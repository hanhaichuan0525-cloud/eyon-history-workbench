import {
  ARTIFACT_CANON_CONSUMPTION_SCHEMA,
  type ArtifactCanonAssessment,
  type ArtifactCanonBinding,
  type ArtifactCanonConsumptionDecision,
  type CanonBranch,
} from '../retrieval/contracts.ts';
import type { ArtifactCanonAssessmentTargetView } from './artifactCanonAssessment.ts';
import { operationRebaseState, projectCanonCausalRebase } from './causalRebase.ts';

/**
 * 从不可变绑定与当前 append-only 分支推导可评估目标。
 * 不依赖“最近一次生成”的查询缓存，因此提交或回滚后可立即刷新。
 */
export function currentArtifactCanonAssessmentTarget(input: {
  bindings: ArtifactCanonBinding[];
  branch: CanonBranch;
}): ArtifactCanonAssessmentTargetView {
  const branch = structuredClone(input.branch);
  const bindings = structuredClone(input.bindings)
    .filter(binding => binding.branchId === branch.branchId);
  const boundFactIds = new Set(bindings.flatMap(binding => binding.factIds));
  // 直接由某次操作生成的产物，必须把该操作的 current fact 纳入当前态评估。
  // 否则“纯新增”蝴蝶效应没有前置 fact，回滚后仍会被误判为 current。
  for (const binding of bindings) {
    for (const ref of binding.operationRefs) {
      const operation = branch.deltas
        .find(delta => delta.deltaId === ref.deltaId)
        ?.operations.find(item => item.factKey === ref.factKey);
      if (operation) boundFactIds.add(operation.current.factId);
    }
  }
  const activeFactIds = new Set(boundFactIds);
  const inactiveFactIds = new Set<string>();
  const appliedDeltaIds: string[] = [];
  const skippedDeltaIds: string[] = [];
  const supersededDeltaIds: string[] = [];
  const uncertainItems: string[] = [];
  const revisionByDeltaId = new Map(branch.revisions.map(item => [item.deltaId, item]));
  const causalRebase = projectCanonCausalRebase(branch);

  const deltas = [...branch.deltas]
    .sort((left, right) => left.revision - right.revision
      || left.deltaId.localeCompare(right.deltaId, 'en'));

  // 回滚、孤立或超出当前 head 的新事实不能因旧 binding 而继续被当成活动事实。
  for (const delta of deltas) {
    const revision = revisionByDeltaId.get(delta.deltaId);
    for (const operation of delta.operations) {
      if (!boundFactIds.has(operation.current.factId)) continue;
      const state = causalRebase.status === 'bounded-overflow'
        ? legacyOperationState(delta.status, revision?.status)
        : operationRebaseState(causalRebase, {
          deltaId: delta.deltaId,
          factKey: operation.factKey,
        }) ?? 'uncertain';
      if (state === 'active' && delta.revision <= branch.headRevision) continue;
      activeFactIds.delete(operation.current.factId);
      if (state === 'uncertain') {
        inactiveFactIds.delete(operation.current.factId);
        uncertainItems.push(`${delta.deltaId}/${operation.factKey}: causal-rebase-uncertain`);
      } else {
        inactiveFactIds.add(operation.current.factId);
      }
    }
  }

  for (const delta of deltas) {
    const revision = revisionByDeltaId.get(delta.deltaId);
    const revisionActive = revision?.status === 'active'
      && delta.revision <= branch.headRevision;
    if (!revisionActive || !delta.verified) {
      skippedDeltaIds.push(delta.deltaId);
      if (revisionActive && !delta.verified) {
        uncertainItems.push(`${delta.deltaId}: unverified-active-delta`);
        for (const operation of delta.operations) {
          activeFactIds.delete(operation.current.factId);
          inactiveFactIds.delete(operation.current.factId);
        }
      }
      continue;
    }
    let appliedOperations = 0;
    for (const operation of delta.operations) {
      const state = causalRebase.status === 'bounded-overflow'
        ? legacyOperationState(delta.status, revision?.status)
        : operationRebaseState(causalRebase, {
          deltaId: delta.deltaId,
          factKey: operation.factKey,
        }) ?? 'uncertain';
      if (state !== 'active') continue;
      if (operation.op === 'replace' || operation.op === 'retract') {
        for (const factId of operation.originalFactIds) {
          activeFactIds.delete(factId);
          inactiveFactIds.add(factId);
        }
      }
      if (operation.op !== 'retract') {
        activeFactIds.add(operation.current.factId);
        inactiveFactIds.delete(operation.current.factId);
      }
      appliedOperations += 1;
    }
    if (appliedOperations > 0) {
      appliedDeltaIds.push(delta.deltaId);
      supersededDeltaIds.push(...delta.supersedesDeltaIds);
    } else {
      skippedDeltaIds.push(delta.deltaId);
    }
  }

  const canonical = {
    branchId: branch.branchId,
    resolvedRevision: branch.headRevision,
    activeFactIds: uniqueSorted([...activeFactIds]),
    inactiveFactIds: uniqueSorted([...inactiveFactIds]),
    appliedDeltaIds: uniqueSorted(appliedDeltaIds),
    skippedDeltaIds: uniqueSorted(skippedDeltaIds),
    supersededDeltaIds: uniqueSorted(supersededDeltaIds),
    uncertainItems: uniqueSorted(uncertainItems),
  };
  return {
    branchId: canonical.branchId,
    viewId: `canon-current:${fingerprint(JSON.stringify(canonical))}`,
    resolvedRevision: canonical.resolvedRevision,
    activeFactIds: canonical.activeFactIds,
    inactiveFactIds: canonical.inactiveFactIds,
    resolutionReceipt: {
      appliedDeltaIds: canonical.appliedDeltaIds,
      skippedDeltaIds: canonical.skippedDeltaIds,
      supersededDeltaIds: canonical.supersededDeltaIds,
      uncertainItems: canonical.uncertainItems,
    },
  };
}

