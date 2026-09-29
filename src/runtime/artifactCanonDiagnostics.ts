import {
  listArtifactCanonBindingDiagnostics,
  type ArtifactCanonBindingDiagnostic,
} from '../core/artifactCanonBinding.ts';
import type { ArtifactCanonBinding } from '../retrieval/contracts.ts';
import type {
  ArtifactCanonAssessment,
  CanonBranch,
  CanonCausalReconcileReceipt,
} from '../retrieval/contracts.ts';
import {
  assessArtifactCanonBindingsSafely,
  createIneligibleArtifactCanonAssessment,
  type ArtifactCanonAssessmentDiagnostic,
  type ArtifactCanonAssessmentTargetView,
} from '../core/artifactCanonAssessment.ts';
import {
  currentArtifactCanonAssessmentTarget,
  decideArtifactCanonConsumptions,
} from '../core/artifactCanonConsumption.ts';
import type { ArtifactCanonConsumptionDecision } from '../retrieval/contracts.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import type { ButterflyRecord } from '../storage/butterflies.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { RuinCandidateRecord } from '../storage/ruins.ts';
import {
  previewCanonCausalConflicts,
  type CanonCausalConflictPreview,
} from '../core/causalPreview.ts';
import {
  projectCanonCausalRebase,
  type CanonCausalRebaseProjection,
} from '../core/causalRebase.ts';
import { buildGenealogyLocalView } from '../core/genealogyLocalView.ts';

export interface ArtifactCanonBindingInspection {
  schema: 'eyon.canon.artifact-binding-inspection.v1';
  counts: {
    artifacts: number;
    boundArtifacts: number;
    unboundArtifacts: number;
    bindings: number;
    bindingMissing: number;
  };
  artifacts: Array<{
    artifactType: ArtifactCanonBinding['artifactType'];
    artifactId: string;
    binding: 'bound' | 'unbound';
    bindingCount: number;
  }>;
  bindings: ArtifactCanonBinding[];
  failures: ArtifactCanonBindingDiagnostic[];
}

export interface ArtifactCanonAssessmentInspection {
  schema: 'eyon.canon.artifact-assessment-inspection.v1';
  comparedView: {
    branchId: string;
    viewId: string;
    resolvedRevision: number;
  };
  counts: {
    artifacts: number;
    assessments: number;
    returnedAssessments: number;
    omittedAssessments: number;
    assessable: number;
    unbound: number;
    bindingMissing: number;
    current: number;
    partiallyStale: number;
    stale: number;
    orphaned: number;
    uncertain: number;
    failures: number;
  };
  assessments: ArtifactCanonAssessment[];
  failures: ArtifactCanonAssessmentDiagnostic[];
}

export interface ArtifactCanonConsumptionInspection {
  genealogyViews?: Array<{ artifactId: string; branchId: string; canonRevision: number; units: import('../core/genealogyLocalView.ts').GenealogyUnitState[] }>;
  schema: 'eyon.canon.artifact-consumption-inspection.v1';
  branch: {
    branchId: string;
    headRevision: number;
    updatedAt: number;
    revisions: number;
    active: number;
    reverted: number;
    orphaned: number;
  };
  changes: Array<{
    revision: number;
    parentRevision: number;
    status: CanonBranch['revisions'][number]['status'];
    deltaStatus: CanonBranch['deltas'][number]['status'] | 'missing';
    actionId: string;
    deltaId: string;
    assistantMessageId: number;
    rawCommand: string;
    actionRecord: string;
    verified: boolean;
    operations: Array<{
      op: 'assert' | 'retract' | 'replace';
      factKey: string;
      originalFactIds: string[];
      currentFactId: string;
    }>;
    createdAt: number;
    revertedAt?: number;
  }>;
  assessment: ArtifactCanonAssessmentInspection;
  decisions: ArtifactCanonConsumptionDecision[];
  /** P3-A：纯只读预演；不代表这些状态已经生效。 */
  causalPreview: CanonCausalConflictPreview;
  /** P3-B：当前分支实际消费的 operation 级确定性投影。 */
  causalRebase: CanonCausalRebaseProjection;
  /** P3-C：只有真正调用过局部协调的 revision 才出现。 */
  causalReconciles?: Array<CanonCausalReconcileReceipt & {
    receiptId: string;
    canonRevision: number;
  }>;
  counts: {
    available: number;
    availableWithWarning: number;
    excluded: number;
    manualReview: number;
  };
}

