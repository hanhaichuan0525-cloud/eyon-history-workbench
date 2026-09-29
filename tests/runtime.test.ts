import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyPreparation } from '../src/workflows/biography.ts';
import type {
  RuntimeChatMessage,
  RuntimeCustomApi,
  RuntimePrompt,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  TavernBiographyShellAdapter,
  type BiographyFloorLock,
} from '../src/runtime/tavernBiographyShell.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import {
  GenerationCancelledError,
  TavernGenerationAdapter,
  type GenerationSettingsProvider,
} from '../src/runtime/tavernGeneration.ts';
import { CustomApiRequestError } from '../src/runtime/tavernRuntimeAdapter.ts';
import {
  GENERATION_ERROR_CODES,
  toGenerationFailureEnvelope,
  generationKind,
} from '../src/runtime/generationError.ts';
import { BiographyValidationError } from '../src/validators/biography.ts';
import {
  BiographyLifecycle,
  type BiographyLifecycleController,
} from '../src/runtime/biographyLifecycle.ts';
import { registerBiographyLifecycle } from '../src/runtime/registerLifecycle.ts';
import { createGlobalEventBridge } from '../src/runtime/globalBindings.ts';
import { BiographyController } from '../src/runtime/biographyController.ts';
import type { BiographyWorkflow } from '../src/workflows/biography.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';

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
      // 与宿主（JS-Slash-Runner）一致：extra 写入时同步双写到
      // swipeInfo[swipe_id].extra，随 swipe/删楼/分支正确回滚。
      if (update.extra !== undefined) {
        message.extra = structuredClone(update.extra);
        const swipeId = message.swipe_id ?? 0;
        message.swipeInfo ??= [];
        message.swipeInfo[swipeId] = {
          ...(message.swipeInfo[swipeId] ?? {}),
          extra: structuredClone(update.extra),
        };
      }
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
      runtime.messages.set(10, {
        message_id: 10,
        role: 'user',
        message: '这是另一轮可见玩家输入',
        swipe_id: 0,
      });
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

test('重 roll 后的新助手楼可跨过隐藏系统楼提交', async () => {
  const runtime = new FakeRuntime();
  runtime.messages.delete(9);
  runtime.messages.set(10, {
    message_id: 10,
    role: 'system',
    message: 'MVU hidden bridge',
    is_hidden: true,
  });
  runtime.messages.set(11, {
    message_id: 11,
    role: 'system',
    message: 'another hidden bridge',
    is_hidden: true,
  });
  runtime.messages.set(12, {
    message_id: 12,
    role: 'assistant',
    message: '伊雍重新生成的开场',
    swipe_id: 1,
  });
  runtime.lastMessageId = 12;
  const shell = new TavernBiographyShellAdapter(runtime);

  const reuseLock: BiographyFloorLock = {
    ...makeLock(),
    reuse: true,
  };
  await shell.assertRenderedFloor(reuseLock, 12);
  await shell.assertRenderedFloor(makeLock(), 12);
});

test('独立生成接口始终使用自定义端点（generateRaw 兜底），且始终静默返回文本', async () => {
  const runtime = new FakeRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://example.com/v1',
        key: 'secret',
        model: 'model-a',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation-1');
  await adapter.generate('ruin', 'prompt-two');
  assert.deepEqual(runtime.rawCalls[0], {
    generation_id: 'generation-1',
    user_input: 'prompt-two',
    should_stream: false,
    should_silence: true,
    max_chat_history: 0,
    ordered_prompts: [
      {
        role: 'system',
        content: '你是伊雍墟境历史流水线的 JSON 编译器。用户消息中的 HISTORICAL_AUTHORITY_READ_ONLY 是本次创作的史料权威层，必须优先沿用其中的既有人物、组织、地点、制度与事件，不得用无关新造设定取代。用户消息中的 REFERENCE_DATA_READ_ONLY 是任务索引与输出约束。两个只读区块均严禁回显。先识别当前消息要求的是全候选规划还是单候选扩写，再只返回该 MANDATORY_FINAL_OUTPUT_CONTRACT 指定 schema 的 JSON 对象。规划阶段保持简洁并统一命名；扩写阶段按 RUIN_RULES 完成创作与自检。不得输出解释、Markdown、输入上下文或其他结构。',
      },
      'user_input',
    ],
    custom_api: {
      apiurl: 'https://example.com/v1',
      key: 'secret',
      model: 'model-a',
      source: 'openai',
      max_tokens: 60000,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    },
  });
});

