import assert from 'node:assert/strict';
import test from 'node:test';

import {
  carryPlayerFloor,
  normalizeRuinVariables,
  registerRuinTimeKernel,
  strengthenEntryCommands,
} from '../src/runtime/ruinTimeKernel.ts';
import type { RuntimeChatMessage, TavernRuntime } from '../src/runtime/contracts.ts';
import type { TavernDataBindings } from '../src/runtime/tavernHost.ts';
import { markWorkbenchReturn } from '../src/runtime/butterflyReturnAuthorization.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';

function activeVariables(overrides: Record<string, unknown> = {}) {
  return {
    stat_data: {
      世界: {
        时间: '复兴纪元145年-5月-20日-23:15',
        地点: '地下教堂',
      },
      墟境系统: {
        运行状态: {
          墟境流程状态: 'exploring',
          墟境任务规则锁定: 1,
          墟境待遣返: 0,
          墟境待蝴蝶效应结算: 0,
          墟境轮次: 'RUN-145',
          墟境进入前时间: '复兴纪元488年-5月-10日-14:28',
          墟境进入前地点: '源泉温床',
          本轮现实时间: '复兴纪元488年-5月-10日-14:28',
          本轮现实地点: '源泉温床',
          墟境当前时间: '复兴纪元145年-5月-20日-23:15',
          墟境当前地点: '地下教堂',
          本轮墟境进入时间: '复兴纪元145年-5月-20日-23:15',
          本轮墟境进入地点: '地下教堂',
          本轮墟境离开时间: '复兴纪元145年-5月-20日-23:15',
          本轮墟境离开地点: '地下教堂',
          归档轮次: '',
          归档现实时间: '',
          归档现实地点: '',
          归档墟境进入时间: '',
          归档墟境进入地点: '',
          归档墟境离开时间: '',
          归档墟境离开地点: '',
          蝴蝶效应锚定计数: 2,
          ...overrides,
        },
      },
    },
  };
}

function patch(operations: unknown[]): string {
  return `正文\n\n${JSON.stringify(operations)}`;
}

function kernelHost() {
  let card = '卡A';
  let chat = 'chat-A';
  const messages: Record<string, RuntimeChatMessage[]> = {};
  const variables: Record<string, Record<number, Record<string, unknown>>> = {};
  const entryState = activeVariables({ 墟境轮次: 'RUN-A',
    本轮现实时间: 'chat-A现实时间', 本轮现实地点: 'chat-A现实地点',
    本轮墟境进入时间: 'A历史时间', 本轮墟境进入地点: 'A历史地点',
    墟境当前时间: 'A历史时间', 墟境当前地点: 'A历史地点' }).stat_data.墟境系统.运行状态;
  const entryText = patch([
    ...Object.entries(entryState).map(([key, value]) => ({ op: 'replace',
      path: `/墟境系统/运行状态/${key}`, value })),
    { op: 'replace', path: '/世界/时间', value: 'A历史时间' },
    { op: 'replace', path: '/世界/地点', value: 'A历史地点' },
  ]);
  for (const key of ['chat-A', 'chat-B']) {
    messages[key] = [
      { message_id: 0, role: 'assistant', message: '现实正文', swipe_id: 0 },
      { message_id: 1, role: 'user', message: '继续', swipe_id: 0 },
      { message_id: 2, role: 'assistant', message: key === 'chat-A'
        ? entryText
        : 'B自己的正文', swipe_id: 0 },
    ];
    variables[key] = Object.fromEntries([0, 1, 2].map(id => [id, {
      stat_data: { 世界: { 时间: `${key}现实时间`, 地点: `${key}现实地点` } },
    }]));
  }
  const writes: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const runtime = {
    getCurrentCharacterName: () => card,
    getCurrentChatId: () => chat,
    getLastMessageId: () => messages[chat]?.at(-1)?.message_id ?? -1,
    getMessageSwipeId: (id: number) => messages[chat]?.[id]?.swipe_id ?? null,
    getChatMessages: (range: number | string) => {
      const current = messages[chat] ?? [];
      if (typeof range === 'number') return current.filter(item => item.message_id === range);
      if (range === 'all') return current;
      const end = Number(range.split('-')[1]);
      return current.filter(item => item.message_id <= end);
    },
    async setChatMessages(updates: Array<Partial<RuntimeChatMessage> & { message_id: number }>) {
      for (const update of updates) Object.assign(messages[chat].find(item => item.message_id === update.message_id)!, update);
    },
  } as TavernRuntime;
  const bindings = {
    getMessageVariables: (id: number) => variables[chat][id],
    replaceMessageVariables: async (id: number, value: Record<string, unknown>) => {
      writes.push(`${card}/${chat}/${id}`);
      variables[chat][id] = structuredClone(value);
    },
  } as TavernDataBindings;
  const globals = {
    Mvu: { getMvuData() {}, events: { BEFORE_MESSAGE_UPDATE: 'before', VARIABLE_UPDATE_ENDED: 'ended', COMMAND_PARSED: 'parsed' } },
    // Simulate older hosts with no unsubscribe function; disposal must still gate callbacks.
    eventOn: (name: string, listener: (...args: unknown[]) => void) => { listeners.set(name, listener); },
  };
  return {
    runtime, bindings, globals, writes, variables, messages,
    switchTo: (nextCard: string, nextChat: string) => { card = nextCard; chat = nextChat; },
    emit: (name: string, ...args: unknown[]) => listeners.get(name)?.(...args),
  };
}

