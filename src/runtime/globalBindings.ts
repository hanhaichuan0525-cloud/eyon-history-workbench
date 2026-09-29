import type { TavernEventBridge } from './registerLifecycle.ts';
import type { ScriptVariableBindings } from './workbenchSettings.ts';
import type {
  HostWorldbookEntry,
  TavernDataBindings,
} from './tavernHost.ts';
import {
  resolveHostGlobal,
  resolveTavernHelperFunction,
} from './tavernRuntimeAdapter.ts';

type GlobalRecord = Record<string, unknown>;
type Listener = (...args: unknown[]) => unknown;

export async function waitForGlobalMvu(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): Promise<void> {
  const waitGlobalInitialized = resolveTavernHelperFunction<
    (name: string) => Promise<void>
  >(globalObject, 'waitGlobalInitialized') ?? globalObject.waitGlobalInitialized;
  if (typeof waitGlobalInitialized === 'function') {
    await (waitGlobalInitialized as (name: string) => Promise<void>)('Mvu');
  }
  const resolvedMvu = resolveHostGlobal(globalObject, 'Mvu');
  const mvu = isRecord(resolvedMvu) ? resolvedMvu : null;
  if (typeof mvu?.getMvuData !== 'function') {
    throw new Error('Mvu.getMvuData is unavailable');
  }
}

