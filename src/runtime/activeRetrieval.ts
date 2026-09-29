import type { ContextSource } from '../core/context.ts';
import type {
  CanonBranch,
  EvidenceBundle,
  RetrievalTaskType,
} from '../retrieval/contracts.ts';
import {
  canonQueryScopeFromBundle,
  canonResolutionBranch,
  projectEvidenceBundleCanon,
  resolveCanon,
} from '../retrieval/canonResolver.ts';
import type {
  RetrievalShadowCapture,
  RuntimeShadowCandidate,
  RuntimeShadowCaptureInput,
  RuntimeShadowSuccessObservation,
} from '../retrieval/runtimeShadow.ts';
import { recordCanonResolvedViewDiagnostic } from './canonViewDiagnostics.ts';

export interface ActiveRetrievalResult {
  observation: RuntimeShadowSuccessObservation;
  bundle: EvidenceBundle;
  sourceIndex: ContextSource[];
}

/**
 * 四个业务模块共用的正式检索门。Active 失败必须终止当前任务；不得回退、拼接
 * 或继续消费 legacy sourceIndex。模型可见正文只来自 EvidencePassage。
 */
export async function resolveActiveRetrieval(input: {
  retrieval?: RetrievalShadowCapture;
  taskType: RetrievalTaskType;
  requestId: string;
  query: string;
  contextQuery?: string;
  runtimeCandidates: RuntimeShadowCandidate[];
  contextCandidates: ContextSource[];
  legacySourceIds: string[];
  worldbookCorpusReceipt?: RuntimeShadowCaptureInput['worldbookCorpusReceipt'];
  /** 作为「疆域/地点范围」引用而非在场演员的实体名；目标纪元不可用时降级为 warning。 */
  territorialReferences?: string[];
  /** 仅作检索焦点、不自动成为 required 演员的实体名。 */
  focusEntityNames?: string[];
  /** 从完整检索 query 中剥离重点参考资料后，真正要求演员的玩家输入。 */
  castRequirementQuery?: string;
  /** 开局锁定的年龄基准时间（人物时间锚换算用）。 */
  baselineWorldTime?: string | null;
  /**
   * 显式选中的来源 logicalId 列表（如工作台「引用传记」）：
   * 检索未命中也强制入选（forced-reference 开门），与全世界书同池同门。
   */
  forcedSourceLogicalIds?: string[];
  /**
   * 仅单元测试专用：允许旧兼容 provider（无 getWorldbookCorpus）在 fixture 中
   * 以 complete=false 语料运行。生产构建不得传入；缺省即强制完整语料门。
   */
  allowIncompleteCorpusForFixture?: boolean;
  /** 当前聊天的 Canon 分支；生产环境由四模块共用仓库提供。 */
  canonBranch?: CanonBranch;
}): Promise<ActiveRetrievalResult> {
  if (!input.retrieval) {
    throw new Error(`Active ${input.taskType} retrieval is unavailable`);
  }
  assertCompleteWorldbookCorpus(input);
  const result = await input.retrieval.capture({
    requestId: input.requestId,
    taskType: input.taskType,
    mode: 'active',
    query: input.query,
    contextQuery: input.contextQuery,
    candidates: input.runtimeCandidates,
    legacySourceIds: input.legacySourceIds,
    worldbookCorpusReceipt: input.worldbookCorpusReceipt,
    territorialReferences: input.territorialReferences,
    focusEntityNames: input.focusEntityNames,
    castRequirementQuery: input.castRequirementQuery,
    baselineWorldTime: input.baselineWorldTime,
    forcedSourceLogicalIds: input.forcedSourceLogicalIds,
  });
  if (result.status === 'failure') {
    throw new Error(`Active ${input.taskType} retrieval failed: ${result.error}`);
  }

  let bundle = result.bundle;
  if (input.canonBranch) {
    const queryScope = canonQueryScopeFromBundle(bundle);
    const view = resolveCanon(
      canonResolutionBranch(input.canonBranch, bundle),
      input.canonBranch.headRevision,
      queryScope,
    );
    bundle = projectEvidenceBundleCanon(bundle, view);
    recordCanonResolvedViewDiagnostic({
      requestId: input.requestId,
      taskType: input.taskType,
      view,
    });
    // F-02 诊断增强（只记录不阻断）：一次看清 canon 投递全链路——
    // 查询侧 scope 内容、应用/跳过/未决计数、视图内新事实条数。
    const activeNewFacts = view.activeFacts
      .filter(fact => fact.revisionIntroduced > 0).length;
    console.info(
      '[Eyon History Workbench] canon view: '
      + `task=${input.taskType} revision=${view.resolvedRevision} `
      + `applied=${view.resolutionReceipt.appliedDeltaIds.length} `
      + `skipped=${view.resolutionReceipt.skippedDeltaIds.length} `
      + `uncertain=${view.resolutionReceipt.uncertainItems.length} `
      + `activeNewFacts=${activeNewFacts} `
      + `scopeEntities=${queryScope.subjectEntityIds.length} `
      + `scopeEras=[${queryScope.temporalScopes.join('|')}] `
      + `scopeLocations=[${queryScope.spatialScopes.join('|')}] `
      + `scopeNames=${queryScope.names?.length ?? 0}`,
    );
  }
  const observation: RuntimeShadowSuccessObservation & { bundle: EvidenceBundle } = {
    ...result,
    bundle,
  };

  const incompleteGroup = bundle.castManifest?.groupCoverage.find(group =>
    group.exhaustive && !group.complete);
  if (incompleteGroup) {
    throw new Error(
      `Active ${input.taskType} retrieval could not cover exhaustive group: ${incompleteGroup.phrase}`,
    );
  }
  const ungroundedActor = bundle.castManifest?.entries.find(entry =>
    ['required', 'group-required'].includes(entry.disposition)
    && entry.identity.passageIds.length === 0);
  if (ungroundedActor) {
    throw new Error(
      `Active ${input.taskType} retrieval has no evidence passage for cast actor: ${ungroundedActor.identity.canonicalName}`,
    );
  }

  return {
    observation,
    bundle,
    sourceIndex: selectActivePassageSources(
      observation,
      input.contextCandidates,
      input.taskType,
    ),
  };
}

