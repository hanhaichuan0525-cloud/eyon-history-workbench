import assert from 'node:assert/strict';
import test from 'node:test';
import type {
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
  canonMemoryTombstoneKey,
  MemoryButterflyRepository,
  pendingSettlementKey,
  type ButterflyRecord,
  type PendingSettlement,
} from '../src/storage/butterflies.ts';
import { ButterflyController } from '../src/runtime/butterflyController.ts';
import {
  currentBranchActiveStateFacts,
  type TavernButterflyContextAssembler,
} from '../src/runtime/butterflyContext.ts';
import {
  buildButterflyApiPrompt,
  buildButterflyNarrativeInstruction,
} from '../src/prompts/butterfly.ts';
import { TavernButterflyNarrativeShell } from '../src/runtime/tavernButterflyShell.ts';
import { parseAndValidateButterfly } from '../src/validators/butterfly.ts';
import { ButterflyWorkflow } from '../src/workflows/butterfly.ts';
import { MemoryCanonRepository } from '../src/storage/canon.ts';
import { reconcileCanonOrphans } from '../src/runtime/canonOrphanReconcile.ts';
import { syncButterflyCanonStatuses } from '../src/runtime/canonRecordStatus.ts';
import type { CanonFact } from '../src/retrieval/contracts.ts';
import { resolveCanon } from '../src/retrieval/canonResolver.ts';
import { continuousStateAt } from '../src/retrieval/continuousState.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import type { RuntimeChatMessage, TavernRuntime } from '../src/runtime/contracts.ts';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';
import { isWorkbenchReturnAuthorized } from '../src/runtime/butterflyReturnAuthorization.ts';
import { WorkbenchLifecycle } from '../src/runtime/workbenchLifecycle.ts';

function rollbackGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function rollbackHarness(
  requireReferences?: (sourceMessageId: number) => Promise<typeof DEFAULT_BUTTERFLY_REFERENCES>,
  onReturnRendered?: (pending: PendingSettlement) => Promise<void>,
  beforeFreeze?: () => void,
) {
  const repository = new MemoryButterflyRepository();
  const messages: RuntimeChatMessage[] = [
    { message_id: 8, role: 'assistant', message: '契约成功，珊奈决定同行。' },
    { message_id: 9, role: 'user', message: '遣返' },
  ];
  let freezeCalls = 0; let prepareCalls = 0; let runId = 'run-1';
  const statuses: string[] = [];
  const runtime: TavernRuntime = {
    getCurrentCharacterName: () => namespace.characterKey,
    getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => messages.at(-1)!.message_id,
    getMessageSwipeId: () => 0,
    getChatMessages: range => typeof range === 'number'
      ? messages.filter(item => item.message_id === range)
      : messages.filter(item => item.message_id <= Number(range.split('-')[1])),
    async setChatMessages(updates) {
      for (const update of updates) Object.assign(messages.find(item => item.message_id === update.message_id)!, update);
    }, async setExtensionPrompt() {},
    async generate() { return ''; }, async generateRaw() { return ''; },
  };
  const assembler = {
    async currentRun() { return { runId }; },
    async freeze(input: { userMessageId: number; requestId: string; rawCommand: string; triggerType: 'button' | 'text'; creativeReferences?: typeof DEFAULT_BUTTERFLY_REFERENCES }) {
      freezeCalls += 1;
      return { request: { ...request(), ...(input.creativeReferences ? { creativeReferences: input.creativeReferences } : {}), runId, requestId: input.requestId,
        trigger: { type: input.triggerType, userMessageId: input.userMessageId, returnAssistantMessageId: 0, rawCommand: input.rawCommand } },
      sourceHash: fingerprintText(JSON.stringify({ messages, creativeReferences: input.creativeReferences })) };
    },
    attachReturnFloor(req: ButterflyRequest, id: number) {
      return { ...req, trigger: { ...req.trigger, returnAssistantMessageId: id } };
    },
  } as unknown as TavernButterflyContextAssembler;
  const workflow = {
    async prepare(pending: PendingSettlement) {
      prepareCalls += 1;
      const record = rollbackRecord(pending);
      const existing = await repository.getRecord(record.key);
      if (existing && existing.sourceHash === pending.sourceHash) return existing;
      if (existing) await repository.updateRecord(record); else await repository.saveRecord(record);
      return record;
    },
    async settle(pending: PendingSettlement) { return rollbackRecord(pending); },
  } as unknown as ButterflyWorkflow;
  const controller = new ButterflyController({ assembler, workflow, repository, runtime,
    createRequestId: () => `request-${freezeCalls + 1}`, roll: () => 68, now: () => 100,
    hooks: { requireReferences, onReturnRendered, beforeFreeze, onStatus: status => { statuses.push(status); } },
    narrativeShell: { async arm() {}, async clear() {}, async clearActive() {}, async assertRenderedFloor() {} },
  });
  return { controller, repository, runtime, messages, assembler, workflow, statuses,
    calls: () => ({ freezeCalls, prepareCalls }), setRun: (value: string) => { runId = value; } };
}

function rollbackRecord(pending: PendingSettlement): ButterflyRecord {
  return { key: butterflyRecordKey(namespace, pending.runId), namespace, runId: pending.runId,
    requestId: pending.request.requestId, request: pending.request, result: result(),
    sourceHash: pending.sourceHash, triggerEvidenceHash: pending.triggerEvidenceHash,
    panel: '<butterfly_panel/>', archiveEntry: '归档', assistantMessageId: pending.request.trigger.returnAssistantMessageId,
    status: 'validated', revision: 1, createdAt: 1, updatedAt: 1 };
}

test('新一轮只有按钮遣返，先确认偏好；正文即使确认也不收集或调用模型', async () => {
    let allowed = false; let checks = 0;
    const h = rollbackHarness(async () => { checks++; if (!allowed) throw new Error('请先确认本轮参考方案'); return { ...DEFAULT_BUTTERFLY_REFERENCES }; });
    const prepare = () => h.controller.prepareBeforeUserTurn('遣返',9);
    assert.equal(await h.controller.prepareText('遣返'), null);
    assert.equal(checks, 0);
    await assert.rejects(prepare(),/请先确认/u);
    assert.deepEqual(h.calls(),{freezeCalls:0,prepareCalls:0});
    assert.equal((await h.repository.listPending(namespace)).length,0);
    allowed = true;
    assert.equal(await h.controller.prepareText('遣返'), null);
    const pending = await prepare();
    assert.deepEqual(pending?.request.creativeReferences,DEFAULT_BUTTERFLY_REFERENCES);
    assert.equal(checks,2);
    allowed = false;
    await assert.rejects(prepare(), /请先确认/u);
    assert.equal(checks,3,'重新点击遣返必须核验当前方案确认');
    assert.deepEqual(h.calls(),{freezeCalls:1,prepareCalls:1});
    await h.controller.retry(pending.runId);
    assert.equal(checks,3,'显式重试已冻结归档仍沿用冻结方案');
});

test('同楼重新确认不同方案后点击遣返，冻结与生成均采用新方案', async () => {
  let refs = { ...DEFAULT_BUTTERFLY_REFERENCES };
  const h = rollbackHarness(async () => refs);
  const first = await h.controller.prepareBeforeUserTurn('遣返', 9);
  refs = { ...refs, domain: '风俗与日常', evolution: '意外转用', manifestation: '自然遇见' };
  const second = await h.controller.prepareBeforeUserTurn('遣返', 9);
  assert.notEqual(first.request.requestId, second.request.requestId);
  assert.deepEqual(second.request.creativeReferences, refs);
  assert.notEqual(first.sourceHash, second.sourceHash);
  assert.deepEqual(h.calls(), { freezeCalls: 2, prepareCalls: 2 });
  const stored = await h.repository.getRecord(butterflyRecordKey(namespace, second.runId));
  assert.deepEqual(stored?.request.creativeReferences, refs);
});

test('方案内容相同而属性排列不同，同楼准备仍复用完整冻结来源', async () => {
  let refs = { ...DEFAULT_BUTTERFLY_REFERENCES };
  const h = rollbackHarness(async () => refs);
  const first = await h.controller.prepareBeforeUserTurn('遣返', 9);
  refs = Object.fromEntries(Object.entries(refs).reverse()) as typeof refs;
  const second = await h.controller.prepareBeforeUserTurn('遣返', 9);
  assert.equal(first.request.requestId, second.request.requestId);
  assert.equal(h.calls().freezeCalls, 1);
});

test('独立API预检只保护新冻结，已有结果的同楼复用与正文重roll不再检查地址', async () => {
  let configured = true; let checks = 0;
  const h = rollbackHarness(async () => ({ ...DEFAULT_BUTTERFLY_REFERENCES }), undefined, () => {
    checks++;
    if (!configured) throw new Error('独立 API 地址为空');
  });
  const first = await h.controller.prepareBeforeUserTurn('遣返', 9);
  await h.controller.confirmPreparedUserFloor('遣返', 9);
  configured = false;
  const reused = await h.controller.prepareBeforeUserTurn('遣返', 9);
  const rerolled = await h.controller.prepareText('遣返');
  assert.equal(reused.request.requestId, first.request.requestId);
  assert.equal(rerolled?.request.requestId, first.request.requestId);
  assert.equal(checks, 1);
  assert.equal(h.calls().freezeCalls, 1);
  assert.equal((await h.repository.getRecord(butterflyRecordKey(namespace, first.runId)))?.revision, 1);
});

for (const fails of [false, true]) test(`返程时地交接${fails ? '失败保留可重试快照' : '先于归档且恢复丢失的同楼授权'}`, async () => {
  const order: string[] = [];
  let fail = fails;
  const h = rollbackHarness(async () => ({ ...DEFAULT_BUTTERFLY_REFERENCES }), async pending => {
    assert.equal(pending.request.trigger.returnAssistantMessageId, 10);
    assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), true);
    order.push('restore');
    if (fail) throw new Error('现实锚点回读失败');
  });
  h.workflow.settle = async pending => { order.push('settle'); return rollbackRecord(pending); };
  const pending = await h.controller.prepareBeforeUserTurn('遣返', 9);
  await h.controller.confirmPreparedUserFloor('遣返', 9);
  h.messages[1].extra = {}; // 宿主重写玩家楼时丢失脚本元数据。
  h.messages.push({ message_id: 10, role: 'assistant', message: '已经回到现世。' });
  if (fails) {
    await assert.rejects(h.controller.commitRendered(10), /现实锚点回读失败/u);
    assert.deepEqual(order, ['restore']);
    assert.match((await h.repository.getPending(pending.key))!.failure!.message, /现实锚点回读失败/u);
    fail = false;
    await h.controller.retry(pending.runId);
    assert.deepEqual(order, ['restore', 'restore', 'settle']);
  } else {
    await h.controller.commitRendered(10);
    assert.deepEqual(order, ['restore', 'settle']);
  }
});

test('等待确认读取时停止任务可立即释放，迟到确认不冻结旧资料', { timeout:2000 }, async () => {
  const gate=rollbackGate<typeof DEFAULT_BUTTERFLY_REFERENCES>();
  const h=rollbackHarness(()=>gate.promise);
  const pending=h.controller.prepareBeforeUserTurn('遣返',9);
  const stopped=assert.rejects(pending,/cancelled/u);
  await new Promise(resolve=>setImmediate(resolve));
  h.controller.cancelPending(); await stopped;
  gate.resolve({...DEFAULT_BUTTERFLY_REFERENCES});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(h.calls(),{freezeCalls:0,prepareCalls:0});
});

test('正文自然遣返意愿只保留探索与引导，即使已经确认也不发起结算', async () => {
  let checks = 0;
  const h = rollbackHarness(async () => { checks++; return { ...DEFAULT_BUTTERFLY_REFERENCES }; });
  const guardCalls: string[] = [];
  const lifecycle = new WorkbenchLifecycle({
    runtime: h.runtime, butterfly: h.controller,
    biography: { async prepareText() { return null; }, async commitRendered() { return null; }, async cancelPending() {} },
    ruin: { async generateFromText() { return null; }, cancelPending() {} },
    genealogy: { async generateFromText() { return null; }, cancelPending() {} },
    ruinInputProvider: { async getInput() { throw new Error('不该请求墟境生成'); } },
    genealogyInputProvider: { async getInput() { throw new Error('不该请求谱系生成'); } },
    ruinTurnGuard: { async prepareOrdinaryTurn() { guardCalls.push('guide'); }, async clear() { guardCalls.push('clear'); } },
  });
  for (const text of ['好了，遣返吧，伊雍——', '抱着她回归现世。', '返回现世', '【伊雍遣返正文协作请求】遣返']) {
    h.messages[1].message = text;
    assert.equal(await lifecycle.onUserMessageSent(9), false);
    assert.equal(await lifecycle.beforeGeneration('normal'), false);
  }
  assert.deepEqual(h.calls(), { freezeCalls: 0, prepareCalls: 0 });
  assert.equal(checks, 0);
  assert.deepEqual(guardCalls, ['guide', 'guide', 'guide', 'guide']);
  assert.equal((await h.repository.listPending(namespace)).length, 0);
});

test('按钮授权只在准备成功后写入同楼元数据，重roll不再冻结也不降级为文本来源', async () => {
  const h = rollbackHarness(async () => ({ ...DEFAULT_BUTTERFLY_REFERENCES }));
  h.messages[1].data = { stat_data: { existing: '保留玩家楼变量' } };
  const pending = await h.controller.prepareBeforeUserTurn('遣返',9);
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), false);
  await h.controller.confirmPreparedUserFloor('遣返',9);
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), true);
  assert.equal(h.messages[1].message, '遣返', '不改玩家正文');
  assert.deepEqual(h.messages[1].data, { stat_data: { existing: '保留玩家楼变量' } }, '不重写玩家楼data/MVU');
  const resumed = await h.controller.prepareText('遣返');
  assert.equal(resumed?.request.trigger.type, 'button');
  assert.equal(h.calls().freezeCalls, 1);
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], 'other-run'), false);
  h.runtime.getCurrentChatId = () => 'other-chat';
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), false);
  h.runtime.getCurrentChatId = () => namespace.chatId;
  h.messages[0].message = '取消同行。';
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), false);
  assert.equal(await h.controller.prepareText('遣返'), null);
});

