import type {
  GenerationAdapter,
  HostAdapter,
  RuinTaskSnapshot,
  UserTurnAdapter,
} from '../adapters/host.ts';
import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import { GenerationCancelledError, isTaskCancellationError } from '../runtime/tavernGeneration.ts';
import { buildRuinTaskPrompt } from '../prompts/ruinTask.ts';
import { resolveRuinTaskEconomy } from '../core/ruinTaskEconomy.ts';
import {
  materializeRuinTask,
  parseRuinTaskDraft,
  type RuinTaskInterpretation,
  type RuinTaskRecord,
  type RuinTaskScale,
} from '../schemas/ruinTask.ts';
import {
  loadRuntimeWorldbookCorpus,
  type TavernRuntime,
  type RuntimeChatMessage,
  type RuntimeContextSourceProvider,
} from '../runtime/contracts.ts';
import {
  TavernRuinTaskShellAdapter,
  type RuinTaskFloorLock,
} from '../runtime/tavernRuinTaskShell.ts';
import { fingerprintText } from '../runtime/transactionIdentity.ts';

const ENTRY_METADATA_KEY = 'eyonHistoryRuinEntryRequest';

export interface RuinTaskDraftRequest {
  direction: string;
  interpretation: RuinTaskInterpretation;
  scale: RuinTaskScale;
}

export interface RuinTaskEditPatch {
  title?: string;
  detail?: string;
  objective?: string;
}

export interface RuinTaskReviewSnapshot {
  phase: 'review' | 'staged' | 'approved' | 'rendered';
  runId: string;
  direction: string;
  interpretation: RuinTaskInterpretation;
  scale: RuinTaskScale;
  task: {
    title: string;
    mode: '个人' | '团队';
    difficulty: RuinTaskRecord['difficulty'];
    status: string;
    attention: '高' | '中' | '低';
    progress: string;
    detail: string;
    objective: string;
    reward: string;
  };
  approvedTaskHash?: string;
  triggerMessageId?: number;
}

interface RuinTaskReviewState extends RuinTaskReviewSnapshot {
  namespace: WorkbenchNamespace;
  record: RuinTaskRecord;
}

export interface RuinTaskSubmission {
  requestId: string;
  runId: string;
  messageId: number;
  direction: string;
  task: RuinTaskRecord;
  approvedTaskHash: string;
}

export interface RuinTaskHooks {
  onStatus?(status: string, detail: string, extra?: Record<string, unknown>): void;
}

interface RuinTaskTerminalWatch {
  namespace: WorkbenchNamespace;
  runId: string;
  triggerMessageId: number;
  tasks: RuinTaskSnapshot[];
}

export class RuinTaskWorkflow {
  private sending: AbortController | null = null;
  private epoch = 0;
  private readonly dependencies: {
    host: HostAdapter;
    generator: GenerationAdapter;
    userTurns: UserTurnAdapter;
    runtime: TavernRuntime;
    sources: RuntimeContextSourceProvider;
    shell: TavernRuinTaskShellAdapter;
    hooks?: RuinTaskHooks;
  };
  private review: RuinTaskReviewState | null = null;
  private pendingLock: RuinTaskFloorLock | null = null;
  private approvedLock: RuinTaskFloorLock | null = null;
  private inFlight: Promise<RuinTaskReviewSnapshot> | null = null;
  private confirming: Promise<RuinTaskSubmission> | null = null;
  private settlePoll: ReturnType<typeof setInterval> | null = null;
  private terminalPoll: ReturnType<typeof setTimeout> | null = null;
  private terminalWatch: RuinTaskTerminalWatch | null = null;

  constructor(dependencies: {
    host: HostAdapter;
    generator: GenerationAdapter;
    userTurns: UserTurnAdapter;
    runtime: TavernRuntime;
    sources: RuntimeContextSourceProvider;
    shell: TavernRuinTaskShellAdapter;
    hooks?: RuinTaskHooks;
  }) {
    this.dependencies = dependencies;
  }

