import { createButtonCommand, parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import {
  GenealogyWorkflow,
  type GenealogyRequestIdentity,
} from '../workflows/genealogy.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';
import { isTaskCancellationError } from './tavernGeneration.ts';

export type GenealogyControllerStatus =
  | 'assembling_context'
  | 'generating_genealogy'
  | 'ready'
  | 'failed';

export interface GenealogyControllerHooks {
  onStatus?(status: GenealogyControllerStatus, detail?: string): void;
}

export class GenealogyTransactionGuard {
  private epoch = 0;

  currentEpoch(): number {
    return this.epoch;
  }

  cancelAll(): void {
    this.epoch += 1;
  }

  assertCurrent(epoch: number): void {
    if (epoch !== this.epoch) {
      throw new Error('Genealogy request was cancelled by a lifecycle change');
    }
  }
}

export class GenealogyController {
  private readonly inFlight = new Map<string, Promise<GenealogyRecord>>();
  private readonly workflow: GenealogyWorkflow;
  private readonly runtime: TavernRuntime;
  private readonly hooks: GenealogyControllerHooks;
  private readonly transactionGuard: GenealogyTransactionGuard;

  constructor(
    workflow: GenealogyWorkflow,
    runtime: TavernRuntime,
    hooks: GenealogyControllerHooks = {},
    transactionGuard = new GenealogyTransactionGuard(),
  ) {
    this.workflow = workflow;
    this.runtime = runtime;
    this.hooks = hooks;
    this.transactionGuard = transactionGuard;
  }

  async generateFromText(
    text: string,
    input: GenealogyGenerationInput,
  ): Promise<GenealogyRecord | null> {
    const command = parseTextCommand(text);
    if (!command || command.type !== 'genealogy.generate') return null;
    const message = this.latestVisibleMessage('user');
    if (fingerprintText(message.message) !== fingerprintText(text)) {
      throw new Error('Genealogy command does not match the active user floor');
    }
    return this.generate(command, input, this.identityFor(message.message_id));
  }

  async generateFromPanel(
    input: GenealogyGenerationInput,
  ): Promise<GenealogyRecord> {
    const message = this.latestVisibleMessage();
    return this.generate(
      createButtonCommand('genealogy.generate', `宗族谱系 ${input.focusCharacter.name}`),
      input,
      this.identityFor(message.message_id),
    );
  }

  cancelPending(): void {
    this.transactionGuard.cancelAll();
    this.inFlight.clear();
  }

  private async generate(
    command: ReturnType<typeof createButtonCommand>,
    input: GenealogyGenerationInput,
    identity: GenealogyRequestIdentity,
  ): Promise<GenealogyRecord> {
    const key = [
      namespaceKey(identity.namespace),
      identity.triggerMessageId,
      identity.triggerTextHash,
      identity.triggerSwipeId,
      identity.lifecycleEpoch,
      fingerprintText(JSON.stringify(input)),
    ].join('::');
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const task = (async () => {
      try {
        this.hooks.onStatus?.('assembling_context', '正在查找中心人物与宗族的旧记录');
        this.hooks.onStatus?.('generating_genealogy', '正在核对年龄、世代与亲缘位置');
        const record = await this.workflow.generate(command, input, identity);
        this.hooks.onStatus?.('ready', '宗族谱系已完成并写入当前存档');
        return record;
      } catch (error) {
        if (isTaskCancellationError(error)) throw error;
        this.hooks.onStatus?.(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    })().finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  private identityFor(messageId: number): GenealogyRequestIdentity {
    const characterKey = this.runtime.getCurrentCharacterName()?.trim();
    const chatId = this.runtime.getCurrentChatId().trim();
    if (!characterKey || !chatId) throw new Error('No active character chat is available');
    const message = this.requireVisibleMessage(messageId);
    return {
      namespace: { characterKey, chatId },
      triggerMessageId: messageId,
      triggerTextHash: fingerprintText(message.message),
      triggerSwipeId: this.runtime.getMessageSwipeId(messageId),
      lifecycleEpoch: this.transactionGuard.currentEpoch(),
    };
  }

  private latestVisibleMessage(role?: 'user') {
    const messages = this.runtime.getChatMessages(
      `0-${this.runtime.getLastMessageId()}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.is_hidden && (!role || message.role === role)) return message;
    }
    throw new Error('No visible floor is available for genealogy generation');
  }

  private requireVisibleMessage(messageId: number) {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.is_hidden) throw new Error('Genealogy anchor floor is unavailable');
    return message;
  }
}

export function createGenealogyIdentityAssertion(
  runtime: TavernRuntime,
  transactionGuard = new GenealogyTransactionGuard(),
) {
  return async (identity: GenealogyRequestIdentity): Promise<void> => {
    transactionGuard.assertCurrent(identity.lifecycleEpoch);
    const characterKey = runtime.getCurrentCharacterName()?.trim();
    const chatId = runtime.getCurrentChatId().trim();
    if (
      !characterKey
      || !chatId
      || namespaceKey({ characterKey, chatId }) !== namespaceKey(identity.namespace)
    ) {
      throw new Error('Chat changed while genealogy request was running');
    }
    const message = runtime
      .getChatMessages(identity.triggerMessageId, { include_swipes: false })
      .find(item => item.message_id === identity.triggerMessageId);
    if (
      !message
      || message.is_hidden
      || fingerprintText(message.message) !== identity.triggerTextHash
      || runtime.getMessageSwipeId(identity.triggerMessageId) !== identity.triggerSwipeId
    ) {
      throw new Error('Genealogy anchor floor changed while request was running');
    }
  };
}
