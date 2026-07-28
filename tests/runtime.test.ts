import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyPreparation } from '../src/workflows/biography.ts';
import type {
  RuntimeChatMessage,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  TavernBiographyShellAdapter,
  type BiographyFloorLock,
} from '../src/runtime/tavernBiographyShell.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import {
  TavernGenerationAdapter,
  type GenerationSettingsProvider,
} from '../src/runtime/tavernGeneration.ts';
import {
  BiographyLifecycle,
  type BiographyLifecycleController,
} from '../src/runtime/biographyLifecycle.ts';
import { registerBiographyLifecycle } from '../src/runtime/registerLifecycle.ts';
import { BiographyController } from '../src/runtime/biographyController.ts';
import type { BiographyWorkflow } from '../src/workflows/biography.ts';

function makePreparation(): BiographyPreparation {
  return {
    requestId: 'request-1',
    biographyId: 'bio-request-1',
    recordKey: 'record-1',
    scope: {
      namespace: {
        characterKey: '命定之诗',
        chatId: '存档一',
      },
      triggerMessageId: 8,
    },
    sourceHash: 'source-hash',
    slot: '[EYON_ROOTTRACE_SLOT::request-1]',
    instruction: '只生成伊雍的自然开场，并保留插槽。',
    rootTrace: '[RootTrace]\nTitle:: 示例\n[/RootTrace]',
  };
}

class FakeRuntime implements TavernRuntime {
  characterKey = '命定之诗';
  chatId = '存档一';
  lastMessageId = 9;
  messages = new Map<number, RuntimeChatMessage>([
    [8, {
      message_id: 8,
      role: 'user',
      message: '对维奥莱塔进行寻根溯源',
      swipe_id: 0,
    }],
    [9, {
      message_id: 9,
      role: 'assistant',
      message: '<eyon_court/>\n[EYON_ROOTTRACE_SLOT::request-1]',
      swipe_id: 0,
    }],
  ]);
  prompts = new Map<string, string>();
  rawCalls: unknown[] = [];

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
    const value = this.messages.get(messageId)?.swipe_id;
    return Number.isInteger(value) ? value! : null;
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

  async setChatMessages(
    updates: Array<{
      message_id: number;
      message?: string;
      data?: Record<string, unknown>;
      extra?: Record<string, unknown>;
    }>,
  ) {
    for (const update of updates) {
      const message = this.messages.get(update.message_id);
      if (!message) throw new Error('missing message');
      if (update.message !== undefined) message.message = update.message;
      if (update.data !== undefined) message.data = structuredClone(update.data);
      if (update.extra !== undefined) message.extra = structuredClone(update.extra);
    }
  }

  setExtensionPrompt(key: string, value: string) {
    this.prompts.set(key, value);
  }

  async generate() {
    return '';
  }

  async generateRaw(config: unknown) {
    this.rawCalls.push(config);
    return '{"ok":true}';
  }
}

function makeLock(): BiographyFloorLock {
  return {
    preparation: makePreparation(),
    triggerTextHash: fingerprintText('对维奥莱塔进行寻根溯源'),
    triggerSwipeId: 0,
  };
}

test('传记注入只武装扩展提示，不创建或抢占助手楼', () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  shell.arm(makeLock());
  assert.equal(runtime.messages.size, 2);
  assert.equal(
    runtime.prompts.get('eyon-history-biography-request-1'),
    '只生成伊雍的自然开场，并保留插槽。',
  );
});

test('精确楼层锁允许同一聊天中紧邻的自然助手楼提交', async () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const lock = makeLock();
  await shell.assertRenderedFloor(lock, 9);
  await shell.attachRequestMetadata(lock, 9);
  const metadata = runtime.messages.get(9)?.extra?.eyonHistoryRequest as
    | Record<string, unknown>
    | undefined;
  assert.equal(metadata?.requestId, 'request-1');
  assert.equal(metadata?.triggerMessageId, 8);
  assert.equal(metadata?.sourceHash, 'source-hash');
});

test('聊天、玩家文本、swipe 或助手楼任一变化都会拒绝错绑', async () => {
  const cases: Array<(runtime: FakeRuntime) => void> = [
    runtime => {
      runtime.chatId = '另一个存档';
    },
    runtime => {
      runtime.messages.get(8)!.message = '已经编辑过的命令';
    },
    runtime => {
      runtime.messages.get(8)!.swipe_id = 1;
    },
    runtime => {
      runtime.lastMessageId = 10;
    },
  ];

  for (const mutate of cases) {
    const runtime = new FakeRuntime();
    const shell = new TavernBiographyShellAdapter(runtime);
    mutate(runtime);
    await assert.rejects(() => shell.assertRenderedFloor(makeLock(), 9));
  }
});