test('自定义端点优先使用酒馆后端直连通道并保留 OpenAI 响应结构', async () => {
  class DirectCustomRuntime extends FakeRuntime {
    customCalls: unknown[] = [];

    async generateCustomRaw(config: unknown) {
      this.customCalls.push(config);
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"direct":true}' },
        }],
      };
    }
  }

  const runtime = new DirectCustomRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'unused-id');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"direct":true}');
  assert.equal(runtime.rawCalls.length, 0);
  const customCall = runtime.customCalls[0] as {
    signal?: AbortSignal;
    messages: unknown[];
    custom_api: unknown;
  };
  assert.equal(customCall.signal instanceof AbortSignal, true);
  assert.deepEqual({ messages: customCall.messages, custom_api: customCall.custom_api }, {
    messages: [
      {
        role: 'system',
        content: '你是伊雍墟境历史流水线的 JSON 编译器。用户消息中的 HISTORICAL_AUTHORITY_READ_ONLY 是本次创作的史料权威层，必须优先沿用其中的既有人物、组织、地点、制度与事件，不得用无关新造设定取代。用户消息中的 REFERENCE_DATA_READ_ONLY 是任务索引与输出约束。两个只读区块均严禁回显。先识别当前消息要求的是全候选规划还是单候选扩写，再只返回该 MANDATORY_FINAL_OUTPUT_CONTRACT 指定 schema 的 JSON 对象。规划阶段保持简洁并统一命名；扩写阶段按 RUIN_RULES 完成创作与自检。不得输出解释、Markdown、输入上下文或其他结构。',
      },
      { role: 'user', content: 'candidate prompt' },
    ],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: 'secret',
      model: 'deepseek-chat',
      source: 'openai',
      max_tokens: 60000,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    },
  });
});

test('独立 API 的多个完整 choice 不会被拼成多个 JSON 对象', async () => {
  class MultipleChoiceRuntime extends FakeRuntime {
    async generateCustomRaw() {
      return {
        choices: [
          { index: 0, message: { content: '{"choice":0}' }, finish_reason: 'stop' },
          { index: 1, message: { content: '{"choice":1}' }, finish_reason: 'stop' },
        ],
      };
    }
  }

  const runtime = new MultipleChoiceRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'unused-id');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"choice":0}');
});

test('独立 API 的流式事件数组只拼接首个 choice 的内容片段', async () => {
  class StreamEventRuntime extends FakeRuntime {
    async generateCustomRaw() {
      return [
        { choices: [{ index: 0, delta: { content: '{"stream":' } }] },
        { choices: [{ index: 0, delta: { content: 'true}' } }] },
      ];
    }
  }

  const runtime = new StreamEventRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'unused-id');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"stream":true}');
});

test('DeepSeek 推理字段不会被误当成最终 JSON', async () => {
  class ReasoningRuntime extends FakeRuntime {
    attempts = 0;

    async generateCustomRaw() {
      this.attempts += 1;
      return {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '{"direct":true}',
            reasoning_content: '这段推理不得进入答案。',
          },
        }],
      };
    }
  }

  const runtime = new ReasoningRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-reasoner',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 1;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"direct":true}');
  assert.equal(runtime.attempts, 1);
});

test('独立 API 的半截 JSON 会按截断重试并提高输出额度', async () => {
  class TruncatedRuntime extends FakeRuntime {
    customCalls: number[] = [];

    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
    }) {
      this.customCalls.push(config.custom_api.max_tokens ?? 0);
      if (this.customCalls.length === 1) {
        return {
          choices: [{
            finish_reason: 'length',
            message: { content: '{"schema":"eyon.ruin.candidate.v1","candidate":{' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"complete":true}' },
        }],
      };
    }
  }

  const runtime = new TruncatedRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.example.com',
        key: 'secret',
        model: 'custom-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 1;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"complete":true}');
  assert.deepEqual(runtime.customCalls, [60000, 60000]);
});

test('独立 API 的连续截断只补救一次，避免重复长请求', async () => {
  class RepeatedTruncationRuntime extends FakeRuntime {
    customCalls: number[] = [];

    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
    }) {
      this.customCalls.push(config.custom_api.max_tokens ?? 0);
      if (this.customCalls.length < 3) {
        return {
          choices: [{
            finish_reason: 'length',
            message: { content: '{"schema":"eyon.ruin.outlines.v1"' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"complete":true}' },
        }],
      };
    }
  }

  const runtime = new RepeatedTruncationRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.example.com',
        key: 'secret',
        model: 'custom-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 0;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  await assert.rejects(
    () => adapter.generate('ruin', 'candidate prompt'),
    /truncated/u,
  );
  assert.deepEqual(runtime.customCalls, [60000]);
});

test('输出额度顶格（60000）时截断仍原样重试一次，第二次成功', async () => {  class CapTruncatedRuntime extends FakeRuntime {
    customCalls: number[] = [];

    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
    }) {
      this.customCalls.push(config.custom_api.max_tokens ?? 0);
      if (this.customCalls.length === 1) {
        return {
          choices: [{
            finish_reason: 'length',
            message: { content: '{"schema":"eyon.biography.passage.batch.v1","passages":[' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"complete":true}' },
        }],
      };
    }
  }

  const runtime = new CapTruncatedRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 8192,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 2;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  // 顶格 60000 无法翻倍：原样重试 1 次后成功，不再直接判死。
  assert.equal(await adapter.generate('biography', 'batch prompt'), '{"complete":true}');
  assert.deepEqual(runtime.customCalls, [60000, 60000]);
});

