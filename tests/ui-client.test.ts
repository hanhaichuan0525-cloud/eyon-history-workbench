import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKBENCH_DATA_CHANGED_EVENT,
  WORKBENCH_GLOBAL,
  WORKBENCH_READY_EVENT,
  WORKBENCH_RUIN_REFERENCES_EVENT,
  WORKBENCH_STATUS_EVENT,
  type EyonHistoryWorkbenchFacade,
} from '../src/runtime/facade.ts';
import { WorkbenchUiClient } from '../src/ui/workbenchClient.ts';

const EMPTY_GENERATION = {
  apiurl: '',
  key: '',
  model: '',
  source: 'openai' as const,
  maxTokens: 4096,
  temperature: 0.8,
};

function makeFacade(): EyonHistoryWorkbenchFacade {
  const settings = {
    schemaVersion: 1 as const,
    generation: {
      genealogy: { ...EMPTY_GENERATION },
      ruin: { ...EMPTY_GENERATION },
      biography: { ...EMPTY_GENERATION },
      butterfly: { ...EMPTY_GENERATION },
    },
    ruinDraft: null,
    genealogyDepth: { ancestors: 4, descendants: 3, maxPerGeneration: 4 },
    appearance: {
      mode: 'dark' as const,
      accent: 'jade' as const,
      text: 'neutral' as const,
    },
    ruinPreferences: {
      candidateCount: 3,
    },
    retrieval: {
      biographyEnabled: false,
      worldbookScope: 'eyon' as const,
      mergeAliases: true,
      worldbookEntryExclusions: {},
    },
    retries: {
      genealogy: 2,
      ruin: 3,
      biography: 2,
      butterfly: 2,
    },
    customApiTimeoutMs: 600000,
    deepseekStructured: false,
    storyClock: null,
    baselineWorldTime: null,
    baselineWorldTimes: {},
    errorLog: [],
  };
  return {
    version: 'test',
    getSettings: () => settings,
    updateSettings: () => settings,
    setGenerationSettings: () => settings,
    applyGenerationSettingsToAll: () => settings,
    setRuinDraft: () => settings,
    getRuinGeography: async () => [],
    getButterflyReferences: async () => null,
    setButterflyReferences: async () => undefined,
    listRetrievalShadowObservations: () => [],
    listPromptDiagnostics: () => [],
    listCanonResolvedViews: () => [],
    inspectCurrentArtifactCanonBindings: async () => ({
      schema: 'eyon.canon.artifact-binding-inspection.v1',
      counts: {
        artifacts: 0,
        boundArtifacts: 0,
        unboundArtifacts: 0,
        bindings: 0,
        bindingMissing: 0,
      },
      artifacts: [],
      bindings: [],
      failures: [],
    }),
    inspectCurrentArtifactCanonAssessments: async () => null,
    inspectCurrentArtifactCanonConsumption: async () => ({
      schema: 'eyon.canon.artifact-consumption-inspection.v1',
      branch: {
        branchId: 'canon:test', headRevision: 0, updatedAt: 0,
        revisions: 0, active: 0, reverted: 0, orphaned: 0,
      },
      changes: [],
      assessment: {
        schema: 'eyon.canon.artifact-assessment-inspection.v1',
        comparedView: { branchId: 'canon:test', viewId: 'canon-current:test', resolvedRevision: 0 },
        counts: {
          artifacts: 0, assessments: 0, returnedAssessments: 0, omittedAssessments: 0,
          assessable: 0, unbound: 0, bindingMissing: 0, current: 0,
          partiallyStale: 0, stale: 0, orphaned: 0, uncertain: 0, failures: 0,
        },
        assessments: [], failures: [],
      },
      decisions: [],
      causalPreview: {
        schema: 'eyon.canon.causal-preview.v1',
        branchId: 'canon:test',
        headRevision: 0,
        status: 'no-conflict',
        modelCalls: 0,
        counts: {
          activeOperations: 0, recordedBases: 0, supportUnits: 0, opaqueOperations: 0,
          conflictRoots: 0, brokenSupports: 0, survivingSupports: 0, affectedOperations: 0,
        },
        conflictRoots: [], supports: [], affectedOperations: [], stopPoints: [], warnings: [],
      },
      causalRebase: {
        schema: 'eyon.canon.causal-rebase-projection.v1',
        branchId: 'canon:test', headRevision: 0, status: 'projected', modelCalls: 0,
        operationStates: [], supportStates: [], warnings: [],
      },
      counts: { available: 0, availableWithWarning: 0, excluded: 0, manualReview: 0 },
    }),
    getRuinRuntimeSnapshot: async () => ({
      flowState: 'idle',
      runId: '',
      realityTime: '现实时间',
      realityLocation: '现实地点',
      ruinTime: '',
      ruinLocation: '',
    }),
    listGenealogyCharacters: async () => [],
    listCharacterWorldbookEntries: async () => [],
    setCharacterWorldbookEntryEnabled: async () => [],
    setCharacterWorldbookEntriesEnabled: async () => [],
    generateGenealogy: async () => { throw new Error('not used'); },
    listGenealogies: async () => [],
    clearCharacterGenealogy: async () => ({ deleted: 0, recordKeys: [], references: [] }),
    listRuinCharacterReferences: async () => [],
    toggleGenealogyNodeRuinReference: async () => [],
    removeRuinCharacterReference: async () => [],
    fetchCustomApiModels: async () => [],
    generateRuin: async () => { throw new Error('not used'); },
    listRuins: async () => [],
    listBiographies: async () => [],
    deleteBiography: async () => true,
    listRuinBiographyReferences: async () => [],
    toggleBiographyRuinReference: async () => [],
    removeRuinBiographyReference: async () => [],
    listButterflies: async () => [],
    listButterflyPending: async () => [],
    deleteButterfly: async () => true,
    retireButterflyMirrors: async () => ({ worldbooks: [], removedEntries: 0, globals: [] }),
    inspectCanonMemory: () => ({ snapshot: null, failure: '' }),
    refreshCanonMemory: async () => ({
      schema: 'eyon.canon.memory-snapshot.v2',
      branchId: 'canon:test',
      headRevision: 0,
      computedAt: 0,
      trigger: 'manual',
      counts: { total: 0, resident: 0, triggered: 0, unmatched: 0, filtered: 0 },
      injectedText: '',
      entries: [],
      continuity: { anchorCount: 0, relationCount: 0, omittedCount: 0, warnings: [], injectedText: '' },
      tombstoneCount: 0,
    }),
    inspectCurrentCanon: async () => ({
      schema: 'eyon.canon.inspection.v1',
      namespace: { characterKey: 'character', chatId: 'chat' },
      checkedAt: '2026-08-24T00:00:00.000Z',
      branch: {
        schema: 'eyon.canon.branch.v1',
        branchId: 'canon:test',
        characterKey: 'character',
        chatId: 'chat',
        headRevision: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      revisions: [],
      actions: [],
      deltas: [],
      receipts: [],
      counts: { revisions: 0, actions: 0, deltas: 0, receipts: 0 },
      revisionStatuses: { active: 0, reverted: 0, orphaned: 0 },
      deltaStatuses: {
        active: 0,
        'partially-active': 0,
        superseded: 0,
        orphaned: 0,
        reverted: 0,
      },
      issues: [],
      healthy: true,
    }),
    cancelTask: async () => undefined,
    inspectCurrentData: async () => ({
      namespace: { characterKey: 'character', chatId: 'chat' },
      checkedAt: '2026-07-29T00:00:00.000Z',
      counts: {
        biographies: 0,
        genealogies: 0,
        ruins: 0,
        butterflies: 0,
        pendingButterflies: 0,
        canonMemoryTombstones: 0,
        ruinReferences: 0,
      },
      issues: [],
      healthy: true,
    }),
    exportCurrentData: async () => ({
      format: 'eyon-history-workbench-backup',
      schemaVersion: 1,
      workbenchVersion: 'test',
      exportedAt: '2026-07-29T00:00:00.000Z',
      namespace: { characterKey: 'character', chatId: 'chat' },
      settings,
      data: {
        biographies: [],
        genealogies: [],
        ruins: [],
        butterflies: [],
        pendingButterflies: [],
        canonMemoryTombstones: [],
        ruinReferences: [],
      },
    }),
    clearGenerationCache: async () => ({
      ruinDraftCleared: true,
      ruinReferencesCleared: 0,
      genealogiesCleared: 0,
      ruinsCleared: 0,
      butterflyPendingCleared: 0,
    }),
    clearErrorLog: () => settings,
    getRuinPresenceDiagnostics: () => [],
    enterRuin: async () => ({
      recordKey: 'record-1',
      candidateId: 'candidate-1',
      nodeId: 'node-anomaly',
      messageId: 9,
      playerText: '我踏入这处历史特异点。',
      contractText: '【历史工作台·单楼进入契约】',
    }),
    getRuinTaskReview: async () => null,
    generateRuinTaskDraft: async request => ({
      phase: 'review',
      runId: 'run-1',
      direction: request.direction,
      interpretation: request.interpretation,
      scale: request.scale,
      task: {
        title: '核验潮痕', mode: '个人', difficulty: 'D', status: '进行中',
        attention: '中', progress: '刚刚建立', detail: '核验潮痕的来源。',
        objective: '取得两处可比对的潮痕。', reward: '100 FP',
      },
    }),
    updateRuinTaskDraft: patch => ({
      phase: 'review', runId: 'run-1', direction: '核验潮痕',
      interpretation: '原意锁定', scale: '即时互动',
      task: {
        title: patch.title ?? '核验潮痕', mode: '个人', difficulty: 'D', status: '进行中',
        attention: '中', progress: '刚刚建立', detail: patch.detail ?? '核验潮痕的来源。',
        objective: patch.objective ?? '取得两处可比对的潮痕。', reward: '100 FP',
      },
    }),
    confirmRuinTaskDraft: async () => ({
      phase: 'staged',
      runId: 'run-1',
      direction: '核验潮痕',
      interpretation: '原意锁定',
      scale: '即时互动',
      task: {
        title: '核验潮痕',
        mode: '个人',
        difficulty: 'D',
        status: '进行中',
        attention: '中',
        progress: '刚刚建立',
        detail: '核验潮痕的来源。',
        objective: '取得两处可比对的潮痕。',
        reward: '100 FP；425Z 圣羽币；潮痕拓片',
      },
    }),
    returnRuin: async () => undefined,
    retryButterfly: async () => undefined,
    dispose() {},
  };
}

test('UI客户端只通过公开门面读取当前命名空间快照', async () => {
  const facade = makeFacade();
  const globals = { [WORKBENCH_GLOBAL]: facade };
  const client = new WorkbenchUiClient(globals, new EventTarget());
  assert.equal(client.isReady(), true);
  assert.deepEqual(await client.readSnapshot(), {
    version: 'test',
    settings: facade.getSettings(),
    runtime: {
      flowState: 'idle',
      runId: '',
      realityTime: '现实时间',
      realityLocation: '现实地点',
      ruinTime: '',
      ruinLocation: '',
    },
    biographies: [],
    genealogies: [],
    ruins: [],
    butterflies: [],
  });
});

test('UI客户端通过公开门面执行资料管理操作', async () => {
  const facade = makeFacade();
  const client = new WorkbenchUiClient(
    { [WORKBENCH_GLOBAL]: facade },
    new EventTarget(),
  );
  assert.equal((await client.inspectCurrentData()).healthy, true);
  assert.deepEqual(await client.clearCharacterGenealogy('玲山'), { deleted: 0, recordKeys: [], references: [] });
  assert.equal(
    (await client.exportCurrentData()).format,
    'eyon-history-workbench-backup',
  );
  assert.deepEqual(await client.clearGenerationCache(), {
    ruinDraftCleared: true,
    ruinReferencesCleared: 0,
    genealogiesCleared: 0,
    ruinsCleared: 0,
    butterflyPendingCleared: 0,
  });
});

test('运行时未就绪时启动开关仍写入酒馆扩展设置', () => {
  const extensionSettings: Record<string, unknown> = {};
  const globals = {
    SillyTavern: {
      extensionSettings,
      saveSettingsDebounced: () => undefined,
    },
  };
  const client = new WorkbenchUiClient(globals, new EventTarget());
  assert.equal(client.isReady(), false);
  assert.equal(client.isWorkbenchEnabled(), true);
  assert.deepEqual(client.updateSettings({ workbenchEnabled: false }), {
    workbenchEnabled: false,
  });
  assert.equal(client.isWorkbenchEnabled(), false);
  assert.deepEqual(client.updateSettings({ workbenchEnabled: true }), {
    workbenchEnabled: true,
  });
  assert.equal(
    (extensionSettings['eyon-history-workbench'] as { workbenchEnabled: boolean }).workbenchEnabled,
    true,
  );
  assert.equal(client.isWorkbenchEnabled(), true);
});

test('UI客户端订阅并释放工作台状态与就绪事件', () => {
  const events = new EventTarget();
  const client = new WorkbenchUiClient({}, events);
  const statuses: string[] = [];
  const ready: string[] = [];
  const offStatus = client.onStatus(detail => statuses.push(detail.status));
  const offReady = client.onReady(facade => ready.push(facade.version));
  events.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, {
    detail: { status: 'generating_ruin', detail: '伊雍正在编排历史节点' },
  }));
  events.dispatchEvent(new CustomEvent(WORKBENCH_READY_EVENT, {
    detail: makeFacade(),
  }));
  offStatus();
  offReady();
  events.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, {
    detail: { status: 'ignored', detail: '' },
  }));
  assert.deepEqual(statuses, ['generating_ruin']);
  assert.deepEqual(ready, ['test']);
});

