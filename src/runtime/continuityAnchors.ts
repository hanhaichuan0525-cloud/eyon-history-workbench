import type { ContextSource } from '../core/context.ts';
import {
  CONTINUITY_VIEW_BUDGET,
  CONTINUITY_VIEW_SCHEMA,
  continuityAnchorsFromCommittedRecords,
  listContinuityAnchorDiagnostics,
  recordContinuityViewFailure,
  type ContinuityView,
  type GeneratedContinuityAnchor,
} from '../core/continuityAnchors.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import {
  continuityRelationsFromCommittedRecords,
  listContinuityRelationDiagnostics,
  recordContinuityRelationDiagnostic,
  type ContinuityViewRelation,
} from '../core/continuityRelations.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  assessArtifactCanonBinding,
  artifactCanonAssessmentTargetView,
  type ArtifactCanonAssessmentTargetView,
} from '../core/artifactCanonAssessment.ts';
import type { CanonBranch, CanonResolvedView } from '../retrieval/contracts.ts';
import { selectRelevantContextSources } from './sourceSelection.ts';
import { fingerprintText } from './transactionIdentity.ts';
import {
  readP4DerivedCache,
  writeP4DerivedCache,
  type P4DerivedCacheScope,
} from '../core/p4DerivedCache.ts';

export interface ContinuityAnchorInspection {
  branchId: string;
  canonRevision: number;
  counts: {
    committedBiographies: number;
    legacyBiographies: number;
    storedAnchors: number;
    currentAnchors: number;
    storedRelations: number;
    currentRelations: number;
    parallelViews: number;
    sourceConflicts: number;
  };
  anchors: GeneratedContinuityAnchor[];
  relations: ContinuityViewRelation[];
  diagnostics: ReturnType<typeof listContinuityAnchorDiagnostics>;
  relationDiagnostics: ReturnType<typeof listContinuityRelationDiagnostics>;
}

/**
 * 构建本次任务的低权连续性视图。任何读取、筛选或预算故障都降级为空视图。
 */