test('畸形 JSON（语法错误但括号闭合）归入截断类，重试一次后成功', async () => {
  class MalformedJsonRuntime extends FakeRuntime {
    attempts = 0;

    async generateCustomRaw(): Promise<unknown> {
      this.attempts += 1;
      if (this.attempts === 1) {
        return {
          choices: [{
            finish_reason: 'stop',
            message: { content: '{"schema":"eyon.biography.plan.v1" "requestId":"x"}' },
          }],
        };
      }
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '{"complete":true}' },
        }],
      };
    }
  }

  const runtime = new MalformedJsonRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 8192,
        temperature: 0.7,
      };
    },
    getRetryLimit: () => 2,
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  // 畸形 JSON 不再流到校验器报 "Expected ':' after property name"，而是走截断重试。
  assert.equal(await adapter.generate('biography', 'plan prompt'), '{"complete":true}');
  assert.equal(runtime.attempts, 2);
});

test('DeepSeek 一键结构化开启时墟境请求锁定 8192 有界预算', async () => {
  class DeepSeekRuntime extends FakeRuntime {
    customCalls: number[] = [];

    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
    }) {
      this.customCalls.push(config.custom_api.max_tokens ?? 0);
      return { choices: [{ message: { content: '{"complete":true}' } }] };
    }
  }

  const runtime = new DeepSeekRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getDeepseekStructured() {
      return true;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');

  assert.equal(await adapter.generate('ruin', 'candidate prompt'), '{"complete":true}');
  assert.deepEqual(runtime.customCalls, [8192]);
});

test('独立生成会对瞬时错误和空响应重试，并为每次请求换用新 ID', async () => {
  class TransientRuntime extends FakeRuntime {
    attempts = 0;

    override async generateRaw(config: unknown) {
      this.rawCalls.push(config);
      this.attempts += 1;
      if (this.attempts === 1) throw new Error('Got response status 502');
      if (this.attempts === 2) return '   ';
      return { choices: [{ message: { content: '{"ok":true}' } }] } as never;
    }
  }

  const runtime = new TransientRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {};
    },
    getRetryLimit() {
      return 2;
    },
  };
  let generation = 0;
  const retryProgress: Array<[number, number]> = [];
  const adapter = new TavernGenerationAdapter(
    runtime,
    settings,
    () => `generation-${++generation}`,
    {
      sleep: async () => undefined,
      random: () => 0,
      onRetry: (_taskType, attempt, max) => retryProgress.push([attempt, max]),
    },
  );
  assert.equal(await adapter.generate('ruin', 'prompt'), '{"ok":true}');
  assert.equal(runtime.attempts, 3);
  assert.equal(runtime.rawCalls.length, 3);
  assert.deepEqual(retryProgress, [[1, 2], [2, 2]]);
  assert.notEqual(
    (runtime.rawCalls[0] as { generation_id: string }).generation_id,
    (runtime.rawCalls[1] as { generation_id: string }).generation_id,
  );
});

test('独立生成会重试中转站包装后的 <none> 占位错误', async () => {
  class PlaceholderRuntime extends FakeRuntime {
    attempts = 0;

    override async generateRaw(_config: unknown): Promise<string> {
      this.attempts += 1;
      if (this.attempts === 1) {
        throw new CustomApiRequestError(
          'transport',
          'Custom API relay returned a placeholder error: <none>',
        );
      }
      return '{"ok":true}';
    }
  }

  const runtime = new PlaceholderRuntime();
  const retryProgress: Array<[number, number]> = [];
  const adapter = new TavernGenerationAdapter(
    runtime,
    {
      async get() {
        return {};
      },
      getRetryLimit() {
        return 2;
      },
    },
    () => 'generation',
    {
      sleep: async () => undefined,
      random: () => 0,
      onRetry: (_taskType, attempt, max) => retryProgress.push([attempt, max]),
    },
  );

  assert.equal(await adapter.generate('ruin', 'prompt'), '{"ok":true}');
  assert.equal(runtime.attempts, 2);
  assert.deepEqual(retryProgress, [[1, 2]]);
});

