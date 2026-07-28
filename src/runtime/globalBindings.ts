import type { TavernEventBridge } from './registerLifecycle.ts';
import type { ScriptVariableBindings } from './workbenchSettings.ts';
import type {
  HostWorldbookEntry,
  TavernDataBindings,
} from './tavernHost.ts';

type GlobalRecord = Record<string, unknown>;
type Listener = (...args: unknown[]) => void;

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

  return {
    getChatVariables: () => getVariables({ type: 'chat' }),
    getCharWorldbookNames: () => getCharWorldbookNames('current'),
    getChatWorldbookName: () => getChatWorldbookName('current'),
    getGlobalWorldbookNames,
    getWorldbook,
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
  names: { characterMessageRendered: string; chatChanged: string };
} {
  const eventOn = requireFunction<
    (event: string, listener: Listener) => { stop?: () => void } | void
  >(globalObject.eventOn, 'eventOn');
  const eventNames = requireRecord(globalObject.tavern_events, 'tavern_events');
  const characterMessageRendered = requireString(
    eventNames.CHARACTER_MESSAGE_RENDERED,
    'tavern_events.CHARACTER_MESSAGE_RENDERED',
  );
  const chatChanged = requireString(
    eventNames.CHAT_CHANGED,
    'tavern_events.CHAT_CHANGED',
  );
  const stops = new Map<Listener, () => void>();
  return {
    bridge: {
      on(event, listener) {
        const subscription = eventOn(event, listener);
        if (subscription?.stop) stops.set(listener, subscription.stop);
      },
      off(_event, listener) {
        stops.get(listener)?.();
        stops.delete(listener);
      },
    },
    names: { characterMessageRendered, chatChanged },
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

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${name} is unavailable`);
  }
  return value;
}
