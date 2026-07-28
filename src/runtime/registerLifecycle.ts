import type { BiographyLifecycle } from './biographyLifecycle.ts';

export interface TavernEventBridge {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
}

export interface BiographyLifecycleEvents {
  characterMessageRendered: string;
  chatChanged: string;
}

export interface LifecycleRegistration {
  dispose(): void;
}

export function registerBiographyLifecycle(
  lifecycle: BiographyLifecycle,
  events: TavernEventBridge,
  eventNames: BiographyLifecycleEvents,
  globalObject: Record<string, unknown> = globalThis as Record<string, unknown>,
): LifecycleRegistration {
  const previous = globalObject.eyon_history_generateInterceptor;
  const interceptor = async (
    _chat: unknown,
    _contextSize: number,
    _abort: (immediately: boolean) => void,
    type?: string,
  ): Promise<void> => {
    try {
      await lifecycle.beforeGeneration(type);
    } catch (error) {
      console.error(
        '[Eyon History Workbench] biography preparation failed; normal generation continues',
        error,
      );
      await lifecycle.onChatChanged();
    }
  };
  globalObject.eyon_history_generateInterceptor = interceptor;

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
  const onChatChanged = () => {
    void lifecycle.onChatChanged().catch(error => {
      console.error(
        '[Eyon History Workbench] failed to clear pending biography request',
        error,
      );
    });
  };
  events.on(eventNames.characterMessageRendered, onRendered);
  events.on(eventNames.chatChanged, onChatChanged);

  return {
    dispose() {
      events.off?.(eventNames.characterMessageRendered, onRendered);
      events.off?.(eventNames.chatChanged, onChatChanged);
      void lifecycle.onChatChanged();
      if (previous === undefined) {
        delete globalObject.eyon_history_generateInterceptor;
      } else {
        globalObject.eyon_history_generateInterceptor = previous;
      }
    },
  };
}