test('时间内核同一聊天的延迟回放仍正常同步时地', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.ok(host.writes.length > 0);
  assert.deepEqual((host.variables['chat-A'][2].stat_data as any).世界,
    { 时间: 'A历史时间', 地点: 'A历史地点' });
});

test('时间内核不再把正文遣返文字当作授权，误写idle仍留在原墟境', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A' });
  host.messages['chat-A'][1].message = '好了，遣返吧，伊雍——';
  host.messages['chat-A'][2].message = '伊雍把你送回了现实。';
  const kernel = registerRuinTimeKernel(host.runtime,host.bindings,host.globals);
  t.after(() => kernel.dispose());
  const attempted = structuredClone(host.variables['chat-A'][2]);
  host.emit('before', { variables: attempted, message_content: host.messages['chat-A'][2].message });
  const stat = attempted.stat_data as any;
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'exploring');
  assert.equal(stat.墟境系统.运行状态.墟境任务规则锁定, 1);
  assert.equal(stat.世界.地点, '地下教堂');
});

test('按钮元数据授权可恢复现实，跨卡复制同号楼授权无效', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A' });
  host.messages['chat-A'][1].message = '遣返';
  host.messages['chat-A'][2].message = '返程正文';
  await markWorkbenchReturn(host.runtime, {
    namespace: { characterKey: '卡A', chatId: 'chat-A' }, runId: 'RUN-A',
    request: { requestId: 'request-button', trigger: { type: 'button', userMessageId: 1, rawCommand: '遣返' } },
  } as never);
  const kernel = registerRuinTimeKernel(host.runtime,host.bindings,host.globals);
  t.after(() => kernel.dispose());
  const authorized = structuredClone(host.variables['chat-A'][2]);
  host.emit('before', { variables: authorized, message_content: '返程正文' });
  const stat = authorized.stat_data as any;
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'idle');
  assert.equal(stat.墟境系统.运行状态.归档轮次, 'RUN-A');
  assert.equal(stat.世界.地点, '源泉温床');
  host.switchTo('卡B','chat-A'); kernel.onChatChanged();
  const unauthorized = structuredClone(host.variables['chat-A'][2]);
  host.emit('before', { variables: unauthorized, message_content: '返程正文' });
  assert.equal((unauthorized.stat_data as any).墟境系统.运行状态.墟境流程状态,'exploring');
});

test('旧版真实归档面板不因缺少新按钮标记被锁回墟境，伪造标签无效', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const panel = '<butterfly_panel>真实旧结算</butterfly_panel>';
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A' });
  host.variables['chat-A'][2] = activeVariables({ 墟境流程状态: 'idle', 墟境任务规则锁定: 0,
    墟境轮次: '', 归档轮次: 'RUN-A' });
  host.messages['chat-A'][1].message = '遣返';
  host.messages['chat-A'][2].message = panel;
  host.messages['chat-A'][2].extra = { eyonButterflyRequest: { requestId:'old-request', swipeId:0, panelHash:fingerprintText(panel) } };
  const kernel = registerRuinTimeKernel(host.runtime,host.bindings,host.globals);
  t.after(() => kernel.dispose());
  const archived = structuredClone(host.variables['chat-A'][2]);
  host.emit('before', { variables: archived, message_content: panel });
  assert.equal((archived.stat_data as any).墟境系统.运行状态.墟境流程状态,'idle');
  host.messages['chat-A'][2].message += '篡改';
  host.messages['chat-A'][2].extra = {};
  const fake = structuredClone(host.variables['chat-A'][2]);
  host.emit('before', { variables: fake, message_content: panel });
  assert.equal((fake.stat_data as any).墟境系统.运行状态.墟境流程状态,'exploring');
});

