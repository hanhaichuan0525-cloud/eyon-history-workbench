import { parseTextCommand, type WorkbenchCommand } from '../core/commands.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';
import type { TavernRuntime } from './contracts.ts';
import { findGenerationTriggerUserMessage } from './generationTrigger.ts';
import { GenerationCancelledError } from './tavernGeneration.ts';
import {
  noopRuinTurnGuard,
  type RuinTurnGuard,
} from './ruinTurnGuard.ts';

const SUPPORTED_GENERATION_TYPES = new Set<string | undefined>([
  undefined,
  'normal',
  'regenerate',
  'swipe',
]);

export interface WorkbenchBiographyController {
  prepareText(text: string): Promise<unknown | null>;
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
  releaseStaleNarrative?(latestUserMessageId: number): Promise<void>;
}

export interface RuinLifecycleController {
  generateFromText(
    text: string,
    input: RuinGenerationInput,
  ): Promise<unknown | null>;
  cancelPending(): void;
}

/**
 * 进入特异点的生命周期控制器(RuinEntryWorkflow):
 * 渲染事件提交 + 聊天切换/取消时清理注入。
 */
export interface RuinEntryLifecycleController {
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
}

export interface RuinTaskLifecycleController {
  preparePlayerFloor?(text: string, triggerMessageId: number): Promise<boolean>;
  prepareGeneration?(triggerMessageId: number): Promise<boolean>;
  commitRendered(messageId: number): Promise<unknown | null>;
  cancelPending(): Promise<void>;
}

export interface RuinGenerationInputProvider {
  getInput(command: WorkbenchCommand): Promise<RuinGenerationInput>;
}

export interface GenealogyLifecycleController {
  generateFromText(
    text: string,
    input: GenealogyGenerationInput,
  ): Promise<unknown | null>;
  cancelPending(): void;
}

export interface GenealogyGenerationInputProvider {
  getInput(command: WorkbenchCommand): Promise<GenealogyGenerationInput>;
}

export interface ButterflyLifecycleController {
  prepareText(text: string): Promise<unknown | null>;
  commitRendered(messageId: number): Promise<unknown | null>;
  onChatChanged(): Promise<void>;
  releaseStaleNarrative?(latestUserMessageId: number): Promise<void>;
}

export class WorkbenchLifecycle {
  private readonly biography: WorkbenchBiographyController;
  private readonly ruin: RuinLifecycleController;
  private readonly ruinInputProvider: RuinGenerationInputProvider;
  private readonly genealogy: GenealogyLifecycleController;
  private readonly genealogyInputProvider: GenealogyGenerationInputProvider;
  private readonly butterfly: ButterflyLifecycleController;
  private readonly ruinEntry: RuinEntryLifecycleController;
  private readonly ruinTask: RuinTaskLifecycleController;
  private readonly ruinTurnGuard: RuinTurnGuard;
  private readonly runtime: TavernRuntime;
  private returnEpoch = 0;
  private rollbackBarrier: Promise<void> = Promise.resolve();
  /**
   * MESSAGE_SENT 比输入框 DOM 更接近宿主事实：无论点击、回车还是其他扩展
   * 建楼，只要酒馆确认了工作台遣返玩家楼，就在这里承接已准备事务。生成前
   * 钩子等待同一 Promise；手写遣返只触发引导，不冻结历史。
   */
  private returnPreparation: {
    messageId: number;
    rawCommand: string;
    result: Promise<boolean>;
  } | null = null;
  private taskConfirmationPreparation: {
    messageId: number;
    rawText: string;
    result: Promise<boolean>;
  } | null = null;

