export const SOURCE_SNAPSHOT_SCHEMA = 'eyon.retrieval.source-snapshot.v1' as const;
export const EVIDENCE_BUNDLE_SCHEMA = 'eyon.retrieval.evidence-bundle.v1' as const;
export const RETRIEVAL_RECEIPT_SCHEMA = 'eyon.retrieval.receipt.v1' as const;
export const EVIDENCE_PASSAGE_STRATEGY_VERSION = 'eyon.retrieval.passage.v2-full' as const;
export const WORLD_KNOWLEDGE_CORPUS_SCHEMA = 'eyon.retrieval.worldbook-corpus.v1' as const;
export const WORLD_KNOWLEDGE_CATALOG_SCHEMA = 'eyon.retrieval.world-knowledge-catalog.v1' as const;
export const RETRIEVAL_STRATEGY_V12 = 'v1.2-catalog-cast' as const;
export const COMPACT_KNOWLEDGE_DIRECTORY_SCHEMA = 'eyon.retrieval.compact-knowledge-directory.v1' as const;
export const SEMANTIC_EVIDENCE_SCHEMA = 'eyon.retrieval.semantic-evidence.v1' as const;
export const SEMANTIC_EVIDENCE_COMPILER_VERSION = 'p0-d-no-vector-v4' as const;
export const TASK_CITATION_REGISTRY_SCHEMA = 'eyon.retrieval.task-citation-registry.v2' as const;
export const CANON_RESOLVED_VIEW_SCHEMA = 'eyon.canon.resolved-view.v1' as const;
export const ARTIFACT_CANON_ASSESSMENT_SCHEMA = 'eyon.canon.artifact-assessment.v1' as const;
export const ARTIFACT_CANON_CONSUMPTION_SCHEMA = 'eyon.canon.artifact-consumption.v1' as const;

export type RetrievalTaskType = 'biography' | 'genealogy' | 'ruin' | 'butterfly';
export type RetrievalMode = 'shadow' | 'active';
export type WorldbookBindingScope =
  | 'character-primary'
  | 'character-additional'
  | 'chat'
  | 'global';

export type WorldbookCorpusEntryStatus =
  | 'retrievable'
  | 'disabled'
  | 'empty'
  | 'user-excluded'
  | 'routed-generated';

export interface WorldbookCorpusEntryReceipt {
  logicalId: string;
  sourceId: string;
  worldbookName: string;
  uid: number;
  title: string;
  bindingScopes: WorldbookBindingScope[];
  enabled: boolean;
  status: WorldbookCorpusEntryStatus;
}

export interface WorldbookCorpusReceipt {
  schema: typeof WORLD_KNOWLEDGE_CORPUS_SCHEMA;
  /** true 表示宿主逐 UID 枚举了全部当前绑定世界书，而非仅提供已召回来源。 */
  complete: boolean;
  bindings: Array<{ worldbookName: string; scopes: WorldbookBindingScope[] }>;
  entries: WorldbookCorpusEntryReceipt[];
  counts: Record<WorldbookCorpusEntryStatus | 'total' | 'enabled', number>;
}

export interface RuntimeWorldbookCorpus {
  sources: RuntimeWorldbookSource[];
  receipt: WorldbookCorpusReceipt;
}

export type KnowledgeEntityKind =
  | 'person' | 'place' | 'organization' | 'faction' | 'family' | 'collective'
  | 'event' | 'era' | 'species' | 'institution' | 'artifact' | 'concept' | 'unknown';

export interface KnowledgeSpan {
  snapshotId: string;
  startOffset: number;
  endOffset: number;
}

/**
 * 人物事件证据锚。数组顺序只用于稳定展示，绝不自动代表历史先后；
 * 只有 CanonEventRelation 或明确 temporalScope 才能约束 chronology。
 */
export interface OrderedLifeAnchor {
  /** 对应 CharacterCanonFacts 中的稳定事实 ID；旧数据可缺省。 */
  factId?: string;
  event: string;
  /** 相对当前时间的关系：before-current=当前之前已发生；at=当下状态；after=未来（罕见） */
  relation: 'before-current' | 'at' | 'after';
  /** 可选的锚点（地点/人物/时间描述） */
  anchor?: string;
  /** 当前证据能否为该事件提供时间定位；旧数据可缺省。 */
  chronology?: 'dated' | 'relative' | 'unresolved';
  epistemicStatus?: CanonFactEpistemicStatus;
  confidence?: CanonFactConfidence;
  sourceLabel: string;
  /** 原文精确位置；用于回溯而不是靠摘要猜测。 */
  sourceSpan?: KnowledgeSpan;
}

export type CanonFactEpistemicStatus =
  | 'explicit'
  | 'structural'
  | 'user-asserted'
  | 'reported'
  | 'contested'
  | 'inferred'
  | 'generated';

export type CanonFactConfidence = 'high' | 'medium' | 'low';

/**
 * P0 的最小原子事实。事实身份不依赖 passage 窗口，因此同一事实能在规划、扩写和回执中复用。
 */