function frozenReturn() {
  return {
    namespace: { characterKey: '卡A', chatId: 'chat-A' }, runId: 'RUN-A',
    request: { requestId: 'request-frozen-return', runId: 'RUN-A',
      trigger: { type: 'button', userMessageId: 1, returnAssistantMessageId: 2, rawCommand: '遣返' },
      anchors: { reality: { time: '冻结现实时间', location: '冻结现实地点' },
        ruinEntry: { time: '入境时间', location: '入境地点' },
        ruinExit: { time: '离境时间', location: '离境地点' } } },
  } as never;
}

test('冻结返程是迟到MVU和回放的唯一真源，上一楼错误锚点不能再次覆盖', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A',
    本轮现实时间: '错误的历史时间', 本轮现实地点: '错误的历史地点' });
  host.messages['chat-A'][1].message = '遣返'; host.messages['chat-A'][2].message = '返程正文';
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  assert.equal(await kernel.restoreAuthorizedReturn(pending), true);
  const late = structuredClone(host.variables['chat-A'][0]);
  host.emit('ended', late, host.variables['chat-A'][0]);
  assert.deepEqual((late.stat_data as any).世界, { 时间: '冻结现实时间', 地点: '冻结现实地点' });
  assert.equal((late.stat_data as any).墟境系统.运行状态.归档现实时间, '冻结现实时间');
  host.variables['chat-A'][2] = late;
  t.mock.timers.tick(1000); await Promise.resolve();
  assert.equal((host.variables['chat-A'][2].stat_data as any).世界.时间, '冻结现实时间');
});

test('正文前登记冻结返程，MVU先结束或上一楼缺轮次也能恢复且保留其余更新', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending: any = frozenReturn();
  pending.request.trigger.returnAssistantMessageId = 0;
  host.messages['chat-A'][1].message = '遣返'; host.messages['chat-A'][2].message = '返程正文';
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  assert.equal(kernel.authorizeReturn(pending), true);
  const fresh = { stat_data: { 世界: { 时间: '过去', 地点: '旧处' }, 主角: { 金钱: 123 },
    墟境系统: { 运行状态: { 墟境流程状态: 'exploring', 墟境轮次: 'RUN-A' } } } };
  host.emit('before', { variables: fresh, message_content: '返程正文' });
  host.emit('ended', fresh, {});
  assert.deepEqual(fresh.stat_data.世界, { 时间: '冻结现实时间', 地点: '冻结现实地点' });
  assert.deepEqual(fresh.stat_data.主角, { 金钱: 123 });
  host.variables['chat-A'][2] = fresh;
  assert.equal(await kernel.restoreAuthorizedReturn(frozenReturn()), true);
  host.messages['chat-A'].push({ message_id: 3, role: 'user', message: '继续' },
    { message_id: 4, role: 'assistant', message: '现实前进' });
  const later = { stat_data: { 世界: { 时间: '新的现实时间', 地点: '新地点' } } };
  host.emit('ended', later, {});
  assert.deepEqual(later.stat_data.世界, { 时间: '新的现实时间', 地点: '新地点' });
});

test('渲染先于MVU容器时等候真实更新，不复制旧主角数据，停止内核后不迟到写回', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.messages['chat-A'][1].message = '遣返'; host.messages['chat-A'][2].message = '返程正文';
  host.variables['chat-A'][2] = {};
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  const restoring = kernel.restoreAuthorizedReturn(pending);
  assert.equal(host.writes.length, 0);
  const fresh = { stat_data: { 主角: { 金钱: 456 }, 世界: { 时间: '过去' } } };
  host.emit('ended', fresh, {}); host.variables['chat-A'][2] = fresh;
  t.mock.timers.tick(100); assert.equal(await restoring, true);
  assert.deepEqual((host.variables['chat-A'][2].stat_data as any).主角, { 金钱: 456 });
  host.variables['chat-A'][2] = {};
  const stopped = kernel.restoreAuthorizedReturn(pending);
  kernel.dispose(); const count = host.writes.length;
  t.mock.timers.tick(100); assert.equal(await stopped, false);
  assert.equal(host.writes.length, count);
});

