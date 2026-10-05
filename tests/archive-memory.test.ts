import assert from 'node:assert/strict';
import test from 'node:test';
import type { BiographyRecord } from '../src/storage/biographies.ts';
import type { ButterflyRecord } from '../src/storage/butterflies.ts';
import type { ArtifactCanonBinding, CanonBranch, InterventionDelta } from '../src/retrieval/contracts.ts';
import { ArchiveMemoryIndex } from '../src/runtime/archiveMemoryIndex.ts';
import { buildCanonMemorySnapshot, CanonMemoryChannel } from '../src/runtime/canonMemoryChannel.ts';
import { buildBiographyArchiveMemory } from '../src/runtime/biographyArchiveMemory.ts';
import { namespaceKey } from '../src/core/namespace.ts';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const namespace = { characterKey: '测试卡', chatId: '聊天A' };
function branch(headRevision = 0): CanonBranch {
  return { schema: 'eyon.canon.branch.v1', branchId: 'branch:A', ...namespace, headRevision,
    revisions: [], actions: [], deltas: [], receipts: [], createdAt: 0, updatedAt: 0 };
}
function biography(name = '美墨珊奈'): BiographyRecord {
  return { key: `bio:${name}`, namespace, biographyId: `bio:${name}`, requestId: 'request',
    triggerMessageId: 10, assistantMessageId: 11, sourceHash: 'hash', status: 'committed', revision: 1,
    biography: { target: { name, aliases: ['珊奈'] },
      origin: { title: '起源', content: '她诞生于海港。' },
      stages: [{ id: 'stage-1', title: '八岁生日的姐姐遇害事件',
        content: '珊奈八岁生日当晚，姐姐遇害。\n\n后来她把那盏台灯永久保存。',
        people: [name], factions: [], objects: ['台灯'], locations: ['雾晶港'] }],
      status: { title: '现状', content: '她如今在学院生活。' },
    } as unknown as BiographyRecord['biography'], createdAt: 1, updatedAt: 1 };
}
function binding(record: BiographyRecord, factIds: string[] = []): ArtifactCanonBinding {
  return { schema: 'eyon.canon.artifact-binding.v1', bindingId: `binding:${record.biographyId}`,
    branchId: 'branch:A', artifactType: 'biography', artifactId: record.biographyId,
    unitType: 'stage', unitId: 'stage-1', boundView: { viewId: 'v0', resolvedRevision: 0, queryScopeHash: 'scope' },
    entityIds: [], factIds, operationRefs: [], sourceRefs: ['source'], createdAt: 1 };
}
function butterfly(id: string, updatedAt = 1): ButterflyRecord {
  return { key: `effect:${id}`, namespace, runId: id, requestId: 'request', request: {},
    result: { effect: { historicalEvolution: `演变原文${id}`, presentLanding: `落点原文${id}`,
      ruinActionRecord: `行动原文${id}`, perceptibleEvidence: [`证据一${id}`, `证据二${id}`], historicalKeywords: [] } },
    sourceHash: 'hash', panel: `[标题|${id}]`, archiveEntry: `### ${id}`, assistantMessageId: 11,
    status: 'committed', revision: 1, canonRevision: 0, createdAt: updatedAt, updatedAt,
  } as unknown as ButterflyRecord;
}
function snapshot(bios: BiographyRecord[], query: string, current = branch(), records: ButterflyRecord[] = []) {
  return buildCanonMemorySnapshot({ records, biographies: bios, branch: current, matchText: query,
    focusText: query, trigger: 'test', now: 1 });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function relate(left: BiographyRecord, right: BiographyRecord) {
  for (const record of [left, right]) record.continuityAnchors ??= [{
    schema: 'eyon.continuity.anchor.v1', anchorId: `anchor:${record.biographyId}`,
    branchId: 'branch:A', canonRevision: 0,
    producer: { artifactType: 'biography', artifactId: record.biographyId, unitId: 'stage-1' },
    eventId: 'event:same', claim: record.biography.stages[0]!.content,
    temporalScope: { label: '复兴纪元479年' }, participants: [], locations: [],
    sourceRefs: [record.biographyId], stance: 'asserted', createdAt: 1,
  }];
  (left.continuityRelations ??= []).push({ schema: 'eyon.continuity.relation.v1',
    relationId: `relation:${left.biographyId}:${right.biographyId}`, namespace: namespaceKey(namespace),
    branchId: 'branch:A', canonRevision: 0, kind: 'sourceConflict', dimension: 'outcome',
    memberAnchorIds: [left.continuityAnchors![0]!.anchorId, right.continuityAnchors![0]!.anchorId],
    producerArtifactId: left.biographyId, producerUnitRef: 'stage-1', sourceRefs: ['甲', '乙'], createdAt: 1 });
}

function entryMemoryHooks(channel: CanonMemoryChannel, barrier: Promise<void>) {
  const source = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const loadCanonMemory = async');
  const end = source.indexOf('  const onCanonMemoryChatChanged', start);
  assert.ok(start >= 0 && end > start);
  const compiled = ts.transpileModule(`
    let generationMemoryRefreshes = 0;
    const disposed = false, contextRevision = 0;
    const renderedMemoryBarrier = barrier;
    const scopeReader = { getNamespace: () => namespace };
    const globalObject = {};
    const readTavernComposerText = () => '八岁生日的姐姐遇害事件';
    const butterflies = { list: async () => [], listMemoryTombstones: async () => [] };
    const biographies = { list: async () => records };
    const canon = { getBranch: async () => currentBranch };
    ${source.slice(start, end)}
    return { refreshCanonMemory };
  `, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function('canonMemory', 'barrier', 'namespace', 'namespaceKey', 'records', 'currentBranch', compiled)(
    channel, barrier, namespace, namespaceKey, [biography()], branch(),
  ) as { refreshCanonMemory: (trigger: string) => Promise<void> };
}

test('旧传记无连续性锚仍按别名召回完整原文章节，不要求重新生成', () => {
  const bio = biography();
  const memory = snapshot([bio], '珊奈的姐姐遇害那晚');
  assert.ok(memory.injectedText.includes(bio.biography.stages[0]!.content));
  assert.equal(memory.continuity.passageCount, 3);
  assert.ok(memory.injectedText.includes('未经当前历史依赖核定'));
});

test('无关话题不凭归档权威保底触发传记', () => {
  assert.equal(snapshot([biography()], '今天去市场买苹果。').continuity.passageCount, 0);
});

test('传记明确事件题名和正文双词可召回，不要求点名主体', () => {
  const bio = biography();
  assert.equal(snapshot([bio], '八岁生日的姐姐遇害事件').continuity.passageCount, 1);
  assert.equal(snapshot([bio], '姐姐遇害 台灯永久保存').continuity.passageCount, 1);
});

test('原文内独特书名能召回，外部作者名和不存在的别名不会凭空加入索引', () => {
  const bio = biography('二叶');
  bio.biography.target.aliases = [];
  bio.biography.stages[0]!.content = '她保管着《暮潮手札》，等待下一次移交。';
  assert.equal(snapshot([bio], '《暮潮手札》在哪里').continuity.passageCount, 1);
  assert.equal(snapshot([bio], '银莳萝').continuity.passageCount, 0);
});

test('明确研究已保存的伊雍传记仍可召回，不因名字与工作台同名被误过滤', () => {
  const bio = biography('伊雍');
  bio.biography.target.aliases = [];
  assert.ok(snapshot([bio], '伊雍的历史').injectedText.includes(bio.biography.stages[0]!.content));
});

test('NFKC、大小写与空格差异不妨碍明确别名命中', () => {
  const bio = biography('Alice');
  bio.biography.target.aliases = ['ALICE'];
  assert.ok(snapshot([bio], 'ＡＬＩＣＥ 的历史').injectedText.includes('台灯永久保存'));
});

test('通用词单独不召回，通用词加独立事件线索可召回', () => {
  const index = new ArchiveMemoryIndex();
  index.sync('A', [{ key: 'one', title: '旧城事件', content: '姐姐遇害后留下台灯。', keywords: ['姐姐'] }]);
  assert.equal(index.score('one', '姐姐').score, 0);
  assert.ok(index.score('one', '姐姐遇害').score > 0);
});

test('同一章节原文更新、删除、切作用域均更新派生索引', () => {
  const index = new ArchiveMemoryIndex();
  const unit = { key: 'one', title: '记录', content: '保存《旧手札》', keywords: [] };
  index.sync('A', [unit]);
  assert.ok(index.score('one', '旧手札').score > 0);
  index.sync('A', [{ ...unit, content: '保存《新手札》' }]);
  assert.equal(index.score('one', '旧手札').score, 0);
  assert.ok(index.score('one', '新手札').score > 0);
  index.sync('A', []);
  assert.equal(index.score('one', '新手札').score, 0);
  index.sync('B', [unit]);
  assert.equal(index.score('one', '新手札').score, 0);
});

test('历史修订推进不使未受影响的绑定传记失去原文召回', () => {
  const bio = biography();
  bio.canonBindings = [binding(bio, ['base:unchanged'])];
  assert.ok(snapshot([bio], '八岁生日的姐姐遇害事件', branch(500)).injectedText.includes('台灯永久保存'));
});

test('明确失效的章节整体不投递，不把旧历史截成新事实', () => {
  const bio = biography();
  bio.canonBindings = [binding(bio, ['base:old'])];
  const current = branch(1);
  current.revisions = [{ revision: 1, parentRevision: 0, deltaId: 'delta:new', status: 'active', createdAt: 1,
    actionId: 'action', assistantMessageId: 11, receiptId: 'receipt' }];
  current.deltas = [{ schema: 'eyon.canon.intervention-delta.v1', deltaId: 'delta:new', branchId: 'branch:A',
    revision: 1, parentRevision: 0, actionRef: 'action', effectiveFrom: { label: '复兴纪元' },
    operations: [{ op: 'replace', factKey: 'person|life', originalFactIds: ['base:old'],
      current: { factId: 'fact:new', subjectEntityId: 'person', predicate: 'life', object: '新事实',
        statement: '新事实', sourceRefs: ['source'], sourceSnapshotIds: [], sourceSpans: [],
        temporalScope: '复兴纪元', spatialScope: null, epistemicStatus: 'generated', confidence: 'high',
        revisionIntroduced: 1, revisionRetired: null } }], preconditionFactIds: [], dependsOnDeltaIds: [],
    cascadeScope: { entityIds: [], locations: [] }, preserves: [], supersedesDeltaIds: [],
    status: 'active', verified: true, createdAt: 1 } as InterventionDelta];
  const memory = snapshot([bio], '八岁生日的姐姐遇害事件', current);
  assert.equal(memory.continuity.passageCount, 0);
  assert.ok(memory.continuity.warnings.some(item => item.includes('已失效')));
});

test('回滚后的未来绑定、其他分支、其他卡和未提交传记均不投递', () => {
  for (const mode of ['future', 'branch', 'card', 'pending']) {
    const bio = biography();
    bio.canonBindings = [binding(bio)];
    if (mode === 'future') bio.canonBindings[0]!.boundView.resolvedRevision = 1;
    if (mode === 'branch') bio.canonBindings[0]!.branchId = 'branch:B';
    if (mode === 'card') bio.namespace = { ...namespace, characterKey: '其他卡' };
    if (mode === 'pending') bio.status = 'validated';
    assert.equal(snapshot([bio], '八岁生日的姐姐遇害事件').continuity.passageCount, 0, mode);
  }
});

test('任意长原文章节原样投递，后半段及空行不被截断', () => {
  const bio = biography();
  bio.biography.stages[0]!.content = '原文完整句。\n\n'.repeat(3000) + 'FINAL_PROSE_DETAIL';
  assert.ok(snapshot([bio], '八岁生日的姐姐遇害事件').injectedText.includes(bio.biography.stages[0]!.content));
});

test('章节纪年或模糊时段原样带入，不能只投递脱离时间背景的正文', () => {
  const bio = biography();
  bio.biography.stages[0]!.span = '远古时期，约八岁生日当晚';
  assert.ok(snapshot([bio], '八岁生日的姐姐遇害事件').injectedText.includes('远古时期，约八岁生日当晚'));
});

test('无关历史修订推进后已知冲突仍成组投递双边完整原文', () => {
  const left = biography('档案甲');
  const right = biography('档案乙');
  right.biography.stages[0]!.title = '另一个标题';
  right.biography.stages[0]!.content = '另一份记载。\n\n与甲方有不同结局。';
  relate(left, right);
  const memory = buildBiographyArchiveMemory({ records: [left, right], branch: branch(99),
    query: '八岁生日的姐姐遇害事件' });
  assert.equal(memory.passageCount, 2);
  assert.ok(memory.text.includes(left.biography.stages[0]!.content));
  assert.ok(memory.text.includes(right.biography.stages[0]!.content));
  assert.ok(memory.text.includes('来源冲突'));
});

test('冲突关系缺失另一边原文时整组跳过，不把单边写成定论', () => {
  const left = biography('档案甲');
  const right = biography('档案乙');
  relate(left, right);
  const memory = buildBiographyArchiveMemory({ records: [left], branch: branch(),
    query: '八岁生日的姐姐遇害事件' });
  assert.equal(memory.passageCount, 0);
  assert.ok(memory.warnings.some(item => item.includes('无法完整投递')));
});

test('传记数量预算不能切开四方冲突簇，三个完整章节仍可一起投递', () => {
  const records = ['甲', '乙', '丙', '丁'].map(name => biography(`档案${name}`));
  for (let i = 1; i < records.length; i++) relate(records[i - 1]!, records[i]!);
  const query = '八岁生日的姐姐遇害事件';
  assert.equal(buildBiographyArchiveMemory({ records, branch: branch(), query }).passageCount, 0);
  records[2]!.continuityRelations = [];
  assert.equal(buildBiographyArchiveMemory({ records: records.slice(0, 3), branch: branch(), query }).passageCount, 3);
});

test('损坏或跨聊天的可选关系不污染本聊天原文召回', () => {
  const left = biography('档案甲');
  const right = biography('档案乙');
  relate(left, right);
  left.continuityRelations![0]!.namespace = namespaceKey({ ...namespace, chatId: '聊天B' });
  left.continuityRelations!.push({ schema: 'eyon.continuity.relation.v1' } as never);
  assert.equal(buildBiographyArchiveMemory({ records: [left], branch: branch(),
    query: '八岁生日的姐姐遇害事件' }).passageCount, 1);
});

test('蝴蝶旧记录无行动账本也投递完整行动、演变、落点和全部证据', () => {
  const record = butterfly('古林契约');
  record.result.effect.historicalEvolution = '第一段。\n\n' + '完整演变。'.repeat(1500) + 'END_OF_EVOLUTION';
  const memory = snapshot([], '古林契约', branch(), [record]);
  for (const original of [record.result.effect.ruinActionRecord, record.result.effect.historicalEvolution,
    record.result.effect.presentLanding, ...record.result.effect.perceptibleEvidence]) {
    assert.ok(memory.injectedText.includes(original));
  }
});

test('一千楼之后当前关键词仍召回很早的传记和蝴蝶，不依赖原楼留在上下文', async () => {
  const bio = biography();
  const old = butterfly('八岁生日的姐姐遇害事件');
  const writes: string[] = [];
  const channel = new CanonMemoryChannel({
    getChatMessages: () => Array.from({ length: 1000 }, (_, i) => ({ message_id: i, role: 'assistant', message: '今天吃苹果。' })),
    setExtensionPrompt: (_key, text) => { writes.push(text); },
  });
  await channel.refresh({ records: [old, butterfly('新事件A', 2), butterfly('新事件B', 3)], biographies: [bio],
    branch: branch(), currentInput: '八岁生日的姐姐遇害事件', trigger: 'before-generation', now: 1 });
  assert.ok(writes[0]!.includes(old.result.effect.ruinActionRecord));
  assert.ok(writes[0]!.includes(bio.biography.stages[0]!.content));
});

test('其他聊天蝴蝶即使命中关键词也不进入正文', () => {
  const record = butterfly('古林契约');
  record.namespace = { ...namespace, chatId: '聊天B' };
  assert.equal(snapshot([], '古林契约', branch(), [record]).injectedText, '');
});

test('回滚后的未来蝴蝶记录即使缺旧delta绑定也不重新注入', () => {
  const record = butterfly('古林契约');
  record.canonRevision = 2;
  assert.equal(snapshot([], '古林契约', branch(1), [record]).injectedText, '');
});

test('生成前等待归档读取和宿主提示写入确认，再允许正文继续', async () => {
  const read = deferred<{ records: ButterflyRecord[]; branch: CanonBranch; trigger: string; now: number }>();
  const ack = deferred<void>();
  const writes: string[] = [];
  let continued = false;
  const channel = new CanonMemoryChannel({ getChatMessages: () => [],
    setExtensionPrompt: (_key, text) => { writes.push(text); return ack.promise; } });
  const pending = channel.refreshBeforeGeneration(() => read.promise).then(() => { continued = true; });
  assert.equal(continued, false);
  read.resolve({ records: [butterfly('古林契约')], branch: branch(), trigger: 'before-generation', now: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(writes[0]!.includes('行动原文古林契约'));
  assert.equal(continued, false);
  ack.resolve();
  await pending;
  assert.equal(continued, true);
});

test('真实入口：归档完成的后台刷新不能取消生成前等待提示写入的屏障', async () => {
  const commit = deferred<void>();
  const ack = deferred<void>();
  const channel = new CanonMemoryChannel({ getChatMessages: () => [],
    setExtensionPrompt: (_key, text) => text ? ack.promise : undefined });
  const hooks = entryMemoryHooks(channel, commit.promise);
  const committed = commit.promise.then(() => hooks.refreshCanonMemory('message-committed'));
  let continued = false;
  const preparing = hooks.refreshCanonMemory('before-generation').then(() => { continued = true; });
  commit.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(continued, false);
  ack.resolve();
  await Promise.all([preparing, committed]);
  assert.equal(continued, true);
});

test('生成前读取超时放行并清空旧提示，迟到结果不能重新注入', async () => {
  const read = deferred<{ records: ButterflyRecord[]; branch: CanonBranch; trigger: string; now: number }>();
  const writes: string[] = [];
  const channel = new CanonMemoryChannel({ getChatMessages: () => [], setExtensionPrompt: (_key, text) => { writes.push(text); } });
  assert.equal(await channel.refreshBeforeGeneration(() => read.promise, () => true, 10), null);
  assert.equal(channel.snapshot(), null);
  assert.ok(channel.lastFailure().includes('超时'));
  read.resolve({ records: [butterfly('迟到事件')], branch: branch(), trigger: 'before-generation', now: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(writes, ['']);
});

test('生成前资料读取失败不阻断正文，也不沿用旧注入', async () => {
  const writes: string[] = [];
  const channel = new CanonMemoryChannel({ getChatMessages: () => [], setExtensionPrompt: (_key, text) => { writes.push(text); } });
  assert.equal(await channel.refreshBeforeGeneration(async () => { throw new Error('READ_FAILED'); }), null);
  assert.ok(channel.lastFailure().includes('READ_FAILED'));
  assert.deepEqual(writes, ['']);
});

test('旧召回超时不能清空较新聊天已经写入的提示', async () => {
  const read = deferred<{ records: ButterflyRecord[]; branch: CanonBranch; trigger: string; now: number }>();
  const writes: string[] = [];
  const channel = new CanonMemoryChannel({ getChatMessages: () => [], setExtensionPrompt: (_key, text) => { writes.push(text); } });
  const old = channel.refreshBeforeGeneration(() => read.promise, () => true, 10);
  await channel.clear('chat-changed', 2);
  await channel.refresh({ records: [butterfly('新聊天事件')], branch: branch(), trigger: 'chat-changed', now: 2 });
  assert.equal(await old, null);
  assert.equal(writes.length, 2);
  assert.ok(channel.snapshot()!.injectedText.includes('行动原文新聊天事件'));
  assert.equal(channel.lastFailure(), '');
  read.resolve({ records: [butterfly('旧聊天事件')], branch: branch(), trigger: 'before-generation', now: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 2);
});

test('宿主拒绝提示写入时不宣称召回成功，清空后保留诊断并允许正文继续', async () => {
  const writes: string[] = [];
  const channel = new CanonMemoryChannel({ getChatMessages: () => [], setExtensionPrompt: (_key, text) => {
    writes.push(text);
    if (text) throw new Error('HOST_WRITE_FAILED');
  } });
  assert.equal(await channel.refreshBeforeGeneration(async () => ({ records: [butterfly('事件')],
    branch: branch(), trigger: 'before-generation', now: 1 })), null);
  assert.equal(channel.snapshot(), null);
  assert.ok(channel.lastFailure().includes('HOST_WRITE_FAILED'));
  assert.equal(writes.at(-1), '');
});
