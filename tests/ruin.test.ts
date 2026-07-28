import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuinContextBundle } from '../src/core/context.ts';
import { parseTextCommand } from '../src/core/commands.ts';
import type {
  RuntimeChatMessage,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  createRuinIdentityAssertion,
  RuinController,
  RuinTransactionGuard,
} from '../src/runtime/ruinController.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import { WorkbenchLifecycle } from '../src/runtime/workbenchLifecycle.ts';
import type {
  RuinCandidates,
  RuinGenerationInput,
} from '../src/schemas/ruin.ts';
import {
  MemoryRuinCandidateRepository,
  ruinCandidateRecordKey,
  type RuinCandidateRecord,
} from '../src/storage/ruins.ts';
import { parseAndValidateRuinCandidates } from '../src/validators/ruin.ts';
import { RuinWorkflow } from '../src/workflows/ruin.ts';
import {
  buildRuinEntryText,
  RuinEntryWorkflow,
} from '../src/workflows/ruinEntry.ts';

const namespace = {
  characterKey: '命定之诗',
  chatId: '存档-墟境测试',
};
const requestId = 'ruin-test-001';
const sourceId = 'worldbook:布劳尔旧堡';

function makeInput(): RuinGenerationInput {
  return {
    era: '复兴纪元',
    start: { year: 145, month: 5, day: 1 },
    end: { year: 145, month: 5, day: 31 },
    location: '布劳尔旧堡',
    supplementaryDirection: '寻找一处能够由个人选择改变的历史裂点',
    selectedCharacters: [],
    wave: {
      level: 'stable',
      candidateCount: 3,
    },
    materials: Array.from({ length: 3 }, (_, index) => ({
      candidateKey: `candidate-${index + 1}`,
      periodType: 'transition' as const,
      background: `边地婚盟正在重排旧有秩序${index + 1}`,
      conflict: `档案继承权与地方供给发生冲突${index + 1}`,
      trigger: `一份被替换的名册暴露出制度裂缝${index + 1}`,
    })),
  };
}

function makeContext(): RuinContextBundle {
  const source = {
    sourceId,
    sourceType: 'worldbook' as const,
    title: '布劳尔旧堡',
    content: '旧堡保存着地方婚盟与供给名册。',
    authority: 90,
  };
  return {
    schema: 'eyon.context.v1',
    taskType: 'ruin',
    requestId,
    scope: {
      ...namespace,
      triggerMessageId: 8,
    },
    currentWorld: {
      time: '复兴纪元488年',
      location: '布劳尔子爵领',
    },
    worldbookContext: [source],
    recentContext: [],
    characterContext: [],
    genealogyRefs: [],
    biographyRefs: [],
    butterflyRefs: [],
    sourceIndex: [source],
    warnings: [],
    sourceHash: 'ruin-source-hash',
  };
}

function makeNode(
  id: string,
  kind: 'origin' | 'process' | 'anomaly' | 'result',
  day: number,
) {
  const anomaly = kind === 'anomaly';
  return {
    id,
    kind,
    time: {
      year: 145,
      month: 5,
      day,
      hour: anomaly ? 23 : null,
      minute: anomaly ? 15 : null,
      label: `复兴纪元145年5月${day}日`,
    },
    location: '布劳尔旧堡',
    title: `${kind}-${day}`,
    summary: '名册、供给与婚盟在同一条制度链上发生变化。',
    cause: '旧有的继承安排无法消化新的供给压力。',
    causalMechanism: '掌握名册的人能够改变物资和婚盟的分配顺序。',
    participants: ['档案官'],
    interests: [{
      actor: '档案官',
      wants: '保住名册解释权',
      fears: '替换行为被公开',
    }],
    materialConditions: ['纸张短缺', '封蜡由少数人保管'],
    opposition: '地方家族拒绝承认未经见证的新名册。',
    visibleTrace: '封蜡颜色与登记年份不一致。',
    intervention: anomaly ? '在名册被封存前揭露或替换关键页。' : '',
    possibleBranches: anomaly
      ? [
          { condition: '公开证据', consequence: '婚盟被迫重新议定' },
          { condition: '秘密替换', consequence: '继承顺序在暗处改变' },
        ]
      : [],
    enterable: anomaly,
    inference: true,
    sourceRefs: [sourceId],
  };
}

