import { parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import type {
  BiographyPreparation,
  BiographyWorkflow,
  BiographyWorkflowResult,
  BiographyWorkflowScope,
} from '../workflows/biography.ts';
import type {
  BiographyFloorLock,
  TavernBiographyShellAdapter,
} from './tavernBiographyShell.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

export type BiographyControllerStatus =
  | 'assembling_context'
  | 'generating_archive'
  | 'awaiting_narrative'
  | 'committed'
  | 'failed';

export interface BiographyControllerHooks {
  onStatus?(status: BiographyControllerStatus, detail?: string): void;
}

export interface PreparedBiography {
  preparation: BiographyPreparation;
  triggerTextHash: string;
}

export class BiographyController {
  private readonly inFlight = new Map<string, Promise<PreparedBiography | null>>();
  private pending: BiographyFloorLock | null = null;
  private readonly workflow: BiographyWorkflow;
  private readonly shell: TavernBiographyShellAdapter;
  private readonly runtime: TavernRuntime;
  private readonly getScope: () => Promise<BiographyWorkflowScope>;
  private readonly hooks: BiographyControllerHooks;

  constructor(
    workflow: BiographyWorkflow,
    shell: TavernBiographyShellAdapter,
    runtime: TavernRuntime,
    getScope: () => Promise<BiographyWorkflowScope>,
    hooks: BiographyControllerHooks = {},
  ) {
    this.workflow = workflow;
    this.shell = shell;
    this.runtime = runtime;
    this.getScope = getScope;
    this.hooks = hooks;
  }

  async prepareText(text: string): Promise<PreparedBiography | null> {
    const command = parseTextCommand(text);
    if (!command || command.type !== 'biography.generate') return null;

    const scope = await this.getScope();
    const trigger = this.requireTrigger(scope.triggerMessageId);
    const triggerTextHash = fingerprintText(trigger.message);
    if (fingerprintText(text) !== triggerTextHash) {
      throw new Error('Generation command does not match the active user floor');
    }

    const key = [
      namespaceKey(scope.namespace),
      scope.triggerMessageId,
      triggerTextHash,
      this.runtime.getMessageSwipeId(scope.triggerMessageId),
    ].join('::');
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.pending) {
      if (pendingKey(this.pending) === key) {
        return {
          preparation: this.pending.preparation,
          triggerTextHash,
        };
      }
      await this.clearPending();
    }

    const task = this.prepare(
      command,
      triggerTextHash,
      this.runtime.getMessageSwipeId(scope.triggerMessageId),
    )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  async commitRendered(assistantMessageId: number): Promise<BiographyWorkflowResult | null> {
    const lock = this.pending;
    if (!lock) return null;
    this.pending = null;
    await this.shell.clear(lock.preparation.requestId);
    try {
      await this.shell.assertRenderedFloor(lock, assistantMessageId);
      const result = await this.workflow.commit(lock.preparation, assistantMessageId);
      await this.shell.attachRequestMetadata(lock, assistantMessageId);
      this.hooks.onStatus?.('committed', '传记已写入当前存档');
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.hooks.onStatus?.('failed', detail);
      throw error;
    }
  }

  async cancelPending(): Promise<void> {
    await this.clearPending();
  }

  private async prepare(
    command: NonNullable<ReturnType<typeof parseTextCommand>>,
    triggerTextHash: string,
    triggerSwipeId: number | null,
  ): Promise<PreparedBiography> {
    try {
      this.hooks.onStatus?.('assembling_context', '伊雍正在检索史料');
      this.hooks.onStatus?.('generating_archive', '伊雍正在整理史料');
      const preparation = await this.workflow.prepare(command);
      const lock: BiographyFloorLock = {
        preparation,
        triggerTextHash,
        triggerSwipeId,
      };
      await this.shell.arm(lock);
      this.pending = lock;
      this.hooks.onStatus?.('awaiting_narrative', '等待正文模型自然展开伊雍回应');
      return { preparation, triggerTextHash };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.hooks.onStatus?.('failed', detail);
      throw error;
    }
  }

  private requireTrigger(messageId: number) {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.role !== 'user' || message.is_hidden) {
      throw new Error('Active biography trigger is not a visible user floor');
    }
    return message;
  }

  private async clearPending(): Promise<void> {
    if (!this.pending) return;
    await this.shell.clear(this.pending.preparation.requestId);
    this.pending = null;
  }
}

function pendingKey(lock: BiographyFloorLock): string {
  return [
    namespaceKey(lock.preparation.scope.namespace),
    lock.preparation.scope.triggerMessageId,
    lock.triggerTextHash,
    lock.triggerSwipeId,
  ].join('::');
}
