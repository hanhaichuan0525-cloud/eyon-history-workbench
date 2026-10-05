import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonBranch, InterventionDelta } from '../src/retrieval/contracts.ts';
import type { ButterflyRecord } from '../src/storage/butterflies.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';
import {
  assessRecordEffectiveness,
  buildCanonMemorySnapshot,
  CANON_MEMORY_STOPWORDS,
  CanonMemoryChannel,
  extractHardKeywords,
  extractSoftKeywords,
  scoreEntry,
  createCanonMemoryTombstone,
} from '../src/runtime/canonMemoryChannel.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function memoryRefreshFixture() {
  const writes: Array<{ chat: string; text: string }> = [];
  let chat = 'chat-A';
  let revision = 0;
  const channel = new CanonMemoryChannel({
    getChatMessages: () => [{ message_id: 0, role: 'user', message: '尤娜' }],
    setExtensionPrompt: (_key, text) => { writes.push({ chat, text }); },
  });
  const input = {
    records: [record({ runId: 'run-A', revision: 1, deltaRef: 'd-A', title: 'A历史',
      evolution: 'ONLY_FROM_A：尤娜的历史改写。', keywords: ['尤娜'] })],
    branch: branch([delta({ deltaId: 'd-A', revision: 1, subjectNames: ['尤娜'] })]),
    trigger: 'manual', now: 1,
  };
  const guard = () => {
    const expectedChat = chat;
    const expectedRevision = revision;
    return () => chat === expectedChat && revision === expectedRevision;
  };
  return { channel, writes, input, guard,
    switchTo: (next: string) => { chat = next; revision += 1; } };
}

test('异步A记忆晚于B清空完成，不能注入B聊天', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise, fixture.guard());
  fixture.switchTo('chat-B');
  await fixture.channel.clear('chat-changed', 2);
  pending.resolve(fixture.input);
  assert.equal(await oldRefresh, null);
  assert.equal(fixture.channel.snapshot(), null);
  assert.deepEqual(fixture.writes, [{ chat: 'chat-B', text: '' }]);
});

test('即使尚未收到切卡清理事件，命名空间守卫也拒绝旧A记忆', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise, fixture.guard());
  fixture.switchTo('chat-B');
  pending.resolve(fixture.input);
  assert.equal(await oldRefresh, null);
  assert.deepEqual(fixture.writes, []);
});

test('A→B→A后旧读取批次失效，但新A读取正常注入', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise, fixture.guard());
  fixture.switchTo('chat-B');
  await fixture.channel.clear('chat-changed', 2);
  fixture.switchTo('chat-A');
  pending.resolve(fixture.input);
  assert.equal(await oldRefresh, null);
  const fresh = await fixture.channel.refreshFromSource(async () => fixture.input, fixture.guard());
  assert.ok(fresh?.injectedText.includes('ONLY_FROM_A'));
  assert.ok(fixture.writes.at(-1)?.text.includes('ONLY_FROM_A'));
});

test('同一聊天并发刷新只允许最新读取结果注入', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise, fixture.guard());
  const newest = await fixture.channel.refreshFromSource(async () => ({ ...fixture.input,
    records: [], branch: branch([]), trigger: 'newest' }), fixture.guard());
  pending.resolve(fixture.input);
  assert.equal(await oldRefresh, null);
  assert.equal(fixture.channel.snapshot(), newest);
  assert.deepEqual(fixture.writes, [{ chat: 'chat-A', text: '' }]);
});

test('退役后旧资料读取不能重新建立记忆注入', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise);
  await fixture.channel.clear('dispose', 2);
  pending.resolve(fixture.input);
  assert.equal(await oldRefresh, null);
  assert.deepEqual(fixture.writes, [{ chat: 'chat-A', text: '' }]);
});

test('退役后旧读取失败不会变成新聊天的报错', async () => {
  const fixture = memoryRefreshFixture();
  const pending = deferred<typeof fixture.input>();
  const oldRefresh = fixture.channel.refreshFromSource(() => pending.promise);
  await fixture.channel.clear('dispose', 2);
  pending.reject(new Error('OLD_SOURCE_FAILED'));
  assert.equal(await oldRefresh, null);
  assert.equal(fixture.channel.lastFailure(), '');
});

