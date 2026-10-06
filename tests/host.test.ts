import assert from 'node:assert/strict';
import test from 'node:test';
import type { TavernRuntime } from '../src/runtime/contracts.ts';
import {
  SerializedTavernUserTurnAdapter,
  TavernButterflyMirrorRetirement,
  TavernContextSourceProvider,
  TavernWorkbenchHost,
  type TavernDataBindings,
} from '../src/runtime/tavernHost.ts';
import { ScriptWorkbenchSettings } from '../src/runtime/workbenchSettings.ts';
import { MemoryBiographyRepository } from '../src/storage/biographies.ts';
import {
  genealogyRecordKey,
  MemoryGenealogyRepository,
  type GenealogyRecord,
} from '../src/storage/genealogies.ts';

test('镜像退役清理：只摘锚定书的全局绑定、只删脚本自建条目，不碰用户世界书', async () => {
  const rebound: string[][] = [];
  const deleted: Array<{ name: string; removed: number }> = [];
  const retirement = new TavernButterflyMirrorRetirement(bindings({
    getWorldbookNames: () => [
      '伊雍-蝴蝶效应锚定-chat-a',
      '伊雍-蝴蝶效应锚定-chat-b',
      '用户自己的书',
    ],
    getGlobalWorldbookNames: () => [
      '用户自己的书',
      '伊雍-蝴蝶效应锚定-chat-a',
      '伊雍-蝴蝶效应锚定-chat-b',
    ],
    rebindGlobalWorldbooks: async names => { rebound.push([...names]); },
    deleteWorldbookEntries: async (name, predicate) => {
      const entries = [
        {
          uid: 7, name: '镜像条目', enabled: true, content: '镜像',
          extra: { source: 'eyon_butterfly_anchor', chat_id: 'chat-a', run_id: 'run-a' },
        },
        { uid: 8, name: '用户条目', enabled: true, content: '用户内容' },
      ];
      const kept = entries.filter(entry => !predicate(entry as never));
      deleted.push({ name, removed: entries.length - kept.length });
      return { deleted_entries: entries.filter(predicate as never) as never[] };
    },
  }));

  const result = await retirement.retireLegacyMirrors();
  assert.deepEqual(result.worldbooks, [
    '伊雍-蝴蝶效应锚定-chat-a',
    '伊雍-蝴蝶效应锚定-chat-b',
  ]);
  assert.equal(result.removedEntries, 2, '每本锚定书各删一条脚本自建条目');
  assert.deepEqual(rebound, [['用户自己的书']], '只保留非锚定书的全局绑定');
  assert.deepEqual(result.globals, ['用户自己的书']);
  assert.ok(
    deleted.every(item => item.name.startsWith('伊雍-蝴蝶效应锚定-')),
    '不得触碰用户世界书',
  );
});

test('镜像退役清理在宿主能力缺失时降级：仍摘绑定，不抛错，不碰用户书', async () => {
  // 宿主没有 deleteWorldbookEntries（旧版酒馆助手）：只摘全局绑定并如实报 0 条。
  const rebound: string[][] = [];
  const withoutDelete = new TavernButterflyMirrorRetirement(bindings({
    getWorldbookNames: () => ['伊雍-蝴蝶效应锚定-chat-a', '用户自己的书'],
    getGlobalWorldbookNames: () => ['用户自己的书', '伊雍-蝴蝶效应锚定-chat-a'],
    rebindGlobalWorldbooks: async names => { rebound.push([...names]); },
  }));
  const degraded = await withoutDelete.retireLegacyMirrors();
  assert.deepEqual(degraded.worldbooks, ['伊雍-蝴蝶效应锚定-chat-a']);
  assert.equal(degraded.removedEntries, 0, '无删除能力时按 0 条如实汇报');
  assert.deepEqual(rebound, [['用户自己的书']], '摘绑定不依赖条目删除能力');
  assert.deepEqual(degraded.globals, ['用户自己的书']);

  // 宿主没有 rebindGlobalWorldbooks（更旧）：不抛错，条目删除照做。
  const deleted: string[] = [];
  const withoutRebind = new TavernButterflyMirrorRetirement(bindings({
    getWorldbookNames: () => ['伊雍-蝴蝶效应锚定-chat-a'],
    getGlobalWorldbookNames: () => ['伊雍-蝴蝶效应锚定-chat-a'],
    deleteWorldbookEntries: async (name, predicate) => {
      deleted.push(name);
      const entries = [{
        uid: 1, name: '镜像', enabled: true, content: '镜像',
        extra: { source: 'eyon_butterfly_anchor' },
      }];
      return { deleted_entries: entries.filter(predicate as never) as never[] };
    },
  }));
  const noRebind = await withoutRebind.retireLegacyMirrors();
  assert.equal(noRebind.removedEntries, 1);
  assert.deepEqual(deleted, ['伊雍-蝴蝶效应锚定-chat-a']);
});

