import type { GenerationSettings } from './settings.ts';
import type {
  GenerationTaskType,
  WorkbenchSettings,
} from './workbenchSettings.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type {
  RuinBiographyReference,
  RuinSelectedCharacter,
} from '../storage/ruinReferences.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import type { ButterflyRecord, PendingSettlement } from '../storage/butterflies.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { RuinCandidateRecord } from '../storage/ruins.ts';
import type { RuinEntrySubmission } from '../workflows/ruinEntry.ts';
import type {
  RuinTaskDraftRequest,
  RuinTaskEditPatch,
  RuinTaskReviewSnapshot,
} from '../workflows/ruinTask.ts';
import type { RuinRuntimeSnapshot } from '../adapters/host.ts';
import type { CharacterWorldbookEntryOption } from './tavernHost.ts';
import type {
  WorkbenchDataBackup,
  WorkbenchDataInspection,
} from './dataManagement.ts';
import type { RuntimeShadowObservation } from '../retrieval/runtimeShadow.ts';
import type { CanonBranchInspection } from './canonDiagnostics.ts';
import type { CanonMemorySnapshot } from './canonMemoryChannel.ts';

export const WORKBENCH_GLOBAL = 'EyonHistoryWorkbench';
export const WORKBENCH_STATUS_EVENT = 'eyon-history-workbench:status';
export const WORKBENCH_CANCEL_TASK_EVENT = 'eyon-history-workbench:cancel-task';
export const WORKBENCH_APPEARANCE_EVENT = 'eyon-history-workbench:appearance';
export const WORKBENCH_READY_EVENT = 'eyon-history-workbench:ready';
export const WORKBENCH_OPEN_EVENT = 'eyon-history-workbench:open';
export const WORKBENCH_RUIN_REFERENCES_EVENT =
  'eyon-history-workbench:ruin-references';
export const WORKBENCH_DATA_CHANGED_EVENT =
  'eyon-history-workbench:data-changed';

export type WorkbenchDataView =
  | 'timeline'
  | 'genealogy'
  | 'ruin'
  | 'biography'
  | 'settings';

export interface WorkbenchDataChangedDetail {
  views: WorkbenchDataView[];
  reason:
    | 'cache-cleared'
    | 'genealogy-generated'
    | 'ruin-generated'
    | 'ruin-candidate-retried'
    | 'ruin-task-requested'
    | 'ruin-references'
    | 'biography-generated'
    | 'biography-deleted'
    | 'biography-references'
    | 'butterfly-deleted'
    | 'butterfly-retried'
    | 'canon-memory-refreshed';
}

export interface WorkbenchStatusDetail {
  status: string;
  detail: string;
  taskType?: GenerationTaskType | 'system';
  phase?: 'running' | 'retrying' | 'recovered' | 'success' | 'error' | 'info' | 'cancelled';
  cancellable?: boolean;
  progress?: {
    current: number;
    total: number;
    /** 进行中任务的开始时间戳：宿主页据此自行计时，不依赖事件频率 */
    startedAt?: number;
  };
  retry?: {
    attempt: number;
    max: number;
  };
  technicalDetail?: string;
}

export interface WorkbenchAppearanceDetail {
  mode: 'dark' | 'light';
  accent: 'jade' | 'gold' | 'blue' | 'crimson';
  text: 'neutral' | 'warm' | 'cool';
}

export interface GenealogyCharacterOption {
  mvuId: string;
  name: string;
  aliases: string[];
  /** 仅用于界面在生年未定时显示现年，不会反推或写入 Canon 出生年。 */
  age?: string;
  race: string;
  identities: string[];
  professions: string[];
  lifeLevel: string;
}