test('截断/瞬时故障重试成功后触发恢复留痕（onRecoveredAfterRetry）', async () => {
  class RecoveringRuntime extends FakeRuntime {
    attempts = 0;
    override async generateRaw(_config: unknown): Promise<string> {
      this.attempts += 1;
      if (this.attempts === 1) {
        throw new Error('API response was truncated (finish_reason=length)');
      }
      return '{"ok":true}';
    }
  }
  const runtime = new RecoveringRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {};
    },
    getRetryLimit() {
      return 2;
    },
  };
  const recovered: Array<{ successAttempt: number; error: string }> = [];
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation', {
    sleep: async () => undefined,
    random: () => 0,
    onRecoveredAfterRetry: (_taskType, info) => {
      recovered.push({
        successAttempt: info.successAttempt,
        error: info.error instanceof Error ? info.error.message : String(info.error),
      });
    },
  });
  const response = await adapter.generate('ruin', 'prompt');
  assert.equal(response, '{"ok":true}');
  assert.equal(runtime.attempts, 2);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].successAttempt, 2);
  assert.match(recovered[0].error, /truncated/u);
});

test('独立生成不会重试不可恢复的授权错误', async () => {
  class UnauthorizedRuntime extends FakeRuntime {
    attempts = 0;

    override async generateRaw(_config: unknown): Promise<string> {
      this.attempts += 1;
      throw new Error('Unauthorized');
    }
  }

  const runtime = new UnauthorizedRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {};
    },
    getRetryLimit() {
      return 3;
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');
  await assert.rejects(() => adapter.generate('ruin', 'prompt'), /Unauthorized/u);
  assert.equal(runtime.attempts, 1);
});

test('生成拦截器不会在下一个助手楼误复用旧传记命令', async () => {
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
  runtime.lastMessageId = 8;
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.deepEqual(prepared, ['对维奥莱塔进行寻根溯源']);
  runtime.lastMessageId = 9;
  assert.equal(await lifecycle.beforeGeneration(), false);
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.equal(await lifecycle.beforeGeneration('continue'), false);
  assert.equal(await lifecycle.beforeGeneration('quiet'), false);
  assert.equal(prepared.length, 1);
  assert.equal(await lifecycle.beforeGeneration('regenerate'), true);
  assert.deepEqual(prepared, [
    '对维奥莱塔进行寻根溯源',
    '对维奥莱塔进行寻根溯源',
  ]);
});

test('注册层直接监听发送前事件，并兼容 manifest 拦截器与后续生命周期', async () => {
  const calls: string[] = [];
  const lifecycle = {
    async beforeGeneration(type?: string) {
      calls.push(`before:${type}`);
      return true;
    },
    async onUserMessageSent(messageId: number) {
      calls.push(`sent:${messageId}`);
      return false;
    },
    async onAssistantRendered(messageId: number) {
      calls.push(`rendered:${messageId}`);
    },
    async onChatChanged() {
      calls.push('changed');
    },
  } as unknown as BiographyLifecycle;
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
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
      generationAfterCommands: 'before',
      characterMessageRendered: 'rendered',
      chatChanged: 'changed',
      messageSent: 'sent',
    },
    globals,
  );
  const interceptor = globals.eyon_history_generateInterceptor as
    | ((chat: unknown, size: number, abort: () => void, type: string) => Promise<void>)
    | undefined;
  assert.ok(interceptor);
  listeners.get('sent')?.(8);
  await listeners.get('before')?.('normal', {}, false);
  await listeners.get('before')?.('normal', {}, true);
  listeners.get('rendered')?.(9, 'normal');
  listeners.get('changed')?.('存档二');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['sent:8', 'before:normal', 'rendered:9', 'changed']);
  registration.dispose();
  assert.equal(globals.eyon_history_generateInterceptor, undefined);
  assert.equal(listeners.size, 0);
});

test('全局事件桥暴露 MESSAGE_SENT，并在旧宿主缺失时安全降级', () => {
  const subscriptions: Array<{ event: string; stopped: boolean }> = [];
  const makeGlobal = (withMessageSent: boolean) => ({
    eventOn(event: string) {
      const subscription = { event, stopped: false };
      subscriptions.push(subscription);
      return { stop: () => { subscription.stopped = true; } };
    },
    tavern_events: {
      GENERATION_AFTER_COMMANDS: 'before',
      CHARACTER_MESSAGE_RENDERED: 'rendered',
      CHAT_CHANGED: 'changed',
      ...(withMessageSent ? { MESSAGE_SENT: 'sent' } : {}),
    },
  });
  assert.equal(createGlobalEventBridge(makeGlobal(true)).names.messageSent, 'sent');
  assert.equal(createGlobalEventBridge(makeGlobal(false)).names.messageSent, undefined);
});

