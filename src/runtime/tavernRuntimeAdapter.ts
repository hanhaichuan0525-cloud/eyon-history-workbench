import type {
  RuntimeChatMessage,
  RuntimeCustomApi,
  RuntimePrompt,
  TavernRuntime,
} from './contracts.ts';
import {
  customApiAuthenticationError,
  customAuthorizationHeader,
  isAuthenticationFailure,
  normalizeCustomApiBaseUrl,
  requireCustomApiKey,
} from './customApiCredentials.ts';

interface TavernHostBindings {
  getCurrentCharacterName(): string | null;
  getCurrentChatId(): string;
  getLastMessageId(): number;
  isGenerating?(): boolean | undefined;
  getChatMessages(
    range: number | string,
    options?: { include_swipes?: boolean },
  ): Array<Record<string, unknown>>;
  setChatMessages(
    messages: Array<Record<string, unknown>>,
    options?: { refresh?: 'none' | 'affected' | 'all' },
  ): Promise<void>;
  setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    shouldScan: boolean,
    role: number,
    filter?: unknown,
  ): Promise<void> | void;
  injectOncePrompt(prompt: {
    id: string;
    content: string;
    depth: number;
    role: 'system' | 'assistant' | 'user';
    should_scan?: boolean;
  }): boolean;
  generate(config: Parameters<TavernRuntime['generate']>[0]): Promise<string>;
  generateRaw(config: Parameters<TavernRuntime['generateRaw']>[0]): Promise<string>;
  generateCustomRaw?(config: {
    messages: RuntimePrompt[];
    custom_api: RuntimeCustomApi;
    signal?: AbortSignal;
    timeoutMs?: number;
    deepseekStructured?: boolean;
  }): Promise<unknown>;
}

export type CustomApiFailureKind =
  | 'transport'
  | 'provider_http'
  | 'empty_response';

/**
 * 中转 API 请求超时兜底（毫秒）。设置项 customApiTimeoutMs 缺省时使用。
 * 0 = 不限制（与参考工作流助手一致：慢中转上游无限等待、慢而终成）。
 * 默认 600 秒：慢上游正常成功可达 5 分钟以上，120 秒会把「慢但会成功」
 * 的请求误判为超时；10 分钟仍无响应才视为真死。
 */
export const CUSTOM_API_TIMEOUT_MS = 600_000;

export class CustomApiRequestError extends Error {
  readonly kind: CustomApiFailureKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    kind: CustomApiFailureKind,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CustomApiRequestError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export class TavernRuntimeAdapter implements TavernRuntime {
  private readonly host: TavernHostBindings;

  constructor(host: TavernHostBindings) {
    this.host = host;
  }

  getCurrentCharacterName(): string | null {
    return this.host.getCurrentCharacterName();
  }

  getCurrentChatId(): string {
    return this.host.getCurrentChatId();
  }

  getLastMessageId(): number {
    return this.host.getLastMessageId();
  }

  isGenerating(): boolean | undefined {
    return this.host.isGenerating?.();
  }

  getMessageSwipeId(messageId: number): number | null {
    const raw = this.host
      .getChatMessages(messageId, { include_swipes: true })
      .find(message => Number(message.message_id) === messageId);
    const value = raw?.swipe_id;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }

  getChatMessages(
    range: number | string,
    options?: { include_swipes?: boolean },
  ): RuntimeChatMessage[] {
    return this.host.getChatMessages(range, options).flatMap(raw => {
      const role = raw.role;
      const messageId = Number(raw.message_id);
      if (
        (role !== 'system' && role !== 'assistant' && role !== 'user')
        || !Number.isInteger(messageId)
      ) {
        return [];
      }
      return [{
        message_id: messageId,
        role,
        message: typeof raw.message === 'string' ? raw.message : '',
        is_hidden: raw.is_hidden === true,
        data: isRecord(raw.data) ? raw.data : undefined,
        extra: isRecord(raw.extra) ? raw.extra : undefined,
        swipe_id: typeof raw.swipe_id === 'number' ? raw.swipe_id : undefined,
        swipeInfo: Array.isArray(raw.swipe_info)
          ? raw.swipe_info.map(slot =>
            isRecord(slot) ? { extra: isRecord(slot.extra) ? slot.extra : undefined } : undefined)
          : undefined,
      }];
    });
  }

  async setChatMessages(
    messages: Array<{
      message_id: number;
      message?: string;
      data?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      swipeInfo?: Array<Record<string, unknown> | undefined>;
    }>,
    options?: { refresh?: 'none' | 'affected' | 'all' },
  ): Promise<void> {
    await this.host.setChatMessages(messages, options);
  }

  async setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    shouldScan: boolean,
    role: number,
    filter?: unknown,
  ): Promise<void> {
    await this.host.setExtensionPrompt(
      key,
      value,
      position,
      depth,
      shouldScan,
      role,
      filter,
    );
  }

