import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { BiographyWorkflowScope } from '../workflows/biography.ts';
import type { TavernRuntime } from './contracts.ts';

export class TavernScopeReader {
  private readonly runtime: TavernRuntime;
  private readonly triggerMessageId: () => number;

  constructor(
    runtime: TavernRuntime,
    triggerMessageId: () => number,
  ) {
    this.runtime = runtime;
    this.triggerMessageId = triggerMessageId;
  }

  getNamespace(): WorkbenchNamespace {
    const characterKey = this.runtime.getCurrentCharacterName()?.trim();
    const chatId = this.runtime.getCurrentChatId().trim();
    if (!characterKey || !chatId) {
      throw new Error('No active character chat is available');
    }
    return { characterKey, chatId };
  }

  getScope(): BiographyWorkflowScope {
    const triggerMessageId = this.triggerMessageId();
    if (!Number.isInteger(triggerMessageId) || triggerMessageId < 0) {
      throw new Error('Trigger message id is invalid');
    }
    return {
      namespace: this.getNamespace(),
      triggerMessageId,
    };
  }
}