test('已失效的刷新不会开始读取，当前来源故障仍正常暴露', async () => {
  const fixture = memoryRefreshFixture();
  let reads = 0;
  assert.equal(await fixture.channel.refreshFromSource(async () => {
    reads += 1;
    return fixture.input;
  }, () => false), null);
  assert.equal(reads, 0);
  await assert.rejects(fixture.channel.refreshFromSource(async () => {
    throw new Error('CURRENT_SOURCE_FAILED');
  }), /CURRENT_SOURCE_FAILED/);
});

test('旧注入接口的异步确认失败，不覆盖新聊天已清空的诊断', async () => {
  const ack = deferred<void>();
  let count = 0;
  const channel = new CanonMemoryChannel({ getChatMessages: () => [],
    setExtensionPrompt: () => ++count === 1 ? ack.promise : undefined });
  const fixture = memoryRefreshFixture();
  const old = channel.refresh(fixture.input);
  await channel.clear('chat-changed', 2);
  ack.reject(new Error('OLD_WRITE_ACK_FAILED'));
  await old;
  assert.equal(channel.snapshot(), null);
  assert.equal(channel.lastFailure(), '');
});

function delta(input: {
  deltaId: string;
  revision: number;
  status?: InterventionDelta['status'];
  subjectNames?: string[];
  locations?: string[];
  entityIds?: string[];
}): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1',
    deltaId: input.deltaId,
    branchId: 'canon:test',
    revision: input.revision,
    parentRevision: Math.max(0, input.revision - 1),
    actionRef: `action:${input.deltaId}`,
    effectiveFrom: { label: `复兴纪元${320 + input.revision}年` },
    operations: (input.entityIds ?? []).map((entityId, index) => ({
      op: 'assert' as const,
      factKey: `${entityId}|historical_change|复兴纪元${320 + input.revision}年`,
      originalFactIds: [],
      current: {
        factId: `fact:${input.deltaId}:${index}`,
        subjectEntityId: entityId,
        predicate: 'historical_change',
        object: '测试变化',
        statement: '测试变化陈述',
        temporalScope: `复兴纪元${320 + input.revision}年`,
        spatialScope: null,
        epistemicStatus: 'generated' as const,
        confidence: 'medium' as const,
        sourceRefs: ['chat:8'],
        sourceSnapshotIds: [],
        sourceSpans: [],
        revisionIntroduced: input.revision,
        revisionRetired: null,
      },
    })),
    preconditionFactIds: [],
    dependsOnDeltaIds: [],
    cascadeScope: {
      entityIds: input.entityIds ?? [],
      locations: input.locations ?? [],
      subjectNames: input.subjectNames ?? [],
    },
    preserves: [],
    supersedesDeltaIds: [],
    status: input.status ?? 'active',
    verified: true,
    createdAt: input.revision,
  };
}

function record(input: {
  runId: string;
  revision: number;
  deltaRef?: string;
  canonStatus?: ButterflyRecord['canonStatus'];
  status?: ButterflyRecord['status'];
  title: string;
  evolution: string;
  keywords: string[];
  updatedAt?: number;
}): ButterflyRecord {
  return {
    key: `butterfly:${input.runId}`,
    namespace: { characterKey: '伊雍', chatId: 'chat' },
    runId: input.runId,
    requestId: `request-${input.runId}`,
    request: {} as never,
    result: {
      effect: {
        roll: 68,
        scope: '城市',
        presentLanding: '黄昏花室的铅灰穹顶',
        perceptibleEvidence: ['主梁上一道被秘银填平的指痕状裂纹'],
        ruinActionRecord: '玩家在黄昏花室扼杀了学徒尤娜。',
        historicalEvolution: input.evolution,
        historicalKeywords: input.keywords,
      },
    } as never,
    sourceHash: 'hash',
    panel: '[标题|测试面板]',
    archiveEntry: `### ${input.title}\n正文`,
    assistantMessageId: 60,
    status: input.status ?? 'committed',
    revision: input.revision,
    ...(input.deltaRef ? { deltaRef: input.deltaRef } : {}),
    ...(input.canonStatus ? { canonStatus: input.canonStatus } : {}),
    canonRevision: input.revision,
    worldbookName: '伊雍-蝴蝶效应锚定-chat',
    worldbookUid: 1,
    createdAt: input.revision,
    updatedAt: input.updatedAt ?? input.revision,
  } as unknown as ButterflyRecord;
}

