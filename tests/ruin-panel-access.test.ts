import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { assertRuinGenerationAvailable, availableRuinPanel, canOpenRuinPanel, type RuinPanel } from '../src/core/ruinPanelAccess.ts';
import { GenerationCancelledError } from '../src/runtime/tavernGeneration.ts';
import { WORKBENCH_VIEWS, normalizeWorkbenchView } from '../src/ui/workbenchNavigation.ts';

test('三个子页遵守当前入境状态；旧runId、空runId与未知状态不能绕过', () => {
  const panels: RuinPanel[] = ['generation', 'tasks', 'butterfly'];
  for (const runId of ['', '旧轮次']) {
    const runtime = { flowState: 'idle' as const, runId };
    assert.deepEqual(panels.map(panel => canOpenRuinPanel(runtime, panel)), [true, false, false]);
    assert.equal(availableRuinPanel(runtime, 'butterfly'), 'generation');
    assert.doesNotThrow(() => assertRuinGenerationAvailable(runtime));
  }
  for (const flowState of ['exploring', 'anchored', 'returning'] as const) {
    const runtime = { flowState, runId: '当前轮次' };
    assert.deepEqual(panels.map(panel => canOpenRuinPanel(runtime, panel)), [false, true, true]);
    assert.equal(availableRuinPanel(runtime, 'generation'), 'tasks');
    assert.equal(availableRuinPanel(runtime, 'butterfly'), 'butterfly');
    assert.throws(() => assertRuinGenerationAvailable(runtime), /生成已锁定/u);
    assert.deepEqual(panels.map(panel => canOpenRuinPanel({ flowState, runId: '' }, panel)), [false, false, false]);
  }
  assert.equal(canOpenRuinPanel({ flowState: 'unknown' as never, runId: '轮次' }, 'generation'), false);
  assert.equal(canOpenRuinPanel({ flowState: 'idle', runId: '' }, 'unknown' as never), false);
});

