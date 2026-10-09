import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { ViewRefreshGuard } from '../src/ui/viewRefresh.ts';
import { WorkbenchUiClient } from '../src/ui/workbenchClient.ts';
import { deduplicateEmbeddedRules } from '../src/prompts/ruleText.ts';
import { clearPromptDiagnostics, recordPromptDiagnostic, recordPromptUsage, listPromptDiagnostics } from '../src/runtime/promptDiagnostics.ts';
import { renderGenerationDiagnostics } from '../src/ui/generationDiagnostics.ts';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';
import { TavernGenerationAdapter } from '../src/runtime/tavernGeneration.ts';

const source = readFileSync(new URL('../src/ui/workbenchShell.ts', import.meta.url), 'utf8');
const tree = ts.createSourceFile('shell.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function extract(name: string): string {
  let found = '';
  function walk(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(tree); ts.forEachChild(node, walk); }
  walk(tree); assert.ok(found, name); return found;
}
function run(code: string, sandbox: Record<string, unknown>): any {
  return runInNewContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), sandbox);
}

test('实际外壳首次只挂当前页；再次访问复用实例、草稿与主题', () => {
  const calls: string[] = [], handles = new Map(), moduleRoots = new Map();
  for (const id of ['timeline', 'ruin', 'genealogy', 'biography', 'settings']) moduleRoots.set(id, {});
  const mount = (id: string) => () => { calls.push(id); return { draft: '中文未发送草稿', setAppearance(value: any) { assert.equal(value.mode, 'dark'); } }; };
  const ensure = run(`${extract('ensureMounted')} ensureMounted`, {
    disposed: false, handles, moduleRoots, client: {}, appearance: { mode: 'dark' },
    mountTimelineWorkbench: mount('timeline'), mountRuinWorkbench: mount('ruin'), mountGenealogyWorkbench: mount('genealogy'), mountBiographyWorkbench: mount('biography'), mountSettingsWorkbench: mount('settings'),
    updateChrome() {}, resetWorkspaceScroll() {}, applyWorkbenchAppearance() {},
  });
  assert.equal(ensure('ruin'), true); assert.deepEqual(calls, ['ruin']);
  const handle = handles.get('ruin'); ensure('settings');
  assert.equal(ensure('ruin'), false); assert.equal(handles.get('ruin'), handle); assert.equal(handle.draft, '中文未发送草稿');
  assert.equal(handles.size, 2);
});

test('实际外壳局部变化不刷新隐藏页面，计数仍同步；当前页收到变化立即刷新', async () => {
  const calls: string[] = [], handles = new Map(['ruin', 'biography'].map(id => [id, { async refresh() { calls.push(id); } }]));
  let snapshots = 0;
  const refresh = run(`${extract('refreshChangedViews')} refreshChangedViews`, { disposed: false, active: 'ruin', handles, reads: new ViewRefreshGuard(() => 0), client: { isReady: () => true, async readSnapshot() { snapshots++; return {}; } }, updateChrome() {} });
  await refresh(['biography']); assert.deepEqual(calls, []); assert.equal(snapshots, 1);
  await refresh(['ruin', 'biography', 'ruin']); assert.deepEqual(calls, ['ruin']);
});

test('实际安全清缓存不会误调用旧的删除资料接口；旧版本只可降级到派生缓存接口', () => {
  let cleared = 0, deleted = 0;
  const facade: any = { clearTemporaryCache() { cleared++; }, clearGenerationCache() { deleted++; } };
  const call = () => WorkbenchUiClient.prototype.clearTemporaryCache.call({ facade: () => facade } as any);
  call(); assert.equal(cleared, 1); assert.equal(deleted, 0);
  delete facade.clearTemporaryCache; assert.throws(call, /不支持安全清理/); assert.equal(deleted, 0);
  facade.clearContinuityCache = () => cleared++; call(); assert.equal(cleared, 2); assert.equal(deleted, 0);
});

test('自带规则仅去重逐字相同的长段，短标题与不同语义不变；不裁切全文', () => {
  const same = '必须保留史料的年龄、死亡、来源与不确定性。'.repeat(12);
  const long = '玩家世界书原文，中文和EJS完全保持。'.repeat(10000);
  const result = deduplicateEmbeddedRules({ shared: `标题\n\n${same}`, generation: `${same}\n\n${same}\n\n不同：${same}\n\n${long}\n\n标题` });
  assert.equal(result.shared, `标题\n\n${same}`); assert.ok(result.generation.includes(`不同：${same}`)); assert.ok(result.generation.includes(long)); assert.ok(result.generation.endsWith('标题'));
  assert.equal(result.generation.startsWith(same), true, '独立消费的生成规则保留共同约束');
  assert.equal(result.generation.includes(`${same}\n\n${same}`), false, '只删除同份文档内部的重复');
});

