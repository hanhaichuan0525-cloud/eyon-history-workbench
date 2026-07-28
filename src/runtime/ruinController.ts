import { createButtonCommand, parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type {
  RuinCandidateRecord,
} from '../storage/ruins.ts';
import {
  RuinWorkflow,
  type RuinRequestIdentity,
} from '../workflows/ruin.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

export type RuinControllerStatus =
  | 'assembling_context'
  | 'generating_candidates'
  | 'ready'
  | 'failed';

export interface RuinControllerHooks {
  onStatus?(status: RuinControllerStatus, detail?: string): void;
}

export class RuinTransactionGuard {
  private epoch = 0;

  currentEpoch(): number {
    return this.epoch;
  }

  cancelAll(): void {
    this.epoch += 1;
  }

  assertCurrent(epoch: number): void {
    if (epoch !== this.epoch) {
      throw new Error('Ruin request was cancelled by a lifecycle change');
    }
  }
}

export class RuinController {
  private readonly inFlight = new Map<string, Promise<RuinCandidateRecord>>();
  private readonly workflow: RuinWorkflow;
  private readonly runtime: TavernRuntime;
  private readonly hooks: RuinControllerHooks;
  private readonly transactionGuard: RuinTransactionGuard;

  constructor(
    workflow: RuinWorkflow,
    runtime: TavernRuntime,
    hooks: RuinControllerHooks = {},
    transactionGuard = new RuinTransactionGuard(),
  ) {
    this.workflow = workflow;
    this.runtime = runtime;
    this.hooks = hooks;
    this.transactionGuard = transactionGuard;
  }

  async generateFromText(
    text: string,
    input: RuinGenerationInput,
  ): Promise<RuinCandidateRecord | null> {
    const command = parseTextCommand(text);
    if (!command || command.type !== 'ruin.generate') return null;
    const message = this.latestVisibleMessage('user');
    if (fingerprintText(message.message) !== fingerprintText(text)) {
      throw new Error('Ruin command does not match the active user floor');
    }
    return this.generate(command, input, this.identityFor(message.message_id));
  }

  async generateFromPanel(
    input: RuinGenerationInput,
  ): Promise<RuinCandidateRecord> {
    const message = this.latestVisibleMessage();
    return this.generate(
      createButtonCommand('ruin.generate', '墟境探索'),
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
    input: RuinGenerationInput,
    identity: RuinRequestIdentity,
  ): Promise<RuinCandidateRecord> {
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
        this.hooks.onStatus?.('assembling_context', '伊雍正在检索历史坐标');
        this.hooks.onStatus?.('generating_candidates', '伊雍正在编织历史岔路');
        const record = await this.workflow.generate(command, input, identity);
        this.hooks.onStatus?.('ready', '候选墟境已经完成');
        return record;
      } catch (error) {
        this.hooks.onStatus?.(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
    })().finally(() => {
      if (this.inFlight.get(key) === task) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, task);
    return task;
  }

  private identityFor(messageId: number): RuinRequestIdentity {
    const characterKey = this.runtime.getCurrentCharacterName()?.trim();
    const chatId = this.runtime.getCurrentChatId().trim();
    if (!characterKey || !chatId) {
      throw new Error('No active character chat is available');
    }
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
    const last = this.runtime.getLastMessageId();
    const messages = this.runtime.getChatMessages(`0-${last}`, {
      include_swipes: false,
    });
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.is_hidden && (!role || message.role === role)) return message;
    }
    throw new Error('No visible floor is available for ruin generation');
  }

  private requireVisibleMessage(messageId: number) {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.is_hidden) {
      throw new Error('Ruin anchor floor is unavailable');
    }
    return message;
  }
}

export function createRuinIdentityAssertion(
  runtime: TavernRuntime,
  transactionGuard = new RuinTransactionGuard(),
) {
  return async (identity: RuinRequestIdentity): Promise<void> => {
    transactionGuard.assertCurrent(identity.lifecycleEpoch);
    const characterKey = runtime.getCurrentCharacterName()?.trim();
    const chatId = runtime.getCurrentChatId().trim();
    if (
      !characterKey
      || !chatId
      || namespaceKey({ characterKey, chatId }) !== namespaceKey(identity.namespace)
    ) {
      throw new Error('Chat changed while ruin request was running');
    }
    const message = runtime
      .getChatMessages(identity.triggerMessageId, { include_swipes: false })
      .find(item => item.message_id === identity.triggerMessageId);
    if (
      !message
      || message.is_hidden
      || fingerprintText(message.message) !== identity.triggerTextHash
      || runtime.getMessageSwipeId(identity.triggerMessageId) !== identity.triggerSwipeId
      || runtime.getLastMessageId() !== identity.triggerMessageId
    ) {
      throw new Error('Ruin anchor floor changed while request was running');
    }
  };
}