export function buildContinuityViewSafely(input: {
  records: readonly BiographyRecord[];
  branchId: string;
  canonRevision: number;
  query: string;
  targetView?: CanonResolvedView | ArtifactCanonAssessmentTargetView;
  branch?: CanonBranch;
  /** 全文复核专用：只附所选锚的原文与同一作品现状，不回扫整本传记。 */
  includeCommittedProse?: boolean;
  cacheScope?: {
    namespace?: string;
    module?: 'biography' | 'ruin' | 'genealogy' | 'biography-review' | 'continuity';
    subjectScope?: string[];
    timeScope?: string[];
    locationScope?: string[];
  };
}): ContinuityView {
  const empty = (): ContinuityView => ({
    schema: CONTINUITY_VIEW_SCHEMA,
    branchId: input.branchId,
    canonRevision: input.canonRevision,
    queryScopeHash: fingerprintText([
      input.branchId,
      String(input.canonRevision),
      input.query,
    ].join('\n')),
    anchors: [],
    relationGroups: [],
    omittedCount: 0,
    warnings: [],
  });
  try {
    const scopedAnchors = continuityAnchorsFromCommittedRecords(
      input.records,
      input.branchId,
      input.canonRevision,
    );
    // P4-A2 不增加同一 passage 的投递占位：若脚本已为最终正文建立 final-prose
    // 低权锚，就在同一冻结 eventId 下优先使用它；旧记录中的事件槽锚仍作为
    // 自然 fallback。
    const preferredAnchors = preferFinalProseAnchors(scopedAnchors);
    const currentRelations = continuityRelationsFromCommittedRecords({
      records: input.records,
      anchors: preferredAnchors,
      namespace: input.records[0] ? namespaceKey(input.records[0].namespace) : '',
      branchId: input.branchId,
      canonRevision: input.canonRevision,
    });
    const candidates: ContextSource[] = preferredAnchors.map(anchor => ({
      sourceId: anchor.anchorId,
      sourceType: 'biography',
      title: [
        ...anchor.participants.map(item => item.name),
        ...anchor.locations.map(item => item.name),
        ...(anchor.objects ?? []).map(item => item.name),
        anchor.temporalScope.label,
      ].filter(Boolean).join(' · '),
      content: anchor.claim,
      authority: 20,
      strategyType: 'selective',
      keywords: [
        ...anchor.participants.map(item => item.name),
        ...anchor.locations.map(item => item.name),
        ...(anchor.objects ?? []).flatMap(item => continuityObjectKeywords(item.name)),
        anchor.temporalScope.label,
      ],
    }));
    const relevantSources = selectRelevantContextSources(candidates, input.query, {
      limit: candidates.length,
      fallbackCount: 0,
      minScore: CONTINUITY_VIEW_BUDGET.minimumSelectionScore,
    });
    // 影响窗只由本次查询命中的锚及其直接关系成员构成。无关锚新增不会让
    // 当前窗口失效；删除/修改相关锚或关系则一定改变 anchorSetHash。
    const directIds = new Set(relevantSources.map(source => source.sourceId));
    const impactIds = new Set(directIds);
    for (const relation of currentRelations) {
      if (relation.memberAnchorIds.some(id => directIds.has(id))) {
        relation.memberAnchorIds.forEach(id => impactIds.add(id));
      }
    }
    const impactAnchors = preferredAnchors.filter(anchor => impactIds.has(anchor.anchorId));
    const impactRelations = currentRelations.filter(relation =>
      relation.memberAnchorIds.some(id => directIds.has(id)));
    const cacheScope = continuityCacheScope(input, impactAnchors, impactRelations);
    const cached = readP4DerivedCache(cacheScope, value => isContinuityView(value, empty().queryScopeHash));
    if (cached) return cached;

    // “同 revision”是第一道边界；现有 P2-B Canon 评估是第二道边界。
    // 只评估影响窗内的锚。评估失败只跳过该锚，不阻断传记或墟境生成。
    const anchors = input.targetView
      ? impactAnchors.filter(anchor => {
        const binding = findProducerBinding(input.records, anchor);
        if (!binding) return false;
        try {
          const assessment = assessArtifactCanonBinding({
            binding,
            view: input.targetView!,
            branch: input.branch,
          });
          return assessment.eligibility === 'assessable'
            && assessment.status === 'current';
        } catch (error) {
          recordContinuityViewFailure(
            `anchor assessment skipped ${anchor.anchorId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
      })
      : impactAnchors;
    const byId = new Map(anchors.map(anchor => [anchor.anchorId, anchor]));
    // 同一冻结事件只保留最早提交的一个锚，避免回忆/重复传记占满预算。
    const relevant: GeneratedContinuityAnchor[] = [];
    const seenEvents = new Set<string>();
    for (const source of relevantSources) {
      const anchor = byId.get(source.sourceId);
      if (!anchor || seenEvents.has(anchor.eventId)) continue;
      seenEvents.add(anchor.eventId);
      relevant.push(anchor);
    }

    const selection = selectRelationAwareAnchors(relevant, anchors, impactRelations);
    const handles = new Map(selection.selected.map((anchor, index) => [anchor.anchorId, `C${index + 1}`]));
    const view: ContinuityView = {
      ...empty(),
      anchors: selection.selected.map((anchor, index) => ({
        anchorId: anchor.anchorId,
        handle: `C${index + 1}`,
        claim: anchor.claim,
        time: anchor.temporalScope.label,
        participants: anchor.participants.map(item => item.name),
        locations: anchor.locations.map(item => item.name),
        objects: (anchor.objects ?? []).map(item => item.name),
        stance: anchor.stance,
        origin: continuityOriginLabel(anchor.producer.unitId),
        ...(input.includeCommittedProse && index < 2
          ? committedProseExcerpts(input.records, anchor)
          : {}),
      })),
      relationGroups: selection.groups.flatMap(group => {
        const left = handles.get(group.memberAnchorIds[0]);
        const right = handles.get(group.memberAnchorIds[1]);
        return left && right ? [{
          kind: group.kind,
          dimension: group.dimension,
          handles: [left, right] as [string, string],
          omittedMemberCount: group.omittedMemberCount,
        }] : [];
      }),
      omittedCount: selection.omittedCount,
    };
    writeP4DerivedCache(cacheScope, view);
    return view;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordContinuityViewFailure(message);
    return { ...empty(), warnings: [`continuity_view_failed:${message.slice(0, 160)}`] };
  }
}

function continuityCacheScope(
  input: Parameters<typeof buildContinuityViewSafely>[0],
  anchors: readonly GeneratedContinuityAnchor[],
  relations: readonly ContinuityViewRelation[],
): P4DerivedCacheScope {
  const queryScopeHash = fingerprintText([input.branchId, String(input.canonRevision), input.query].join('\n'));
  const recordNamespace = input.records[0] ? namespaceKey(input.records[0].namespace) : '';
  const target = input.targetView
    ? ('activeFacts' in input.targetView
      ? artifactCanonAssessmentTargetView(input.targetView)
      : input.targetView)
    : undefined;
  const producerState = anchors.map(anchor => {
    const binding = findProducerBinding(input.records, anchor);
    const relevantFacts = new Set(binding?.factIds ?? []);
    const relevantDeltaIds = new Set((binding?.operationRefs ?? []).map(ref => ref.deltaId));
    return {
      anchor,
      binding,
      targetFacts: target ? {
        active: target.activeFactIds.filter(id => relevantFacts.has(id)).sort(),
        inactive: target.inactiveFactIds.filter(id => relevantFacts.has(id)).sort(),
      } : null,
      branchDeltas: input.branch?.deltas.flatMap(delta => {
        const operations = delta.operations.filter(operation =>
          relevantFacts.has(operation.current.factId)
          || relevantDeltaIds.has(delta.deltaId));
        return operations.length ? [{ revision: delta.revision, status: delta.status, operations }] : [];
      }) ?? [],
    };
  }).sort((left, right) => left.anchor.anchorId.localeCompare(right.anchor.anchorId));
  const relationState = [...relations]
    .map(relation => ({
      relationId: relation.relationId,
      kind: relation.kind,
      dimension: relation.dimension,
      memberAnchorIds: [...relation.memberAnchorIds].sort(),
    }))
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
  return {
    namespace: input.cacheScope?.namespace ?? recordNamespace,
    branchId: input.branchId,
    canonRevision: input.canonRevision,
    queryScopeHash,
    module: input.cacheScope?.module ?? (input.includeCommittedProse ? 'biography-review' : 'continuity'),
    subjectScope: input.cacheScope?.subjectScope ?? [input.query],
    timeScope: input.cacheScope?.timeScope ?? [],
    locationScope: input.cacheScope?.locationScope ?? [],
    anchorSetHash: fingerprintText(JSON.stringify({
      producerState,
      relationState,
      includeCommittedProse: Boolean(input.includeCommittedProse),
    })),
  };
}

function isContinuityView(value: unknown, queryScopeHash: string): value is ContinuityView {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ContinuityView>;
  return candidate.schema === CONTINUITY_VIEW_SCHEMA
    && candidate.queryScopeHash === queryScopeHash
    && Array.isArray(candidate.anchors)
    && Array.isArray(candidate.relationGroups)
    && Array.isArray(candidate.warnings);
}

function continuityObjectKeywords(name: string): string[] {
  const plain = name.replace(/[《》〈〉「」『』【】]/gu, '').trim();
  return plain && plain !== name ? [name, plain] : [name];
}

function preferFinalProseAnchors(
  anchors: readonly GeneratedContinuityAnchor[],
): GeneratedContinuityAnchor[] {
  const selected = new Map<string, GeneratedContinuityAnchor>();
  for (const anchor of anchors) {
    const key = [anchor.producer.artifactId, anchor.producer.unitId, anchor.eventId].join('\u0000');
    const existing = selected.get(key);
    if (!existing || (anchor.claimSource === 'final-prose' && existing.claimSource !== 'final-prose')) {
      selected.set(key, anchor);
    }
  }
  return [...selected.values()];
}

function committedProseExcerpts(
  records: readonly BiographyRecord[],
  anchor: GeneratedContinuityAnchor,
): { finalProseExcerpt?: string; statusExcerpt?: string } {
  const record = records.find(item =>
    item.status === 'committed' && item.biographyId === anchor.producer.artifactId);
  if (!record) return {};
  const unitId = anchor.producer.unitId;
  const passage = unitId === 'origin'
    ? record.biography.origin
    : unitId === 'status'
      ? record.biography.status
      : record.biography.stages.find(stage => stage.id === unitId);
  if (!passage) return {};
  const excerpt = completeCommittedProse(passage.content);
  const targetName = record.biography.target.name.trim();
  const status = unitId !== 'status' && targetName && anchor.claim.includes(targetName)
    ? completeCommittedProse(record.biography.status.content)
    : '';
  return {
    ...(excerpt ? { finalProseExcerpt: excerpt } : {}),
    ...(status ? { statusExcerpt: status } : {}),
  };
}

function completeCommittedProse(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

export function inspectContinuityAnchors(input: {
  records: readonly BiographyRecord[];
  branchId: string;
  canonRevision: number;
}): ContinuityAnchorInspection {
  const committed = input.records.filter(record => record.status === 'committed');
  const storedAnchors = committed.flatMap(record => record.continuityAnchors ?? []);
  const currentAnchors = continuityAnchorsFromCommittedRecords(
    input.records,
    input.branchId,
    input.canonRevision,
  );
  const storedRelations = committed.flatMap(record => record.continuityRelations ?? []);
  const currentRelations = continuityRelationsFromCommittedRecords({
    records: input.records,
    anchors: currentAnchors,
    namespace: input.records[0] ? namespaceKey(input.records[0].namespace) : '',
    branchId: input.branchId,
    canonRevision: input.canonRevision,
  });
  return {
    branchId: input.branchId,
    canonRevision: input.canonRevision,
    counts: {
      committedBiographies: committed.length,
      legacyBiographies: committed.filter(record => !record.continuityAnchors).length,
      storedAnchors: storedAnchors.length,
      currentAnchors: currentAnchors.length,
      storedRelations: storedRelations.length,
      currentRelations: currentRelations.length,
      parallelViews: currentRelations.filter(item => item.kind === 'parallelView').length,
      sourceConflicts: currentRelations.filter(item => item.kind === 'sourceConflict').length,
    },
    anchors: structuredClone(storedAnchors),
    relations: structuredClone(currentRelations),
    diagnostics: listContinuityAnchorDiagnostics(),
    relationDiagnostics: listContinuityRelationDiagnostics(),
  };
}

/** 模型只看自然语言连续性提示，不看内部 anchorId/bindingId。 */
export function renderContinuityView(
  view: ContinuityView | undefined,
  options: { includeRelations?: boolean } = {},
): string[] {
  if (!view || view.anchors.length === 0) return [];
  return [
    '<GENERATED_CONTINUITY_READ_ONLY>',
    '以下是同一聊天、同一 Canon 版本中，已提交作品采用过的低权连续性。它们不是世界书或蝴蝶正史，也不是演员配额。',
    'asserted 与 hypothesis 都表示旧作品已采用的版本；hypothesis 仅说明它源于原创或推断，并非世界书正史。若新作品涉及同一对象与时期，须保持旧作品明确写出的事件时间、存续与持久状态；不能仅因标签是 hypothesis 就无说明改写。',
    '玩家明确要求另一版本、后续确切干预或更高权证据可以改变它；若写修复、重建、重新开业或重新取得已失物件，应交代变化发生的时间与经过，不可让旧状态悄然消失。',
    '任何条目与当前 Canon 冲突时一律以 Canon 为准；无需逐条复述，也不要回报句柄。',
    ...view.anchors.map(anchor => [
      `[${anchor.handle}][${anchor.stance}] ${anchor.claim}`,
      `时间：${anchor.time || '未标'}；参与：${anchor.participants.join('、') || '未标'}；地点：${anchor.locations.join('、') || '未标'}；来源：${anchor.origin}`,
      ...(anchor.finalProseExcerpt ? [`该事件的已提交正文摘录：${anchor.finalProseExcerpt}`] : []),
      ...(anchor.statusExcerpt ? [`同一作品的现状摘录：${anchor.statusExcerpt}`] : []),
    ].join('\n')),
    ...(options.includeRelations ? view.relationGroups.map(group => group.kind === 'parallelView'
      ? `[并存视角][${continuityDimensionLabel(group.dimension)}] ${group.handles[0]} 与 ${group.handles[1]} 是同一事实面的两种低权表达；目前不裁定唯一版本，后续涉及该事实时保留差异，不要擅自合并。${group.omittedMemberCount > 0 ? ` 同组另有 ${group.omittedMemberCount} 个视角因预算未展开。` : ''}`
      : `[来源冲突][${continuityDimensionLabel(group.dimension)}] ${group.handles[0]} 与 ${group.handles[1]} 各有不同来源且不能同时成立；当前没有胜者，后续不得静默选边。${group.omittedMemberCount > 0 ? ` 同组另有 ${group.omittedMemberCount} 个视角因预算未展开。` : ''}`) : []),
    ...(view.omittedCount > 0 ? [`另有 ${view.omittedCount} 条相关锚因预算未注入。`] : []),
    '</GENERATED_CONTINUITY_READ_ONLY>',
  ];
}

interface RelationAwareSelection {
  selected: GeneratedContinuityAnchor[];
  groups: Array<{
    kind: ContinuityViewRelation['kind'];
    dimension: ContinuityViewRelation['dimension'];
    memberAnchorIds: [string, string];
    omittedMemberCount: number;
  }>;
  omittedCount: number;
}

function selectRelationAwareAnchors(
  relevant: readonly GeneratedContinuityAnchor[],
  available: readonly GeneratedContinuityAnchor[],
  relations: readonly ContinuityViewRelation[],
): RelationAwareSelection {
  const anchorById = new Map(available.map(anchor => [anchor.anchorId, anchor]));
  const relevantRank = new Map(relevant.map((anchor, index) => [anchor.anchorId, index]));
  const relevantIds = new Set(relevantRank.keys());
  const clusters = relationClusters(relations)
    .filter(cluster => cluster.memberIds.some(id => relevantIds.has(id)))
    .sort((left, right) => clusterRank(left.memberIds, relevantRank)
      - clusterRank(right.memberIds, relevantRank)
      || left.memberIds[0]!.localeCompare(right.memberIds[0]!));
  const selected: GeneratedContinuityAnchor[] = [];
  const selectedIds = new Set<string>();
  const candidateIds = new Set(relevantIds);
  const groups: RelationAwareSelection['groups'] = [];
  for (const cluster of clusters) {
    cluster.memberIds.forEach(id => candidateIds.add(id));
    const members = cluster.memberIds
      .map(id => anchorById.get(id))
      .filter((anchor): anchor is GeneratedContinuityAnchor => Boolean(anchor))
      .sort((left, right) => (relevantRank.get(left.anchorId) ?? Number.MAX_SAFE_INTEGER)
        - (relevantRank.get(right.anchorId) ?? Number.MAX_SAFE_INTEGER)
        || left.anchorId.localeCompare(right.anchorId));
    const pair = members.slice(0, 2);
    if (pair.length < 2 || selected.length + 2 > CONTINUITY_VIEW_BUDGET.maxAnchors) continue;
    pair.forEach(anchor => {
      if (!selectedIds.has(anchor.anchorId)) {
        selected.push(anchor);
        selectedIds.add(anchor.anchorId);
      }
    });
    const direct = cluster.relations.find(relation =>
      pair.every(anchor => relation.memberAnchorIds.includes(anchor.anchorId)))
      ?? cluster.relations[0]!;
    groups.push({
      kind: direct.kind,
      dimension: direct.dimension,
      memberAnchorIds: [pair[0]!.anchorId, pair[1]!.anchorId],
      omittedMemberCount: Math.max(0, members.length - 2),
    });
    if (members.length > 2) {
      recordContinuityRelationDiagnostic({
        code: 'cluster-omitted', relationId: direct.relationId,
        message: `${members.length - 2} relation cluster members omitted by the two-view prompt limit`,
        createdAt: Date.now(),
      });
    }
  }
  const seenEvents = new Set(selected.map(anchor => anchor.eventId));
  for (const anchor of relevant) {
    if (selectedIds.has(anchor.anchorId) || seenEvents.has(anchor.eventId)) continue;
    if (selected.length >= CONTINUITY_VIEW_BUDGET.maxAnchors) break;
    selected.push(anchor);
    selectedIds.add(anchor.anchorId);
    seenEvents.add(anchor.eventId);
  }
  return {
    selected,
    groups,
    omittedCount: [...candidateIds].filter(id => !selectedIds.has(id)).length,
  };
}

function relationClusters(relations: readonly ContinuityViewRelation[]): Array<{
  memberIds: string[];
  relations: ContinuityViewRelation[];
}> {
  const adjacency = new Map<string, Set<string>>();
  for (const relation of relations) {
    const [left, right] = relation.memberAnchorIds;
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }
  const visited = new Set<string>();
  const result: Array<{ memberIds: string[]; relations: ContinuityViewRelation[] }> = [];
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const queue = [start];
    const members: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      members.push(current);
      for (const next of [...(adjacency.get(current) ?? [])].sort()) {
        if (!visited.has(next)) queue.push(next);
      }
    }
    members.sort();
    const memberSet = new Set(members);
    result.push({
      memberIds: members,
      relations: relations.filter(relation =>
        relation.memberAnchorIds.every(id => memberSet.has(id))),
    });
  }
  return result;
}

function clusterRank(memberIds: readonly string[], ranks: Map<string, number>): number {
  return Math.min(...memberIds.map(id => ranks.get(id) ?? Number.MAX_SAFE_INTEGER));
}

function continuityDimensionLabel(value: ContinuityViewRelation['dimension']): string {
  return ({
    time: '时间', location: '地点', participant: '参与者', relationship: '关系',
    ownership: '归属', objectState: '物品状态', outcome: '结果',
  } as const)[value];
}

function findProducerBinding(
  records: readonly BiographyRecord[],
  anchor: GeneratedContinuityAnchor,
) {
  const record = records.find(item =>
    item.status === 'committed'
    && item.biographyId === anchor.producer.artifactId);
  return record?.canonBindings?.find(binding =>
    binding.bindingId === anchor.producer.bindingId
    && binding.unitId === anchor.producer.unitId
    && binding.branchId === anchor.branchId
    && binding.boundView.resolvedRevision === anchor.canonRevision);
}

function continuityOriginLabel(unitId: string): string {
  if (unitId === 'origin') return '已提交传记 · 起源';
  if (unitId === 'status') return '已提交传记 · 现状';
  const stage = /^stage-(\d+)$/u.exec(unitId);
  return stage ? `已提交传记 · 第 ${stage[1]} 阶段` : '已提交传记 · 历史阶段';
}
