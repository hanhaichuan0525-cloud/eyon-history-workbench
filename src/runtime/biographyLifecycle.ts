import type { TavernRuntime } from './contracts.ts';

const SUPPORTED_GENERATION_TYPES = new Set<string | undefined>([
  undefined,
  'normal',
  'regenerate',
  'swipe',
]);

export class BiographyLifecycle {
  private readonly controller: BiographyLifecycleController;
  private readonly runtime: TavernRuntime;

  constructor(controller: BiographyLifecycleController, runtime: TavernRuntime) {
    this.controller = controller;
    this.runtime = runtime;
  }

  async beforeGeneration(type?: string): Promise<boolean> {
    if (!SUPPORTED_GENERATION_TYPES.has(type)) return false;
    const userMessage = this.findLatestVisibleUserMessage();
    if (!userMessage) return false;
    return (await this.controller.prepareText(userMessage.message)) !== null;
  }

  async onAssistantRendered(messageId: number): Promise<void> {
    await this.controller.commitRendered(messageId);
  }

  async onChatChanged(): Promise<void> {
    await this.controller.cancelPending();
  }

  private findLatestVisibleUserMessage() {
    const lastMessageId = this.runtime.getLastMessageId();
    if (lastMessageId < 0) return null;
    const messages = this.runtime.getChatMessages(
      `0-${lastMessageId}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && !message.is_hidden) return message;
    }
    return null;
  }
}

export interface BiographyLifecycleController {
  prepareText(text: string): Promise<unknown | null>;
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
}
