import { parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import { createSlot } from '../core/slots.ts';
import { buildBiographyShellInstruction } from '../prompts/biography.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
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
import { GenerationCancelledError, isTaskCancellationError } from './tavernGeneration.ts';

export type BiographyControllerStatus =
  | 'assembling_context'
  | 'generating_archive'
  | 'awaiting_narrative'
  | 'committed'
  | 'failed';

export interface BiographyControllerHooks {
  onStatus?(status: BiographyControllerStatus, detail?: string): void;
  /** 提交成功回调：携带完整结果（含剧情时钟），供上层维护持久状态 */
  onCommitted?(result: BiographyWorkflowResult): void;
}

export interface PreparedBiography {
  preparation: BiographyPreparation;
  triggerTextHash: string;
}

export class BiographyController {
  private epoch = 0;
  private readonly inFlight = new Map<string, Promise<PreparedBiography | null>>();
  private pending: BiographyFloorLock | null = null;
  private settlePoll: {
    lock: BiographyFloorLock;
    messageId: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;
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
    const epoch = this.epoch;
    const command = parseTextCommand(text);
    if (!command || command.type !== 'biography.generate') return null;

    const scope = await this.getScope();
    this.assertActive(epoch);
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
    if (this.inFlight.size) throw new Error('传记正在准备，请等待或停止当前任务');
    if (this.pending) {
      if (pendingKey(this.pending) === key) {
        // 同一触发楼的再次请求(重roll、swipe、双入口):复用已准备的传记。
        // 升级为 reuse 语义:酒馆 regenerate 会重建助手楼号,新楼不再
        // 紧邻触发楼,严格紧邻断言会误拒并销毁事务,导致传记丢失。
        this.pending.reuse = true;
        return {
          preparation: this.pending.preparation,
          triggerTextHash,
        };
      }
      await this.clearPending();
      this.assertActive(epoch);
    }

    // 双入口(生成拦截器 + GENERATION_AFTER_COMMANDS)可能并发进入:
    // 整个准备流程(含 reuse 分支)必须纳入 inFlight,避免并发生成两个
    // requestId 造成协作提示残留与事务互相覆盖。
    const task = (async () => {
      const committed = await this.workflow.findCommittedByTrigger(
        scope.namespace,
        scope.triggerMessageId,
      );
      this.assertActive(epoch);
      if (committed) {
        console.info('[Eyon History Workbench] biography reuse path', {
          triggerMessageId: scope.triggerMessageId,
          recordKey: committed.key,
          status: committed.status,
        });
        const triggerSwipeId = this.runtime.getMessageSwipeId(scope.triggerMessageId);
        const preparation = buildReusePreparation(committed, scope);
        const lock: BiographyFloorLock = {
          preparation,
          triggerTextHash,
          triggerSwipeId,
          reuse: true,
        };
        await this.shell.arm(lock);
        if (epoch !== this.epoch) {
          await this.shell.clear(lock.preparation.requestId);
          this.assertActive(epoch);
        }
        this.pending = lock;
        this.hooks.onStatus?.('awaiting_narrative', '复用已有传记，正在重写正文');
        return { preparation, triggerTextHash };
      }
      console.info('[Eyon History Workbench] biography fresh generation path', {
        triggerMessageId: scope.triggerMessageId,
      });

      return this.prepare(
        command,
        triggerTextHash,
        this.runtime.getMessageSwipeId(scope.triggerMessageId),
        epoch,
      );
    })().finally(() => { if (this.inFlight.get(key) === task) this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }

  async prepareBeforeUserTurn(
    text: string,
    expectedMessageId: number,
  ): Promise<PreparedBiography | null> {
    const epoch = this.epoch;
    const command = parseTextCommand(text);
    if (!command || command.type !== 'biography.generate') return null;

    const current = await this.getScope();
    this.assertActive(epoch);
    const scope: BiographyWorkflowScope = {
      namespace: current.namespace,
      triggerMessageId: expectedMessageId,
    };
    const triggerTextHash = fingerprintText(text);
    const key = [
      namespaceKey(scope.namespace),
      expectedMessageId,
      triggerTextHash,
      'pre-send',
    ].join('::');
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size) throw new Error('传记正在准备，请等待或停止当前任务');
    if (this.pending) await this.clearPending();
    this.assertActive(epoch);

    const task = this.prepare(
      command,
      triggerTextHash,
      null,
      epoch,
      scope,
      async expected => this.assertPendingUserTurn(expected),
    ).finally(() => { if (this.inFlight.get(key) === task) this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }

  async confirmPreparedUserFloor(text: string, messageId: number): Promise<void> {
    const lock = this.pending;
    if (!lock) throw new Error('Biography preparation was not armed before sending');
    if (
      lock.preparation.scope.triggerMessageId !== messageId
      || lock.triggerTextHash !== fingerprintText(text)
    ) {
      await this.clearPending();
      throw new Error('Biography preparation does not belong to the created user floor');
    }
    const trigger = this.requireTrigger(messageId);
    if (fingerprintText(trigger.message) !== lock.triggerTextHash) {
      await this.clearPending();
      throw new Error('Biography trigger text changed while the user floor was created');
    }
    lock.triggerSwipeId = this.runtime.getMessageSwipeId(messageId);
  }

  async commitRendered(assistantMessageId: number): Promise<BiographyWorkflowResult | null> {
    const epoch = this.epoch;
    const lock = this.pending;
    if (!lock) return null;
    // 先断言楼层身份,通过后才销毁锁与协作提示。
    // 重roll(regenerate)时酒馆会先删除旧正文楼再生成新楼,删除动作
    // 可能触发一次指向旧楼/空楼的渲染事件:该事件不是本事务的目标,
    // 必须保留锁等待真正的新楼事件,而不是提前销毁事务导致传记丢失。
    try {
      await this.shell.assertRenderedFloor(lock, assistantMessageId);
      this.assertActive(epoch);
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn('[Eyon History Workbench] biography rendered floor rejected; keeping transaction', {
        assistantMessageId,
        detail,
        reuse: lock.reuse ?? false,
      });
      return null;
    }
    // 协作提示只属于这一次正文生成。楼层身份一旦确认，
    // 即刻释放提示租约；后续等待流式结束、插入传记与存档
    // 仍由 pending lock 独立完成，不再污染下一楼。
    await this.shell.clear(lock.preparation.requestId);
    this.assertActive(epoch);
    // 假流/流式中间态:目标楼已通过身份断言但正文尚未生成完整。
    // 跳过本次提交,保留锁等待内容完整后的下一次渲染事件。
    const content = await this.shell.readAssistantMessage(assistantMessageId);
    this.assertActive(epoch);
    if (!content.trim()) {
      console.warn('[Eyon History Workbench] biography target floor is still empty; waiting for content', {
        assistantMessageId,
        reuse: lock.reuse ?? false,
      });
      return null;
    }
    if (this.runtime.isGenerating?.() === true) {
      // 流式尚未结束：court 可能已经出现，但正文还在继续流出——此时提交
      // 会把「court 之后尚未流出的正文」吞掉。保留锁，等流式结束后的
      // 渲染事件再次进入；同时启动兜底轮询（部分宿主在流式结束时
      // 不再触发渲染事件，靠轮询确认 isGenerating 转 false 后提交）。
      console.warn('[Eyon History Workbench] biography narrative is still streaming; waiting for stream end', {
        assistantMessageId,
        reuse: lock.reuse ?? false,
      });
      this.ensureSettlePoll(lock, assistantMessageId);
      return null;
    }
    return this.commitLock(lock, assistantMessageId);
  }

  private async commitLock(
    lock: BiographyFloorLock,
    assistantMessageId: number,
  ): Promise<BiographyWorkflowResult | null> {
    this.stopSettlePoll();
    if (this.pending !== lock) return null;
    const epoch = this.epoch;
    this.pending = null;
    await this.shell.clear(lock.preparation.requestId);
    this.assertActive(epoch);
    try {
      const result = await this.workflow.commit(lock.preparation, assistantMessageId, () => this.assertActive(epoch));
      this.assertActive(epoch);
      await this.shell.attachRequestMetadata(lock, assistantMessageId);
      this.assertActive(epoch);
      this.hooks.onStatus?.('committed', '完整传记已写入当前存档');
      this.hooks.onCommitted?.(result);
      return result;
    } catch (error) {
      if (epoch !== this.epoch || isTaskCancellationError(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      this.hooks.onStatus?.('failed', detail);
      throw error;
    }
  }

  /**
   * 流式结束兜底轮询：流式未结束时启动，500ms 一次检查 isGenerating；
   * 转 false 后立即提交；锁被清（聊天切换/取消）或超过 60s 仍生成中则放弃。
   */
  private ensureSettlePoll(lock: BiographyFloorLock, assistantMessageId: number): void {
    if (this.settlePoll && this.settlePoll.messageId === assistantMessageId) return;
    this.stopSettlePoll();
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      if (this.pending !== lock) {
        this.stopSettlePoll();
        return;
      }
      if (this.runtime.isGenerating?.() !== true) {
        this.stopSettlePoll();
        void this.commitLock(lock, assistantMessageId).catch(error => {
          console.error('[Eyon History Workbench] biography settle commit failed', error);
        });
        return;
      }
      if (checks >= 120) {
        // 60 秒仍生成中：放弃轮询，等下一次渲染事件再评估。
        this.stopSettlePoll();
      }
    }, 500);
    this.settlePoll = { lock, messageId: assistantMessageId, timer };
  }

  private stopSettlePoll(): void {
    if (this.settlePoll) {
      clearInterval(this.settlePoll.timer);
      this.settlePoll = null;
    }
  }

  async cancelPending(): Promise<void> {
    this.epoch += 1;
    this.inFlight.clear();
    await this.clearPending();
  }

  async releaseStaleNarrative(latestUserMessageId: number): Promise<void> {
    if (
      !this.pending
      || this.pending.preparation.scope.triggerMessageId === latestUserMessageId
    ) return;
    await this.clearPending();
  }

  private async prepare(
    command: NonNullable<ReturnType<typeof parseTextCommand>>,
    triggerTextHash: string,
    triggerSwipeId: number | null,
    epoch: number,
    scope?: BiographyWorkflowScope,
    assertCurrent?: (scope: BiographyWorkflowScope) => Promise<void>,
  ): Promise<PreparedBiography> {
    const assertActive = () => this.assertActive(epoch);
    try {
      assertActive();
      this.hooks.onStatus?.('assembling_context', '正在查找与本次传记有关的史料');
      this.hooks.onStatus?.('generating_archive', '已找到材料，正在安排全篇段落');
      const preparation = await this.workflow.prepare(command, {
        scope,
        assertCurrent,
        assertActive,
      });
      assertActive();
      const lock: BiographyFloorLock = {
        preparation,
        triggerTextHash,
        triggerSwipeId,
      };
      await this.shell.arm(lock);
      if (epoch !== this.epoch) {
        await this.shell.clear(preparation.requestId);
        assertActive();
      }
      this.pending = lock;
      this.hooks.onStatus?.('awaiting_narrative', '正在将完整传记写入这一轮正文');
      return { preparation, triggerTextHash };
    } catch (error) {
      if (epoch !== this.epoch || isTaskCancellationError(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      this.hooks.onStatus?.('failed', detail);
      throw error;
    }
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.epoch) throw new GenerationCancelledError('biography');
  }

  private async assertPendingUserTurn(expected: BiographyWorkflowScope): Promise<void> {
    const current = await this.getScope();
    if (
      namespaceKey(expected.namespace) !== namespaceKey(current.namespace)
      || this.runtime.getLastMessageId() + 1 !== expected.triggerMessageId
    ) {
      throw new Error('Chat changed while biography preparation was running');
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
    this.stopSettlePoll();
    if (!this.pending) return;
    const lock = this.pending;
    this.pending = null;
    await this.shell.clear(lock.preparation.requestId);
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

function buildReusePreparation(
  record: BiographyRecord,
  scope: BiographyWorkflowScope,
): BiographyPreparation {
  // 复用已提交传记：recordKey/rootTrace/instruction 取自已有记录，
  // requestId 与 slot 占位符重新生成（旧的 slot 已被上一次 commit 替换掉）。
  const requestId = crypto.randomUUID();
  const slot = createSlot('rootTrace', requestId);
  return {
    requestId,
    biographyId: record.biographyId,
    recordKey: record.key,
    scope,
    sourceHash: record.sourceHash,
    slot,
    instruction: buildBiographyShellInstruction(record.biography, slot),
    rootTrace: record.biography.rootTrace,
  };
}