test('镜像退役清理：单本世界书删除失败不阻断其余，且如实汇报条数', async () => {
  const warned: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(String(args[0])); };
  try {
    const retirement = new TavernButterflyMirrorRetirement(bindings({
      getWorldbookNames: () => ['伊雍-蝴蝶效应锚定-bad', '伊雍-蝴蝶效应锚定-good'],
      getGlobalWorldbookNames: () => [
        '用户自己的书',
        '伊雍-蝴蝶效应锚定-bad',
        '伊雍-蝴蝶效应锚定-good',
      ],
      rebindGlobalWorldbooks: async () => undefined,
      deleteWorldbookEntries: async (name, predicate) => {
        if (name.endsWith('bad')) throw new Error('世界书未绑定，无法删除条目');
        const entries = [{
          uid: 3, name: '镜像', enabled: true, content: '镜像',
          extra: { source: 'eyon_butterfly_anchor' },
        }];
        return { deleted_entries: entries.filter(predicate as never) as never[] };
      },
    }));
    const result = await retirement.retireLegacyMirrors();
    assert.equal(result.worldbooks.length, 2, '两本都进入处理清单');
    assert.equal(result.removedEntries, 1, '只统计真正删掉的条目');
    assert.ok(
      warned.some(line => line.includes('mirror cleanup failed')),
      '失败按本记日志，不静默吞掉',
    );
    assert.deepEqual(result.globals, ['用户自己的书'], '失败也不影响摘绑定结果');
  } finally {
    console.warn = originalWarn;
  }
});

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
    getCurrentVariables: () => ({}),
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
        世界: { 时间: '错误聊天时间', 地点: '错误聊天地点' },
        墟境系统: {
          运行状态: { 墟境流程状态: 'idle' },
        },
      },
    }),
    getCurrentVariables: () => ({
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
    ruinTasks: [],
  });
});

test('新玩家楼尚未复制 MVU 时，宿主快照回看上一可见 AI 楼的活动轮次', async () => {
  const messages = [
    { message_id: 4, role: 'assistant' as const, message: '仍在墟境' },
    { message_id: 5, role: 'user' as const, message: '我检查现场' },
  ];
  const host = new TavernWorkbenchHost(runtime(messages), bindings({
    getCurrentVariables: () => ({
      stat_data: {
        世界: { 时间: '空玩家楼时间', 地点: '空玩家楼地点' },
        墟境系统: { 运行状态: { 墟境流程状态: 'idle' } },
      },
    }),
    getMessageVariables: messageId => messageId === 4 ? {
      stat_data: {
        世界: { 时间: '历史时间', 地点: '历史地点' },
        墟境系统: {
          运行状态: {
            墟境流程状态: 'exploring',
            墟境轮次: 'run-previous',
            本轮现实时间: '现实时间',
            本轮现实地点: '现实地点',
            墟境当前时间: '历史时间',
            墟境当前地点: '历史地点',
          },
        },
      },
    } : {},
  }));

  assert.deepEqual(await host.getRuinRuntimeSnapshot(), {
    flowState: 'exploring',
    runId: 'run-previous',
    realityTime: '现实时间',
    realityLocation: '现实地点',
    ruinTime: '历史时间',
    ruinLocation: '历史地点',
    ruinTasks: [],
  });
});

