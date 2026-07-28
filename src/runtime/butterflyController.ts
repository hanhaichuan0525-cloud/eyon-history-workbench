import { parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  pendingSettlementKey,
  type ButterflyRecord,
  type ButterflyRepository,
  type PendingSettlement,
} from '../storage/butterflies.ts';
import type { TavernRuntime } from './contracts.ts';
import { TavernButterflyContextAssembler } from './butterflyContext.ts';
import { ButterflyWorkflow } from '../workflows/butterfly.ts';

export type ButterflyControllerStatus =
  | 'freezing_butterfly'
  | 'generating_butterfly'
  | 'committing_butterfly'
  | 'butterfly_ready'
  | 'butterfly_pending';

export interface ButterflyControllerHooks {
  onStatus?(status: ButterflyControllerStatus, detail?: string): void;
}

export class ButterflyController {
  private readonly assembler: TavernButterflyContextAssembler;
  private readonly workflow: ButterflyWorkflow;
  private readonly repository: ButterflyRepository;
  private readonly runtime: TavernRuntime;
  private readonly hooks: ButterflyControllerHooks;
  private readonly createRequestId: () => string;
  private readonly roll: () => number;
  private readonly now: () => number;
  private epoch = 0;

  constructor(dependencies: {
    assembler: TavernButterflyContextAssembler;
    workflow: ButterflyWorkflow;
    repository: ButterflyRepository;
    runtime: TavernRuntime;
    createRequestId(): string;
    roll(): number;
    now(): number;
    hooks?: ButterflyControllerHooks;
  }) {
    this.assembler = dependencies.assembler;
    this.workflow = dependencies.workflow;
    this.repository = dependencies.repository;
    this.runtime = dependencies.runtime;
    this.createRequestId = dependencies.createRequestId;
    this.roll = dependencies.roll;
    this.now = dependencies.now;
    this.hooks = dependencies.hooks ?? {};
  }

  async prepareText(text: string): Promise<PendingSettlement | null> {
    const command = parseTextCommand(text);
    if (!command || command.type !== 'ruin.return') return null;
    const user = this.latestVisibleUser();
    if (user.message.trim() !== command.raw) {
      throw new Error('遣返命令与当前玩家楼不一致');
    }
    const namespace = currentNamespace(this.runtime);
    const [namespacePending, namespaceRecords] = await Promise.all([
      this.repository.listPending(namespace),
      this.repository.list(namespace),
    ]);
    const sameTrigger = (record: {
      request: PendingSettlement['request'];
    }) => (
      record.request.trigger.userMessageId === user.message_id
      && record.request.trigger.rawCommand.trim() === command.raw
    );
    const triggerPending = namespacePending.find(sameTrigger);
    if (triggerPending) return triggerPending;
    const triggerRecord = namespaceRecords.find(sameTrigger);
    if (triggerRecord) {
      const now = this.now();
      const pending: PendingSettlement = {
        key: pendingSettlementKey(namespace, triggerRecord.runId),
        namespace,
        runId: triggerRecord.runId,
        request: {
          ...triggerRecord.request,
          requestId: triggerRecord.requestId,
          trigger: {
            userMessageId: user.message_id,
            returnAssistantMessageId: 0,
            type: command.source,
            rawCommand: command.raw,
          },
        },
        assistantSwipeId: null,
        sourceHash: triggerRecord.sourceHash,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.savePending(pending);
      return pending;
    }
    this.hooks.onStatus?.('freezing_butterfly', '伊雍正在封存本轮历史锚点');
    const frozen = await this.assembler.freeze({
      requestId: this.createRequestId(),
      namespace,
      userMessageId: user.message_id,
      rawCommand: command.raw,
      triggerType: command.source,
      roll: this.roll(),
    });
    const key = pendingSettlementKey(namespace, frozen.request.runId);
    const existingPending = await this.repository.getPending(key);
    if (existingPending) return existingPending;
    const now = this.now();
    const pending: PendingSettlement = {
      key,
      namespace,
      runId: frozen.request.runId,
      request: frozen.request,
      assistantSwipeId: null,
      sourceHash: frozen.sourceHash,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.savePending(pending);
    return pending;
  }

  async commitRendered(messageId: number): Promise<ButterflyRecord | null> {
    const namespace = currentNamespace(this.runtime);
    const candidates = await this.repository.listPending(namespace);
    const pending = candidates.find(record =>
      record.request.trigger.userMessageId + 1 === messageId
    );
    if (!pending) return null;
    const epoch = this.epoch;
    try {
      const request = this.assembler.attachReturnFloor(pending.request, messageId);
      const updated: PendingSettlement = {
        ...pending,
        request,
        assistantSwipeId: this.runtime.getMessageSwipeId(messageId),
        sourceHash: pending.sourceHash,
        revision: pending.revision + 1,
        updatedAt: this.now(),
        failure: undefined,
      };
      await this.repository.updatePending(updated);
      this.hooks.onStatus?.('generating_butterfly', '伊雍正在校订历史余波');
      const record = await this.workflow.settle(updated);
      if (epoch !== this.epoch) throw new Error('聊天切换后结算结果已被隔离');
      this.hooks.onStatus?.('butterfly_ready', '蝴蝶效应锚定已经归档');
      return record;
    } catch (error) {
      const current = await this.repository.getPending(pending.key);
      if (current) {
        await this.repository.updatePending({
          ...current,
          failure: {
            code: error instanceof Error && 'code' in error
              ? String(error.code)
              : 'SETTLEMENT_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
          revision: current.revision + 1,
          updatedAt: this.now(),
        });
      }
      this.hooks.onStatus?.(
        'butterfly_pending',
        '遣返已完成，历史结算待重试',
      );
      throw error;
    }
  }

  async retry(runId: string): Promise<ButterflyRecord> {
    const namespace = currentNamespace(this.runtime);
    const pending = await this.repository.getPending(
      pendingSettlementKey(namespace, runId),
    );
    if (!pending) throw new Error('没有找到该轮次的待结算快照');
    return this.workflow.settle(pending);
  }

  cancelPending(): void {
    this.epoch += 1;
  }

  async activateCurrentNamespace(): Promise<void> {
    await this.workflow.activateNamespace(currentNamespace(this.runtime));
  }

  async onChatChanged(): Promise<void> {
    this.cancelPending();
    await this.activateCurrentNamespace();
  }

  private latestVisibleUser() {
    const messages = this.runtime.getChatMessages(
      `0-${this.runtime.getLastMessageId()}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && !message.is_hidden) return message;
    }
    throw new Error('当前没有可用的遣返玩家楼');
  }
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) throw new Error('当前没有可用的角色聊天');
  return { characterKey, chatId };
}