function branch(deltas: InterventionDelta[], headRevision = deltas.length): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1',
    branchId: 'canon:test',
    characterKey: '伊雍',
    chatId: 'chat',
    headRevision,
    revisions: deltas.map(item => ({
      revision: item.revision,
      parentRevision: item.parentRevision,
      actionId: item.actionRef,
      deltaId: item.deltaId,
      assistantMessageId: 60,
      status: item.status === 'reverted' ? 'reverted' as const : 'active' as const,
      receiptId: `receipt:${item.deltaId}`,
      createdAt: item.createdAt,
    })),
    actions: deltas.map(item => ({
      schema: 'eyon.canon.intervention-action.v1' as const,
      actionId: item.actionRef,
      branchId: 'canon:test',
      runId: item.deltaId,
      userMessageId: 59,
      assistantMessageId: 60,
      rawCommand: '遣返',
      actionRecord: '行动记录',
      sourceRefs: ['chat:8'],
      occurredAt: { label: '复兴纪元321年' },
      createdAt: item.createdAt,
    })),
    deltas,
    receipts: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as CanonBranch;
}

test('赎出本人状态不随旧档案未命中或整条数量预算退场；失效与跨聊天不投递', () => {
  const deltas = Array.from({ length: 8 }, (_, i) => delta({ deltaId: `d${i + 1}`, revision: i + 1,
    entityIds: [`entity:person-${i + 1}`], subjectNames: [`人物${i + 1}`] }));
  const fact = deltas[0]!.operations[0]!.current;
  fact.predicate = 'historical_redemption'; fact.temporalScope = '神明纪元1年';
  fact.statement = '二叶保持半岁形态离开原历史并抵达现世。';
  const records = deltas.map(d => record({ runId: d.deltaId, deltaRef: d.deltaId, revision: d.revision,
    title: d.deltaId, evolution: '完全无关的普通历史原文', keywords: ['旁人'] }));
  const input = { records, branch: branch(deltas), matchText: '现在看窗外', trigger: 'before-generation', now: 100 };
  const snapshot = buildCanonMemorySnapshot(input);
  assert.equal(snapshot.entries.find(entry => entry.runId === 'd1')!.status, 'unmatched');
  assert.match(snapshot.injectedText, /二叶保持半岁/u);
  assert.match(snapshot.injectedText, /旧成年版本/u);
  assert.match(snapshot.injectedText, /赎出前/u);
  assert.match(snapshot.injectedText, /不在场/u);
  const deletedArchive = buildCanonMemorySnapshot({ ...input, records: [] });
  assert.match(deletedArchive.injectedText, /二叶保持半岁/u, '仅删除展示档案不撤销有效Canon');
  for (const invalidate of [
    (b: CanonBranch) => { b.deltas[0]!.status = 'reverted'; },
    (b: CanonBranch) => { b.deltas[0]!.status = 'orphaned'; },
    (b: CanonBranch) => { b.deltas[0]!.verified = false; },
    (b: CanonBranch) => { b.revisions[0]!.status = 'reverted'; },
    (b: CanonBranch) => { b.headRevision = 0; },
    (b: CanonBranch) => { b.branchId = 'another-branch'; },
  ]) {
    const b = structuredClone(input.branch); invalidate(b);
    assert.doesNotMatch(buildCanonMemorySnapshot({ ...input, branch: b }).injectedText, /<HISTORICAL_REDEMPTION_CURRENT>/u);
  }
  const anotherChat = branch([]);
  anotherChat.chatId = 'other-chat';
  assert.equal(buildCanonMemorySnapshot({ ...input, branch: anotherChat }).injectedText, '');
});

test('硬关键词：取 cascadeScope 专名与载体名，泛词与身份 id 前缀被剔除', () => {
  const hard = extractHardKeywords(
    delta({
      deltaId: 'd1', revision: 1,
      subjectNames: ['尤娜', '帝国'],
      locations: ['黄昏花室', '大陆'],
      entityIds: ['entity:generated:%E6%8D%95%E5%85%89%E7%90%89%E7%92%83'],
    }),
  );
  assert.ok(hard.includes('尤娜'));
  assert.ok(hard.includes('黄昏花室'));
  assert.ok(hard.includes('捕光琉璃'), 'generated 实体名应被解码为可读专名');
  assert.ok(!hard.includes('帝国'), '泛词应被剔除');
  assert.ok(!hard.includes('大陆'), '泛词应被剔除');
  assert.ok(CANON_MEMORY_STOPWORDS.has('帝国'));
});