test('返程交接使用冻结锚点恢复时地，旧楼缺字段也不依赖模型或只读快照猜测', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.messages['chat-A'][1].message = '遣返';
  host.messages['chat-A'][2].message = '返程正文，没有完整状态更新。';
  (host.variables['chat-A'][2].stat_data as any).其他模块 = { 保留: '完整变量' };
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  assert.equal(await kernel.restoreAuthorizedReturn(pending), true);
  const stat = host.variables['chat-A'][2].stat_data as any;
  assert.deepEqual(stat.世界, { 时间: '冻结现实时间', 地点: '冻结现实地点' });
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'idle');
  assert.equal(stat.墟境系统.运行状态.归档轮次, 'RUN-A');
  assert.equal(stat.墟境系统.虚嗣指南快照.archiveExitRuinTime, '离境时间');
  assert.deepEqual(stat.其他模块, { 保留: '完整变量' });
});

test('没有同楼按钮授权、前置行动被改或已经换卡，冻结锚点都不能回写', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.messages['chat-A'][1].message = '遣返';
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  await markWorkbenchReturn(host.runtime, pending);
  host.messages['chat-A'][0].message = '行动被编辑';
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  await markWorkbenchReturn(host.runtime, pending);
  host.switchTo('卡B', 'chat-A');
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  assert.deepEqual(host.writes, []);
});

test('冻结返程恢复后，延迟MVU回放不会重新锁回历史时间', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.messages['chat-A'][1].message = '遣返';
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A',
    本轮现实时间: '冻结现实时间', 本轮现实地点: '冻结现实地点',
    本轮墟境进入时间: '入境时间', 本轮墟境进入地点: '入境地点',
    本轮墟境离开时间: '离境时间', 本轮墟境离开地点: '离境地点' });
  host.messages['chat-A'][2].message = patch([
    { op: 'replace', path: '/世界/时间', value: '仍然错误的历史时间' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'idle' },
  ]);
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  assert.equal(await kernel.restoreAuthorizedReturn(pending), true);
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  t.mock.timers.tick(1000);
  await Promise.resolve(); await Promise.resolve();
  const stat = host.variables['chat-A'][2].stat_data as any;
  assert.deepEqual(stat.世界, { 时间: '冻结现实时间', 地点: '冻结现实地点' });
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'idle');
});

test('返程交接不碰后续楼、新轮次、隐藏楼或已经关闭的内核', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost(); const pending = frozenReturn();
  host.messages['chat-A'][1].message = '遣返';
  await markWorkbenchReturn(host.runtime, pending);
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  host.variables['chat-A'][2] = activeVariables({ 墟境轮次: 'RUN-NEW' });
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  host.variables['chat-A'][2] = { stat_data: {} };
  host.messages['chat-A'].push({ message_id: 3, role: 'user', message: '继续' });
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  host.messages['chat-A'].pop();
  host.messages['chat-A'][2].is_hidden = true;
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  host.messages['chat-A'][2].is_hidden = false;
  kernel.dispose();
  assert.equal(await kernel.restoreAuthorizedReturn(pending), false);
  assert.deepEqual(host.writes, []);
});

test('A卡排队后切到B卡，同号楼层不被旧正文或旧时地覆盖', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  host.switchTo('卡B', 'chat-B');
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
  assert.deepEqual((host.variables['chat-B'][2].stat_data as any).世界,
    { 时间: 'chat-B现实时间', 地点: 'chat-B现实地点' });
});

test('同卡切聊天也会丢弃旧聊天延迟任务', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  host.switchTo('卡A', 'chat-B');
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
});

test('仅切角色卡而聊天名相同，也不能保留原卡任务', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  host.switchTo('卡B', 'chat-A');
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
});

test('同号玩家楼在切卡后重新继承本卡数据，而非按旧楼号跳过', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  host.messages['chat-A'].pop();
  host.messages['chat-B'].pop();
  host.variables['chat-A'][0] = activeVariables({ 墟境轮次: 'RUN-A' });
  host.variables['chat-B'][0] = activeVariables({ 墟境轮次: 'RUN-B',
    墟境当前时间: 'B历史时间', 墟境当前地点: 'B历史地点' });
  (host.variables['chat-B'][0].stat_data as any).世界 = { 时间: 'B历史时间', 地点: 'B历史地点' };
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  t.mock.timers.tick(1000);
  await Promise.resolve();
  host.switchTo('卡B', 'chat-B');
  kernel.onChatChanged();
  t.mock.timers.tick(400);
  t.mock.timers.tick(700);
  await Promise.resolve();
  const stat = host.variables['chat-B'][1].stat_data as any;
  assert.equal(stat.墟境系统.运行状态.墟境轮次, 'RUN-B');
  assert.deepEqual(stat.世界, { 时间: 'B历史时间', 地点: 'B历史地点' });
});

