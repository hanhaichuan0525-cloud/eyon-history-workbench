export interface WorkbenchGenerationLifecycle {
  beforeGeneration(type?: string): Promise<boolean>;
  onUserMessageSent?(messageId: number): Promise<boolean>;
  onAssistantRendered(messageId: number): Promise<void>;
  onChatChanged(): Promise<void>;
}

export interface TavernEventBridge {
  on(event: string, listener: (...args: unknown[]) => unknown): void;
  first?(event: string, listener: (...args: unknown[]) => unknown): void;
  off?(event: string, listener: (...args: unknown[]) => unknown): void;
}

export interface BiographyLifecycleEvents {
  generationAfterCommands: string;
  characterMessageRendered: string;
  chatChanged: string;
  /** 旧宿主缺失时仍保留 generationAfterCommands 兜底。 */
  messageSent?: string;
}

export interface LifecycleRegistration {
  dispose(): void;
}

export function registerBiographyLifecycle(
  lifecycle: WorkbenchGenerationLifecycle,
  events: TavernEventBridge,
  eventNames: BiographyLifecycleEvents,
  globalObject: Record<string, unknown> = globalThis as Record<string, unknown>,
): LifecycleRegistration {
  const previous = globalObject.eyon_history_generateInterceptor;
  const prepare = async (type?: string): Promise<void> => {
    await lifecycle.beforeGeneration(type);
  };
  const failClosed = async (
    error: unknown,
    abort?: (immediately: boolean) => void,
  ): Promise<never> => {
    abort?.(true);
    stopHostGeneration(globalObject);
    await lifecycle.onChatChanged();
    console.error(
      '[Eyon History Workbench] pre-generation preparation failed; generation stopped',
      error,
    );
    throw error;
  };
  const interceptor = async (
    _chat: unknown,
    _contextSize: number,
    abort: (immediately: boolean) => void,
    type?: string,
  ): Promise<void> => {
    try {
      await prepare(type);
    } catch (error) {
      await failClosed(error, abort);
    }
  };
  globalObject.eyon_history_generateInterceptor = interceptor;

  const onBeforeGeneration = async (...args: unknown[]): Promise<void> => {
    const type = typeof args[0] === 'string' ? args[0] : undefined;
    const dryRun = args[2] === true;
    if (dryRun) return;
    try {
      await prepare(type);
    } catch (error) {
      await failClosed(error);
    }
  };

  const onRendered = (...args: unknown[]) => {
    const messageId = Number(args[0]);
    if (!Number.isInteger(messageId) || messageId < 0) return;
    void lifecycle.onAssistantRendered(messageId).catch(error => {
      console.error(
        '[Eyon History Workbench] biography commit rejected',
        error,
      );
    });
  };
  const onMessageSent = (...args: unknown[]) => {
    const messageId = Number(args[0]);
    if (!Number.isInteger(messageId) || messageId < 0) return;
    void lifecycle.onUserMessageSent?.(messageId).catch(error => {
      // 不在 MESSAGE_SENT 回调里直接停止宿主；generationAfterCommands 会等待
      // 同一份拒绝 Promise，并走既有 fail-closed 通道。
      console.error(
        '[Eyon History Workbench] return preparation after message sent failed',
        error,
      );
    });
  };
  const onChatChanged = () => {
    void lifecycle.onChatChanged().catch(error => {
      console.error(
        '[Eyon History Workbench] failed to clear pending biography request',
        error,
      );
    });
  };
  if (events.first) {
    events.first(eventNames.generationAfterCommands, onBeforeGeneration);
  } else {
    events.on(eventNames.generationAfterCommands, onBeforeGeneration);
  }
  events.on(eventNames.characterMessageRendered, onRendered);
  events.on(eventNames.chatChanged, onChatChanged);
  if (eventNames.messageSent && lifecycle.onUserMessageSent) {
    events.on(eventNames.messageSent, onMessageSent);
  }

  return {
    dispose() {
      events.off?.(eventNames.generationAfterCommands, onBeforeGeneration);
      events.off?.(eventNames.characterMessageRendered, onRendered);
      events.off?.(eventNames.chatChanged, onChatChanged);
      if (eventNames.messageSent && lifecycle.onUserMessageSent) {
        events.off?.(eventNames.messageSent, onMessageSent);
      }
      void lifecycle.onChatChanged();
      if (previous === undefined) {
        delete globalObject.eyon_history_generateInterceptor;
      } else {
        globalObject.eyon_history_generateInterceptor = previous;
      }
    },
  };
}

export const registerWorkbenchLifecycle = registerBiographyLifecycle;

function stopHostGeneration(globalObject: Record<string, unknown>): void {
  const sillyTavern = asRecord(globalObject.SillyTavern);
  const getContext = typeof sillyTavern?.getContext === 'function'
    ? sillyTavern.getContext as () => unknown
    : null;
  const context = asRecord(getContext?.());
  if (typeof context?.stopGeneration === 'function') {
    (context.stopGeneration as () => boolean)();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
