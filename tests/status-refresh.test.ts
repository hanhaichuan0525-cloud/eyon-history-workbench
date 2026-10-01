import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { TaskStatusProjection, isTaskBusy } from '../src/runtime/taskStatus.ts';
import { ViewRefreshGuard, preserveDomState } from '../src/ui/viewRefresh.ts';
import { namespaceKey } from '../src/core/namespace.ts';
import { GenerationCancelledError } from '../src/runtime/tavernGeneration.ts';
import { companionStatusDescription } from '../src/ui/companionPresentation.ts';

test('工作流计数与总起点不被请求心跳、重试、单候选失败重置', () => {
  const projection = new TaskStatusProjection();
  const base = { taskType: 'ruin' as const, phase: 'running' as const };
  projection.project({ ...base, status: 'assembling_context', detail: '查资料' }, 1000);
  const writing = projection.project({ ...base, status: 'generating_candidate', detail: '撰写第二份', progress: { current: 1, total: 3, item: 2 } }, 2000);
  assert.equal(writing.startedAt, 1000);
  const request = projection.project({ ...base, status: 'generating', detail: '请求', request: { label: '正在修订本份史稿', startedAt: 3000 }, retry: { attempt: 2, max: 3 } }, 3000);
  assert.deepEqual(request.progress, { current: 1, total: 3, item: 2 });
  assert.equal(request.detail, '正在修订本份史稿', '流程与请求阶段不重复拼接');
  assert.equal(companionStatusDescription(request), '正在修订本份史稿（第 2 份）\n\n史稿已完成 1/3');
  assert.equal(request.startedAt, 1000);
  const tick = projection.project({ ...base, status: 'generating', detail: '心跳', request: { label: '正在修订本份史稿', startedAt: 3000 } }, 4000);
  assert.equal(tick.retry?.attempt, 2);
  assert.equal(tick.detail, request.detail, '心跳不重复拼接文案');
  const failure = projection.project({ ...base, status: 'candidate_failed', detail: '第二份失败', progress: { current: 1, total: 3 } }, 5000);
  assert.equal(failure.startedAt, 1000);
  assert.equal(isTaskBusy(failure), true);
  const ready = projection.project({ ...base, phase: 'success', status: 'ready', detail: '部分完成', progress: { current: 2, total: 3 } }, 6000);
  assert.equal(ready.startedAt, undefined);
  assert.equal(ready.progress?.current, 2);
  assert.equal(projection.project({ ...base, status: 'retrying_candidate', detail: '补稿' }, 7000).startedAt, 7000);
});

test('任务草案只显示一个阶段，分隔换空行但不拆姓名间隔号', () => {
  const projection = new TaskStatusProjection();
  projection.project({ taskType: 'ruin', status: 'generating_ruin_task_draft', phase: 'running', detail: '伊雍正在按你选择的权限与规模拟定任务草案', progress: { current: 1, total: 1 } }, 1000);
  const request = projection.project({ taskType: 'ruin', status: 'generating', phase: 'running', detail: '正在拟定墟境任务草案', request: { label: '正在拟定墟境任务草案', startedAt: 1200 } });
  assert.equal(companionStatusDescription(request), '正在拟定墟境任务草案');
  assert.equal(companionStatusDescription({ status: 'info', detail: '玲山·哈姆斯沃思 · 正在读取资料' }), '玲山·哈姆斯沃思\n\n正在读取资料');
});

test('等待玩家/正文不是模型等待；停止与聊天清理结束旧计时', () => {
  const projection = new TaskStatusProjection();
  projection.project({ taskType: 'biography', phase: 'running', status: 'assembling_context', detail: '' }, 1000);
  const waiting = projection.project({ taskType: 'biography', phase: 'info', status: 'awaiting_narrative', detail: '等正文' }, 2000);
  assert.equal(isTaskBusy(waiting), false);
  assert.equal(waiting.startedAt, undefined);
  assert.equal(isTaskBusy({ phase: 'recovered', status: 'generating', detail: '' }), true);
  projection.clear();
  assert.equal(projection.project({ taskType: 'biography', phase: 'running', status: 'generating', detail: '' }, 3000).startedAt, 3000);
});

