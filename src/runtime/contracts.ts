import type {
  RuntimeWorldbookCorpus,
  RuntimeWorldbookSource,
} from '../retrieval/contracts.ts';

export type RuntimeRole = 'system' | 'assistant' | 'user';

export interface RuntimeChatMessage {
  message_id: number;
  role: RuntimeRole;
  message: string;
  is_hidden?: boolean;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  swipe_id?: number;
  /** 各 swipe 槽的持久数据（ST 的 swipe_info）：extra 只是当前 swipe 的镜像，
   *  切 swipe 后真正随槽位回滚的是这里的 extra；双写可防元数据丢失 */
  swipeInfo?: Array<{ extra?: Record<string, unknown> } | undefined>;
}

export interface RuntimePrompt {
  role: RuntimeRole;
  content: string;
}

export type RuntimeOrderedPrompt = RuntimePrompt | 'user_input';

export interface RuntimeCustomApi {
  /** 自定义 API 地址（OpenAI 兼容聊天补全端点）。为空时生成会报“接口地址为空”。 */
  apiurl?: string;
  key?: string;
  model?: string;
  source?: string;
  max_tokens?: number;
  temperature?: number;
  response_format?: {
    type: 'json_object';
  };
}

export interface TavernRuntime {
  getCurrentCharacterName(): string | null;
  getCurrentChatId(): string;
  getLastMessageId(): number;
  getMessageSwipeId(messageId: number): number | null;
  /**
   * 酒馆当前是否正在生成（含流式）：
   * true=生成中，false=空闲，undefined=宿主不提供该能力。
   * 传记提交前用它确认正文流式已结束，避免流式中途提交吞掉后续内容。
   */
  isGenerating?(): boolean | undefined;
  getChatMessages(
    range: number | string,
    options?: { include_swipes?: boolean },
  ): RuntimeChatMessage[];
  setChatMessages(
    messages: Array<{
      message_id: number;
      message?: string;
      data?: Record<string, unknown>;
      extra?: Record<string, unknown>;
      /** 整组 swipe_info（含各槽 extra）：随 swipe/删楼/分支正确回滚 */
      swipeInfo?: Array<Record<string, unknown> | undefined>;
    }>,
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
  /**
   * 注入一段仅对下一次生成请求有效的提示词（对应酒馆助手的
   * `injectPrompts(prompts, { once: true })`）。返回 true 表示注入成功；
   * 返回 false 表示宿主不支持该通道，调用方应回退到 setExtensionPrompt。
   */
  injectOncePrompts?(prompt: {
    id: string;
    content: string;
    depth: number;
    role: 'system' | 'assistant' | 'user';
    should_scan?: boolean;
  }): Promise<boolean> | boolean;
  generate(config: {
    generation_id?: string;
    user_input?: string;
    should_stream?: boolean;
    should_silence?: boolean;
    injects?: Array<{
      role: RuntimeRole;
      content: string;
      position: 'in_chat';
      depth: number;
      should_scan: boolean;
    }>;
    max_chat_history?: 'all' | number;
  }): Promise<string>;
  generateRaw(config: {
    generation_id?: string;
    user_input?: string;
    should_stream?: boolean;
    should_silence?: boolean;
    max_chat_history?: 'all' | number;
    ordered_prompts: RuntimeOrderedPrompt[];
    custom_api?: RuntimeCustomApi;
    /** 统一取消令牌；旧版 Tavern Helper 会忽略此字段，由外层竞速器收口。 */
    signal?: AbortSignal;
  }): Promise<string>;
  generateCustomRaw?(config: {
    messages: RuntimePrompt[];
    custom_api: RuntimeCustomApi;
    signal?: AbortSignal;
    timeoutMs?: number;
    deepseekStructured?: boolean;
  }): Promise<unknown>;
}

export interface RuntimeContextSourceProvider {
  getCurrentWorld(): Promise<{ time: string; location: string }>;
  /** Retrieval v1.2 完整宿主适配器；旧测试适配器可暂由 getWorldbookSources 兼容。 */
  getWorldbookCorpus?(): Promise<RuntimeWorldbookCorpus>;
  getWorldbookSources(): Promise<RuntimeWorldbookSource[]>;
  getCharacterSources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getGenealogySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getBiographySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getButterflySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
}

/** 兼容仅实现旧来源数组的测试/第三方适配器；真实 Tavern 适配器总是返回 complete=true。 */
export async function loadRuntimeWorldbookCorpus(
  provider: RuntimeContextSourceProvider,
): Promise<RuntimeWorldbookCorpus> {
  if (provider.getWorldbookCorpus) return provider.getWorldbookCorpus();
  const sources = await provider.getWorldbookSources();
  return {
    sources,
    receipt: {
      schema: 'eyon.retrieval.worldbook-corpus.v1',
      complete: false,
      bindings: [],
      entries: sources.map(source => ({
        logicalId: source.worldbook.logicalId,
        sourceId: source.sourceId,
        worldbookName: source.worldbook.worldbookName,
        uid: source.worldbook.uid,
        title: source.title,
        bindingScopes: [...source.worldbook.bindingScopes],
        enabled: true,
        status: 'retrievable',
      })),
      counts: {
        total: sources.length,
        enabled: sources.length,
        retrievable: sources.length,
        disabled: 0,
        empty: 0,
        'user-excluded': 0,
        'routed-generated': 0,
      },
    },
  };
}