  injectOncePrompts(prompt: {
    id: string;
    content: string;
    depth: number;
    role: 'system' | 'assistant' | 'user';
    should_scan?: boolean;
  }): boolean {
    return this.host.injectOncePrompt(prompt);
  }

  generate(config: Parameters<TavernRuntime['generate']>[0]): Promise<string> {
    return this.host.generate(config);
  }

  generateRaw(config: Parameters<TavernRuntime['generateRaw']>[0]): Promise<string> {
    return this.host.generateRaw(config);
  }

  generateCustomRaw(config: {
    messages: RuntimePrompt[];
    custom_api: RuntimeCustomApi;
    signal?: AbortSignal;
    timeoutMs?: number;
    deepseekStructured?: boolean;
  }): Promise<unknown> {
    if (!this.host.generateCustomRaw) {
      throw new Error('Direct custom API channel is unavailable');
    }
    return this.host.generateCustomRaw(config);
  }
}

export function createGlobalTavernRuntime(
  globalObject: Record<string, unknown> = globalThis as Record<string, unknown>,
): TavernRuntimeAdapter {
  const sillyTavern = requireRecord(globalObject.SillyTavern, 'SillyTavern');
  const generate = resolveTavernHelperFunction<TavernHostBindings['generate']>(
    globalObject,
    'generate',
  ) ?? requireFunction<TavernHostBindings['generate']>(
    globalObject.generate,
    'generate',
  );
  const generateRaw = resolveTavernHelperFunction<TavernHostBindings['generateRaw']>(
    globalObject,
    'generateRaw',
  ) ?? requireFunction<TavernHostBindings['generateRaw']>(
    globalObject.generateRaw,
    'generateRaw',
  );
  const injectPrompts = resolveTavernHelperFunction<
    (
      prompts: Array<{
        id: string;
        content: string;
        position: 'in_chat' | 'none';
        depth: number;
        role: 'system' | 'assistant' | 'user';
        should_scan?: boolean;
        filter?: () => boolean | Promise<boolean>;
      }>,
      options?: { once?: boolean },
    ) => { uninject?: () => void } | void
  >(globalObject, 'injectPrompts')
    ?? (typeof globalObject.injectPrompts === 'function'
      ? globalObject.injectPrompts as (
          prompts: Array<{
            id: string;
            content: string;
            position: 'in_chat' | 'none';
            depth: number;
            role: 'system' | 'assistant' | 'user';
            should_scan?: boolean;
            filter?: () => boolean | Promise<boolean>;
          }>,
          options?: { once?: boolean },
        ) => { uninject?: () => void } | void
      : null);
  return new TavernRuntimeAdapter({
    getCurrentCharacterName: requireFunction(
      globalObject.getCurrentCharacterName,
      'getCurrentCharacterName',
    ),
    getCurrentChatId: requireFunction(
      sillyTavern.getCurrentChatId,
      'SillyTavern.getCurrentChatId',
    ),
    getLastMessageId: requireFunction(globalObject.getLastMessageId, 'getLastMessageId'),
    isGenerating: () => {
      // 酒馆 context 提供 getGenerating()（{is_sending, is_streaming}）时优先使用；
      // 退化为 is_sending 属性；都不提供时返回 undefined（不阻塞提交，维持旧行为）。
      try {
        const getContext = typeof sillyTavern.getContext === 'function'
          ? sillyTavern.getContext as () => {
            getGenerating?: () => { is_sending?: boolean; is_streaming?: boolean };
            is_sending?: boolean;
          }
          : null;
        const context = getContext?.();
        if (!context) return undefined;
        const generating = context.getGenerating?.();
        if (generating) {
          return generating.is_sending === true || generating.is_streaming === true;
        }
        return typeof context.is_sending === 'boolean' ? context.is_sending : undefined;
      } catch {
        return undefined;
      }
    },
    getChatMessages: requireFunction(globalObject.getChatMessages, 'getChatMessages'),
    setChatMessages: requireFunction(globalObject.setChatMessages, 'setChatMessages'),
    setExtensionPrompt: requireFunction(
      sillyTavern.setExtensionPrompt,
      'SillyTavern.setExtensionPrompt',
    ),
    injectOncePrompt: prompt => {
      if (!injectPrompts) return false;
      try {
        injectPrompts([{
          id: prompt.id,
          content: prompt.content,
          position: 'in_chat',
          depth: prompt.depth,
          role: prompt.role,
          should_scan: prompt.should_scan ?? false,
        }], { once: true });
        return true;
      } catch {
        // 宿主注入通道异常时回退到 setExtensionPrompt 常驻注入。
        return false;
      }
    },
    generate,
    generateRaw,
    generateCustomRaw: config => requestCustomChatCompletion(globalObject, config),
  });
}

