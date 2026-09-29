import { BiographyController } from './runtime/biographyController.ts';
import { ButterflyController } from './runtime/butterflyController.ts';
import { TavernButterflyNarrativeShell } from './runtime/tavernButterflyShell.ts';
import { TavernButterflyContextAssembler } from './runtime/butterflyContext.ts';
import { TavernBiographyContextAssembler } from './runtime/biographyContext.ts';
import { createBiographyEvidenceResolver } from './runtime/biographyEvidence.ts';
import {
  createGlobalDataBindings,
  createGlobalEventBridge,
  createGlobalScriptVariableBindings,
  waitForGlobalMvu,
} from './runtime/globalBindings.ts';
import { registerWorkbenchLifecycle } from './runtime/registerLifecycle.ts';
import {
  createRuinIdentityAssertion,
  RuinController,
  RuinTransactionGuard,
} from './runtime/ruinController.ts';
import { TavernRuinContextAssembler } from './runtime/ruinContext.ts';
import { TavernGenealogyContextAssembler } from './runtime/genealogyContext.ts';
import {
  createGenealogyIdentityAssertion,
  GenealogyController,
  GenealogyTransactionGuard,
} from './runtime/genealogyController.ts';
import { TavernGenealogyInputProvider } from './runtime/genealogyInput.ts';
import {
  embeddedBiographyRules,
  embeddedGenealogyRules,
  embeddedButterflyRules,
  embeddedRuinRules,
} from './runtime/ruleBundle.ts';
import { TavernBiographyShellAdapter } from './runtime/tavernBiographyShell.ts';
import {
  TavernGenerationAdapter,
  isGenerationCancelledError,
} from './runtime/tavernGeneration.ts';
import {
  clearTavernComposerText,
  installBiographyPreSendInterceptor,
  readTavernComposerText,
} from './runtime/biographyPreSend.ts';
import {
  SerializedTavernUserTurnAdapter,
  TavernContextSourceProvider,
  TavernButterflyMirrorRetirement,
  TavernWorkbenchHost,
} from './runtime/tavernHost.ts';
import { resolveWorkbenchDisplayText } from './runtime/displayText.ts';
import { TavernRuinEntryShellAdapter } from './runtime/tavernRuinEntryShell.ts';
import { TavernRuinTaskShellAdapter } from './runtime/tavernRuinTaskShell.ts';
import {
  createGlobalTavernRuntime,
  resolveTavernHelperFunction,
} from './runtime/tavernRuntimeAdapter.ts';
import {
  customApiAuthenticationError,
  customAuthorizationHeader,
  isAuthenticationFailure,
  normalizeCustomApiBaseUrl,
  requireCustomApiKey,
} from './runtime/customApiCredentials.ts';
import { TavernScopeReader } from './runtime/tavernScope.ts';
import { registerRuinTimeKernel } from './runtime/ruinTimeKernel.ts';
import { TavernRuinTurnGuard } from './runtime/ruinTurnGuard.ts';
import {
  ScriptWorkbenchSettings,
  type GenerationTaskType,
} from './runtime/workbenchSettings.ts';
import { toGenerationFailureEnvelope } from './runtime/generationError.ts';
import { WorkbenchLifecycle } from './runtime/workbenchLifecycle.ts';
import { listRuinPresenceDiagnostics } from './runtime/presenceDiagnostics.ts';
import { IndexedDbBiographyRepository } from './storage/indexedDbBiographies.ts';
import {
  IndexedDbGenealogyRepository,
  type GenealogyRecord,
} from './storage/genealogies.ts';
import {
  IndexedDbRuinCandidateRepository,
  type RuinCandidateRecord,
} from './storage/ruins.ts';
import {
  IndexedDbRuinCharacterReferenceRepository,
  ruinCharacterReferenceIdentity,
  type RuinSelectedCharacter,
} from './storage/ruinReferences.ts';
import { namespaceKey } from './core/namespace.ts';
import type { RuinGenerationInput } from './schemas/ruin.ts';
import { BiographyWorkflow } from './workflows/biography.ts';
import { RuinWorkflow } from './workflows/ruin.ts';
import { RuinEntryWorkflow } from './workflows/ruinEntry.ts';
import { RuinTaskWorkflow } from './workflows/ruinTask.ts';
import { GenealogyWorkflow } from './workflows/genealogy.ts';
import { genealogyNodeToRuinReference } from './runtime/genealogySources.ts';
import { buildGenealogyLocalView } from './core/genealogyLocalView.ts';
import {
  clearP4DerivedCache,
  inspectP4DerivedCache,
} from './core/p4DerivedCache.ts';
import { ButterflyWorkflow } from './workflows/butterfly.ts';
import { IndexedDbButterflyRepository } from './storage/butterflies.ts';
import { IndexedDbCanonRepository } from './storage/canon.ts';
import {
  WORKBENCH_DATA_CHANGED_EVENT,
  WORKBENCH_CANCEL_TASK_EVENT,
  WORKBENCH_GLOBAL,
  WORKBENCH_READY_EVENT,
  WORKBENCH_RUIN_REFERENCES_EVENT,
  WORKBENCH_STATUS_EVENT,
  type EyonHistoryWorkbenchFacade,
  type GenealogyCharacterOption,
  type WorkbenchStatusDetail,
  type WorkbenchDataChangedDetail,
} from './runtime/facade.ts';
import { listPromptDiagnostics } from './runtime/promptDiagnostics.ts';
import { inspectCanonBranch } from './runtime/canonDiagnostics.ts';
import {
  latestArtifactCanonAssessmentTarget,
  listCanonResolvedViewDiagnostics,
} from './runtime/canonViewDiagnostics.ts';
import {
  inspectArtifactCanonAssessments,
  inspectArtifactCanonBindings,
  inspectArtifactCanonConsumption,
} from './runtime/artifactCanonDiagnostics.ts';
import {
  createWorkbenchBackup,
  inspectWorkbenchData,
  type WorkbenchDataCollection,
} from './runtime/dataManagement.ts';
import { installHostStatusToast } from './ui/hostStatusToast.ts';
import { createBiographyStagePlan } from './runtime/biographyDice.ts';
import { RuntimeShadowRetrievalObserver } from './retrieval/runtimeShadow.ts';
import {
  reconcileCanonOrphans,
  runtimeMessageExistenceProbe,
} from './runtime/canonOrphanReconcile.ts';
// internal.87（G-12）：记录 canonStatus 与当前分支状态对账。
import { syncButterflyCanonStatuses } from './runtime/canonRecordStatus.ts';
import {
  CanonMemoryChannel,
  createCanonMemoryTombstone,
} from './runtime/canonMemoryChannel.ts';
import { inspectContinuityAnchors } from './runtime/continuityAnchors.ts';

let disposeCurrent: (() => void) | null = null;