test('A→B→A后旧批次不能恢复，新批次仍能正常工作', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.switchTo('卡B', 'chat-B');
  kernel.onChatChanged();
  host.switchTo('卡A', 'chat-A');
  kernel.onChatChanged();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.ok(host.writes.length > 0);
  assert.ok(host.writes.every(key => key === '卡A/chat-A/2'));
});

test('切swipe/改写同号楼层后不能回放旧正文', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.emit('ended', structuredClone(host.variables['chat-A'][2]));
  host.messages['chat-A'][2].swipe_id = 1;
  host.messages['chat-A'][2].message = '回滚后的新正文';
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
});

test('无角色或聊天时不读写楼层', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  host.switchTo('', '');
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  t.after(() => kernel.dispose());
  host.emit('ended', {});
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(host.writes, []);
});

test('关闭时间内核后，残留MVU回调和计时器都不能继续生效', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = kernelHost();
  const kernel = registerRuinTimeKernel(host.runtime, host.bindings, host.globals);
  kernel.dispose();
  const value = structuredClone(host.variables['chat-A'][2]);
  const before = structuredClone(value);
  host.emit('before', { variables: value, message_content: host.messages['chat-A'][2].message });
  host.emit('ended', value);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.deepEqual(value, before);
  assert.deepEqual(host.writes, []);
});

test('完整进入契约会建立活动轮次、同步世界时地并生成快照', () => {
  const variables = { stat_data: { 世界: { 时间: '现实', 地点: '现实地点' } } };
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 1 },
    { op: 'replace', path: '/墟境系统/运行状态/墟境轮次', value: 'RUN-145' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实时间', value: '现实 14:28' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实地点', value: '现实地点' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入时间', value: '历史 23:15' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入地点', value: '地下教堂' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '历史 23:15' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '地下教堂' },
    { op: 'replace', path: '/世界/时间', value: '历史 23:15' },
    { op: 'replace', path: '/世界/地点', value: '地下教堂' },
  ]);
  assert.equal(normalizeRuinVariables(variables, null, text), true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '历史 23:15');
  assert.equal(stat.墟境系统.运行状态.本轮墟境离开时间, '历史 23:15');
  assert.equal(stat.墟境系统.虚嗣指南快照.flowState, 'exploring');
  assert.equal(stat.墟境系统.虚嗣指南快照.lockedRealTime, '现实 14:28');
});

test('同一轮推进只更新墟境当前与离开锚点，不允许进入锚点和现实锚点漂移', () => {
  const previous = activeVariables();
  const variables = activeVariables({
    墟境流程状态: 'idle',
    墟境任务规则锁定: 0,
    本轮现实时间: '错误现实',
    本轮现实地点: '错误地点',
    本轮墟境进入时间: '错误进入时间',
    本轮墟境进入地点: '错误进入地点',
    墟境当前时间: '',
    墟境当前地点: '',
  });
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '复兴纪元145年-5月-20日-23:20' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '祭坛后室' },
  ]);
  normalizeRuinVariables(variables, previous, text);
  const state = (variables.stat_data as Record<string, any>).墟境系统.运行状态;
  assert.equal(state.墟境流程状态, 'exploring');
  assert.equal(state.本轮现实时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(state.本轮墟境进入时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(state.墟境当前时间, '复兴纪元145年-5月-20日-23:20');
  assert.equal(state.本轮墟境离开地点, '祭坛后室');
});

