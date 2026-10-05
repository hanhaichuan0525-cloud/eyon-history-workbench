import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as creative from '../src/core/creativeReferences.ts';

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
function run(code: string, sandbox: Record<string, unknown>) {
  return runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), sandbox);
}
function state(): any {
  return { generationView: 'compose', geography: [], geoMode: 'custom', geoSearch: '', characters: [], biographies: [],
    selectedCharacterIds: new Set(), busy: false, entering: false, error: '',
    draft: { era: '复兴纪元', start: { year: '', month: '', day: '' }, end: { year: '', month: '', day: '' },
      location: '港口', supplementaryDirection: '二叶玩积木', candidateCount: 3, creativeReferences: creative.defaultRuinReferences() } };
}

test('三段常驻设置与六个日期输入均直接可用，只有长文风帮助折叠', () => {
  const renderer = run(`${['renderForm', 'renderCreativeForm', 'renderGeographyPicker', 'renderDateGroup'].map(extract).join('\n')} renderForm`, {
    ...creative, KNOWN_EYON_ERAS: ['复兴纪元'], CUSTOM_ERA_OPTION: '__custom_era__', isCustomEra: () => false,
    escapeHtml: (value: string) => value, escapeAttribute: (value: string) => value,
    periodLabel: (value: string) => value,
  });
  const html = renderer(state());
  assert.equal((html.match(/class="composer-card /gu) ?? []).length, 3);
  assert.ok(html.indexOf('历史舞台') < html.indexOf('探索对象') && html.indexOf('探索对象') < html.indexOf('讲述气质'));
  assert.equal((html.match(/data-date="/gu) ?? []).length, 6);
  assert.equal((html.match(/data-period-index=/gu) ?? []).length, 3);
  assert.equal((html.match(/data-ruin-style=/gu) ?? []).length, 3);
  const details = [...html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/gu)];
  assert.equal(details.length, 1);
  assert.doesNotMatch(details[0][1], /data-date=|data-direction|data-auto-genealogy|data-ruin-style|data-period-index/u);
  assert.match(html, /data-auto-genealogy/u);
  assert.doesNotMatch(html, /data-date-details|data-reference-details|给想象一个方向|无需先知道角色全名/u);
});

test('左右独立卡片与窄屏切页使用同一份草稿，不重新生成或重挂页面', () => {
  const stateValue = state(), draft = stateValue.draft;
  const attributes = new Map<string, string>();
  const tabs = ['compose', 'read'].map(view => ({ dataset: { generationView: view }, handler: () => {},
    addEventListener(_: string, fn: () => void) { this.handler = fn; },
    setAttribute(key: string, value: string) { attributes.set(`${view}:${key}`, value); } }));
  const bind = extract('bind'), start = bind.indexOf('root.querySelectorAll<HTMLButtonElement>');
  const end = bind.indexOf("root.querySelectorAll<HTMLButtonElement>('[data-ruin-panel]')");
  const scroller = { scrollTop: 250 };
  run(`${extract('selectGenerationView')} ${bind.slice(start, end)}`, { state: stateValue,
    generationScrollPositions: new Map(), generationScroller: () => scroller, getComputedStyle: () => ({ display: 'flex' }), root: {
    querySelectorAll: () => tabs, querySelector: () => ({ setAttribute: (key: string, value: string) => attributes.set(key, value) }),
  } });
  tabs[1].handler(); assert.equal(stateValue.generationView, 'read'); assert.equal(scroller.scrollTop, 0);
  scroller.scrollTop = 110;
  tabs[0].handler(); assert.equal(stateValue.generationView, 'compose'); assert.equal(scroller.scrollTop, 250);
  tabs[1].handler(); assert.equal(scroller.scrollTop, 110);
  tabs[0].handler();
  assert.equal(stateValue.draft, draft); assert.equal(draft.supplementaryDirection, '二叶玩积木');
  assert.equal(attributes.get('compose:aria-pressed'), 'true');
  const css = readFileSync(new URL('../src/ui/ruinWorkbench.css', import.meta.url), 'utf8');
  assert.match(css, /grid-template-columns: minmax\(0,3fr\) minmax\(0,7fr\)/u);
  assert.match(css, /@container ruin-generation \(max-width:820px\)/u);
  assert.match(css, /\[data-view=compose\] \.generation-reader, \[data-view=read\] \.ruin-composer/u);
});

test('通过校验后才切到阅览；后台心跳与候选增量更新不强制切页', async () => {
  for (const valid of [false, true]) {
    const currentState = state();
    const generate = run(`${extract('generate')} generate`, {
      state: currentState, canOpenRuinPanel: () => true, buildInput: () => valid ? {} : null,
      reads: { invalidate() {} }, operationIsCurrent: () => () => true, render() {},
      selectGenerationView: (view: string) => { currentState.generationView = view; },
      client: { facade: () => ({ setRuinDraft() {}, generateRuin: async () => { throw new Error('不调用模型'); } }) },
      awaitingNewRecord: false,
    });
    await generate(); assert.equal(currentState.generationView, valid ? 'read' : 'compose');
  }
  assert.doesNotMatch(extract('syncRecords'), /generationView\s*=/u);
  assert.doesNotMatch(extract('refresh'), /generationView\s*=/u);
});

test('嵌套蝴蝶控制台的组字事件不锁住父页面，父表单自己的组字仍受保护', () => {
  const callbacks: Record<string, (event: any) => void> = {};
  const root = { addEventListener: (type: string, fn: (event: any) => void) => { callbacks[type] = fn; } };
  class Element { owner: unknown; constructor(owner: unknown) { this.owner = owner; } getRootNode() { return this.owner; } }
  const start = source.indexOf('const ownsComposition ='), end = source.indexOf('const configured =', start);
  const controls = run(`let composing = false, deferredRender = false; ${source.slice(start, end)} (() => composing)`, {
    root, Element, setTimeout: (fn: () => void) => fn(), render() {},
  });
  callbacks.compositionstart({ composedPath: () => [new Element({})] }); assert.equal(controls(), false);
  callbacks.compositionstart({ composedPath: () => [new Element(root)] }); assert.equal(controls(), true);
  callbacks.compositionend({ composedPath: () => [new Element(root)] }); assert.equal(controls(), false);
});

test('全部候选完成不抢走大纲显示后玩家自行选择的候选或旧史稿', async () => {
  let resolve!: (record: any) => void;
  const response = new Promise(r => { resolve = r; });
  const currentState = { ...state(), records: [], activeRecordKey: 'old', activeCandidateId: 'old-2', selectedNodeId: 'old-node' };
  const record = { key: 'new', result: { candidates: [{ id: 'new-1' }, { id: 'new-2' }] } };
  const controls = run(`let awaitingNewRecord = false; ${extract('generate')} ({ generate, outlinesReady: () => awaitingNewRecord = false })`, {
    state: currentState, canOpenRuinPanel: () => true, buildInput: () => ({}),
    reads: { invalidate() {} }, recordReads: { invalidate() {} }, operationIsCurrent: () => () => true, render() {},
    selectGenerationView: (view: string) => { currentState.generationView = view; },
    ruinCandidateState: () => ({ status: 'ready' }),
    client: { facade: () => ({ setRuinDraft() {}, generateRuin: () => response }) },
  });
  const pending = controls.generate();
  controls.outlinesReady(); currentState.generationView = 'compose';
  resolve(record); await pending;
  assert.equal(currentState.activeRecordKey, 'old'); assert.equal(currentState.activeCandidateId, 'old-2');
  assert.equal(currentState.selectedNodeId, 'old-node'); assert.equal(currentState.generationView, 'compose');
  assert.equal(currentState.busy, false);
});