test('带行动草稿的按钮返程同文冻结并获得授权，正文能读取完整原话', async () => {
  const h = rollbackHarness(async () => ({ ...DEFAULT_BUTTERFLY_REFERENCES }));
  const text = '我抱着小花灵，决定带她回现世。\n\n遣返';
  h.messages[1].message = text;
  const pending = await h.controller.prepareBeforeUserTurn(text, 9);
  assert.equal(pending.request.trigger.rawCommand, text.normalize('NFKC'));
  await h.controller.confirmPreparedUserFloor(text, 9);
  assert.equal(isWorkbenchReturnAuthorized(h.runtime, h.messages[1], pending.runId), true);
  assert.equal(h.messages[1].message, text, '聊天原文保留全角标点；冻结元数据仍沿用既有NFKC匹配');
  assert.ok(buildButterflyNarrativeInstruction(result(), pending.request).includes(text.normalize('NFKC')));
});

test('新的文本预发送入口拒绝，旧文本冻结不自动启动但仍能从工作台重新归档', async () => {
  const h = rollbackHarness();
  await assert.rejects(h.controller.prepareBeforeUserTurn('遣返',9,'text'), /工作台/u);
  assert.deepEqual(h.calls(), { freezeCalls: 0, prepareCalls: 0 });
  const pending = await h.controller.prepareBeforeUserTurn('遣返',9);
  await h.repository.updatePending({ ...pending, request: { ...pending.request,
    trigger: { ...pending.request.trigger, type: 'text' } } });
  const record = (await h.repository.getRecord(butterflyRecordKey(namespace,pending.runId)))!;
  await h.repository.updateRecord({ ...record, request: { ...record.request,
    trigger: { ...record.request.trigger, type: 'text' } } });
  assert.equal(await h.controller.prepareText('遣返'), null);
  assert.ok(await h.controller.retry(pending.runId), '显式工作台旧冻结归档重试仍可用');
});

test('按钮准备期间前置行动被编辑，不给改变后的玩家楼签发返程授权', async () => {
  const h = rollbackHarness();
  const pending = await h.controller.prepareBeforeUserTurn('遣返',9);
  h.messages[0].message = '我明确撤回了带她同行的决定。';
  await assert.rejects(h.controller.confirmPreparedUserFloor('遣返',9), /行动来源已变化/u);
  assert.equal(isWorkbenchReturnAuthorized(h.runtime,h.messages[1],pending.runId),false);
});

test('按钮授权确认读库期间取消，迟到的旧pending不得重新给玩家楼授权', async () => {
  const h = rollbackHarness();
  const pending = await h.controller.prepareBeforeUserTurn('遣返',9);
  const reading = rollbackGate<PendingSettlement[]>();
  h.repository.listPending = () => reading.promise;
  const confirmation = h.controller.confirmPreparedUserFloor('遣返',9);
  const cancelled = assert.rejects(confirmation, /取消|cancel|lifecycle/u);
  h.controller.cancelPending();
  reading.resolve([pending]);
  await cancelled;
  assert.equal(isWorkbenchReturnAuthorized(h.runtime,h.messages[1],pending.runId),false);
});

test('软参考范围可退让到真实结果，旧冻结请求仍保持原范围回显', () => {
  const original=request(); const response=result();
  original.dice.scope='个人';
  original.creativeReferences={...DEFAULT_BUTTERFLY_REFERENCES,scope:'个人'};
  assert.doesNotThrow(()=>parseAndValidateButterfly(JSON.stringify(response),original));
  delete original.creativeReferences;
  assert.throws(()=>parseAndValidateButterfly(JSON.stringify(response),original),/dice scope/u);
});

test('按钮收集失败结束忙碌状态，不写半份 pending，工作台可重试', async () => {
    const h = rollbackHarness();
    const freeze = h.assembler.freeze.bind(h.assembler);
    h.assembler.freeze = async () => { throw new Error('人物证据关联失败'); };
    const prepare = () => h.controller.prepareBeforeUserTurn('遣返', 9);
    await assert.rejects(prepare(), /人物证据关联失败/u);
    assert.deepEqual(h.statuses, ['freezing_butterfly', 'butterfly_pending']);
    assert.equal((await h.repository.listPending(namespace)).length, 0);
    assert.equal(h.calls().prepareCalls, 0, '收集失败不能误称已调用模型');
    h.assembler.freeze = freeze;
    assert.ok(await prepare());
    assert.equal(h.statuses.at(-1), 'butterfly_awaiting_narrative');
});

test('停止后的旧收集任务晚失败，不得覆盖新遣返任务状态', async () => {
  const h = rollbackHarness();
  const freeze = h.assembler.freeze.bind(h.assembler);
  let rejectOld!: (error: Error) => void;
  h.assembler.freeze = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  const old = h.controller.prepareBeforeUserTurn('遣返',9);
  const cancelled = assert.rejects(old, /cancelled/u);
  await new Promise(resolve => setImmediate(resolve));
  h.controller.cancelPending(); await cancelled;
  h.assembler.freeze = freeze;
  assert.ok(await h.controller.prepareBeforeUserTurn('遣返',9));
  rejectOld(new Error('旧收集晚失败'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.statuses.at(-1), 'butterfly_awaiting_narrative');
  assert.ok(!h.statuses.includes('butterfly_pending'));
});

test('按钮同楼重roll复用，前置行动改变只允许再点按钮冻结', async () => {
  const h = rollbackHarness();
  const original = await h.controller.prepareBeforeUserTurn('遣返',9);
  await h.controller.prepareText('遣返');
  assert.equal(h.calls().freezeCalls, 1);
  h.messages[0].message = '取消之前的同行决定，珊奈留在历史中。';
  assert.equal(await h.controller.prepareText('遣返'), null);
  const changed = await h.controller.prepareBeforeUserTurn('遣返',9);
  assert.equal(h.calls().freezeCalls, 2);
  assert.notEqual(changed?.sourceHash, original?.sourceHash);
  assert.equal(h.statuses.at(-1), 'butterfly_awaiting_narrative');
});

test('相同遣返文字在新楼新墟境不复用旧轮pending', async () => {
  const h = rollbackHarness();
  await h.controller.prepareBeforeUserTurn('遣返',9);
  h.setRun('run-new');
  h.messages.push({ message_id: 50, role: 'assistant', message: '进入节点：另一段历史。' },
    { message_id: 51, role: 'user', message: '遣返' });
  assert.equal(await h.controller.prepareText('遣返'), null);
  const fresh = await h.controller.prepareBeforeUserTurn('遣返',51);
  assert.equal(fresh?.runId, 'run-new'); assert.equal(fresh?.request.trigger.userMessageId, 51);
  assert.equal(h.calls().freezeCalls, 2);
  assert.equal(await h.repository.getPending(pendingSettlementKey(namespace, 'run-1')), null);
});

test('旧提交忽略取消时可同楼重试，旧finally不删除新提交锁', { timeout: 2000 }, async () => {
  const h = rollbackHarness(); await h.controller.prepareBeforeUserTurn('遣返',9);
  h.messages.push({ message_id: 10, role: 'assistant', message: '遣返回来。' });
  const old = rollbackGate<ButterflyRecord>(); const fresh = rollbackGate<ButterflyRecord>();
  let calls = 0;
  h.workflow.settle = async (pending, assertActive) => {
    const record = await (++calls === 1 ? old.promise : fresh.promise);
    assertActive?.(); return record;
  };
  const first = h.controller.commitRendered(10);
  const cancelled = assert.rejects(first, /cancelled/u);
  await new Promise(resolve => setImmediate(resolve));
  h.controller.cancelPending(); await cancelled;
  const second = h.controller.commitRendered(10);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
  const pending = (await h.repository.listPending(namespace))[0];
  old.resolve(rollbackRecord(pending));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await h.controller.commitRendered(10), null);
  assert.equal(calls, 2, '旧任务收尾不得放开新互斥锁');
  fresh.resolve(rollbackRecord(pending)); assert.ok(await second);
});

test('回滚撤销受影响pending与预生成结果，不删除已归档历史或更早准备', async () => {
  const h = rollbackHarness(); const pending = await h.controller.prepareBeforeUserTurn('遣返',9); assert.ok(pending);
  const earlier = { ...pending, key: pendingSettlementKey(namespace, 'earlier'), runId: 'earlier',
    request: { ...pending.request, trigger: { ...pending.request.trigger, userMessageId: 2 } } };
  await h.repository.savePending(earlier);
  const archive = { ...rollbackRecord(pending), key: butterflyRecordKey(namespace, 'archive'),
    runId: 'archive', status: 'committed' as const };
  await h.repository.saveRecord(archive);
  h.controller.cancelPending(); await h.controller.onMessageDeleted(10);
  assert.equal(await h.repository.getPending(pending.key), null);
  assert.ok(await h.repository.getPending(earlier.key));
  assert.equal((await h.repository.getRecord(butterflyRecordKey(namespace, pending.runId)))?.canonStatus, 'reverted');
  assert.ok(await h.repository.getRecord(archive.key));
});

test('回滚清理捕获旧聊天，不因期间换聊天删除新聊天pending', async () => {
  const h = rollbackHarness(); const old = await h.controller.prepareBeforeUserTurn('遣返',9); assert.ok(old);
  const nextNamespace = { ...namespace, chatId: 'next-chat' };
  const next = { ...old, namespace: nextNamespace, key: pendingSettlementKey(nextNamespace, old.runId),
    request: { ...old.request, chatId: nextNamespace.chatId } };
  await h.repository.savePending(next);
  h.runtime.getCurrentChatId = () => nextNamespace.chatId;
  await h.controller.onMessageDeleted(10, namespace);
  assert.equal(await h.repository.getPending(old.key), null);
  assert.ok(await h.repository.getPending(next.key));
});

test('真实工作流：遣返AI删楼重roll复用全文并重绑Canon，删玩家楼再按钮才生成新蝴蝶', async () => {
  const h = rollbackHarness(); const canon = new MemoryCanonRepository();
  let generationCalls = 0;
  h.runtime.getMessageSwipeId = id => h.messages.find(message => message.message_id === id)?.swipe_id ?? 0;
  const host = { async getNamespace() { return namespace; }, async assertButterflyTarget() {},
    async appendButterflyPanel(id: number, requestId: string, panel: string) {
      const message = h.messages.find(message => message.message_id === id)!;
      message.message = message.message.replace(/<butterfly_panel>[\s\S]*?<\/butterfly_panel>/gu, '').trim() + '\n' + panel;
      message.extra = { eyonButterflyRequest: { requestId, swipeId: h.runtime.getMessageSwipeId(id), panelHash: fingerprintText(panel) } };
    }, async getButterflyFreezeSnapshot() { throw new Error('unused'); },
    async getRuinRuntimeSnapshot() { throw new Error('unused'); },
    async getLatestUserText() { return '遣返'; }, async replaceAssistantSlot() {},
  } satisfies ButterflyHostAdapter;
  const workflow = new ButterflyWorkflow({ repository: h.repository, canonRepository: canon, host,
    generator: { async generate(_task, prompt) {
      generationCalls++;
      const input = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
      return JSON.stringify({ ...result(), requestId: input.requestId, runId: input.runId });
    } }, now: () => 200,
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' },
  });
  h.workflow.prepare = workflow.prepare.bind(workflow); h.workflow.settle = workflow.settle.bind(workflow);
  const original = await h.controller.prepareBeforeUserTurn('遣返', 9);
  await h.controller.confirmPreparedUserFloor('遣返', 9);
  h.messages.push({ message_id: 10, role: 'assistant', message: '第一次返程正文', swipe_id: 0 });
  const first = await h.controller.commitRendered(10);
  assert.equal(first?.status, 'committed'); assert.equal(generationCalls, 1);
  const originalText = first!.result.effect.historicalEvolution;
  // 模拟真实删AI楼事件：Canon先回滚、对账、撤销pending；玩家遣返楼仍健在。
  h.messages.pop(); h.controller.cancelPending();
  await canon.rollbackByMessageId(namespace, 10, 201);
  await syncButterflyCanonStatuses({ repository: h.repository, namespace, branch: await canon.getBranch(namespace), now: 201 });
  await h.controller.onMessageDeleted(10);
  const replay = await h.controller.prepareText('遣返');
  assert.equal(replay?.request.requestId, original.request.requestId);
  assert.equal(generationCalls, 1); assert.equal(h.calls().freezeCalls, 1);
  h.messages.push({ message_id: 10, role: 'assistant', message: '重roll返程正文', swipe_id: 1 });
  const rebound = await h.controller.commitRendered(10);
  assert.equal(rebound?.result.effect.historicalEvolution, originalText);
  assert.equal(rebound?.canonStatus, 'active'); assert.equal(generationCalls, 1);
  assert.equal((await canon.getBranch(namespace)).revisions.filter(revision => revision.status === 'active').length, 1);
  const head = (await canon.getBranch(namespace)).headRevision;
  await h.controller.prepareText('遣返'); await h.controller.commitRendered(10);
  assert.equal((await canon.getBranch(namespace)).headRevision, head, '同楼重复渲染不重复入账');
  assert.equal(h.messages.at(-1)!.message.match(/<butterfly_panel>/gu)?.length, 1);
  // 删除玩家楼及后文后，手工重建同号同文也不能复活旧事务。
  h.messages.splice(1); h.controller.cancelPending();
  await canon.rollbackByMessageId(namespace, 10, 202);
  await syncButterflyCanonStatuses({ repository: h.repository, namespace, branch: await canon.getBranch(namespace), now: 202 });
  await h.controller.onMessageDeleted(9);
  h.messages.push({ message_id: 9, role: 'user', message: '遣返' });
  assert.equal(await h.controller.prepareText('遣返'), null);
  h.messages.pop();
  const fresh = await h.controller.prepareBeforeUserTurn('遣返', 9);
  assert.notEqual(fresh.request.requestId, original.request.requestId);
  assert.equal(generationCalls, 2); assert.equal(h.calls().freezeCalls, 2);
});