test('覆盖层擦掉轮次后先补回同轮身份，再锁住现实与进入锚点', () => {
  const previous = activeVariables();
  const variables = activeVariables({
    墟境轮次: '',
    墟境流程状态: 'idle',
    墟境任务规则锁定: 0,
    本轮现实时间: '错误现实',
    本轮现实地点: '错误地点',
    本轮墟境进入时间: '错误进入时间',
    本轮墟境进入地点: '错误进入地点',
    墟境当前时间: '',
    墟境当前地点: '',
  });
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '复兴纪元145年-5月-20日-23:21' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '钟楼夹层' },
  ]);

  normalizeRuinVariables(variables, previous, text);
  const state = (variables.stat_data as Record<string, any>).墟境系统.运行状态;
  assert.equal(state.墟境轮次, 'RUN-145');
  assert.equal(state.本轮现实时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(state.本轮墟境进入时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(state.墟境当前时间, '复兴纪元145年-5月-20日-23:21');
  assert.equal(state.本轮墟境离开地点, '钟楼夹层');
});

test('相邻玩家楼已授权遣返时，即使模型只写 idle 契约也会恢复现实', () => {
  const previous = activeVariables({
    本轮墟境离开时间: '复兴纪元145年-5月-20日-23:22',
    本轮墟境离开地点: '礼拜堂出口',
  });
  const variables = activeVariables();
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'idle' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 0 },
  ]);
  normalizeRuinVariables(variables, previous, text, true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(stat.世界.地点, '源泉温床');
  assert.equal(stat.墟境系统.运行状态.归档轮次, 'RUN-145');
  assert.equal(
    stat.墟境系统.运行状态.归档墟境离开时间,
    '复兴纪元145年-5月-20日-23:22',
  );
  assert.equal(stat.墟境系统.运行状态.墟境轮次, '');
  assert.equal(stat.墟境系统.虚嗣指南快照.flowState, 'idle');
});

test('任务完成但玩家没有授权遣返时，模型误写 idle 也会继续留在墟境', () => {
  const previous = activeVariables();
  const variables = activeVariables();
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'idle' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 0 },
    { op: 'replace', path: '/世界/时间', value: '错误的现实时间' },
    { op: 'replace', path: '/世界/地点', value: '错误的现实地点' },
  ]);

  normalizeRuinVariables(variables, previous, text, false);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'exploring');
  assert.equal(stat.墟境系统.运行状态.墟境任务规则锁定, 1);
  assert.equal(stat.世界.时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(stat.世界.地点, '地下教堂');
});

test('玩家已授权遣返时不依赖模型输出结构化字段也会确定性回正', () => {
  const previous = activeVariables({
    本轮墟境离开时间: '复兴纪元145年-5月-20日-23:25',
    本轮墟境离开地点: '地下教堂出口',
  });
  const variables = activeVariables();

  normalizeRuinVariables(variables, previous, '她穿过光门，回到了熟悉的房间。', true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(stat.世界.地点, '源泉温床');
  assert.equal(stat.墟境系统.运行状态.归档墟境离开地点, '地下教堂出口');
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'idle');
  assert.equal(stat.墟境系统.运行状态.墟境轮次, '');
});

test('玩家楼只继承上一可见 AI 楼的墟境根；活动轮次同时继承世界时地', () => {
  const variables = { stat_data: { 世界: { 时间: '错误', 地点: '错误' } } };
  assert.equal(carryPlayerFloor(variables, activeVariables()), true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.墟境系统.运行状态.墟境轮次, 'RUN-145');
  assert.equal(stat.世界.时间, '复兴纪元145年-5月-20日-23:15');
});

test('COMMAND_PARSED 只对完整 entering 契约补强，不接受单独 exploring', () => {
  const incomplete: Array<Record<string, unknown>> = [];
  assert.equal(strengthenEntryCommands(incomplete, patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
  ])), false);
  assert.equal(incomplete.length, 0);

  const commands: Array<Record<string, unknown>> = [{
    type: 'set',
    args: ['墟境系统.运行状态.墟境流程状态', '"idle"'],
  }];
  const complete = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 1 },
    { op: 'replace', path: '/墟境系统/运行状态/墟境轮次', value: 'RUN-145' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实时间', value: '现实' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实地点', value: '现实地点' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入时间', value: '历史' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入地点', value: '历史地点' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '历史' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '历史地点' },
    { op: 'replace', path: '/世界/时间', value: '历史' },
    { op: 'replace', path: '/世界/地点', value: '历史地点' },
  ]);
  assert.equal(strengthenEntryCommands(commands, complete), true);
  assert.ok(commands.some(command => command.reason === 'eyon_time_kernel_runtime_init'));
  assert.ok(commands.some(command => (
    Array.isArray(command.args)
    && command.args[0] === '墟境系统.运行状态.墟境流程状态'
    && command.reason === 'eyon_time_kernel_entry_contract'
  )));
});