export async function requestCustomChatCompletion(
  globalObject: Record<string, unknown>,
  config: {
    messages: RuntimePrompt[];
    custom_api: RuntimeCustomApi;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** DeepSeek 一键结构化：json_object + thinking disabled + 输出上限 8192 */
    deepseekStructured?: boolean;
  },
): Promise<unknown> {
  const endpoint = normalizeCustomApiBaseUrl(config.custom_api.apiurl ?? '');
  if (!endpoint) throw new Error('Custom API endpoint is empty');

  const fetchFunction = requireFunction<typeof fetch>(
    globalObject.fetch ?? globalThis.fetch,
    'fetch',
  );
  const sillyTavern = requireRecord(globalObject.SillyTavern, 'SillyTavern');
  const getContext = typeof sillyTavern.getContext === 'function'
    ? sillyTavern.getContext as () => { getRequestHeaders?: () => Record<string, string> }
    : null;
  const headers = getContext?.().getRequestHeaders?.() ?? {};
  const key = requireCustomApiKey(config.custom_api.key);
  let maxTokens = config.custom_api.max_tokens;
  let responseFormat = config.custom_api.response_format;
  let includeBody = '';
  if (config.deepseekStructured) {
    // DeepSeek 一键结构化：强制 json_object，禁用思考模式（reasoning_content
    // 会污染 json_object 解析），输出上限压到官方硬上限 8192（更大直接 400）。
    responseFormat = responseFormat ?? { type: 'json_object' };
    includeBody = 'thinking:\n  type: disabled';
    if (maxTokens === undefined || maxTokens > 8_192) maxTokens = 8_192;
  }
  const requestBody: Record<string, unknown> = {
    messages: config.messages,
    model: config.custom_api.model ?? '',
    stream: false,
    chat_completion_source: 'custom',
    group_names: [],
    include_reasoning: false,
    custom_prompt_post_processing: 'strict',
    reverse_proxy: endpoint,
    proxy_password: key,
    custom_url: endpoint,
    custom_include_headers: customAuthorizationHeader(key),
    custom_exclude_body: '',
  };
  if (maxTokens !== undefined) {
    requestBody.max_tokens = maxTokens;
  }
  if (config.custom_api.temperature !== undefined) {
    requestBody.temperature = config.custom_api.temperature;
  }
  if (responseFormat !== undefined) {
    // response_format 走顶层字段（ST 原生支持）。custom_include_body 只用于
    // 补充模型专用参数（如 thinking），不再重复注入 response_format，
    // 避免同一参数双写导致后端 merge 冲突。
    requestBody.response_format = responseFormat;
    if (includeBody) requestBody.custom_include_body = includeBody;
  } else if (includeBody) {
    requestBody.custom_include_body = includeBody;
  }

  // 挂起保护：中转 API 上游可能既不返回也不报错（连接僵死、上游排队、半开连接），
  // 没有超时会导致生成任务无限等待、并发池槽位被永久占用。
  // 超时后抛 transport 错误，由上层决定重试策略。
  // timeoutMs <= 0 表示不限制（对齐参考工作流助手的无限等待语义）。
  const timeoutMs = config.timeoutMs ?? CUSTOM_API_TIMEOUT_MS;
  const timeoutController = new AbortController();
  const timeoutError = new CustomApiRequestError(
    'transport',
    `Custom API request timed out after ${timeoutMs}ms`,
  );
  let timedOut = false;
  const timeoutTimer = timeoutMs > 0
    ? setTimeout(() => {
      timedOut = true;
      timeoutController.abort(timeoutError);
    }, timeoutMs)
    : null;
  const onExternalAbort = () => timeoutController.abort(config.signal?.reason);
  if (config.signal?.aborted) onExternalAbort();
  else config.signal?.addEventListener('abort', onExternalAbort, { once: true });

  let response: Response;
  let rawBody = '';
  try {
    try {
      response = await fetchFunction('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: timeoutController.signal,
      });
    } catch (cause) {
      if (config.signal?.aborted) throw cause;
      if (timedOut) throw timeoutError;
      throw new CustomApiRequestError(
        'transport',
        `Custom API transport failed: ${errorMessage(cause)}`,
        { cause },
      );
    }

    try {
      rawBody = await response.text();
    } catch (cause) {
      if (config.signal?.aborted) throw cause;
      if (timedOut) throw timeoutError;
      throw new CustomApiRequestError(
        'transport',
        `Custom API response stream closed prematurely: ${errorMessage(cause)}`,
        { status: response.status, cause },
      );
    }
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    config.signal?.removeEventListener('abort', onExternalAbort);
  }
  if (!response.ok) {
    throw new CustomApiRequestError(
      'provider_http',
      `Custom API request failed (HTTP ${response.status})${errorBodySuffix(rawBody)}`,
      {
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers.get('Retry-After')),
      },
    );
  }
  if (!rawBody.trim()) {
    throw new CustomApiRequestError(
      'empty_response',
      `API response is empty (HTTP ${response.status}, empty body)`,
      { status: response.status },
    );
  }

  const payload = parseBackendResponse(rawBody);
  const apiError = extractApiError(payload);
  if (apiError) {
    if (isAuthenticationFailure(apiError)) {
      throw customApiAuthenticationError(endpoint, config.custom_api.model ?? '');
    }
    // 中转占位错误（<none>/空消息/{}）：上游异常但无具体信息，
    // 视为瞬时故障走可重试路径，而不是直接判死任务。
    if (isRelayPlaceholderError(apiError)) {
      throw new CustomApiRequestError(
        'transport',
        `Custom API relay returned a placeholder error: ${apiError}`,
      );
    }
    throw new Error(`Custom API error: ${apiError}`);
  }
  return payload;
}