test('实际API适配通道记录服务端token，不额外请求、不改返回正文', async () => {
  clearPromptDiagnostics(); let calls = 0;
  const adapter = new TavernGenerationAdapter({ async generateCustomRaw() { calls++; return { choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 125, completion_tokens: 18, total_tokens: 143 } }; } } as any,
    { async get() { return { apiurl: 'https://example.invalid/v1', key: 'local-fixture', model: 'fixture', source: 'openai' }; } }, () => 'fixture');
  assert.equal(await adapter.generate('ruin', '原文完整'), '{"ok":true}'); assert.equal(calls, 1);
  assert.equal(listPromptDiagnostics()[0].usage?.total, 143);
});

test('并发、缺失用量、Gemini用量与换聊天迟到响应诊断不会串线或猜数字', () => {
  clearPromptDiagnostics();
  const record = () => recordPromptDiagnostic({ taskType: 'butterfly', prompt: 'secret全文', systemPrompt: '', attempt: 1, compactRecovery: false });
  const a = record(), b = record();
  recordPromptUsage(b, { usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 7, totalTokenCount: 42, cachedContentTokenCount: 3 }, key: 'secret' });
  recordPromptUsage(a, { usage: { prompt_tokens: -1, completion_tokens: NaN, total_tokens: '100' } });
  assert.equal(listPromptDiagnostics()[0].usage, undefined); assert.equal(listPromptDiagnostics()[1].usage?.total, 42);
  assert.doesNotMatch(JSON.stringify(listPromptDiagnostics()), /secret/);
  clearPromptDiagnostics(); const c = record(); recordPromptUsage(b, { usage: { total_tokens: 99 } });
  assert.notEqual(b, c); assert.equal(listPromptDiagnostics()[0].usage, undefined);
});

test('检索回执跨聊天清空，队列中旧任务完成后不会重新出现旧角色标题', async () => {
  const observer = new RuntimeShadowRetrievalObserver();
  const pending = observer.capture({ requestId: 'old', taskType: 'ruin', query: '二叶', candidates: [{ sourceId: 'old-book', sourceType: 'worldbook', title: '旧聊天二叶', content: '二叶是一名花灵少女。' }], legacySourceIds: [] });
  observer.clearObservations(); await pending; assert.equal(observer.list().length, 0);
  await observer.capture({ requestId: 'new', taskType: 'ruin', query: '珊奈', candidates: [], legacySourceIds: [] });
  assert.equal(observer.list()[0].requestId, 'new');
});

test('诊断界面转义来源文字并明确区分字符与实际token', () => {
  const html = renderGenerationDiagnostics([{ status: 'success', taskType: 'ruin', sourceMappings: [{ snapshotId: 'x', title: '<img onerror="bad">' }], receipt: { selected: [{ snapshotId: 'x', reason: '<script>bad</script>' }], rejected: [], selectedPassages: [], passageBudget: { usedChars: 10 }, warnings: [] } } as any], listPromptDiagnostics());
  assert.doesNotMatch(html, /<img|<script>/); assert.match(html, /&lt;img/); assert.match(html, /字符数不等于 token/);
});

test('原生入口和模型语义编译器退役；脚本清单、骰表及兼容存档字段保留', () => {
  for (const path of ['extension/index.js', 'extension/capability-contract.json', 'src/retrieval/semanticEvidence.ts']) assert.equal(existsSync(new URL('../' + path, import.meta.url)), false);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.js, undefined); assert.equal(manifest.hooks, undefined); assert.equal(manifest.entry, 'dist/index.js'); assert.equal(manifest.minimumLoaderVersion, '0.1.0');
  const settings = readFileSync(new URL('../src/ui/settingsWorkbench.ts', import.meta.url), 'utf8');
  assert.match(settings, /删除生成资料/); assert.match(settings, /advanced-diagnostics/); assert.doesNotMatch(settings, /剧情时刻|时效判定以此为准/);
  assert.doesNotMatch(readFileSync(new URL('../src/prompts/biography.ts', import.meta.url), 'utf8'), /EYON-TIME-START|EYON-TIME-END/);
});