const ARTIFACT_CANON_ASSESSMENT_INSPECTION_LIMIT = 512;

export function inspectArtifactCanonBindings(input: {
  biographies: BiographyRecord[];
  genealogies: GenealogyRecord[];
  ruins: RuinCandidateRecord[];
  butterflies: ButterflyRecord[];
}): ArtifactCanonBindingInspection {
  const records = [
    ...input.biographies.map(record => ({
      artifactType: 'biography' as const,
      artifactId: record.biographyId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.genealogies.map(record => ({
      artifactType: 'genealogy' as const,
      artifactId: record.requestId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.ruins.map(record => ({
      artifactType: 'ruin' as const,
      artifactId: record.requestId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.butterflies.map(record => ({
      artifactType: 'butterfly' as const,
      artifactId: record.runId,
      bindings: record.canonBindings ?? [],
    })),
  ].sort((left, right) =>
    left.artifactType.localeCompare(right.artifactType, 'en')
    || left.artifactId.localeCompare(right.artifactId, 'en'));
  const artifactKeys = new Set(records.map(record =>
    `${record.artifactType}:${record.artifactId}`));
  const bindings = records
    .flatMap(record => record.bindings)
    .sort((left, right) => left.bindingId.localeCompare(right.bindingId, 'en'));
  const failures = listArtifactCanonBindingDiagnostics().filter(item =>
    artifactKeys.has(`${item.artifactType}:${item.artifactId}`));
  const unboundArtifacts = records.filter(record => record.bindings.length === 0).length;
  return structuredClone({
    schema: 'eyon.canon.artifact-binding-inspection.v1' as const,
    counts: {
      artifacts: records.length,
      boundArtifacts: records.length - unboundArtifacts,
      unboundArtifacts,
      bindings: bindings.length,
      bindingMissing: failures.length,
    },
    artifacts: records.map(record => ({
      artifactType: record.artifactType,
      artifactId: record.artifactId,
      binding: record.bindings.length > 0 ? 'bound' as const : 'unbound' as const,
      bindingCount: record.bindings.length,
    })),
    bindings,
    failures,
  });
}

/** P2-B 只读聚合：逐局部单位评估，不传播状态，也不改写原记录。 */
export function inspectArtifactCanonAssessments(input: {
  biographies: BiographyRecord[];
  genealogies: GenealogyRecord[];
  ruins: RuinCandidateRecord[];
  butterflies: ButterflyRecord[];
  view: ArtifactCanonAssessmentTargetView;
  branch: CanonBranch;
}): ArtifactCanonAssessmentInspection {
  const records = artifactBindingRecords(input, input.branch);
  const bindingDiagnostics = listArtifactCanonBindingDiagnostics().filter(item =>
    records.some(record => record.artifactType === item.artifactType
      && record.artifactId === item.artifactId));
  const evaluated = assessArtifactCanonBindingsSafely({
    bindings: records.flatMap(record => record.bindings),
    view: input.view,
    branch: input.branch,
  });
  const ineligible = [
    ...records
      .filter(record => record.bindings.length === 0)
      .map(record => createIneligibleArtifactCanonAssessment({
        artifactType: record.artifactType,
        artifactId: record.artifactId,
        unitType: 'artifact',
        unitId: record.artifactId,
        eligibility: 'unbound',
        view: input.view,
      })),
    ...bindingDiagnostics.map(item => createIneligibleArtifactCanonAssessment({
      artifactType: item.artifactType,
      artifactId: item.artifactId,
      unitType: item.unitType?.trim() || 'artifact',
      unitId: item.unitId?.trim() || item.artifactId,
      eligibility: 'binding-missing',
      view: input.view,
    })),
  ];
  const allAssessments = [...evaluated.assessments, ...ineligible]
    .sort((left, right) =>
      left.artifactType.localeCompare(right.artifactType, 'en')
      || left.artifactId.localeCompare(right.artifactId, 'en')
      || left.unitType.localeCompare(right.unitType, 'en')
      || left.unitId.localeCompare(right.unitId, 'en')
      || left.assessmentId.localeCompare(right.assessmentId, 'en'));
  const assessments = allAssessments.slice(0, ARTIFACT_CANON_ASSESSMENT_INSPECTION_LIMIT);
  const countEligibility = (eligibility: ArtifactCanonAssessment['eligibility']) =>
    allAssessments.filter(item => item.eligibility === eligibility).length;
  const countStatus = (status: NonNullable<ArtifactCanonAssessment['status']>) =>
    allAssessments.filter(item => item.status === status).length;
  return structuredClone({
    schema: 'eyon.canon.artifact-assessment-inspection.v1' as const,
    comparedView: {
      branchId: input.view.branchId,
      viewId: input.view.viewId,
      resolvedRevision: input.view.resolvedRevision,
    },
    counts: {
      artifacts: records.length,
      assessments: allAssessments.length,
      returnedAssessments: assessments.length,
      omittedAssessments: Math.max(0, allAssessments.length - assessments.length),
      assessable: countEligibility('assessable'),
      unbound: countEligibility('unbound'),
      bindingMissing: countEligibility('binding-missing'),
      current: countStatus('current'),
      partiallyStale: countStatus('partially-stale'),
      stale: countStatus('stale'),
      orphaned: countStatus('orphaned'),
      uncertain: countStatus('uncertain'),
      failures: evaluated.failures.length,
    },
    assessments,
    failures: evaluated.failures,
  });
}

/**
 * P2-C 当前分支只读报告。它直接消费 branch head，不等待下一次生成刷新缓存。
 * 原稿与 binding 均不修改，明确失效也只形成消费结论。
 */
export function inspectArtifactCanonConsumption(input: {
  biographies: BiographyRecord[];
  genealogies: GenealogyRecord[];
  ruins: RuinCandidateRecord[];
  butterflies: ButterflyRecord[];
  branch: CanonBranch;
}): ArtifactCanonConsumptionInspection {
  const records = artifactBindingRecords(input, input.branch);
  const bindings = records.flatMap(record => record.bindings);
  const view = currentArtifactCanonAssessmentTarget({ bindings, branch: input.branch });
  const assessment = inspectArtifactCanonAssessments({ ...input, view });
  const decisions = decideArtifactCanonConsumptions(assessment.assessments);
  const actions = new Map(input.branch.actions.map(action => [action.actionId, action]));
  const deltas = new Map(input.branch.deltas.map(delta => [delta.deltaId, delta]));
  const changes = [...input.branch.revisions]
    .sort((left, right) => right.revision - left.revision)
    .slice(0, 128)
    .map(revision => {
      const action = actions.get(revision.actionId);
      const delta = deltas.get(revision.deltaId);
      return {
        revision: revision.revision,
        parentRevision: revision.parentRevision,
        status: revision.status,
        deltaStatus: delta?.status ?? 'missing' as const,
        actionId: revision.actionId,
        deltaId: revision.deltaId,
        assistantMessageId: revision.assistantMessageId,
        rawCommand: action?.rawCommand ?? '',
        actionRecord: action?.actionRecord ?? '',
        verified: delta?.verified ?? false,
        operations: (delta?.operations ?? []).map(operation => ({
          op: operation.op,
          factKey: operation.factKey,
          originalFactIds: [...operation.originalFactIds],
          currentFactId: operation.current.factId,
        })),
        createdAt: revision.createdAt,
        ...(revision.revertedAt === undefined ? {} : { revertedAt: revision.revertedAt }),
      };
    });
  const revisionCount = (status: CanonBranch['revisions'][number]['status']) =>
    input.branch.revisions.filter(item => item.status === status).length;
  const decisionCount = (disposition: ArtifactCanonConsumptionDecision['disposition']) =>
    decisions.filter(item => item.disposition === disposition).length;
  return structuredClone({
    schema: 'eyon.canon.artifact-consumption-inspection.v1' as const,
    branch: {
      branchId: input.branch.branchId,
      headRevision: input.branch.headRevision,
      updatedAt: input.branch.updatedAt,
      revisions: input.branch.revisions.length,
      active: revisionCount('active'),
      reverted: revisionCount('reverted'),
      orphaned: revisionCount('orphaned'),
    },
    changes,
    assessment,
    decisions,
    genealogyViews: input.genealogies.slice(-128).map(record => {
      const { artifactId, branchId, canonRevision, units } = buildGenealogyLocalView(record, input.branch);
      return { artifactId, branchId, canonRevision, units: units.slice(0, 256) };
    }),
    causalPreview: previewCanonCausalConflicts(input.branch),
    causalRebase: projectCanonCausalRebase(input.branch),
    causalReconciles: input.branch.receipts
      .filter(receipt => !!receipt.causalReconcile)
      .map(receipt => ({
        ...receipt.causalReconcile!,
        receiptId: receipt.receiptId,
        canonRevision: receipt.canonRevision,
      })),
    counts: {
      available: decisionCount('available'),
      availableWithWarning: decisionCount('available-with-warning'),
      excluded: decisionCount('excluded'),
      manualReview: decisionCount('manual-review'),
    },
  });
}

function artifactBindingRecords(input: {
  biographies: BiographyRecord[];
  genealogies: GenealogyRecord[];
  ruins: RuinCandidateRecord[];
  butterflies: ButterflyRecord[];
}, branch?: CanonBranch) {
  return [
    ...input.biographies.map(record => ({
      artifactType: 'biography' as const,
      artifactId: record.biographyId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.genealogies.map(record => ({
      artifactType: 'genealogy' as const,
      artifactId: record.requestId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.ruins.map(record => ({
      artifactType: 'ruin' as const,
      artifactId: record.requestId,
      bindings: record.canonBindings ?? [],
    })),
    ...input.butterflies.map(record => ({
      artifactType: 'butterfly' as const,
      artifactId: record.runId,
      bindings: butterflyAssessmentBindings(record, branch),
    })),
  ].sort((left, right) =>
    left.artifactType.localeCompare(right.artifactType, 'en')
    || left.artifactId.localeCompare(right.artifactId, 'en'));
}

/**
 * internal.81 及更早的蝴蝶档案只记录 deltaRef，binding 可能没有 operationRefs。
 * 评估时只读补齐这层关系；不改旧档案、不重算 bindingId，也不影响原始绑定诊断。
 */
function butterflyAssessmentBindings(
  record: ButterflyRecord,
  branch?: CanonBranch,
): ArtifactCanonBinding[] {
  const bindings = record.canonBindings ?? [];
  if (!branch || !record.deltaRef) return bindings;
  const delta = branch.deltas.find(item => item.deltaId === record.deltaRef);
  if (!delta) return bindings;
  const allRefs = delta.operations.map(operation => ({
    deltaId: delta.deltaId,
    factKey: operation.factKey,
  }));
  return bindings.map(binding => {
    const inferred = binding.unitType === 'action' || binding.unitType === 'panel'
      ? allRefs
      : binding.unitType === 'operation'
        ? allRefs.filter(ref => binding.unitId === `${ref.deltaId}:${ref.factKey}`)
        : [];
    if (inferred.length === 0) return binding;
    const operationRefs = uniqueOperationRefs([
      ...binding.operationRefs,
      ...inferred,
    ]);
    return { ...binding, operationRefs };
  });
}

function uniqueOperationRefs(
  refs: ArtifactCanonBinding['operationRefs'],
): ArtifactCanonBinding['operationRefs'] {
  const byKey = new Map<string, ArtifactCanonBinding['operationRefs'][number]>();
  for (const ref of refs) {
    byKey.set(`${ref.deltaId}\u0000${ref.factKey}`, ref);
  }
  return [...byKey.values()].sort((left, right) =>
    left.deltaId.localeCompare(right.deltaId, 'en')
    || left.factKey.localeCompare(right.factKey, 'en'));
}