export function resolveTavernHelperFunction<T extends (...args: never[]) => unknown>(
  globalObject: Record<string, unknown>,
  name: string,
): T | null {
  for (const candidate of tavernHelperCandidates(globalObject)) {
    const value = candidate[name];
    if (typeof value === 'function') {
      return value.bind(candidate) as T;
    }
  }
  return null;
}

function tavernHelperCandidates(
  globalObject: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  const append = (value: unknown): void => {
    if (isRecord(value) && !candidates.includes(value)) candidates.push(value);
  };

  try {
    const parent = globalObject.parent as Record<string, unknown> | undefined;
    append(parent?.TavernHelper);
  } catch {
    // Cross-origin parents are intentionally ignored.
  }
  try {
    const top = globalObject.top as Record<string, unknown> | undefined;
    append(top?.TavernHelper);
  } catch {
    // Cross-origin top windows are intentionally ignored.
  }
  append(globalObject.TavernHelper);
  return candidates;
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}

function requireFunction<T extends (...args: never[]) => unknown>(
  value: unknown,
  name: string,
): T {
  if (typeof value !== 'function') {
    throw new Error(`${name} is unavailable`);
  }
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBackendResponse(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    const events = rawBody
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .filter(line => line && line !== '[DONE]')
      .flatMap(line => {
        try {
          return [JSON.parse(line) as unknown];
        } catch {
          return [];
        }
      });
    return events.length ? events : rawBody;
  }
}

function extractApiError(payload: unknown): string {
  if (!isRecord(payload) || payload.error === undefined) return '';
  if (typeof payload.error === 'string') return payload.error.slice(0, 800);
  if (isRecord(payload.error)) {
    const message = payload.error.message;
    if (typeof message === 'string') return message.slice(0, 800);
  }
  return JSON.stringify(payload.error).slice(0, 800);
}

/**
 * 中转站占位错误：上游异常但无具体信息（<none>/空消息/{} 等）。
 * 这些不是参数或鉴权错误，属于瞬时故障，应走可重试路径而非直接判死任务。
 */
function isRelayPlaceholderError(message: string): boolean {
  const normalized = message
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase();
  return normalized === ''
    || normalized === '<none>'
    || normalized === 'none'
    || normalized === '{}'
    || normalized === 'null';
}

function errorBodySuffix(rawBody: string): string {
  const compact = rawBody.replace(/\s+/gu, ' ').trim().slice(0, 800);
  return compact ? `: ${compact}` : '';
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1_000), 4_000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(Math.max(0, timestamp - Date.now()), 4_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