export interface CanonFact {
  factId: string;
  subjectEntityId: string;
  predicate: string;
  object: string;
  statement: string;
  temporalScope: string | null;
  spatialScope: string | null;
  epistemicStatus: CanonFactEpistemicStatus;
  confidence: CanonFactConfidence;
  /** 可引用的逻辑来源 ID（worldbook/chat/产物 sourceId）。 */
  sourceRefs: string[];
  sourceSnapshotIds: string[];
  sourceSpans: KnowledgeSpan[];
  revisionIntroduced: number;
  revisionRetired: number | null;
  continuousState?: import('./continuousState.ts').ContinuousState;
}

/** 只表达有证据支持的事件关系；未列出的事件对保持未决。 */
export interface CanonEventRelation {
  relationId: string;
  fromFactId: string;
  toFactId: string;
  relation: 'before' | 'after' | 'requires';
  epistemicStatus: 'explicit' | 'structural' | 'user-asserted' | 'inferred';
  confidence: CanonFactConfidence;
  rationale: string;
  sourceFactIds: string[];
}

/** 一个人物在统一目录中的规范事实集合；不等同于某次任务的全部 prompt。 */
export interface CharacterCanonFacts {
  schema: 'eyon.retrieval.character-canon-facts.v1';
  entityId: string;
  canonicalName: string;
  identityFactIds: string[];
  relationFactIds: string[];
  lifeEventFactIds: string[];
  currentStateFactIds: string[];
  eventRelations: CanonEventRelation[];
  facts: CanonFact[];
}

/** 某次任务真正需要看见的人物事实投影。 */
export interface PersonCanonView {
  schema: 'eyon.retrieval.person-canon-view.v1';
  entityId: string;
  canonicalName: string;
  aliases: string[];
  requiredFactIds: string[];
  relevantFactIds: string[];
  eventRelations?: CanonEventRelation[];
  facts: CanonFact[];
  sourceSnapshotIds: string[];
  /** P1：由当前 revision 的 active birth/death facts 投影；缺省沿用 P0 人物时间线。 */
  lifespan?: KnowledgeEntity['lifespan'];
}

/**
 * 对人物整条目的可追踪附件。只从本次已建立索引的启用来源中挑选；contentHash 进入 sourceHash。
 */
export interface TaskAnchorAttachment {
  schema: 'eyon.retrieval.task-anchor-attachment.v1';
  attachmentId: string;
  entityId: string;
  canonicalName: string;
  sourceId: string;
  snapshotId: string;
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  content: string;
  contentHash: string;
  charCount: number;
  purpose: 'direct-character-entry' | 'cast-character-entry';
}

export interface CanonTimePoint {
  label: string;
  era?: string | null;
  year?: number | null;
}

export interface CanonTimeInterval {
  start?: CanonTimePoint | null;
  end?: CanonTimePoint | null;
}

export interface InterventionAction {
  schema: 'eyon.canon.intervention-action.v1';
  actionId: string;
  branchId: string;
  runId: string;
  userMessageId: number;
  assistantMessageId: number;
  rawCommand: string;
  actionRecord: string;
  sourceRefs: string[];
  occurredAt: CanonTimePoint;
  createdAt: number;
}

export interface InterventionDeltaOperation {
  op: 'assert' | 'retract' | 'replace';
  factKey: string;
  originalFactIds: string[];
  current: CanonFact;
}

/** P3-A：delta 内事实操作的稳定引用。沿用 P2 的 (deltaId, factKey) 身份。 */
export interface CanonOperationRef {
  deltaId: string;
  factKey: string;
}

/** P3-A：支撑关系只引用稳定身份，不复制事实正文。 */
export type CanonCausalRef =
  | { kind: 'fact'; factId: string }
  | { kind: 'operation'; operationRef: CanonOperationRef }
  | { kind: 'action'; actionId: string };

/**
 * P3-A：每项事实操作的因果来源。
 * direct 是本次干涉的直接结果；supported 由一个或多个支撑单元承接；
 * opaque 是兼容旧记录或无法安全归并的保守状态，不等于错误或失效。
 */
export type CanonOperationCausalBasis =
  | {
    basis: 'direct';
    operationRef: CanonOperationRef;
  }
  | {
    basis: 'supported';
    operationRef: CanonOperationRef;
    supportIds: string[];
  }
  | {
    basis: 'opaque';
    operationRef: CanonOperationRef;
    reason: string;
  };

/** P3-A：一条可审计、可插拔、但尚不参与自动裁决的因果支撑记录。 */
export interface CanonCausalSupportUnit {
  schema: 'eyon.canon.causal-support.v1';
  supportId: string;
  branchId: string;
  introducedRevision: number;
  introducedByDeltaId: string;
  inputRefs: CanonCausalRef[];
  outputRef: CanonCausalRef;
  claimText: string;
  sourceRefs: string[];
}

/** P3-C：一次有界协调留下的局部裁决。只允许作用于既有 operation。 */
export interface CanonCausalReconcileDecision {
  schema: 'eyon.canon.causal-reconcile-decision.v1';
  decisionId: string;
  branchId: string;
  introducedRevision: number;
  introducedByDeltaId: string;
  targetOperationRef: CanonOperationRef;
  decision: 'retire' | 'uncertain';
  reason: string;
  sourceRefs: string[];
}