function makeCandidates(): RuinCandidates {
  const candidates = Array.from({ length: 3 }, (_, index) => {
    const number = index + 1;
    return {
      id: `ruin-${number}`,
      candidateKey: `candidate-${number}`,
      title: `被替换的婚盟名册${number}`,
      periodType: 'transition' as const,
      span: {
        start: { year: 145, month: 5, day: 2 },
        end: { year: 145, month: 5, day: 22 },
        label: '复兴纪元145年5月',
      },
      premise: `一份名册让地方秩序偏离原有轨迹${number}。`,
      summary: `婚盟、供给和继承权围绕一份被替换的名册重新排列${number}。`,
      historyProse: '史'.repeat(450),
      fusion: {
        normalOrder: '地方家族按旧名册完成婚盟和供给。',
        latentFault: '名册解释权长期被少数档案官垄断。',
        pressuredActors: ['档案官', '地方家族'],
        bridge: {
          type: 'institution' as const,
          name: '婚盟名册制度',
          explanation: '名册同时决定婚盟承认与供给次序。',
        },
        triggerImpact: '替换页让原有的继承顺序失去凭证。',
        forcedDecision: '档案官必须公开证据或继续掩盖。',
        irreversibleTurn: '新名册被盖上正式封蜡。',
        historicalResult: '地方秩序以一套错误凭证延续。',
      },
      shift: {
        from: 'stable' as const,
        to: 'transition' as const,
        explanation: '制度仍在运行，但解释权已经发生转移。',
      },
      nodes: [
        makeNode('node-origin', 'origin', 2),
        makeNode('node-process', 'process', 12),
        makeNode('node-anomaly', 'anomaly', 20),
        makeNode('node-result', 'result', 22),
      ],
      cast: [{
        name: '档案官',
        kind: 'person' as const,
        identity: '旧堡名册保管人',
        role: '控制证据与封蜡',
        desire: '维持自身的解释权',
        constraint: '必须让替换页通过公开见证',
        sourceRefs: [sourceId],
        inference: true,
      }],
      selectedCharacterUsage: [],
      historicalTexture: {
        dailyLife: ['仆役按名册领取灯油与粮食'],
        institutions: ['婚盟见证与档案封存'],
        materialCulture: ['封蜡、羊皮纸与手抄副本'],
        socialDivisions: ['档案官、地方家族与仆役'],
      },
      sourceRefs: [sourceId],
      biographyUsage: [],
      inferenceNotes: ['档案官姓名无资料，因此仅按职业推断。'],
      qualityChecks: {
        threeMaterialsIntegrated: true,
        causalChainComplete: true,
        anomalyEnterable: true,
        timelineConsistent: true,
        distinctFromOtherCandidates: true,
        supplementaryDirectionFulfilled: true,
        selectedCharactersReconciled: true,
        clicheDependence: false,
      },
    };
  });
  return {
    schema: 'eyon.ruin.candidates.v2',
    requestId,
    era: '复兴纪元',
    location: '布劳尔旧堡',
    wave: {
      level: 'stable',
      candidateCount: 3,
    },
    candidates,
  };
}

function makeRecord(): RuinCandidateRecord {
  return {
    key: ruinCandidateRecordKey(namespace, requestId),
    namespace,
    requestId,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    sourceHash: 'source',
    input: makeInput(),
    result: makeCandidates(),
    createdAt: 1000,
  };
}

class RuinRuntime implements TavernRuntime {
  characterKey = namespace.characterKey;
  chatId = namespace.chatId;
  lastMessageId = 8;
  messages = new Map<number, RuntimeChatMessage>([[
    8,
    {
      message_id: 8,
      role: 'user',
      message: '墟境探索',
      swipe_id: 0,
    },
  ]]);

  getCurrentCharacterName() {
    return this.characterKey;
  }

  getCurrentChatId() {
    return this.chatId;
  }

  getLastMessageId() {
    return this.lastMessageId;
  }

  getMessageSwipeId(messageId: number) {
    return this.messages.get(messageId)?.swipe_id ?? null;
  }