test('UI客户端订阅跨模块资料变化事件', () => {
  const events = new EventTarget();
  const client = new WorkbenchUiClient({}, events);
  const received: string[] = [];
  const off = client.onDataChanged(detail => {
    received.push(`${detail.reason}:${detail.views.join(',')}`);
  });
  events.dispatchEvent(new CustomEvent(WORKBENCH_DATA_CHANGED_EVENT, {
    detail: { reason: 'ruin-references', views: ['genealogy', 'ruin'] },
  }));
  off();
  events.dispatchEvent(new CustomEvent(WORKBENCH_DATA_CHANGED_EVENT, {
    detail: { reason: 'cache-cleared', views: ['settings'] },
  }));
  assert.deepEqual(received, ['ruin-references:genealogy,ruin']);
});

test('单人物清空在UI窗口广播且不把旧聊天结果传播给新聊天', async () => {
  const events = new EventTarget(), facade = makeFacade();
  const client = new WorkbenchUiClient({ [WORKBENCH_GLOBAL]: facade }, events);
  const received: string[] = [];
  events.addEventListener(WORKBENCH_DATA_CHANGED_EVENT, event => received.push((event as CustomEvent).detail.reason));
  events.addEventListener(WORKBENCH_RUIN_REFERENCES_EVENT, () => received.push('references'));
  await client.clearCharacterGenealogy('玲山');
  assert.deepEqual(received, ['references', 'genealogy-cleared']);
  let resolve!: (value: any) => void;
  facade.clearCharacterGenealogy = () => new Promise(done => { resolve = done; });
  const clearing = client.clearCharacterGenealogy('玲山'); facade.contextRevision = 1;
  resolve({ deleted: 1, recordKeys: ['old'], references: [] });
  await assert.rejects(clearing, /聊天已切换/u);
  assert.equal(received.length, 2);
});