test('相同runId但来源已变化的预生成结果重建，orphaned仍不自动改写', async () => {
  const h = rollbackHarness(); const pending = await h.controller.prepareBeforeUserTurn('遣返',9); assert.ok(pending);
  let generated = 0;
  const workflow = new ButterflyWorkflow({ repository: h.repository, now: () => 10,
    generator: { async generate() { generated += 1; return JSON.stringify(result()); } },
    host: { async getNamespace() { return namespace; } } as ButterflyHostAdapter,
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' },
  });
  // 使用标准 requestId，让真实 validator 验证输出，而非只检查 mock 调用。
  const changed = { ...pending, request: request(), sourceHash: 'changed' };
  const rebuilt = await workflow.prepare(changed);
  assert.equal(generated, 1); assert.equal(rebuilt.sourceHash, 'changed');
  await h.repository.updateRecord({ ...rebuilt, canonStatus: 'orphaned' });
  await workflow.prepare({ ...changed, sourceHash: 'another' });
  assert.equal(generated, 1);
});

test('契约事实与玩家最后决定同时进入后台和正文，不新增模型必填字段', () => {
  const req = request();
  req.playerInterventions = [
    { sourceId: 'chat:6', title: 'assistant floor 6', content: '命定契约成功，所需FP已扣除。' },
    { sourceId: 'chat:7', title: 'user floor 7', content: '把珊奈带到现实，跟我一起遣返。' },
    { sourceId: 'chat:8', title: 'user floor 8', content: '取消带回决定，珊奈留在这里。' },
  ];
  req.sourceIndex = [...req.playerInterventions];
  const rules = { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' };
  for (const prompt of [buildButterflyApiPrompt({ request: req, rules }), buildButterflyNarrativeInstruction(result(), req)]) {
    for (const source of req.playerInterventions) assert.ok(prompt.includes(source.content));
    assert.match(prompt, /契约失败\/FP不足/u); assert.match(prompt, /只签约但没有带回决定/u);
    assert.match(prompt, /最后有效决定/u); assert.match(prompt, /控制台偏好只提供间接余波的创作参考/u);
    assert.doesNotMatch(prompt, /骰点规模只限制间接余波/u);
  }
  assert.equal(buildButterflyApiPrompt({ request: req, rules }).match(/<EYON_BUTTERFLY_REQUEST_JSON>/gu)?.length, 1);
});

test('长楼末尾与旧窗口契约确认完整保留，玩家行动不被AI楼挤出', async () => {
  const { TavernButterflyContextAssembler: Assembler } = await import('../src/runtime/butterflyContext.ts');
  const confirmation = '普通场景。'.repeat(1000) + '\n命定契约成功，FP已扣除，双方约定可以同行。';
  const messages: RuntimeChatMessage[] = [
    { message_id: 1, role: 'assistant', message: '[RuinTrace]\nTitle:: 旧港\n[/RuinTrace]' },
    { message_id: 2, role: 'user', message: '我决定将珊奈带到现实。' },
    { message_id: 3, role: 'assistant', message: confirmation },
    ...Array.from({ length: 64 }, (_, index) => ({ message_id: index + 4,
      role: index % 2 ? 'assistant' as const : 'user' as const, message: `普通行动${index}` })),
    { message_id: 68, role: 'user', message: '好了，遣返吧，伊雍——' },
  ];
  const h = rollbackHarness();
  h.messages.splice(0, h.messages.length, ...messages);
  const prompts: string[] = [];
  h.runtime.setExtensionPrompt = async (_key, text) => { prompts.push(text); };
  const assembler = new Assembler(h.runtime, {
    async getWorldbookSources() { return []; }, async getCharacterSources() { return []; },
    async getGenealogySources() { return []; }, async getBiographySources() { return []; },
    async getButterflySources() { return []; },
  } as never, {
    async getButterflyFreezeSnapshot() { return { runId: 'long', ...request().anchors }; },
    getRuinRoundStartMessageId() { return 1; },
  } as never, {
    async capture() { return { status: 'success', sourceMappings: [], receipt: { selected: [] },
      bundle: { receipt: {}, passages: [], conflictGroupIds: [], sourceSnapshots: [] } }; },
  } as never);
  const frozen = await assembler.freeze({ requestId: 'long', namespace, userMessageId: 68,
    rawCommand: '好了,遣返吧,伊雍——', triggerType: 'text', roll: 68 });
  assert.ok(frozen.request.playerInterventions.some(source => source.content === confirmation));
  assert.ok(frozen.request.playerInterventions.some(source => source.sourceId === 'chat:2'));
  assert.ok(frozen.request.playerInterventions.some(source => source.sourceId === 'chat:38'));
  assert.ok(frozen.request.playerInterventions.some(source => source.sourceId === 'chat:68'));
  assert.ok(frozen.request.playerInterventions.some(source => source.sourceId === 'chat:15'), '本轮普通旧楼也是行动事实，不得靠窗口丢弃');
  assert.equal(frozen.request.sourceIndex.filter(source => source.sourceId.startsWith('chat:')).length, 68);
  const shell = new TavernButterflyNarrativeShell(h.runtime);
  await shell.arm({ ...((await h.controller.prepareBeforeUserTurn(h.messages.at(-1)!.message,9))!), request: frozen.request }, result());
  assert.ok(prompts.at(-1)?.includes(confirmation));
  assert.ok(prompts.at(-1)?.includes('我决定将珊奈带到现实。'));
});

test('蝴蝶档案删除同时清理同轮待结算快照，且重复删除幂等', async () => {
  const repository = new MemoryButterflyRepository();
  const runId = 'run-delete';
  const pending = {
    key: pendingSettlementKey(namespace, runId), namespace, runId,
  } as PendingSettlement;
  await repository.savePending(pending);
  await repository.saveRecord({
    key: butterflyRecordKey(namespace, runId), namespace, runId,
  } as never);

  assert.equal(await repository.deleteRun(namespace, runId), true);
  assert.equal(await repository.getRecord(butterflyRecordKey(namespace, runId)), null);
  assert.equal(await repository.getPending(pendingSettlementKey(namespace, runId)), null);
  assert.equal(await repository.deleteRun(namespace, runId), false);
});

test('G-09 删除可见档案时可原子保留紧凑正史记忆残片', async () => {
  const repository = new MemoryButterflyRepository();
  const runId = 'run-memory-tombstone';
  await repository.saveRecord({
    key: butterflyRecordKey(namespace, runId), namespace, runId,
  } as never);
  const tombstone = {
    key: canonMemoryTombstoneKey(namespace, runId), namespace, runId,
    branchId: 'canon:test', canonRevision: 3,
    actionRef: 'action:3', deltaRef: 'delta:3', title: '已删除档案',
    spacetime: '复兴纪元481年·黑曜监牢', actionRecord: '海因里希救出玲山。',
    softKeywords: ['玲山', '黑曜监牢'], createdAt: 1, deletedAt: 2,
  };
  assert.equal(await repository.deleteRun(namespace, runId, tombstone), true);
  assert.equal((await repository.listMemoryTombstones(namespace)).length, 1);
  assert.equal((await repository.listMemoryTombstones(namespace))[0]?.actionRecord, '海因里希救出玲山。');
});

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
      type: 'button',
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

test('历史赎出索引与归返提示保留同一个人的连续性，不生成旧成年副本', async () => {
  const h = linkingSettleHarness({
    carriers: [{ carrier: '幽谷居民', time: '神明纪元1年', change: '记下二叶离去' },
      { carrier: '档案馆', time: '复兴纪元488年', change: '保存离去记录' }],
    directEffects: [{ subject: '二叶', time: '神明纪元1年1月1日09:05', stateHint: '历史赎出',
      change: '半岁的二叶已通过成功契约离开历史，随玩家抵达现世。',
      continuousState: { dimension: 'location', value: '现世', start: '复兴纪元488年' } }],
    linkingIndex: [{ entityId: 'entity:two-leaf', names: ['二叶'] }],
  });
  h.pending.request.anchors.ruinEntry = { time: '神明纪元1年1月1日09:00', location: '幽谷溪畔' };
  h.pending.request.anchors.ruinExit = { time: '神明纪元1年1月1日09:05', location: '幽谷溪畔' };
  const saved = await h.workflow.settle(h.pending);
  const branch = await h.canon.getBranch(namespace);
  const fact = branch.deltas[0]!.operations.find(op => op.current.subjectEntityId === 'entity:two-leaf')!.current;
  assert.equal(fact.predicate, 'historical_redemption');
  assert.equal(fact.continuousState, undefined);
  assert.equal(branch.deltas[0]!.operations.find(op => op.current === fact)!.factKey,
    'entity:two-leaf|historical_redemption|world');
  assert.equal(fact.temporalScope, h.pending.request.anchors.ruinExit.time);
  assert.match(fact.statement, /现世抵达：复兴纪元488年/u);
  for (const prompt of [buildButterflyNarrativeInstruction(saved.result, h.pending.request),
    buildButterflyApiPrompt({ request: h.pending.request,
      rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' } })]) {
    assert.match(prompt, /不是复制品/u);
    assert.match(prompt, /成年/u);
    assert.match(prompt, /赎出前/u);
    assert.match(prompt, /不等于死亡/u);
  }
});

test('取消赎出、仅签约、复制品带回不建立原本人历史抽离状态，缺索引仍可结算', async () => {
  for (const stateHint of ['历史赎出失败', '取消历史赎出', '仅签约', '复制品带回', '']) {
    const h = linkingSettleHarness({
      carriers: [{ carrier: '旧堡', time: '复兴纪元184年', change: '保留旧档案' },
        { carrier: '档案馆', time: '复兴纪元488年', change: '保存档案' }],
      directEffects: stateHint ? [{ subject: '二叶', time: '', stateHint, change: stateHint }] : [],
      linkingIndex: [{ entityId: 'entity:two-leaf', names: ['二叶'] }],
    });
    assert.equal((await h.workflow.settle(h.pending)).status, 'committed');
    const branch = await h.canon.getBranch(namespace);
    assert.ok(branch.deltas[0]!.operations.every(op => op.current.predicate !== 'historical_redemption'));
  }
});

test('蝴蝶效应提示词包含只读证据与完整因果计划且仍使用单一请求', () => {
  const prompt = buildButterflyApiPrompt({
    request: request(),
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
  });
  assert.match(prompt, /<BUTTERFLY_EVIDENCE_POLICY_READ_ONLY>/u);
  assert.match(prompt, /<BUTTERFLY_CAUSAL_PLAN>/u);
  assert.match(prompt, /<BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>/u);
  assert.match(prompt, /历史演变是本结果的主体/u);
  assert.match(prompt, /建议 450-900 个中文字符/u);
  assert.match(prompt, /仅用于兼容回显/u);
  assert.doesNotMatch(prompt, /被永久改写|只限定\*\*结果落地时的规模\*\*/u);
  assert.match(prompt, /不是越不成比例越好/u);
  assert.match(prompt, /误读可有可无/u);
  assert.match(prompt, /代价不是硬性要求/u);
  assert.match(prompt, /继续调查、利用、保护、交易、对抗或误解/u);
  assert.match(prompt, /不得写成范围说明、得失清单、游戏结算报告或固定模板/u);
  assert.match(prompt, /两到三条不同的可能路径/u);
  assert.match(prompt, /人生的志愿与际遇、感情与后代、技术与创造/u);
  assert.match(prompt, /信仰与竞争、生态与迁徙、游戏与习俗/u);
  assert.doesNotMatch(prompt, /【人生接力】|【用途转生】|【共同生活】/u);
  assert.doesNotMatch(prompt, /【失败｜不要这样写】/u);
  assert.match(prompt, /结果为何自然长成此种深度与范围/u);
  assert.match(prompt, /directEffects 作为脚本内部索引卡/u);
  assert.match(prompt, /具名物品，也必须单列一项/u);
  assert.match(prompt, /物品状态（原件损毁\/遗失\/修复\/替换）/u);
  assert.match(prompt, /不要生成 factId、entityId/u);
  assert.equal(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>/gu)?.length, 1);
});

test('蝴蝶历史演变保留完整性下限，范围不再形成超长拒收', () => {
  const compact = result();
  compact.effect.historicalEvolution = '甲'.repeat(180);
  const personalRequest = request();
  personalRequest.dice = { roll: 10, scope: '个人' };
  compact.effect.roll = 10;
  compact.effect.scope = '个人';
  assert.doesNotThrow(() => parseAndValidateButterfly(
    JSON.stringify(compact),
    personalRequest,
  ));

  const tooShortForNation = structuredClone(compact);
  const nationRequest = request();
  nationRequest.dice = { roll: 90, scope: '国家' };
  tooShortForNation.effect.roll = 90;
  tooShortForNation.effect.scope = '国家';
  assert.throws(
    () => parseAndValidateButterfly(JSON.stringify(tooShortForNation), nationRequest),
    /below the accepted minimum 220.*国家/u,
  );
});

test('787字和更长的蝴蝶原文均完整接收，新参考与旧冻结请求都不裁剪', () => {
  for (const references of [undefined, { ...DEFAULT_BUTTERFLY_REFERENCES }]) {
    const req = request(); req.dice = { roll: 1, scope: '个人' };
    if (references) req.creativeReferences = references;
    for (const length of [787, 1200, 2400]) {
      const value = result(); value.effect.roll = 1;
      value.effect.scope = references ? '跨国' : '个人';
      value.effect.historicalEvolution = '甲'.repeat(length - 4) + '\n\n末尾原文';
      const parsed = parseAndValidateButterfly(JSON.stringify(value), req);
      assert.equal(parsed.effect.historicalEvolution, value.effect.historicalEvolution);
    }
  }
});

test('新参考的最低完整性报错注明实际范围，不把跨国误标成个人', () => {
  const req = request(); req.creativeReferences = { ...DEFAULT_BUTTERFLY_REFERENCES };
  req.dice = { roll: 1, scope: '个人' };
  const value = result(); value.effect.roll = 1; value.effect.scope = '跨国';
  value.effect.historicalEvolution = '甲'.repeat(180);
  assert.throws(() => parseAndValidateButterfly(JSON.stringify(value), req), /minimum 220 for 跨国/u);
});

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

test('蝴蝶引用元数据局部损坏时丢弃坏引用并由冻结请求补回玩家行动证据', () => {
  const malformedRef = 'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97v4.';
  const withBrokenMetadata = result();
  withBrokenMetadata.sourceIds = ['chat:8', malformedRef];
  withBrokenMetadata.causalStages[0]!.sourceIds = [malformedRef];
  withBrokenMetadata.inferences[0]!.basisSourceIds = [malformedRef];

  const parsed = parseAndValidateButterfly(
    JSON.stringify(withBrokenMetadata),
    request(),
  );
  assert.deepEqual(parsed.sourceIds, ['chat:8']);
  assert.deepEqual(parsed.causalStages[0]!.sourceIds, []);
  assert.deepEqual(parsed.inferences[0]!.basisSourceIds, []);

  const actionUnsourced = result();
  actionUnsourced.sourceIds = [malformedRef];
  assert.deepEqual(
    parseAndValidateButterfly(JSON.stringify(actionUnsourced), request()).sourceIds,
    ['chat:8'],
  );
});

test('蝴蝶 Citation v2 将编码世界书句柄解析回请求中的同一原名来源', () => {
  const rawWorldbookId = 'worldbook:命定之诗与黄昏之歌v4.2:697939';
  const encodedWorldbookId = 'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97%E4%B8%8E%E9%BB%84%E6%98%8F%E4%B9%8B%E6%AD%8Cv4.2:697939';
  const input = request();
  const worldbook = {
    sourceId: rawWorldbookId,
    title: '命定之诗与黄昏之歌',
    content: '玲山的世界书史实。',
  };
  input.relevantWorldbook = [worldbook];
  input.sourceIndex = [...input.sourceIndex, worldbook];
  const withHandles = result();
  withHandles.sourceIds = ['S1'];
  withHandles.causalStages[0]!.sourceIds = ['S1'];
  withHandles.inferences[0]!.basisSourceIds = ['S1'];
  const activeEvidence = {
    citationRegistry: {
      schema: 'eyon.retrieval.task-citation-registry.v2' as const,
      passages: [],
      facts: [],
      events: [],
      sources: [
        {
          handle: 'S1' as const,
          sourceId: encodedWorldbookId,
          snapshotIds: [`${encodedWorldbookId}@sha256:fixture`],
        },
        { handle: 'S2' as const, sourceId: 'chat:8', snapshotIds: [] },
      ],
    },
    requestedEra: '复兴纪元',
    eraProfile: null,
    personTimeline: [],
    castManifest: null,
    temporalRules: [],
    territorial: [],
    passages: [],
  };

  const parsed = parseAndValidateButterfly(
    JSON.stringify(withHandles),
    input,
    activeEvidence,
  );
  assert.deepEqual(parsed.sourceIds, [rawWorldbookId, 'chat:8']);
  assert.deepEqual(parsed.causalStages[0]!.sourceIds, [rawWorldbookId]);
  assert.deepEqual(parsed.inferences[0]!.basisSourceIds, [rawWorldbookId]);
});

test('直接变化索引卡兼容旧结果并对局部坏字段 fail-open', () => {
  const legacy = parseAndValidateButterfly(JSON.stringify(result()), request());
  assert.deepEqual(legacy.directEffects, [], '旧结果缺少 directEffects 时应自动降级为空');

  const valid = {
    ...result(),
    directEffects: [{
      subject: '玲山·哈姆斯沃思',
      time: '复兴纪元480年7月16日',
      stateHint: '死亡',
      change: '玲山·哈姆斯沃思在钟楼废墟中死亡。',
      ignoredFutureField: '允许未来扩展，不应破坏旧解析器',
    }],
  };
  const parsed = parseAndValidateButterfly(JSON.stringify(valid), request());
  assert.equal(parsed.directEffects?.[0]?.subject, '玲山·哈姆斯沃思');
  assert.equal(parsed.directEffects?.[0]?.stateHint, '死亡');

  const malformed = { ...result(), directEffects: '模型偶发误写' };
  const degraded = parseAndValidateButterfly(JSON.stringify(malformed), request());
  assert.deepEqual(degraded.directEffects, [], '索引卡类型错误不得截断蝴蝶效应');

  const partial = {
    ...result(),
    directEffects: [{ subject: 7, time: null, stateHint: {}, change: '仍保留正文' }],
  };
  const filtered = parseAndValidateButterfly(JSON.stringify(partial), request());
  assert.deepEqual(filtered.directEffects, [], '缺少有效对象名的单项只应被忽略');
});

test('R-01：同一「神明纪元 + 后世帝国」夹具下，蝴蝶 prompt 含活跃时间规则且 validator 能本地检出违规', () => {
  const activeEvidence = {
    requestedEra: '神明纪元',
    eraProfile: {
      requestedEra: '神明纪元',
      exists: [],
      notYet: ['奥古斯提姆帝国'],
      extinct: [],
      eraFeatures: [],
    },
    personTimeline: [],
    castManifest: null,
    temporalRules: [{
      subject: '奥古斯提姆帝国',
      scope: 'entity' as const,
      availableFromEra: '混乱纪元',
      affectedEntityNames: ['奥古斯提姆帝国'],
      evidence: '混乱纪元：建立奥古斯提姆帝国',
    }],
    territorial: [],
    passages: [],
  };
  const prompt = buildButterflyApiPrompt({
    request: request(),
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    activeEvidence,
  });
  assert.match(prompt, /<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>/u);
  assert.match(prompt, /奥古斯提姆帝国/u);
  assert.match(prompt, /神明纪元/u);
  assert.match(prompt, /<ERA_PROFILE>/u);

  // 时代错位不再致命：结果在神明纪元引入后世帝国 → 通过（由模型按错位契约合理处理）。
  const violating = result();
  violating.effect.historicalEvolution = `名册被调换后，负责清点遗物的抄写员没有发现原件，却依据封印留下了一份摹本。数十年间，这份摹本先被地方宗族当作私产，随后在继承诉讼中进入城市法庭，奥古斯提姆帝国的使者恰好也在神明纪元末期抵达金谷城。法庭为核对土地边界建立了专门目录，促使相关档案免于第二次销毁。此后每逢领地转让，书记官都必须同时核验两份互相矛盾的版本，封印纹样逐渐成为判断真伪的法定旁证。到现世，目录制度已经扩展为公开借阅室，旧贵族对谱系证据的垄断因此松动。`;
  const validatedViolating = parseAndValidateButterfly(
    JSON.stringify(violating),
    request(),
    activeEvidence,
  );
  assert.equal(validatedViolating.causalStages.length, 2);

  // 无错位内容同样通过。
  const clean = parseAndValidateButterfly(
    JSON.stringify(result()),
    request(),
    activeEvidence,
  );
  assert.equal(clean.causalStages.length, 2);
});

test('蝴蝶效应按 validated → message_committed → committed 提交且同轮不重复', async () => {
  const repository = new MemoryButterflyRepository();
  const canon = new MemoryCanonRepository();
  const appendedPanels: Array<{ messageId: number; requestId: string; panel: string }> = [];
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
    async appendButterflyPanel(messageId, requestId, panel) {
      appendedPanels.push({ messageId, requestId, panel });
    },
  };
  const generator: GenerationAdapter = {
    async generate() {
      generatorCalls += 1;
      return JSON.stringify(result());
    },
  };
  const workflow = new ButterflyWorkflow({
    generator,
    repository,
    canonRepository: canon,
    host,
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
  assert.equal(committed.canonRevision, 1);
  assert.ok(committed.actionRef);
  assert.ok(committed.deltaRef);
  assert.deepEqual(committed.canonReceipt?.appliedDeltaIds, [committed.deltaRef]);
  const committedDelta = (await canon.getBranch(namespace)).deltas[0]!;
  assert.deepEqual(
    committedDelta.causalBasis?.map(item => item.basis),
    ['direct', 'supported'],
    'P3-A：首段是直接因果根，后续段记录为受支撑结果',
  );
  assert.equal(committedDelta.causalSupportUnits?.length, 1);
  assert.equal(
    committedDelta.causalSupportUnits?.[0]?.claimText,
    result().causalStages[0]!.linkToNext,
  );
  assert.equal(appendedPanels.length, 1, '首次提交追加一次面板');
  assert.equal(await repository.getPending(pending.key), null);
  // internal.87（§6 步 B）：镜像退役——归档不再写世界书字段。
  assert.equal(
    (await repository.getRecord(butterflyRecordKey(namespace, frozen.runId)))?.worldbookName,
    undefined,
  );

  const same = await workflow.settle(pending);
  assert.equal(same.status, 'committed');
  // internal.81 v21：同楼再次提交只触发一次面板补插尝试（宿主 v20 按文本幂等，
  // host.test 单独锁定），绝不重新生成或重新入账。
  assert.equal(appendedPanels.length, 2);
  assert.equal(generatorCalls, 1);
  assert.equal((await canon.getBranch(namespace)).headRevision, 1);

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
  assert.equal(appendedPanels.length, 3, '重掷新楼重新追加面板');
  assert.equal(generatorCalls, 1);
  const reboundBranch = await canon.getBranch(namespace);
  assert.equal(rebound.canonRevision, 2);
  assert.equal(reboundBranch.headRevision, 2);
  assert.equal(reboundBranch.revisions.find(item => item.revision === 1)?.status, 'reverted');
  assert.equal(reboundBranch.revisions.find(item => item.revision === 2)?.assistantMessageId, 12);
});

test('遣返正文前的预结算不要求尚未创建的玩家楼或 AI 楼', async () => {
  const repository = new MemoryButterflyRepository();
  const frozen = request();
  frozen.trigger = {
    ...frozen.trigger,
    userMessageId: 9,
    returnAssistantMessageId: 0,
  };
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, frozen.runId),
    namespace,
    runId: frozen.runId,
    request: frozen,
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'hash-before-return-floor',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  let fullFloorAssertions = 0;
  const workflow = new ButterflyWorkflow({
    generator: {
      async generate() { return JSON.stringify(result()); },
    },
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() { throw new Error('not used'); },
      async getButterflyFreezeSnapshot() { throw new Error('not used'); },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
      async assertButterflyTarget() {
        fullFloorAssertions += 1;
        throw new Error('return floors do not exist yet');
      },
      async appendButterflyPanel() {},
    },
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    now: () => 100,
  });

  const prepared = await workflow.prepare(pending);
  assert.equal(prepared.status, 'validated');
  assert.equal(prepared.assistantMessageId, 0);
  assert.equal(fullFloorAssertions, 0);
  assert.deepEqual(await repository.getPending(pending.key), pending);
});

test('蝴蝶效应生成失败时保留冻结快照且不触碰正文或世界书', async () => {
  const repository = new MemoryButterflyRepository();
  let panelCalls = 0;
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
  assert.deepEqual(await repository.getPending(pending.key), pending);
  assert.equal(
    await repository.getRecord(butterflyRecordKey(namespace, frozen.runId)),
    null,
  );
});

test('遣返楼重掷优先复用同一玩家楼记录，不在 idle 后重新读取活动变量', async () => {
  const repository = new MemoryButterflyRepository();
  const replayUser: RuntimeChatMessage = { message_id: 9, role: 'user', message: '遣返' };
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
  const armedRequestIds: string[] = [];
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
      getChatMessages: () => [replayUser],
      setChatMessages: async updates => { Object.assign(replayUser, updates[0]); },
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'must-not-be-used',
    roll: () => 1,
    now: () => 100,
    narrativeShell: {
      async arm(pending) { armedRequestIds.push(pending.request.requestId); },
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });
  const pending = await controller.prepareText('遣返');
  assert.equal(freezeCalls, 0);
  assert.equal(pending?.runId, frozen.runId);
  assert.equal(pending?.request.trigger.returnAssistantMessageId, 0);
  assert.deepEqual(armedRequestIds, ['request-1']);
});

test('遣返预发送先完成后台预结算，再建立可恢复玩家楼', async () => {
  const repository = new MemoryButterflyRepository();
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [{
    message_id: 8,
    role: 'assistant',
    message: '墟境中的最后一幕',
  }];
  let prepareCalls = 0;
  let armCalls = 0;
  const frozenRequest: ButterflyRequest = {
    ...request(),
    trigger: {
      type: 'text',
      userMessageId: 9,
      returnAssistantMessageId: 0,
      rawCommand: '遣返',
    },
  };
  const controller = new ButterflyController({
    assembler: {
      async freeze() {
        return {
          request: frozenRequest,
          sourceHash: 'hash-pre-send-order',
        };
      },
    } as unknown as TavernButterflyContextAssembler,
    workflow: {
      async prepare() {
        prepareCalls += 1;
        return { result: result() } as never;
      },
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => messages.at(-1)?.message_id ?? -1,
      getMessageSwipeId: () => 0,
      getChatMessages: () => messages,
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => frozenRequest.requestId,
    roll: () => frozenRequest.dice.roll,
    now: () => 100,
    narrativeShell: {
      async arm() { armCalls += 1; },
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  const pending = await controller.prepareBeforeUserTurn('遣返', 9);
  assert.equal(pending.request.trigger.userMessageId, 9);
  assert.equal(prepareCalls, 1);
  assert.equal(armCalls, 1);

  messages.push({ message_id: 9, role: 'user', message: '遣返' });
  await controller.confirmPreparedUserFloor('遣返', 9);
  assert.equal(prepareCalls, 1);
  assert.equal(armCalls, 1);
});

test('停止后同一遣返楼可立即重试，旧任务收尾不会删除新任务', async () => {
  const repository = new MemoryButterflyRepository();
  const replayUser: RuntimeChatMessage = { message_id: 9, role: 'user', message: '遣返' };
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-cancel-reroll'),
    namespace,
    runId: 'run-cancel-reroll',
    request: {
      ...request(),
      runId: 'run-cancel-reroll',
      trigger: {
        type: 'button',
        userMessageId: 9,
        returnAssistantMessageId: 0,
        rawCommand: '遣返',
      },
    },
    triggerSwipeId: 0,
    assistantSwipeId: null,
    sourceHash: 'hash-cancel-reroll',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  let prepareCalls = 0;
  let rejectFirst!: (reason: unknown) => void;
  let resolveSecond!: (value: never) => void;
  const firstTask = new Promise<never>((_resolve, reject) => {
    rejectFirst = reject;
  });
  const secondTask = new Promise<never>(resolve => {
    resolveSecond = resolve;
  });
  const controller = new ButterflyController({
    assembler: {} as TavernButterflyContextAssembler,
    workflow: {
      prepare() {
        prepareCalls += 1;
        return prepareCalls === 1 ? firstTask : secondTask;
      },
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => 0,
      getChatMessages: () => [replayUser],
      setChatMessages: async updates => { Object.assign(replayUser, updates[0]); },
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'unused',
    roll: () => 1,
    now: () => 2,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  const first = controller.prepareText('遣返');
  const firstFailure = assert.rejects(first, /cancelled/u);
  while (prepareCalls < 1) await Promise.resolve();
  controller.cancelPending();

  const second = controller.prepareText('遣返');
  while (prepareCalls < 2) await Promise.resolve();
  rejectFirst(new Error('cancelled'));
  await firstFailure;

  const third = controller.prepareText('遣返');
  await Promise.resolve();
  assert.equal(prepareCalls, 2);
  resolveSecond({ result: result() } as never);
  await Promise.all([second, third]);
  assert.equal(prepareCalls, 2);
});

test('进入新墟境会隔离晚返回的旧蝴蝶任务，不重新武装旧遣返楼', async () => {
  const repository = new MemoryButterflyRepository();
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-entry-isolation'),
    namespace,
    runId: 'run-entry-isolation',
    request: {
      ...request(),
      runId: 'run-entry-isolation',
      trigger: {
        type: 'button',
        userMessageId: 9,
        returnAssistantMessageId: 0,
        rawCommand: '遣返',
      },
    },
    triggerSwipeId: 0,
    assistantSwipeId: null,
    sourceHash: 'hash-entry-isolation',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  let resolvePrepare!: (value: never) => void;
  const prepareTask = new Promise<never>(resolve => {
    resolvePrepare = resolve;
  });
  let armCalls = 0;
  const controller = new ButterflyController({
    assembler: {} as TavernButterflyContextAssembler,
    workflow: {
      prepare: () => prepareTask,
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => 0,
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
    createRequestId: () => 'unused',
    roll: () => 1,
    now: () => 2,
    narrativeShell: {
      async arm() { armCalls += 1; },
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  const stale = controller.prepareText('遣返');
  await Promise.resolve();
  await controller.onRuinEntered();
  resolvePrepare({ result: result() } as never);
  await assert.rejects(stale, /cancelled/u);
  assert.equal(armCalls, 0);
});

test('遣返正文协作提示只约束本楼叙事且不要求模型生成蝴蝶面板', () => {
  const instruction = buildButterflyNarrativeInstruction();
  assert.match(instruction, /完成遣返叙事/u);
  assert.match(instruction, /不要生成、猜测或复写 <butterfly_panel>/u);
  assert.match(instruction, /不要延迟遣返/u);
  assert.match(instruction, /工作台.*按钮签发.*有效的工作台遣返授权/u);
  assert.match(instruction, /不再重复要求玩家打开工作台/u);
  assert.doesNotMatch(instruction, /presentLanding|historicalEvolution/u);
});

test('预结算正文先恢复现实锚点，感知窗口不是玩家传送目的地', () => {
  const instruction = buildButterflyNarrativeInstruction(result());
  assert.match(instruction, /不要按年代复述/u);
  assert.match(instruction, /先恢复冻结的现实锚点/u);
  assert.match(instruction, /不是传送目的地/u);
  assert.match(instruction, /否则保留可信的后续见闻或调查线索/u);
  assert.match(instruction, /角色只能知道其身份与经历有理由知道的碎片/u);
  assert.match(instruction, /不能让所有人突然全知/u);
});

test('遣返正文获得精确冻结时地，创作偏好进入同一次生成且篇幅只作参考', () => {
  const req = { ...request(), creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES,
    scope: '大陆' as const, domain: '风俗与日常' as const, evolution: '意外转用' as const } };
  const instruction = buildButterflyNarrativeInstruction(result(), req);
  assert.ok(instruction.includes(`本轮冻结现实时间：${req.anchors.reality.time}`));
  assert.ok(instruction.includes(`本轮冻结现实地点：${req.anchors.reality.location}`));
  assert.match(instruction, /墟境经过的时间不加到现实时间上/u);
  const prompt = buildButterflyApiPrompt({ request: req,
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' } });
  assert.match(prompt, /波及范围「大陆」.*大陆不同地域与社会/u);
  assert.match(prompt, /影响领域「风俗与日常」/u);
  assert.match(prompt, /演化方式「意外转用」/u);
  assert.match(prompt, /通常400至700字.*不因超长拒收或裁剪全文/u);
  assert.match(prompt, /两到三条不同的可能路径/u);
  assert.doesNotMatch(prompt, /【失败｜|一封信件 -> 一次判例/u);
});

test('预结算结果会进入同一遣返正文提示，但面板仍由提交阶段追加', async () => {
  const prompts: string[] = [];
  const shell = new TavernButterflyNarrativeShell({
    getCurrentCharacterName: () => namespace.characterKey,
    getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 8,
    getMessageSwipeId: () => null,
    getChatMessages: () => [],
    setChatMessages: async () => undefined,
    setExtensionPrompt: async (_key, value) => { prompts.push(value); },
    generate: async () => '',
    generateRaw: async () => '',
  });
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-prepared-narrative'),
    namespace,
    runId: 'run-prepared-narrative',
    request: request(),
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'hash-prepared-narrative',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  await shell.arm(pending, result());
  const instruction = prompts.at(-1) ?? '';
  assert.match(instruction, /金谷城档案馆新近开放的旧族谱借阅室/u);
  assert.match(instruction, /现世已经成立的历史事实/u);
  assert.match(instruction, /不要生成、猜测或复写 <butterfly_panel>/u);
});

test('遣返隐藏提示严格绑定角色、聊天、相邻楼与玩家 swipe', async () => {
  const messages = [
    { message_id: 9, role: 'user' as const, message: '遣返' },
    { message_id: 10, role: 'assistant' as const, message: '已返回现实' },
  ];
  let userSwipeId = 3;
  const prompts: Array<{ key: string; value: string }> = [];
  const shell = new TavernButterflyNarrativeShell({
    getCurrentCharacterName: () => namespace.characterKey,
    getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 10,
    getMessageSwipeId: messageId => messageId === 9 ? userSwipeId : 1,
    getChatMessages: () => messages,
    setChatMessages: async () => undefined,
    setExtensionPrompt: async (key, value) => { prompts.push({ key, value }); },
    generate: async () => '',
    generateRaw: async () => '',
  });
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-1'),
    namespace,
    runId: 'run-1',
    request: request(),
    triggerSwipeId: 3,
    assistantSwipeId: null,
    sourceHash: 'hash-shell',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  await shell.arm(pending);
  assert.match(prompts.at(-1)?.value ?? '', /不要生成、猜测或复写/u);
  await shell.assertRenderedFloor(pending, 10);
  messages[0].message = '我收好证据，然后遣返。';
  const prosePending = {
    ...pending,
    request: {
      ...pending.request,
      trigger: {
        ...pending.request.trigger,
        rawCommand: '我收好证据,然后遣返。',
      },
    },
  };
  await shell.assertRenderedFloor(prosePending, 10);
  userSwipeId = 4;
  await assert.rejects(
    () => shell.assertRenderedFloor(pending, 10),
    /不属于本次遣返请求/u,
  );
  await shell.clear(pending.request.requestId);
  assert.equal(prompts.at(-1)?.value, '');
});

test('遣返楼绑定忽略宿主插入的隐藏系统楼', async () => {
  const messages = [
    { message_id: 9, role: 'user' as const, message: '好了，遣返吧' },
    {
      message_id: 10,
      role: 'system' as const,
      message: 'MVU hidden bridge',
      is_hidden: true,
    },
    { message_id: 11, role: 'assistant' as const, message: '已经返回现实' },
  ];
  const shell = new TavernButterflyNarrativeShell({
    getCurrentCharacterName: () => namespace.characterKey,
    getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 11,
    getMessageSwipeId: () => null,
    getChatMessages: () => messages,
    setChatMessages: async () => undefined,
    setExtensionPrompt: async () => undefined,
    generate: async () => '',
    generateRaw: async () => '',
  });
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-hidden-floor'),
    namespace,
    runId: 'run-hidden-floor',
    request: {
      ...request(),
      runId: 'run-hidden-floor',
      trigger: {
        type: 'text',
        userMessageId: 9,
        returnAssistantMessageId: 0,
        rawCommand: '好了,遣返吧',
      },
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'hash-hidden-floor',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };

  await shell.assertRenderedFloor(pending, 11);
});

test('蝴蝶控制器会把隐藏系统楼后的可见 AI 楼交给结算', async () => {
  const repository = new MemoryButterflyRepository();
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, 'run-controller-hidden-floor'),
    namespace,
    runId: 'run-controller-hidden-floor',
    request: {
      ...request(),
      runId: 'run-controller-hidden-floor',
      trigger: {
        type: 'text',
        userMessageId: 9,
        returnAssistantMessageId: 0,
        rawCommand: '好了,遣返吧',
      },
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'hash-controller-hidden-floor',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  let settledAssistantMessageId = 0;
  const controller = new ButterflyController({
    assembler: {
      attachReturnFloor(frozen: ButterflyRequest, assistantMessageId: number) {
        return {
          ...frozen,
          trigger: { ...frozen.trigger, returnAssistantMessageId: assistantMessageId },
        };
      },
    } as unknown as TavernButterflyContextAssembler,
    workflow: {
      async settle(updated: PendingSettlement) {
        settledAssistantMessageId = updated.request.trigger.returnAssistantMessageId;
        return { requestId: updated.request.requestId };
      },
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 11,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 9, role: 'user', message: '好了，遣返吧' },
        {
          message_id: 10,
          role: 'system',
          message: 'MVU hidden bridge',
          is_hidden: true,
        },
        { message_id: 11, role: 'assistant', message: '已经返回现实' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'unused',
    roll: () => 1,
    now: () => 2,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  await controller.commitRendered(11);
  assert.equal(settledAssistantMessageId, 11);
});

test('普通正文里由模型仿写的蝴蝶面板会被剥离且不会触发归档', async () => {
  const repository = new MemoryButterflyRepository();
  const message = {
    message_id: 11,
    role: 'assistant' as const,
    message: '普通正文\n\n<butterfly_panel>模型仿写</butterfly_panel>\n\n<UpdateVariable>变量</UpdateVariable>',
    extra: { preserved: true },
  };
  let writes = 0;
  const controller = new ButterflyController({
    assembler: {} as TavernButterflyContextAssembler,
    workflow: {} as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 11,
      getMessageSwipeId: () => 0,
      getChatMessages: () => [message],
      setChatMessages: async changes => {
        writes += 1;
        message.message = changes[0].message ?? message.message;
        message.extra = changes[0].extra as typeof message.extra;
      },
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'unused',
    roll: () => 1,
    now: () => 2,
  });

  assert.equal(await controller.commitRendered(11), null);
  assert.equal(writes, 1);
  assert.equal(
    message.message,
    '普通正文\n\n<UpdateVariable>变量</UpdateVariable>',
  );
  assert.deepEqual(message.extra, { preserved: true });
  assert.deepEqual(await repository.list(namespace), []);
});

test('脚本授权且文本哈希匹配的正式蝴蝶面板在重复渲染时保留', async () => {
  const repository = new MemoryButterflyRepository();
  const panel = '<butterfly_panel>正式面板</butterfly_panel>';
  const message = {
    message_id: 11,
    role: 'assistant' as const,
    message: `遣返正文\n\n${panel}`,
    extra: {
      eyonButterflyRequest: {
        requestId: 'request-official',
        swipeId: 3,
        panelHash: fingerprintText(panel),
      },
    },
  };
  let writes = 0;
  let lastWrite: { message?: string; extra?: Record<string, unknown> } | undefined;
  const controller = new ButterflyController({
    assembler: {} as TavernButterflyContextAssembler,
    workflow: {} as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 11,
      getMessageSwipeId: () => 3,
      getChatMessages: () => [message],
      setChatMessages: async changes => {
        writes += 1;
        lastWrite = changes[0];
      },
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'unused',
    roll: () => 1,
    now: () => 2,
  });

  assert.equal(await controller.commitRendered(11), null);
  assert.equal(writes, 0);
  assert.match(message.message, /<butterfly_panel>正式面板<\/butterfly_panel>/u);

  message.message = '被改写的正文\n\n<butterfly_panel>模型篡改</butterfly_panel>';
  assert.equal(await controller.commitRendered(11), null);
  assert.equal(writes, 1);
  assert.equal(lastWrite?.message, '被改写的正文');
  assert.equal(lastWrite?.extra?.eyonButterflyRequest, undefined);
});

test('完整干预不裁字，提示词中重复来源原文只投递一次', async () => {
  const { TavernButterflyContextAssembler } = await import('../src/runtime/butterflyContext.ts');
  const long = '超长内容。'.repeat(3000); // 9000 字
  const assembler = new TavernButterflyContextAssembler(
    {
      getChatMessages: () => [
        { message_id: 1, role: 'user', message: long },
        { message_id: 2, role: 'assistant', message: 'AI 楼内容。'.repeat(2000) },
      ],
      getCurrentCharacterName: () => '伊雍',
      getCurrentChatId: () => 'chat',
      getLastMessageId: () => 2,
    } as never,
    {
      async getWorldbookSources() { return []; },
      async getCharacterSources() { return [{ sourceId: 'm', title: '卡', content: long }]; },
      async getGenealogySources() { return [{ sourceId: 'g', title: '谱', content: long }]; },
      async getBiographySources() { return [{ sourceId: 'b', title: '传', content: long }]; },
      async getButterflySources() { return []; },
    } as never,
    {
      async getButterflyFreezeSnapshot() {
        return {
          runId: 'r',
          reality: { time: 't', location: 'l' },
          ruinEntry: { time: 't0', location: '墟境' },
          ruinExit: { time: 't1', location: '现世' },
        };
      },
    } as never,
    {
      // 最小 active 检索成功回执：不选中任何候选，冻结仍须完成（fixed anchors 原样保留）。
      async capture() {
        return {
          status: 'success',
          recordedAt: 0,
          requestId: 'r',
          taskType: 'butterfly',
          sourceMappings: [],
          receipt: { selected: [] },
          comparison: {},
          conflictGroupIds: [],
          diagnostics: {
            candidateCount: 0,
            snapshotCacheHits: 0,
            snapshotCacheMisses: 0,
            engineReused: false,
            indexBuildMs: 0,
            retrievalMs: 0,
            totalDurationMs: 0,
          },
          bundle: { receipt: {}, passages: [], conflictGroupIds: [], sourceSnapshots: [] },
        };
      },
    } as never,
  );
  const frozen = await assembler.freeze({
    requestId: 'r', namespace: { characterKey: '伊雍', chatId: 'chat' },
    userMessageId: 2, rawCommand: '遣返', triggerType: 'text', roll: 1, sourceMessageId: 1,
  });
  const request = frozen.request as {
    playerInterventions: Array<{ content: string }>;
    relevantWorldbook: Array<{ content: string }>;
    relevantChatFacts: Array<{ content: string }>;
  };
  const sourceTexts = [
    ...request.playerInterventions.map(i => i.content),
    ...request.relevantWorldbook.map(i => i.content),
    ...request.relevantChatFacts.map(i => i.content),
  ];
  assert.ok(sourceTexts.includes(long));
  assert.ok(sourceTexts.includes('AI 楼内容。'.repeat(2000)));
  const prompt = buildButterflyApiPrompt({ request: frozen.request, rules: {
    sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '',
  } });
  assert.equal(prompt.split(long).length - 1, 1, '完整来源只投递一次而非裁剪');
  assert.match(prompt, /完整原文见 sourceIndex/u);
});

test('墟境行动记录长度走 20-400 容忍窗口，不再被 80 字隐形硬门误杀（internal.81 v16）', () => {
  const compact = result();
  compact.effect.ruinActionRecord = '行动。'.repeat(10); // 30 字：旧硬门（<80 即拒）会误杀，现在放行
  assert.doesNotThrow(() => parseAndValidateButterfly(JSON.stringify(compact), request()));

  const boundaryLow = structuredClone(compact);
  boundaryLow.effect.ruinActionRecord = '行'.repeat(20); // 等于下限，放行
  assert.doesNotThrow(() => parseAndValidateButterfly(JSON.stringify(boundaryLow), request()));

  const boundaryHigh = structuredClone(compact);
  boundaryHigh.effect.ruinActionRecord = '行'.repeat(400); // 等于上限，放行
  assert.doesNotThrow(() => parseAndValidateButterfly(JSON.stringify(boundaryHigh), request()));

  const below = structuredClone(compact);
  below.effect.ruinActionRecord = '行'.repeat(19); // 低于防呆下限，拒绝且报错带实际长度
  assert.throws(
    () => parseAndValidateButterfly(JSON.stringify(below), request()),
    /Ruin action record length 19 is outside the accepted 20-400 range/u,
  );

  const above = structuredClone(compact);
  above.effect.ruinActionRecord = '行'.repeat(401); // 高于防失控上限，拒绝
  assert.throws(
    () => parseAndValidateButterfly(JSON.stringify(above), request()),
    /accepted 20-400 range \(target 80-180\)/u,
  );
});

test('蝴蝶 prompt 明示行动记录长度目标与拦截线（internal.81 v16）', () => {
  const prompt = buildButterflyApiPrompt({
    request: request(),
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
  });
  assert.match(prompt, /ruinActionRecord 只总结玩家实际完成的关键干涉/u);
  assert.match(prompt, /目标 80-180 个中文字符/u);
  assert.match(prompt, /低于 20 或高于 400 时拦截自然波动/u);
});

test('旧内容上限冻结快照在复用前被体检丢弃并重新冻结（internal.81 v16）', async () => {
  const repository = new MemoryButterflyRepository();
  let freezeCalls = 0;
  const legacyRunId = 'run-legacy';
  const longSource = { sourceId: 'chat:8', title: 'user floor 8', content: '长'.repeat(3000) };
  const legacyPending: PendingSettlement = {
    key: pendingSettlementKey(namespace, legacyRunId),
    namespace,
    runId: legacyRunId,
    request: {
      ...request(),
      runId: legacyRunId,
      playerInterventions: [longSource],
      relevantChatFacts: [longSource],
      sourceIndex: [longSource],
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'legacy',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  await repository.savePending(legacyPending);

  const assembler = {
    async freeze() {
      freezeCalls += 1;
      return {
        request: { ...request(), requestId: 'fresh', runId: 'run-fresh' },
        sourceHash: 'fresh',
      };
    },
  } as unknown as TavernButterflyContextAssembler;
  const workflow = {
    async prepare() {
      return { status: 'validated' };
    },
  } as unknown as ButterflyWorkflow;
  const controller = new ButterflyController({
    assembler,
    workflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 8, role: 'assistant', message: '我们从墟境回到了现世。' },
        { message_id: 9, role: 'user', message: '遣返' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'fresh',
    roll: () => 68,
    now: () => 3,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  assert.equal(await controller.prepareText('遣返'), null, '损坏冻结不再由正文重建');
  const pending = await controller.prepareBeforeUserTurn('遣返',9);
  assert.ok(pending, '工作台按钮应返回新冻结的待结算快照');
  assert.equal(freezeCalls, 1, '旧上限快照应被体检丢弃，走一次全新冻结');
  assert.equal(
    await repository.getPending(pendingSettlementKey(namespace, legacyRunId)),
    null,
    '旧上限 pending 应已被删除',
  );
  const freshKey = pendingSettlementKey(namespace, 'run-fresh');
  const fresh = await repository.getPending(freshKey);
  assert.ok(fresh, '新冻结快照应已保存');
  assert.equal(fresh!.request.requestId, 'fresh');
  assert.equal(pending!.key, freshKey);
});

test('已消费 Canon 却缺失绑定视图的 pending 会重新冻结，不再重复产生 binding-missing', async () => {
  const repository = new MemoryButterflyRepository();
  let freezeCalls = 0;
  const brokenRunId = 'run-missing-binding-view';
  const brokenPending: PendingSettlement = {
    key: pendingSettlementKey(namespace, brokenRunId),
    namespace,
    runId: brokenRunId,
    request: { ...request(), runId: brokenRunId },
    activeEvidence: {
      canonResolvedView: {
        viewId: 'canon-view:old',
        branchId: 'canon:old',
        resolvedRevision: 0,
        queryScopeHash: 'scope-old',
        activeRevisionFacts: [],
        uncertainItems: [],
      },
      requestedEra: '复兴纪元',
      eraProfile: null,
      personTimeline: [],
      castManifest: null,
      temporalRules: [],
      territorial: [],
      passages: [],
    },
    // 故意缺少 canonBindingView：这是曾在真机中留下 binding-missing 的坏快照形态。
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'broken-binding',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  await repository.savePending(brokenPending);

  const assembler = {
    async freeze() {
      freezeCalls += 1;
      return {
        request: { ...request(), requestId: 'fresh-binding', runId: 'run-fresh-binding' },
        sourceHash: 'fresh-binding',
      };
    },
  } as unknown as TavernButterflyContextAssembler;
  const workflow = {
    async prepare() { return { status: 'validated' }; },
  } as unknown as ButterflyWorkflow;
  const controller = new ButterflyController({
    assembler,
    workflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 8, role: 'assistant', message: '我们从墟境回到了现世。' },
        { message_id: 9, role: 'user', message: '遣返' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'fresh-binding',
    roll: () => 68,
    now: () => 3,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  assert.equal(await controller.prepareText('遣返'), null);
  const pending = await controller.prepareBeforeUserTurn('遣返',9);
  assert.ok(pending);
  assert.equal(freezeCalls, 1);
  assert.equal(await repository.getPending(brokenPending.key), null);
  assert.equal(pending!.runId, 'run-fresh-binding');
});

test('提交只认文本一致的当前轮 pending：旧轮同玩家楼记录不再劫持（internal.81 v18）', async () => {
  const repository = new MemoryButterflyRepository();
  const settledKeys: string[] = [];
  const oldRunId = 'run-old';
  const currentRunId = 'run-current';
  const oldPending: PendingSettlement = {
    key: pendingSettlementKey(namespace, oldRunId),
    namespace,
    runId: oldRunId,
    request: {
      ...request(),
      runId: oldRunId,
      trigger: { ...request().trigger, userMessageId: 51, rawCommand: '遣返' },
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'old',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const currentPending: PendingSettlement = {
    key: pendingSettlementKey(namespace, currentRunId),
    namespace,
    runId: currentRunId,
    request: {
      ...request(),
      runId: currentRunId,
      trigger: { ...request().trigger, userMessageId: 51, rawCommand: '好了，伊雍，遣返吧' },
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'current',
    revision: 1,
    createdAt: 2,
    updatedAt: 2,
  };
  await repository.savePending(oldPending);
  await repository.savePending(currentPending);

  const assembler = {
    attachReturnFloor(frozen: PendingSettlement['request'], assistantMessageId: number) {
      return {
        ...frozen,
        trigger: { ...frozen.trigger, returnAssistantMessageId: assistantMessageId },
      };
    },
  } as unknown as TavernButterflyContextAssembler;
  const workflow = {
    async settle(updated: PendingSettlement) {
      settledKeys.push(updated.key);
      await repository.deletePending(updated.key);
      return { status: 'committed', key: updated.key };
    },
  } as unknown as ButterflyWorkflow;
  const controller = new ButterflyController({
    assembler,
    workflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 53,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 51, role: 'user', message: '好了，伊雍，遣返吧' },
        { message_id: 52, role: 'system', message: 'MVU hidden bridge', is_hidden: true },
        { message_id: 53, role: 'assistant', message: '我们回到了现实。' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'r',
    roll: () => 1,
    now: () => 3,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  const record = await controller.commitRendered(53);
  assert.ok(record, '渲染事件应命中当前轮 pending 并完成提交');
  assert.deepEqual(settledKeys, [currentPending.key], '只应提交文本一致的当前轮 pending');
  assert.equal(
    await repository.getPending(currentPending.key),
    null,
    '提交成功后当前轮 pending 应被 settle 流程清理',
  );
  const untouched = await repository.getPending(oldPending.key);
  assert.ok(untouched, '旧轮 pending 不应被触碰或删除');
  assert.equal(untouched!.failure, undefined, '旧轮 pending 不应再被误标失败');
});

test('真正开始新冻结时会清掉同聊天的其他轮次残留 pending（internal.81 v18）', async () => {
  const repository = new MemoryButterflyRepository();
  const staleRunId = 'run-stale-6000-era';
  const stalePending: PendingSettlement = {
    key: pendingSettlementKey(namespace, staleRunId),
    namespace,
    runId: staleRunId,
    request: {
      ...request(),
      runId: staleRunId,
      trigger: { ...request().trigger, userMessageId: 45, rawCommand: '遣返' },
    },
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'stale',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  await repository.savePending(stalePending);

  const assembler = {
    async freeze() {
      return {
        request: { ...request(), requestId: 'fresh-run', runId: 'run-fresh' },
        sourceHash: 'fresh',
      };
    },
  } as unknown as TavernButterflyContextAssembler;
  const workflow = {
    async prepare() {
      return { status: 'validated' };
    },
  } as unknown as ButterflyWorkflow;
  const controller = new ButterflyController({
    assembler,
    workflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 8, role: 'assistant', message: '我们在墟境中。' },
        { message_id: 9, role: 'user', message: '好了，伊雍，遣返吧' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'fresh-run',
    roll: () => 1,
    now: () => 4,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  assert.equal(await controller.prepareText('好了，伊雍，遣返吧'), null);
  const pending = await controller.prepareBeforeUserTurn('好了，伊雍，遣返吧',9);
  assert.ok(pending, '新冻结应成功');
  const freshKey = pendingSettlementKey(namespace, 'run-fresh');
  assert.ok(await repository.getPending(freshKey), '新轮 pending 应已保存');
  assert.equal(
    await repository.getPending(pendingSettlementKey(namespace, staleRunId)),
    null,
    '其他轮次的残留 pending 应被清理',
  );
  const remaining = await repository.listPending(namespace);
  assert.deepEqual(remaining.map(item => item.key), [freshKey]);
});

test('重新归档成功与失败都会点亮宿主状态（internal.81 v19）', async () => {
  const repository = new MemoryButterflyRepository();
  const runId = 'run-retry-feedback';
  const pendingRecord: PendingSettlement = {
    key: pendingSettlementKey(namespace, runId),
    namespace,
    runId,
    request: request(),
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'hash',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
  };
  await repository.savePending(pendingRecord);
  const statuses: Array<{ status: string; detail?: string }> = [];
  const controller = new ButterflyController({
    assembler: {} as never,
    workflow: {
      async settle() {
        throw new Error('世界书镜像写入失败');
      },
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'r',
    roll: () => 1,
    now: () => 5,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
    hooks: {
      onStatus: (status, detail) => {
        statuses.push({ status, detail });
      },
    },
  });

  await assert.rejects(
    () => controller.retry(runId),
    /世界书镜像写入失败/u,
  );
  const failed = await repository.getPending(pendingRecord.key);
  assert.ok(failed?.failure, '失败原因应写回待结算快照');
  assert.match(failed!.failure!.message, /世界书镜像写入失败/u);
  assert.ok(
    statuses.some(item => item.status === 'butterfly_pending' && item.detail?.includes('世界书镜像写入失败')),
    '失败应点亮 butterfly_pending 且带原因',
  );

  const okWorkflow = {
    async settle() {
      return { status: 'committed', key: pendingRecord.key };
    },
  } as unknown as ButterflyWorkflow;
  const controller2 = new ButterflyController({
    assembler: {} as never,
    workflow: okWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'r',
    roll: () => 1,
    now: () => 5,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
    hooks: {
      onStatus: (status, detail) => {
        statuses.push({ status, detail });
      },
    },
  });
  const record = await controller2.retry(runId);
  assert.equal(record.status, 'committed');
  assert.ok(
    statuses.some(item => item.status === 'butterfly_ready'),
    '成功应点亮 butterfly_ready',
  );
});

test('删楼回滚（reverted）的同轮记录不再被复用，prepare 重新生成并覆盖（internal.81 v21）', async () => {
  const repository = new MemoryButterflyRepository();
  let generatorCalls = 0;
  const host: ButterflyHostAdapter = {
    async getNamespace() { return namespace; },
    async getRuinRuntimeSnapshot() {
      return {
        flowState: 'idle', runId: '', realityTime: '', realityLocation: '',
        ruinTime: '', ruinLocation: '',
      };
    },
    async getButterflyFreezeSnapshot() { throw new Error('not used'); },
    async getLatestUserText() { return '遣返'; },
    async replaceAssistantSlot() {},
    async assertButterflyTarget() {},
    async appendButterflyPanel() {},
  };
  const generator: GenerationAdapter = {
    async generate() {
      generatorCalls += 1;
      return JSON.stringify(result());
    },
  };
  const workflow = new ButterflyWorkflow({
    generator,
    repository,
    canonRepository: new MemoryCanonRepository(),
    host,
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    now: () => 200,
  });

  const runId = request().runId;
  const stale: ButterflyRecord = {
    key: butterflyRecordKey(namespace, runId),
    namespace,
    runId,
    requestId: 'request-old',
    request: request(),
    result: result(),
    sourceHash: 'old-hash',
    panel: '<butterfly_panel>旧版</butterfly_panel>',
    archiveEntry: '### 《蝴蝶效应锚定日志1》',
    assistantMessageId: 10,
    status: 'committed',
    canonStatus: 'reverted',
    deltaRef: 'delta:old',
    canonRevision: 1,
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
  };
  await repository.saveRecord(stale);

  const freshPending: PendingSettlement = {
    key: pendingSettlementKey(namespace, runId),
    namespace,
    runId,
    request: request(),
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'new-hash',
    revision: 1,
    createdAt: 3,
    updatedAt: 3,
  };

  const prepared = await workflow.prepare(freshPending);
  assert.equal(generatorCalls, 1, 'reverted 记录不得复用，必须重新生成');
  assert.equal(prepared.status, 'validated');
  const stored = await repository.getRecord(butterflyRecordKey(namespace, runId));
  assert.equal(stored?.requestId, 'request-1', '新版应覆盖旧记录（request-old → request-1）');
  assert.equal(stored?.canonRevision, undefined, '覆盖记录重置 Canon 提交态');
  assert.equal(stored?.canonStatus, undefined, '失效标记随覆盖清除');
});

test('G-12 端到端：清扫路径回滚 → 对账标记 reverted → prepare 必须重新生成（internal.87）', async () => {
  const repository = new MemoryButterflyRepository();
  const canon = new MemoryCanonRepository();
  let generatorCalls = 0;
  const host: ButterflyHostAdapter = {
    async getNamespace() { return namespace; },
    async getRuinRuntimeSnapshot() {
      return {
        flowState: 'idle', runId: '', realityTime: '', realityLocation: '',
        ruinTime: '', ruinLocation: '',
      };
    },
    async getButterflyFreezeSnapshot() { throw new Error('not used'); },
    async getLatestUserText() { return '遣返'; },
    async replaceAssistantSlot() {},
    async assertButterflyTarget() {},
    async appendButterflyPanel() {},
  };
  const generator: GenerationAdapter = {
    async generate() {
      generatorCalls += 1;
      return JSON.stringify(result());
    },
  };
  const workflow = new ButterflyWorkflow({
    generator,
    repository,
    canonRepository: canon,
    host,
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: 'generation',
    },
    now: () => 300,
  });

  // 真机同款第一步：正常结算一轮（同时落档案与 Canon revision）。
  const frozen = request();
  const pending: PendingSettlement = {
    key: pendingSettlementKey(namespace, frozen.runId),
    namespace,
    runId: frozen.runId,
    request: frozen,
    triggerSwipeId: null,
    assistantSwipeId: null,
    sourceHash: 'g12-hash',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  await repository.savePending(pending);
  const settled = await workflow.settle(pending);
  assert.equal(settled.status, 'committed');
  assert.equal(generatorCalls, 1);
  assert.equal((await canon.getBranch(namespace)).headRevision, 1);

  // 真机同款第二步：宿主批量删楼（F-03 病历：只有部分消息派发 messageDeleted，
  // 绑定的 revision 由孤儿清扫回滚——清扫不标记记录，这正是 G-12 的漏洞现场）。
  const sweep = await reconcileCanonOrphans(canon, namespace, async () => false, 500);
  assert.ok(sweep.receipts.length >= 1, '清扫应回滚绑定楼已消失的 active revision');
  const midRecord = await repository.getRecord(butterflyRecordKey(namespace, frozen.runId));
  assert.equal(
    midRecord?.canonStatus,
    'active',
    '前置：清扫本身只回滚 canon，不标记记录（漏洞现场）',
  );

  // internal.87 修复：按当前分支状态对账。
  const synced = await syncButterflyCanonStatuses({
    repository,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 600,
  });
  assert.equal(synced.synced, 1);
  assert.equal(
    (await repository.getRecord(butterflyRecordKey(namespace, frozen.runId)))?.canonStatus,
    'reverted',
    '对账后记录必须标成 reverted（v21 闸的输入）',
  );

  // 闸放行：同一轮再次请求（重roll / 重发遣返）不得复用旧文本。
  const again = await workflow.prepare({ ...pending, revision: 2, updatedAt: 700 });
  assert.equal(generatorCalls, 2, '清扫路径回滚后必须重新生成，而不是复用旧文本');
  assert.equal(again.status, 'validated');
});

test('已归档且被回滚（reverted）的记录在重发遣返时走全新冻结，不重建复用（internal.81 v21）', async () => {
  const repository = new MemoryButterflyRepository();
  let freezeCalls = 0;
  let workflowPrepareCalls = 0;
  const runId = request().runId;
  const stale: ButterflyRecord = {
    key: butterflyRecordKey(namespace, runId),
    namespace,
    runId,
    requestId: 'request-old',
    request: request(),
    result: result(),
    sourceHash: 'old-hash',
    panel: '<butterfly_panel>旧版</butterfly_panel>',
    archiveEntry: '### 《蝴蝶效应锚定日志1》',
    assistantMessageId: 10,
    status: 'committed',
    canonStatus: 'reverted',
    deltaRef: 'delta:old',
    canonRevision: 1,
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
  };
  await repository.saveRecord(stale);

  const controller = new ButterflyController({
    assembler: {
      async freeze() {
        freezeCalls += 1;
        return {
          request: { ...request(), requestId: 'request-fresh', runId },
          sourceHash: 'fresh-hash',
        };
      },
    } as unknown as TavernButterflyContextAssembler,
    workflow: {
      async prepare() {
        workflowPrepareCalls += 1;
        return { status: 'validated' };
      },
    } as unknown as ButterflyWorkflow,
    repository,
    runtime: {
      getCurrentCharacterName: () => namespace.characterKey,
      getCurrentChatId: () => namespace.chatId,
      getLastMessageId: () => 9,
      getMessageSwipeId: () => null,
      getChatMessages: () => [
        { message_id: 8, role: 'assistant', message: '我们在墟境中。' },
        { message_id: 9, role: 'user', message: '遣返' },
      ],
      setChatMessages: async () => undefined,
      setExtensionPrompt: async () => undefined,
      generate: async () => '',
      generateRaw: async () => '',
    },
    createRequestId: () => 'request-fresh',
    roll: () => 68,
    now: () => 300,
    narrativeShell: {
      async arm() {},
      async clear() {},
      async clearActive() {},
      async assertRenderedFloor() {},
    },
  });

  assert.equal(await controller.prepareText('遣返'), null);
  const pending = await controller.prepareBeforeUserTurn('遣返',9);
  assert.ok(pending, '工作台重新发起应产生新的待结算');
  assert.equal(freezeCalls, 1, 'reverted 记录不得重建复用，应走全新冻结');
  assert.equal(workflowPrepareCalls, 1, '应重新走生成准备而不是复用旧文本');
  assert.equal(pending!.request.requestId, 'request-fresh');
});

// internal.82（F-01）：结算提交前把命中稳定实体的模型 carrier 归并进 canon 实体空间。
function linkingSettleHarness(overrides: {
  carriers: Array<{ carrier: string; time: string; change: string }>;
  directEffects?: ButterflyResult['directEffects'];
  linkingIndex?: PendingSettlement['linkingIndex'];
  activeEvidence?: PendingSettlement['activeEvidence'];
  canon?: MemoryCanonRepository;
  historicalEvolution?: string;
}) {
  const repository = new MemoryButterflyRepository();
  const canon = overrides.canon ?? new MemoryCanonRepository();
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
    async appendButterflyPanel() {},
  };
  const generator: GenerationAdapter = {
    async generate() {
      return JSON.stringify({
        ...result(),
        ...(overrides.historicalEvolution ? { effect: { ...result().effect, historicalEvolution: overrides.historicalEvolution } } : {}),
        ...(overrides.directEffects ? { directEffects: overrides.directEffects } : {}),
        causalStages: overrides.carriers.map((stage, index) => ({
          order: index + 1,
          time: stage.time,
          carrier: stage.carrier,
          change: stage.change,
          linkToNext: '延续',
          sourceIds: ['chat:8'],
        })),
      });
    },
  };
  const workflow = new ButterflyWorkflow({
    generator,
    repository,
    canonRepository: canon,
    host,
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
    sourceHash: 'hash-f01',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(overrides.linkingIndex ? { linkingIndex: overrides.linkingIndex } : {}),
    ...(overrides.activeEvidence ? { activeEvidence: overrides.activeEvidence } : {}),
  };
  return { repository, canon, workflow, pending };
}

test('超旧上限的历史演变能完成真实工作流归档，面板与存储保留全文末尾', async () => {
  const prose = result().effect.historicalEvolution.repeat(4) + '\n\n这就是完整史稿的最后一句。';
  const h = linkingSettleHarness({ historicalEvolution: prose, carriers: [
    { carrier: '旧堡', time: '复兴纪元184年', change: '保存名册' },
    { carrier: '档案馆', time: '复兴纪元488年', change: '开放借阅' },
  ] });
  const committed = await h.workflow.settle(h.pending);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.result.effect.historicalEvolution, prose);
  assert.ok(committed.archiveEntry.includes(prose));
  assert.ok(committed.panel.includes(prose.replace(/玩家/gu, '<user>')), '面板只沿用既有称谓替换，不截正文');
  assert.equal((await h.repository.getRecord(committed.key))?.result.effect.historicalEvolution, prose);
});

test('G-01B：同一结算的三次状态转变分开提交，后续状态留有因果支持', async () => {
  const harness = linkingSettleHarness({
    carriers: [{ carrier: '旧堡', time: '复兴纪元450年', change: '旧堡保留记录' }, { carrier: '账簿', time: '复兴纪元488年', change: '记录流传' }],
    directEffects: ['监禁', '越狱', '赦免'].map((value, index) => ({ subject: '尤娜', time: `复兴纪元${450 + index}年3月1日`, stateHint: value, change: `尤娜${value}`,
      continuousState: { dimension: '拘束', value, start: `复兴纪元${450 + index}年3月1日` } })),
    linkingIndex: [{ entityId: 'entity:yuna', names: ['尤娜'] }],
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef)!;
  const states = delta.operations.filter(op => op.current.continuousState);
  assert.equal(states.length, 3); assert.ok(states.every(op => op.op === 'assert'));
  assert.equal(new Set(states.map(op => op.factKey)).size, 3);
  assert.equal(delta.causalBasis?.filter(basis => basis.basis === 'supported').length, 3);
  const view = resolveCanon({ ...branch, baseCanon: { facts: [], personViews: [], sourceSnapshots: [], passages: [], eventRelations: [] } }, branch.headRevision,
    { subjectEntityIds: ['entity:yuna'], temporalScopes: ['复兴纪元453年'], spatialScopes: [], sourceIds: ['chat:8'] });
  assert.equal(continuousStateAt(view.continuousStates!, 'entity:yuna', '拘束', '复兴纪元453年3月1日').value, '赦免');
});

test('结算提交把命中稳定实体的载体归并进 canon（internal.82 F-01）', async () => {
  const harness = linkingSettleHarness({
    carriers: [
      { carrier: '尤娜', time: '复兴纪元321年', change: '在海因里希的扼杀下死亡，捕光琉璃工艺传承断绝' },
      { carrier: '黄昏花室的铅云穹顶', time: '复兴纪元321年之后', change: '成为阴冷压抑的场所' },
    ],
    linkingIndex: [{
      entityId: 'entity:worldbook:test:yuna',
      names: ['尤娜', '尤娜·夜莺'],
    }],
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  assert.equal(committed.status, 'committed');
  assert.equal(committed.canonRevision, 1);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef);
  assert.ok(delta, 'canon delta 应已落库');
  const [first, second] = delta!.operations;
  // 命中稳定实体：factKey 进入 catalog 实体空间（不再是 entity:generated）。
  assert.match(first!.factKey, /^entity:worldbook:test:yuna\|/u,
    '命中稳定实体的阶段应归并到 catalog 实体 id');
  assert.equal(first!.current.subjectEntityId, 'entity:worldbook:test:yuna');
  // 未命中（复合描述、无唯一候选）：维持 entity:generated 兜底，不硬猜。
  assert.match(second!.factKey, /^entity:generated:/u,
    '未命中实体维持 generated 兜底');
  // cascadeScope 与归并后的 operations 同源：投影闸输入即为稳定实体。
  assert.ok(delta!.cascadeScope.entityIds.includes('entity:worldbook:test:yuna'),
    'cascadeScope 应携带归并后的稳定实体 id');
  // F-02：时间区间与载体名随结算写入（generated 叙事实体的时空投递通道）。
  assert.ok(delta!.cascadeScope.time?.start?.label, 'cascadeScope 应携带起始时间');
  assert.ok(delta!.cascadeScope.time?.end?.label, 'cascadeScope 应携带结束时间');
  assert.ok(
    (delta!.cascadeScope.subjectNames ?? []).includes('尤娜'),
    'cascadeScope.subjectNames 应包含命中实体的载体名',
  );
  assert.ok(
    (delta!.cascadeScope.subjectNames ?? []).includes('黄昏花室的铅云穹顶'),
    'cascadeScope.subjectNames 应包含未命中实体的载体名（供地点/名称投递）',
  );
});

test('旧 pending 无映射索引时行为不变：全部 entity:generated 兜底（internal.82 兼容）', async () => {
  const harness = linkingSettleHarness({
    carriers: [
      { carrier: '尤娜', time: '复兴纪元321年', change: '在海因里希的扼杀下死亡' },
      { carrier: '旧堡抄写员', time: '复兴纪元184年', change: '依据封印制作名册摹本' },
    ],
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  assert.equal(committed.status, 'committed');
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef);
  for (const operation of delta!.operations) {
    assert.match(operation.factKey, /^entity:generated:/u,
      '无 linkingIndex 时全部维持 generated 兜底（与 internal.81 行为一致）');
  }
});

test('直接变化先写入稳定人物状态，因果传播阶段仍完整保留', async () => {
  const harness = linkingSettleHarness({
    directEffects: [{
      subject: '玲山·哈姆斯沃思',
      time: '复兴纪元480年7月16日',
      stateHint: '死亡',
      change: '玲山·哈姆斯沃思因脑髓贯穿与心脉断绝而死亡。',
    }],
    carriers: [
      { carrier: '圣翼骑士团刺客', time: '复兴纪元480年', change: '走私铁证随刺杀一并消失' },
      { carrier: '皇室档案库', time: '复兴纪元488年', change: '档案只保留死亡报告' },
    ],
    linkingIndex: [{
      entityId: 'entity:worldbook:test:lingshan',
      names: ['玲山·哈姆斯沃思', '玲山'],
    }],
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef);
  assert.ok(delta);
  assert.equal(delta!.operations.length, 3, '一条直接状态与两条传播阶段都应保留');
  const direct = delta!.operations[0]!;
  assert.equal(direct.current.subjectEntityId, 'entity:worldbook:test:lingshan');
  assert.equal(direct.current.predicate, 'death_time');
  assert.equal(direct.current.object, '复兴纪元480年7月16日');
  assert.equal(direct.op, 'assert');
  assert.equal(delta!.operations[1]!.current.predicate, 'historical_change');
  assert.ok((delta!.cascadeScope.subjectNames ?? []).includes('玲山·哈姆斯沃思'));
});

test('明确改变人物出生、建筑建成或机构成立时间时写入可替换时间原点', async () => {
  const harness = linkingSettleHarness({
    directEffects: [
      {
        subject: '玲山·哈姆斯沃思',
        time: '复兴纪元463年',
        stateHint: '出生日期被改变',
        change: '玲山因历史干涉改在复兴纪元463年出生。',
      },
      {
        subject: '黄昏花室',
        time: '复兴纪元322年',
        stateHint: '建筑落成时间改变',
        change: '黄昏花室改在复兴纪元322年落成。',
      },
      {
        subject: '琉璃塔信报社',
        time: '复兴纪元487年',
        stateHint: '机构成立时间改变',
        change: '琉璃塔信报社改在复兴纪元487年成立。',
      },
    ],
    carriers: [
      { carrier: '帝国历法档案', time: '复兴纪元487年', change: '登记三个新时间原点' },
      { carrier: '皇室档案库', time: '复兴纪元488年', change: '沿用修订后的时间记录' },
    ],
    linkingIndex: [
      { entityId: 'entity:lingshan', names: ['玲山·哈姆斯沃思'] },
      { entityId: 'entity:flower-room', names: ['黄昏花室'] },
      { entityId: 'entity:glass-tower', names: ['琉璃塔信报社'] },
    ],
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const operations = branch.deltas.find(item => item.deltaId === committed.deltaRef)!.operations;
  const birth = operations.find(item => item.current.predicate === 'birth_time')!;
  const created = operations.find(item => item.current.predicate === 'created_time')!;
  const established = operations.find(item => item.current.predicate === 'established_time')!;
  assert.equal(birth.current.object, '复兴纪元463年');
  assert.equal(created.current.object, '复兴纪元322年');
  assert.equal(established.current.object, '复兴纪元487年');
  assert.equal(created.factKey, 'entity:flower-room|created_time|world');
  assert.equal(established.factKey, 'entity:glass-tower|established_time|world');
});

test('已存在的人物状态由直接变化替换；陌生提示只降级为通用历史变化', async () => {
  const activeEvidence: NonNullable<PendingSettlement['activeEvidence']> = {
    requestedEra: '复兴纪元',
    eraProfile: null,
    personTimeline: [],
    personCanonViews: [{
      schema: 'eyon.retrieval.person-canon-view.v1',
      entityId: 'entity:worldbook:test:lingshan',
      canonicalName: '玲山·哈姆斯沃思',
      aliases: ['玲山'],
      requiredFactIds: ['fact:baseline:lingshan:death'],
      relevantFactIds: ['fact:baseline:lingshan:death'],
      facts: [{
        factId: 'fact:baseline:lingshan:death',
        subjectEntityId: 'entity:worldbook:test:lingshan',
        predicate: 'death_time',
        object: '复兴纪元520年',
        statement: '玲山原本在复兴纪元520年去世。',
        temporalScope: '复兴纪元520年',
        spatialScope: null,
        epistemicStatus: 'explicit',
        confidence: 'high',
        sourceRefs: ['chat:8'],
        sourceSnapshotIds: [],
        sourceSpans: [],
        revisionIntroduced: 0,
        revisionRetired: null,
      }],
      sourceSnapshotIds: [],
    }],
    castManifest: null,
    temporalRules: [],
    territorial: [],
    passages: [],
  };
  const harness = linkingSettleHarness({
    directEffects: [
      {
        subject: '玲山·哈姆斯沃思',
        time: '复兴纪元480年7月16日',
        stateHint: '死亡',
        change: '玲山在钟楼废墟中提前死亡。',
      },
      {
        subject: '玲山·哈姆斯沃思',
        time: '复兴纪元480年7月16日',
        stateHint: '无法归类的新状态',
        change: '玲山留下的私人暗号从此无人能够解读。',
      },
    ],
    carriers: [
      { carrier: '拾荒者', time: '复兴纪元481年', change: '捡到带血压制环' },
      { carrier: '皇室档案库', time: '复兴纪元488年', change: '收录压制环' },
    ],
    linkingIndex: [{
      entityId: 'entity:worldbook:test:lingshan',
      names: ['玲山·哈姆斯沃思', '玲山'],
    }],
    activeEvidence,
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef)!;
  const death = delta.operations.find(operation => operation.current.predicate === 'death_time')!;
  assert.equal(death.op, 'replace');
  assert.deepEqual(death.originalFactIds, ['fact:baseline:lingshan:death']);
  assert.ok(delta.preconditionFactIds.includes('fact:baseline:lingshan:death'));
  const fallback = delta.operations.find(operation =>
    operation.current.statement.includes('私人暗号'))!;
  assert.equal(fallback.current.predicate, 'historical_change');
  assert.equal(fallback.op, 'assert');
});

test('物品直接变化进入可替换 object_status，同一原件后续修复会承接旧状态', async () => {
  const artifactEntityId = 'entity:worldbook:test:camera';
  const previousFactId = 'fact:intervention:camera:destroyed';
  const activeEvidence: NonNullable<PendingSettlement['activeEvidence']> = {
    requestedEra: '复兴纪元',
    eraProfile: null,
    personTimeline: [],
    personCanonViews: [],
    activeCanonStateFacts: [{
      factId: previousFactId,
      subjectEntityId: artifactEntityId,
      predicate: 'object_status',
    }],
    castManifest: null,
    temporalRules: [],
    territorial: [],
    passages: [],
  };
  const harness = linkingSettleHarness({
    directEffects: [{
      subject: '玲山的旧式留影相机',
      time: '复兴纪元482年',
      stateHint: '物品状态（原件修复）',
      change: '玲山的旧式留影相机在复兴纪元482年由钟表匠修复。',
    }],
    carriers: [
      { carrier: '钟表匠', time: '复兴纪元482年', change: '为相机更换破裂镜片' },
      { carrier: '玲山', time: '复兴纪元483年', change: '再次用相机记录帝都' },
    ],
    linkingIndex: [{
      entityId: artifactEntityId,
      names: ['玲山的旧式留影相机', '旧式留影相机'],
    }],
    activeEvidence,
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef)!;
  const artifactState = delta.operations.find(operation =>
    operation.current.predicate === 'object_status')!;
  assert.equal(artifactState.op, 'replace');
  assert.equal(artifactState.current.subjectEntityId, artifactEntityId);
  assert.deepEqual(artifactState.originalFactIds, [previousFactId]);
});

test('catalog 未命中时，同状态的 active generated 简称可由全名唯一承接为 replace', async () => {
  const previousEntityId = 'entity:generated:%E7%8E%B2%E5%B1%B1';
  const previousFactId = 'fact:intervention:run-r2:direct:1';
  const activeEvidence: NonNullable<PendingSettlement['activeEvidence']> = {
    requestedEra: '复兴纪元',
    eraProfile: null,
    personTimeline: [],
    personCanonViews: [],
    activeCanonStateFacts: [{
      factId: previousFactId,
      subjectEntityId: previousEntityId,
      predicate: 'custody_status',
    }],
    castManifest: null,
    temporalRules: [],
    territorial: [],
    passages: [],
  };
  const harness = linkingSettleHarness({
    directEffects: [{
      subject: '玲山·哈姆斯沃思',
      time: '复兴纪元481年',
      stateHint: '越狱后自由',
      change: '玲山·哈姆斯沃思越狱后恢复自由。',
    }],
    carriers: [
      { carrier: '边境执政官', time: '复兴纪元481年', change: '追捕命令改写' },
      { carrier: '琉璃塔筹备处', time: '复兴纪元483年', change: '重新接纳她的手稿' },
    ],
    activeEvidence,
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const branch = await harness.canon.getBranch(namespace);
  const delta = branch.deltas.find(item => item.deltaId === committed.deltaRef)!;
  const custody = delta.operations.find(operation =>
    operation.current.predicate === 'custody_status')!;
  assert.equal(custody.op, 'replace');
  assert.equal(custody.current.subjectEntityId, previousEntityId);
  assert.deepEqual(custody.originalFactIds, [previousFactId]);
  assert.equal(custody.factKey, `${previousEntityId}|custody_status|world`);
});

test('任务检索与 pending 均未投递旧状态时，提交事务仍让 R5 承接 R2 为 replace', async () => {
  const canon = new MemoryCanonRepository();
  const previousEntityId = 'entity:generated:%E7%8E%B2%E5%B1%B1';
  const previousFactId = 'fact:intervention:run-r2:direct:1';
  const previousFact: CanonFact = {
    factId: previousFactId,
    subjectEntityId: previousEntityId,
    predicate: 'custody_status',
    object: '被监禁',
    statement: '玲山被监禁。',
    temporalScope: '复兴纪元480年',
    spatialScope: '帝国监狱',
    epistemicStatus: 'generated',
    confidence: 'medium',
    sourceRefs: ['chat:20'],
    sourceSnapshotIds: [],
    sourceSpans: [],
    revisionIntroduced: 0,
    revisionRetired: null,
  };
  await canon.commitIntervention({
    namespace,
    action: {
      schema: 'eyon.canon.intervention-action.v1',
      runId: 'run-r2',
      userMessageId: 19,
      assistantMessageId: 20,
      rawCommand: '遣返',
      actionRecord: '玲山被监禁',
      sourceRefs: ['chat:20'],
      occurredAt: { label: '复兴纪元480年' },
      createdAt: 20,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '复兴纪元480年' },
      operations: [{
        op: 'assert',
        factKey: `${previousEntityId}|custody_status|world`,
        originalFactIds: [],
        current: previousFact,
      }],
      preconditionFactIds: [],
      dependsOnDeltaIds: [],
      cascadeScope: {
        entityIds: [previousEntityId],
        locations: ['帝国监狱'],
        subjectNames: ['玲山'],
      },
      preserves: ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: 20,
    },
  });
  const branch = await canon.getBranch(namespace);
  const stateFacts = currentBranchActiveStateFacts(branch);
  assert.deepEqual(stateFacts, [{
    factId: previousFactId,
    subjectEntityId: previousEntityId,
    predicate: 'custody_status',
  }]);

  const harness = linkingSettleHarness({
    directEffects: [{
      subject: '玲山·哈姆斯沃思',
      time: '复兴纪元481年',
      stateHint: '越狱后自由',
      change: '玲山·哈姆斯沃思越狱后恢复自由。',
    }],
    carriers: [
      { carrier: '帝国监狱', time: '复兴纪元481年', change: '追捕令随之改写' },
      { carrier: '琉璃塔筹备处', time: '复兴纪元483年', change: '重新接纳她的手稿' },
    ],
    // 真机 R5 的关键条件：pending 没有可靠携带旧状态，只能在提交时读当前分支。
    canon,
  });
  await harness.repository.savePending(harness.pending);
  const committed = await harness.workflow.settle(harness.pending);
  const settledBranch = await harness.canon.getBranch(namespace);
  const delta = settledBranch.deltas.find(item => item.deltaId === committed.deltaRef)!;
  const custody = delta.operations.find(operation =>
    operation.current.predicate === 'custody_status')!;
  assert.equal(custody.op, 'replace');
  assert.equal(custody.current.subjectEntityId, previousEntityId);
  assert.deepEqual(custody.originalFactIds, [previousFactId]);
});