async function bootstrap(): Promise<void> {
  disposeCurrent?.();
  const globalObject = globalThis as Record<string, unknown>;
  await waitForGlobalMvu(globalObject);
  const disposeHostStatusToast = installHostStatusToast(globalThis);
  const runtime = createGlobalTavernRuntime(globalObject);
  const dataBindings = createGlobalDataBindings(globalObject);
  const settings = new ScriptWorkbenchSettings(
    createGlobalScriptVariableBindings(globalObject),
  );
  const emitTaskStatus = (
    taskType: GenerationTaskType,
    status: string,
    detail = '',
    extra: Partial<WorkbenchStatusDetail> = {},
  ) => {
    const phase = extra.phase ?? classifyStatusPhase(status);
    const technicalDetail = phase === 'error' ? detail : extra.technicalDetail;
    if (phase === 'error') {
      try {
        settings.appendError({
          id: crypto.randomUUID(),
          taskType,
          message: detail,
          occurredAt: Date.now(),
        });
      } catch (error) {
        console.error('[Eyon History Workbench] failed to persist error log', error);
      }
    }
    emitStatus(
      status,
      phase === 'error'
        ? `${taskLabel(taskType)}未完成，详情已保存至设置中的错误日志`
        : detail,
      {
        ...extra,
        taskType,
        phase,
        cancellable: extra.cancellable
          ?? (phase === 'running' || phase === 'retrying'),
        technicalDetail,
      },
    );
  };
  const biographies = new IndexedDbBiographyRepository();
  const genealogies = new IndexedDbGenealogyRepository();
  const ruins = new IndexedDbRuinCandidateRepository();
  const ruinReferences = new IndexedDbRuinCharacterReferenceRepository();
  const butterflies = new IndexedDbButterflyRepository();
  const canon = new IndexedDbCanonRepository();
  const host = new TavernWorkbenchHost(runtime, dataBindings);
  const sources = new TavernContextSourceProvider(
    dataBindings,
    biographies,
    genealogies,
    () => scopeReader.getNamespace(),
    namespace => settings.getWorldbookEntryExclusions(namespace),
    // internal.87（§6 步 B）：蝴蝶史料源改为本地记录 + Canon 投影。
    butterflies,
    canon,
  );
  const scopeReader = new TavernScopeReader(runtime, () =>
    latestVisibleUserMessageId(runtime));
  const generator = new TavernGenerationAdapter(
    runtime,
    settings,
    () => crypto.randomUUID(),
    {
      onRetry: (taskType, attempt, max, error) => {
        const raw = error instanceof Error ? error.message : String(error);
        // 自动重试前把失败原因写入错误日志，避免“重试最终成功”后
        // 找不到首次失败的技术详情。
        try {
          settings.appendError({
            id: crypto.randomUUID(),
            taskType,
            message: `第 ${attempt} 次尝试失败：${raw}`,
            // 标准错误码（信封）：用户设置页一眼分流「校验 vs 环境 vs 临时」
            code: toGenerationFailureEnvelope(error).code,
            occurredAt: Date.now(),
          });
        } catch (logError) {
          console.error('[Eyon History Workbench] failed to persist retry log', logError);
        }
        const short = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
        emitTaskStatus(
          taskType,
          'retrying_generation',
          `${taskLabel(taskType)}连接中断（${short}），伊雍正在重新校订（${attempt}/${max}）`,
          {
            phase: 'retrying',
            retry: { attempt, max },
            technicalDetail: raw,
          },
        );
      },
      onRecoveredAfterRetry: (taskType, info) => {
        // 失败 → 重试 → 成功：补一条恢复记录，让设置页错误日志闭环
        // （此前只有失败条目，没有“最终成功”的收尾，用户看不到重试是否成功）。
        const raw = info.error instanceof Error ? info.error.message : String(info.error);
        const code = toGenerationFailureEnvelope(info.error).code;
        try {
          settings.appendError({
            id: crypto.randomUUID(),
            taskType,
            message: `重试后成功（第 ${info.successAttempt} 次尝试）：此前失败原因 ${raw}`,
            code: `RECOVERED_AFTER_${code}`,
            occurredAt: Date.now(),
          });
        } catch (logError) {
          console.error('[Eyon History Workbench] failed to persist recovery log', logError);
        }
        emitTaskStatus(
          taskType,
          'generating',
          `${taskLabel(taskType)}已恢复（此前失败原因：${raw.slice(0, 80)}）`,
          {
            phase: 'recovered',
            retry: { attempt: info.successAttempt, max: info.max },
            technicalDetail: `recovered from ${code}: ${raw}`,
          },
        );
      },
      onRequestProgress: (taskType, info) => {
        if (info.status === 'running') {
          // 请求进行中：更新同一条任务通知，显示阶段与尝试次数。
          // 「已等待」时长由宿主页 toast 按 startedAt 自行计时，
          // 不受后台标签节流 iframe 计时器的影响。
          const label = info.label || `${taskLabel(taskType)}正在等待模型返回`;
          const attempt = info.attempt > 1
            ? ` · 第 ${info.attempt} / ${info.maxRetries} 次尝试`
            : '';
          emitTaskStatus(
            taskType,
            'generating',
            `${label}${attempt}`,
            {
              phase: 'running',
              progress: {
                current: info.attempt,
                total: info.maxRetries,
                startedAt: info.startedAt,
              },
            },
          );
        }
      },
    },
  );
  const retrievalShadow = new RuntimeShadowRetrievalObserver(24);
  const biographyShell = new TavernBiographyShellAdapter(runtime);
  const resolveBiographyEvidence = createBiographyEvidenceResolver(sources);
  const biographyWorkflow = new BiographyWorkflow({
    contextAssembler: new TavernBiographyContextAssembler(
      runtime,
      sources,
      retrievalShadow,
      settings.ensureBaselineWorldTime.bind(settings),
      canon,
      biographies,
    ),
    generator,
    shell: biographyShell,
    repository: biographies,
    rules: embeddedBiographyRules,
    getScope: async () => scopeReader.getScope(),
    createRequestId: () => crypto.randomUUID(),
    now: Date.now,
    createStagePlan: createBiographyStagePlan,
    canonRepository: canon,
    // 二次检索：本批计划或首稿实际借用的具名实体 → 精确补齐身份资料；不按年代扩张历史事实集。
    resolveEvidence: resolveBiographyEvidence,
  });
  const biographyController = new BiographyController(
    biographyWorkflow,
    biographyShell,
    runtime,
    async () => scopeReader.getScope(),
    {
      onStatus: (status, detail) =>
        emitTaskStatus('biography', status, detail),
      onCommitted: result => {
        // 剧情时钟：传记正文产出的时间戳写回脚本变量，随角色卡持久化
        try {
          settings.setStoryClock(result.storyClock);
        } catch (error) {
          console.error('[Eyon History Workbench] failed to persist story clock', error);
        }
      },
    },
  );
  const ruinGuard = new RuinTransactionGuard();
  const ruinWorkflow = new RuinWorkflow({
    contextAssembler: new TavernRuinContextAssembler(
      runtime,
      sources,
      async () => new Set(
        (await ruinReferences.readBiographies(scopeReader.getNamespace()))
          .map(reference => reference.biographyId),
      ),
      retrievalShadow,
      settings.ensureBaselineWorldTime.bind(settings),
      canon,
      biographies,
    ),
    generator,
    repository: ruins,
    rules: embeddedRuinRules,
    createRequestId: () => crypto.randomUUID(),
    now: Date.now,
    assertCurrent: createRuinIdentityAssertion(runtime, ruinGuard),
    canonRepository: canon,
    onCandidateProgress: event => {
      emitTaskStatus(
        'ruin',
        event.stage === 'running'
          ? 'generating_candidate'
          : event.stage === 'success'
          ? 'candidate_ready'
          : 'candidate_failed',
        event.stage === 'running'
          ? `正在生成墟境（${event.candidateIndex}/${event.total}）`
          : event.stage === 'success'
          ? `墟境候选已完成（${event.completed}/${event.total}）`
          : `第${event.candidateIndex}个墟境未完成，可单独重试`,
        {
          phase: event.stage === 'running'
            ? 'running'
          : event.stage === 'success'
            ? 'running'
            : 'error',
          progress: {
            current: event.stage === 'running'
              ? event.candidateIndex
              : event.completed,
            total: event.total,
          },
        },
      );
    },
    resolveSelectedCharacters: selected => sources.projectRuinCharacters(selected),
  });
  const ruinController = new RuinController(
    ruinWorkflow,
    runtime,
    {
      onStatus: (status, detail) =>
        emitTaskStatus('ruin', status, detail),
    },
    ruinGuard,
  );
  const genealogyGuard = new GenealogyTransactionGuard();
  const genealogyWorkflow = new GenealogyWorkflow({
    contextAssembler: new TavernGenealogyContextAssembler(
      runtime,
      sources,
      retrievalShadow,
      settings.ensureBaselineWorldTime.bind(settings),
      canon,
      biographies,
    ),
    generator,
    repository: genealogies,
    rules: embeddedGenealogyRules,
    createRequestId: () => crypto.randomUUID(),
    now: Date.now,
    assertCurrent: createGenealogyIdentityAssertion(runtime, genealogyGuard),
    canonRepository: canon,
  });
  const genealogyController = new GenealogyController(
    genealogyWorkflow,
    runtime,
    {
      onStatus: (status, detail) =>
        emitTaskStatus('genealogy', status, detail),
    },
    genealogyGuard,
  );
  const userTurns = new SerializedTavernUserTurnAdapter(runtime, dataBindings, {
    onUserFloorCreated: text => {
      // 只清除仍与刚建立玩家楼完全一致的旧输入；若玩家已开始输入下一句则保持不动。
      clearTavernComposerText(text, globalObject);
    },
  });
  const biographyPreSend = installBiographyPreSendInterceptor({
    globalObject,
    submit: async (text, signal) => {
      await userTurns.sendUserTurn(text, {
        signal,
        beforeCreate: expectedMessageId =>
          biographyController.prepareBeforeUserTurn(text, expectedMessageId)
            .then(() => undefined),
        afterCreate: messageId =>
          biographyController.confirmPreparedUserFloor(text, messageId),
      });
    },
  });
  const ruinEntry = new RuinEntryWorkflow({
    repository: ruins,
    host,
    userTurns,
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
    hooks: {
      onStatus: (status, detail, extra) =>
        emitTaskStatus('ruin', status, detail, extra as Partial<WorkbenchStatusDetail>),
    },
  });
  const ruinTask = new RuinTaskWorkflow({
    host,
    generator,
    userTurns,
    runtime,
    sources,
    shell: new TavernRuinTaskShellAdapter(runtime),
    hooks: {
      onStatus: (status, detail, extra) => {
        emitTaskStatus('ruin', status, detail, extra as Partial<WorkbenchStatusDetail>);
        if (status === 'ready') {
          globalThis.dispatchEvent(new CustomEvent(WORKBENCH_DATA_CHANGED_EVENT, {
            detail: { views: ['ruin'], reason: 'ruin-task-requested' },
          }));
        }
      },
    },
  });
  const butterflyContext = new TavernButterflyContextAssembler(
    runtime,
    sources,
    host,
    retrievalShadow,
    settings.ensureBaselineWorldTime.bind(settings),
    canon,
  );
  // internal.87（§6 步 B）：世界书镜像已退役，这里只保留存量镜像的显式清理能力。
  const butterflyMirror = new TavernButterflyMirrorRetirement(dataBindings);
  const butterflyWorkflow = new ButterflyWorkflow({
    generator,
    repository: butterflies,
    canonRepository: canon,
    host,
    rules: embeddedButterflyRules,
    now: Date.now,
  });
  const butterflyController = new ButterflyController({
    assembler: butterflyContext,
    workflow: butterflyWorkflow,
    repository: butterflies,
    runtime,
    createRequestId: () => crypto.randomUUID(),
    roll: () => crypto.getRandomValues(new Uint32Array(1))[0] % 100 + 1,
    now: Date.now,
    narrativeShell: new TavernButterflyNarrativeShell(runtime),
    hooks: {
      onStatus: (status, detail) =>
        emitTaskStatus('butterfly', status, detail),
    },
  });
  let activeReturnTurnController: AbortController | null = null;
  const lifecycle = new WorkbenchLifecycle({
    biography: biographyController,
    ruin: ruinController,
    ruinInputProvider: settings,
    genealogy: genealogyController,
    genealogyInputProvider: new TavernGenealogyInputProvider(sources, settings),
    butterfly: butterflyController,
    ruinEntry,
    ruinTask,
    ruinTurnGuard: new TavernRuinTurnGuard(runtime, host),
    runtime,
  });
  const events = createGlobalEventBridge(globalObject);
  const timeKernel = registerRuinTimeKernel(
    runtime,
    dataBindings,
    globalObject,
  );
  const registration = registerWorkbenchLifecycle(
    lifecycle,
    events.bridge,
    events.names,
    globalObject,
  );
  // internal.86（蓝图 §6 步 A）：蝴蝶记忆注入通道。
  // 让「当前分支仍有效的改写历史」直接进入正文模型（不再依赖世界书激活）；
  // 刷新时机：正文生成前（最准）/ 切聊天 / 删楼回退 / AI 楼渲染后 / 手动。
  const canonMemory = new CanonMemoryChannel(runtime);
  const refreshCanonMemory = (trigger: string): void => {
    let namespace: ReturnType<typeof scopeReader.getNamespace>;
    try {
      namespace = scopeReader.getNamespace();
    } catch {
      return; // 无活动聊天 → 跳过
    }
    void (async () => {
      const [records, tombstones, biographyRecords, branch] = await Promise.all([
        butterflies.list(namespace),
        butterflies.listMemoryTombstones(namespace),
        biographies.list(namespace),
        canon.getBranch(namespace),
      ]);
      await canonMemory.refresh({
        records,
        tombstones,
        biographies: biographyRecords,
        branch,
        trigger,
        currentInput: readTavernComposerText(globalObject) ?? '',
        now: Date.now(),
      });
    })().catch(error => console.error(
      '[Eyon History Workbench] canon memory refresh failed',
      error,
    ));
  };
  const onCanonMemoryBeforeGeneration = (): void => {
    refreshCanonMemory('before-generation');
  };
  const onCanonMemoryChatChanged = (): void => {
    refreshCanonMemory('chat-changed');
  };
  const onCanonMemoryRendered = (...args: unknown[]): void => {
    const messageId = Number(args[0]);
    if (!Number.isInteger(messageId) || messageId < 0) return;
    refreshCanonMemory('message-rendered');
  };
  if (events.names.generationAfterCommands) {
    events.bridge.on(events.names.generationAfterCommands, onCanonMemoryBeforeGeneration);
  }
  if (events.names.chatChanged) {
    events.bridge.on(events.names.chatChanged, onCanonMemoryChatChanged);
  }
  if (events.names.characterMessageRendered) {
    events.bridge.on(events.names.characterMessageRendered, onCanonMemoryRendered);
  }
  // 删楼回退:释放进入防重标记(宿主不支持该事件时静默降级)
  // F-03（internal.83）：宿主批量删除/截断只对部分消息派发 messageDeleted
  // （真机病历：删到第 47 楼后绑 52/58 的 revision 收不到事件），孤儿 active
  // 无法经删楼回滚。每次收到任意删楼事件后顺带做一次孤儿清扫（X 入口）。
  // internal.87（G-12）：记录状态与当前分支对账。
  // 删除/批删/清理都可能先由 F-03 清扫回滚 canon，此时 messageDeleted 处理器自己的
  // rollbackByMessageId 会返回 null；旧实现借此早退，导致记录 canonStatus 停在旧值，
  // 使 v21「reverted → 重新生成」闸误判为"仍有效"而复用旧文本。改为按当前分支重算。
  const syncCanonRecordStatuses = async (
    namespace: ReturnType<typeof scopeReader.getNamespace>,
    receipt?: Parameters<typeof syncButterflyCanonStatuses>[0]['receipt'],
  ): Promise<void> => {
    try {
      await syncButterflyCanonStatuses({
        repository: butterflies,
        namespace,
        branch: await canon.getBranch(namespace),
        now: Date.now(),
        ...(receipt ? { receipt } : {}),
      });
      if (namespaceKey(namespace) === namespaceKey(scopeReader.getNamespace())) {
        publishDataChanged({ views: ['genealogy', 'ruin'], reason: 'canon-memory-refreshed' });
      }
    } catch (error) {
      console.error(
        '[Eyon History Workbench] canon record status sync failed',
        error,
      );
    }
  };
  const runCanonOrphanReconcile = (): void => {
    try {
      const namespace = scopeReader.getNamespace();
      void reconcileCanonOrphans(
        canon,
        namespace,
        runtimeMessageExistenceProbe(messageId =>
          runtime.getChatMessages(messageId, { include_swipes: false })),
        Date.now(),
      )
        .then(() => syncCanonRecordStatuses(namespace))
        .catch(error => console.error(
          '[Eyon History Workbench] canon orphan reconcile failed',
          error,
        ));
    } catch {
      // 无活动聊天/namespace 未就绪 → 跳过
    }
  };
  const onMessageDeleted = (messageId: unknown): void => {
    const id = typeof messageId === 'number' ? messageId : Number(messageId);
    if (Number.isInteger(id) && id >= 0) {
      ruinEntry.onMessageDeleted(id);
      void ruinTask.onMessageDeleted(id).catch(error => console.error(
        '[Eyon History Workbench] failed to restore ruin task draft after message deletion',
        error,
      ));
      const namespace = scopeReader.getNamespace();
      void (async () => {
        const rollback = await canon.rollbackByMessageId(namespace, id, Date.now());
        // G-12：即使本次回滚不由这里执行（清扫抢先 / 脚本未加载时由 Y 入口补清），
        // 也要按当前分支状态把记录状态对齐——回执仍按 receipt 附带留痕。
        await syncCanonRecordStatuses(namespace, rollback?.receipt);
      })().catch(error => console.error(
          '[Eyon History Workbench] failed to rollback canon revision after message deletion',
          error,
        ));
    }
    runCanonOrphanReconcile();
    refreshCanonMemory('message-deleted');
  };
  if (events.names.messageDeleted) {
    events.bridge.on(events.names.messageDeleted, onMessageDeleted);
  }
  const publishRuinReferences = (references: RuinSelectedCharacter[]): void => {
    globalThis.dispatchEvent(new CustomEvent(
      WORKBENCH_RUIN_REFERENCES_EVENT,
      { detail: structuredClone(references) },
    ));
  };
  const publishDataChanged = (detail: WorkbenchDataChangedDetail): void => {
    globalThis.dispatchEvent(new CustomEvent(
      WORKBENCH_DATA_CHANGED_EVENT,
      { detail: structuredClone(detail) },
    ));
  };
  const cancelTask = async (taskType: GenerationTaskType): Promise<void> => {
    generator.cancel(taskType);
    if (taskType === 'biography') {
      biographyPreSend.cancel();
      await biographyController.cancelPending();
    } else if (taskType === 'genealogy') {
      genealogyController.cancelPending();
    } else if (taskType === 'ruin') {
      ruinController.cancelPending();
      await ruinTask.cancelPending();
    } else {
      activeReturnTurnController?.abort(new Error('generation was cancelled'));
      activeReturnTurnController = null;
      butterflyController.cancelPending();
    }
    emitTaskStatus(taskType, 'cancelled', `${taskLabel(taskType)}已停止`, {
      phase: 'cancelled',
      cancellable: false,
    });
  };
  const onCancelTask = (event: Event): void => {
    const detail = (event as CustomEvent<{ taskType?: GenerationTaskType }>).detail;
    if (!detail?.taskType) return;
    void cancelTask(detail.taskType).catch(error => {
      if (!isGenerationCancelledError(error)) {
        console.error('[Eyon History Workbench] task cancellation failed', error);
      }
    });
  };
  globalThis.addEventListener(WORKBENCH_CANCEL_TASK_EVENT, onCancelTask);
  const facade: EyonHistoryWorkbenchFacade = {
    version: '0.10.0-internal.140',
    resolveDisplayText: text => resolveWorkbenchDisplayText(text, globalObject),
    getSettings: () => settings.read(),
    updateSettings: patch => settings.update(patch),
    setGenerationSettings: (taskType, next) =>
      settings.setGeneration(taskType, next),
    applyGenerationSettingsToAll: next =>
      settings.applyGenerationToAll(next),
    setRuinDraft: input => settings.update({ ruinDraft: input }),
    listRetrievalShadowObservations: () => retrievalShadow.list(),
    listPromptDiagnostics,
    listCanonResolvedViews: listCanonResolvedViewDiagnostics,
    inspectCurrentArtifactCanonBindings: async () => {
      const namespace = scopeReader.getNamespace();
      const [biographyRecords, genealogyRecords, ruinRecords, butterflyRecords] =
        await Promise.all([
          biographies.list(namespace),
          genealogies.list(namespace),
          ruins.list(namespace),
          butterflies.list(namespace),
        ]);
      return inspectArtifactCanonBindings({
        biographies: biographyRecords,
        genealogies: genealogyRecords,
        ruins: ruinRecords,
        butterflies: butterflyRecords,
      });
    },
    inspectCurrentContinuityAnchors: async () => {
      const namespace = scopeReader.getNamespace();
      const [branch, records] = await Promise.all([
        canon.getBranch(namespace),
        biographies.list(namespace),
      ]);
      return inspectContinuityAnchors({
        records,
        branchId: branch.branchId,
        canonRevision: branch.headRevision,
      });
    },
    inspectContinuityCache: () => inspectP4DerivedCache(),
    clearContinuityCache: () => clearP4DerivedCache('facade'),
    inspectCurrentArtifactCanonAssessments: async requestId => {
      const namespace = scopeReader.getNamespace();
      const branch = await canon.getBranch(namespace);
      const view = latestArtifactCanonAssessmentTarget({
        branchId: branch.branchId,
        requestId,
      });
      if (!view) return null;
      const [biographyRecords, genealogyRecords, ruinRecords, butterflyRecords] =
        await Promise.all([
          biographies.list(namespace),
          genealogies.list(namespace),
          ruins.list(namespace),
          butterflies.list(namespace),
        ]);
      return inspectArtifactCanonAssessments({
        biographies: biographyRecords,
        genealogies: genealogyRecords,
        ruins: ruinRecords,
        butterflies: butterflyRecords,
        view,
        branch,
      });
    },
    inspectCurrentArtifactCanonConsumption: async () => {
      const namespace = scopeReader.getNamespace();
      const [branch, biographyRecords, genealogyRecords, ruinRecords, butterflyRecords] =
        await Promise.all([
          canon.getBranch(namespace),
          biographies.list(namespace),
          genealogies.list(namespace),
          ruins.list(namespace),
          butterflies.list(namespace),
        ]);
      return inspectArtifactCanonConsumption({
        biographies: biographyRecords,
        genealogies: genealogyRecords,
        ruins: ruinRecords,
        butterflies: butterflyRecords,
        branch,
      });
    },
    getRuinRuntimeSnapshot: () => host.getRuinRuntimeSnapshot(),
    listGenealogyCharacters: async () =>
      (await sources.getCharacterSources())
        .map(toGenealogyCharacterOption)
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    listCharacterWorldbookEntries: () =>
      sources.listCharacterWorldbookEntries(),
    setCharacterWorldbookEntryEnabled: async (entryKey, enabled) => {
      settings.setWorldbookEntryEnabled(
        scopeReader.getNamespace(),
        entryKey,
        enabled,
      );
      return sources.listCharacterWorldbookEntries();
    },
    setCharacterWorldbookEntriesEnabled: async (entryKeys, enabled) => {
      settings.setWorldbookEntriesEnabled(
        scopeReader.getNamespace(),
        entryKeys,
        enabled,
      );
      return sources.listCharacterWorldbookEntries();
    },
    generateRuin: async input => {
      const record = await ruinController.generateFromPanel(input);
      publishDataChanged({ views: ['ruin'], reason: 'ruin-generated' });
      return record;
    },
    generateGenealogy: async input => {
      const record = await genealogyController.generateFromPanel(input);
      // Selection storage is not a Canon cache. Keep choices so a rollback can restore them.
      publishRuinReferences(await sources.projectRuinCharacters(await ruinReferences.read(scopeReader.getNamespace())));
      publishDataChanged({
        views: ['genealogy', 'ruin'],
        reason: 'genealogy-generated',
      });
      return { ...record, localView: buildGenealogyLocalView(record, await canon.getBranch(scopeReader.getNamespace())) };
    },
    listGenealogies: async () => sources.getCurrentGenealogyRecords(),
    listRuinCharacterReferences: async () =>
      sources.projectRuinCharacters(await ruinReferences.read(scopeReader.getNamespace())),
    toggleGenealogyNodeRuinReference: async (genealogyRecordKey, nodeId) => {
      const namespace = scopeReader.getNamespace();
      const record = await genealogies.get(genealogyRecordKey);
      if (!record || namespaceKey(record.namespace) !== namespaceKey(namespace)) {
        throw new Error('Genealogy record does not belong to the current chat');
      }
      const node = record.result.nodes.find(item => item.id === nodeId);
      if (!node) throw new Error('Genealogy node was not found');
      const view = buildGenealogyLocalView(record, await canon.getBranch(namespace));
      const reference = genealogyNodeToRuinReference(record, node.id, view);
      const current = await ruinReferences.read(namespace);
      if (!reference) return sources.projectRuinCharacters(current);
      const referenceId = ruinCharacterReferenceIdentity(reference);
      const exists = current.some(item =>
        ruinCharacterReferenceIdentity(item) === referenceId);
      const next = exists
        ? current.filter(item =>
          ruinCharacterReferenceIdentity(item) !== referenceId)
        : [...current, reference];
      await ruinReferences.write(namespace, next);
      const saved = await sources.projectRuinCharacters(next);
      publishRuinReferences(saved);
      publishDataChanged({
        views: ['genealogy', 'ruin'],
        reason: 'ruin-references',
      });
      return saved;
    },
    removeRuinCharacterReference: async referenceId => {
      const namespace = scopeReader.getNamespace();
      const current = await ruinReferences.read(namespace);
      const next = current.filter(item =>
        ruinCharacterReferenceIdentity(item) !== referenceId);
      await ruinReferences.write(namespace, next);
      const saved = await sources.projectRuinCharacters(next);
      publishRuinReferences(saved);
      publishDataChanged({
        views: ['genealogy', 'ruin'],
        reason: 'ruin-references',
      });
      return saved;
    },
    fetchCustomApiModels: (apiurl, key) =>
      fetchCustomApiModels(globalObject, apiurl, key),
    listRuins: async () => ruins.list(scopeReader.getNamespace()),
    retryRuinCandidate: async (recordKey, candidateId) => {
      const record = await ruinController.retryCandidate(recordKey, candidateId);
      publishDataChanged({
        views: ['ruin'], reason: 'ruin-candidate-retried',
      });
      return record;
    },
    listBiographies: async () => biographies.list(scopeReader.getNamespace()),
    deleteBiography: async recordKey => {
      const namespace = scopeReader.getNamespace();
      const record = await biographies.get(recordKey);
      if (!record || namespaceKey(record.namespace) !== namespaceKey(namespace)) {
        return false;
      }
      const deleted = await biographies.delete(recordKey);
      if (!deleted) return false;
      const references = await ruinReferences.readBiographies(namespace);
      await ruinReferences.writeBiographies(
        namespace,
        references.filter(reference => reference.recordKey !== recordKey),
      );
      publishDataChanged({
        views: ['biography', 'ruin'],
        reason: 'biography-deleted',
      });
      return true;
    },
    listRuinBiographyReferences: () =>
      ruinReferences.readBiographies(scopeReader.getNamespace()),
    toggleBiographyRuinReference: async recordKey => {
      const namespace = scopeReader.getNamespace();
      const record = await biographies.get(recordKey);
      if (!record || namespaceKey(record.namespace) !== namespaceKey(namespace)) {
        throw new Error('Biography record does not belong to the current chat');
      }
      const current = await ruinReferences.readBiographies(namespace);
      const referenceId = `biography:${record.biographyId}`;
      const exists = current.some(reference => reference.referenceId === referenceId);
      const next = exists
        ? current.filter(reference => reference.referenceId !== referenceId)
        : [...current, {
          referenceId,
          recordKey: record.key,
          biographyId: record.biographyId,
          title: record.biography.target.name,
          span: record.biography.span.label ?? '',
          summary: record.biography.summary,
        }];
      const saved = await ruinReferences.writeBiographies(namespace, next);
      publishDataChanged({
        views: ['biography', 'ruin'],
        reason: 'biography-references',
      });
      return saved;
    },
    removeRuinBiographyReference: async referenceId => {
      const namespace = scopeReader.getNamespace();
      const current = await ruinReferences.readBiographies(namespace);
      const saved = await ruinReferences.writeBiographies(
        namespace,
        current.filter(reference => reference.referenceId !== referenceId),
      );
      publishDataChanged({
        views: ['biography', 'ruin'],
        reason: 'biography-references',
      });
      return saved;
    },
    listButterflies: async () => butterflies.list(scopeReader.getNamespace()),
    listButterflyPending: async () => butterflies.listPending(scopeReader.getNamespace()),
    deleteButterfly: async runId => {
      const namespace = scopeReader.getNamespace();
      const record = (await butterflies.list(namespace))
        .find(item => item.runId === runId);
      if (!record) return false;
      const branch = await canon.getBranch(namespace);
      const tombstone = createCanonMemoryTombstone({
        record,
        branch,
        now: Date.now(),
      }) ?? undefined;
      const deleted = await butterflies.deleteRun(namespace, runId, tombstone);
      if (!deleted) return false;
      publishDataChanged({ views: ['timeline', 'genealogy', 'ruin'], reason: 'butterfly-deleted' });
      refreshCanonMemory('butterfly-archive-deleted');
      return true;
    },
    // internal.87（§6 步 B）：清理旧版脚本自动挂载的蝴蝶镜像世界书绑定与镜像条目。
    retireButterflyMirrors: () => butterflyMirror.retireLegacyMirrors(),
    inspectCurrentCanon: async () => {
      const namespace = scopeReader.getNamespace();
      return inspectCanonBranch(namespace, await canon.getBranch(namespace));
    },
    inspectCurrentData: async () => {
      const namespace = scopeReader.getNamespace();
      return inspectWorkbenchData(
        namespace,
        await collectCurrentData(
          namespace,
          biographies,
          genealogies,
          ruins,
          butterflies,
          ruinReferences,
        ),
      );
    },
    exportCurrentData: async () => {
      const namespace = scopeReader.getNamespace();
      return createWorkbenchBackup(
        facade.version,
        namespace,
        settings.read(),
        await collectCurrentData(
          namespace,
          biographies,
          genealogies,
          ruins,
          butterflies,
          ruinReferences,
        ),
      );
    },
    clearGenerationCache: async () => {
      const namespace = scopeReader.getNamespace();
      const references = await ruinReferences.read(namespace);
      const biographyReferences = await ruinReferences.readBiographies(namespace);
      ruinController.cancelPending();
      genealogyController.cancelPending();
      butterflyController.cancelPending();
      settings.update({ ruinDraft: null });
      const butterflyPending = await butterflies.listPending(namespace);
      const [genealogiesCleared, ruinsCleared] = await Promise.all([
        genealogies.clear(namespace),
        ruins.clear(namespace),
        ...butterflyPending.map(item =>
          butterflies.deletePending(item.key).catch(() => false)
        ),
      ]);
      await ruinReferences.write(namespace, []);
      await ruinReferences.writeBiographies(namespace, []);
      publishRuinReferences([]);
      publishDataChanged({
        views: ['genealogy', 'ruin', 'settings', 'timeline'],
        reason: 'cache-cleared',
      });
      return {
        ruinDraftCleared: true,
        ruinReferencesCleared: references.length + biographyReferences.length,
        genealogiesCleared,
        ruinsCleared,
        // internal.81 v19：缓存清理一并清除蝴蝶待结算快照（失败/残留/未归档）。
        butterflyPendingCleared: butterflyPending.length,
      };
    },
    clearErrorLog: () => settings.clearErrorLog(),
    getRuinPresenceDiagnostics: () => listRuinPresenceDiagnostics(),
    enterRuin: async (recordKey, candidateId, nodeId) => {
      const composerText = readTavernComposerText(globalObject);
      if (composerText === null) {
        throw new Error('读取酒馆输入框失败，已中止进入特异点（输入框可能尚未加载）');
      }
      // 进入新墟境前隔离上一轮仍在后台运行的蝴蝶效应。
      // 否则旧请求晚返回时会重新点亮“遣返完成”提示或旧注入，
      // 让新墟境看起来像刚刚被遣返。
      generator.cancel('butterfly');
      await butterflyController.onRuinEntered();
      const submission = await ruinEntry.enter(
        recordKey,
        candidateId,
        nodeId,
        composerText,
      );
      // 发送成功后清空输入框:仅当内容仍等于已读文本(防覆盖用户中途新输入)
      clearTavernComposerText(composerText, globalObject);
      return submission;
    },
    getRuinTaskReview: () => ruinTask.readReview(),
    generateRuinTaskDraft: request => ruinTask.generateDraft(request),
    updateRuinTaskDraft: patch => ruinTask.updateDraft(patch),
    confirmRuinTaskDraft: async () => {
      const review = ruinTask.stageDraftForComposer();
      try {
        await writeTavernComposer(
          globalObject,
          `确认墟境任务：${review.task.title}`,
        );
        return review;
      } catch (error) {
        ruinTask.restoreStagedDraft();
        throw error;
      }
    },
    returnRuin: () => {
      const controller = new AbortController();
      activeReturnTurnController = controller;
      return userTurns.sendUserTurn('遣返', {
        signal: controller.signal,
        beforeCreate: expectedMessageId =>
          butterflyController.prepareBeforeUserTurn('遣返', expectedMessageId)
            .then(() => undefined),
        afterCreate: messageId =>
          butterflyController.confirmPreparedUserFloor('遣返', messageId),
      }).finally(() => {
        if (activeReturnTurnController === controller) {
          activeReturnTurnController = null;
        }
      });
    },
    retryButterfly: async runId => {
      const record = await butterflyController.retry(runId);
      publishDataChanged({ views: ['timeline', 'genealogy', 'ruin'], reason: 'butterfly-retried' });
      return record;
    },
    cancelTask,
    inspectCanonMemory: () => ({
      snapshot: canonMemory.snapshot(),
      failure: canonMemory.lastFailure(),
    }),
    refreshCanonMemory: async () => {
      const namespace = scopeReader.getNamespace();
      const [records, tombstones, biographyRecords, branch] = await Promise.all([
        butterflies.list(namespace),
        butterflies.listMemoryTombstones(namespace),
        biographies.list(namespace),
        canon.getBranch(namespace),
      ]);
      const memorySnapshot = await canonMemory.refresh({
        records,
        tombstones,
        biographies: biographyRecords,
        branch,
        trigger: 'manual',
        currentInput: readTavernComposerText(globalObject) ?? '',
        now: Date.now(),
      });
      publishDataChanged({ views: ['settings'], reason: 'canon-memory-refreshed' });
      return memorySnapshot;
    },
    dispose() {
      globalThis.removeEventListener(WORKBENCH_CANCEL_TASK_EVENT, onCancelTask);
      if (events.names.messageDeleted) {
        events.bridge.off?.(events.names.messageDeleted, onMessageDeleted);
      }
      if (events.names.generationAfterCommands) {
        events.bridge.off?.(events.names.generationAfterCommands, onCanonMemoryBeforeGeneration);
      }
      if (events.names.chatChanged) {
        events.bridge.off?.(events.names.chatChanged, onCanonMemoryChatChanged);
      }
      if (events.names.characterMessageRendered) {
        events.bridge.off?.(events.names.characterMessageRendered, onCanonMemoryRendered);
      }
      void canonMemory.clear('dispose', Date.now());
      clearP4DerivedCache('dispose');
      biographyPreSend.dispose();
      registration.dispose();
      timeKernel.dispose();
      disposeHostStatusToast();
      if (globalObject[WORKBENCH_GLOBAL] === facade) {
        delete globalObject[WORKBENCH_GLOBAL];
      }
    },
  };
  globalObject[WORKBENCH_GLOBAL] = facade;
  disposeCurrent = () => facade.dispose();
  globalThis.dispatchEvent(new CustomEvent(WORKBENCH_READY_EVENT, { detail: facade }));
  emitStatus('ready', '伊雍历史工作台已就绪', {
    taskType: 'system',
    phase: 'success',
  });
  // F-03（internal.83）：就绪清扫（Y 入口）——补掉「上次会话期间消息已消失但
  // 事件缺失/未处理」的跨会话孤儿残留。namespace 未就绪时内部跳过。
  runCanonOrphanReconcile();
}