/** P3-C：模型协调的有界、可审计回执。 */
export interface CanonCausalReconcileReceipt {
  schema: 'eyon.canon.causal-reconcile-receipt.v1';
  status: 'applied' | 'partial' | 'failed' | 'stale';
  modelCalls: 1;
  repairCalls: 0 | 1;
  consideredOperationRefs: CanonOperationRef[];
  acceptedProposalCount: number;
  droppedProposalCount: number;
  decisionIds: string[];
  supportIds: string[];
  warnings: string[];
  failureCode?: string;
}

export type InterventionDeltaStatus =
  | 'active'
  | 'partially-active'
  | 'superseded'
  | 'orphaned'
  | 'reverted';

/** P3-B：operation 的当前重基线状态。它由 branch 按需派生，不写回 operation 原稿。 */
export type CanonOperationRebaseState =
  | 'active'
  | 'superseded'
  | 'orphaned'
  | 'uncertain'
  | 'reverted';

/** P3-B：一次提交或回滚附带的确定性局部重基线回执。 */
export interface CanonCausalRebaseReceipt {
  schema: 'eyon.canon.causal-rebase-receipt.v1';
  status: 'no-conflict' | 'rebased' | 'bounded-overflow';
  modelCalls: 0;
  changedOperations: Array<{
    operationRef: CanonOperationRef;
    previousState?: CanonOperationRebaseState;
    currentState: CanonOperationRebaseState;
    reasonCodes: string[];
  }>;
  brokenSupportIds: string[];
  survivingSupportIds: string[];
  uncertainOperationRefs: CanonOperationRef[];
  restoredOperationRefs: CanonOperationRef[];
  warnings: string[];
}

export interface InterventionDelta {
  schema: 'eyon.canon.intervention-delta.v1';
  deltaId: string;
  branchId: string;
  revision: number;
  parentRevision: number;
  actionRef: string;
  effectiveFrom: CanonTimePoint;
  operations: InterventionDeltaOperation[];
  /** P3-A 可选附加信息；旧 delta 缺省时按 opaque 读取，绝不阻断。 */
  causalBasis?: CanonOperationCausalBasis[];
  /** P3-A 可选附加信息；仅记录支撑，不改变当前 CanonResolvedView。 */
  causalSupportUnits?: CanonCausalSupportUnit[];
  /** P3-C 可选附加信息；随引入它的 delta 回滚，不覆盖旧 operation 原稿。 */
  causalReconcileDecisions?: CanonCausalReconcileDecision[];
  preconditionFactIds: string[];
  dependsOnDeltaIds: string[];
  cascadeScope: {
    entityIds: string[];
    time?: CanonTimeInterval;
    locations: string[];
    /**
     * F-02（internal.82 覆盖）：载体归一化名（蝴蝶结算 causalStages.carrier）。
     * generated 叙事实体按名称/地点/时间投递；旧 delta 缺省退化为仅地点/时间判定。
     */
    subjectNames?: string[];
  };
  preserves: string[];
  supersedesDeltaIds: string[];
  status: InterventionDeltaStatus;
  verified: boolean;
  createdAt: number;
}

export interface CanonResolutionReceipt {
  schema: 'eyon.canon.resolution-receipt.v1';
  receiptId: string;
  branchId: string;
  parentRevision: number;
  canonRevision: number;
  appliedDeltaIds: string[];
  skippedDeltaIds: string[];
  supersededDeltaIds: string[];
  orphanedDeltaIds: string[];
  revertedDeltaIds: string[];
  preserves: string[];
  affectedArtifactSegmentIds: string[];
  resolutionMode: 'deterministic' | 'safe-with-uncertainty';
  uncertainItems: string[];
  sourceRefs: string[];
  durationMs: number;
  createdAt: number;
  /** P3-B 可选附录；旧 receipt 缺省时继续兼容。 */
  causalRebase?: CanonCausalRebaseReceipt;
  /** P3-C 可选附录；确定性路径缺省，代表严格零模型调用。 */
  causalReconcile?: CanonCausalReconcileReceipt;
}

export interface CanonRevisionRecord {
  revision: number;
  parentRevision: number;
  actionId: string;
  deltaId: string;
  assistantMessageId: number;
  status: 'active' | 'reverted' | 'orphaned';
  receiptId: string;
  createdAt: number;
  revertedAt?: number;
}

/** 当前聊天的 append-only 历史分支。revision 0 是不可变世界书基线。 */
export interface CanonBranch {
  schema: 'eyon.canon.branch.v1';
  branchId: string;
  characterKey: string;
  chatId: string;
  headRevision: number;
  revisions: CanonRevisionRecord[];
  actions: InterventionAction[];
  deltas: InterventionDelta[];
  receipts: CanonResolutionReceipt[];
  createdAt: number;
  updatedAt: number;
}

/** P1-1 查询范围只缩小投影，不创造事实或改变 delta 优先级。 */
export interface CanonQueryScope {
  subjectEntityIds: string[];
  temporalScopes: string[];
  spatialScopes: string[];
  sourceIds: string[];
  /**
   * F-02（internal.82 覆盖）：查询侧实体名集合（人物 canonicalName/别名等）。
   * 供 generated 叙事实体干涉按「名称命中」投递；旧调用方缺省即退化为实体精确匹配。
   */
  names?: string[];
}