/** 执行真实入口函数，宿主与模型替换成只记录调用的桩。 */
function generationHarness() {
  const source = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const entries = new Map<string, string>();
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ['generateRuin', 'retryRuinCandidate', 'enterRuin'].includes(node.name.getText(tree))) entries.set(node.name.getText(tree), node.initializer.getText(tree));
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.equal(entries.size, 3);
  const calls: string[] = [];
  const context: any = {
    exports: {}, assertRuinGenerationAvailable,
    assertWorkbenchEnabled() {},
    runTask: (_: string, task: Function) => task(() => { if (context.changed) throw new GenerationCancelledError('ruin'); }),
    host: { getRuinRuntimeSnapshot: async () => context.runtime },
    runtime: { flowState: 'idle', runId: '' }, changed: false,
    ruinController: { generateFromPanel: async () => { calls.push('generate'); return {}; }, retryCandidate: async () => { calls.push('retry'); return {}; } },
    generator: { cancel: () => calls.push('cancel-butterfly') }, lifecycle: { resetReturnPreparation() {} },
    butterflyController: { onRuinEntered: async () => {} },
    ruinEntry: { enter: async () => { calls.push('enter'); return {}; } },
    publishDataChanged: () => calls.push('publish'), globalObject: {},
    readTavernComposerText: () => '', clearTavernComposerText() {},
  };
  runInNewContext(ts.transpileModule([...entries].map(([name, text]) => `export const ${name} = ${text};`).join('\n'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, calls, ...context.exports };
}

test('实际运行入口在入境时拒绝新生成、补稿和再次进入，不调用模型或取消旧结算', async () => {
  const h = generationHarness();
  for (const flowState of ['exploring', 'anchored', 'returning']) {
    h.context.runtime = { flowState, runId: '本轮' };
    for (const action of [h.generateRuin, h.retryRuinCandidate, h.enterRuin]) await assert.rejects(action({}), /生成已锁定/u);
  }
  assert.deepEqual(h.calls, []);
  h.context.runtime = { flowState: 'idle', runId: '' };
  await h.generateRuin({}); await h.retryRuinCandidate('记录', '候选'); await h.enterRuin('记录', '候选', '节点');
  assert.ok(h.calls.includes('generate') && h.calls.includes('retry') && h.calls.includes('enter'));
});

test('实际运行入口读取状态时切聊天，迟到的idle不放行新操作', async () => {
  const h = generationHarness();
  h.context.host.getRuinRuntimeSnapshot = async () => { h.context.changed = true; return { flowState: 'idle', runId: '' }; };
  for (const action of [h.generateRuin, h.retryRuinCandidate, h.enterRuin]) await assert.rejects(action({}), GenerationCancelledError);
  assert.deepEqual(h.calls, []);
});

test('实际正文归档回调提交后通知入境状态刷新；切聊天或退役不发旧通知', async () => {
  const source = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback = '';
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'onAssistantRendered') callback = node.initializer.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.ok(callback);
  const events: string[] = [];
  const context: any = { exports: {}, contextRevision: 0, disposed: false, renderedMemoryBarrier: Promise.resolve(),
    lifecycle: { onAssistantRendered: async () => {} },
    publishDataChanged: (event: { reason: string }) => events.push(event.reason),
    refreshCanonMemory: async () => events.push('memory'),
  };
  runInNewContext(ts.transpileModule(`export const rendered = ${callback};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  await context.exports.rendered(8);
  assert.deepEqual(events,['ruin-presence-refreshed','memory']);
  events.length = 0;
  context.lifecycle.onAssistantRendered = async () => { context.contextRevision++; };
  await context.exports.rendered(9); assert.deepEqual(events,[]);
  context.lifecycle.onAssistantRendered = async () => { context.disposed = true; };
  await context.exports.rendered(10); assert.deepEqual(events,[]);
});

test('实际侧栏点击逻辑：默认收起、点击展开、再次点击收起、切模块后收起；状态锁同步', () => {
  const source = readFileSync(new URL('../src/ui/workbenchShell.ts', import.meta.url), 'utf8');
  assert.match(source, /data-ruin-children hidden/u);
  const tree = ts.createSourceFile('shell.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = new Map<string, string>(); let binding = '';
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && ['navigate', 'updateChrome'].includes(node.name?.text ?? '')) functions.set(node.name!.text, node.getText(tree));
    if (ts.isExpressionStatement(node) && node.getText(tree).startsWith("root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach")) binding = node.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.equal(functions.size, 2); assert.ok(binding);
  class Button {
    attributes = new Map<string,string>(); disabled = false; title = ''; callback: Function = () => {};
    dataset: Record<string, string>;
    constructor(dataset: Record<string, string>) { this.dataset = dataset; }
    addEventListener(_: string, callback: Function) { this.callback = callback; }
    setAttribute(key: string, value: string) { this.attributes.set(key,value); }
  }
  const main = WORKBENCH_VIEWS.map(view => new Button({ view: view.id }));
  const children = ['generation','tasks','butterfly'].map(ruinChild => new Button({ ruinChild }));
  const group = { hidden: true };
  const root = {
    querySelectorAll: (selector: string) => selector === '[data-view]' ? main : selector === '[data-ruin-child]' ? children : [],
    querySelector: (selector: string) => selector === '[data-ruin-children]' ? group : selector === '[data-view="ruin"]' ? main.find(button => button.dataset.view === 'ruin') : null,
  };
  const context: any = { exports: {}, root, canOpenRuinPanel, normalizeWorkbenchView, WORKBENCH_VIEWS, moduleRoots: new Map(), ensureMounted: () => false, resetWorkspaceScroll() {}, refreshView: async () => {}, ledgerFor: () => [], statusText: '', runtime: { flowState:'idle',runId:'' } };
  runInNewContext(ts.transpileModule(`let active='ruin',ruinMenuExpanded=false,ruinPanel='generation';
    const snapshot={runtime,ruins:[],butterflies:[],genealogies:[],biographies:[]};
    ${[...functions.values()].join('\n')}
    ${binding}
    export { updateChrome, navigate }; export const setRuntime = value => {snapshot.runtime=value;updateChrome();};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const { updateChrome, navigate, setRuntime } = context.exports;
  updateChrome(); assert.equal(group.hidden,true);
  const ruin = main.find(button => button.dataset.view === 'ruin')!;
  ruin.callback(); assert.equal(group.hidden,false); assert.equal(ruin.attributes.get('aria-expanded'),'true');
  assert.deepEqual(children.map(button=>button.disabled),[false,true,true]);
  setRuntime({flowState:'exploring',runId:'当前轮次'});
  assert.deepEqual(children.map(button=>button.disabled),[true,false,false]);
  assert.equal(children[0].title,'遣返现世后解锁');
  ruin.callback(); assert.equal(group.hidden,true);
  ruin.callback(); assert.equal(group.hidden,false);
  navigate('biography'); assert.equal(group.hidden,true);
  navigate('ruin'); assert.equal(group.hidden,true,'程序化导航不擅自展开菜单');
  ruin.callback(); assert.equal(group.hidden,false);
  setRuntime({flowState:'idle',runId:''}); assert.deepEqual(children.map(button=>button.disabled),[false,true,true]);
});