  getChatMessages(range: number | string) {
    if (typeof range === 'number') {
      const message = this.messages.get(range);
      return message ? [structuredClone(message)] : [];
    }
    const [start, end] = range.split('-').map(Number);
    return [...this.messages.values()]
      .filter(message => message.message_id >= start && message.message_id <= end)
      .map(message => structuredClone(message));
  }

  async setChatMessages() {}

  setExtensionPrompt() {}

  async generate() {
    return '';
  }

  async generateRaw() {
    return '';
  }
}

test('候选墟境严格核对材料、来源、时间轴和可进入特异点', () => {
  const result = makeCandidates();
  assert.deepEqual(
    parseAndValidateRuinCandidates(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input: makeInput(),
      context: makeContext(),
    }),
    result,
  );

  const reversed = structuredClone(result);
  reversed.candidates[0].nodes[2].time.day = 10;
  assert.throws(
    () => parseAndValidateRuinCandidates(JSON.stringify(reversed), {
      requestId,
      directive: '墟境探索',
      input: makeInput(),
      context: makeContext(),
    }),
    /monotonic/u,
  );

  const unknownSource = structuredClone(result);
  unknownSource.candidates[0].sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateRuinCandidates(JSON.stringify(unknownSource), {
      requestId,
      directive: '墟境探索',
      input: makeInput(),
      context: makeContext(),
    }),
    /Unknown source reference/u,
  );
});

test('候选生成只落入当前聊天命名空间，不改世界变量也不自动进入', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const command = parseTextCommand('墟境探索');
  assert.ok(command);
  const workflow = new RuinWorkflow({
    contextAssembler: {
      async assemble() {
        return makeContext();
      },
    },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'ruin');
        assert.match(prompt, /寻找一处能够由个人选择改变的历史裂点/u);
        return JSON.stringify(makeCandidates());
      },
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '验证契约',
      generationContract: '生成契约',
    },
    createRequestId() {
      return requestId;
    },
    now() {
      return 1000;
    },
    async assertCurrent() {},
  });

  const record = await workflow.generate(command, makeInput(), {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.equal(
    (await repository.get(ruinCandidateRecordKey(namespace, requestId)))?.requestId,
    requestId,
  );
  assert.equal(record.result.candidates[0].nodes[2].enterable, true);
  const entryText = buildRuinEntryText(
    record,
    'ruin-1',
    'node-anomaly',
    {
      time: '复兴纪元488年5月10日 14:28',
      location: '布劳尔子爵城堡仪式大厅',
    },
  );
  assert.match(entryText, /^进入节点\n\n【历史工作台·单楼进入契约】/u);
  assert.match(entryText, /现实锚点时间：复兴纪元488年5月10日 14:28/u);
  assert.match(entryText, /直接承接上一楼尚未结束的动作/u);
  assert.equal(entryText.split('[RuinTrace]').length - 1, 1);
  assert.match(entryText, /Type:: 过渡期/u);
  assert.throws(
    () => buildRuinEntryText(record, 'ruin-1', 'node-origin', {
      time: '复兴纪元488年5月10日 14:28',
      location: '布劳尔子爵城堡仪式大厅',
    }),
    /Only an enterable anomaly/u,
  );
});

test('楼层、swipe、聊天或生命周期变化后，候选事务拒绝提交', async () => {
  const mutations: Array<(runtime: RuinRuntime, guard: RuinTransactionGuard) => void> = [
    runtime => {
      runtime.chatId = '另一存档';
    },
    runtime => {
      runtime.messages.get(8)!.message = '编辑后的内容';
    },
    runtime => {
      runtime.messages.get(8)!.swipe_id = 1;
    },
    runtime => {
      runtime.lastMessageId = 9;
    },
    (_runtime, guard) => {
      guard.cancelAll();
    },
  ];

  for (const mutate of mutations) {
    const runtime = new RuinRuntime();
    const guard = new RuinTransactionGuard();
    const assertCurrent = createRuinIdentityAssertion(runtime, guard);
    const identity = {
      namespace,
      triggerMessageId: 8,
      triggerTextHash: fingerprintText('墟境探索'),
      triggerSwipeId: 0,
      lifecycleEpoch: guard.currentEpoch(),
    };
    mutate(runtime, guard);
    await assert.rejects(() => assertCurrent(identity));
  }
});

