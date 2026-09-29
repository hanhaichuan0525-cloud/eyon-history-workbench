import assert from 'node:assert/strict';
import test from 'node:test';

import type { ButterflyHostAdapter } from '../src/adapters/host.ts';
import { TavernBiographyContextAssembler } from '../src/runtime/biographyContext.ts';
import { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import type {
  RuntimeChatMessage,
  RuntimeContextSourceProvider,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import { TavernGenealogyContextAssembler } from '../src/runtime/genealogyContext.ts';
import { TavernRuinContextAssembler } from '../src/runtime/ruinContext.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';

class ShadowRuntime implements TavernRuntime {
  getCurrentCharacterName() { return '命定之诗'; }
  getCurrentChatId() { return 'shadow-chat'; }
  getLastMessageId() { return 3; }
  getMessageSwipeId() { return 0; }
  getChatMessages(range: number | string): RuntimeChatMessage[] {
    const messages: RuntimeChatMessage[] = [
      {
        message_id: 0,
        role: 'user',
        message: '进入墟境前，我曾随口询问过圣翼议会。',
      },
      {
        message_id: 1,
        role: 'user',
        message: '我踏入这处历史特异点。',
      },
      {
        message_id: 2,
        role: 'assistant',
        message: [
          '圣翼议会正在金谷城召开紧急会议。',
          '[RuinTrace]',
          'Title:: 圣翼议会史案',
          'Type:: 稳定期',
          'Span:: 复兴纪元470年',
          'History:: 议会长期维持旧秩序。',
          'Shift:: 稳定期 → 动荡期',
          'NodeTime:: 复兴纪元470年5月',
          '[/RuinTrace]',
        ].join('\n'),
        extra: {
          eyonHistoryRuinEntryRequest: {
            requestId: 'ruin-entry-shadow',
            triggerMessageId: 1,
            triggerTextHash: 'hash',
            playerText: '我踏入这处历史特异点。',
            swipeId: 0,
            ruinHistory: {
              title: '圣翼议会史案',
              era: '复兴纪元488年',
              originalTrajectory: '议会维持旧秩序',
              historicalBackground: '王权与议会冲突',
              enteredAnomaly: '议长失踪',
              locationChain: ['金谷城'],
            },
          },
        },
      },
      {
        message_id: 3,
        role: 'user',
        message: '我保护议长并公开圣翼议会的秘密档案。',
      },
    ];
    if (typeof range === 'number') {
      return messages.filter(message => message.message_id === range);
    }
    const [start, end] = range.split('-').map(Number);
    return messages.filter(message =>
      message.message_id >= start && message.message_id <= end);
  }
  async setChatMessages() {}
  setExtensionPrompt() {}
  async generate() { return ''; }
  async generateRaw() { return ''; }
}

const simpleSource = (sourceId: string, title: string, content = `${title}的史料`) => ({
  sourceId,
  title,
  content,
});

const worldbookSource = (): RuntimeWorldbookSource => ({
  ...simpleSource('worldbook:命定之诗与黄昏之歌:7', '圣翼议会', '圣翼议会位于金谷城。'),
  strategyType: 'selective',
  keywords: ['圣翼议会'],
  worldbook: {
    schema: 'eyon.retrieval.worldbook-metadata.v1',
    logicalId: 'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97%E4%B8%8E%E9%BB%84%E6%98%8F%E4%B9%8B%E6%AD%8C:7',
    worldbookName: '命定之诗与黄昏之歌',
    uid: 7,
    bindingScopes: ['character-primary'],
    enabled: true,
    strategy: {
      type: 'selective',
      primaryKeys: ['圣翼议会'],
      secondary: { logic: 'and_any', keys: [] },
      scanDepth: 'same_as_global',
    },
    position: null,
    probability: null,
    recursion: null,
    effect: null,
    extra: {},
  },
});

const sources: RuntimeContextSourceProvider = {
  async getCurrentWorld() {
    return { time: '复兴纪元488年', location: '金谷城' };
  },
  async getWorldbookCorpus() {
    const book = [worldbookSource()];
    return {
      sources: book,
      receipt: {
        schema: 'eyon.retrieval.worldbook-corpus.v1',
        complete: true,
        bindings: [{ worldbookName: '命定之诗与黄昏之歌', scopes: ['character-primary'] }],
        entries: book.map(source => ({
          logicalId: source.worldbook.logicalId,
          sourceId: source.sourceId,
          worldbookName: source.worldbook.worldbookName,
          uid: source.worldbook.uid,
          title: source.title,
          bindingScopes: ['character-primary'],
          enabled: true,
          status: 'retrievable',
        })),
        counts: {
          total: book.length,
          enabled: book.length,
          retrievable: book.length,
          disabled: 0,
          empty: 0,
          'user-excluded': 0,
          'routed-generated': 0,
        },
      },
    };
  },
  async getWorldbookSources() {
    return [worldbookSource()];
  },
  async getCharacterSources() {
    return [simpleSource('mvu-character:议长', '议长', '议长主持圣翼议会。')];
  },
  async getGenealogySources() {
    return [simpleSource('genealogy:council', '议长谱系', '议长家系与圣翼议会有关。')];
  },
  async getBiographySources() {
    return [simpleSource('biography:chair', '议长传记', '议长生平与圣翼议会有关。')];
  },
  async getButterflySources() {
    return [simpleSource('butterfly:former', '旧蝴蝶锚', '议会档案曾被隐藏。')];
  },
};

const contextInput = {
  requestId: 'shadow-context',
  namespace: { characterKey: '命定之诗', chatId: 'shadow-chat' },
  triggerMessageId: 3,
  directive: '检索圣翼议会与议长的历史',
};

test('传记、谱系、墟境与蝴蝶效应全部以 active 回执生成正式上下文', async () => {
  const runtime = new ShadowRuntime();
  const observer = new RuntimeShadowRetrievalObserver();

  const activeBiography = await new TavernBiographyContextAssembler(runtime, sources, observer)
    .assemble(contextInput);
  assert.ok(activeBiography.sourceIndex.length > 0);

  const activeGenealogy = await new TavernGenealogyContextAssembler(runtime, sources, observer)
    .assemble(contextInput);
  assert.ok(activeGenealogy.sourceIndex.length > 0);

  const selectedBiographies = async () => new Set(['chair']);
  const activeRuin = await new TavernRuinContextAssembler(
    runtime,
    sources,
    selectedBiographies,
    observer,
  ).assemble(contextInput);
  assert.ok(activeRuin.sourceIndex.length > 0);

  const host: ButterflyHostAdapter = {
    async getNamespace() { return contextInput.namespace; },
    async getRuinRuntimeSnapshot() {
      return {
        flowState: 'anchored',
        runId: 'run-shadow',
        realityTime: '复兴纪元488年',
        realityLocation: '金谷城',
        ruinTime: '复兴纪元470年',
        ruinLocation: '旧议会厅',
      };
    },
    async getButterflyFreezeSnapshot() {
      return {
        flowState: 'anchored',
        runId: 'run-shadow',
        reality: { time: '复兴纪元488年', location: '金谷城' },
        ruinEntry: { time: '复兴纪元470年', location: '旧议会厅' },
        ruinExit: { time: '复兴纪元471年', location: '金谷城' },
      };
    },
    async getLatestUserText() { return '遣返'; },
    async replaceAssistantSlot() {},
    async assertButterflyTarget() {},
    async appendButterflyPanel() {},
  };
  const butterflyInput = {
    requestId: 'shadow-butterfly',
    namespace: contextInput.namespace,
    userMessageId: 3,
    rawCommand: '结算圣翼议会的蝴蝶效应',
    triggerType: 'button' as const,
    roll: 64,
  };
  const activeButterfly = await new TavernButterflyContextAssembler(
    runtime,
    sources,
    host,
    observer,
  ).freeze(butterflyInput);
  assert.ok(activeButterfly.request.sourceIndex.length > 0);
  assert.deepEqual(activeButterfly.request.ruinHistory, {
    title: '圣翼议会史案',
    era: '复兴纪元488年',
    originalTrajectory: '议会维持旧秩序',
    historicalBackground: '王权与议会冲突',
    enteredAnomaly: '议长失踪',
    locationChain: ['金谷城', '旧议会厅'],
  });
  assert.deepEqual(
    activeButterfly.request.playerInterventions.map(source => source.sourceId),
    ['chat:3'],
    '玩家干涉必须从权威进入助手楼之后开始，不得混入进入前聊天或入口史案楼',
  );

  const observations = observer.list();
  assert.deepEqual(
    observations.map(item => item.taskType),
    ['biography', 'genealogy', 'ruin', 'butterfly'],
  );
  for (const observation of observations) {
    assert.equal(observation.status, 'success');
    if (observation.status !== 'success') continue;
    assert.equal(observation.receipt.mode, 'active');
    assert.equal(observation.receipt.requestId, observation.requestId);
    assert.ok(observation.sourceMappings.every(item =>
      item.logicalId && item.snapshotId.startsWith(`${item.logicalId}@sha256:`)));
    assert.ok(observation.sourceMappings.every(item =>
      item.sourceType && item.title && Number.isInteger(item.sourceOrder)));
    assert.ok(observation.receipt.candidateSnapshotIds.length > 0);
    if (observation.receipt.selected.length > 0) {
      assert.ok(observation.receipt.selectedPassages.length > 0);
      assert.ok(observation.receipt.passageBudget.usedChars > 0);
      const passageSnapshotIds = new Set(
        observation.receipt.selectedPassages.map(passage => passage.snapshotId),
      );
      assert.ok(observation.receipt.selected.every(item => passageSnapshotIds.has(item.snapshotId)));
    }
    assert.doesNotMatch(JSON.stringify(observation.receipt), /圣翼议会位于金谷城/u);
    assert.equal(
      observation.receipt.selected.length + observation.receipt.rejected.length,
      observation.receipt.candidateSnapshotIds.length,
    );
    assert.ok(Array.isArray(observation.comparison.legacyOnlyLogicalIds));
    assert.ok(Array.isArray(observation.comparison.unifiedOnlyLogicalIds));
  }
  const genealogyObservation = observations.find(item => item.taskType === 'genealogy');
  assert.equal(genealogyObservation?.status, 'success');
  if (genealogyObservation?.status === 'success') {
    assert.deepEqual(
      [...new Set(genealogyObservation.sourceMappings.map(item => item.sourceType))].sort(),
      ['biography', 'butterfly', 'chat', 'genealogy', 'mvu', 'worldbook'],
      '谱系影子检索也必须纳入既有谱系、传记与蝴蝶效应，且不改变正式 sourceIndex',
    );
  }

  // R-01：四模块必须持有同构 Active 证据（bundle 或精简视图），策略版本与 passage 一一对应。
  assert.equal(
    activeBiography.evidenceBundle.receipt.passageBudget.strategyVersion,
    activeRuin.evidenceBundle.receipt.passageBudget.strategyVersion,
    '传记与墟境必须消费同一 passage 策略版本',
  );
  assert.equal(
    activeGenealogy.evidenceBundle.receipt.passageBudget.strategyVersion,
    activeRuin.evidenceBundle.receipt.passageBudget.strategyVersion,
    '谱系与墟境必须消费同一 passage 策略版本',
  );
  const biographyObservation = observations.find(item => item.taskType === 'biography');
  if (biographyObservation?.status === 'success') {
    const bundlePassageIds = new Set(
      activeBiography.evidenceBundle.passages.map(passage => passage.passageId),
    );
    assert.ok(
      biographyObservation.receipt.selectedPassages.every(decision =>
        decision.passageId && bundlePassageIds.has(decision.passageId)),
      '传记 receipt.selectedPassages 必须与 ContextBundle 的 evidenceBundle 同一 passage 集合',
    );
  }
  assert.ok(
    activeButterfly.activeEvidence,
    '蝴蝶冻结必须携带 Active 精简证据视图',
  );
  if (activeButterfly.activeEvidence) {
    assert.equal(
      activeButterfly.activeEvidence.requestedEra,
      '复兴纪元',
      '蝴蝶证据视图的 requestedEra 取自冻结史案的纪元',
    );
  }

  const ruinObservation = observations.find(item => item.taskType === 'ruin');
  assert.equal(ruinObservation?.status, 'success');
  if (ruinObservation?.status === 'success') {
    const selectedSnapshotIds = new Set(
      ruinObservation.receipt.selected.map(item => item.snapshotId),
    );
    const selectedSourceIds = ruinObservation.sourceMappings
      .filter(item => selectedSnapshotIds.has(item.snapshotId))
      .map(item => item.sourceId);
    assert.deepEqual(activeRuin.sourceIndex.map(source => source.sourceId).sort(), selectedSourceIds.sort());
    assert.deepEqual(
      activeRuin.evidenceBundle.passages.map(passage => passage.passageId),
      ruinObservation.receipt.selectedPassages.map(passage => passage.passageId),
    );
  }
});

test('墟境正式上下文只消费 unified 入选源，不再把 legacy 泛词噪声交给 prompt', async () => {
  const main = worldbookSource();
  main.sourceId = 'worldbook:main:822383';
  main.title = '[世界主设定]';
  main.content = '神明纪元的阿斯塔利亚大陆上，狡黠女神泰珂常以恶作剧捉弄其他神明。';
  main.keywords = ['神明纪元', '阿斯塔利亚', '泰珂'];
  main.worldbook = {
    ...main.worldbook,
    logicalId: 'worldbook:main:822383',
    uid: 822383,
    strategy: { ...main.worldbook.strategy, primaryKeys: main.keywords },
  };
  const noise = worldbookSource();
  noise.sourceId = 'worldbook:noise:1';
  noise.title = '伊雍核心';
  noise.content = '墟境探索系统覆盖阿斯塔利亚，当前帝国人物包括奥古斯塔。';
  noise.keywords = ['墟境探索'];
  noise.worldbook = {
    ...noise.worldbook,
    logicalId: 'worldbook:noise:1',
    uid: 1,
    strategy: { ...noise.worldbook.strategy, primaryKeys: noise.keywords },
  };
  const observer = new RuntimeShadowRetrievalObserver();
  const context = await new TavernRuinContextAssembler(
    new ShadowRuntime(),
    {
      ...sources,
      async getWorldbookCorpus() {
        const book = [main, noise];
        return {
          sources: book,
          receipt: {
            schema: 'eyon.retrieval.worldbook-corpus.v1',
            complete: true,
            bindings: [{ worldbookName: '命定之诗与黄昏之歌', scopes: ['character-primary'] }],
            entries: book.map(source => ({
              logicalId: source.worldbook.logicalId,
              sourceId: source.sourceId,
              worldbookName: source.worldbook.worldbookName,
              uid: source.worldbook.uid,
              title: source.title,
              bindingScopes: ['character-primary'],
              enabled: true,
              status: 'retrievable',
            })),
            counts: {
              total: book.length,
              enabled: book.length,
              retrievable: book.length,
              disabled: 0,
              empty: 0,
              'user-excluded': 0,
              'routed-generated': 0,
            },
          },
        };
      },
      async getWorldbookSources() { return [main, noise]; },
      async getCharacterSources() { return []; },
      async getGenealogySources() { return []; },
      async getBiographySources() { return []; },
      async getButterflySources() { return []; },
    },
    async () => new Set(),
    observer,
  ).assemble({
    ...contextInput,
    requestId: 'active-tyche-context',
    directive: '墟境探索\n神明纪元\n阿斯塔利亚大陆全境\n狡黠的女神泰珂对其他神明所作的恶作剧',
  });

  assert.deepEqual(context.sourceIndex.map(source => source.title), ['[世界主设定]']);
  assert.deepEqual(context.worldbookContext, context.sourceIndex);
  assert.equal(context.recentContext.length, 0);
  assert.ok(!JSON.stringify(context).includes('奥古斯塔'));
  const observation = observer.list().at(-1);
  assert.equal(observation?.status, 'success');
  if (observation?.status === 'success') {
    assert.equal(observation.receipt.mode, 'active');
    assert.ok(observation.comparison.legacyOnlyLogicalIds.includes('worldbook:noise:1'));
  }
});

test('自定义纪年必须精确命中并强制纳入当前世界书证据', async () => {
  const eraSource = worldbookSource();
  eraSource.sourceId = 'worldbook:custom-era:127';
  eraSource.title = '星辉历年表';
  eraSource.content = '星辉历127年，星港议会重修南天文台。';
  eraSource.keywords = ['星辉历'];
  eraSource.worldbook = {
    ...eraSource.worldbook,
    logicalId: 'worldbook:custom-era:127',
    uid: 127,
    strategy: { ...eraSource.worldbook.strategy, primaryKeys: ['星辉历'] },
  };
  const customSources: RuntimeContextSourceProvider = {
    ...sources,
    async getCurrentWorld() { return { time: '星辉历130年', location: '星港' }; },
    async getWorldbookCorpus() {
      return {
        sources: [eraSource],
        receipt: {
          schema: 'eyon.retrieval.worldbook-corpus.v1',
          complete: true,
          bindings: [{ worldbookName: eraSource.worldbook.worldbookName, scopes: ['character-primary'] }],
          entries: [{
            logicalId: eraSource.worldbook.logicalId,
            sourceId: eraSource.sourceId,
            worldbookName: eraSource.worldbook.worldbookName,
            uid: eraSource.worldbook.uid,
            title: eraSource.title,
            bindingScopes: ['character-primary'],
            enabled: true,
            status: 'retrievable',
          }],
          counts: { total: 1, enabled: 1, retrievable: 1, disabled: 0, empty: 0, 'user-excluded': 0, 'routed-generated': 0 },
        },
      };
    },
    async getWorldbookSources() { return [eraSource]; },
    async getCharacterSources() { return []; },
    async getGenealogySources() { return []; },
    async getBiographySources() { return []; },
    async getButterflySources() { return []; },
  };
  const context = await new TavernRuinContextAssembler(
    new ShadowRuntime(),
    customSources,
    async () => new Set(),
    new RuntimeShadowRetrievalObserver(),
  ).assemble({
    ...contextInput,
    requestId: 'custom-era-context',
    directive: '墟境探索\n星辉历\n星港',
    eraAnchor: '星辉历',
    customEra: true,
  });
  assert.deepEqual(context.worldbookContext.map(source => source.sourceId), [eraSource.sourceId]);

  await assert.rejects(
    () => new TavernRuinContextAssembler(
      new ShadowRuntime(),
      customSources,
      async () => new Set(),
      new RuntimeShadowRetrievalObserver(),
    ).assemble({
      ...contextInput,
      requestId: 'missing-custom-era-context',
      directive: '墟境探索\n不存在历',
      eraAnchor: '不存在历',
      customEra: true,
    }),
    /未在当前角色卡的完整世界书中精确命中/u,
  );
});

test('墟境 active 检索失败时显式终止，不静默回退 legacy', async () => {
  await assert.rejects(
    () => new TavernRuinContextAssembler(
      new ShadowRuntime(),
      sources,
      async () => new Set(),
      {
        async capture(input) {
          return {
            status: 'failure' as const,
            recordedAt: Date.now(),
            requestId: input.requestId,
            taskType: input.taskType,
            error: 'fixture failure',
          };
        },
      },
    ).assemble(contextInput),
    /Active ruin retrieval failed: fixture failure/u,
  );
});

test('R-03：active 模式拒绝 complete=false 的旧兼容语料（生产路径不豁免）', async () => {
  const incompleteSources: RuntimeContextSourceProvider = {
    ...sources,
    getWorldbookCorpus: undefined,
  };
  await assert.rejects(
    () => new TavernRuinContextAssembler(
      new ShadowRuntime(),
      incompleteSources,
      async () => new Set(),
      new RuntimeShadowRetrievalObserver(),
    ).assemble(contextInput),
    /worldbook corpus is incomplete/u,
  );
  // 其余三模块同门：传记也拒绝 incomplete 语料。
  await assert.rejects(
    () => new TavernBiographyContextAssembler(
      new ShadowRuntime(),
      incompleteSources,
      new RuntimeShadowRetrievalObserver(),
    ).assemble(contextInput),
    /worldbook corpus is incomplete/u,
  );
});

test('生产旁路复用快照与索引，并把异常记录为显式失败而不抛给旧链', async () => {
  const observer = new RuntimeShadowRetrievalObserver();
  const input = {
    requestId: 'cache-first',
    taskType: 'ruin' as const,
    query: '圣翼议会',
    candidates: [{
      ...worldbookSource(),
      sourceType: 'worldbook' as const,
    }],
    legacySourceIds: ['worldbook:命定之诗与黄昏之歌:7'],
  };
  const first = await observer.capture(input);
  const second = await observer.capture({ ...input, requestId: 'cache-second' });
  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  if (first.status === 'success' && second.status === 'success') {
    assert.ok(first.bundle.passages.length > 0);
    assert.equal(first.diagnostics.snapshotCacheMisses, 1);
    assert.equal(second.diagnostics.snapshotCacheHits, 1);
    assert.equal(second.diagnostics.engineReused, true);
    assert.deepEqual(first.sourceMappings, second.sourceMappings);
    assert.deepEqual(second.comparison.legacyOnlyLogicalIds, []);
    assert.ok(!('bundle' in (observer.list().at(-1) ?? {})));
  }

  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    const failure = await observer.capture({
      requestId: 'explicit-failure',
      taskType: 'biography',
      query: '异常输入',
      candidates: [{
        sourceId: null,
        sourceType: 'chat',
        title: 'bad',
        content: 'bad',
      } as unknown as Parameters<RuntimeShadowRetrievalObserver['capture']>[0]['candidates'][number]],
      legacySourceIds: [],
    });
    assert.equal(failure.status, 'failure');
    if (failure.status === 'failure') assert.match(failure.error, /trim/u);
    assert.equal(observer.list().at(-1)?.status, 'failure');
  } finally {
    console.warn = originalWarn;
  }
});
