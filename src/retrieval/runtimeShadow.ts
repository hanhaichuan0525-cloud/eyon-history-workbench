import type {
  EvidenceBundle,
  RetrievalReceipt,
  RetrievalMode,
  RetrievalTaskType,
  SourceSnapshot,
  WorldbookRetrievalMetadata,
  WorldbookCorpusReceipt,
} from './contracts.ts';
import {
  createSourceSnapshot,
  stableJson,
} from './sourceSnapshot.ts';
import {
  UnifiedShadowRetrievalEngine,
  type ShadowComparison,
} from './shadowEngine.ts';

export interface RuntimeShadowCandidate {
  sourceId: string;
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  content: string;
  sourceOrder?: number;
  worldbook?: WorldbookRetrievalMetadata;
}

interface OrderedRuntimeShadowCandidate extends RuntimeShadowCandidate {
  sourceOrder: number;
}

export interface RuntimeShadowCaptureInput {
  requestId: string;
  taskType: RetrievalTaskType;
  /** 玩家明确选择或任务冻结的历史目标；只有它可以让候选入选。 */
  query: string;
  /** 当前世界与近期对话；只能给已命中目标的候选加辅助分。 */
  contextQuery?: string;
  candidates: RuntimeShadowCandidate[];
  legacySourceIds: string[];
  mode?: RetrievalMode;
  worldbookCorpusReceipt?: WorldbookCorpusReceipt;
  /**
   * 作为「疆域/地点范围」引用而非在场演员的实体名；目标纪元不可用时降级为 warning。
   */
  territorialReferences?: string[];
  /** 仅提高检索与创作注意力，不自动成为 required 演员的实体名。 */
  focusEntityNames?: string[];
  /** 只有此文本中的直接实体可升级为 required 演员。 */
  castRequirementQuery?: string;
  /** 开局锁定的年龄基准时间（人物时间锚换算用）。 */
  baselineWorldTime?: string | null;
  /** 显式选中的来源 logicalId（如「引用传记」）：检索未命中也强制入选。 */
  forcedSourceLogicalIds?: string[];
}

export interface RuntimeShadowSourceMapping {
  sourceId: string;
  logicalId: string;
  snapshotId: string;
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  sourceOrder: number;
}

export interface RuntimeShadowDiagnostics {
  candidateCount: number;
  snapshotCacheHits: number;
  snapshotCacheMisses: number;
  engineReused: boolean;
  indexBuildMs: number;
  retrievalMs: number;
  totalDurationMs: number;
}

export interface RuntimeShadowSuccessObservation {
  status: 'success';
  recordedAt: number;
  requestId: string;
  taskType: RetrievalTaskType;
  sourceMappings: RuntimeShadowSourceMapping[];
  receipt: RetrievalReceipt;
  comparison: ShadowComparison;
  conflictGroupIds: string[];
  diagnostics: RuntimeShadowDiagnostics;
}

export interface RuntimeShadowFailureObservation {
  status: 'failure';
  recordedAt: number;
  requestId: string;
  taskType: RetrievalTaskType;
  error: string;
}

export type RuntimeShadowObservation =
  | RuntimeShadowSuccessObservation
  | RuntimeShadowFailureObservation;

export interface RuntimeShadowSuccessCapture extends RuntimeShadowSuccessObservation {
  /** 仅随当前调用瞬时返回；不会写入公开 observation 历史。 */
  bundle: EvidenceBundle;
}

export type RuntimeShadowCaptureResult =
  | RuntimeShadowSuccessCapture
  | RuntimeShadowFailureObservation;

export interface RetrievalShadowCapture {
  capture(input: RuntimeShadowCaptureInput): Promise<RuntimeShadowCaptureResult>;
}

interface SnapshotCacheEntry {
  sourceType: SourceSnapshot['sourceType'];
  title: string;
  content: string;
  sourceOrder: number;
  metadataKey: string;
  snapshot: SourceSnapshot;
}

/**
 * Retrieval v1 的运行时观察器。默认只记录 shadow 回执；显式使用 active 模式的调用方
 * 可以消费其入选回执生成正式 Context。观察器自身不改写 Context，失败始终留作显式记录。
 */
export class RuntimeShadowRetrievalObserver implements RetrievalShadowCapture {
  private readonly maxObservations: number;
  private readonly observations: RuntimeShadowObservation[] = [];
  private readonly snapshotCache = new Map<string, SnapshotCacheEntry>();
  private engine: UnifiedShadowRetrievalEngine | null = null;
  private engineKey = '';
  private queue: Promise<void> = Promise.resolve();
  private observationEpoch = 0;

  constructor(maxObservations = 24) {
    this.maxObservations = maxObservations;
  }