/** 运行时把不可变 revision 0 材料附着到分支；不写回 CanonBranch 存储。 */
export interface CanonBaseView {
  facts: CanonFact[];
  eventRelations: CanonEventRelation[];
  personViews: PersonCanonView[];
  passages: EvidencePassage[];
  sourceSnapshots: SourceSnapshot[];
}

export interface CanonResolutionBranch extends CanonBranch {
  baseCanon: CanonBaseView;
}

export interface CanonInactiveFact {
  fact: CanonFact;
  retiredByDeltaId: string;
  reason: string;
}

export interface CanonPassageView {
  passageId: string;
  snapshotId: string;
  sourceId: string;
  status: 'active' | 'partial' | 'fact-capsule' | 'inactive';
  content: string;
  activeFactIds: string[];
  inactiveFactIds: string[];
  reason: string;
}

export interface CanonResolveReceipt {
  schema: 'eyon.canon.resolve-receipt.v1';
  branchId: string;
  requestedRevision: number;
  resolvedRevision: number;
  queryScopeHash: string;
  appliedDeltaIds: string[];
  skippedDeltaIds: string[];
  supersededDeltaIds: string[];
  uncertainItems: string[];
}

/** 四模块普通生成唯一允许消费的当前 Canon 视图。 */
export interface CanonResolvedView {
  schema: typeof CANON_RESOLVED_VIEW_SCHEMA;
  viewId: string;
  branchId: string;
  requestedRevision: number;
  resolvedRevision: number;
  queryScopeHash: string;
  activeFacts: CanonFact[];
  continuousStates?: import('./continuousState.ts').ContinuousStateInterval[];
  inactiveFacts: CanonInactiveFact[];
  uncertainItems: string[];
  eventRelations: CanonEventRelation[];
  personViews: PersonCanonView[];
  passageViews: CanonPassageView[];
  resolutionReceipt: CanonResolveReceipt;
  /**
   * F-02 v5（internal.82 覆盖）：本次命中的玩家干涉行动摘要（人类可读断言）。
   * fact 卡只携带各阶段陈述（可能不点名对象生死）；行动记录（actionRecord）
   * 才写「谁在何时何地做了什么」。注入视图供模型把同窗口叙事建立在完整事实上。
   * 旧视图缺省 = 空数组，渲染侧兼容。
   */
  interventionSummaries?: Array<{
    revision: number;
    record: string;
    time?: string;
    locations: string[];
  }>;
}

/** P2-A：生成产物的一个最小单元实际消费了哪一个 Canon 视图与哪些依赖。 */
export interface ArtifactCanonBinding {
  schema: 'eyon.canon.artifact-binding.v1';
  bindingId: string;
  branchId: string;
  artifactType: 'biography' | 'genealogy' | 'ruin' | 'butterfly';
  artifactId: string;
  unitType: string;
  unitId: string;
  boundView: {
    viewId: string;
    resolvedRevision: number;
    queryScopeHash: string;
  };
  entityIds: string[];
  factIds: string[];
  operationRefs: Array<{
    deltaId: string;
    factKey: string;
  }>;
  sourceRefs: string[];
  createdAt: number;
}

/** P2-B：由不可变 binding 与明确目标视图按需派生的局部有效性判断。 */
export interface ArtifactCanonAssessment {
  schema: typeof ARTIFACT_CANON_ASSESSMENT_SCHEMA;
  assessmentId: string;
  bindingId?: string;
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  unitType: string;
  unitId: string;
  comparedView: {
    branchId: string;
    viewId: string;
    resolvedRevision: number;
  };
  eligibility: 'assessable' | 'unbound' | 'binding-missing';
  status?: 'current' | 'partially-stale' | 'stale' | 'orphaned' | 'uncertain';
  activeFactIds: string[];
  inactiveFactIds: string[];
  unresolvedFactIds: string[];
  activeOperationRefs: ArtifactCanonBinding['operationRefs'];
  inactiveOperationRefs: ArtifactCanonBinding['operationRefs'];
  reasons: Array<{
    code: string;
    factId?: string;
    deltaId?: string;
    factKey?: string;
  }>;
}

/**
 * P2-C：消费者对一个局部 assessment 的只读处理结论。
 * 只有明确 stale/orphaned 才阻止自动复用；不确定与旧产物永不被脚本擅自判废。
 */
export interface ArtifactCanonConsumptionDecision {
  schema: typeof ARTIFACT_CANON_CONSUMPTION_SCHEMA;
  assessmentId: string;
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  unitType: string;
  unitId: string;
  eligibility: ArtifactCanonAssessment['eligibility'];
  status?: ArtifactCanonAssessment['status'];
  disposition: 'available' | 'available-with-warning' | 'excluded' | 'manual-review';
  excludesAutomaticReuse: boolean;
  reasonCodes: string[];
}

/** 蝴蝶效应冻结阶段只需携带视图身份，不复制 Canon passage 或 prompt 正文。 */
export type ArtifactCanonBoundView = ArtifactCanonBinding['boundView'] & {
  branchId: string;
};

