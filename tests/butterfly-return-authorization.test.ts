import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCommandInput } from '../src/core/commands.ts';
import type { ButterflyRequest } from '../src/schemas/butterfly.ts';
import { MemoryButterflyRepository, butterflyRecordKey, type ButterflyRecord, type PendingSettlement } from '../src/storage/butterflies.ts';
import { ButterflyController } from '../src/runtime/butterflyController.ts';
import type { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import { isWorkbenchReturnAuthorized } from '../src/runtime/butterflyReturnAuthorization.ts';
import { TavernRuntimeAdapter } from '../src/runtime/tavernRuntimeAdapter.ts';
import { SerializedTavernUserTurnAdapter, type TavernDataBindings } from '../src/runtime/tavernHost.ts';
import { registerRuinTimeKernel } from '../src/runtime/ruinTimeKernel.ts';
import type { ButterflyWorkflow } from '../src/workflows/butterfly.ts';

const namespace = { characterKey: '卡A', chatId: 'chat-A' };
const playerText = '我抱着小花灵走出墟境。\n\n好了，遣返吧，伊雍——';

/** 严格模拟已核验的助手普通消息分支及swipe extra读取，不调用真实宿主或模型。 */
function harness(mode = 'normal') {
  let chat = namespace.chatId;
  const calls: string[] = [];
  const messages: any[] = [{ message_id: 0, role: 'assistant', message: '[RuinTrace]进入后完整行动',
    data: {}, swipe_id: 0, swipe_info: [{ extra: {} }] }];
  const writes: any[] = [];
  const playerData = { stat_data: { 主角: { 姓名: '玩家', 钱包: 12 } }, foreignData: { untouched: true } };
  const runtime = new TavernRuntimeAdapter({
    getCurrentCharacterName: () => namespace.characterKey,
    getCurrentChatId: () => chat,
    getLastMessageId: () => messages.at(-1).message_id,
    getChatMessages: range => messages.filter(item => typeof range === 'number'
      ? item.message_id === range : item.message_id <= Number(range.split('-')[1]))
      .map(item => structuredClone({ ...item, extra: item.swipe_info[item.swipe_id].extra })),
    async setChatMessages(updates, options) {
      calls.push('write'); writes.push(structuredClone({ updates, options }));
      for (const update of updates) {
        // JS-Slash-Runner 36d8889/src/function/chat_message.ts: extra-only不进普通消息分支。
        if (!Object.hasOwn(update, 'message') && !Object.hasOwn(update, 'data')) continue;
        if (mode === 'drop') continue; // 宿主成功resolve却没有落盘。
        const item = messages.find(message => message.message_id === update.message_id);
        if (Object.hasOwn(update, 'message')) item.message = update.message;
        if (Object.hasOwn(update, 'data')) item.data = structuredClone(update.data);
        if (Object.hasOwn(update, 'extra')) item.swipe_info[item.swipe_id].extra = structuredClone(update.extra);
        if (mode === 'body') item.message = normalizeCommandInput(item.message);
        if (mode === 'swipe') { item.swipe_id = 1; item.swipe_info.push({ extra: {} }); }
        if (mode === 'evidence') messages[0].message += '行动已变';
        if (mode === 'chat') chat = 'chat-B';
      }
    },
    async setExtensionPrompt() {}, injectOncePrompt: () => false,
    async generate() { throw new Error('不调用真实模型'); },
    async generateRaw() { throw new Error('不调用真实模型'); },
  });
  const repository = new MemoryButterflyRepository();
  const bindings = {
    async createUserMessage(text: string) {
      calls.push('create'); messages.push({ message_id: messages.length, role: 'user', message: text,
        data: structuredClone(playerData), swipe_id: 0, swipe_info: [{ extra: { foreign: { preserved: true } } }] });
    },
    async triggerReply() { calls.push('trigger'); },
  } as TavernDataBindings;
  const kernel = registerRuinTimeKernel(runtime, bindings, {});
  const controller = new ButterflyController({
    runtime, repository, roll: () => 1, now: () => 100, createRequestId: () => 'request-A',
    assembler: {
      async freeze(input: { requestId: string; userMessageId: number; rawCommand: string; triggerType: 'button' }) {
        calls.push('freeze');
        const request: ButterflyRequest = {
          schema: 'eyon.butterfly.request.v1', requestId: input.requestId, ...namespace, runId: 'run-A',
          trigger: { type: input.triggerType, userMessageId: input.userMessageId,
            returnAssistantMessageId: 0, rawCommand: input.rawCommand },
          anchors: { reality: { time: '488年14:05', location: '现实城' },
            ruinEntry: { time: '184年23:15', location: '旧堡' },
            ruinExit: { time: '184年23:20', location: '旧堡密道' } },
          dice: { roll: 1, scope: '个人' },
          ruinHistory: { title: '旧堡', era: '复兴纪元', originalTrajectory: '',
            historicalBackground: '', enteredAnomaly: '', locationChain: ['旧堡'] },
          playerInterventions: [], involvedEntities: [], currentRealityContext: [], relevantWorldbook: [],
          relevantChatFacts: [], relevantGenealogy: [], relevantBiographies: [], previousButterflyAnchors: [], sourceIndex: [],
        };
        return { request, sourceHash: 'frozen-source' };
      },
    } as unknown as TavernButterflyContextAssembler,
    workflow: {
      async prepare(pending: PendingSettlement) {
        calls.push('prepare');
        const record = { ...pending, key: butterflyRecordKey(namespace, pending.runId),
          requestId: pending.request.requestId, result: {}, status: 'validated' } as unknown as ButterflyRecord;
        await repository.saveRecord(record); return record;
      },
    } as unknown as ButterflyWorkflow,
    narrativeShell: { async arm() { calls.push('arm'); }, async clear() { calls.push('clear-shell'); },
      async clearActive() { calls.push('clear-shell'); }, async assertRenderedFloor() {} },
    hooks: { onReturnPrepared(pending) {
      calls.push('authorize');
      if (!kernel.authorizeReturn(pending)) throw new Error('本轮遣返事务未能登记，请保留玩家楼并重试。');
    } },
  });
  const sender = new SerializedTavernUserTurnAdapter(runtime, bindings, {
    onUserFloorCreated: () => { calls.push('clear-input'); },
  });
  const submit = () => sender.sendUserTurn(playerText, {
    beforeCreate: id => controller.prepareBeforeUserTurn(playerText, id).then(() => undefined),
    afterCreate: id => controller.confirmPreparedUserFloor(playerText, id),
  });
  return { runtime, messages, calls, writes, playerData, submit, kernel };
}

test('严格助手分支：预冻结、建楼、保存当前swipe授权、真实内核登记后才触发一次正文', async () => {
  const h = harness();
  try {
    await h.runtime.setChatMessages([{ message_id: 0, extra: { unsupportedProbe: true } }], { refresh: 'none' });
    assert.deepEqual(h.runtime.getChatMessages(0)[0].extra, {}); // 负控证明桩不是宽松Object.assign。
    h.calls.length = 0; h.writes.length = 0;
    assert.deepEqual(await h.submit(), { messageId: 1 });
    assert.deepEqual(h.calls, ['freeze', 'prepare', 'arm', 'create', 'clear-input', 'write', 'authorize', 'trigger']);
    assert.equal(h.messages.length, 2);
    const user = h.runtime.getChatMessages(1)[0];
    assert.equal(user.message, playerText); assert.deepEqual(user.data, h.playerData);
    assert.deepEqual(user.extra?.foreign, { preserved: true });
    assert.equal(isWorkbenchReturnAuthorized(h.runtime, user, 'run-A'), true);
    assert.equal(isWorkbenchReturnAuthorized(h.runtime, user, 'other-run'), false);
    assert.deepEqual(Object.keys(h.writes[0].updates[0]).sort(), ['extra', 'message', 'message_id']);
    assert.deepEqual(h.writes[0].options, { refresh: 'none' });
  } finally { h.kernel.dispose(); }
});

test('宿主静默不写也必须由回读拒绝；保留已建玩家楼，不登记、不触发正文', async () => {
  const h = harness('drop');
  try {
    await assert.rejects(h.submit(), /遣返授权写入后校验失败/u);
    assert.equal(h.messages.length, 2); assert.equal(h.messages[1].message, playerText);
    assert.deepEqual(h.messages[1].data, h.playerData);
    assert.ok(h.calls.includes('clear-shell'));
    assert.ok(!h.calls.includes('authorize')); assert.ok(!h.calls.includes('trigger'));
  } finally { h.kernel.dispose(); }
});

test('写后原正文、swipe、行动来源或聊天变化不能放宽门禁继续触发', async () => {
  for (const mode of ['body', 'swipe', 'evidence', 'chat']) {
    const h = harness(mode);
    try {
      await assert.rejects(h.submit(), /遣返授权写入后校验失败/u, mode);
      assert.ok(!h.calls.includes('authorize'), mode); assert.ok(!h.calls.includes('trigger'), mode);
      assert.equal(h.messages.length, 2);
    } finally { h.kernel.dispose(); }
  }
});