test('发送前准备失败会停止本轮正文并清除临时状态', async () => {
  const calls: string[] = [];
  const lifecycle = {
    async beforeGeneration() {
      throw new Error('biography api failed');
    },
    async onAssistantRendered() {},
    async onChatChanged() {
      calls.push('cleared');
    },
  } as unknown as BiographyLifecycle;
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  const events = {
    on(event: string, listener: (...args: unknown[]) => unknown) {
      listeners.set(event, listener);
    },
    off(event: string) {
      listeners.delete(event);
    },
  };
  let stopped = 0;
  const globals: Record<string, unknown> = {
    SillyTavern: {
      getContext: () => ({
        stopGeneration: () => {
          stopped += 1;
          return true;
        },
      }),
    },
  };
  const registration = registerBiographyLifecycle(
    lifecycle,
    events,
    {
      generationAfterCommands: 'before',
      characterMessageRendered: 'rendered',
      chatChanged: 'changed',
    },
    globals,
  );

  await assert.rejects(
    async () => listeners.get('before')?.('normal', {}, false),
    /biography api failed/u,
  );
  assert.equal(stopped, 1);
  assert.deepEqual(calls, ['cleared']);
  registration.dispose();
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
    async findCommittedByTrigger() {
      return null;
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

test('流式未结束时提交被推迟，流式结束后才写入', async () => {  class StreamingRuntime extends FakeRuntime {
    generating = true;
    isGenerating() {
      return this.generating;
    }
  }
  const runtime = new StreamingRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const preparation = makePreparation();
  let commitCount = 0;
  const workflow = {
    async prepare() {
      return preparation;
    },
    async findCommittedByTrigger() {
      return null;
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

  await controller.prepareText('对维奥莱塔进行寻根溯源');
  // 流式未结束：court 已出现但正文还在流出 → 不提交，锁保留
  const early = await controller.commitRendered(9);
  assert.equal(early, null);
  assert.equal(commitCount, 0);
  assert.equal(
    runtime.prompts.get('eyon-history-biography-request-1'),
    '',
    '目标正文楼一旦确认，传记提示租约应立即释放，不能污染下一楼',
  );
  // 流式结束后的渲染事件：提交成功
  runtime.generating = false;
  const result = await controller.commitRendered(9);
  assert.equal(result?.assistantMessageId, 9);
  assert.equal(commitCount, 1);
});

test('下一轮可见玩家输入会销毁过期传记事务，不再向后续正文重复注入', async () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const preparation = makePreparation();
  let commitCount = 0;
  const controller = new BiographyController(
    {
      async prepare() { return preparation; },
      async findCommittedByTrigger() { return null; },
      async commit() {
        commitCount += 1;
        throw new Error('stale biography must not commit');
      },
    } as unknown as BiographyWorkflow,
    shell,
    runtime,
    async () => preparation.scope,
  );

  await controller.prepareText('对维奥莱塔进行寻根溯源');
  assert.match(
    runtime.prompts.get('eyon-history-biography-request-1') ?? '',
    /只生成伊雍的自然开场/u,
  );
  runtime.messages.set(10, {
    message_id: 10,
    role: 'user',
    message: '我继续处理今天的政务。',
    swipe_id: 0,
  });
  runtime.lastMessageId = 10;

  await controller.releaseStaleNarrative(10);
  assert.equal(runtime.prompts.get('eyon-history-biography-request-1'), '');
  assert.equal(await controller.commitRendered(9), null);
  assert.equal(commitCount, 0);
});

test('重 roll 复用已提交传记，不再重新规划扩写', async () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const preparation = makePreparation();
  let prepareCount = 0;
  const record = {
    key: 'record-committed',
    namespace: preparation.scope.namespace,
    biographyId: 'bio-committed',
    requestId: 'old-request',
    triggerMessageId: preparation.scope.triggerMessageId,
    assistantMessageId: 9,
    sourceHash: 'source-hash',
    status: 'committed',
    revision: 1,
    biography: {
      target: { name: '维奥莱塔' },
      playerDirective: {
        raw: '对维奥莱塔进行寻根溯源',
        primaryDirection: '猎艳史',
      },
      span: { label: '24岁至28岁' },
      rootTrace: '[RootTrace]\nTitle:: 《维奥莱塔》\n[/RootTrace]',
    },
    createdAt: 1000,
    updatedAt: 2000,
  } as unknown as BiographyRecord;
  const workflow = {
    async prepare() {
      prepareCount += 1;
      return preparation;
    },
    async findCommittedByTrigger() {
      return record;
    },
  } as unknown as BiographyWorkflow;
  const controller = new BiographyController(
    workflow,
    shell,
    runtime,
    async () => preparation.scope,
  );

  const prepared = await controller.prepareText('对维奥莱塔进行寻根溯源');
  assert.ok(prepared);
  assert.equal(prepareCount, 0);
  assert.equal(prepared.preparation.recordKey, 'record-committed');
  assert.equal(prepared.preparation.rootTrace, record.biography.rootTrace);
});

test('DeepSeek ruin expansion switches to compact recovery after two premature closes', async () => {
  const fullPrompt = [
    '<RUIN_SELECTED_CANDIDATE_EXPANSION>',
    'full expansion request',
    '</RUIN_SELECTED_CANDIDATE_EXPANSION>',
    '<EVIDENCE_LEDGER_READ_ONLY>',
    '{"schema":"eyon.ruin.evidence.v1","canonicalCharacters":[]}',
    '</EVIDENCE_LEDGER_READ_ONLY>',
    '<SELECTED_OUTLINE_READ_ONLY>',
    '{"id":"ruin-c1","candidateKey":"c1","title":"旧港账簿","nodes":[],"cast":[]}',
    '</SELECTED_OUTLINE_READ_ONLY>',
    'Copy these fixed fields exactly: {"schema":"eyon.ruin.expansion.v1","requestId":"request-1","candidateKey":"c1"}',
  ].join('\n');

  class PrematureCloseRuntime extends FakeRuntime {
    customCalls: Array<{ prompt: string; maxTokens: number }> = [];

    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
    }) {
      this.customCalls.push({
        prompt: config.messages[1]?.content ?? '',
        maxTokens: config.custom_api.max_tokens ?? 0,
      });
      if (this.customCalls.length <= 2) {
        // 与真实直连通道一致：流中断发生在 response.text() 读取时，
        // 抛 transport 类错误（带 200 状态），由 message 归为 PREMATURE_CLOSE。
        throw new CustomApiRequestError(
          'transport',
          'Custom API response stream closed prematurely: fetch failed',
          { status: 200 },
        );
      }
      return {
        choices: [{
          finish_reason: 'stop',
          message: {
            content: '{"schema":"eyon.ruin.expansion.v1","requestId":"request-1","candidateKey":"c1","candidate":{"historyProse":"完成"}}',
          },
        }],
      };
    }
  }

  const runtime = new PrematureCloseRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 2;
    },
  };
  const adapter = new TavernGenerationAdapter(
    runtime,
    settings,
    () => 'generation',
    { sleep: async () => undefined, random: () => 0 },
  );

  const response = await adapter.generate('ruin', fullPrompt);
  assert.match(response, /"historyProse":"完成"/u);
  assert.equal(runtime.customCalls.length, 3);
  assert.deepEqual(runtime.customCalls.map(call => call.maxTokens), [60000, 60000, 2048]);
  assert.equal(runtime.customCalls[0]?.prompt, fullPrompt);
  assert.equal(runtime.customCalls[1]?.prompt, fullPrompt);
  assert.match(runtime.customCalls[2]?.prompt ?? '', /RUIN_COMPACT_EXPANSION_RECOVERY/u);
  assert.doesNotMatch(runtime.customCalls[2]?.prompt ?? '', /RUIN_RULES/u);
  assert.match(runtime.customCalls[2]?.prompt ?? '', /candidate contains exactly one field: historyProse/u);
});

