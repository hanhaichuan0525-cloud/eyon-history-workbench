import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ViewRefreshGuard } from '../src/ui/viewRefresh.ts';
import { isTaskBusy } from '../src/runtime/taskStatus.ts';

const source = readFileSync(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('ui.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function extract(name: string) {
  let found = '';
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.ok(found, name); return found;
}
function deferred() {
  let resolve!: (value: any) => void;
  return { promise: new Promise<any>(r => { resolve = r; }), resolve: (value: any) => resolve(value) };
}
function run(code: string, sandbox: Record<string, unknown>) {
  return runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), sandbox);
}

test('实际增量读：大纲就绪立即选新档，其后候选刷新不抢手动浏览', async () => {
  let revision = 0, renderCount = 0;
  let response = deferred();
  const records = [
    { key: 'new', createdAt: 2, result: { candidates: [{ id: 'new-1' }, { id: 'new-2' }] } },
    { key: 'old', createdAt: 1, result: { candidates: [{ id: 'old-1' }] } },
  ];
  const state: any = { records: [], activeRecordKey: 'old', activeCandidateId: 'old-1', selectedNodeId: 'node', disposed: false };
  const guard = new ViewRefreshGuard(() => revision);
  const sync = run(`let awaitingNewRecord = true; ${extract('activeRecord')} ${extract('syncRecords')} syncRecords`, {
    state, recordReads: guard, client: { isReady: () => true, facade: () => ({ listRuins: () => response.promise }) },
    render: () => renderCount++,
  });
  const pending = sync('new'); response.resolve(records); await pending;
  assert.equal(state.activeRecordKey, 'new'); assert.equal(state.activeCandidateId, 'new-1');
  state.activeRecordKey = 'old'; state.activeCandidateId = 'old-1'; state.selectedNodeId = 'user-node';
  response = deferred(); const later = sync('new'); response.resolve(records); await later;
  assert.equal(state.activeRecordKey, 'old'); assert.equal(state.selectedNodeId, 'user-node');
  response = deferred(); const stale = sync('new'); revision++;
  response.resolve([]); await stale;
  assert.equal(state.records.length, 2); assert.equal(renderCount, 2, '换聊天后的迟到资料不重绘');
});

test('实际状态订阅：带request的开始/逐份完成要更新，重复心跳不重绘', () => {
  let callback: (detail: any) => void = () => {};
  let paints = 0, refreshes = 0;
  const synced: any[] = [];
  const state: any = { status: null, busy: false };
  let statement = '';
  const walk = (node: ts.Node) => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === 'offStatus')) statement = node.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree);
  run(statement, { state, client: { onStatus(fn: any) { callback = fn; return () => {}; } }, isTaskBusy,
    render: () => paints++, syncRecords: (key: string) => { synced.push(key); }, refresh: () => refreshes++ });
  const status = { taskType: 'ruin', phase: 'running', status: 'generating_candidate', detail: '第一份', recordKey: 'new', request: { startedAt: 1 } };
  callback(status); callback({ ...status, request: { startedAt: 2 } });
  assert.equal(paints, 1);
  callback({ ...status, status: 'candidate_ready', detail: '第一份已完成', progress: { current: 1, total: 3 } });
  assert.equal(paints, 2); assert.ok(synced.every(key => key === 'new'));
  callback({ ...status, phase: 'success', status: 'ready', detail: '完成' });
  assert.equal(state.busy, false); assert.equal(refreshes, 1);
});

test('中文搜索输入只更新结果区，组字期间延迟结果更新而不重建输入', () => {
  const handlers: Record<string, () => void> = {}, timers: Array<() => void> = [];
  const search = { value: '', addEventListener(type: string, fn: () => void) { handlers[type] = fn; } };
  const results = { innerHTML: '' };
  const state = { geoSearch: '' };
  const bind = extract('bind');
  const searchStart = bind.indexOf('const search =');
  const searchEnd = bind.indexOf("root.querySelectorAll<HTMLSelectElement>('[data-geo-level]')", searchStart);
  const sandbox: any = { state, root: { querySelector: (selector: string) => selector === '[data-geo-search]' ? search : results,
      querySelectorAll: () => [] }, setTimeout: (fn: () => void) => timers.push(fn), renderGeoResults: (s: any) => s.geoSearch };
  const controls = run(`let composing = false; ${extract('updateGeoResults')} ${extract('bindGeoResults')}
    ${bind.slice(searchStart, searchEnd)} ({setComposing: value => composing = value})`, sandbox);
  search.value = '帝国'; handlers.input(); assert.equal(results.innerHTML, '帝国');
  controls.setComposing(true); search.value = '帝国 艾'; handlers.input();
  assert.equal(state.geoSearch, '帝国 艾'); assert.equal(results.innerHTML, '帝国');
  controls.setComposing(false); search.value = '帝国 艾瑟'; handlers.compositionend(); handlers.input();
  timers.forEach(fn => fn()); assert.equal(results.innerHTML, '帝国 艾瑟');
  assert.equal(sandbox.root.querySelector('[data-geo-search]'), search);
  assert.match(extract('render'), /if \(composing\) \{ deferredRender = true; return; \}/u);
});
