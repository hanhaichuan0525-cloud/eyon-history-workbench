import {
  normalizeCommandInput,
  parseTextCommand,
} from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  pendingSettlementKey,
  type ButterflyRecord,
  type ButterflyRepository,
  type PendingSettlement,
} from '../storage/butterflies.ts';
import type { TavernRuntime } from './contracts.ts';
import { TavernButterflyContextAssembler, BUTTERFLY_FREEZE_SOURCE_LIMIT } from './butterflyContext.ts';
import { ButterflyWorkflow } from '../workflows/butterfly.ts';
import {
  noopButterflyNarrativeShell,
  type ButterflyNarrativeShell,
} from './tavernButterflyShell.ts';
import {
  GenerationCancelledError,
  isTaskCancellationError,
} from './tavernGeneration.ts';
import { isLatestVisibleTurnPair } from './visibleTurns.ts';
import { fingerprintText } from './transactionIdentity.ts';
import { canonicalTaskSourceId } from '../retrieval/citations.ts';

export const BUTTERFLY_SOURCE_IDENTITY_VERSION = 1;

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
  private readonly narrativeShell: ButterflyNarrativeShell;
  private readonly hooks: ButterflyControllerHooks;
  private readonly createRequestId: () => string;
  private readonly roll: () => number;
  private readonly now: () => number;
  private readonly preparations = new Map<string, Promise<ButterflyRecord>>();
  private readonly renderedCommits = new Set<number>();
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
    narrativeShell?: ButterflyNarrativeShell;
  }) {
    this.assembler = dependencies.assembler;
    this.workflow = dependencies.workflow;
    this.repository = dependencies.repository;
    this.runtime = dependencies.runtime;
    this.narrativeShell = dependencies.narrativeShell
      ?? noopButterflyNarrativeShell;
    this.createRequestId = dependencies.createRequestId;
    this.roll = dependencies.roll;
    this.now = dependencies.now;
    this.hooks = dependencies.hooks ?? {};
  }

  async prepareText(text: string): Promise<PendingSettlement | null> {
    // 隔离快照在请求起点取值：即使本请求的前置 await 比 cancel/进入新墟境慢，
    // 晚到后也不会以「新 epoch」身份重新武装旧遣返楼（internal.81 v14 竞态修复）。
    const startedEpoch = this.epoch;
    const command = parseTextCommand(text);
    if (!command || command.type !== 'ruin.return') return null;
    const user = this.latestVisibleUser();
    if (normalizeCommandInput(user.message) !== command.raw) {
      throw new Error('遣返命令与当前玩家楼不一致');
    }
    const namespace = currentNamespace(this.runtime);
    const [namespacePending, namespaceRecords] = await Promise.all([
      this.repository.listPending(namespace),
      this.repository.list(namespace),
    ]);
    const samePendingTrigger = (record: {
      request: PendingSettlement['request'];
    }) => (
      record.request.trigger.rawCommand.trim() === command.raw
    );
    const triggerPending = namespacePending.find(samePendingTrigger);
    if (triggerPending) {
      if (this.isLegacyFrozenPending(triggerPending)) {
        // internal.81 v16：体检发现旧内容上限（6000 字/条）时代的冻结快照——
        // 直接复用会让 v15 瘦身永不生效（每次重试仍以 72K 级 prompt 慢生成）。
        // 删除旧 pending 后继续走全新冻结，用新上限重建同轮快照。
        await this.repository.deletePending(triggerPending.key);
      } else {
        const rebound = rebindPendingTrigger(
          triggerPending,
          user.message_id,
          this.runtime.getMessageSwipeId(user.message_id),
          command.source,
          command.raw,
          this.now(),
        );
        if (rebound !== triggerPending) {
          await this.repository.updatePending(rebound);
        }
        return this.armPendingGuarded(rebound, undefined, startedEpoch);
      }
    }
    const triggerRecord = namespaceRecords.find(record =>
      record.request.trigger.userMessageId === user.message_id
      && record.request.trigger.rawCommand.trim() === command.raw
    );
    // internal.81 v21：已归档记录若带 reverted（该轮 Canon 已被删楼回滚），
    // 不再重建复用旧文本——fallthrough 走全新冻结与重新结算，让新版覆盖旧版。
    if (triggerRecord && triggerRecord.canonStatus !== 'reverted') {
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
        triggerSwipeId: this.runtime.getMessageSwipeId(user.message_id),
        assistantSwipeId: null,
        sourceHash: triggerRecord.sourceHash,
        sourceIdentityVersion: BUTTERFLY_SOURCE_IDENTITY_VERSION,
        citationSourceSetHash: butterflyCitationSourceSetHash(triggerRecord.request),
        canonBindingView: triggerRecord.canonBindings?.[0]
          ? {
            branchId: triggerRecord.canonBindings[0].branchId,
            ...triggerRecord.canonBindings[0].boundView,
          }
          : undefined,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.pruneStalePending(namespace, pending.key);
      await this.repository.savePending(pending);
      return this.armPendingGuarded(pending, triggerRecord, startedEpoch);
    }
    this.hooks.onStatus?.('freezing_butterfly', '正在收集这轮穿越留下的介入、见证与归返锚点');
    const frozen = await this.assembler.freeze({
      requestId: this.createRequestId(),
      namespace,
      userMessageId: user.message_id,
      rawCommand: command.raw,
      triggerType: command.source,
      roll: this.roll(),
      sourceMessageId: this.previousVisibleAssistant(user.message_id).message_id,
    });
    const key = pendingSettlementKey(namespace, frozen.request.runId);
    const existingPending = await this.repository.getPending(key);
    if (existingPending) {
      if (this.isLegacyFrozenPending(existingPending)) {
        // internal.81 v16：与 triggerPending 同因——旧上限快照直接丢弃，
        // 用刚完成的新冻结（当前 1500 上限）覆盖重建。
        await this.repository.deletePending(key);
      } else {
        const rebound = rebindPendingTrigger(
          existingPending,
          user.message_id,
          this.runtime.getMessageSwipeId(user.message_id),
          command.source,
          command.raw,
          this.now(),
        );
        if (rebound !== existingPending) {
          await this.repository.updatePending(rebound);
        }
        return this.armPendingGuarded(rebound, undefined, startedEpoch);
      }
    }
    const now = this.now();
    const pending: PendingSettlement = {
      key,
      namespace,
      runId: frozen.request.runId,
      request: frozen.request,
      activeEvidence: frozen.activeEvidence,
      canonBindingView: frozen.canonBindingView,
      canonBindingAppliedDeltaIds: frozen.canonBindingAppliedDeltaIds,
      linkingIndex: frozen.linkingIndex,
      triggerSwipeId: this.runtime.getMessageSwipeId(user.message_id),
      assistantSwipeId: null,
      sourceHash: frozen.sourceHash,
      sourceIdentityVersion: BUTTERFLY_SOURCE_IDENTITY_VERSION,
      citationSourceSetHash: butterflyCitationSourceSetHash(frozen.request),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.pruneStalePending(namespace, key);
    await this.repository.savePending(pending);
    return this.armPendingGuarded(pending, undefined, startedEpoch);
  }

  async prepareBeforeUserTurn(
    text: string,
    expectedUserMessageId: number,
    triggerType: 'button' | 'text' = 'button',
  ): Promise<PendingSettlement> {
    // 隔离快照同样在请求起点取值（internal.81 v14 竞态修复）。
    const startedEpoch = this.epoch;
    const command = parseTextCommand(text);
    if (!command || command.type !== 'ruin.return') {
      throw new Error('只能为明确的遣返命令预冻结历史锚点');
    }
    const namespace = currentNamespace(this.runtime);
    const source = this.latestVisibleAssistant();
    this.hooks.onStatus?.('freezing_butterfly', '正在收集这轮穿越留下的介入、见证与归返锚点');
    const frozen = await this.assembler.freeze({
      requestId: this.createRequestId(),
      namespace,
      userMessageId: expectedUserMessageId,
      rawCommand: command.raw,
      triggerType,
      roll: this.roll(),
      sourceMessageId: source.message_id,
    });
    const key = pendingSettlementKey(namespace, frozen.request.runId);
    const existing = await this.repository.getPending(key);
    if (existing) {
      if (this.isLegacyFrozenPending(existing)) {
        // internal.81 v16：旧内容上限时代的冻结快照——直接丢弃，
        // 用刚完成的新冻结（当前 1500 上限）覆盖重建，否则瘦身永不生效。
        await this.repository.deletePending(key);
      } else {
        const rebound = rebindPendingTrigger(
          existing,
          expectedUserMessageId,
          null,
          triggerType,
          command.raw,
          this.now(),
        );
        if (rebound !== existing) {
          await this.repository.updatePending(rebound);
        }
        return this.armPendingGuarded(rebound, undefined, startedEpoch);
      }
    }
    const now = this.now();
    const pending: PendingSettlement = {
      key,
      namespace,
      runId: frozen.request.runId,
      request: frozen.request,
      activeEvidence: frozen.activeEvidence,
      canonBindingView: frozen.canonBindingView,
      canonBindingAppliedDeltaIds: frozen.canonBindingAppliedDeltaIds,
      linkingIndex: frozen.linkingIndex,
      triggerSwipeId: null,
      assistantSwipeId: null,
      sourceHash: frozen.sourceHash,
      sourceIdentityVersion: BUTTERFLY_SOURCE_IDENTITY_VERSION,
      citationSourceSetHash: butterflyCitationSourceSetHash(frozen.request),
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.pruneStalePending(namespace, key);
    await this.repository.savePending(pending);
    // 与传记楼保持同一条链路：预发送阶段后台完成唯一一次蝴蝶效应
    // 准备并武装正文提示，成功后才创建遣返玩家楼并触发正文。
    // 玩家楼尚未创建时若被停止，pending 仍保留，下一次同一命令可重绑重试。
    await this.armPendingGuarded(pending, undefined, startedEpoch);
    return pending;
  }

  async confirmPreparedUserFloor(
    text: string,
    messageId: number,
  ): Promise<void> {
    const command = parseTextCommand(text);
    if (!command || command.type !== 'ruin.return') {
      throw new Error('只能确认明确的遣返命令');
    }
    const user = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (
      !user
      || user.role !== 'user'
      || user.is_hidden
      || normalizeCommandInput(user.message) !== command.raw
    ) {
      await this.narrativeShell.clearActive();
      throw new Error('预结算的蝴蝶效应不属于已建立的玩家楼');
    }
    const namespace = currentNamespace(this.runtime);
    const candidates = await this.repository.listPending(namespace);
    const pending = candidates.find(record =>
      record.request.trigger.userMessageId === messageId
      && normalizeCommandInput(record.request.trigger.rawCommand) === command.raw
    );
    if (!pending) {
      await this.narrativeShell.clearActive();
      throw new Error('没有找到该玩家楼的蝴蝶效应预结算');
    }
    const confirmed: PendingSettlement = {
      ...pending,
      triggerSwipeId: this.runtime.getMessageSwipeId(messageId),
      revision: pending.revision + 1,
      updatedAt: this.now(),
    };
    await this.repository.updatePending(confirmed);
  }

  async commitRendered(messageId: number): Promise<ButterflyRecord | null> {
    // 清理伪面板会触发一次受影响楼层重绘；同楼重入只负责显示刷新，不能
    // 并发启动第二次归档。外层互斥覆盖清理、结算与正式面板写回全过程。
    if (this.renderedCommits.has(messageId)) return null;
    this.renderedCommits.add(messageId);
    try {
      return await this.commitRenderedOnce(messageId);
    } finally {
      this.renderedCommits.delete(messageId);
    }
  }

  private async commitRenderedOnce(messageId: number): Promise<ButterflyRecord | null> {
    // 显示正则只认识 <butterfly_panel> 标签，无法判断标签来自脚本还是模型。
    // 因此在任何归档判断之前先做楼层授权：普通正文里由模型仿写的面板会
    // 被剥离；正式面板必须带脚本写入且属于当前 swipe 的请求元数据。
    await this.removeUnauthorizedButterflyPanels(messageId);
    const namespace = currentNamespace(this.runtime);
    const candidates = await this.repository.listPending(namespace);
    // internal.81 v18：候选必须与「渲染的 AI 楼」构成最新可见对之外，还要校验
    // 玩家楼实际文本与该 pending 的命令文本一致（防旧轮记录劫持当前轮提交——
    // 真机病历：5 条历史 pending 共享同一玩家楼 id，最旧的「遣返」记录 revision 连
    // 续被误伤 8 次，真正当前轮的 validated 记录永远轮不到）。同文本多条时取最新。
    const matching = candidates
      .filter(record =>
        isLatestVisibleTurnPair(
          this.runtime,
          record.request.trigger.userMessageId,
          messageId,
        )
      )
      .filter(record => {
        const user = this.runtime
          .getChatMessages(record.request.trigger.userMessageId, { include_swipes: false })
          .find(item => item.message_id === record.request.trigger.userMessageId);
        return !!user
          && user.role === 'user'
          && !user.is_hidden
          && normalizeCommandInput(user.message)
            === normalizeCommandInput(record.request.trigger.rawCommand);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const pending = matching[0] ?? null;
    if (!pending) return null;
    const epoch = this.epoch;
    try {
      try {
        await this.narrativeShell.assertRenderedFloor(pending, messageId);
      } finally {
        await this.narrativeShell.clear(pending.request.requestId);
      }
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
      this.hooks.onStatus?.('committing_butterfly', '正在把通过校验的变化写回现世与 Canon');
      const record = await this.workflow.settle(updated);
      if (epoch !== this.epoch) throw new Error('聊天切换后结算结果已被隔离');
      this.hooks.onStatus?.('butterfly_ready', '本轮历史余波已归档，现世记忆已更新');
      return record;
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
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
        '蝴蝶效应尚未归档（遣返正文已保留），原因：'
          + (error instanceof Error ? error.message : String(error)),
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
    // internal.81 v19：重试与正文渲染提交同款反馈——成功/失败都要点亮宿主
    // 任务通知，失败原因写回快照；此前重试是无声的（UI 既无成功也无失败提示）。
    try {
      const record = await this.workflow.settle(pending);
      this.hooks.onStatus?.('butterfly_ready', '本轮历史余波已归档，现世记忆已更新');
      return record;
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
      const current = await this.repository.getPending(pending.key).catch(() => null);
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
        }).catch(() => undefined);
      }
      this.hooks.onStatus?.(
        'butterfly_pending',
        '蝴蝶效应尚未归档（遣返正文已保留），原因：'
          + (error instanceof Error ? error.message : String(error)),
      );
      throw error;
    }
  }

  cancelPending(): void {
    this.epoch += 1;
    // 取消后允许同一玩家楼立即重试。旧 Promise 的 finally 必须以身份
    // 核对方式收尾，不能误删随后建立的新任务。
    this.preparations.clear();
    // 取消可能发生在“结果已准备、玩家楼尚未创建”的窄窗口；
    // 该窗口没有 commitRendered 可以负责清理注入，因此这里主动收尾。
    void this.narrativeShell.clearActive().catch(error => {
      console.warn('[Eyon History Workbench] butterfly injection cleanup after cancel failed', error);
    });
  }

  async onChatChanged(): Promise<void> {
    this.cancelPending();
    await this.narrativeShell.clearActive();
  }

  /**
   * 新墟境开始时隔离上一轮仍在飞行的蝴蝶任务。
   * 旧请求即使因宿主忽略 abort 而晚返回，也不得重新武装旧遣返楼。
   * 待结算快照本身保留，供用户仍停留在原轮次时重试；这里只清理运行态。
   */
  async onRuinEntered(): Promise<void> {
    this.cancelPending();
    await this.narrativeShell.clearActive();
  }

  async releaseStaleNarrative(latestUserMessageId: number): Promise<void> {
    const namespace = currentNamespace(this.runtime);
    const candidates = await this.repository.listPending(namespace);
    if (candidates.some(record =>
      record.request.trigger.userMessageId === latestUserMessageId
    )) return;
    await this.narrativeShell.clearActive();
  }

  private async armPending(
    pending: PendingSettlement,
    preparedRecord?: ButterflyRecord,
    startedEpoch?: number,
  ): Promise<PendingSettlement> {
    // 入口即查（internal.81 v14）：用请求起点的隔离快照核对——晚到的旧请求
    // 在重新 prepare 与 arm 之前就被拦下，不会绕成新 epoch 武装旧遣返楼。
    const epoch = startedEpoch ?? this.epoch;
    if (epoch !== this.epoch) {
      throw new GenerationCancelledError('butterfly');
    }
    const currentSwipeId = this.runtime.getMessageSwipeId(
      pending.request.trigger.userMessageId,
    );
    let armed = pending;
    if (pending.triggerSwipeId !== currentSwipeId) {
      armed = {
        ...pending,
        triggerSwipeId: currentSwipeId,
        revision: pending.revision + 1,
        updatedAt: this.now(),
      };
      await this.repository.updatePending(armed);
    }
    // 重掷/重生成命中同一玩家楼的既有记录时，直接复用已冻结结果。
    // 不再调用 prepare，也不重新读取已经离开的历史现场。
    const record = preparedRecord ?? await this.prepareRecord(armed);
    if (epoch !== this.epoch) {
      throw new GenerationCancelledError('butterfly');
    }
    await this.narrativeShell.arm(armed, record.result);
    return armed;
  }

  private prepareRecord(pending: PendingSettlement): Promise<ButterflyRecord> {
    const existing = this.preparations.get(pending.key);
    if (existing) return existing;
    this.hooks.onStatus?.('generating_butterfly', '正在判断余波会落向谁、由谁承担代价');
    const task = this.workflow.prepare(pending)
      .finally(() => {
        if (this.preparations.get(pending.key) === task) {
          this.preparations.delete(pending.key);
        }
      });
    this.preparations.set(pending.key, task);
    return task;
  }

  /**
   * internal.81 v16 体检：冻结快照是否来自旧内容上限时代（v15 之前 6000 字/条）。
   * 旧快照若被直接复用，v15 瘦身永不生效——每次重试仍以 72K 级 prompt 慢生成。
   */
  private isLegacyFrozenPending(pending: PendingSettlement): boolean {
    // 当前版冻结已经消费了 Canon 视图却没有保留 ArtifactCanonBinding 所需的视图身份，
    // 说明这是旧版/不完整 pending。继续复用只会稳定地产生 binding-missing；丢弃后
    // 重新冻结即可恢复，且不会把此诊断升级为正文中断。
    if (pending.activeEvidence?.canonResolvedView && !pending.canonBindingView) return true;
    const citationRegistry = pending.activeEvidence?.citationRegistry;
    if (citationRegistry) {
      if (pending.sourceIdentityVersion !== BUTTERFLY_SOURCE_IDENTITY_VERSION) return true;
      if (pending.citationSourceSetHash !== butterflyCitationSourceSetHash(pending.request)) {
        return true;
      }
      const registrySources = citationRegistry.sources.map(entry =>
        canonicalTaskSourceId(entry.sourceId)
      );
      if (new Set(registrySources).size !== registrySources.length) return true;
      const requestSources = canonicalButterflySourceIds(pending.request);
      if (
        registrySources.length !== requestSources.length
        || registrySources.some(sourceId => !requestSources.includes(sourceId))
      ) return true;
    }
    const request = pending.request;
    return [
      ...request.playerInterventions,
      ...request.currentRealityContext,
      ...request.relevantWorldbook,
      ...request.relevantChatFacts,
      ...request.relevantGenealogy,
      ...request.relevantBiographies,
      ...request.previousButterflyAnchors,
      ...request.sourceIndex,
    ].some(source =>
      (source?.content ?? '').trim().length > BUTTERFLY_FREEZE_SOURCE_LIMIT
    );
  }

  /**
   * internal.81 v18：真正开始新一轮冻结时，清掉同聊天里其他轮次的残留待结算
   * （真机病历：6000 字/175KB 时代的失败 pending 跨轮存活并劫持提交候选）。
   * 只清理不同 runId 的 key；当前轮 key 原样保留（供同轮重试）。
   */
  private async pruneStalePending(
    namespace: { characterKey: string; chatId: string },
    keepKey: string,
  ): Promise<void> {
    const stale = await this.repository.listPending(namespace);
    await Promise.all(stale
      .filter(record => record.key !== keepKey)
      .map(record =>
        this.repository.deletePending(record.key).catch(() => undefined)
      ));
  }

  /**
   * internal.81 v16：武装失败（生成被拒/校验失败等）时把原因写进待结算快照并点亮
   * 可重试状态——此前 prepare 失败是无声的：玩家只看到「转圈后没反应」，UI 也没有
   * 可重试入口与失败原因。取消类错误保持原样上抛，不污染状态。
   */
  private async armPendingGuarded(
    pending: PendingSettlement,
    preparedRecord?: ButterflyRecord,
    startedEpoch?: number,
  ): Promise<PendingSettlement> {
    try {
      return await this.armPending(pending, preparedRecord, startedEpoch);
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
      const current = await this.repository.getPending(pending.key).catch(() => null);
      if (current) {
        const message = error instanceof Error ? error.message : String(error);
        await this.repository.updatePending({
          ...current,
          failure: {
            code: error instanceof Error && 'code' in error
              && typeof error.code === 'string'
              ? error.code
              : 'BUTTERFLY_PREPARE_FAILED',
            message,
          },
          revision: current.revision + 1,
          updatedAt: this.now(),
        }).catch(() => undefined);
        this.hooks.onStatus?.(
          'butterfly_pending',
          `蝴蝶效应尚未归档：${message.slice(0, 120)}`,
        );
      }
      throw error;
    }
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

  private latestVisibleAssistant() {
    return this.previousVisibleAssistant(this.runtime.getLastMessageId() + 1);
  }

  private previousVisibleAssistant(beforeMessageId: number) {
    const messages = this.runtime.getChatMessages(
      `0-${Math.max(0, beforeMessageId - 1)}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message.message_id < beforeMessageId
        && message.role === 'assistant'
        && !message.is_hidden
      ) return message;
    }
    throw new Error('遣返命令之前没有可用于冻结的 AI 楼');
  }

  private async removeUnauthorizedButterflyPanels(messageId: number): Promise<void> {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.role !== 'assistant' || message.is_hidden) return;
    const panels = [...message.message.matchAll(BUTTERFLY_PANEL_RE)];
    if (panels.length === 0) return;

    const currentSwipeId = this.runtime.getMessageSwipeId(messageId);
    const metadata = butterflyPanelMetadata(message.extra);
    const requestId = typeof metadata.requestId === 'string'
      ? metadata.requestId.trim()
      : '';
    const metadataSwipeId = metadata.swipeId;
    const panelHash = typeof metadata.panelHash === 'string'
      ? metadata.panelHash.trim()
      : '';
    const authorized = panels.length === 1
      && requestId.length > 0
      && (typeof metadataSwipeId === 'number' || metadataSwipeId === null)
      && metadataSwipeId === currentSwipeId
      // 兼容 internal.81 起已经归档但尚未记录哈希的旧正式面板；新版面板
      // 一旦带哈希，就必须与脚本当时写入的原文完全一致。
      && (!panelHash || panelHash === fingerprintText(panels[0][0]));
    if (authorized) return;

    const nextMessage = message.message
      .replace(BUTTERFLY_PANEL_RE, '')
      .replace(/\n{3,}/gu, '\n\n')
      .trimEnd();
    const { eyonButterflyRequest: _discarded, ...nextExtra } = message.extra ?? {};
    await this.runtime.setChatMessages([{
      message_id: messageId,
      message: nextMessage,
      extra: nextExtra,
    }], { refresh: 'affected' });
    console.warn(
      '[Eyon History Workbench] removed an unauthorized model-authored butterfly panel',
      { messageId, panelCount: panels.length },
    );
  }
}

const BUTTERFLY_PANEL_RE = /<butterfly_panel>[\s\S]*?<\/butterfly_panel>/gu;

function butterflyPanelMetadata(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const value = extra?.eyonButterflyRequest;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalButterflySourceIds(request: PendingSettlement['request']): string[] {
  return [...new Set(
    request.sourceIndex.map(source => canonicalTaskSourceId(source.sourceId)),
  )].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function butterflyCitationSourceSetHash(request: PendingSettlement['request']): string {
  return fingerprintText(JSON.stringify(canonicalButterflySourceIds(request)));
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) throw new Error('当前没有可用的角色聊天');
  return { characterKey, chatId };
}

function rebindPendingTrigger(
  pending: PendingSettlement,
  userMessageId: number,
  triggerSwipeId: number | null,
  triggerType: 'button' | 'text',
  rawCommand: string,
  now: number,
): PendingSettlement {
  const trigger = pending.request.trigger;
  if (
    trigger.userMessageId === userMessageId
    && trigger.returnAssistantMessageId === 0
    && trigger.type === triggerType
    && trigger.rawCommand === rawCommand
    && pending.triggerSwipeId === triggerSwipeId
  ) return pending;
  return {
    ...pending,
    request: {
      ...pending.request,
      trigger: {
        ...trigger,
        userMessageId,
        returnAssistantMessageId: 0,
        type: triggerType,
        rawCommand,
      },
    },
    triggerSwipeId,
    assistantSwipeId: null,
    revision: pending.revision + 1,
    updatedAt: now,
  };
}