export interface KnowledgeEntity {
  entityId: string;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  kinds: KnowledgeEntityKind[];
  tags: string[];
  temporalScopes: string[];
  locationScopes: string[];
  identities: string[];
  sourceSnapshotIds: string[];
  spans: KnowledgeSpan[];
  /** 有序事件链锚（人物卡既定事件；提取不到则为空）。 */
  lifeAnchors?: OrderedLifeAnchor[];
  /** P0-A：从来源原文提取、带稳定 ID 与精确 span 的人物规范事实。 */
  characterFacts?: CharacterCanonFacts;
  /**
   * 人物时间资格（人物时间锚的机器可读事实）。
   * born/died 支持显式生卒年与「年龄 + 基准时间」换算两种来源；
   * ageBased 表示来自年龄换算（基准见 basedOnEra/Year），谱系硬门只用显式生卒。
   */
  lifespan?: {
    originKind?: 'birth' | 'arrival' | 'activation' | 'incarnation';
    identityTracks?: import('../schemas/genealogy.ts').GenealogyNode['identity'];
    born?: { era: string; year: number } | null;
    died?: { era: string; year: number } | null;
    /** 年龄换算来源：当前记录年龄（基准 = basedOn*） */
    ageAtRecord?: number;
    /** 年龄换算基准纪元/年（来自开局锁定的 baselineWorldTime） */
    basedOnEra?: string;
    basedOnYear?: number;
    /** true = 界外来客/来自异界/穿越（年龄是抵达本世界后的累计，不是生理出生） */
    arrivalBased?: boolean;
    /** true = 出生年来自年龄推算而非显式生卒（inferred） */
    ageBased?: boolean;
  };
}

export type KnowledgeRelationStatus = 'explicit' | 'structural';

export interface KnowledgeRelation {
  relationId: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  status: KnowledgeRelationStatus;
  sourceSnapshotIds: string[];
  spans: KnowledgeSpan[];
}

export interface KnowledgeCatalogCoverage {
  snapshotId: string;
  status: 'indexed' | 'partial' | 'opaque';
  entityIds: string[];
  fullTextIndexed: true;
  reason: string;
}

/** Temporal v2：事件类型。created/formed 为「此后才存在」，renamed/reformed/destroyed/dissolved 为生命周期事件。 */
export type TemporalEventType =
  | 'created'
  | 'formed'
  | 'renamed'
  | 'reformed'
  | 'destroyed'
  | 'dissolved'
  | 'active-range'
  | 'unknown';

/** Temporal v2：事实置信度。只有 high + explicit 可以触发 fatal。 */
export type TemporalConfidence = 'high' | 'medium' | 'low';

/** Temporal v2：事实认识状态。 */
export type TemporalFactStatus = 'explicit' | 'structural' | 'inferred' | 'conflicted';

export interface TemporalEligibilityRule {
  ruleId: string;
  subject: string;
  scope: 'entity' | 'institution';
  availableFromEra: string;
  affectedEntityIds: string[];
  affectedEntityNames: string[];
  sourceSnapshotId: string;
  evidence: string;
  span: KnowledgeSpan;
  /** Temporal v2：事件类型；缺省视为 created（向后兼容）。 */
  eventType?: TemporalEventType;
  /** Temporal v2：置信度；缺省视为 high（向后兼容旧账本）。 */
  confidence?: TemporalConfidence;
  /** Temporal v2：认识状态；缺省视为 explicit（向后兼容旧账本）。 */
  status?: TemporalFactStatus;
  /** Temporal v2：是否来自权威年表（单一纪元顺序来源）。 */
  isAuthoritative?: boolean;
}

export interface TemporalEligibilityLedger {
  schema: 'eyon.retrieval.temporal-eligibility.v1';
  eraOrder: string[];
  rules: TemporalEligibilityRule[];
  /** Temporal v2：权威年表来源 snapshotId 列表（纪元顺序的唯一权威来源）。 */
  authoritativeSourceSnapshotIds?: string[];
}

export interface WorldKnowledgeCatalog {
  schema: typeof WORLD_KNOWLEDGE_CATALOG_SCHEMA;
  entities: KnowledgeEntity[];
  relations: KnowledgeRelation[];
  adjacency: Record<string, string[]>;
  reverseAdjacency: Record<string, string[]>;
  coverage: KnowledgeCatalogCoverage[];
  temporalEligibility: TemporalEligibilityLedger;
  buildDurationMs: number;
}

export interface EventFrame {
  schema: 'eyon.retrieval.event-frame.v1';
  action: string;
  directEntityIds: string[];
  temporalTerms: string[];
  locationEntityIds: string[];
  collectiveTargets: Array<{
    phrase: string;
    selector: 'deity' | 'organization-members' | 'family-members' | 'named-collective';
    entityId: string | null;
    exhaustive: boolean;
  }>;
}

export type CastDisposition =
  | 'required' | 'group-required' | 'recommended' | 'optional' | 'excluded';

export interface CastIdentityCapsule {
  canonicalName: string;
  aliases: string[];
  kinds: KnowledgeEntityKind[];
  identities: string[];
  /** 由目录中的 member_of / belongs_to / part_of 关系得出的已知归属。 */
  affiliations?: string[];
  temporalScopes: string[];
  locationScopes: string[];
  sourceSnapshotIds: string[];
  passageIds: string[];
}