  constructor(options: {
    biography: WorkbenchBiographyController;
    ruin: RuinLifecycleController;
    ruinInputProvider: RuinGenerationInputProvider;
    genealogy: GenealogyLifecycleController;
    genealogyInputProvider: GenealogyGenerationInputProvider;
    butterfly?: ButterflyLifecycleController;
    ruinEntry?: RuinEntryLifecycleController;
    ruinTask?: RuinTaskLifecycleController;
    ruinTurnGuard?: RuinTurnGuard;
    runtime: TavernRuntime;
  }) {
    this.biography = options.biography;
    this.ruin = options.ruin;
    this.ruinInputProvider = options.ruinInputProvider;
    this.genealogy = options.genealogy;
    this.genealogyInputProvider = options.genealogyInputProvider;
    this.butterfly = options.butterfly ?? {
      async prepareText() { return null; },
      async commitRendered() { return null; },
      async onChatChanged() {},
    };
    this.ruinEntry = options.ruinEntry ?? {
      async commitRendered() { return null; },
      async cancelPending() {},
    };
    this.ruinTask = options.ruinTask ?? {
      async commitRendered() { return null; },
      async cancelPending() {},
    };
    this.ruinTurnGuard = options.ruinTurnGuard ?? noopRuinTurnGuard;
    this.runtime = options.runtime;
  }

  async beforeGeneration(type?: string): Promise<boolean> {
    if (!SUPPORTED_GENERATION_TYPES.has(type)) return false;
    const epoch = this.returnEpoch;
    await this.rollbackBarrier;
    this.assertReturnActive(epoch);
    const userMessage = findGenerationTriggerUserMessage(this.runtime, type);
    if (!userMessage) return false;
    await this.releaseStaleNarratives(userMessage.message_id);
    const queuedTask = this.taskConfirmationPreparation;
    if (
      queuedTask
      && queuedTask.messageId === userMessage.message_id
      && queuedTask.rawText === userMessage.message
    ) {
      await queuedTask.result;
    } else {
      await this.ruinTask.preparePlayerFloor?.(userMessage.message, userMessage.message_id);
    }
    await this.ruinTask.prepareGeneration?.(userMessage.message_id);
    this.assertReturnActive(epoch);
    const command = parseTextCommand(userMessage.message);
    if (!command) {
      await this.ruinTurnGuard.prepareOrdinaryTurn();
      return false;
    }
    if (command.type !== 'ruin.return') await this.ruinTurnGuard.clear();

    if (command.type === 'biography.generate') {
      return (await this.biography.prepareText(userMessage.message)) !== null;
    }
    if (command.type === 'ruin.generate') {
      const input = await this.ruinInputProvider.getInput(command);
      return (
        await this.ruin.generateFromText(userMessage.message, input)
      ) !== null;
    }
    if (command.type === 'genealogy.generate') {
      const input = await this.genealogyInputProvider.getInput(command);
      return (
        await this.genealogy.generateFromText(userMessage.message, input)
      ) !== null;
    }
    if (command.type === 'ruin.return') {
      const queued = this.returnPreparation;
      if (
        queued
        && queued.messageId === userMessage.message_id
        && queued.rawCommand === command.raw
      ) {
        const result = await queued.result;
        this.assertReturnActive(epoch);
        if (result) await this.ruinTurnGuard.clear();
        else await this.ruinTurnGuard.prepareOrdinaryTurn();
        return result;
      }
      const result = (await this.butterfly.prepareText(userMessage.message)) !== null;
      this.assertReturnActive(epoch);
      if (result) await this.ruinTurnGuard.clear();
      else await this.ruinTurnGuard.prepareOrdinaryTurn();
      return result;
    }
    return false;
  }

  /**
   * 酒馆已创建玩家楼后的承接入口。只恢复工作台已准备的遣返事务，
   * 不从聊天文字发起冻结；普通消息保持零副作用。返回值主要供测试与宿主诊断使用，真正
   * 的 fail-closed 仍由 beforeGeneration 等待同一 Promise 后执行。
   */
  onUserMessageSent(messageId: number): Promise<boolean> {
    const epoch = this.returnEpoch;
    return this.rollbackBarrier.then(() => {
      this.assertReturnActive(epoch);
      return this.prepareSentUserFloor(messageId);
    });
  }

