export type RuntimeRole = 'system' | 'assistant' | 'user';

export interface RuntimeChatMessage {
  message_id: number;
  role: RuntimeRole;
  message: string;
  is_hidden?: boolean;
  data?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  swipe_id?: number;
}

export interface RuntimePrompt {
  role: RuntimeRole;
  content: string;
}

export interface RuntimeCustomApi {
  apiurl: string;
  key?: string;
  model: string;
  source?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface TavernRuntime {
  getCurrentCharacterName(): string | null;
  getCurrentChatId(): string;
  getLastMessageId(): number;
  getMessageSwipeId(messageId: number): number | null;
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
    ordered_prompts: RuntimePrompt[];
    custom_api?: RuntimeCustomApi;
  }): Promise<string>;
}

export interface RuntimeContextSourceProvider {
  getCurrentWorld(): Promise<{ time: string; location: string }>;
  getWorldbookSources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getCharacterSources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getGenealogySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getBiographySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
  getButterflySources(): Promise<Array<{ sourceId: string; title: string; content: string }>>;
}