test('人物与世界资料只读取最新消息楼的 MVU stat_data', async () => {
  const sources = new TavernContextSourceProvider(
    bindings({
      getChatVariables: () => ({
        stat_data: {
          世界: { 时间: '旧时间', 地点: '旧地点' },
          关系列表: { 旧人物: { 种族: '旧数据' } },
        },
      }),
      getCurrentVariables: () => ({
        stat_data: {
          世界: { 时间: '当前时间', 地点: '当前地点' },
          关系列表: { 维奥莱塔: { 种族: '人类' } },
        },
      }),
    }),
    new MemoryBiographyRepository(),
    new MemoryGenealogyRepository(),
    () => ({ characterKey: '伊雍', chatId: 'chat-a' }),
  );
  assert.deepEqual(await sources.getCurrentWorld(), {
    time: '当前时间',
    location: '当前地点',
  });
  assert.deepEqual(
    (await sources.getCharacterSources()).map(item => item.title),
    ['维奥莱塔'],
  );
});

test('蝴蝶冻结拒绝用旧归档轮次或旧快照冒充当前活动轮次', async () => {
  const host = new TavernWorkbenchHost(runtime(), bindings({
    getCurrentVariables: () => ({
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

test('蝴蝶冻结可严格读取指定 AI 楼的消息级 MVU 快照', async () => {
  const requested: number[] = [];
  const host = new TavernWorkbenchHost(runtime(), bindings({
    getChatVariables: () => ({
      stat_data: {
        墟境系统: {
          运行状态: { 墟境流程状态: 'idle' },
        },
      },
    }),
    getCurrentVariables: () => ({
      stat_data: {
        墟境系统: {
          运行状态: { 墟境流程状态: 'idle' },
        },
      },
    }),
    getMessageVariables: messageId => {
      requested.push(messageId);
      return {
        stat_data: {
          墟境系统: {
            运行状态: {
              墟境流程状态: 'exploring',
              墟境轮次: 'run-message-8',
              本轮现实时间: '现实 14:05',
              本轮现实地点: '现实大厅',
              本轮墟境进入时间: '历史 23:15',
              本轮墟境进入地点: '历史走廊',
              本轮墟境离开时间: '历史 23:20',
              本轮墟境离开地点: '历史密道',
            },
            虚嗣指南快照: {
              runId: 'run-message-8',
            },
          },
        },
      };
    },
  }));
  assert.deepEqual(await host.getButterflyFreezeSnapshot(8), {
    flowState: 'exploring',
    runId: 'run-message-8',
    reality: { time: '现实 14:05', location: '现实大厅' },
    ruinEntry: { time: '历史 23:15', location: '历史走廊' },
    ruinExit: { time: '历史 23:20', location: '历史密道' },
  });
  assert.deepEqual(requested, [8]);
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

test('蝴蝶提交把隐藏系统楼视为宿主细节而非新的对话回合', async () => {
  const messages = [
    { message_id: 9, role: 'user' as const, message: '好了，遣返吧' },
    {
      message_id: 10,
      role: 'system' as const,
      message: 'MVU hidden bridge',
      is_hidden: true,
    },
    { message_id: 11, role: 'assistant' as const, message: '返回现实' },
  ];
  const host = new TavernWorkbenchHost({
    ...runtime(messages),
    getMessageSwipeId: () => 2,
  }, bindings());

  await host.assertButterflyTarget({
    requestId: 'request-hidden-floor',
    userMessageId: 9,
    assistantMessageId: 11,
    assistantSwipeId: 2,
    rawCommand: '好了,遣返吧',
  });
});

test('蝴蝶面板会原位替换唯一旧面板并保留遣返正文与变量块', async () => {
  const messages = [{
    message_id: 10,
    role: 'assistant' as const,
    message: '遣返正文\n\n<butterfly_panel>旧面板</butterfly_panel>\n\n<UpdateVariable>变量</UpdateVariable>',
    extra: {},
  }];
  const updates: Array<{ message?: string; extra?: Record<string, unknown> }> = [];
  const host = new TavernWorkbenchHost({
    ...runtime(messages),
    setChatMessages: async changes => {
      updates.push(changes[0]);
    },
  }, bindings());

  await host.appendButterflyPanel(
    10,
    'request-new',
    '<butterfly_panel>新面板</butterfly_panel>',
  );

  assert.equal(
    updates[0].message,
    '遣返正文\n\n<butterfly_panel>新面板</butterfly_panel>\n\n<UpdateVariable>变量</UpdateVariable>',
  );
  assert.deepEqual(
    (updates[0].extra?.eyonButterflyRequest as Record<string, unknown>).requestId,
    'request-new',
  );
  assert.equal(
    typeof (updates[0].extra?.eyonButterflyRequest as Record<string, unknown>).panelHash,
    'string',
  );
});

test('蝴蝶面板发现多份旧面板时拒绝猜测替换目标', async () => {
  const messages = [{
    message_id: 10,
    role: 'assistant' as const,
    message: '<butterfly_panel>一</butterfly_panel>\n<butterfly_panel>二</butterfly_panel>',
  }];
  const host = new TavernWorkbenchHost(runtime(messages), bindings());
  await assert.rejects(
    () => host.appendButterflyPanel(
      10,
      'request-new',
      '<butterfly_panel>新</butterfly_panel>',
    ),
    /包含多份/u,
  );
});

test('蝴蝶面板插入正文之后、MVU 变量面板之前（internal.81 v20）', async () => {
  const messages = [{
    message_id: 10,
    role: 'assistant' as const,
    message: '遣返正文\n\n<UpdateVariable>变量面板</UpdateVariable>',
  }];
  const updates: Array<{ message?: string }> = [];
  const host = new TavernWorkbenchHost({
    ...runtime(messages),
    setChatMessages: async changes => {
      updates.push(changes[0]);
    },
  }, bindings());

  await host.appendButterflyPanel(
    10,
    'request-v20',
    '<butterfly_panel>新面板</butterfly_panel>',
  );

  assert.equal(
    updates[0].message,
    '遣返正文\n\n<butterfly_panel>新面板</butterfly_panel>\n<UpdateVariable>变量面板</UpdateVariable>',
  );
});

test('历史尾置的自加面板在重试时自动归位到 MVU 面板之前且重复提交幂等（internal.81 v20）', async () => {
  const messages = [{
    message_id: 10,
    role: 'assistant' as const,
    message: '遣返正文\n<UpdateVariable>变量面板</UpdateVariable>\n\n<butterfly_panel>旧面板</butterfly_panel>',
    extra: { eyonButterflyRequest: { requestId: 'request-same', swipeId: null } },
  }];
  let writes = 0;
  const host = new TavernWorkbenchHost({
    ...runtime(messages),
    setChatMessages: async changes => {
      writes += 1;
      const target = messages.find(item => item.message_id === changes[0].message_id);
      if (target && changes[0].message !== undefined) {
        target.message = changes[0].message as string;
      }
    },
  }, bindings());

  await host.appendButterflyPanel(
    10,
    'request-same',
    '<butterfly_panel>新面板</butterfly_panel>',
  );
  assert.equal(writes, 1);
  assert.equal(
    messages[0].message,
    '遣返正文\n\n<butterfly_panel>新面板</butterfly_panel>\n<UpdateVariable>变量面板</UpdateVariable>',
  );

  await host.appendButterflyPanel(
    10,
    'request-same',
    '<butterfly_panel>新面板</butterfly_panel>',
  );
  assert.equal(writes, 1, '同一请求重复提交应幂等，不重复写入楼层');
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

test('Retrieval v1.2 逐 UID 守恒登记全部绑定条目并仅放行可检索正文', async () => {
  const sources = new TavernContextSourceProvider(
    bindings({
      getCharWorldbookNames: () => ({ primary: '核心', additional: [] }),
      getChatWorldbookName: () => null,
      getGlobalWorldbookNames: () => [],
      getWorldbook: async () => [
        { uid: 1, name: '可检索', enabled: true, content: '正文' },
        { uid: 2, name: '禁用', enabled: false, content: '正文' },
        { uid: 3, name: '空白', enabled: true, content: '   ' },
        { uid: 4, name: '用户排除', enabled: true, content: '正文' },
        { uid: 5, name: '派生锚点', enabled: true, content: '正文', extra: { source: 'eyon_butterfly_anchor' } },
        {
          uid: 6,
          name: '未触发 selective',
          enabled: true,
          content: '仍须建目录',
          strategy: { type: 'selective', keys: ['本轮未命中'], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 2 },
        },
        {
          uid: 7,
          name: '概率零 vectorized',
          enabled: true,
          content: '仍须建目录',
          probability: 0,
          strategy: { type: 'vectorized', keys: [], keys_secondary: { logic: 'and_any', keys: [] }, scan_depth: 'same_as_global' },
        },
      ],
    }),
    new MemoryBiographyRepository(),
    new MemoryGenealogyRepository(),
    () => ({ characterKey: '伊雍', chatId: 'chat-a' }),
    () => new Set(['%E6%A0%B8%E5%BF%83:4']),
  );

  const corpus = await sources.getWorldbookCorpus();
  assert.equal(corpus.receipt.complete, true);
  assert.deepEqual(corpus.receipt.counts, {
    total: 7,
    enabled: 6,
    retrievable: 3,
    disabled: 1,
    empty: 1,
    'user-excluded': 1,
    'routed-generated': 1,
  });
  assert.deepEqual(
    corpus.receipt.entries.map(entry => [entry.uid, entry.status]),
    [[1, 'retrievable'], [2, 'disabled'], [3, 'empty'], [4, 'user-excluded'], [5, 'routed-generated'], [6, 'retrievable'], [7, 'retrievable']],
  );
  assert.deepEqual(corpus.sources.map(source => source.worldbook.uid), [1, 6, 7]);
});

test('世界书来源旁路保留完整检索元数据与全部绑定范围', async () => {
  const requested: string[] = [];
  const sources = new TavernContextSourceProvider(
    bindings({
      getCharWorldbookNames: () => ({
        primary: '核心 设定',
        additional: ['核心 设定'],
      }),
      getChatWorldbookName: () => null,
      getGlobalWorldbookNames: () => ['核心 设定'],
      getWorldbook: async name => {
        requested.push(name);
        return [{
          uid: 17,
          name: '圣翼议会',
          enabled: true,
          content: ' 圣翼议会属于梵尼亚。 ',
          strategy: {
            type: 'vectorized',
            keys: [' 圣翼议会 ', /梵尼亚/iu],
            keys_secondary: {
              logic: 'and_all',
              keys: ['教会', /议会/u],
            },
            scan_depth: 4,
          },
          position: { type: 'at_depth', role: 'system', depth: 3, order: 20 },
          probability: 85,
          recursion: {
            prevent_incoming: false,
            prevent_outgoing: true,
            delay_until: 1,
          },
          effect: { sticky: 2, cooldown: 1, delay: null },
          extra: { category: 'organization' },
        }];
      },
    }),
    new MemoryBiographyRepository(),
    new MemoryGenealogyRepository(),
    () => ({ characterKey: '伊雍', chatId: 'chat-a' }),
  );

  const [result] = await sources.getWorldbookSources();
  assert.deepEqual(requested, ['核心 设定']);
  assert.ok(result);
  assert.equal(result.content, '圣翼议会属于梵尼亚。');
  assert.equal(result.strategyType, 'selective', 'BP01 不改变旧选择器的兼容语义');
  assert.deepEqual(result.keywords, [' 圣翼议会 ', '/梵尼亚/iu']);
  assert.deepEqual(result.worldbook, {
    schema: 'eyon.retrieval.worldbook-metadata.v1',
    logicalId: 'worldbook:%E6%A0%B8%E5%BF%83%20%E8%AE%BE%E5%AE%9A:17',
    worldbookName: '核心 设定',
    uid: 17,
    bindingScopes: ['character-primary', 'character-additional', 'global'],
    enabled: true,
    strategy: {
      type: 'vectorized',
      primaryKeys: [' 圣翼议会 ', '/梵尼亚/iu'],
      secondary: { logic: 'and_all', keys: ['教会', '/议会/u'] },
      scanDepth: 4,
    },
    position: { type: 'at_depth', role: 'system', depth: 3, order: 20 },
    probability: 85,
    recursion: {
      preventIncoming: false,
      preventOutgoing: true,
      delayUntil: 1,
    },
    effect: { sticky: 2, cooldown: 1, delay: null },
    extra: { category: 'organization' },
  });
});

test('工作台世界书选择按角色卡与全局分栏并过滤独立 API 资料', async () => {
  const sources = new TavernContextSourceProvider(
    bindings({
      getCharWorldbookNames: () => ({
        primary: 'core',
        additional: [],
      }),
      getChatWorldbookName: () => 'chat-book',
      getGlobalWorldbookNames: () => ['global-book', 'core'],
      getWorldbook: async name => [{
        uid: 1,
        name: `${name}-entry`,
        enabled: true,
        content: `${name}-content`,
      }],
    }),
    new MemoryBiographyRepository(),
    new MemoryGenealogyRepository(),
    () => ({ characterKey: '伊雍', chatId: 'chat-a' }),
    () => new Set(['core:1']),
  );

  const options = await sources.listCharacterWorldbookEntries();
  assert.deepEqual(
    options.map(item => [item.worldbookName, item.scope, item.selectedForWorkbench]),
    [
      ['core', 'character', false],
      ['global-book', 'global', true],
    ],
  );
  assert.deepEqual(
    (await sources.getWorldbookSources()).map(item => item.content),
    ['chat-book-content', 'global-book-content'],
  );
});

test('谱系资料同时登记整份谱系与可精确引用的人物节点', async () => {
  const namespace = { characterKey: '伊雍', chatId: 'chat-a' };
  const genealogies = new MemoryGenealogyRepository();
  const result: GenealogyRecord['result'] = {
    schema: 'eyon.genealogy.v2',
    requestId: 'genealogy-1',
    focusCharacterId: 'focus-1',
    focusCharacterName: '维奥莱塔',
    depth: { ancestors: 2, descendants: 1, maxPerGeneration: 4 },
    nodes: [{
      id: 'aunt-1',
      mvuId: '',
      name: '阿黛拉',
      aliases: [],
      generation: -1,
      isFocus: false,
      isMvuCharacter: false,
      viewable: true,
      canInjectToRuin: true,
      provenance: 'inferred',
      birth: {
        status: 'known', era: '复兴纪元', year: 430, month: null,
        day: null, precision: 'approximate', label: '约复兴纪元430年',
      },
      death: {
        status: 'unknown', era: '', year: null, month: null,
        day: null, precision: 'unknown', label: '卒年不详',
      },
      race: '人类',
      identities: ['皇族旁系'],
      professions: ['宫廷史官'],
      lifeLevel: '',
      relationToFocus: '姑母',
      summary: '曾经整理皇族旧档案。',
      profile: {
        personality: '谨慎而执着。',
        lifeExperience: '长期任职于宫廷档案馆。',
      },
      sourceRefs: [],
      historyRefs: [],
    }],
    edges: [],
    referenceSummary: {
      familyNames: ['奥古斯塔'],
      knownResidences: ['帝都'],
      knownOrganizations: ['宫廷档案馆'],
      brief: '皇族谱系资料。',
    },
    qualityChecks: {
      focusIsMvuCharacter: true,
      generatedNodesHaveProvenance: true,
      allNodesHaveLifeDates: true,
      allNodesHaveBasicProfiles: true,
      onlyMvuNodesCanInjectToRuin: true,
      noConflictNarrative: true,
    },
  };
  await genealogies.save({
    key: genealogyRecordKey(namespace, result.requestId),
    namespace,
    requestId: result.requestId,
    triggerMessageId: 5,
    triggerTextHash: 'hash',
    triggerSwipeId: null,
    sourceHash: 'source-hash',
    input: {
      focusCharacter: { mvuId: 'focus-1', name: '维奥莱塔', aliases: [] },
      depth: result.depth,
    },
    result,
    createdAt: 100,
  });

  const sources = new TavernContextSourceProvider(
    bindings(),
    new MemoryBiographyRepository(),
    genealogies,
    () => namespace,
  );
  const genealogySources = await sources.getGenealogySources();
  assert.deepEqual(
    genealogySources.map(item => item.sourceId),
    ['genealogy:genealogy-1', 'genealogy:genealogy-1:aunt-1'],
  );
  assert.match(genealogySources[1].title, /阿黛拉/u);
  assert.doesNotMatch(genealogySources[1].content, /宫廷史官/u);
  assert.match(genealogySources[1].content, /待核实/u);
  assert.equal((await genealogies.list(namespace))[0].result.nodes[0].professions[0], '宫廷史官');
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

test('玩家楼发送器在创建消息前完成事务回调', async () => {
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [{
    message_id: 0,
    role: 'assistant',
    message: '墟境探索正文',
  }];
  const calls: string[] = [];
  const adapter = new SerializedTavernUserTurnAdapter(
    runtime(messages),
    bindings({
      createUserMessage: async text => {
        calls.push(`create:${text}`);
        messages.push({ message_id: 1, role: 'user', message: text });
      },
      triggerReply: async () => {
        calls.push('trigger');
      },
    }),
  );
  const result = await adapter.sendUserTurn('遣返', {
    beforeCreate: async expectedMessageId => {
      calls.push(`freeze:${expectedMessageId}`);
      assert.equal(messages.at(-1)?.role, 'assistant');
    },
  });
  assert.deepEqual(result, { messageId: 1 });
  assert.deepEqual(calls, ['freeze:1', 'create:遣返', 'trigger']);
});

test('玩家楼发送器在核验建楼后、元数据确认与触发正文前释放宿主输入框', async () => {
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [{
    message_id: 0,
    role: 'assistant',
    message: '墟境探索正文',
  }];
  const calls: string[] = [];
  const adapter = new SerializedTavernUserTurnAdapter(
    runtime(messages),
    bindings({
      createUserMessage: async text => {
        calls.push(`create:${text}`);
        messages.push({ message_id: 1, role: 'user', message: text });
      },
      triggerReply: async () => {
        calls.push('trigger');
      },
    }),
    {
      onUserFloorCreated: async (text, messageId) => {
        calls.push(`clear:${messageId}:${text}`);
      },
    },
  );

  const result = await adapter.sendUserTurn('任务完成，遣返吧', {
    beforeCreate: async expectedMessageId => {
      calls.push(`freeze:${expectedMessageId}`);
    },
    afterCreate: async messageId => {
      calls.push(`confirm:${messageId}`);
    },
  });

  assert.deepEqual(result, { messageId: 1 });
  assert.deepEqual(calls, [
    'freeze:1',
    'create:任务完成，遣返吧',
    'clear:1:任务完成，遣返吧',
    'confirm:1',
    'trigger',
  ]);
});

test('玩家楼没有通过唯一楼校验时不清空输入框也不触发正文', async () => {
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [{ message_id: 0, role: 'assistant', message: '墟境正文' }];
  const calls: string[] = [];
  const adapter = new SerializedTavernUserTurnAdapter(
    runtime(messages),
    bindings({
      createUserMessage: async () => {
        calls.push('create');
        messages.push({ message_id: 1, role: 'user', message: '被宿主改写的内容' });
      },
      triggerReply: async () => {
        calls.push('trigger');
      },
    }),
    {
      onUserFloorCreated: async () => {
        calls.push('clear');
      },
    },
  );

  await assert.rejects(
    adapter.sendUserTurn('任务完成，遣返吧'),
    /没有建立预期的唯一玩家楼/u,
  );
  assert.deepEqual(calls, ['create']);
});

test('取消预发送玩家楼不会堵住下一次遣返重试', async () => {
  const messages: Array<{
    message_id: number;
    role: 'user' | 'assistant' | 'system';
    message: string;
  }> = [{ message_id: 0, role: 'assistant', message: '墟境正文' }];
  const calls: string[] = [];
  const adapter = new SerializedTavernUserTurnAdapter(
    runtime(messages),
    bindings({
      createUserMessage: async text => {
        calls.push(`create:${text}`);
        messages.push({ message_id: messages.length, role: 'user', message: text });
      },
      triggerReply: async () => { calls.push('trigger'); },
    }),
  );
  const controller = new AbortController();
  const first = adapter.sendUserTurn('遣返', {
    signal: controller.signal,
    beforeCreate: async () => new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(controller.signal.reason);
      }, { once: true });
    }),
  });
  controller.abort(new Error('generation was cancelled'));
  await assert.rejects(first, /generation was cancelled/u);

  const second = await adapter.sendUserTurn('遣返');
  assert.deepEqual(second, { messageId: 1 });
  assert.deepEqual(calls, ['create:遣返', 'trigger']);
});

test('脚本设置保留其他脚本变量，并为四个生成模块提供默认接口', async () => {
  let variables: Record<string, unknown> = { unrelated: 7 };
  const settings = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables,
    replaceScriptVariables: next => {
      variables = next;
    },
  });
  const defaults = settings.read();
  assert.equal(defaults.ruinPreferences.candidateCount, 3);
  assert.deepEqual(defaults.retrieval, {
    biographyEnabled: false,
    worldbookScope: 'eyon',
    mergeAliases: true,
    worldbookEntryExclusions: {},
  });
  assert.deepEqual(await settings.get('ruin'), {
    apiurl: '',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 60000,
    temperature: 0.8,
  });
  settings.setGeneration('ruin', {
    apiurl: 'https://example.com/v1',
    key: 'secret',
    model: 'model-a',
    source: 'openai',
    maxTokens: 4096,
    temperature: 0.7,
  });
  assert.deepEqual(await settings.get('genealogy'), {
    apiurl: '',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 60000,
    temperature: 0.8,
  });
  assert.equal((await settings.get('ruin')).model, 'model-a');
  assert.throws(() => settings.applyGenerationToAll({
    apiurl: '', key: '', model: '', source: 'openai', maxTokens: 4096, temperature: 0.8,
  }), /地址为空/u, '未配置模块可读取，但显式保存不能覆盖为一个空地址');
  settings.applyGenerationToAll({
    apiurl: 'https://example.com/v1',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 4096,
    temperature: 0.8,
  });
  assert.deepEqual(await settings.get('butterfly'), {
    apiurl: 'https://example.com/v1',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 4096,
    temperature: 0.8,
  });
  settings.update({ ruinDraft: null });
  assert.equal(variables.unrelated, 7);
  assert.ok('eyonHistoryWorkbench' in variables);
});

test('年龄基准按角色卡与聊天隔离，旧版全局值不污染新聊天', () => {
  let variables: Record<string, unknown> = {
    eyonHistoryWorkbench: {
      // 模拟旧版本曾在另一份存档锁定的全局年份。
      baselineWorldTime: '复兴纪元496年',
    },
  };
  const settings = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables,
    replaceScriptVariables: next => {
      variables = next;
    },
  });
  const first = { characterKey: '伊雍', chatId: 'chat-old' };
  const second = { characterKey: '伊雍', chatId: 'chat-new' };

  assert.equal(settings.getBaselineWorldTime(first), null, '旧全局年份不得冒充当前聊天基准');
  assert.equal(settings.ensureBaselineWorldTime(first, '复兴纪元496年'), '复兴纪元496年');
  assert.equal(settings.ensureBaselineWorldTime(second, '复兴纪元488年'), '复兴纪元488年');
  assert.equal(settings.getBaselineWorldTime(first), '复兴纪元496年');
  assert.equal(settings.getBaselineWorldTime(second), '复兴纪元488年');
  assert.equal(
    settings.ensureBaselineWorldTime(second, '复兴纪元481年'),
    '复兴纪元488年',
    '同一聊天进入历史后不得让基准随楼层漂移',
  );
});

test('旧版 { mode: follow_tavern | custom } 生成设置自动迁移为新结构', async () => {
  let variables: Record<string, unknown> = {
    unrelated: 1,
    eyonHistoryWorkbench: {
      generation: {
        genealogy: { mode: 'follow_tavern' },
        ruin: {
          mode: 'custom',
          custom: {
            apiurl: 'https://example.com/v1',
            key: 'k',
            model: 'm',
            source: 'openai',
            maxTokens: 2048,
            temperature: 0.5,
          },
        },
      },
    },
  };
  const settings = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables,
    replaceScriptVariables: next => {
      variables = next;
    },
  });
  // follow_tavern → 空配置（未配置）
  assert.deepEqual(await settings.get('genealogy'), {
    apiurl: '',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 60000,
    temperature: 0.8,
  });
  // custom → 展开 custom 字段，key 原样保留
  assert.deepEqual(await settings.get('ruin'), {
    apiurl: 'https://example.com/v1',
    key: 'k',
    model: 'm',
    source: 'openai',
    maxTokens: 2048,
    temperature: 0.5,
  });
  // 未配置的模块补默认值
  assert.deepEqual(await settings.get('butterfly'), {
    apiurl: '',
    key: '',
    model: '',
    source: 'openai',
    maxTokens: 60000,
    temperature: 0.8,
  });
});