test('compact ruin recovery stops after one additional premature close', async () => {
  const fullPrompt = [
    '<RUIN_SELECTED_CANDIDATE_EXPANSION>',
    '</RUIN_SELECTED_CANDIDATE_EXPANSION>',
    '<SELECTED_OUTLINE_READ_ONLY>',
    '{"id":"ruin-c1","candidateKey":"c1","title":"旧港账簿","nodes":[],"cast":[]}',
    '</SELECTED_OUTLINE_READ_ONLY>',
    'Copy these fixed fields exactly: {"schema":"eyon.ruin.expansion.v1","requestId":"request-1","candidateKey":"c1"}',
  ].join('\n');

  class AlwaysPrematureCloseRuntime extends FakeRuntime {
    attempts = 0;

    async generateCustomRaw() {
      this.attempts += 1;
      throw new CustomApiRequestError(
        'transport',
        'Custom API response stream closed prematurely: fetch failed',
        { status: 200 },
      );
    }
  }

  const runtime = new AlwaysPrematureCloseRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.deepseek.com',
        key: 'secret',
        model: 'deepseek-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit() {
      return 4;
    },
  };
  const adapter = new TavernGenerationAdapter(
    runtime,
    settings,
    () => 'generation',
    { sleep: async () => undefined, random: () => 0 },
  );

  await assert.rejects(
    () => adapter.generate('ruin', fullPrompt),
    /closed prematurely/u,
  );
  assert.equal(runtime.attempts, 3);
});

test('取消独立 API 任务会中止底层请求并隔离迟到结果', async () => {
  let requestSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => {
    markStarted = resolve;
  });

  class AbortableRuntime extends FakeRuntime {
    async generateCustomRaw(config: {
      messages: RuntimePrompt[];
      custom_api: RuntimeCustomApi;
      signal?: AbortSignal;
    }): Promise<unknown> {
      requestSignal = config.signal;
      markStarted();
      return new Promise((_, reject) => {
        config.signal?.addEventListener('abort', () => {
          reject(config.signal?.reason ?? new Error('aborted'));
        }, { once: true });
      });
    }
  }

  const runtime = new AbortableRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://api.example.com',
        key: 'secret',
        model: 'custom-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation');
  const generation = adapter.generate('biography', 'biography prompt');

  await started;
  assert.equal(requestSignal?.aborted, false);
  adapter.cancel('biography');

  await assert.rejects(generation, GenerationCancelledError);
  assert.equal(requestSignal?.aborted, true);
});

