import type { TavernEventBridge } from './registerLifecycle.ts';
import type { ScriptVariableBindings } from './workbenchSettings.ts';
import type {
  HostWorldbookEntry,
  TavernDataBindings,
} from './tavernHost.ts';

type GlobalRecord = Record<string, unknown>;
type Listener = (...args: unknown[]) => unknown;

export async function waitForGlobalMvu(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): Promise<void> {
  const waitGlobalInitialized = globalObject.waitGlobalInitialized;
  if (typeof waitGlobalInitialized === 'function') {
    await (waitGlobalInitialized as (name: string) => Promise<void>)('Mvu');
  }
  const mvu = isRecord(globalObject.Mvu) ? globalObject.Mvu : null;
  if (typeof mvu?.getMvuData !== 'function') {
    throw new Error('Mvu.getMvuData is unavailable');
  }
}

export function createGlobalDataBindings(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): TavernDataBindings {
  const getVariables = requireFunction<
    (option: Record<string, unknown>) => Record<string, unknown>
  >(globalObject.getVariables, 'getVariables');
  const getCharWorldbookNames = requireFunction<
    (_character: 'current') => { primary: string | null; additional: string[] }
  >(globalObject.getCharWorldbookNames, 'getCharWorldbookNames');
  const getChatWorldbookName = requireFunction<
    (_chat: 'current') => string | null
  >(globalObject.getChatWorldbookName, 'getChatWorldbookName');
  const getGlobalWorldbookNames = requireFunction<() => string[]>(
    globalObject.getGlobalWorldbookNames,
    'getGlobalWorldbookNames',
  );
  const getWorldbook = requireFunction<
    (name: string) => Promise<HostWorldbookEntry[]>
  >(globalObject.getWorldbook, 'getWorldbook');
  const getWorldbookNames = requireFunction<() => string[]>(
    globalObject.getWorldbookNames,
    'getWorldbookNames',
  );
  const rebindGlobalWorldbooks = requireFunction<
    (names: string[]) => Promise<void>
  >(globalObject.rebindGlobalWorldbooks, 'rebindGlobalWorldbooks');
  // internal.88（§6 步 B）：createWorldbook / createWorldbookEntries / updateWorldbookWith
  // 随世界书镜像退役一并移除——它们此前只为镜像写入服务，却是**加载期硬依赖**
  // （requireFunction 缺失即抛错），删掉后脚本不再要求宿主提供世界书写接口。
  const deleteWorldbookEntries = typeof globalObject.deleteWorldbookEntries === 'function'
    ? globalObject.deleteWorldbookEntries as (
        name: string,
        predicate: (entry: HostWorldbookEntry) => boolean,
        options?: { render?: 'debounced' | 'immediate' },
      ) => Promise<{ deleted_entries: HostWorldbookEntry[] }>
    : null;
  const createChatMessages = requireFunction<
    (
      messages: Array<{ role: 'user'; message: string }>,
      options?: { refresh?: 'none' | 'affected' | 'all' },
    ) => Promise<void>
  >(globalObject.createChatMessages, 'createChatMessages');
  const triggerSlash = requireFunction<(command: string) => Promise<string>>(
    globalObject.triggerSlash,
    'triggerSlash',
  );
  const mvu = isRecord(globalObject.Mvu) ? globalObject.Mvu : null;
  const getMvuData = typeof mvu?.getMvuData === 'function'
    ? mvu.getMvuData as (option: Record<string, unknown>) => Record<string, unknown>
    : null;
  const replaceMvuData = typeof mvu?.replaceMvuData === 'function'
    ? mvu.replaceMvuData as (
        variables: Record<string, unknown>,
        option: Record<string, unknown>,
      ) => Promise<void>
    : null;

  return {
    getChatVariables: () => getVariables({ type: 'chat' }),
    getCurrentVariables: () => (
      getMvuData
        ? getMvuData({ type: 'message', message_id: -1 })
        : getVariables({ type: 'message', message_id: -1 })
    ),
    getMessageVariables: messageId => (
      getMvuData
        ? getMvuData({ type: 'message', message_id: messageId })
        : getVariables({ type: 'message', message_id: messageId })
    ),
    replaceMessageVariables: replaceMvuData
      ? (messageId, variables) =>
          replaceMvuData(variables, { type: 'message', message_id: messageId })
      : undefined,
    getCharWorldbookNames: () => getCharWorldbookNames('current'),
    getChatWorldbookName: () => getChatWorldbookName('current'),
    getGlobalWorldbookNames,
    getWorldbook,
    getWorldbookNames,
    rebindGlobalWorldbooks,
    deleteWorldbookEntries: deleteWorldbookEntries
      ? (name, predicate) =>
          deleteWorldbookEntries(name, predicate, { render: 'debounced' })
      : undefined,
    createUserMessage: text =>
      createChatMessages(
        [{ role: 'user', message: text }],
        { refresh: 'affected' },
      ),
    triggerReply: async () => {
      await triggerSlash('/trigger');
    },
  };
}

