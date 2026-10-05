import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { namespaceKey } from '../src/core/namespace.ts';
import { MemoryGenealogyRepository, type GenealogyRecord } from '../src/storage/genealogies.ts';
import { pruneStaleGenealogyReferences } from '../src/storage/ruinReferences.ts';
import { GenerationCancelledError } from '../src/runtime/tavernGeneration.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 提取实际门面和租约/引用队列，替换宿主读写；不调用模型，不加载真实酒馆。 */
async function harness() {
  const source = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('entry.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let clear = '', lease = '', queue = '';
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'clearCharacterGenealogy') clear = node.initializer.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'runTask') lease = `const ${node.getText(tree)};`;
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'mutateReferences') queue = node.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.ok(clear && lease && queue);
  const namespace = { characterKey: '卡', chatId: 'A' };
  const genealogies = new MemoryGenealogyRepository();
  for (const [chatId, requestId, id] of [['A', 'old', '玲山'], ['A', 'new', '玲山'], ['A', 'other', '珊奈'], ['B', 'other-chat', '玲山']]) {
    await genealogies.save({ key: requestId, namespace: { ...namespace, chatId }, requestId,
      input: { focusCharacter: { mvuId: id } }, result: { focusCharacterId: id, focusCharacterName: id },
    } as GenealogyRecord);
  }
  const reference = (requestId: string, source: 'genealogy' | 'mvu' = 'genealogy') => ({
    source, mvuId: source === 'mvu' ? '玲山' : `node:${requestId}`,
    ...(source === 'genealogy' ? { referenceId: `genealogy:${requestId}:father` } : {}),
  });
  const referenceStore = new Map<string, any[]>([
    [namespaceKey(namespace), [reference('old'), reference('new'), reference('other'), reference('single', 'mvu')]],
    [namespaceKey({ ...namespace, chatId: 'B' }), [reference('other-chat')]],
  ]);
  let draft: any = { locationScope: '不改地点', selectedCharacters: [...referenceStore.get(namespaceKey(namespace))!] };
  let characters: any = [{ mvuId: '玲山', name: '玲山' }, { mvuId: '珊奈', name: '珊奈' }];
  const activeTasks = new Map(), dataEvents: any[] = [], referenceEvents: any[] = [];
  const context: any = {
    exports: {}, namespaceKey, GenerationCancelledError, pruneStaleGenealogyReferences,
    activeTasks, clearingContext: 0, contextRevision: 0, referenceWrites: new Map(),
    taskLabel: () => '谱系', scopeReader: { getNamespace: () => ({ ...namespace }) },
    sources: { getCharacterSources: async () => characters, projectRuinCharacters: async (next: any) => next },
    toGenealogyCharacterOption: (item: any) => item, genealogies,
    ruinReferences: {
      read: async (ns: any) => [...referenceStore.get(namespaceKey(ns))!],
      write: async (ns: any, next: any[]) => { referenceStore.set(namespaceKey(ns), next); },
    },
    settings: { getRuinDraft: (ns: any) => { assert.equal(namespaceKey(ns),namespaceKey(namespace)); return draft; }, setRuinDraft: (ns: any, next: any) => { assert.equal(namespaceKey(ns),namespaceKey(namespace)); draft = next; } },
    publishDataChanged: (detail: any) => dataEvents.push(detail),
    publishRuinReferences: (refs: any) => referenceEvents.push(refs),
  };
  runInNewContext(ts.transpileModule(`${queue}\n${lease}\nconst clear = ${clear};\nexport { clear };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, clear: context.exports.clear, genealogies, referenceStore, dataEvents, referenceEvents,
    activeTasks, namespace, draft: () => draft, setCharacters(value: any) { characters = value; } };
}

test('实际门面单人清空：新旧记录和草稿引用清除，手选MVU/其他人/其他聊天保留并通知刷新', async () => {
  const h = await harness(); const result = await h.clear('玲山');
  assert.deepEqual([...result.recordKeys].sort(), ['new', 'old']);
  assert.equal(result.deleted, 2);
  assert.deepEqual(result.references.map((item: any) => item.mvuId), ['node:other', '玲山']);
  assert.deepEqual(h.draft().selectedCharacters.map((item: any) => item.mvuId), ['node:other', '玲山']);
  assert.equal(h.draft().locationScope, '不改地点');
  assert.deepEqual((await h.genealogies.list(h.namespace)).map(item => item.requestId), ['other']);
  assert.equal((await h.genealogies.list({ ...h.namespace, chatId: 'B' })).length, 1);
  assert.equal(h.dataEvents[0].reason, 'genealogy-cleared');
  assert.deepEqual([...h.dataEvents[0].views], ['genealogy', 'ruin', 'settings']);
  assert.equal(h.activeTasks.size, 0);
});

test('实际门面单人清空：生成中、无当前MVU身份均拒绝，不触碰存档', async () => {
  const h = await harness(); h.activeTasks.set('genealogy', Symbol());
  await assert.rejects(h.clear('玲山'), /正在进行/u);
  h.activeTasks.clear(); h.setCharacters([]);
  await assert.rejects(h.clear('玲山'), /未清空任何谱系/u);
  assert.equal((await h.genealogies.list(h.namespace)).length, 3);
  assert.equal(h.dataEvents.length, 0);
});

test('实际门面单人清空：读人物期间换聊天，旧操作不删除或广播', async () => {
  const h = await harness(); const pending = deferred<any[]>();
  h.context.sources.getCharacterSources = () => pending.promise;
  const clearing = h.clear('玲山');
  await new Promise(done => setImmediate(done));
  h.context.contextRevision++;
  pending.resolve([{ mvuId: '玲山', name: '玲山' }]);
  await assert.rejects(clearing, GenerationCancelledError);
  assert.equal((await h.genealogies.list(h.namespace)).length, 3);
  assert.equal(h.referenceEvents.length, 0);
});