export interface EyonHistoryWorkbenchFacade {
  version: string;
  /** 只展开工作台可见文本中的动态宿主宏；不修改存储或聊天正文。 */
  resolveDisplayText?(text: string): string;
  getSettings(): WorkbenchSettings;
  updateSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings;
  setGenerationSettings(
    taskType: GenerationTaskType,
    settings: GenerationSettings,
  ): WorkbenchSettings;
  applyGenerationSettingsToAll(
    settings: GenerationSettings,
  ): WorkbenchSettings;
  setRuinDraft(input: RuinGenerationInput | null): WorkbenchSettings;
  /** 最近的 Retrieval v1 旁路回执；只读、有界，不参与正式上下文。 */
  listRetrievalShadowObservations(): RuntimeShadowObservation[];
  /** 实际生成请求的字符数诊断；只读、有界，不保存 Prompt 或证据正文。 */
  listPromptDiagnostics(): import('./promptDiagnostics.ts').PromptDiagnostic[];
  /** P1 当前 Canon 投影诊断；只读、有界，不保存来源正文。 */
  listCanonResolvedViews(): import('./canonViewDiagnostics.ts').CanonResolvedViewDiagnostic[];
  /** P2-A 当前聊天产物绑定诊断；只读，不评估 stale/orphaned。 */
  inspectCurrentArtifactCanonBindings(): Promise<
    import('./artifactCanonDiagnostics.ts').ArtifactCanonBindingInspection
  >;
  /** P4-A 当前聊天的已存事实锚与同 revision 可用数量；只读，不触发生成。 */
  inspectCurrentContinuityAnchors?(): Promise<
    import('./continuityAnchors.ts').ContinuityAnchorInspection
  >;
  /** P4-D 派生视图内存缓存诊断；不含正文、世界书或完整 prompt。 */
  inspectContinuityCache?(): ReturnType<
    typeof import('../core/p4DerivedCache.ts').inspectP4DerivedCache
  >;
  /** 只清 P4 派生视图缓存；不删除传记、谱系、Canon 或事实锚。 */
  clearContinuityCache?(): void;
  /** P2-B 当前聊天局部状态只读诊断；无可比较视图时返回 null。 */
  inspectCurrentArtifactCanonAssessments(requestId?: string): Promise<
    import('./artifactCanonDiagnostics.ts').ArtifactCanonAssessmentInspection | null
  >;
  /** P2-C 当前 head 的变更、局部状态与消费结论；只读，不等待下一次生成。 */
  inspectCurrentArtifactCanonConsumption(): Promise<
    import('./artifactCanonDiagnostics.ts').ArtifactCanonConsumptionInspection
  >;
  getRuinRuntimeSnapshot(): Promise<RuinRuntimeSnapshot>;
  listGenealogyCharacters(): Promise<GenealogyCharacterOption[]>;
  listCharacterWorldbookEntries(): Promise<CharacterWorldbookEntryOption[]>;
  setCharacterWorldbookEntryEnabled(
    entryKey: string,
    enabled: boolean,
  ): Promise<CharacterWorldbookEntryOption[]>;
  setCharacterWorldbookEntriesEnabled(
    entryKeys: string[],
    enabled: boolean,
  ): Promise<CharacterWorldbookEntryOption[]>;
  generateGenealogy(input: GenealogyGenerationInput): Promise<GenealogyRecord>;
  listGenealogies(): Promise<GenealogyRecord[]>;
  listRuinCharacterReferences(): Promise<RuinSelectedCharacter[]>;
  toggleGenealogyNodeRuinReference(
    genealogyRecordKey: string,
    nodeId: string,
  ): Promise<RuinSelectedCharacter[]>;
  removeRuinCharacterReference(
    referenceId: string,
  ): Promise<RuinSelectedCharacter[]>;
  fetchCustomApiModels(apiurl: string, key: string): Promise<string[]>;
  generateRuin(input: RuinGenerationInput): Promise<RuinCandidateRecord>;
  listRuins(): Promise<RuinCandidateRecord[]>;
  retryRuinCandidate?(
    recordKey: string,
    candidateId: string,
  ): Promise<RuinCandidateRecord>;
  listBiographies(): Promise<BiographyRecord[]>;
  deleteBiography(recordKey: string): Promise<boolean>;
  listRuinBiographyReferences(): Promise<RuinBiographyReference[]>;
  toggleBiographyRuinReference(recordKey: string): Promise<RuinBiographyReference[]>;
  removeRuinBiographyReference(referenceId: string): Promise<RuinBiographyReference[]>;
  listButterflies(): Promise<ButterflyRecord[]>;
  /** 待结算快照（含失败原因）：时空页据此把「预结算成功但提交失败」的记录显示成可重试条目。 */
  listButterflyPending(): Promise<PendingSettlement[]>;
  /**
   * 删除可见本地档案，不回滚 Canon，也不改正文楼层；若干涉仍 active，
   * G-09 会保留不可浏览的紧凑因果摘要（不是档案备份）。
   */
  deleteButterfly(runId: string): Promise<boolean>;
  /**
   * internal.87（§6 步 B）：清理旧版脚本自动挂载的蝴蝶镜像世界书——
   * 摘掉全局绑定 + 删除脚本自建条目，不删除世界书文件本身。
   */
  retireButterflyMirrors(): Promise<import('../adapters/host.ts').MirrorRetirementResult>;
  /** 当前聊天 Canon 分支的只读一致性诊断；返回结构化副本，不修改仓库。 */
  inspectCurrentCanon(): Promise<CanonBranchInspection>;
  inspectCurrentData(): Promise<WorkbenchDataInspection>;
  exportCurrentData(): Promise<WorkbenchDataBackup>;
  clearGenerationCache(): Promise<{
    ruinDraftCleared: boolean;
    ruinReferencesCleared: number;
    genealogiesCleared: number;
    ruinsCleared: number;
    /** internal.81 v19：一并清除的蝴蝶待结算快照（失败/残留/未归档 pending；已归档记录不受影响）。 */
    butterflyPendingCleared: number;
  }>;
  clearErrorLog(): WorkbenchSettings;
  /** 人物时间锚诊断（工作台排查用）：最近墟境生成的时间范围与选中人物锚命中情况。 */
  getRuinPresenceDiagnostics(): import('./presenceDiagnostics.ts').RuinPresenceDiagnostic[];
  enterRuin(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<RuinEntrySubmission>;
  getRuinTaskReview(): Promise<RuinTaskReviewSnapshot | null>;
  generateRuinTaskDraft(request: RuinTaskDraftRequest): Promise<RuinTaskReviewSnapshot>;
  updateRuinTaskDraft(patch: RuinTaskEditPatch): RuinTaskReviewSnapshot;
  /** 只把确认标记写入酒馆输入框；玩家亲自发送后才创建并封缄任务楼。 */
  confirmRuinTaskDraft(): Promise<RuinTaskReviewSnapshot>;
  returnRuin(): Promise<unknown>;
  retryButterfly(runId: string): Promise<unknown>;
  cancelTask(taskType: GenerationTaskType): Promise<void>;
  /** internal.86：蝴蝶记忆注入通道的最近快照（诊断面板读取；null = 尚未计算）。 */
  inspectCanonMemory(): {
    snapshot: CanonMemorySnapshot | null;
    failure: string;
  };
  /** internal.86：手动重算并重新注入（诊断面板"重新计算"）。 */
  refreshCanonMemory(): Promise<CanonMemorySnapshot>;
  dispose(): void;
}