test('502 与 ECONNRESET 首错立即重试、之后指数退避，普通错误保持有界退避', async () => {
  const delays: number[] = [];
  const attempts: string[] = [];

  class FailingRuntime extends FakeRuntime {
    async generateCustomRaw(): Promise<unknown> {
      attempts.push('call');
      throw new CustomApiRequestError(
        'provider_http',
        'Custom API request failed (HTTP 502)',
        { status: 502 },
      );
    }
  }

  const runtime = new FailingRuntime();
  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://relay.example.com/v1',
        key: 'secret',
        model: 'relay-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit: () => 3,
  };
  const adapter = new TavernGenerationAdapter(runtime, settings, () => 'generation', {
    sleep: async ms => { delays.push(ms); },
    random: () => 0,
  });

  await assert.rejects(
    () => adapter.generate('biography', 'prompt'),
    /HTTP 502/u,
  );
  // 4 次调用、3 次重试：首错立即（0ms）→ 1s → 2s（attempt 1/2/3）
  assert.equal(attempts.length, 4);
  assert.deepEqual(delays, [0, 1000, 2000]);

  // 普通瞬时错误（空响应类）保持 500ms/1500ms 有界退避
  delays.length = 0;
  attempts.length = 0;
  class PlainRuntime extends FakeRuntime {
    async generateCustomRaw(): Promise<unknown> {
      attempts.push('call');
      throw new CustomApiRequestError(
        'empty_response',
        'API response is empty (HTTP 200, empty body)',
        { status: 200 },
      );
    }
  }
  const plain = new TavernGenerationAdapter(
    new PlainRuntime(),
    settings,
    () => 'generation',
    { sleep: async ms => { delays.push(ms); }, random: () => 0 },
  );
  await assert.rejects(
    () => plain.generate('biography', 'prompt'),
    /API response is empty/u,
  );
  assert.deepEqual(delays, [500, 1500, 1500]);
});

test('超时错误不重试，直接上抛（慢上游重试大概率同样超时）', async () => {
  const delays: number[] = [];
  const attempts: string[] = [];

  class TimeoutRuntime extends FakeRuntime {
    async generateCustomRaw(): Promise<unknown> {
      attempts.push('call');
      throw new CustomApiRequestError(
        'transport',
        'Custom API request timed out after 600000ms',
      );
    }
  }

  const settings: GenerationSettingsProvider = {
    async get() {
      return {
        apiurl: 'https://relay.example.com/v1',
        key: 'secret',
        model: 'relay-chat',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.7,
      };
    },
    getRetryLimit: () => 3,
  };
  const adapter = new TavernGenerationAdapter(
    new TimeoutRuntime(),
    settings,
    () => 'generation',
    { sleep: async ms => { delays.push(ms); }, random: () => 0 },
  );

  await assert.rejects(
    () => adapter.generate('biography', 'prompt'),
    /timed out/u,
  );
  // 超时 = 上游慢而非瞬时抖动：直接上抛，不做 2×超时长的无声空转。
  assert.equal(attempts.length, 1);
  assert.deepEqual(delays, []);
});

test('自定义端点的兜底通道裸 "Bad Gateway" 文本错误被识别为可重试瞬时故障', async () => {
  const delays: number[] = [];
  const attempts: string[] = [];

  class BadGatewayRuntime extends FakeRuntime {
    async generateRaw(): Promise<string> {
      attempts.push('call');
      if (attempts.length === 1) throw new Error('Bad Gateway');
      return '{"complete":true}';
    }
  }

  const settings: GenerationSettingsProvider = {
    async get() {
      return {};
    },
    getRetryLimit: () => 2,
    getCustomApiTimeoutMs: () => 60_000,
  };
  const adapter = new TavernGenerationAdapter(
    new BadGatewayRuntime(),
    settings,
    () => 'generation',
    { sleep: async ms => { delays.push(ms); }, random: () => 0 },
  );

  // 裸文本 502：走 relay 上游分类 → 首错立即重试 → 第二次成功
  assert.equal(await adapter.generate('biography', 'prompt'), '{"complete":true}');
  assert.equal(attempts.length, 2);
  assert.deepEqual(delays, [0]);
});