export interface CastManifestEntry {
  entityId: string;
  disposition: CastDisposition;
  role: 'actor' | 'target' | 'participant' | 'context';
  reasons: string[];
  identity: CastIdentityCapsule;
}

export interface CastManifest {
  schema: 'eyon.retrieval.cast-manifest.v1';
  entries: CastManifestEntry[];
  groupCoverage: Array<{
    phrase: string;
    exhaustive: boolean;
    candidateEntityIds: string[];
    selectedEntityIds: string[];
    omittedEntityIds: string[];
    complete: boolean;
  }>;
}

export interface WorldbookRetrievalMetadata {
  schema: 'eyon.retrieval.worldbook-metadata.v1';
  logicalId: string;
  worldbookName: string;
  uid: number;
  bindingScopes: WorldbookBindingScope[];
  enabled: boolean;
  strategy: {
    type: 'constant' | 'selective' | 'vectorized';
    primaryKeys: string[];
    secondary: {
      logic: 'and_any' | 'and_all' | 'not_all' | 'not_any';
      keys: string[];
    };
    scanDepth: 'same_as_global' | number;
  };
  position: {
    type: string;
    role: 'system' | 'assistant' | 'user';
    depth: number;
    order: number;
  } | null;
  probability: number | null;
  recursion: {
    preventIncoming: boolean;
    preventOutgoing: boolean;
    delayUntil: number | null;
  } | null;
  effect: {
    sticky: number | null;
    cooldown: number | null;
    delay: number | null;
  } | null;
  extra: Record<string, unknown>;
}

/**
 * 旧 context assembler 仍消费顶层 strategyType/keywords；worldbook 是
 * Retrieval v1 的完整旁路真源，BP01 不改变旧字段语义。
 */
export interface RuntimeWorldbookSource {
  sourceId: string;
  title: string;
  content: string;
  strategyType: 'constant' | 'selective';
  keywords: string[];
  worldbook: WorldbookRetrievalMetadata;
}

export interface SourceSnapshot<TMetadata = unknown> {
  schema: typeof SOURCE_SNAPSHOT_SCHEMA;
  logicalId: string;
  snapshotId: string;
  versionHash: string;
  sourceType: 'worldbook' | 'chat' | 'mvu' | 'genealogy' | 'biography' | 'butterfly';
  title: string;
  content: string;
  /** 同一来源类型在宿主返回列表中的零基位置；参与稳定排序与版本身份。 */
  sourceOrder?: number;
  metadata: TMetadata;
}

export type EvidenceEpistemicStatus = 'explicit' | 'inferred' | 'conflicted';

export type EvidenceAuthorityDimension =
  | 'setting'
  | 'current-state'
  | 'identity'
  | 'relationship'
  | 'chronology'
  | 'causality';

export interface EvidenceAuthorityAssessment {
  dimension: EvidenceAuthorityDimension;
  tier: 'primary' | 'supporting' | 'contextual';
}

export interface EvidenceClaim {
  claimId: string;
  subject: string;
  predicate: string;
  object: string;
  temporalScope: string | null;
  epistemicStatus: EvidenceEpistemicStatus;
  authority: EvidenceAuthorityAssessment[];
  sourceSnapshotIds: string[];
  sourcePassageIds: string[];
  conflictGroupId: string | null;
}

export type EvidencePassageExtractionMode = 'full' | 'section' | 'window';

export interface EvidencePassage {
  passageId: string;
  snapshotId: string;
  sourceId: string;
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  sectionPath: string[];
  startOffset: number;
  endOffset: number;
  extractionMode: EvidencePassageExtractionMode;
  content: string;
  contentHash: string;
  charCount: number;
  matchedAnchors: string[];
  temporalScopes: string[];
  selectionReasons: string[];
}

/**
 * 模型只看任务内短句柄；内部稳定主键只在脚本侧解析与存储。
 * 这层属于 EvidenceBundle，四模块共用，不能由单个 prompt 私自另建映射。
 */
export interface TaskCitationRegistry {
  schema: typeof TASK_CITATION_REGISTRY_SCHEMA;
  passages: Array<{
    handle: `P${number}`;
    passageId: string;
  }>;
  facts: Array<{
    handle: `F${number}`;
    factId: string;
  }>;
  /** 世界书/历史产物中的任务级事件；与人物 CanonFact 分栏。 */
  events: Array<{
    handle: `E${number}`;
    eventId: string;
    label: string;
    passageIds: string[];
  }>;
  sources: Array<{
    handle: `S${number}`;
    sourceId: string;
    snapshotIds: string[];
  }>;
}

export interface CompactKnowledgeDirectoryEntry {
  snapshotId: string;
  logicalId: string;
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  coverage: KnowledgeCatalogCoverage['status'];
  entityHints: Array<{
    entityId: string;
    name: string;
    kinds: KnowledgeEntityKind[];
  }>;
  headings: string[];
  preview: string;
  detailLevel: 'candidate' | 'catalog-only';
}

export interface CompactKnowledgeDirectory {
  schema: typeof COMPACT_KNOWLEDGE_DIRECTORY_SCHEMA;
  entries: CompactKnowledgeDirectoryEntry[];
  charCount: number;
  detailedEntryCount: number;
}