test('独立生成接口支持跟随酒馆与自定义端点，且始终静默返回文本', async () => {
  const runtime = new FakeRuntime();
  let value: unknown = { mode: 'follow_tavern' };
  const settings: GenerationSettingsProvider = {
    async get() {
      return value;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation-1');
  await adapter.generate('biography', 'prompt-one');
  assert.deepEqual(runtime.rawCalls[0], {
    generation_id: 'generation-1',
    user_input: '',
    should_stream: false,
    should_silence: true,
    ordered_prompts: [{ role: 'system', content: 'prompt-one' }],
  });

  value = {
    mode: 'custom',
    custom: {
      apiurl: 'https://example.com/v1',
      key: 'secret',
      model: 'model-a',
      source: 'openai',
      maxTokens: 4096,
      temperature: 0.7,
    },
  };
  await adapter.generate('ruin', 'prompt-two');
  assert.deepEqual(runtime.rawCalls[1], {
    generation_id: 'generation-1',
    user_input: '',
    should_stream: false,
    should_silence: true,
    ordered_prompts: [{ role: 'system', content: 'prompt-two' }],
    custom_api: {
      apiurl: 'https://example.com/v1',
      key: 'secret',
      model: 'model-a',
      source: 'openai',
      max_tokens: 4096,
      temperature: 0.7,
    },
  });
});

test('生成拦截器只读取最新可见玩家楼，续写与静默请求不触发传记', async () => {
  const runtime = new FakeRuntime();
  const prepared: string[] = [];
  const controller: BiographyLifecycleController = {
    async prepareText(text) {
      prepared.push(text);
      return {};
    },
    async commitRendered() {
      return null;
    },
    async cancelPending() {},
  };
  const lifecycle = new BiographyLifecycle(controller, runtime);
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.deepEqual(prepared, ['对维奥莱塔进行寻根溯源']);
  assert.equal(await lifecycle.beforeGeneration('continue'), false);
  assert.equal(await lifecycle.beforeGeneration('quiet'), false);
  assert.equal(prepared.length, 1);
});

test('注册层公开 manifest 拦截器，并在助手渲染和切聊天时转发生命周期', async () => {
  const calls: string[] = [];
  const lifecycle = {
    async beforeGeneration(type?: string) {
      calls.push(`before:${type}`);
      return true;
    },
    async onAssistantRendered(messageId: number) {
      calls.push(`rendered:${messageId}`);
    },
    async onChatChanged() {
      calls.push('changed');
    },
  } as BiographyLifecycle;
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const events = {
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
    off(event: string) {
      listeners.delete(event);
    },
  };
  const globals: Record<string, unknown> = {};
  const registration = registerBiographyLifecycle(
    lifecycle,
    events,
    {
      characterMessageRendered: 'rendered',
      chatChanged: 'changed',
    },
    globals,
  );
  const interceptor = globals.eyon_history_generateInterceptor as
    | ((chat: unknown, size: number, abort: () => void, type: string) => Promise<void>)
    | undefined;
  assert.ok(interceptor);
  await interceptor([], 0, () => {}, 'normal');
  listeners.get('rendered')?.(9, 'normal');
  listeners.get('changed')?.('存档二');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['before:normal', 'rendered:9', 'changed']);
  registration.dispose();
  assert.equal(globals.eyon_history_generateInterceptor, undefined);
  assert.equal(listeners.size, 0);
});

test('控制器对同一玩家楼幂等准备，并只在锁定助手楼渲染后提交', async () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const preparation = makePreparation();
  let prepareCount = 0;
  let commitCount = 0;
  const workflow = {
    async prepare() {
      prepareCount += 1;
      return preparation;
    },
    async commit(_preparation: BiographyPreparation, messageId: number) {
      commitCount += 1;
      return {
        requestId: 'request-1',
        biographyId: 'bio-request-1',
        assistantMessageId: messageId,
        warning: 'none' as const,
      };
    },
  } as unknown as BiographyWorkflow;
  const controller = new BiographyController(
    workflow,
    shell,
    runtime,
    async () => preparation.scope,
  );

  const first = await controller.prepareText('对维奥莱塔进行寻根溯源');
  const second = await controller.prepareText('对维奥莱塔进行寻根溯源');
  assert.ok(first);
  assert.ok(second);
  assert.equal(prepareCount, 1);
  assert.equal(commitCount, 0);

  const result = await controller.commitRendered(9);
  assert.equal(result?.assistantMessageId, 9);
  assert.equal(commitCount, 1);
  assert.equal(
    runtime.prompts.get('eyon-history-biography-request-1'),
    '',
  );
  assert.equal(await controller.commitRendered(9), null);
  assert.equal(commitCount, 1);
});