test('自定义端点的兜底通道同样受请求超时约束（不会无限等待）', async () => {
  const delays: number[] = [];
  const attempts: string[] = [];

  class SlowTavernRuntime extends FakeRuntime {
    async generateRaw(): Promise<string> {
      attempts.push('call');
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return 'late';
    }
  }

  const settings: GenerationSettingsProvider = {
    async get() {
      return {};
    },
    getRetryLimit: () => 1,
    getCustomApiTimeoutMs: () => 50,
  };
  const adapter = new TavernGenerationAdapter(
    new SlowTavernRuntime(),
    settings,
    () => 'generation',
    { sleep: async ms => { delays.push(ms); }, random: () => 0 },
  );

  await assert.rejects(
    () => adapter.generate('biography', 'prompt'),
    /timed out/u,
  );
  // 超时不重试：50ms 超时后立即上抛，不等 30 秒的慢响应。
  assert.equal(attempts.length, 1);
  assert.deepEqual(delays, []);
});

test('attachRequestMetadata 双写 swipe_info，滑走再滑回元数据不丢', async () => {
  const runtime = new FakeRuntime();
  const shell = new TavernBiographyShellAdapter(runtime);
  const lock: BiographyFloorLock = {
    preparation: makePreparation(),
    triggerTextHash: fingerprintText('对维奥莱塔进行寻根溯源'),
    triggerSwipeId: 0,
  };
  await shell.attachRequestMetadata(lock, 9);
  const message = runtime.messages.get(9);
  assert.ok(message);
  // extra 与 swipe_info[0].extra 都有元数据（随 swipe/删楼/分支正确回滚）
  const extra = message.extra as Record<string, unknown> | undefined;
  assert.ok(extra?.eyonHistoryRequest);
  assert.ok(message.swipeInfo?.[0]?.extra?.eyonHistoryRequest);
});

test('错误码信封：Bad Gateway / 超时 / 占位响应 / 鉴权 / 校验分流', () => {
  // 环境 502（裸文本——酒馆 generateRaw 通道的真实形态）
  const badGateway = toGenerationFailureEnvelope(new Error('Bad Gateway'));
  assert.equal(badGateway.kind, 'retryable');
  assert.equal(badGateway.code, GENERATION_ERROR_CODES.UPSTREAM_BAD_GATEWAY);
  assert.equal(badGateway.message, 'Bad Gateway');

  // 结构化 502（独立 API 通道：CustomApiRequestError provider_http）
  const http502 = new CustomApiRequestError(
    'provider_http',
    'Custom API request failed (HTTP 502): upstream down',
    { status: 502 },
  );
  const envelope502 = toGenerationFailureEnvelope(http502);
  assert.equal(envelope502.kind, 'retryable');
  assert.equal(envelope502.code, GENERATION_ERROR_CODES.UPSTREAM_BAD_GATEWAY);

  // 超时（CustomApiRequestError transport + timed out）
  const timeout = new CustomApiRequestError(
    'transport',
    'Custom API request timed out after 600000ms',
  );
  const envelopeTimeout = toGenerationFailureEnvelope(timeout);
  assert.equal(envelopeTimeout.code, GENERATION_ERROR_CODES.TIMEOUT);
  assert.equal(generationKind(envelopeTimeout.code), 'retryable');

  // 中转站会把裸 <none> 包装成完整错误句；仍须判作可重试空响应。
  const placeholder = new CustomApiRequestError(
    'transport',
    'Custom API relay returned a placeholder error: <none>',
  );
  const envelopePlaceholder = toGenerationFailureEnvelope(placeholder);
  assert.equal(envelopePlaceholder.kind, 'retryable');
  assert.equal(envelopePlaceholder.code, GENERATION_ERROR_CODES.EMPTY_RESPONSE);

  // 未来出现新的 transport 文案时，也不能退化为 permanent。
  const unknownTransport = new CustomApiRequestError(
    'transport',
    'Custom API transport failed without a recognized provider message',
  );
  const envelopeUnknownTransport = toGenerationFailureEnvelope(unknownTransport);
  assert.equal(envelopeUnknownTransport.kind, 'retryable');
  assert.equal(envelopeUnknownTransport.code, GENERATION_ERROR_CODES.NETWORK_FAILED);

  // 鉴权失败 → permanent（不重试）
  const auth = new CustomApiRequestError(
    'provider_http',
    'Custom API request failed (HTTP 401): Unauthorized',
    { status: 401 },
  );
  const envelopeAuth = toGenerationFailureEnvelope(auth);
  assert.equal(envelopeAuth.code, GENERATION_ERROR_CODES.AUTH_FAILED);
  assert.equal(generationKind(envelopeAuth.code), 'permanent');

  // 校验错误（BiographyValidationError 带具体 code）→ validation，code 保留
  const validation = new BiographyValidationError('Plan span is too vague', 'PLAN_SCHEMA_INVALID');
  const envelopeValidation = toGenerationFailureEnvelope(validation);
  // 信封首分支识别 kind='validation' 的 Error，保留其原始 code
  assert.equal(envelopeValidation.kind, 'validation');
  assert.equal(typeof envelopeValidation.code, 'string');
});