  generateDraft(request: RuinTaskDraftRequest): Promise<RuinTaskReviewSnapshot> {
    if (this.inFlight) return this.inFlight;
    const epoch = this.epoch;
    const task = this.runDraft(request, epoch).catch(error => {
      if (epoch === this.epoch && !isTaskCancellationError(error)) {
        this.dependencies.hooks?.onStatus?.('failed', error instanceof Error ? error.message : String(error), { phase: 'error' });
      }
      throw error;
    }).finally(() => {
      if (this.inFlight === task) this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  async readReview(): Promise<RuinTaskReviewSnapshot | null> {
    const epoch = this.epoch;
    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    if (epoch !== this.epoch) return null;
    if (!this.review) {
      const messages = this.dependencies.runtime.getChatMessages(
        `0-${Math.max(0, this.dependencies.runtime.getLastMessageId())}`,
        { include_swipes: false },
      );
      for (const message of [...messages].reverse()) {
        if (message.role !== 'user' || message.is_hidden) continue;
        const lock = this.dependencies.shell.readTriggerLock(message.message_id);
        if (!lock || lock.runId !== snapshot.runId) continue;
        if (namespaceKey(lock.namespace) !== namespaceKey(namespace)) continue;
        this.approvedLock = lock;
        this.review = reviewFromLock(lock, null);
        break;
      }
    }
    if (!this.review) return null;
    if (
      namespaceKey(namespace) !== namespaceKey(this.review.namespace)
      || snapshot.runId !== this.review.runId
      || snapshot.flowState === 'idle'
    ) {
      this.review = null;
      this.approvedLock = null;
      return null;
    }
    const committed = (snapshot.ruinTasks ?? []).find(task =>
      task.name === this.review?.record.name);
    if (this.review.phase === 'rendered' && committed?.terminal) {
      this.review = null;
      this.approvedLock = null;
      return null;
    }
    return publicReview(this.review);
  }

  updateDraft(patch: RuinTaskEditPatch): RuinTaskReviewSnapshot {
    const review = this.requireEditableReview();
    const title = patch.title === undefined
      ? review.record.title
      : normalizeEditable(patch.title, '任务名称', 2, 28);
    const detail = patch.detail === undefined
      ? plainDetail(review.record)
      : normalizeEditable(patch.detail, '任务详情', 2, 360);
    const objective = patch.objective === undefined
      ? review.record.value.目标
      : normalizeEditable(patch.objective, '任务目标', 2, 280);
    review.record = {
      ...review.record,
      title,
      name: `[墟境任务·${review.record.mode}]${title}`,
      value: {
        ...review.record.value,
        详情: `${review.record.difficulty}级。${detail}`,
        目标: objective,
      },
    };
    review.task = reviewTask(review.record);
    return publicReview(review);
  }

  stageDraftForComposer(): RuinTaskReviewSnapshot {
    const review = this.requireEditableReview();
    review.phase = 'staged';
    this.dependencies.hooks?.onStatus?.(
      'ruin_task_awaiting_player',
      '确认语句已写入输入框；补充你的行动后亲自发送',
      { phase: 'info' },
    );
    return publicReview(review);
  }

  restoreStagedDraft(): RuinTaskReviewSnapshot | null {
    if (!this.review || this.review.phase !== 'staged') return this.review
      ? publicReview(this.review)
      : null;
    this.review.phase = 'review';
    return publicReview(this.review);
  }

  shouldInterceptComposer(text: string): boolean {
    if (!this.review || this.review.phase !== 'staged') return false;
    return includesConfirmationMarker(text, this.review.record.title);
  }

  confirmStagedDraft(text: string, signal?: AbortSignal): Promise<RuinTaskSubmission> {
    if (this.confirming) return this.confirming;
    const playerText = text.trim();
    const review = this.requireStagedReview();
    if (!includesConfirmationMarker(playerText, review.record.title)) {
      throw new Error(`输入框必须保留“${confirmationMarker(review.record.title)}”才能确认任务`);
    }
    const task = this.runConfirm(playerText, signal).finally(() => {
      if (this.confirming === task) this.confirming = null;
    });
    this.confirming = task;
    return task;
  }

  /**
   * 原生发送链路：玩家楼已由酒馆创建，此处只给该楼封缄已审批的
   * 任务。不再拦截 DOM、不再代替酒馆建楼，因而点击发送、回车和其他宿主
   * 发送入口都会自然续接同一次正文生成。
   */
  async preparePlayerFloor(playerText: string, messageId: number): Promise<boolean> {
    const epoch = this.epoch;
    const existing = this.dependencies.shell.readTriggerLock(messageId);
    if (existing) {
      this.pendingLock = existing;
      this.approvedLock = existing;
      return true;
    }
    if (!this.shouldInterceptComposer(playerText)) return false;

    const review = this.requireStagedReview();
    const trigger = this.dependencies.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (
      !trigger
      || trigger.role !== 'user'
      || trigger.is_hidden
      || trigger.message.trim() !== playerText.trim()
    ) {
      throw new Error('墟境任务确认楼不可用，已拒绝注入');
    }

    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    this.assertActive(epoch);
    assertSameRuin(review.namespace, review.runId, namespace, snapshot, '确认任务前');
    assertNoActiveTask(snapshot);
    const requestId = crypto.randomUUID();
    const approvedTaskHash = fingerprintText(JSON.stringify({
      chatId: namespace.chatId,
      runId: review.runId,
      direction: review.direction,
      task: review.record,
    }));
    const lock: RuinTaskFloorLock = {
      requestId,
      runId: review.runId,
      direction: review.direction,
      task: structuredClone(review.record),
      contractText: buildRuinTaskContract(
        review.record,
        review.direction,
        review.runId,
        requestId,
        approvedTaskHash,
      ),
      approvedTaskHash,
      triggerMessageId: messageId,
      triggerTextHash: fingerprintText(trigger.message),
      triggerSwipeId: this.dependencies.runtime.getMessageSwipeId(messageId),
      namespace,
      injection: 'fallback',
    };
    this.pendingLock = lock;
    this.approvedLock = lock;
    try {
      await this.dependencies.shell.arm(lock);
      this.assertActive(epoch);
      await this.dependencies.shell.attachTriggerMetadata(lock);
      this.assertActive(epoch);
      review.phase = 'approved';
      review.approvedTaskHash = approvedTaskHash;
      review.triggerMessageId = messageId;
      this.dependencies.hooks?.onStatus?.(
        'writing_ruin_task',
        '任务已经封缄；后续重抽将始终复用这份文本',
        { phase: 'running' },
      );
      return true;
    } catch (error) {
      await this.dependencies.shell.clear(lock).catch(() => undefined);
      if (this.pendingLock === lock) this.pendingLock = null;
      if (this.approvedLock === lock) this.approvedLock = null;
      if (epoch === this.epoch) {
        review.phase = 'staged';
        delete review.approvedTaskHash;
        delete review.triggerMessageId;
      }
      throw error;
    }
  }

  async prepareGeneration(triggerMessageId: number): Promise<boolean> {
    const epoch = this.epoch;
    this.stopTerminalPoll();
    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    this.assertActive(epoch);
    const activeTasks = (snapshot.ruinTasks ?? []).filter(task => !task.terminal);
    this.terminalWatch = activeTasks.length > 0 ? {
      namespace,
      runId: snapshot.runId,
      triggerMessageId,
      tasks: structuredClone(activeTasks),
    } : null;
    const lock = this.dependencies.shell.readTriggerLock(triggerMessageId);
    if (!lock) return false;
    if (namespaceKey(namespace) !== namespaceKey(lock.namespace) || snapshot.runId !== lock.runId) {
      throw new Error('墟境任务封缄属于旧聊天或旧墟境，已拒绝注入');
    }
    this.approvedLock = lock;
    this.pendingLock = lock;
    this.review = reviewFromLock(lock, this.review);
    await this.dependencies.shell.arm(lock);
    if (epoch !== this.epoch) await this.dependencies.shell.clear(lock);
    this.assertActive(epoch);
    return true;
  }

  async commitRendered(assistantMessageId: number): Promise<RuinTaskSubmission | null> {
    const epoch = this.epoch;
    const lock = this.pendingLock;
    if (!this.dependencies.shell.readAssistantMessage(assistantMessageId).trim()) return null;
    if (this.dependencies.runtime.isGenerating?.() === true) {
      if (lock) this.ensureSettlePoll(lock, assistantMessageId);
      return null;
    }
    let submission: RuinTaskSubmission | null = null;
    if (lock) {
      try {
        await this.dependencies.shell.assertRenderedFloor(lock, assistantMessageId);
        this.assertActive(epoch);
      } catch (error) {
        if (isTaskCancellationError(error)) throw error;
        console.warn('[Eyon History Workbench] ruin task rendered floor rejected; keeping transaction', error);
        return null;
      }
      submission = await this.commitLock(lock, assistantMessageId);
      this.assertActive(epoch);
    }
    await this.commitTerminalTransition(assistantMessageId);
    return submission;
  }

  async onMessageDeleted(messageId: number): Promise<void> {
    const lock = this.approvedLock ?? this.pendingLock;
    if (!lock || lock.triggerMessageId !== messageId) return;
    const epoch = this.epoch;
    this.stopSettlePoll();
    await this.dependencies.shell.clear(lock).catch(() => undefined);
    this.assertActive(epoch);
    this.pendingLock = null;
    this.approvedLock = null;
    if (this.review?.runId === lock.runId) {
      this.review.phase = 'review';
      delete this.review.approvedTaskHash;
      delete this.review.triggerMessageId;
    }
    this.dependencies.hooks?.onStatus?.(
      'ruin_task_draft_restored',
      '确认楼已删除，任务已解封并恢复为可编辑草案',
      { phase: 'info' },
    );
  }

  async cancelPending(): Promise<void> {
    this.epoch += 1;
    this.inFlight = null;
    this.confirming = null;
    this.sending?.abort(new GenerationCancelledError('ruin'));
    this.sending = null;
    this.stopSettlePoll();
    this.stopTerminalPoll();
    const lock = this.pendingLock;
    this.pendingLock = null;
    this.terminalWatch = null;
    if (lock) await this.dependencies.shell.clear(lock).catch(() => undefined);
    if (this.review?.phase === 'staged') this.review.phase = 'review';
  }

  private async runDraft(requestValue: RuinTaskDraftRequest, epoch: number): Promise<RuinTaskReviewSnapshot> {
    const assertActive = () => {
      if (epoch !== this.epoch) throw new GenerationCancelledError('ruin');
    };
    const request = normalizeDraftRequest(requestValue);
    const startedAt = Date.now();
    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    assertActive();
    assertCanCreateTask(snapshot, request.direction);
    const runId = snapshot.runId;
    const context = readNarrativeContext(this.dependencies.runtime);
    this.dependencies.hooks?.onStatus?.(
      'generating_ruin_task_draft',
      '伊雍正在按你选择的权限与规模拟定任务草案',
      { phase: 'running', progress: { current: 1, total: 1, startedAt } },
    );
    const raw = await this.dependencies.generator.generate(
      'ruin',
      buildRuinTaskPrompt({
        ...request,
        runId,
        ruinTime: snapshot.ruinTime,
        ruinLocation: snapshot.ruinLocation,
        entryHistory: context.entryHistory,
        recentNarrative: context.recentNarrative,
      }),
      { purpose: 'ruin-task', progressLabel: '正在拟定墟境任务草案' },
    );
    assertActive();
    const draft = parseRuinTaskDraft(raw);
    const worldbookCorpus = await loadRuntimeWorldbookCorpus(this.dependencies.sources);
    assertActive();
    const economy = resolveRuinTaskEconomy({
      sources: worldbookCorpus.sources,
      location: snapshot.ruinLocation,
      mode: draft.task.mode,
      difficulty: draft.task.difficulty,
      scale: request.scale,
    });
    const record = materializeRuinTask(draft, economy.reward);
    const [namespaceAfter, snapshotAfter] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    assertActive();
    assertSameRuin(namespace, runId, namespaceAfter, snapshotAfter, '生成任务草案期间');
    assertNoActiveTask(snapshotAfter);
    this.review = {
      phase: 'review',
      runId,
      direction: request.direction,
      interpretation: request.interpretation,
      scale: request.scale,
      task: reviewTask(record),
      namespace,
      record,
    };
    this.approvedLock = null;
    this.dependencies.hooks?.onStatus?.(
      'ruin_task_draft_ready',
      '任务草案已经完成，请检查并修订后再确认',
      { phase: 'success' },
    );
    return publicReview(this.review);
  }

  private async runConfirm(playerText: string, signal?: AbortSignal): Promise<RuinTaskSubmission> {
    const epoch = this.epoch;
    const assertActive = () => this.assertActive(epoch);
    const review = this.requireStagedReview();
    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    assertActive();
    assertSameRuin(review.namespace, review.runId, namespace, snapshot, '确认任务前');
    assertNoActiveTask(snapshot);
    const requestId = crypto.randomUUID();
    const approvedTaskHash = fingerprintText(JSON.stringify({
      chatId: namespace.chatId,
      runId: review.runId,
      direction: review.direction,
      task: review.record,
    }));
    const contractText = buildRuinTaskContract(
      review.record,
      review.direction,
      review.runId,
      requestId,
      approvedTaskHash,
    );
    let armedLock: RuinTaskFloorLock | null = null;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    this.sending = controller;
    try {
      const { messageId } = await this.dependencies.userTurns.sendUserTurn(playerText, {
        signal: controller.signal,
        beforeCreate: async expectedMessageId => {
          const [namespaceNow, snapshotNow] = await Promise.all([
            this.dependencies.host.getNamespace(),
            this.dependencies.host.getRuinRuntimeSnapshot(),
          ]);
          assertActive();
          assertSameRuin(review.namespace, review.runId, namespaceNow, snapshotNow, '任务注入前');
          assertNoActiveTask(snapshotNow);
          const lock: RuinTaskFloorLock = {
            requestId,
            runId: review.runId,
            direction: review.direction,
            task: structuredClone(review.record),
            contractText,
            approvedTaskHash,
            triggerMessageId: expectedMessageId,
            triggerTextHash: fingerprintText(playerText),
            triggerSwipeId: null,
            namespace,
            injection: 'fallback',
          };
          armedLock = lock;
          this.pendingLock = lock;
          this.approvedLock = lock;
          await this.dependencies.shell.arm(lock);
          assertActive();
        },
        afterCreate: async messageId => {
          assertActive();
          if (!armedLock) throw new Error('墟境任务封缄尚未建立');
          armedLock.triggerSwipeId = this.dependencies.runtime.getMessageSwipeId(messageId);
          await this.dependencies.shell.attachTriggerMetadata(armedLock);
          assertActive();
          review.phase = 'approved';
          review.approvedTaskHash = approvedTaskHash;
          review.triggerMessageId = messageId;
        },
      });
      assertActive();
      if (!armedLock) throw new Error('墟境任务确认楼创建失败');
      this.dependencies.hooks?.onStatus?.(
        'writing_ruin_task',
        '任务已经封缄；后续重抽将始终复用这份文本',
        { phase: 'running' },
      );
      return {
        requestId,
        runId: review.runId,
        messageId,
        direction: review.direction,
        task: review.record,
        approvedTaskHash,
      };
    } catch (error) {
      if (armedLock) await this.dependencies.shell.clear(armedLock).catch(() => undefined);
      if (this.pendingLock === armedLock) this.pendingLock = null;
      if (this.approvedLock === armedLock) this.approvedLock = null;
      if (epoch === this.epoch && !isTaskCancellationError(error)) {
        review.phase = 'staged';
        delete review.approvedTaskHash;
        delete review.triggerMessageId;
        this.dependencies.hooks?.onStatus?.(
          'failed', error instanceof Error ? error.message : String(error), { phase: 'error' },
        );
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (this.sending === controller) this.sending = null;
    }
  }

  private requireEditableReview(): RuinTaskReviewState {
    if (!this.review) throw new Error('请先拟定一份墟境任务草案');
    if (this.review.phase !== 'review') {
      throw new Error('任务已经封缄；若要修改，请先删除对应的确认玩家楼');
    }
    return this.review;
  }

  private requireStagedReview(): RuinTaskReviewState {
    if (!this.review) throw new Error('请先拟定一份墟境任务草案');
    if (this.review.phase !== 'staged') {
      throw new Error('请先在工作台确认草案，并由你亲自发送输入框中的确认语句');
    }
    return this.review;
  }

  private async commitTerminalTransition(assistantMessageId: number): Promise<void> {
    const epoch = this.epoch;
    const watch = this.terminalWatch;
    this.terminalWatch = null;
    if (!watch) return;
    if (await this.tryCommitTerminalTransition(watch, assistantMessageId, epoch) || epoch !== this.epoch) return;
    let checks = 0;
    const poll = (): void => {
      if (epoch !== this.epoch) return;
      checks += 1;
      this.terminalPoll = globalThis.setTimeout(() => {
        void this.tryCommitTerminalTransition(watch, assistantMessageId, epoch).then(committed => {
          if (epoch !== this.epoch) return;
          if (committed || checks >= 10) return this.stopTerminalPoll();
          poll();
        }).catch(error => {
          this.stopTerminalPoll();
          console.error('[Eyon History Workbench] ruin task terminal panel commit failed', error);
        });
      }, 150);
    };
    poll();
  }

  private async tryCommitTerminalTransition(
    watch: RuinTaskTerminalWatch,
    assistantMessageId: number,
    epoch: number,
  ): Promise<boolean> {
    const [namespace, snapshot] = await Promise.all([
      this.dependencies.host.getNamespace(),
      this.dependencies.host.getRuinRuntimeSnapshot(),
    ]);
    if (epoch !== this.epoch) return false;
    if (namespaceKey(namespace) !== namespaceKey(watch.namespace)) return false;
    const terminal = watch.tasks.map(before =>
      (snapshot.ruinTasks ?? []).find(after => after.name === before.name && after.terminal)
    ).find((task): task is RuinTaskSnapshot => Boolean(task));
    if (!terminal) return false;
    await this.dependencies.shell.appendTerminalPanel({
      namespace: watch.namespace,
      runId: watch.runId,
      triggerMessageId: watch.triggerMessageId,
      task: terminal,
    }, assistantMessageId, buildRuinTaskTerminalPanel(terminal));
    if (epoch !== this.epoch) return false;
    this.dependencies.hooks?.onStatus?.(
      'ruin_task_terminal',
      `墟境任务“${stripTaskPrefix(terminal.name)}”已${terminal.status || '结束'}`,
      { phase: 'success' },
    );
    return true;
  }

  private async commitLock(lock: RuinTaskFloorLock, assistantMessageId: number): Promise<RuinTaskSubmission | null> {
    this.stopSettlePoll();
    if (this.pendingLock !== lock) return null;
    const epoch = this.epoch;
    this.pendingLock = null;
    try {
      await this.dependencies.host.replaceAssistantSlot(
        assistantMessageId,
        ruinTaskSlot(lock.requestId),
        buildRuinTaskPanel(lock.task),
      );
      this.assertActive(epoch);
    } catch (error) {
      if (epoch === this.epoch) this.pendingLock = lock;
      throw error;
    }
    await this.dependencies.shell.clear(lock);
    this.assertActive(epoch);
    await this.dependencies.shell.attachMetadata(lock, assistantMessageId);
    this.assertActive(epoch);
    if (this.review?.approvedTaskHash === lock.approvedTaskHash) this.review.phase = 'rendered';
    this.dependencies.hooks?.onStatus?.('ready', '墟境任务已经写入正文与任务栏', { phase: 'success' });
    return {
      requestId: lock.requestId,
      runId: lock.runId,
      messageId: lock.triggerMessageId,
      direction: lock.direction,
      task: lock.task,
      approvedTaskHash: lock.approvedTaskHash,
    };
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.epoch) throw new GenerationCancelledError('ruin');
  }

  private ensureSettlePoll(lock: RuinTaskFloorLock, messageId: number): void {
    if (this.settlePoll) return;
    let checks = 0;
    this.settlePoll = setInterval(() => {
      checks += 1;
      if (this.pendingLock !== lock) return this.stopSettlePoll();
      if (this.dependencies.runtime.isGenerating?.() !== true) {
        this.stopSettlePoll();
        void this.commitLock(lock, messageId).catch(error => {
          console.error('[Eyon History Workbench] ruin task settle commit failed', error);
        });
      } else if (checks >= 120) this.stopSettlePoll();
    }, 500);
  }

  private stopSettlePoll(): void {
    if (!this.settlePoll) return;
    clearInterval(this.settlePoll);
    this.settlePoll = null;
  }

  private stopTerminalPoll(): void {
    if (!this.terminalPoll) return;
    clearTimeout(this.terminalPoll);
    this.terminalPoll = null;
  }
}

export function buildRuinTaskPanel(task: RuinTaskRecord): string {
  const title = escapePanelHtml(task.title);
  const difficulty = escapePanelHtml(task.difficulty);
  const detail = escapePanelHtml(plainDetail(task));
  const objective = escapePanelHtml(task.value.目标);
  const reward = escapePanelHtml(task.value.奖励);
  return [
    '<task_info>',
    '<style>',
    '.eyon-ruin-quest{--rq-ink:#2f2839;--rq-muted:#73677c;--rq-gold:#a98245;--rq-line:rgba(125,94,47,.28);position:relative;display:block;max-width:760px;margin:18px auto;padding:22px 24px 20px;border:1px solid var(--rq-line);border-radius:16px;background:linear-gradient(135deg,rgba(253,248,238,.98),rgba(239,232,226,.96));box-shadow:0 14px 36px rgba(45,35,54,.14);color:var(--rq-ink);font-family:"Noto Serif SC","Songti SC",serif;overflow:hidden}',
    '.eyon-ruin-quest:before{content:"";position:absolute;inset:7px;border:1px solid rgba(169,130,69,.2);border-radius:11px;pointer-events:none}',
    '.eyon-ruin-quest__head{position:relative;display:grid;grid-template-columns:1fr auto;gap:8px 16px;padding-bottom:14px;border-bottom:1px solid var(--rq-line)}',
    '.eyon-ruin-quest__eyebrow{font:600 11px/1.2 Georgia,serif;letter-spacing:.22em;color:var(--rq-gold)}',
    '.eyon-ruin-quest__rank{grid-row:1/3;grid-column:2;align-self:center;display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--rq-gold);border-radius:50%;font:700 20px/1 Georgia,serif;color:var(--rq-gold);box-shadow:inset 0 0 0 4px rgba(169,130,69,.08)}',
    '.eyon-ruin-quest h3{margin:0;font-size:clamp(19px,3vw,25px);line-height:1.35;color:var(--rq-ink)}',
    '.eyon-ruin-quest__meta{margin:9px 0 0;color:var(--rq-muted);font-size:13px}',
    '.eyon-ruin-quest dl{position:relative;display:grid;gap:12px;margin:18px 0 0}',
    '.eyon-ruin-quest dl>div{display:grid;grid-template-columns:3.6em 1fr;gap:12px;align-items:start}',
    '.eyon-ruin-quest dt{color:var(--rq-gold);font-weight:700;letter-spacing:.08em}',
    '.eyon-ruin-quest dd{margin:0;line-height:1.75;overflow-wrap:anywhere}',
    '.eyon-ruin-quest__reward{padding-top:12px;border-top:1px dashed var(--rq-line)}',
    '@media(max-width:520px){.eyon-ruin-quest{padding:19px 18px 17px}.eyon-ruin-quest dl>div{grid-template-columns:1fr;gap:3px}}',
    '</style>',
    '<section class="eyon-ruin-quest" aria-label="墟境任务">',
    '  <header class="eyon-ruin-quest__head">',
    '    <span class="eyon-ruin-quest__eyebrow">RUIN COMMISSION</span>',
    `    <span class="eyon-ruin-quest__rank">${difficulty}</span>`,
    `    <h3>${title}</h3>`,
    '  </header>',
    `  <p class="eyon-ruin-quest__meta">委托人 · ${escapePanelHtml(task.commissioner)}</p>`,
    '  <dl>',
    `    <div><dt>详情</dt><dd>${detail}</dd></div>`,
    `    <div><dt>目标</dt><dd>${objective}</dd></div>`,
    `    <div class="eyon-ruin-quest__reward"><dt>奖励</dt><dd>${reward}</dd></div>`,
    '  </dl>',
    '</section>',
    '</task_info>',
  ].join('\n');
}

export function buildRuinTaskTerminalPanel(task: RuinTaskSnapshot): string {
  const title = escapePanelHtml(stripTaskPrefix(task.name));
  const status = escapePanelHtml(task.status || '已结束');
  const progress = escapePanelHtml(task.progress || '任务进程已经结束。');
  const objective = escapePanelHtml(task.objective || '未记录');
  const reward = escapePanelHtml(task.reward || '未记录');
  const terminalClass = /失败|取消|放弃|终止/u.test(task.status)
    ? 'is-failed'
    : 'is-complete';
  return [
    '<task_result>',
    '<style>',
    '.eyon-ruin-quest{--rq-ink:#2f2839;--rq-muted:#73677c;--rq-gold:#a98245;--rq-line:rgba(125,94,47,.28);position:relative;display:block;max-width:760px;margin:18px auto;padding:22px 24px 20px;border:1px solid var(--rq-line);border-radius:16px;background:linear-gradient(135deg,rgba(253,248,238,.98),rgba(239,232,226,.96));box-shadow:0 14px 36px rgba(45,35,54,.14);color:var(--rq-ink);font-family:"Noto Serif SC","Songti SC",serif;overflow:hidden}',
    '.eyon-ruin-quest:before{content:"";position:absolute;inset:7px;border:1px solid rgba(169,130,69,.2);border-radius:11px;pointer-events:none}',
    '.eyon-ruin-quest__head{position:relative;display:grid;grid-template-columns:1fr auto;gap:8px 16px;padding-bottom:14px;border-bottom:1px solid var(--rq-line)}',
    '.eyon-ruin-quest__eyebrow{font:600 11px/1.2 Georgia,serif;letter-spacing:.22em;color:var(--rq-gold)}',
    '.eyon-ruin-quest__rank{grid-row:1/3;grid-column:2;align-self:center;display:grid;place-items:center;min-width:64px;height:36px;padding:0 10px;border:1px solid var(--rq-gold);border-radius:999px;font:700 13px/1 Georgia,"Noto Serif SC",serif;color:var(--rq-gold);box-shadow:inset 0 0 0 4px rgba(169,130,69,.08)}',
    '.eyon-ruin-quest.is-complete{--rq-gold:#6c8e79;--rq-line:rgba(75,119,91,.3)}',
    '.eyon-ruin-quest.is-failed{--rq-gold:#a26067;--rq-line:rgba(146,75,83,.3)}',
    '.eyon-ruin-quest h3{margin:0;font-size:clamp(19px,3vw,25px);line-height:1.35;color:var(--rq-ink)}',
    '.eyon-ruin-quest__meta{margin:9px 0 0;color:var(--rq-muted);font-size:13px}',
    '.eyon-ruin-quest dl{position:relative;display:grid;gap:12px;margin:18px 0 0}',
    '.eyon-ruin-quest dl>div{display:grid;grid-template-columns:4.6em 1fr;gap:12px;align-items:start}',
    '.eyon-ruin-quest dt{color:var(--rq-gold);font-weight:700;letter-spacing:.08em}',
    '.eyon-ruin-quest dd{margin:0;line-height:1.75;overflow-wrap:anywhere}',
    '.eyon-ruin-quest__reward{padding-top:12px;border-top:1px dashed var(--rq-line)}',
    '@media(max-width:520px){.eyon-ruin-quest{padding:19px 18px 17px}.eyon-ruin-quest dl>div{grid-template-columns:1fr;gap:3px}}',
    '</style>',
    `<section class="eyon-ruin-quest ${terminalClass}" aria-label="墟境任务结果">`,
    '  <header class="eyon-ruin-quest__head">',
    '    <span class="eyon-ruin-quest__eyebrow">COMMISSION RESULT</span>',
    `    <span class="eyon-ruin-quest__rank">${status}</span>`,
    `    <h3>${title}</h3>`,
    '  </header>',
    '  <p class="eyon-ruin-quest__meta">委托人 · 伊雍</p>',
    '  <dl>',
    `    <div><dt>结果</dt><dd>${progress}</dd></div>`,
    `    <div><dt>原目标</dt><dd>${objective}</dd></div>`,
    `    <div class="eyon-ruin-quest__reward"><dt>约定奖励</dt><dd>${reward}</dd></div>`,
    '  </dl>',
    '</section>',
    '</task_result>',
  ].join('\n');
}

function escapePanelHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function buildRuinTaskContract(
  task: RuinTaskRecord,
  direction: string,
  runId: string,
  requestId: string,
  approvedTaskHash = fingerprintText(JSON.stringify(task)),
): string {
  const escapedPath = jsonPointerSegment(task.name);
  const slot = ruinTaskSlot(requestId);
  return [
    '【历史工作台·墟境任务封缄契约】',
    `墟境轮次：${runId}`,
    `玩家原始方向：${direction}`,
    `封缄哈希：${approvedTaskHash}`,
    `资料标识：${requestId}`,
    '',
    '这是<user>已在工作台检查并确认的唯一任务。不得改写、扩张、重拟任务，也不得替<user>补造动机、意义或期望结果。',
    '请承接上一楼现场，让任务面板自然出现；不要复述本契约，不要替<user>行动或宣布成功。本楼不发放奖励、不触发遣返。',
    '只有玩家在同一楼亲自写出的行动才可发生；若该楼只有确认语句，则仅确认委托成立，不得擅自让<user>开始执行、完成目标或移动到别处。',
    '在自然正文中任务卡应出现的位置，单独输出且只输出一次下列占位符：',
    slot,
    '不得自行生成<task_info>、HTML或CSS；历史工作台会在本楼完程后将该占位符原子替换为唯一封缄任务卡。',
    '回复末尾按现有MVU规则输出唯一一份完整变量更新；其中必须包含且只新增这一项任务，JSON Patch目标路径为：',
    `/任务列表/${escapedPath}`,
    `该路径的值必须逐字等于：${JSON.stringify(task.value)}`,
    '不得创建第二套任务状态，不得把内部ID、封缄哈希或本契约显示给<user>。',
  ].join('\n');
}

export function ruinTaskSlot(requestId: string): string {
  return `[EYON_RUINTASK_SLOT::${requestId}]`;
}

function normalizeDraftRequest(value: RuinTaskDraftRequest): RuinTaskDraftRequest {
  const direction = normalizeDirection(value.direction);
  if (!direction) throw new Error('请先写下想做的事情');
  const interpretation: RuinTaskInterpretation = ['原意锁定', '情境补全', '自由演绎'].includes(value.interpretation)
    ? value.interpretation : '原意锁定';
  const scale: RuinTaskScale = ['即时互动', '短程目标', '阶段任务'].includes(value.scale)
    ? value.scale : '即时互动';
  return { direction, interpretation, scale };
}

function assertCanCreateTask(snapshot: Awaited<ReturnType<HostAdapter['getRuinRuntimeSnapshot']>>, direction: string): void {
  if (snapshot.flowState !== 'exploring' && snapshot.flowState !== 'anchored') {
    throw new Error('只有进入墟境后才能建立墟境任务');
  }
  if (!snapshot.runId.trim()) throw new Error('当前墟境缺少有效轮次，无法建立任务');
  if (!direction) throw new Error('请先写下想做的事情');
  assertNoActiveTask(snapshot);
}

function assertNoActiveTask(snapshot: Awaited<ReturnType<HostAdapter['getRuinRuntimeSnapshot']>>): void {
  const active = (snapshot.ruinTasks ?? []).find(item => !item.terminal);
  if (active) throw new Error(`“${active.name}”尚未结束，不能同时建立第二项墟境任务`);
}

function assertSameRuin(
  beforeNamespace: WorkbenchNamespace,
  runId: string,
  afterNamespace: WorkbenchNamespace,
  snapshot: Awaited<ReturnType<HostAdapter['getRuinRuntimeSnapshot']>>,
  prefix: string,
): void {
  if (namespaceKey(afterNamespace) !== namespaceKey(beforeNamespace)) {
    throw new Error(`${prefix}聊天发生变化，结果已隔离`);
  }
  if (snapshot.runId !== runId || snapshot.flowState === 'idle') {
    throw new Error(`${prefix}墟境轮次已经变化，结果已隔离`);
  }
}

function normalizeDirection(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function confirmationMarker(title: string): string {
  return `确认墟境任务：${title}`;
}

function includesConfirmationMarker(text: string, title: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\r\n?/gu, '\n');
  return normalized.includes(confirmationMarker(title).normalize('NFKC'));
}

function stripTaskPrefix(name: string): string {
  return name.replace(/^\[墟境任务[·・](?:个人|团队)\]/u, '').trim() || name;
}

function normalizeEditable(value: string, label: string, min: number, max: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (normalized.length < min) throw new Error(`${label}至少需要${min}个字`);
  return normalized.slice(0, max);
}

function plainDetail(task: RuinTaskRecord): string {
  return task.value.详情.replace(new RegExp(`^${task.difficulty}级[。.]?\\s*`, 'u'), '').trim();
}

function reviewTask(record: RuinTaskRecord): RuinTaskReviewSnapshot['task'] {
  return {
    title: record.title,
    mode: record.mode,
    difficulty: record.difficulty,
    status: record.value.状态,
    attention: record.value.关注度,
    progress: record.value.进展,
    detail: plainDetail(record),
    objective: record.value.目标,
    reward: record.value.奖励,
  };
}

function publicReview(review: RuinTaskReviewState): RuinTaskReviewSnapshot {
  const { namespace: _namespace, record: _record, ...snapshot } = review;
  return structuredClone(snapshot);
}

function reviewFromLock(lock: RuinTaskFloorLock, previous: RuinTaskReviewState | null): RuinTaskReviewState {
  return {
    phase: 'approved',
    runId: lock.runId,
    direction: lock.direction,
    interpretation: previous?.interpretation ?? '原意锁定',
    scale: previous?.scale ?? '即时互动',
    task: reviewTask(lock.task),
    approvedTaskHash: lock.approvedTaskHash,
    triggerMessageId: lock.triggerMessageId,
    namespace: lock.namespace,
    record: lock.task,
  };
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function readNarrativeContext(runtime: TavernRuntime): {
  entryHistory: Record<string, unknown> | null;
  recentNarrative: Array<{ role: 'user' | 'assistant'; text: string }>;
} {
  const last = runtime.getLastMessageId();
  const messages = runtime.getChatMessages(`0-${Math.max(0, last)}`, { include_swipes: false })
    .filter(message => !message.is_hidden && (message.role === 'user' || message.role === 'assistant'));
  const entry = [...messages].reverse().map(readEntryHistory).find(Boolean) ?? null;
  const recentNarrative = messages.slice(-10).map(message => ({
    role: message.role as 'user' | 'assistant',
    text: sanitizeNarrative(message.message).slice(-2200),
  }));
  return { entryHistory: entry, recentNarrative };
}

function readEntryHistory(message: RuntimeChatMessage): Record<string, unknown> | null {
  const metadata = message.extra?.[ENTRY_METADATA_KEY];
  if (!isRecord(metadata) || !isRecord(metadata.ruinHistory)) return null;
  return metadata.ruinHistory;
}

function sanitizeNarrative(value: string): string {
  return value
    .replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/giu, '')
    .replace(/<task_info>[\s\S]*?<\/task_info>/giu, '')
    .replace(/<task_result>[\s\S]*?<\/task_result>/giu, '')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
