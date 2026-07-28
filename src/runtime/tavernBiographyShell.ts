import type {
  BiographyPreparation,
  BiographyShellAdapter,
} from '../workflows/biography.ts';
import { namespaceKey } from '../core/namespace.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

const REQUEST_DATA_KEY = 'eyonHistoryRequest';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

export interface BiographyFloorLock {
  preparation: BiographyPreparation;
  triggerTextHash: string;
  triggerSwipeId: number | null;
}

export class TavernBiographyShellAdapter implements BiographyShellAdapter {
  private readonly runtime: TavernRuntime;

  constructor(runtime: TavernRuntime) {
    this.runtime = runtime;
  }

  async arm(lock: BiographyFloorLock): Promise<void> {
    await this.runtime.setExtensionPrompt(
      injectionKey(lock.preparation.requestId),
      lock.preparation.instruction,
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
  }

  async clear(requestId: string): Promise<void> {
    await this.runtime.setExtensionPrompt(
      injectionKey(requestId),
      '',
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
  }

  async assertRenderedFloor(
    lock: BiographyFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const namespace = currentNamespace(this.runtime);
    if (namespaceKey(namespace) !== namespaceKey(lock.preparation.scope.namespace)) {
      throw new Error('Chat changed before biography narrative was rendered');
    }

    const triggerId = lock.preparation.scope.triggerMessageId;
    const trigger = requireMessage(this.runtime, triggerId);
    if (
      trigger.role !== 'user'
      || trigger.is_hidden
      || fingerprintText(trigger.message) !== lock.triggerTextHash
      || this.runtime.getMessageSwipeId(triggerId) !== lock.triggerSwipeId
    ) {
      throw new Error('Biography trigger floor changed before commit');
    }

    const assistant = requireMessage(this.runtime, assistantMessageId);
    if (
      assistant.role !== 'assistant'
      || assistant.is_hidden
      || assistantMessageId !== triggerId + 1
      || this.runtime.getLastMessageId() !== assistantMessageId
    ) {
      throw new Error('Rendered assistant floor does not belong to the biography request');
    }
  }

  async attachRequestMetadata(
    lock: BiographyFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const assistant = requireMessage(this.runtime, assistantMessageId);
    await this.runtime.setChatMessages(
      [{
        message_id: assistantMessageId,
        extra: {
          ...(assistant.extra ?? {}),
          [REQUEST_DATA_KEY]: {
            requestId: lock.preparation.requestId,
            triggerMessageId: lock.preparation.scope.triggerMessageId,
            triggerTextHash: lock.triggerTextHash,
            sourceHash: lock.preparation.sourceHash,
            swipeId: this.runtime.getMessageSwipeId(assistantMessageId),
          },
        },
      }],
      { refresh: 'none' },
    );
  }

  async readAssistantMessage(messageId: number): Promise<string> {
    const message = requireMessage(this.runtime, messageId);
    if (message.role !== 'assistant' || message.is_hidden) {
      throw new Error(`Assistant message ${messageId} is unavailable`);
    }
    return message.message;
  }

  async writeAssistantMessage(messageId: number, content: string): Promise<void> {
    await this.readAssistantMessage(messageId);
    await this.runtime.setChatMessages(
      [{ message_id: messageId, message: content }],
      { refresh: 'none' },
    );
  }

  async refreshAssistantMessage(messageId: number): Promise<void> {
    await this.readAssistantMessage(messageId);
    await this.runtime.setChatMessages(
      [{ message_id: messageId }],
      { refresh: 'affected' },
    );
  }
}

function injectionKey(requestId: string): string {
  return `eyon-history-biography-${requestId}`;
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) {
    throw new Error('No active character chat is available');
  }
  return { characterKey, chatId };
}

function requireMessage(runtime: TavernRuntime, messageId: number) {
  const message = runtime
    .getChatMessages(messageId, { include_swipes: false })
    .find(item => item.message_id === messageId);
  if (!message) {
    throw new Error(`Message ${messageId} is unavailable`);
  }
  return message;
}