test('读取版本隔离旧刷新、mutation、换聊天和dispose', () => {
  let context = 0;
  const guard = new ViewRefreshGuard(() => context);
  const old = guard.begin();
  const current = guard.begin();
  assert.equal(old(), false);
  assert.equal(current(), true);
  guard.invalidate();
  assert.equal(current(), false);
  const chatA = guard.begin(); context += 1;
  assert.equal(chatA(), false);
  const chatB = guard.begin(); guard.dispose();
  assert.equal(chatB(), false);
});

test('稳定章节标识保留展开和滚动；插入书架节点不丢编辑光标', () => {
  const element = (tagName: string, id: string, data: string | null = null) => ({
    tagName, id, attributes: data ? [{ name: 'data-chapter-key', value: data }] : [],
    getAttribute: () => null, querySelector: () => ({ textContent: '第一章' }),
    scrollTop: 10, scrollLeft: 20, open: true,
    selectionStart: 2, selectionEnd: 4, focus() { this.focused = true; }, focused: false,
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
  });
  const chapter = element('DETAILS', '', 'bookA:1');
  const input = element('INPUT', 'direction');
  let nodes = [chapter, input];
  const root = { querySelectorAll: () => nodes, activeElement: input };
  const restore = preserveDomState(root as unknown as ShadowRoot);
  const rebuiltChapter = { ...chapter, open: false, scrollTop: 0, scrollLeft: 0 };
  const rebuiltInput = { ...input, selectionStart: 0, selectionEnd: 0 };
  nodes = [element('BUTTON', 'newBook'), rebuiltChapter, rebuiltInput];
  restore();
  assert.equal(rebuiltChapter.open, true);
  assert.equal(rebuiltChapter.scrollTop, 10);
  assert.equal(rebuiltInput.focused, true);
  assert.equal(rebuiltInput.selectionStart, 2);
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function genealogyHarness() {
  const source = readFileSync(new URL('../src/ui/genealogyWorkbench.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('ui.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ['generate', 'toggleRuinReference', 'clearCharacterGenealogy'].includes(node.name?.text ?? '')) functions.push(node.getText(tree));
    ts.forEachChild(node, walk);
  };
  walk(tree);
  let context = 0;
  let response = deferred<any>();
  const mutations = new ViewRefreshGuard(() => context);
  const state: any = {
    disposed: false, busy: false, busyCharacterId: '', error: '', status: null,
    selectedMvuId: '玲山', selectedNodeId: '', ancestors: 4, descendants: 0,
    maxPerGeneration: 7, records: [], ruinReferences: [], identityByCharacter: new Map(), familyTracks: new Map(), contextMenu: null,
  };
  const client = {
    contextRevision: () => context, setGenealogyDepth() {},
    generateGenealogy: () => response.promise,
    clearCharacterGenealogy: () => response.promise,
    listRuinCharacterReferences: async () => [], toggleGenealogyNodeRuinReference: async () => [],
  };
  const exports: any = {};
  const compiled = ts.transpileModule(`${functions.join('\n')}\nexport { generate, toggleRuinReference, clearCharacterGenealogy };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  runInNewContext(compiled, { exports, state, client, mutations, refreshEpoch: 0,
    render() {}, window: { confirm: () => true }, selectedRecord: () => state.records[0] ?? null,
    selectedCharacter: () => ({ mvuId: '玲山', name: '玲山', aliases: [] }) });
  return { exports, state, mutations, response, switchChat() { context += 1; }, next() { response = deferred<any>(); return response; } };
}

test('实际谱系函数：旧聊天失败不能清新聊天busy或覆盖新状态', async () => {
  const h = genealogyHarness();
  const pending = h.exports.generate();
  h.switchChat(); h.state.status = { status: 'new-chat' }; h.state.busy = true;
  h.response.reject(new Error('old failure')); await pending;
  assert.equal(h.state.status.status, 'new-chat');
  assert.equal(h.state.busy, true);
});

test('实际谱系函数：停止后旧失败不能覆盖立即重试', async () => {
  const h = genealogyHarness();
  const old = h.exports.generate();
  const oldResponse = h.response;
  h.mutations.invalidate(); h.state.busy = false;
  const next = h.next(); const current = h.exports.generate();
  oldResponse.reject(new Error('cancelled')); await old;
  assert.equal(h.state.busy, true);
  next.resolve({ key: 'new', result: { nodes: [{ id: 'focus', isFocus: true }] } });
  await current;
  assert.equal(h.state.busy, false);
  assert.equal(h.state.records[0].key, 'new');
});

test('实际谱系函数：生成途中引用切换不淘汰生成租约', async () => {
  const h = genealogyHarness(); const pending = h.exports.generate();
  await h.exports.toggleRuinReference({ key: 'old' }, 'parent');
  h.response.resolve({ key: 'new', result: { nodes: [{ id: 'focus', isFocus: true }] } });
  await pending;
  assert.equal(h.state.busy, false);
  assert.equal(h.state.records[0].key, 'new');
});

test('实际谱系清空UI：移除所有返回旧档但保留其他人物；生成按钮等待清空结束', async () => {
  const h = genealogyHarness();
  h.state.records = [{ key: 'old', requestId: 'old' }, { key: 'new', requestId: 'new' }, { key: 'other', requestId: 'other' }];
  h.state.familyTracks.set('old', 'soul'); h.state.familyTracks.set('other', 'body');
  const clearing = h.exports.clearCharacterGenealogy();
  assert.equal(h.state.busy, true);
  await h.exports.generate(); assert.equal(h.state.status.status, 'clearing_genealogy', '清空期间不能启动同页生成');
  h.response.resolve({ recordKeys: ['old', 'new'], references: [] }); await clearing;
  assert.equal(h.state.busy, false); assert.equal(h.state.selectedNodeId, '');
  assert.deepEqual(h.state.records.map((item: any) => item.key), ['other']);
  assert.equal(h.state.familyTracks.has('old'), false); assert.equal(h.state.familyTracks.has('other'), true);
});

test('实际谱系清空UI：切换聊天后迟到结果不移除新记录、不覆盖busy', async () => {
  const h = genealogyHarness(); h.state.records = [{ key: 'old', requestId: 'old' }];
  const clearing = h.exports.clearCharacterGenealogy();
  h.switchChat(); h.state.records = [{ key: 'new-chat' }]; h.state.status = { status: 'new-chat' };
  h.response.resolve({ recordKeys: ['old'], references: [] }); await clearing;
  assert.equal(h.state.records[0].key, 'new-chat'); assert.equal(h.state.status.status, 'new-chat');
  assert.equal(h.state.busy, true);
});

test('实际引用写队列：连续添加、添加与删除不丢更新', async () => {
  const source = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let body = '';
  const walk = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'mutateReferences') body = node.getText(tree); ts.forEachChild(node, walk); };
  walk(tree); assert.ok(body);
  const exports: any = {};
  runInNewContext(ts.transpileModule(`${body}\nexport { mutateReferences };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { exports, namespaceKey, GenerationCancelledError, referenceWrites: new Map(), contextRevision: 0, scopeReader: { getNamespace: () => ({ characterKey: '卡', chatId: 'A' }) } });
  let stored: string[] = [];
  const update = (value: string, remove = false) => exports.mutateReferences(async () => {
    const old = [...stored]; await new Promise(resolve => setImmediate(resolve));
    stored = remove ? old.filter(item => item !== value) : [...old, value];
  });
  await Promise.all([update('A'), update('B')]); assert.deepEqual(stored, ['A', 'B']);
  await Promise.all([update('C'), update('A', true)]); assert.deepEqual(stored, ['B', 'C']);
});