export type SemanticEvidenceStatus =
  | 'explicit' | 'structural' | 'reported' | 'contested' | 'inferred' | 'unknown';
export type SemanticEvidenceConfidence = 'high' | 'medium' | 'low';

export interface SemanticPassageBinding {
  passageId: string;
  relevance: 'primary' | 'supporting' | 'contextual' | 'rejected';
  entities: Array<{
    entityId: string;
    name: string;
    kind: KnowledgeEntityKind;
    status: SemanticEvidenceStatus;
    confidence: SemanticEvidenceConfidence;
    rationale: string;
  }>;
  spatialScopes: string[];
  temporalScopes: string[];
  eventKeys: string[];
  rationale: string;
}

export interface SemanticEvidenceView {
  schema: typeof SEMANTIC_EVIDENCE_SCHEMA;
  requestId: string;
  taskType: RetrievalTaskType;
  compilerVersion: typeof SEMANTIC_EVIDENCE_COMPILER_VERSION;
  queryPlan: {
    questions: string[];
    hypotheses: string[];
    prioritizedSnapshotIds: string[];
  };
  passages: SemanticPassageBinding[];
  relations: Array<{
    subjectEntityId: string;
    predicate: string;
    objectEntityId: string;
    passageIds: string[];
    status: SemanticEvidenceStatus;
    confidence: SemanticEvidenceConfidence;
    rationale: string;
  }>;
  events: Array<{
    eventKey: string;
    label: string;
    passageIds: string[];
    status: SemanticEvidenceStatus;
    confidence: SemanticEvidenceConfidence;
    rationale: string;
  }>;
  alternatives: Array<{
    label: string;
    passageIds: string[];
    rationale: string;
  }>;
  unresolved: string[];
}

export interface SemanticEvidenceExpansionRequest {
  snapshotIds: string[];
  anchors: string[];
  reason: string;
}

export interface SemanticEvidenceReceipt {
  schema: typeof SEMANTIC_EVIDENCE_SCHEMA;
  compilerVersion: typeof SEMANTIC_EVIDENCE_COMPILER_VERSION;
  mode: 'model' | 'local-fallback';
  callCount: number;
  cacheHits: number;
  expansionUsed: boolean;
  /** 编译器只组织与解释证据，不拥有从最终上下文删除 passage 的权力。 */
  compilerRole?: 'advisory';
  /** 首次编译提出缺口后，由脚本本地补入且未再次编译的 passage 数量。 */
  localExpansionPassageCount?: number;
  directoryEntryCount: number;
  candidatePassageCount: number;
  selectedPassageCount: number;
  rejectedBindingCount: number;
  warnings: string[];
}

/**
 * Qualified Evidence v1：证据是否相关，与证据能否充当本轮舞台/在场事实是两件事。
 * 这层只声明使用资格，不裁决唯一剧情，也不把不确定项升级为致命错误。
 */
export type EvidenceCreativeZone = 'locked' | 'guided' | 'open';
export type EvidenceTemporalFit = 'contemporary' | 'antecedent' | 'aftermath' | 'external' | 'unknown';
export type EvidenceGeographicFit = 'stage' | 'inside-scope' | 'external' | 'unknown';
export type EvidenceEventPhase = 'precondition' | 'contemporary' | 'aftermath' | 'reference' | 'unknown';
export type EvidenceRevisionFit = 'baseline' | 'current' | 'unresolved' | 'conflicted';
export type EvidenceNarrativeUse =
  | 'stage'
  | 'actor'
  | 'cause'
  | 'background'
  | 'aftermath'
  | 'reference';

export interface QualifiedEvidencePassage {
  passageId: string;
  sourceId: string;
  sourceType: EvidencePassage['sourceType'];
  /** locked 只锁定来源中的明确陈述；未写明的连接仍属于 OPEN 创作区。 */
  zone: EvidenceCreativeZone;
  temporal: {
    fit: EvidenceTemporalFit;
    requestedEras: string[];
    evidenceEras: string[];
  };
  geographic: {
    fit: EvidenceGeographicFit;
    requestedLocations: string[];
    evidenceLocations: string[];
  };
  eventPhase: EvidenceEventPhase;
  revision: {
    fit: EvidenceRevisionFit;
    reason: string;
  };
  entityRoles: Array<{
    entityId: string;
    name: string;
    role: 'direct' | 'actor' | 'target' | 'participant' | 'context';
    disposition?: CastDisposition;
  }>;
  allowedUses: EvidenceNarrativeUse[];
  forbiddenUses: string[];
  reasons: string[];
}

export interface QualifiedEvidenceView {
  schema: 'eyon.retrieval.qualified-evidence.v1';
  taskType: RetrievalTaskType;
  requestedScope: {
    eras: string[];
    locations: string[];
  };
  passages: QualifiedEvidencePassage[];
  creativePolicy: {
    locked: string;
    guided: string;
    open: string;
  };
}