  private prepareSentUserFloor(messageId: number): Promise<boolean> {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    const messageText = message?.message ?? '';
    if (!message || message.role !== 'user' || message.is_hidden) {
      this.returnPreparation = null;
      this.taskConfirmationPreparation = null;
      return Promise.resolve(false);
    }
    const command = parseTextCommand(messageText);
    const taskResult = this.ruinTask.preparePlayerFloor?.(messageText, messageId)
      ?? Promise.resolve(false);
    void taskResult.catch(() => undefined);
    this.taskConfirmationPreparation = {
      messageId,
      rawText: messageText,
      result: taskResult,
    };
    if (!command || command.type !== 'ruin.return') {
      this.returnPreparation = null;
      return taskResult;
    }
    const existing = this.returnPreparation;
    if (
      existing
      && existing.messageId === messageId
      && existing.rawCommand === command.raw
    ) {
      return Promise.all([taskResult, existing.result])
        .then(results => results.some(Boolean));
    }
    const result = this.butterfly.prepareText(messageText)
      .then(prepared => prepared !== null);
    // MESSAGE_SENT 的宿主派发器未必等待异步监听器；先挂一个 rejection
    // observer 防止未处理拒绝，但保留原 Promise 给生成前钩子 fail-closed。
    void result.catch(() => undefined);
    this.returnPreparation = {
      messageId,
      rawCommand: command.raw,
      result,
    };
    return Promise.all([taskResult, result]).then(results => results.some(Boolean));
  }

  async onAssistantRendered(messageId: number): Promise<void> {
    const epoch = this.returnEpoch;
    // 任务终态卡与蝴蝶效应面板可能落在同一遣返楼。先让任务卡完成
    // 读改写，再让蝴蝶面板追加，避免两个模块并发覆盖同一条消息。
    const taskResult = await Promise.allSettled([
      this.ruinTask.commitRendered(messageId),
    ]);
    const remainingResults = await Promise.allSettled([
      this.biography.commitRendered(messageId),
      this.butterfly.commitRendered(messageId),
      this.ruinEntry.commitRendered(messageId),
      this.ruinTurnGuard.clear(),
    ]);
    if (
      this.returnPreparation
      && epoch === this.returnEpoch
      && this.returnPreparation.messageId < messageId
    ) {
      this.returnPreparation = null;
    }
    if (
      this.taskConfirmationPreparation
      && epoch === this.returnEpoch
      && this.taskConfirmationPreparation.messageId < messageId
    ) {
      this.taskConfirmationPreparation = null;
    }
    throwSettledFailures([...taskResult, ...remainingResults]);
  }

  async onChatChanged(): Promise<void> {
    this.rollbackBarrier = Promise.resolve();
    this.resetReturnPreparation();
    this.ruin.cancelPending();
    this.genealogy.cancelPending();
    await settleIndependently([
      this.butterfly.onChatChanged(),
      this.biography.cancelPending(),
      this.ruinEntry.cancelPending(),
      this.ruinTask.cancelPending(),
      this.ruinTurnGuard.clear(),
    ]);
  }

  /** 停止/回滚/新墟境不能复用同 floor id 的旧 MESSAGE_SENT Promise。 */
  resetReturnPreparation(rollback?: Promise<void>): void {
    this.returnEpoch += 1;
    this.returnPreparation = null;
    this.taskConfirmationPreparation = null;
    if (rollback) this.rollbackBarrier = Promise.all([this.rollbackBarrier, rollback]).then(() => undefined);
    void this.rollbackBarrier.catch(() => undefined);
  }

  private assertReturnActive(epoch: number): void {
    if (epoch !== this.returnEpoch) throw new GenerationCancelledError('butterfly');
  }

  private async releaseStaleNarratives(latestUserMessageId: number): Promise<void> {
    const tasks = [
      this.biography.releaseStaleNarrative?.(latestUserMessageId),
      this.butterfly.releaseStaleNarrative?.(latestUserMessageId),
    ].filter((task): task is Promise<void> => task !== undefined);
    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === 'rejected') {
        // 过期提示的清理失败不得截断玩家的普通正文。
        console.error(
          '[Eyon History Workbench] failed to release a stale narrative lease',
          result.reason,
        );
      }
    }
  }
}

async function settleIndependently(tasks: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(tasks);
  throwSettledFailures(results);
}

function throwSettledFailures(results: PromiseSettledResult<unknown>[]): void {
  const failures = results.flatMap(result =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple workbench modules failed');
  }
}