test('G-10①：载体描述句与整条地点链不进硬词池（永不命中=死词）', () => {
  const hard = extractHardKeywords(delta({
    deltaId: 'd12', revision: 12,
    subjectNames: [
      '第三麦庄巡夜管事及其口述报告',
      '麦庄管理条例与“监察者”石雕',
      '金谷城烘焙公会规章与装饰艺术',
      '托马斯',
    ],
    locations: ['奥古斯提姆帝国-东部金谷城外郊-第三麦庄草料库'],
  }));
  assert.ok(!hard.includes('第三麦庄巡夜管事及其口述报告'), '含"及其"的描述句应被剔除');
  assert.ok(hard.includes('托马斯'), '短专名保留');
  assert.ok(hard.includes('第三麦庄草料库'), '地点链应按层级拆分后入池');
  assert.ok(hard.includes('东部金谷城外郊'), '地点链的中间层级入池');
  assert.ok(!hard.some(word => word.includes('-')), '不应保留整条地点链');
  assert.ok(hard.every(word => word.length <= 12), '硬词长度有界');
});

test('G-10②：模型关键词只进软词池，不参与硬触发', () => {
  const keywords = ['托马斯', '监察者神位'];
  const withKeywords = record({
    runId: 'r12', revision: 12, title: '《蝴蝶效应锚定日志1》',
    evolution: '…', keywords,
  });
  const hard = extractHardKeywords(delta({ deltaId: 'd12', revision: 12, subjectNames: ['第三麦庄'] }));
  assert.ok(hard.includes('第三麦庄'));
  assert.ok(!hard.includes('托马斯'), '模型关键词不得进入硬词池');
  assert.deepEqual(extractSoftKeywords(withKeywords), keywords, '模型关键词仍在软词池');
});

test('软关键词：模型关键词过泛词/长度闸', () => {
  const soft = extractSoftKeywords(record({
    runId: 'r1', revision: 1, title: '《尤娜案》', evolution: '…',
    keywords: ['尤娜', '帝国', '历史', 'a', '捕光琉璃'],
  }));
  assert.deepEqual(soft, ['尤娜', '捕光琉璃']);
});

test('打分：硬词命中即触发；软词需 ≥2 或 1 个特异词', () => {
  const rarity = { counts: new Map([['尤娜', 2], ['千爻', 1]]) };
  assert.equal(
    scoreEntry({ hardKeywords: ['尤娜'], softKeywords: [], rarity, matchText: '尤娜的旧部' }).triggered,
    true,
  );
  assert.equal(
    scoreEntry({ hardKeywords: [], softKeywords: ['尤娜'], rarity, matchText: '尤娜的旧部' }).triggered,
    false,
    '单个非特异软词不触发',
  );
  assert.equal(
    scoreEntry({ hardKeywords: [], softKeywords: ['尤娜', '捕光琉璃'], rarity, matchText: '尤娜与捕光琉璃' }).triggered,
    true,
    '两个软词叠加触发',
  );
  assert.equal(
    scoreEntry({ hardKeywords: [], softKeywords: ['千爻'], rarity, matchText: '千爻的名字' }).triggered,
    true,
    '单个特异词触发',
  );
});

test('有效性：reverted/orphaned/未提交记录不注入；缺 deltaRef 的旧档案保守有效', () => {
  const rev = delta({ deltaId: 'd1', revision: 1, status: 'reverted' });
  assert.equal(
    assessRecordEffectiveness(
      record({ runId: 'r1', revision: 1, deltaRef: 'd1', title: '《A》', evolution: '…', keywords: [] }),
      rev,
    ).effective,
    false,
  );
  assert.equal(
    assessRecordEffectiveness(
      record({
        runId: 'r2', revision: 2, deltaRef: 'd2', canonStatus: 'orphaned',
        title: '《B》', evolution: '…', keywords: [],
      }),
      delta({ deltaId: 'd2', revision: 2 }),
    ).effective,
    false,
  );
  assert.equal(
    assessRecordEffectiveness(
      record({
        runId: 'r3', revision: 3, status: 'validated', deltaRef: 'd3',
        title: '《C》', evolution: '…', keywords: [],
      }),
      delta({ deltaId: 'd3', revision: 3 }),
    ).effective,
    true,
    'delta 有效的记录按有效处理（提交状态由 delta 决定）',
  );
  const legacy = assessRecordEffectiveness(
    record({ runId: 'r4', revision: 4, title: '《D》', evolution: '…', keywords: [] }),
    undefined,
  );
  assert.equal(legacy.effective, true);
  assert.deepEqual(legacy.reasons, ['legacy-no-delta-ref']);
});

