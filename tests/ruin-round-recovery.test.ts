import assert from 'node:assert/strict';
import test from 'node:test';
import type { ButterflyFreezeSnapshot } from '../src/adapters/host.ts';
import type { RuntimeChatMessage, TavernRuntime } from '../src/runtime/contracts.ts';
import { TavernWorkbenchHost } from '../src/runtime/tavernHost.ts';
import { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import { butterflyTriggerEvidenceHash } from '../src/runtime/butterflyController.ts';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';
import { buildCurrentSceneSnapshot } from '../src/core/currentSceneReference.ts';
import { biographyFullReference, digestBiographySource } from '../src/runtime/biographyContext.ts';
import { selectRelevantContextSources } from '../src/runtime/sourceSelection.ts';

const snapshot: ButterflyFreezeSnapshot = {
  flowState: 'exploring', runId: 'current-round',
  reality: { time: '复兴纪元488年3月1日19:40', location: '帝国-城-库房' },
  ruinEntry: { time: '神明纪元126年8月15日09:00', location: '精灵王国-深林-泉水-溪畔' },
  ruinExit: { time: '神明纪元126年8月15日09:40', location: '精灵王国-深林-泉水-溪畔' },
};
function runtimeOf(messages: RuntimeChatMessage[]): TavernRuntime {
  return {
    getCurrentCharacterName: () => 'fixture', getCurrentChatId: () => 'round-test',
    getLastMessageId: () => messages.at(-1)!.message_id, getMessageSwipeId: () => 0,
    getChatMessages: range => typeof range === 'number' ? messages.filter(m => m.message_id === range)
      : messages.filter(m => m.message_id >= Number(range.split('-')[0]) && m.message_id <= Number(range.split('-')[1])),
    async setChatMessages() {}, async setExtensionPrompt() {},
    async generate() { return ''; }, async generateRaw() { return ''; },
  };
}
function variables(runId: string, flowState = 'exploring') {
  return { stat_data: { 墟境系统: { 运行状态: {
    墟境流程状态: flowState, 墟境轮次: runId,
    本轮现实时间: snapshot.reality.time, 本轮现实地点: snapshot.reality.location,
    本轮墟境进入时间: snapshot.ruinEntry.time, 本轮墟境进入地点: snapshot.ruinEntry.location,
    本轮墟境离开时间: snapshot.ruinExit.time, 本轮墟境离开地点: snapshot.ruinExit.location,
  } } } };
}
const emptyProvider = {
  async getCurrentWorld() { return snapshot.reality; },
  async getWorldbookSources() { return []; },
  async getWorldbookCorpus() { return { sources: [], receipt: {
    schema: 'eyon.retrieval.worldbook-corpus.v1' as const, complete: true, bindings: [], entries: [],
    counts: { total: 0, enabled: 0, retrievable: 0, disabled: 0, empty: 0, 'user-excluded': 0, 'routed-generated': 0 },
  } }; },
  async getCharacterSources() { return []; }, async getGenealogySources() { return []; },
  async getBiographySources() { return []; }, async getButterflySources() { return []; },
};
function oldEntry(): RuntimeChatMessage {
  return { message_id: 24, role: 'assistant', message: '旧船上的历史入场',
    extra: { eyonHistoryRuinEntryRequest: { ruinHistory: {
      title: '旧船史案', era: '复兴纪元', originalTrajectory: '旧船事实',
      historicalBackground: '旧船背景', enteredAnomaly: '旧船节点', locationChain: ['旧船-甲板'],
    } } } };
}
function currentMessages(): RuntimeChatMessage[] {
  return [oldEntry(), { message_id: 35, role: 'user' as const, message: '我踏入这处历史特异点。' },
    { message_id: 36, role: 'assistant' as const, message: `进入新泉水历史：${snapshot.ruinEntry.time}。米露在溪畔。` },
    ...Array.from({ length: 60 }, (_, i) => ({ message_id: i + 37,
      role: i % 2 ? 'assistant' as const : 'user' as const,
      message: i === 0 ? '我修好泉水边的旧桥。' : `本轮普通事件${i}。` })),
    { message_id: 97, role: 'user' as const, message: '抱着米露带回现实，遣返吧，伊雍。' }];
}
async function freeze(messages: RuntimeChatMessage[], host: object) {
  return new TavernButterflyContextAssembler(runtimeOf(messages), emptyProvider, host as never,
    new RuntimeShadowRetrievalObserver()).freeze({
    requestId: 'round-freeze', namespace: { characterKey: 'fixture', chatId: 'round-test' },
    userMessageId: messages.at(-1)!.message_id, rawCommand: messages.at(-1)!.message,
    triggerType: 'text', roll: 68,
  });
}

test('脚本升级缺少 extra 时，楼层 MVU 恢复本轮入场，长轮次完整保留普通早期行动', async () => {
  const messages = currentMessages(), runtime = runtimeOf(messages);
  const reads: number[] = [];
  const host = new TavernWorkbenchHost(runtime, {
    getCurrentVariables: () => variables(snapshot.runId),
    getMessageVariables: (id: number) => {
      reads.push(id);
      if (id === 97) return {}; // 玩家楼尚未复制 MVU。
      return id >= 36 ? variables(snapshot.runId) : variables('old-round', 'idle');
    },
  } as never);
  assert.equal(host.getRuinRoundStartMessageId(snapshot, 97), 36);
  const result = await freeze(messages, host);
  assert.equal(result.request.ruinHistory.era, '神明纪元');
  assert.ok(!JSON.stringify(result.request).includes('旧船事实'));
  assert.ok(result.request.playerInterventions.some(s => s.sourceId === 'chat:37' && s.content.includes('修好')));
  assert.equal(result.request.sourceIndex.filter(s => s.sourceId.startsWith('chat:')).length, 62);
  assert.ok(result.request.sourceIndex.some(s => s.sourceId === 'chat:36'));
  assert.ok(reads.every(id => id <= 97));
});

test('缺少楼层 MVU 的兼容适配器用本轮入场时间恢复，不借上轮 metadata', async () => {
  const result = await freeze(currentMessages(), { async getButterflyFreezeSnapshot() { return snapshot; } });
  assert.ok(!JSON.stringify(result.request).includes('旧船事实'));
  assert.ok(result.request.sourceIndex.some(s => s.sourceId === 'chat:36'));
});

test('同纪元同地点重复进入时，新入场楼优先于匹配的旧 metadata', async () => {
  const messages = currentMessages();
  messages[0].extra = { eyonHistoryRuinEntryRequest: { ruinHistory: {
    title: '上一次泉水史案', era: '神明纪元', originalTrajectory: '不应借用的旧泉水事实',
    locationChain: [snapshot.ruinEntry.location],
  } } };
  const result = await freeze(messages, { async getButterflyFreezeSnapshot() { return snapshot; } });
  assert.ok(!JSON.stringify(result.request).includes('不应借用的旧泉水事实'));
  messages[2].message = '缺失具体入场时间。';
  await assert.rejects(freeze(messages, { async getButterflyFreezeSnapshot() { return snapshot; } }), /拒绝借用上一轮/u);
});

test('无本轮时地或楼层证据时，明确失败而不是偷偷借上轮史案', async () => {
  const messages = currentMessages();
  messages[2].message = '无法定位到具体时地的普通场景。';
  await assert.rejects(freeze(messages, { async getButterflyFreezeSnapshot() { return snapshot; } }), /拒绝借用上一轮/u);
});

test('同 runId 但入场时地变化仍划分轮次；隐藏入场楼也可读取当前 swipe 变量定位', () => {
  const messages = currentMessages(); messages[2].is_hidden = true;
  const host = new TavernWorkbenchHost(runtimeOf(messages), {
    getMessageVariables: (id: number) => {
      const value = variables(snapshot.runId);
      if (id < 36) value.stat_data.墟境系统.运行状态.本轮墟境进入时间 = '复兴纪元145年5月20日09:00';
      return value;
    },
  } as never);
  assert.equal(host.getRuinRoundStartMessageId(snapshot, 97), 36);
});

test('缺少入口标记时，早于最近36楼的行动改动也让准备缓存失效', () => {
  const messages = Array.from({ length: 80 }, (_, id) => ({
    message_id: id, role: id % 2 ? 'assistant' as const : 'user' as const, message: `普通场景${id}`,
  }));
  const runtime = runtimeOf(messages);
  const before = butterflyTriggerEvidenceHash(runtime, 79, '遣返');
  messages[3].message = '取消先前的修桥行动。';
  assert.notEqual(butterflyTriggerEvidenceHash(runtime, 79, '遣返'), before);
});

test('当前场景和兼容来源选择不再保留固定字符前缀', () => {
  const content = `旧钟塔现场。\n${'完整记录。'.repeat(2000)}\n最终所有者已转为港务局。`;
  const source = { sourceId: 'chat:1', title: '旧钟塔', content, sourceType: 'chat' as const, authority: 80 };
  const scene = buildCurrentSceneSnapshot('探索这座旧钟塔', '帝国-港城-旧钟塔', [source]);
  assert.equal(scene?.evidence[0].content, content);
  assert.equal(selectRelevantContextSources([source], '旧钟塔', { limit: 1, contentLimit: 20 })[0].content, content);
});

test('传记辅助参考保留各段中部事实与结尾，非 JSON 原文也不截断', () => {
  const prose = `复兴纪元477年，${'铺垫'.repeat(600)}中部事实：持有钟塔钥匙。${'后续'.repeat(600)}最终转交钥匙。`;
  const raw = JSON.stringify({ origin: { content: prose }, stages: [{ content: prose }], status: { content: prose } });
  const digest = JSON.parse(digestBiographySource(raw));
  assert.equal(digest.origin.content, prose);
  assert.equal(digest.stages[0].content, prose);
  assert.equal(digest.status.content, prose);
  assert.equal(digestBiographySource(prose), prose);
  assert.ok(biographyFullReference(raw, 20).startsWith(raw));
});