async function fetchCustomApiModels(
  globalObject: Record<string, unknown>,
  apiurl: string,
  key: string,
): Promise<string[]> {
  const endpoint = normalizeCustomApiBaseUrl(apiurl);
  if (!endpoint) throw new Error('API 地址不能为空');
  const normalizedKey = requireCustomApiKey(key);
  const getModelList = resolveTavernHelperFunction<(
    customApi: { apiurl: string; key?: string },
  ) => Promise<string[]>>(globalObject, 'getModelList');
  if (getModelList) {
    const models = await getModelList({
      apiurl: endpoint,
      key: normalizedKey,
    });
    const values = models.map(value => value.trim()).filter(Boolean);
    if (!values.length) throw new Error('接口没有返回可用模型');
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
  }
  const sillyTavern = globalObject.SillyTavern as {
    getContext?: () => { getRequestHeaders?: () => Record<string, string> };
  } | undefined;
  const headers = sillyTavern?.getContext?.().getRequestHeaders?.() ?? {};
  const response = await fetch('/api/backends/chat-completions/status', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_completion_source: 'custom',
      reverse_proxy: endpoint,
      custom_url: endpoint,
      proxy_password: normalizedKey,
      custom_include_headers: customAuthorizationHeader(normalizedKey),
    }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw customApiAuthenticationError(endpoint, '模型列表');
    }
    throw new Error(`模型列表拉取失败（HTTP ${response.status}）`);
  }
  const payload = await response.json() as unknown;
  const payloadError = extractCustomModelListError(payload);
  if (payloadError) {
    if (isAuthenticationFailure(payloadError)) {
      throw customApiAuthenticationError(endpoint, '模型列表');
    }
    throw new Error(`模型列表拉取失败：${payloadError}`);
  }
  const values = extractModelValues(payload);
  if (!values.length) throw new Error('接口没有返回可用模型');
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function extractCustomModelListError(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const record = payload as Record<string, unknown>;
  if (record.error === true) return '接口返回错误';
  if (typeof record.error === 'string') return record.error;
  if (record.error && typeof record.error === 'object' && !Array.isArray(record.error)) {
    const message = (record.error as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

async function writeTavernComposer(
  globalObject: Record<string, unknown>,
  text: string,
): Promise<void> {
  const content = text.trim();
  if (!content) {
    throw new Error('拒绝向酒馆输入框写入空的进入节点契约');
  }
  const documents: Document[] = [];
  const windows: Window[] = [];
  const addDocument = (value: unknown): void => {
    if (
      value
      && typeof value === 'object'
      && 'querySelector' in value
      && typeof (value as Document).querySelector === 'function'
      && !documents.includes(value as Document)
    ) documents.push(value as Document);
  };
  const addWindow = (value: unknown): void => {
    if (!value || typeof value !== 'object' || windows.includes(value as Window)) return;
    try {
      const candidate = value as Window;
      addDocument(candidate.document);
      windows.push(candidate);
    } catch {
      // Cross-origin windows are intentionally ignored.
    }
  };

  const roots: unknown[] = [];
  try {
    roots.push(globalObject.top, globalThis.top, globalObject.parent, globalThis.parent);
  } catch {
    // Cross-origin parents are intentionally ignored.
  }
  roots.push(globalObject, globalThis, globalObject.document, globalThis.document);
  for (const root of roots) {
    addWindow(root);
    addDocument(root);
  }
  for (let index = 0; index < windows.length; index += 1) {
    try {
      for (const frame of Array.from(windows[index].document.querySelectorAll('iframe'))) {
        addWindow(frame.contentWindow);
      }
    } catch {
      // Cross-origin child frames are intentionally ignored.
    }
  }

  const composer = findBestTavernComposer(documents);
  if (!composer) {
    throw new Error('未找到可编辑的酒馆输入框，请确认当前聊天页面已经加载完成');
  }

  const valueComposer = composer as HTMLTextAreaElement | HTMLInputElement;
  const contentEditable = composer.isContentEditable;
  const currentValue = contentEditable
    ? composer.textContent ?? ''
    : 'value' in valueComposer ? valueComposer.value : '';
  const existing = currentValue.trimEnd();
  const next = existing ? `${existing}\n\n${content}` : content;
  const view = composer.ownerDocument.defaultView;
  setComposerValue(composer, next);
  dispatchComposerInput(composer);
  await new Promise(resolve => globalThis.setTimeout(resolve, 30));
  const written = contentEditable
    ? composer.textContent ?? ''
    : 'value' in valueComposer ? valueComposer.value : '';
  if (!written.includes(content)) {
    setComposerValue(composer, next);
    dispatchComposerInput(composer);
    await new Promise(resolve => globalThis.setTimeout(resolve, 30));
  }
  const verified = contentEditable
    ? composer.textContent ?? ''
    : 'value' in valueComposer ? valueComposer.value : '';
  if (!verified.includes(content)) {
    throw new Error('进入节点契约未能写入酒馆输入框，请确认当前聊天输入框可编辑');
  }
  const schedule = view?.requestAnimationFrame
    ? view.requestAnimationFrame.bind(view)
    : (callback: FrameRequestCallback) => globalThis.setTimeout(callback, 0);
  schedule(() => {
    composer.focus();
    if (!contentEditable && typeof valueComposer.setSelectionRange === 'function') {
      valueComposer.setSelectionRange(next.length, next.length);
    }
  });
}

function findBestTavernComposer(documents: Document[]): HTMLElement | null {
  const candidates = new Map<HTMLElement, number>();
  const selectors = [
    '#send_textarea',
    'textarea[data-testid="send-textarea"]',
    'textarea[aria-label*="发送"]',
    'textarea[placeholder*="发送"]',
    '[contenteditable="true"][role="textbox"][data-testid="send-textarea"]',
    '[contenteditable="true"][role="textbox"][aria-label*="发送"]',
    '[contenteditable="true"][role="textbox"][placeholder*="发送"]',
  ];
  documents.forEach((document, documentIndex) => {
    visitQueryableRoots(document, root => {
      for (const selector of selectors) {
        for (const element of Array.from(root.querySelectorAll<HTMLElement>(selector))) {
          const score = scoreTavernComposer(element, selector, documentIndex);
          if (score > (candidates.get(element) ?? Number.NEGATIVE_INFINITY)) {
            candidates.set(element, score);
          }
        }
      }
    });
  });
  return [...candidates.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function visitQueryableRoots(
  root: Document | ShadowRoot,
  visit: (root: Document | ShadowRoot) => void,
): void {
  visit(root);
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    if (element.shadowRoot) visitQueryableRoots(element.shadowRoot, visit);
  }
}

function scoreTavernComposer(
  element: HTMLElement,
  selector: string,
  documentIndex: number,
): number {
  if (!element.isConnected || element.closest('[data-eyon-history-overlay]')) {
    return Number.NEGATIVE_INFINITY;
  }
  const editable = element as HTMLTextAreaElement | HTMLInputElement;
  if (editable.disabled || editable.readOnly) return Number.NEGATIVE_INFINITY;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const visible = style?.display !== 'none'
    && style?.visibility !== 'hidden'
    && Number(style?.opacity ?? '1') > 0
    && rect.width > 0
    && rect.height > 0;
  let score = selector === '#send_textarea' ? 200 : 100;
  if (visible) score += 160;
  if (element === element.ownerDocument.activeElement) score += 30;
  score += Math.max(0, 30 - documentIndex * 4);
  return score;
}

function setComposerValue(composer: HTMLElement, value: string): void {
  if (composer.isContentEditable) {
    composer.textContent = value;
    return;
  }
  const view = composer.ownerDocument.defaultView;
  const valueComposer = composer as HTMLTextAreaElement | HTMLInputElement;
  const isTextarea = composer.tagName.toLowerCase() === 'textarea';
  const prototype = isTextarea
    ? view?.HTMLTextAreaElement?.prototype
    : view?.HTMLInputElement?.prototype;
  const setter = prototype
    ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    : undefined;
  if (setter) setter.call(composer, value);
  else valueComposer.value = value;
}

function dispatchComposerInput(composer: HTMLElement): void {
  const view = composer.ownerDocument.defaultView;
  const EventConstructor = view?.Event ?? globalThis.Event;
  // A plain input event is enough for Tavern's reactive composer. Dispatching
  // change, Enter, or a synthetic click can be interpreted as message submit.
  composer.dispatchEvent(new EventConstructor('input', { bubbles: true, composed: true }));
}

function extractModelValues(payload: unknown): string[] {
  if (Array.isArray(payload)) return payload.flatMap(modelId);
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  for (const key of ['data', 'models']) {
    if (Array.isArray(record[key])) return record[key].flatMap(modelId);
  }
  return [];
}

function modelId(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!value || typeof value !== 'object') return [];
  const id = (value as Record<string, unknown>).id;
  return typeof id === 'string' && id.trim() ? [id.trim()] : [];
}

async function collectCurrentData(
  namespace: ReturnType<TavernScopeReader['getNamespace']>,
  biographies: IndexedDbBiographyRepository,
  genealogies: IndexedDbGenealogyRepository,
  ruins: IndexedDbRuinCandidateRepository,
  butterflies: IndexedDbButterflyRepository,
  ruinReferences: IndexedDbRuinCharacterReferenceRepository,
): Promise<WorkbenchDataCollection> {
  const [
    biographyRecords,
    genealogyRecords,
    ruinRecords,
    butterflyRecords,
    pendingButterflies,
    canonMemoryTombstones,
    references,
  ] = await Promise.all([
    biographies.list(namespace),
    genealogies.list(namespace),
    ruins.list(namespace),
    butterflies.list(namespace),
    butterflies.listPending(namespace),
    butterflies.listMemoryTombstones(namespace),
    ruinReferences.read(namespace),
  ]);
  return {
    biographies: biographyRecords,
    genealogies: genealogyRecords,
    ruins: ruinRecords,
    butterflies: butterflyRecords,
    pendingButterflies,
    canonMemoryTombstones,
    ruinReferences: references,
  };
}


function toGenealogyCharacterOption(
  source: { sourceId: string; title: string; content: string },
): GenealogyCharacterOption {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(source.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // The character remains selectable even when an optional summary is malformed.
  }
  return {
    mvuId: source.sourceId.replace(/^mvu-character:/u, ''),
    name: source.title,
    aliases: stringList(data['别名']),
    age: scalarStringValue(data['年龄']),
    race: stringValue(data['种族']),
    identities: stringList(data['身份']),
    professions: stringList(data['职业']),
    lifeLevel: stringValue(data['生命层级']),
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string =>
      typeof item === 'string' && item.trim().length > 0);
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scalarStringValue(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return stringValue(value);
}

function latestVisibleUserMessageId(
  runtime: ReturnType<typeof createGlobalTavernRuntime>,
): number {
  const last = runtime.getLastMessageId();
  const messages = runtime.getChatMessages(`0-${last}`, {
    include_swipes: false,
  });
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.is_hidden) return message.message_id;
  }
  throw new Error('当前聊天没有可用的玩家楼');
}

function emitStatus(
  status: string,
  detail?: string,
  extra: Partial<WorkbenchStatusDetail> = {},
): void {
  globalThis.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, {
    detail: { status, detail: detail ?? '', ...extra },
  }));
}