test('分层：最近两条有效变化常驻；更早按命中触发；失效不注入', () => {
  const deltas = [
    delta({ deltaId: 'd1', revision: 1, subjectNames: ['尤娜'], locations: ['黄昏花室'] }),
    delta({ deltaId: 'd2', revision: 2, subjectNames: ['金谷界石'], locations: ['金谷'] }),
    delta({ deltaId: 'd3', revision: 3, subjectNames: ['千爻'], locations: ['索伦蒂斯'] }),
    delta({ deltaId: 'd4', revision: 4, status: 'reverted', subjectNames: ['旧案'], locations: ['旧堡'] }),
  ];
  const records = [
    record({ runId: 'r1', revision: 1, deltaRef: 'd1', title: '《尤娜案》', evolution: '尤娜在黄昏花室被扼杀。', keywords: [] }),
    record({ runId: 'r2', revision: 2, deltaRef: 'd2', title: '《金谷案》', evolution: '金谷界石之争。', keywords: [] }),
    record({ runId: 'r3', revision: 3, deltaRef: 'd3', title: '《千爻案》', evolution: '千爻远航。', keywords: [] }),
    record({ runId: 'r4', revision: 4, deltaRef: 'd4', title: '《旧案》', evolution: '已回滚。', keywords: [] }),
  ];
  const snapshot = buildCanonMemorySnapshot({
    records,
    branch: branch(deltas, 4),
    matchText: '我们在黄昏花室遇到了尤娜的旧部。',
    trigger: 'before-generation',
    now: 123,
  });
  const byRun = new Map(snapshot.entries.map(entry => [entry.runId, entry]));
  assert.equal(byRun.get('r3')?.status, 'resident', '最近有效变化常驻');
  assert.equal(byRun.get('r2')?.status, 'resident', '次近有效变化常驻');
  assert.equal(byRun.get('r1')?.status, 'triggered', '更早但命中硬词 → 触发');
  assert.equal(byRun.get('r4')?.status, 'filtered', 'reverted 记录永不注入');
  assert.deepEqual(snapshot.counts, {
    total: 4, resident: 2, triggered: 1, unmatched: 0, filtered: 1,
  });
  assert.match(snapshot.injectedText, /<CANON_MEMORY branch="canon:test" revision="4">/u);
  assert.match(snapshot.injectedText, /禁止把已失效的旧史当作现行事实/u);
  assert.match(snapshot.injectedText, /人物关系、事件结局与专名以本简报为准/u, 'G-11 框定句');
  assert.match(snapshot.injectedText, /不是本回合的行动指令/u, 'G-11 边界句');
  assert.match(snapshot.injectedText, /《尤娜案》/u);
  assert.doesNotMatch(snapshot.injectedText, /已回滚/u, '失效记录正文不进入注入');
});

test('蝴蝶档案已保存的进入/离开时空锚会进入普通正文记忆，不再只藏在 request 中', () => {
  const archived = record({
    runId: 'r-anchor', revision: 1, deltaRef: 'd-anchor', title: '《黑曜监牢案》',
    evolution: '玲山获救后前往帝国边境。', keywords: [],
  });
  archived.request = {
    anchors: {
      reality: { time: '复兴纪元488年', location: '艾瑟嘉德' },
      ruinEntry: { time: '复兴纪元481年6月10日', location: '黑曜监牢' },
      ruinExit: { time: '复兴纪元481年6月11日', location: '梵尼亚外环密林' },
    },
  } as ButterflyRecord['request'];
  const snapshot = buildCanonMemorySnapshot({
    records: [archived],
    branch: branch([delta({
      deltaId: 'd-anchor', revision: 1, subjectNames: ['玲山'], locations: ['黑曜监牢'],
    })], 1),
    matchText: '玲山与黑曜监牢',
    trigger: 'before-generation',
    now: 123,
  });
  assert.match(snapshot.injectedText, /墟境进入：复兴纪元481年6月10日·黑曜监牢/u);
  assert.match(snapshot.injectedText, /墟境离开：复兴纪元481年6月11日·梵尼亚外环密林/u);
  assert.match(snapshot.injectedText, /现世基准：复兴纪元488年·艾瑟嘉德/u);
});

