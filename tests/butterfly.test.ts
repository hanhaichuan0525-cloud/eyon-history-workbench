import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ArchiveAdapter,
  ButterflyHostAdapter,
  GenerationAdapter,
} from '../src/adapters/host.ts';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type {
  ButterflyRequest,
  ButterflyResult,
} from '../src/schemas/butterfly.ts';
import {
  butterflyRecordKey,
  MemoryButterflyRepository,
  pendingSettlementKey,
  type PendingSettlement,
} from '../src/storage/butterflies.ts';
import { ButterflyController } from '../src/runtime/butterflyController.ts';
import type { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import { parseAndValidateButterfly } from '../src/validators/butterfly.ts';
import { ButterflyWorkflow } from '../src/workflows/butterfly.ts';

const namespace: WorkbenchNamespace = {
  characterKey: '伊雍',
  chatId: 'chat-butterfly',
};

function request(): ButterflyRequest {
  const chatSource = {
    sourceId: 'chat:8',
    title: 'user floor 8',
    content: '夜见哉川改变了旧档案的归属，并留下可追溯的封印。',
  };
  return {
    schema: 'eyon.butterfly.request.v1',
    requestId: 'request-1',
    characterKey: namespace.characterKey,
    chatId: namespace.chatId,
    runId: 'run-1',
    trigger: {
      type: 'text',
      userMessageId: 9,
      returnAssistantMessageId: 10,
      rawCommand: '遣返',
    },
    anchors: {
      reality: { time: '复兴纪元488年-3月-15日-14:05', location: '金谷城-仪式大厅' },
      ruinEntry: { time: '复兴纪元184年-11月-9日-23:15', location: '旧堡-侧翼走廊' },
      ruinExit: { time: '复兴纪元184年-11月-9日-23:20', location: '旧堡-密道入口' },
    },
    dice: { roll: 68, scope: '城市' },
    ruinHistory: {
      title: '被替换的名册',
      era: '复兴纪元',
      originalTrajectory: '旧名册原本会被焚毁',
      historicalBackground: '地方宗族争夺档案',
      enteredAnomaly: '名册替换',
      locationChain: ['旧堡', '侧翼走廊', '密道入口'],
    },
    playerInterventions: [chatSource],
    involvedEntities: [],
    currentRealityContext: [],
    relevantWorldbook: [],
    relevantChatFacts: [chatSource],
    relevantGenealogy: [],
    relevantBiographies: [],
    previousButterflyAnchors: [],
    sourceIndex: [chatSource],
  };
}

function result(): ButterflyResult {
  return {
    schema: 'eyon.butterfly.v1',
    requestId: 'request-1',
    runId: 'run-1',
    effect: {
      roll: 68,
      scope: '城市',
      presentLanding: '金谷城档案馆新近开放的旧族谱借阅室',
      perceptibleEvidence: ['现存目录中出现了玩家留下封印的摹本'],
      ruinActionRecord: '夜见哉川在旧堡档案即将焚毁前调换了关键名册，并以封印标记真实谱系，使原本会随火灾消失的继承证据被后来的抄写员重新发现并保存。他还刻意把两份互相矛盾的抄本留在不同柜层，迫使追查者核对封印而非相信权贵口述。',
      historicalEvolution: '名册被调换后，负责清点遗物的抄写员没有发现原件，却依据封印留下了一份摹本。数十年间，这份摹本先被地方宗族当作私产，随后在继承诉讼中进入城市法庭。法庭为核对土地边界建立了专门目录，促使相关档案免于第二次销毁。此后每逢领地转让，书记官都必须同时核验两份互相矛盾的版本，封印纹样逐渐成为判断真伪的法定旁证。到现世，目录制度已经扩展为公开借阅室，旧贵族对谱系证据的垄断因此松动。玩家能够在金谷城档案馆看到封印纹样、异于通行版本的姓名次序，以及围绕这份名册形成的成套诉讼记录。管理员还会指出一处从未被后世仿刻成功的细小缺口，它正是这条因果链留到今日的直接证据。',
      historicalKeywords: ['金谷城', '旧族谱', '档案馆', '封印摹本'],
    },
    causalStages: [
      {
        order: 1,
        time: '复兴纪元184年',
        carrier: '旧堡抄写员',
        change: '依据封印制作名册摹本',
        linkToNext: '摹本进入宗族保管体系',
        sourceIds: ['chat:8'],
      },
      {
        order: 2,
        time: '后续数十年',
        carrier: '城市法庭与档案馆',
        change: '诉讼推动摹本编目并公开保存',
        linkToNext: '目录制度延续到现世',
        sourceIds: ['chat:8'],
      },
    ],
    sourceIds: ['chat:8'],
    inferences: [{
      content: '档案诉讼是私藏摹本转为公共目录的有限推断',
      basisSourceIds: ['chat:8'],
    }],
    warnings: [],
    qualityChecks: {
      anchorsUntouched: true,
      scopeRespected: true,
      causalChainComplete: true,
      presentEvidenceConcrete: true,
      playerAgencyPreserved: true,
      canonConflictsResolved: true,
    },
  };
}

test('蝴蝶效应严格锁定请求、轮次、骰点、来源与因果链', () => {
  const validated = parseAndValidateButterfly(JSON.stringify(result()), request());
  assert.equal(validated.effect.scope, '城市');

  const changed = result();
  changed.effect.scope = '国家';
  assert.throws(
    () => parseAndValidateButterfly(JSON.stringify(changed), request()),
    /dice scope/u,
  );
});

test('蝴蝶效应按 validated → message_committed → committed 提交且同轮不重复', async () => {
  const repository = new MemoryButterflyRepository();
  const panels: string[] = [];
  const archives: string[] = [];
  let generatorCalls = 0;
  const host: ButterflyHostAdapter = {
    async getNamespace() { return namespace; },
    async getRuinRuntimeSnapshot() {
      return {
        flowState: 'idle',
        runId: '',
        realityTime: '',
        realityLocation: '',
        ruinTime: '',
        ruinLocation: '',
      };
    },
    async getButterflyFreezeSnapshot() { throw new Error('not used'); },
    async getLatestUserText() { return '遣返'; },
    async replaceAssistantSlot() {},
    async assertButterflyTarget() {},
    async appendButterflyPanel(_messageId, _requestId, panel) {
      panels.push(panel);
    },
  };
  const generator: GenerationAdapter = {
    async generate() {
      generatorCalls += 1;
      return JSON.stringify(result());
    },
  };
  const archive: ArchiveAdapter = {
    async mirrorButterflyRecord(input) {
      archives.push(input.content);
      return { worldbookName: '伊雍-蝴蝶效应锚定-chat-butterfly', uid: 7 };
    },
  };
  const workflow = new ButterflyWorkflow({
    generator,
    repository,
    host,
    archive,
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    now: () => 100,
  });
  const frozen = request();
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, frozen.runId),
    namespace,
    runId: frozen.runId,
    request: frozen,
    assistantSwipeId: null,
    sourceHash: 'hash-1',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  const committed = await workflow.settle(pending);
  assert.equal(committed.status, 'committed');
  assert.equal(panels.length, 1);
  assert.equal(archives.length, 1);
  assert.equal(await repository.getPending(pending.key), null);
  assert.equal(
    (await repository.getRecord(butterflyRecordKey(namespace, frozen.runId)))?.worldbookUid,
    7,
  );

  const same = await workflow.settle(pending);
  assert.equal(same.status, 'committed');
  assert.equal(panels.length, 1);
  assert.equal(archives.length, 1);
  assert.equal(generatorCalls, 1);

  const reroll: PendingSettlement = {
    ...pending,
    request: {
      ...pending.request,
      trigger: {
        ...pending.request.trigger,
        userMessageId: 11,
        returnAssistantMessageId: 12,
      },
    },
    revision: 2,
    updatedAt: 2,
  };
  await repository.savePending(reroll);
  const rebound = await workflow.settle(reroll);
  assert.equal(rebound.assistantMessageId, 12);
  assert.equal(rebound.status, 'committed');
  assert.equal(panels.length, 2);
  assert.equal(archives.length, 2);
  assert.equal(generatorCalls, 1);
});

