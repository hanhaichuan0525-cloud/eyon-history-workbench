import assert from 'node:assert/strict';
import test from 'node:test';
import type { TavernRuntime } from '../src/runtime/contracts.ts';
import {
  SerializedTavernUserTurnAdapter,
  TavernContextSourceProvider,
  TavernWorkbenchHost,
  type TavernDataBindings,
} from '../src/runtime/tavernHost.ts';
import { ScriptWorkbenchSettings } from '../src/runtime/workbenchSettings.ts';
import { MemoryBiographyRepository } from '../src/storage/biographies.ts';
import { MemoryGenealogyRepository } from '../src/storage/genealogies.ts';

function runtime(messages: Array<{
  message_id: number;
  role: 'user' | 'assistant' | 'system';
  message: string;
}> = []): TavernRuntime {
  return {
    getCurrentCharacterName: () => '伊雍',
    getCurrentChatId: () => 'chat-a',
    getLastMessageId: () => messages.at(-1)?.message_id ?? -1,
    getMessageSwipeId: () => null,
    getChatMessages: () => messages,
    setChatMessages: async () => undefined,
    setExtensionPrompt: async () => undefined,
    generate: async () => '',
    generateRaw: async () => '',
  };
}

function bindings(overrides: Partial<TavernDataBindings> = {}): TavernDataBindings {
  return {
    getChatVariables: () => ({}),
    getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null,
    getGlobalWorldbookNames: () => [],
    getWorldbook: async () => [],
    createUserMessage: async () => undefined,
    triggerReply: async () => undefined,
    ...overrides,
  };
}

test('宿主快照只读取墟境系统根变量，并在探索时保留现实锚点', async () => {
  const host = new TavernWorkbenchHost(runtime(), bindings({
    getChatVariables: () => ({
      stat_data: {
        世界: { 时间: '墟境时间', 地点: '墟境地点' },
        墟境系统: {
          运行状态: {
            墟境流程状态: 'exploring',
            墟境轮次: 'run-7',
            本轮现实时间: '现实时间',
            本轮现实地点: '现实地点',
            墟境当前时间: '墟境时间',
            墟境当前地点: '墟境地点',
          },
        },
        事件: {
          伊雍: {
            墟境流程状态: 'returning',
          },
        },
      },
    }),
  }));
  assert.deepEqual(await host.getRuinRuntimeSnapshot(), {
    flowState: 'exploring',
    runId: 'run-7',
    realityTime: '现实时间',
    realityLocation: '现实地点',
    ruinTime: '墟境时间',
    ruinLocation: '墟境地点',
  });
});

test('蝴蝶冻结拒绝用旧归档轮次或旧快照冒充当前活动轮次', async () => {
  const host = new TavernWorkbenchHost(runtime(), bindings({
    getChatVariables: () => ({
      stat_data: {
        墟境系统: {
          运行状态: {
            墟境流程状态: 'returning',
            墟境轮次: '',
            归档轮次: 'run-old',
            归档现实时间: '旧现实时间',
            归档现实地点: '旧现实地点',
            归档墟境进入时间: '旧进入时间',
            归档墟境进入地点: '旧进入地点',
            归档墟境离开时间: '旧离开时间',
            归档墟境离开地点: '旧离开地点',
          },
          虚嗣指南快照: {
            runId: 'run-old',
            lockedRealTime: '旧现实时间',
            lockedRealLocation: '旧现实地点',
            entryRuinTime: '旧进入时间',
            entryRuinLocation: '旧进入地点',
            exitRuinTime: '旧离开时间',
            exitRuinLocation: '旧离开地点',
          },
        },
      },
    }),
  }));
  await assert.rejects(
    () => host.getButterflyFreezeSnapshot(),
    /缺少完整/u,
  );
});

test('蝴蝶提交严格核对相邻楼、最新楼与当前 swipe', async () => {
  const messages = [
    { message_id: 9, role: 'user' as const, message: '遣返' },
    { message_id: 10, role: 'assistant' as const, message: '返回现实' },
  ];
  const host = new TavernWorkbenchHost({
    ...runtime(messages),
    getMessageSwipeId: () => 2,
  }, bindings());
  await host.assertButterflyTarget({
    requestId: 'request-1',
    userMessageId: 9,
    assistantMessageId: 10,
    assistantSwipeId: 2,
    rawCommand: '遣返',
  });
  await assert.rejects(
    () => host.assertButterflyTarget({
      requestId: 'request-1',
      userMessageId: 9,
      assistantMessageId: 10,
      assistantSwipeId: 1,
      rawCommand: '遣返',
    }),
    /身份已经变化/u,
  );
});

test('资料源只读取当前绑定且启用的世界书条目', async () => {
  const requested: string[] = [];
  const sources = new TavernContextSourceProvider(
    bindings({
      getCharWorldbookNames: () => ({
        primary: '核心',
        additional: ['资料', '核心'],
      }),
      getChatWorldbookName: () => '聊天书',
      getGlobalWorldbookNames: () => ['全局书'],
      getWorldbook: async name => {
        requested.push(name);
        return [
          { uid: 1, name: `${name}-启用`, enabled: true, content: '正文' },
          { uid: 2, name: `${name}-禁用`, enabled: false, content: '不得读取' },
        ];
      },
    }),
    new MemoryBiographyRepository(),
    new MemoryGenealogyRepository(),
    () => ({ characterKey: '伊雍', chatId: 'chat-a' }),
  );
  const result = await sources.getWorldbookSources();
  assert.deepEqual(requested, ['核心', '资料', '聊天书', '全局书']);
  assert.equal(result.length, 4);
  assert.ok(result.every(item => !item.content.includes('不得读取')));
});

test('进入节点发送器串行创建唯一玩家楼，并在校验后才触发正文', async () => {
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [];
  const calls: string[] = [];
  const adapter = new SerializedTavernUserTurnAdapter(
    runtime(messages),
    bindings({
      createUserMessage: async text => {
        calls.push(`create:${text}`);
        messages.push({ message_id: messages.length, role: 'user', message: text });
      },
      triggerReply: async () => {
        calls.push('trigger');
      },
    }),
  );
  const first = adapter.sendUserTurn('进入节点 A');
  const second = adapter.sendUserTurn('进入节点 B');
  assert.deepEqual(await first, { messageId: 0 });
  assert.deepEqual(await second, { messageId: 1 });
  assert.deepEqual(calls, [
    'create:进入节点 A',
    'trigger',
    'create:进入节点 B',
    'trigger',
  ]);
});

test('脚本设置保留其他脚本变量，并为四个生成模块提供默认接口', async () => {
  let variables: Record<string, unknown> = { unrelated: 7 };
  const settings = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables,
    replaceScriptVariables: next => {
      variables = next;
    },
  });
  assert.deepEqual(await settings.get('ruin'), { mode: 'follow_tavern' });
  settings.setGeneration('ruin', {
    mode: 'custom',
    custom: {
      apiurl: 'https://example.com/v1',
      key: 'secret',
      model: 'model-a',
      source: 'openai',
      maxTokens: 4096,
      temperature: 0.7,
    },
  });
  assert.deepEqual(await settings.get('genealogy'), { mode: 'follow_tavern' });
  assert.equal((await settings.get('ruin')).mode, 'custom');
  settings.applyGenerationToAll({ mode: 'follow_tavern' });
  assert.deepEqual(await settings.get('butterfly'), { mode: 'follow_tavern' });
  settings.update({ ruinDraft: null });
  assert.equal(variables.unrelated, 7);
  assert.ok('eyonHistoryWorkbench' in variables);
});