test('统一生命周期只将严格墟境命令路由给独立候选生成器', async () => {
  const runtime = new RuinRuntime();
  const calls: string[] = [];
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText(text) {
        calls.push(`biography:${text}`);
        return {};
      },
      async commitRendered() {
        return null;
      },
      async cancelPending() {
        calls.push('biography:cancel');
      },
    },
    ruin: {
      async generateFromText(text) {
        calls.push(`ruin:${text}`);
        return {};
      },
      cancelPending() {
        calls.push('ruin:cancel');
      },
    },
    ruinInputProvider: {
      async getInput(command) {
        calls.push(`input:${command.type}`);
        return makeInput();
      },
    },
    genealogy: {
      async generateFromText() {
        calls.push('genealogy');
        return {};
      },
      cancelPending() {
        calls.push('genealogy:cancel');
      },
    },
    genealogyInputProvider: {
      async getInput() {
        throw new Error('genealogy input should not be requested');
      },
    },
  });

  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.deepEqual(calls, [
    'input:ruin.generate',
    'ruin:墟境探索',
  ]);

  runtime.messages.get(8)!.message = '我只是在讨论一段墟境历史';
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.equal(await lifecycle.beforeGeneration('continue'), false);
  await lifecycle.onChatChanged();
  assert.deepEqual(
    calls.slice(-3),
    ['ruin:cancel', 'genealogy:cancel', 'biography:cancel'],
  );
});

test('同一楼层同一输入的重复调用复用同一生成事务', async () => {
  const runtime = new RuinRuntime();
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const record = makeRecord();
  const workflow = {
    async generate() {
      calls += 1;
      await pending;
      return record;
    },
  } as unknown as RuinWorkflow;
  const guard = new RuinTransactionGuard();
  const controller = new RuinController(workflow, runtime, {}, guard);

  const first = controller.generateFromText('墟境探索', makeInput());
  const second = controller.generateFromText('墟境探索', makeInput());
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
});

test('点击特异点只发送一个包含点击时现实锚点的玩家楼', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const sent: string[] = [];
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() {
        return namespace;
      },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() {
        return '';
      },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text) {
        sent.push(text);
        return { messageId: 9 };
      },
    },
  });

  const submission = await workflow.enter(
    record.key,
    'ruin-1',
    'node-anomaly',
  );
  assert.equal(submission.messageId, 9);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /现实锚点时间：复兴纪元488年5月10日 14:31/u);
  assert.match(sent[0], /目标墟境地点：布劳尔旧堡/u);
  assert.match(sent[0], /流程状态更新为 exploring/u);
  await assert.rejects(
    () => workflow.enter(record.key, 'ruin-1', 'node-anomaly'),
    /already been submitted/u,
  );
  assert.equal(sent.length, 1);
});

test('非idle状态或跨聊天候选不会创建进入玩家楼', async () => {
  for (const scenario of ['exploring', 'other-chat'] as const) {
    const repository = new MemoryRuinCandidateRepository();
    const record = makeRecord();
    await repository.save(record);
    let sent = 0;
    const workflow = new RuinEntryWorkflow({
      repository,
      host: {
        async getNamespace() {
          return scenario === 'other-chat'
            ? { ...namespace, chatId: '另一个存档' }
            : namespace;
        },
        async getRuinRuntimeSnapshot() {
          return {
            flowState: scenario === 'exploring' ? 'exploring' : 'idle',
            runId: scenario === 'exploring' ? 'run-active' : '',
            realityTime: '复兴纪元488年',
            realityLocation: '布劳尔子爵领',
            ruinTime: '',
            ruinLocation: '',
          };
        },
        async getLatestUserText() {
          return '';
        },
        async replaceAssistantSlot() {},
      },
      userTurns: {
        async sendUserTurn() {
          sent += 1;
          return { messageId: 9 };
        },
      },
    });

    await assert.rejects(
      () => workflow.enter(record.key, 'ruin-1', 'node-anomaly'),
    );
    assert.equal(sent, 0);
  }
});