test('无命中且无有效记录时注入为空（清除语义，幂等）', () => {
  const empty = buildCanonMemorySnapshot({
    records: [],
    branch: branch([], 0),
    matchText: '普通闲聊',
    trigger: 'before-generation',
    now: 1,
  });
  assert.equal(empty.injectedText, '');
  assert.deepEqual(empty.counts, { total: 0, resident: 0, triggered: 0, unmatched: 0, filtered: 0 });

  const unmatched = buildCanonMemorySnapshot({
    records: [
      record({ runId: 'r9', revision: 1, deltaRef: 'd9', title: '《无关案》', evolution: '与话题无关。', keywords: [] }),
    ],
    branch: branch([delta({ deltaId: 'd9', revision: 1, subjectNames: ['风铎港'] })], 1),
    matchText: '我们在谈天气',
    trigger: 'before-generation',
    now: 2,
  });
  // 最近一条有效记录仍常驻（刚改完的历史必然相关），但内容不含无关命中的假设词
  assert.equal(unmatched.entries[0]?.status, 'resident');
  assert.match(unmatched.injectedText, /<CANON_MEMORY/u);
});

test('Canon 按整条记录数量限制，所选原文不截字，其他归档仍可再次召回', () => {
  const longEvolution = '尤娜'.repeat(200);
  const deltas = Array.from({ length: 12 }, (_, index) =>
    delta({ deltaId: `d${index + 1}`, revision: index + 1, subjectNames: ['尤娜'] }));
  const records = Array.from({ length: 12 }, (_, index) =>
    record({
      runId: `r${index + 1}`, revision: index + 1, deltaRef: `d${index + 1}`,
      title: `《案${index + 1}》`, evolution: longEvolution, keywords: [],
    }));
  const snapshot = buildCanonMemorySnapshot({
    records,
    branch: branch(deltas, 12),
    matchText: '尤娜',
    trigger: 'manual',
    now: 3,
  });
  const injectedLines = snapshot.injectedText.split('\n').filter(line => line.startsWith('[R'));
  assert.ok(injectedLines.length >= 2);
  assert.equal(injectedLines.length, 6);
  assert.equal(snapshot.counts.total, 12);
  assert.ok(snapshot.entries.filter(entry => entry.status === 'resident' || entry.status === 'triggered')
    .every(entry => entry.digest.includes(longEvolution)));
  assert.ok(snapshot.injectedText.includes('本轮数量预算未投递'));
});

test('G-09 可见档案删除后仍以紧凑残片解释 active Canon；回滚后自动退出', () => {
  const activeDelta = delta({
    deltaId: 'd-memory', revision: 1,
    subjectNames: ['玲山'], locations: ['黑曜监牢'],
    entityIds: ['entity:generated:%E7%8E%B2%E5%B1%B1'],
  });
  activeDelta.operations[0]!.current.statement = '玲山已脱离黑曜监牢并前往帝国边境。';
  const source = record({
    runId: 'r-memory', revision: 1, deltaRef: 'd-memory',
    title: '《黑曜监牢获救》', evolution: '旧档案长文不应被保留。', keywords: ['玲山', '黑曜监牢'],
  });
  source.actionRef = 'action:d-memory';
  source.request = {
    anchors: { ruinExit: { time: '复兴纪元481年', location: '黑曜监牢' } },
  } as ButterflyRecord['request'];
  const activeBranch = branch([activeDelta], 1);
  const tombstone = createCanonMemoryTombstone({ record: source, branch: activeBranch, now: 99 });
  assert.ok(tombstone);
  const snapshot = buildCanonMemorySnapshot({
    records: [], tombstones: [tombstone!], branch: activeBranch,
    matchText: '玲山回忆黑曜监牢', trigger: 'manual', now: 100,
  });
  assert.equal(snapshot.tombstoneCount, 1);
  assert.match(snapshot.injectedText, /海因里希|行动记录/u);
  assert.match(snapshot.injectedText, /玲山已脱离黑曜监牢/u);
  assert.doesNotMatch(snapshot.injectedText, /旧档案长文/u);

  const reverted = { ...activeDelta, status: 'reverted' as const };
  const rolledBack = buildCanonMemorySnapshot({
    records: [], tombstones: [tombstone!], branch: branch([reverted], 1),
    matchText: '玲山回忆黑曜监牢', trigger: 'message-deleted', now: 101,
  });
  assert.equal(rolledBack.injectedText, '');
  assert.equal(rolledBack.entries[0]?.status, 'filtered');
});