function legacyOperationState(
  deltaStatus: CanonBranch['deltas'][number]['status'],
  revisionStatus: CanonBranch['revisions'][number]['status'] | undefined,
): 'active' | 'superseded' | 'orphaned' | 'uncertain' | 'reverted' {
  if (revisionStatus === 'reverted' || deltaStatus === 'reverted') return 'reverted';
  if (revisionStatus === 'orphaned' || deltaStatus === 'orphaned') return 'orphaned';
  if (deltaStatus === 'superseded') return 'superseded';
  return 'active';
}

/** P2-C 唯一消费策略：保守处理不确定项，只硬排除明确失效的局部单位。 */
export function decideArtifactCanonConsumption(
  assessment: ArtifactCanonAssessment,
): ArtifactCanonConsumptionDecision {
  let disposition: ArtifactCanonConsumptionDecision['disposition'];
  if (assessment.eligibility !== 'assessable' || !assessment.status) {
    disposition = 'manual-review';
  } else if (assessment.status === 'current') {
    disposition = 'available';
  } else if (assessment.status === 'partially-stale') {
    disposition = 'available-with-warning';
  } else if (assessment.status === 'stale' || assessment.status === 'orphaned') {
    disposition = 'excluded';
  } else {
    disposition = 'manual-review';
  }
  return {
    schema: ARTIFACT_CANON_CONSUMPTION_SCHEMA,
    assessmentId: assessment.assessmentId,
    artifactType: assessment.artifactType,
    artifactId: assessment.artifactId,
    unitType: assessment.unitType,
    unitId: assessment.unitId,
    eligibility: assessment.eligibility,
    status: assessment.status,
    disposition,
    excludesAutomaticReuse: disposition === 'excluded',
    reasonCodes: uniqueSorted(assessment.reasons.map(reason => reason.code)),
  };
}

export function decideArtifactCanonConsumptions(
  assessments: ArtifactCanonAssessment[],
): ArtifactCanonConsumptionDecision[] {
  return assessments.map(decideArtifactCanonConsumption).sort((left, right) =>
    left.artifactType.localeCompare(right.artifactType, 'en')
    || left.artifactId.localeCompare(right.artifactId, 'en')
    || left.unitType.localeCompare(right.unitType, 'en')
    || left.unitId.localeCompare(right.unitId, 'en'));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