function classifyStatusPhase(
  status: string,
): NonNullable<WorkbenchStatusDetail['phase']> {
  if (/failed|error/u.test(status)) return 'error';
  if (/cancelled/u.test(status)) return 'cancelled';
  if (/retry/u.test(status)) return 'retrying';
  if (/ready|committed/u.test(status)) return 'success';
  return 'running';
}

function taskLabel(taskType: GenerationTaskType): string {
  return {
    genealogy: '宗族谱系生成',
    ruin: '墟境生成',
    biography: '传记生成',
    butterfly: '蝴蝶效应结算',
  }[taskType];
}

function start(): void {
  void bootstrap().catch(error => {
    console.error('[Eyon History Workbench] bootstrap failed', error);
    emitStatus('failed', '历史工作台载入未完成，请查看控制台日志', {
      taskType: 'system',
      phase: 'error',
      technicalDetail: error instanceof Error ? error.message : String(error),
    });
  });
}

const globalRecord = globalThis as Record<string, unknown>;
const jquery = globalRecord.$;
if (typeof jquery === 'function') {
  (jquery as (ready: () => void) => void)(start);
} else {
  start();
}

globalThis.addEventListener('pagehide', () => {
  disposeCurrent?.();
  disposeCurrent = null;
}, { once: true });