test('G-08 普通正文只在相关时接收同 revision 传记冲突双边，且与源 A 分栏', () => {
  const biographyRecords = biographyConflictRecords();
  const relevant = buildCanonMemorySnapshot({
    records: [], biographies: biographyRecords, branch: branch([], 0),
    matchText: '弥拉拿出《暮潮手札》，追问第七泊位的移交年份。',
    trigger: 'before-generation', now: 200,
  });
  assert.equal(relevant.continuity.anchorCount, 2);
  assert.equal(relevant.continuity.relationCount, 1);
  assert.match(relevant.injectedText, /<BIOGRAPHY_CONTINUITY_MEMORY>/u);
  assert.match(relevant.injectedText, /复兴纪元484年秋/u);
  assert.match(relevant.injectedText, /复兴纪元485年秋/u);
  assert.match(relevant.injectedText, /不得静默选边/u);
  assert.doesNotMatch(relevant.injectedText, /<CANON_MEMORY/u, '无源 A 时不得伪装成 Canon');

  const unrelated = buildCanonMemorySnapshot({
    records: [], biographies: biographyRecords, branch: branch([], 0),
    matchText: '今天去市场买苹果。', trigger: 'before-generation', now: 201,
  });
  assert.equal(unrelated.continuity.anchorCount, 0);
  assert.equal(unrelated.injectedText, '');
});

function biographyConflictRecords(): BiographyRecord[] {
  const make = (id: string, year: number) => {
    const anchorId = `continuity-anchor:${id}`;
    const bindingId = `binding:${id}`;
    return {
      key: `bio:${id}`, namespace: { characterKey: '伊雍', chatId: 'chat' },
      biographyId: `bio:${id}`, requestId: `request:${id}`,
      triggerMessageId: year, assistantMessageId: year,
      sourceHash: 'hash', status: 'committed', revision: 1,
      biography: {} as BiographyRecord['biography'],
      canonBindings: [{
        schema: 'eyon.canon.artifact-binding.v1', bindingId,
        branchId: 'canon:test', artifactType: 'biography', artifactId: `bio:${id}`,
        unitType: 'stage', unitId: 'stage-handover',
        boundView: { viewId: `view:${id}`, resolvedRevision: 0, queryScopeHash: 'scope' },
        entityIds: [], factIds: [], operationRefs: [], sourceRefs: [`source:${id}`], createdAt: year,
      }],
      continuityAnchors: [{
        schema: 'eyon.continuity.anchor.v1', anchorId,
        branchId: 'canon:test', canonRevision: 0,
        producer: { artifactType: 'biography', artifactId: `bio:${id}`, unitId: 'stage-handover', bindingId },
        eventId: 'event:暮潮移交', claimSource: 'final-prose',
        claim: `复兴纪元${year}年秋，洛安在第七泊位将《暮潮手札》交给弥拉。`,
        temporalScope: { label: `复兴纪元${year}年秋` },
        participants: [{ name: '洛安' }, { name: '弥拉' }],
        locations: [{ name: '第七泊位' }], objects: [{ name: '《暮潮手札》' }],
        sourceRefs: [`source:${id}`], stance: 'asserted', createdAt: year,
      }],
      continuityRelations: [], createdAt: year, updatedAt: year,
    } as BiographyRecord;
  };
  const first = make('484', 484);
  const second = make('485', 485);
  second.continuityRelations = [{
    schema: 'eyon.continuity.relation.v1', relationId: 'relation:handover-time',
    namespace: '%E4%BC%8A%E9%9B%8D::chat', branchId: 'canon:test', canonRevision: 0,
    kind: 'sourceConflict', dimension: 'time',
    memberAnchorIds: [first.continuityAnchors![0]!.anchorId, second.continuityAnchors![0]!.anchorId],
    sourceRefs: ['source:484', 'source:485'], producerArtifactId: 'bio:485',
    producerUnitRef: 'stage-handover', createdAt: 485,
  }];
  return [first, second];
}