/**
 * R-03：active 模式下若存在世界书作用域，语料回执必须证明宿主完整枚举
 * （complete=true）。缺失或 complete=false 一律显式失败，绝不把「只召回了
 * 几条」当成「检索全部开启世界书」。仅测试 fixture 可显式豁免。
 */
function assertCompleteWorldbookCorpus(input: {
  taskType: RetrievalTaskType;
  runtimeCandidates: RuntimeShadowCandidate[];
  worldbookCorpusReceipt?: RuntimeShadowCaptureInput['worldbookCorpusReceipt'];
  allowIncompleteCorpusForFixture?: boolean;
}): void {
  if (input.allowIncompleteCorpusForFixture) return;
  const hasWorldbookScope = input.runtimeCandidates.some(candidate =>
    candidate.sourceType === 'worldbook');
  if (!hasWorldbookScope) return;
  if (!input.worldbookCorpusReceipt) {
    throw new Error(
      `Active ${input.taskType} retrieval requires a complete worldbook corpus receipt`,
    );
  }
  if (input.worldbookCorpusReceipt.complete === false) {
    throw new Error(
      `Active ${input.taskType} retrieval worldbook corpus is incomplete (complete=false): `
      + 'host enumeration did not cover all bound entries',
    );
  }
}

function selectActivePassageSources(
  observation: RuntimeShadowSuccessObservation & { bundle: EvidenceBundle },
  candidates: ContextSource[],
  taskType: RetrievalTaskType,
): ContextSource[] {
  const sourceById = new Map(candidates.map(source => [source.sourceId, source]));
  const mappingBySnapshotId = new Map(
    observation.sourceMappings.map(mapping => [mapping.snapshotId, mapping]),
  );
  const passagesBySnapshotId = new Map<string, EvidenceBundle['passages']>();
  const canonPassages = new Map(
    observation.bundle.canonResolvedView?.passageViews.map(item => [item.passageId, item]),
  );
  for (const sourcePassage of observation.bundle.passages) {
    const current = canonPassages.get(sourcePassage.passageId);
    if (current?.status === 'inactive' || (current && !current.content.trim())) continue;
    const passage = current
      ? { ...sourcePassage, content: current.content }
      : sourcePassage;
    const passages = passagesBySnapshotId.get(passage.snapshotId) ?? [];
    passages.push(passage);
    passagesBySnapshotId.set(passage.snapshotId, passages);
  }

  return observation.receipt.selected.flatMap(decision => {
    const mapping = mappingBySnapshotId.get(decision.snapshotId);
    const source = mapping ? sourceById.get(mapping.sourceId) : undefined;
    if (!mapping || !source) {
      throw new Error(
        `Active ${taskType} retrieval selected an unknown source: ${decision.snapshotId}`,
      );
    }
    const seenHashes = new Set<string>();
    const passages = (passagesBySnapshotId.get(decision.snapshotId) ?? [])
      .filter(passage => {
        if (seenHashes.has(passage.contentHash)) return false;
        seenHashes.add(passage.contentHash);
        return true;
      })
      .sort((left, right) => left.startOffset - right.startOffset);
    if (passages.length === 0) {
      // 当前 revision 已把该来源命中的全部事实撤回；该来源不再进入模型正文。
      return [];
    }
    return [{
      ...source,
      content: passages.map(passage => passage.content).join('\n\n'),
    }];
  });
}
