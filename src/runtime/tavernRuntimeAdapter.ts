import type {
  RuntimeChatMessage,
  TavernRuntime,
} from './contracts.ts';

interface TavernHostBindings {
  getCurrentCharacterName(): string | null;
  getCurrentChatId(): string;
  getLastMessageId(): number;
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
  generate(config: Parameters<TavernRuntime['generate']>[0]): Promise<string>;
  generateRaw(config: Parameters<TavernRuntime['generateRaw']>[0]): Promise<string>;
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
      }];
    });
  }

  async setChatMessages(
    messages: Array<{
      message_id: number;
      message?: string;
      data?: Record<string, unknown>;
      extra?: Record<string, unknown>;
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

  generate(config: Parameters<TavernRuntime['generate']>[0]): Promise<string> {
    return this.host.generate(config);
  }

  generateRaw(config: Parameters<TavernRuntime['generateRaw']>[0]): Promise<string> {
    return this.host.generateRaw(config);
  }
}

export function createGlobalTavernRuntime(
  globalObject: Record<string, unknown> = globalThis as Record<string, unknown>,
): TavernRuntimeAdapter {
  const sillyTavern = requireRecord(globalObject.SillyTavern, 'SillyTavern');
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
    getChatMessages: requireFunction(globalObject.getChatMessages, 'getChatMessages'),
    setChatMessages: requireFunction(globalObject.setChatMessages, 'setChatMessages'),
    setExtensionPrompt: requireFunction(
      sillyTavern.setExtensionPrompt,
      'SillyTavern.setExtensionPrompt',
    ),
    generate: requireFunction(globalObject.generate, 'generate'),
    generateRaw: requireFunction(globalObject.generateRaw, 'generateRaw'),
  });
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