test('蝴蝶效应生成失败时保留冻结快照且不触碰正文或世界书', async () => {
  const repository = new MemoryButterflyRepository();
  let panelCalls = 0;
  let archiveCalls = 0;
  const frozen = request();
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, frozen.runId),
    namespace,
    runId: frozen.runId,
    request: frozen,
    assistantSwipeId: null,
    sourceHash: 'hash-failure',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  const workflow = new ButterflyWorkflow({
    generator: {
      async generate() { return '{"schema":"wrong"}'; },
    },
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() { throw new Error('not used'); },
      async getButterflyFreezeSnapshot() { throw new Error('not used'); },
      async getLatestUserText() { return '遣返'; },
      async replaceAssistantSlot() {},
      async assertButterflyTarget() {},
      async appendButterflyPanel() { panelCalls += 1; },
    },
    archive: {
      async mirrorButterflyRecord() {
        archiveCalls += 1;
        return { worldbookName: 'never', uid: -1 };
      },
    },
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    now: () => 100,
  });
  await assert.rejects(() => workflow.settle(pending));
  assert.equal(panelCalls, 0);
  assert.equal(archiveCalls, 0);
  assert.deepEqual(await repository.getPending(pending.key), pending);
  assert.equal(
    await repository.getRecord(butterflyRecordKey(namespace, frozen.runId)),
    null,
  );
});

test('遣返楼重掷优先复用同一玩家楼记录，不在 idle 后重新读取活动变量', async () => {
  const repository = new MemoryButterflyRepository();
  const frozen = request();
  await repository.saveRecord({
    key: butterflyRecordKey(namespace, frozen.runId),
    namespace,
    runId: frozen.runId,
    requestId: frozen.requestId,
    request: frozen,
    result: result(),
    sourceHash: 'frozen-hash',
    panel: '<butterfly_panel></butterfly_panel>',
    archiveEntry: '### 《蝴蝶效应锚定日志1》',
    assistantMessageId: 10,
    status: 'committed',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  let freezeCalls = 0;
  const assembler = {
    async freeze() {
      freezeCalls += 1;
      throw new Error('idle state must not be read on reroll');
    },
  } as unknown as TavernButterflyContextAssembler;
  const controller = new ButterflyController({
    assembler,
    workflow: {} as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [{
        message_id: 9,
        role: 'user',
        message: '遣返',
      }],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'must-not-be-used',
    roll: () => 1,
    now: () => 100,
  });
  const pending = await controller.prepareText('遣返');
  assert.equal(freezeCalls, 0);
  assert.equal(pending?.runId, frozen.runId);
  assert.equal(pending?.request.trigger.returnAssistantMessageId, 0);
});
