import type { TavernRuntime } from './contracts.ts';
import { findGenerationTriggerUserMessage } from './generationTrigger.ts';

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
    const userMessage = findGenerationTriggerUserMessage(this.runtime, type);
    if (!userMessage) return false;
    return (await this.controller.prepareText(userMessage.message)) !== null;
  }

  async onAssistantRendered(messageId: number): Promise<void> {
    await this.controller.commitRendered(messageId);
  }

  async onChatChanged(): Promise<void> {
    await this.controller.cancelPending();
  }

}

export interface BiographyLifecycleController {
  prepareText(text: string): Promise<unknown | null>;
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
}