  capture(input: RuntimeShadowCaptureInput): Promise<RuntimeShadowCaptureResult> {
    const epoch = this.observationEpoch;
    const run = this.queue.then(() => this.captureOne(input, epoch));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  list(): RuntimeShadowObservation[] {
    return structuredClone(this.observations);
  }

  clearObservations(): void {
    this.observationEpoch += 1;
    this.observations.length = 0;
  }

  private async captureOne(
    input: RuntimeShadowCaptureInput,
    epoch: number,
  ): Promise<RuntimeShadowCaptureResult> {
    const started = performance.now();
    try {
      const prepared = dedupeCandidates(input.candidates);
      const sourceIdToLogicalId = new Map<string, string>();
      const snapshots: SourceSnapshot[] = [];
      const sourceMappings: RuntimeShadowSourceMapping[] = [];
      let snapshotCacheHits = 0;
      let snapshotCacheMisses = 0;

      for (const candidate of prepared) {
        const logicalId = candidate.worldbook?.logicalId ?? candidate.sourceId;
        const metadata = candidate.worldbook ?? { sourceId: candidate.sourceId };
        const metadataKey = stableJson({ metadata, sourceOrder: candidate.sourceOrder });
        const cached = this.snapshotCache.get(logicalId);
        let snapshot: SourceSnapshot;
        if (
          cached
          && cached.sourceType === candidate.sourceType
          && cached.title === candidate.title
          && cached.content === candidate.content
          && cached.sourceOrder === candidate.sourceOrder
          && cached.metadataKey === metadataKey
        ) {
          snapshot = cached.snapshot;
          snapshotCacheHits += 1;
        } else {
          snapshot = await createSourceSnapshot({
            logicalId,
            sourceType: candidate.sourceType,
            title: candidate.title,
            content: candidate.content,
            sourceOrder: candidate.sourceOrder,
            metadata,
          });
          this.snapshotCache.set(logicalId, {
            sourceType: candidate.sourceType,
            title: candidate.title,
            content: candidate.content,
            sourceOrder: candidate.sourceOrder,
            metadataKey,
            snapshot,
          });
          snapshotCacheMisses += 1;
        }
        sourceIdToLogicalId.set(candidate.sourceId, logicalId);
        snapshots.push(snapshot);
        sourceMappings.push({
          sourceId: candidate.sourceId,
          logicalId,
          snapshotId: snapshot.snapshotId,
          sourceType: candidate.sourceType,
          title: candidate.title,
          sourceOrder: candidate.sourceOrder,
        });
      }

      const currentLogicalIds = new Set(sourceMappings.map(item => item.logicalId));
      for (const logicalId of this.snapshotCache.keys()) {
        if (!currentLogicalIds.has(logicalId)) this.snapshotCache.delete(logicalId);
      }

      const nextEngineKey = stableJson({
        snapshots: snapshots.map(snapshot => snapshot.snapshotId),
        corpus: input.worldbookCorpusReceipt?.entries.map(entry => [
          entry.logicalId,
          entry.status,
          entry.bindingScopes,
        ]) ?? null,
      });
      const engineReused = this.engine !== null && this.engineKey === nextEngineKey;
      if (!engineReused) {
        this.engine = new UnifiedShadowRetrievalEngine(snapshots);
        this.engineKey = nextEngineKey;
      }
      const engine = this.engine;
      if (!engine) throw new Error('shadow retrieval engine was not initialized');
      const diagnostics = engine.getDiagnostics();
      const result = await engine.retrieve({
        requestId: input.requestId,
        taskType: input.taskType,
        query: input.query,
        contextQuery: input.contextQuery,
        legacyLogicalIds: input.legacySourceIds.map(sourceId =>
          sourceIdToLogicalId.get(sourceId) ?? sourceId),
        mode: input.mode,
        worldbookCorpusReceipt: input.worldbookCorpusReceipt,
        territorialReferences: input.territorialReferences,
        focusEntityNames: input.focusEntityNames,
        castRequirementQuery: input.castRequirementQuery,
        baselineWorldTime: input.baselineWorldTime,
        forcedSourceLogicalIds: input.forcedSourceLogicalIds,
      });
      const observation: RuntimeShadowSuccessObservation = {
        status: 'success',
        recordedAt: Date.now(),
        requestId: input.requestId,
        taskType: input.taskType,
        sourceMappings,
        receipt: result.bundle.receipt,
        comparison: result.comparison,
        conflictGroupIds: result.bundle.conflictGroupIds,
        diagnostics: {
          candidateCount: snapshots.length,
          snapshotCacheHits,
          snapshotCacheMisses,
          engineReused,
          indexBuildMs: diagnostics.indexBuildMs,
          retrievalMs: result.bundle.receipt.durationMs,
          totalDurationMs: performance.now() - started,
        },
      };
      this.record(observation, epoch);
      return structuredClone({ ...observation, bundle: result.bundle });
    } catch (error) {
      const observation: RuntimeShadowFailureObservation = {
        status: 'failure',
        recordedAt: Date.now(),
        requestId: input.requestId,
        taskType: input.taskType,
        error: error instanceof Error ? error.message : String(error),
      };
      this.record(observation, epoch);
      console.warn('[Eyon History Workbench] retrieval shadow failed', observation);
      return structuredClone(observation);
    }
  }

  private record(observation: RuntimeShadowObservation, epoch: number): void {
    if (epoch !== this.observationEpoch) return;
    this.observations.push(observation);
    if (this.observations.length > this.maxObservations) {
      this.observations.splice(0, this.observations.length - this.maxObservations);
    }
  }
}

function dedupeCandidates(candidates: RuntimeShadowCandidate[]): OrderedRuntimeShadowCandidate[] {
  const seen = new Set<string>();
  const sourceOrders = new Map<SourceSnapshot['sourceType'], number>();
  return candidates.flatMap(candidate => {
    const sourceId = candidate.sourceId.trim();
    const logicalId = candidate.worldbook?.logicalId.trim() || sourceId;
    const content = candidate.content.trim();
    if (!sourceId || !logicalId || !content || seen.has(logicalId)) return [];
    seen.add(logicalId);
    const nextOrder = sourceOrders.get(candidate.sourceType) ?? 0;
    sourceOrders.set(candidate.sourceType, nextOrder + 1);
    return [{
      ...candidate,
      sourceId,
      title: candidate.title.trim() || sourceId,
      content,
      sourceOrder: candidate.sourceOrder ?? nextOrder,
    }];
  });
}