export function createGlobalDataBindings(
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): TavernDataBindings {
  const getVariables = resolveRequiredFunction<
    (option: Record<string, unknown>) => Record<string, unknown>
  >(globalObject, 'getVariables');
  const getCharWorldbookNames = resolveRequiredFunction<
    (_character: 'current') => { primary: string | null; additional: string[] }
  >(globalObject, 'getCharWorldbookNames');
  const getChatWorldbookName = resolveRequiredFunction<
    (_chat: 'current') => string | null
  >(globalObject, 'getChatWorldbookName');
  const getGlobalWorldbookNames = resolveRequiredFunction<() => string[]>(
    globalObject,
    'getGlobalWorldbookNames',
  );
  const getWorldbook = resolveRequiredFunction<
    (name: string) => Promise<HostWorldbookEntry[]>
  >(globalObject, 'getWorldbook');
  const getWorldbookNames = resolveRequiredFunction<() => string[]>(
    globalObject,
    'getWorldbookNames',
  );
  const rebindGlobalWorldbooks = resolveRequiredFunction<
    (names: string[]) => Promise<void>
  >(globalObject, 'rebindGlobalWorldbooks');
  // internal.88（§6 步 B）：createWorldbook / createWorldbookEntries / updateWorldbookWith
  // 随世界书镜像退役一并移除——它们此前只为镜像写入服务，却是**加载期硬依赖**
  // （requireFunction 缺失即抛错），删掉后脚本不再要求宿主提供世界书写接口。
  const deleteWorldbookEntries = resolveTavernHelperFunction<
    (
      name: string,
      predicate: (entry: HostWorldbookEntry) => boolean,
      options?: { render?: 'debounced' | 'immediate' },
    ) => Promise<{ deleted_entries: HostWorldbookEntry[] }>
  >(globalObject, 'deleteWorldbookEntries')
    ?? (typeof globalObject.deleteWorldbookEntries === 'function'
      ? globalObject.deleteWorldbookEntries as (
        name: string,
        predicate: (entry: HostWorldbookEntry) => boolean,
        options?: { render?: 'debounced' | 'immediate' },
      ) => Promise<{ deleted_entries: HostWorldbookEntry[] }>
      : null);
  const createChatMessages = resolveRequiredFunction<
    (
      messages: Array<{ role: 'user'; message: string }>,
      options?: { refresh?: 'none' | 'affected' | 'all' },
    ) => Promise<void>
  >(globalObject, 'createChatMessages');
  const triggerSlash = resolveRequiredFunction<(command: string) => Promise<string>>(
    globalObject,
    'triggerSlash',
  );
  const resolvedMvu = resolveHostGlobal(globalObject, 'Mvu');
  const mvu = isRecord(resolvedMvu) ? resolvedMvu : null;
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
  // Tavern Helper scripts expose these helpers directly in their script
  // window. Prefer that local binding so the script-scoped variable store is
  // preserved; UI extensions instead resolve the parent TavernHelper object.
  const getVariables = (typeof globalObject.getVariables === 'function'
    ? globalObject.getVariables as (
        option: Record<string, unknown>,
      ) => Record<string, unknown>
    : resolveTavernHelperFunction<
    (option: Record<string, unknown>) => Record<string, unknown>
  >(globalObject, 'getVariables'));
  const replaceVariables = (typeof globalObject.replaceVariables === 'function'
    ? globalObject.replaceVariables as (
        variables: Record<string, unknown>,
        option: Record<string, unknown>,
      ) => void
    : resolveTavernHelperFunction<
    (variables: Record<string, unknown>, option: Record<string, unknown>) => void
  >(globalObject, 'replaceVariables'));
  const getScriptId = (typeof globalObject.getScriptId === 'function'
    ? globalObject.getScriptId as () => string
    : resolveTavernHelperFunction<() => string>(globalObject, 'getScriptId'));
  if (getVariables && replaceVariables && getScriptId) {
    const option = () => ({ type: 'script', script_id: getScriptId() });
    return {
      getScriptVariables: () => getVariables(option()),
      replaceScriptVariables: variables => replaceVariables(variables, option()),
    };
  }

  // UI extensions do not run inside a Tavern Helper script iframe and therefore
  // have no script_id. Keep the same settings schema, but persist it in the
  // extension namespace owned by SillyTavern instead of inventing a fake script.
  const sillyTavern = requireRecord(
    resolveHostGlobal(globalObject, 'SillyTavern'),
    'SillyTavern',
  );
  const getContext = typeof sillyTavern.getContext === 'function'
    ? sillyTavern.getContext as () => Record<string, unknown>
    : null;
  const context = getContext?.();
  const extensionSettings = isRecord(context?.extensionSettings)
    ? context.extensionSettings
    : isRecord(sillyTavern.extensionSettings)
      ? sillyTavern.extensionSettings
      : null;
  if (!extensionSettings) throw new Error('SillyTavern.extensionSettings is unavailable');
  const saveSettingsDebounced = typeof context?.saveSettingsDebounced === 'function'
    ? context.saveSettingsDebounced as () => Promise<void> | void
    : typeof sillyTavern.saveSettingsDebounced === 'function'
      ? sillyTavern.saveSettingsDebounced as () => Promise<void> | void
      : null;
  const extensionKey = 'eyon-history-workbench';
  return {
    getScriptVariables: () => ({
      eyonHistoryWorkbench: structuredClone(extensionSettings[extensionKey] ?? {}),
    }),
    replaceScriptVariables: variables => {
      extensionSettings[extensionKey] = structuredClone(variables.eyonHistoryWorkbench ?? {});
      void saveSettingsDebounced?.();
    },
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
  const resolvedSillyTavern = resolveHostGlobal(globalObject, 'SillyTavern');
  const sillyTavern = isRecord(resolvedSillyTavern)
    ? resolvedSillyTavern
    : null;
  const eventSource = isRecord(sillyTavern?.eventSource)
    ? sillyTavern.eventSource
    : null;
  const eventOn = resolveTavernHelperFunction<
    (event: string, listener: Listener) => { stop?: () => void } | void
  >(globalObject, 'eventOn')
    ?? (typeof globalObject.eventOn === 'function'
      ? globalObject.eventOn as (
          event: string,
          listener: Listener,
        ) => { stop?: () => void } | void
      : typeof eventSource?.on === 'function'
        ? eventSource.on.bind(eventSource) as (
            event: string,
            listener: Listener,
          ) => { stop?: () => void } | void
        : null);
  if (!eventOn) throw new Error('eventOn is unavailable');
  const eventMakeFirst = resolveTavernHelperFunction<(
    event: string,
    listener: Listener,
  ) => { stop?: () => void } | void>(globalObject, 'eventMakeFirst')
    ?? (typeof globalObject.eventMakeFirst === 'function'
      ? globalObject.eventMakeFirst as (
        event: string,
        listener: Listener,
      ) => { stop?: () => void } | void
      : typeof eventSource?.makeFirst === 'function'
        ? eventSource.makeFirst.bind(eventSource) as (
            event: string,
            listener: Listener,
          ) => { stop?: () => void } | void
        : null);
  const eventRemove = resolveTavernHelperFunction<
    (event: string, listener: Listener) => void
  >(globalObject, 'eventRemoveListener')
    ?? (typeof globalObject.eventRemoveListener === 'function'
      ? globalObject.eventRemoveListener as (event: string, listener: Listener) => void
      : typeof eventSource?.removeListener === 'function'
        ? eventSource.removeListener.bind(eventSource) as (
            event: string,
            listener: Listener,
          ) => void
        : null);
  const eventNames = resolveEventNames(globalObject);
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
        else if (eventRemove) stops.set(listener, () => eventRemove(event, listener));
      },
      first: eventMakeFirst
        ? (event, listener) => {
            const subscription = eventMakeFirst(event, listener);
            if (subscription?.stop) stops.set(listener, subscription.stop);
            else if (eventRemove) stops.set(listener, () => eventRemove(event, listener));
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

function resolveRequiredFunction<T extends (...args: never[]) => unknown>(
  globalObject: GlobalRecord,
  name: string,
): T {
  return resolveTavernHelperFunction<T>(globalObject, name)
    ?? requireFunction(globalObject[name], name);
}

function resolveEventNames(globalObject: GlobalRecord): GlobalRecord {
  if (isRecord(globalObject.tavern_events)) return globalObject.tavern_events;
  const resolvedSillyTavern = resolveHostGlobal(globalObject, 'SillyTavern');
  const sillyTavern = isRecord(resolvedSillyTavern)
    ? resolvedSillyTavern
    : null;
  if (isRecord(sillyTavern?.eventTypes)) return sillyTavern.eventTypes;
  const context = typeof sillyTavern?.getContext === 'function'
    ? (sillyTavern.getContext as () => Record<string, unknown>)()
    : null;
  if (isRecord(context?.event_types)) return context.event_types;
  if (isRecord(context?.eventTypes)) return context.eventTypes;
  throw new Error('tavern_events is unavailable');
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