export function createGlobalScriptVariableBindings(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): ScriptVariableBindings {
  const getVariables = requireFunction<
    (option: Record<string, unknown>) => Record<string, unknown>
  >(globalObject.getVariables, 'getVariables');
  const replaceVariables = requireFunction<
    (variables: Record<string, unknown>, option: Record<string, unknown>) => void
  >(globalObject.replaceVariables, 'replaceVariables');
  const getScriptId = requireFunction<() => string>(
    globalObject.getScriptId,
    'getScriptId',
  );
  const option = () => ({ type: 'script', script_id: getScriptId() });
  return {
    getScriptVariables: () => getVariables(option()),
    replaceScriptVariables: variables => replaceVariables(variables, option()),
  };
}

export function createGlobalEventBridge(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): {
  bridge: TavernEventBridge;
  names: {
    generationAfterCommands: string;
    characterMessageRendered: string;
    chatChanged: string;
    /** 宿主不支持时 undefined（仍由 generationAfterCommands 兼容兜底）。 */
    messageSent?: string;
    /** 宿主不支持时 undefined(删楼回退释放降级为不可用,不影响其他功能) */
    messageDeleted?: string;
  };
} {
  const eventOn = requireFunction<
    (event: string, listener: Listener) => { stop?: () => void } | void
  >(globalObject.eventOn, 'eventOn');
  const eventMakeFirst = typeof globalObject.eventMakeFirst === 'function'
    ? globalObject.eventMakeFirst as (
        event: string,
        listener: Listener,
      ) => { stop?: () => void } | void
    : null;
  const eventNames = requireRecord(globalObject.tavern_events, 'tavern_events');
  const generationAfterCommands = requireString(
    eventNames.GENERATION_AFTER_COMMANDS,
    'tavern_events.GENERATION_AFTER_COMMANDS',
  );
  const characterMessageRendered = requireString(
    eventNames.CHARACTER_MESSAGE_RENDERED,
    'tavern_events.CHARACTER_MESSAGE_RENDERED',
  );
  const chatChanged = requireString(
    eventNames.CHAT_CHANGED,
    'tavern_events.CHAT_CHANGED',
  );
  const messageSent = typeof eventNames.MESSAGE_SENT === 'string'
    ? eventNames.MESSAGE_SENT as string
    : undefined;
  const messageDeleted = typeof eventNames.MESSAGE_DELETED === 'string'
    ? eventNames.MESSAGE_DELETED as string
    : undefined;
  const stops = new Map<Listener, () => void>();
  return {
    bridge: {
      on(event, listener) {
        const subscription = eventOn(event, listener);
        if (subscription?.stop) stops.set(listener, subscription.stop);
      },
      first: eventMakeFirst
        ? (event, listener) => {
            const subscription = eventMakeFirst(event, listener);
            if (subscription?.stop) stops.set(listener, subscription.stop);
          }
        : undefined,
      off(_event, listener) {
        stops.get(listener)?.();
        stops.delete(listener);
      },
    },
    names: {
      generationAfterCommands,
      characterMessageRendered,
      chatChanged,
      messageSent,
      messageDeleted,
    },
  };
}

function requireFunction<T extends (...args: never[]) => unknown>(
  value: unknown,
  name: string,
): T {
  if (typeof value !== 'function') throw new Error(`${name} is unavailable`);
  return value as T;
}

function requireRecord(value: unknown, name: string): GlobalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} is unavailable`);
  }
  return value as GlobalRecord;
}

function isRecord(value: unknown): value is GlobalRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}