test('UI客户端写操作在界面窗口广播资料变化并即时同步墟境人物', async () => {
  const events = new EventTarget();
  const facade = makeFacade();
  const reference = {
    mvuId: 'genealogy:record:node',
    name: '伊芙琳',
    source: 'genealogy' as const,
    identities: ['姑母'],
    race: '人类',
    lifespan: '复兴纪元120年—复兴纪元181年',
    professions: ['书记官'],
    relations: ['谱系中心人物的姑母'],
    contextSummary: '保存旧档案的人。',
    referenceId: 'genealogy:record:node',
  };
  facade.toggleGenealogyNodeRuinReference = async () => [reference];
  const client = new WorkbenchUiClient(
    { [WORKBENCH_GLOBAL]: facade },
    events,
  );
  const referenceEvents: string[][] = [];
  const dataEvents: string[] = [];
  events.addEventListener(WORKBENCH_RUIN_REFERENCES_EVENT, event => {
    referenceEvents.push((event as CustomEvent<typeof reference[]>).detail.map(
      item => item.name,
    ));
  });
  events.addEventListener(WORKBENCH_DATA_CHANGED_EVENT, event => {
    const detail = (event as CustomEvent<{ reason: string }>).detail;
    dataEvents.push(detail.reason);
  });

  await client.toggleGenealogyNodeRuinReference('record', 'node');
  await client.clearGenerationCache();

  assert.deepEqual(referenceEvents, [['伊芙琳'], []]);
  assert.deepEqual(dataEvents, ['ruin-references', 'cache-cleared']);
});