export interface EvidencePassageBudget {
  strategyVersion: typeof EVIDENCE_PASSAGE_STRATEGY_VERSION;
  /** 旧回执兼容字段：v2-full 不再用字符数截断、分窗或排除已选来源。 */
  softLimitChars: number;
  hardLimitChars: number;
  fullSourceLimitChars: number;
  maxWindowChars: number;
}

export interface RetrievalPassageDecision {
  snapshotId: string;
  startOffset: number;
  endOffset: number;
  passageId?: string;
  contentHash?: string;
  sectionPath?: string[];
  extractionMode?: EvidencePassageExtractionMode;
  matchedAnchors?: string[];
  temporalScopes?: string[];
  reason: string;
  charCount: number;
  score?: number;
}

export interface RetrievalDecision {
  snapshotId: string;
  reason: string;
  score?: number;
}

export interface RetrievalReceipt {
  schema: typeof RETRIEVAL_RECEIPT_SCHEMA;
  requestId: string;
  mode: RetrievalMode;
  taskType: RetrievalTaskType;
  profileId: string;
  strategyVersion?: typeof RETRIEVAL_STRATEGY_V12;
  queryHash: string;
  candidateSnapshotIds: string[];
  selected: RetrievalDecision[];
  rejected: RetrievalDecision[];
  passageBudget: EvidencePassageBudget & { usedChars: number };
  selectedPassages: RetrievalPassageDecision[];
  rejectedPassages: RetrievalPassageDecision[];
  /** R-04：可恢复的预算省略与分级警告，不再用错误字符串表达。 */
  warnings: string[];
  /** R-04：desired（P1/P2/recommended）覆盖锚中因预算被省略的锚名。 */
  omittedAnchors: string[];
  passageDurationMs: number;
  fallback: 'none' | 'explicit-legacy';
  durationMs: number;
  catalog?: {
    schema: typeof WORLD_KNOWLEDGE_CATALOG_SCHEMA;
    catalogHash: string;
    entityCount: number;
    relationCount: number;
    temporalRuleCount?: number;
    coverage: Record<'indexed' | 'partial' | 'opaque' | 'total', number>;
  };
  cast?: {
    entryCount: number;
    dispositions: Record<CastDisposition, number>;
    groupsComplete: boolean;
  };
  personCanon?: {
    viewCount: number;
    requiredFactIds: string[];
    attachments: Array<{
      attachmentId: string;
      snapshotId: string;
      contentHash: string;
      charCount: number;
    }>;
  };
  qualification?: {
    schema: QualifiedEvidenceView['schema'];
    passageCount: number;
    stageEligiblePassageIds: string[];
    externalPassageIds: string[];
    /**
     * 只读资格判定明细。这里故意不保存 EvidencePassage.content，只暴露
     * 范围、角色、允许用途与禁用用途，方便真实酒馆测试时判断“为何可用”。
     */
    details: QualifiedEvidencePassage[];
  };
  semanticEvidence?: SemanticEvidenceReceipt;
  worldbookCorpus?: WorldbookCorpusReceipt;
}

export interface EvidenceBundle {
  schema: typeof EVIDENCE_BUNDLE_SCHEMA;
  requestId: string;
  taskType: RetrievalTaskType;
  query: string;
  sourceSnapshots: SourceSnapshot[];
  passages: EvidencePassage[];
  claims: EvidenceClaim[];
  conflictGroupIds: string[];
  catalogCoverage?: KnowledgeCatalogCoverage[];
  temporalEligibility?: TemporalEligibilityLedger;
  eventFrame?: EventFrame;
  castManifest?: CastManifest;
  /** 人物时间锚：入选人物的出生/在世/缺席结论（引擎按 baselineWorldTime 算好，模型直接遵守）。 */
  personTimeline?: Array<{
    name: string;
    state: 'alive' | 'not-born' | 'deceased' | 'unknown';
    narrative: string;
    /** 机器可读生卒/抵达窗口（时期分区逐段推断在场与年龄用）；与 KnowledgeEntity.lifespan 同构。 */
    lifespan?: KnowledgeEntity['lifespan'];
    /** 人物事件证据锚；数组顺序不是 chronology。 */
    lifeAnchors?: OrderedLifeAnchor[];
    /** 只有这些带依据的边可以约束事件先后；其余事件对保持未决。 */
    eventRelations?: CanonEventRelation[];
  }>;
  /** P0-A：四模块共用的任务人物事实投影。 */
  personCanonViews?: PersonCanonView[];
  /** P0-A：人物整条目附件；受 hash/receipt 追踪，不再是 prompt 私有第二真源。 */
  taskAnchorAttachments?: TaskAnchorAttachment[];
  /** 四模块共用的证据使用资格；只约束事实边界，不规定唯一剧情。 */
  qualifiedEvidence?: QualifiedEvidenceView;
  /** P0-D：任务级、可回放但不反写 Canon 的 passage-local 语义解释。 */
  semanticEvidence?: SemanticEvidenceView;
  /** 模型可见短句柄到内部稳定主键的任务级映射；旧缓存可缺省并按 bundle 确定性重建。 */
  citationRegistry?: TaskCitationRegistry;
  /** P1-1：当前 branch/revision 的唯一事实投影；旧缓存兼容时可缺省。 */
  canonResolvedView?: CanonResolvedView;
  receipt: RetrievalReceipt;
}
