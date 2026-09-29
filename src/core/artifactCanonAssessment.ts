import {
  ARTIFACT_CANON_ASSESSMENT_SCHEMA,
  type ArtifactCanonAssessment,
  type ArtifactCanonBinding,
  type CanonBranch,
  type CanonResolvedView,
} from '../retrieval/contracts.ts';
import {
  operationRebaseState,
  projectCanonCausalRebase,
  type CanonCausalRebaseProjection,
} from './causalRebase.ts';

type OperationRef = ArtifactCanonBinding['operationRefs'][number];
type AssessmentReason = ArtifactCanonAssessment['reasons'][number];

/**
 * 诊断只需保留 CanonResolvedView 的身份、事实集合和 resolution receipt；
 * 不复制事实陈述、passage 或 prompt 正文。
 */
export interface ArtifactCanonAssessmentTargetView {
  branchId: string;
  viewId: string;
  resolvedRevision: number;
  activeFactIds: string[];
  inactiveFactIds: string[];
  resolutionReceipt: {
    appliedDeltaIds: string[];
    skippedDeltaIds: string[];
    supersededDeltaIds: string[];
    uncertainItems: string[];
  };
}

export interface ArtifactCanonAssessmentDiagnostic {
  code: 'assessment-failed';
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  unitType: string;
  unitId: string;
  bindingId?: string;
  message: string;
}

export function artifactCanonAssessmentTargetView(
  view: CanonResolvedView,
): ArtifactCanonAssessmentTargetView {
  return {
    branchId: view.branchId,
    viewId: view.viewId,
    resolvedRevision: view.resolvedRevision,
    activeFactIds: uniqueSorted(view.activeFacts.map(fact => fact.factId)),
    inactiveFactIds: uniqueSorted(view.inactiveFacts.map(item => item.fact.factId)),
    resolutionReceipt: {
      appliedDeltaIds: uniqueSorted(view.resolutionReceipt.appliedDeltaIds),
      skippedDeltaIds: uniqueSorted(view.resolutionReceipt.skippedDeltaIds),
      supersededDeltaIds: uniqueSorted(view.resolutionReceipt.supersededDeltaIds),
      uncertainItems: uniqueSorted(view.resolutionReceipt.uncertainItems),
    },
  };
}

/**
 * P2-B 的唯一状态裁决函数。纯确定性、只读、无模型、无网络、无正文解析。
 */
export function assessArtifactCanonBinding(input: {
  binding: ArtifactCanonBinding;
  view: CanonResolvedView | ArtifactCanonAssessmentTargetView;
  branch?: CanonBranch;
}): ArtifactCanonAssessment {
  const binding = structuredClone(input.binding);
  const view = normalizeTargetView(input.view);
  const branch = input.branch ? structuredClone(input.branch) : undefined;
  const causalRebase = branch ? projectCanonCausalRebase(branch) : undefined;
  assertBindingIdentity(binding);

  const activeFactSet = new Set(view.activeFactIds);
  const inactiveFactSet = new Set(view.inactiveFactIds);
  const activeFactIds: string[] = [];
  const inactiveFactIds: string[] = [];
  const unresolvedFactIds: string[] = [];
  const activeOperationRefs: OperationRef[] = [];
  const inactiveOperationRefs: OperationRef[] = [];
  const reasons: AssessmentReason[] = [];
  let orphanedOperation = false;
  let unresolvedOperation = false;

  const comparisonViewIncomplete = !view.branchId.trim()
    || !view.viewId.trim()
    || !Number.isInteger(view.resolvedRevision)
    || view.resolvedRevision < 0;
  const branchMismatch = binding.branchId !== view.branchId
    || (branch !== undefined && branch.branchId !== view.branchId);
  if (branchMismatch || comparisonViewIncomplete) {
    unresolvedFactIds.push(...binding.factIds);
    unresolvedOperation = binding.operationRefs.length > 0;
    reasons.push({
      code: branchMismatch ? 'branch-mismatch' : 'comparison-view-incomplete',
    });
  } else {
    for (const factId of uniqueSorted(binding.factIds)) {
      const active = activeFactSet.has(factId);
      const inactive = inactiveFactSet.has(factId);
      if (active && !inactive) {
        activeFactIds.push(factId);
      } else if (inactive && !active) {
        inactiveFactIds.push(factId);
        reasons.push({ code: 'fact-inactive', factId });
      } else {
        unresolvedFactIds.push(factId);
        reasons.push({
          code: active && inactive ? 'fact-status-conflict' : 'fact-unresolved',
          factId,
        });
      }
    }

    for (const operationRef of uniqueOperationRefs(binding.operationRefs)) {
      const state = classifyOperation(
        operationRef,
        view,
        branch,
        causalRebase,
        activeFactSet,
        inactiveFactSet,
      );
      if (state === 'active') {
        activeOperationRefs.push(operationRef);
      } else if (state === 'inactive') {
        inactiveOperationRefs.push(operationRef);
        reasons.push({ code: 'operation-inactive', ...operationRef });
      } else if (state === 'orphaned') {
        orphanedOperation = true;
        inactiveOperationRefs.push(operationRef);
        reasons.push({ code: 'operation-orphaned', ...operationRef });
      } else {
        unresolvedOperation = true;
        reasons.push({ code: 'operation-unresolved', ...operationRef });
      }
    }
  }

  const activeCount = activeFactIds.length + activeOperationRefs.length;
  const inactiveCount = inactiveFactIds.length + inactiveOperationRefs.length;
  const dependencyCount = binding.factIds.length + binding.operationRefs.length;
  let status: NonNullable<ArtifactCanonAssessment['status']>;
  if (orphanedOperation) {
    status = 'orphaned';
  } else if (branchMismatch || comparisonViewIncomplete
    || unresolvedFactIds.length > 0 || unresolvedOperation) {
    status = 'uncertain';
  } else if (dependencyCount === 0 || inactiveCount === 0) {
    status = 'current';
  } else if (activeCount === 0) {
    status = 'stale';
  } else {
    status = 'partially-stale';
  }

  return finalizeAssessment({
    schema: ARTIFACT_CANON_ASSESSMENT_SCHEMA,
    bindingId: binding.bindingId,
    artifactType: binding.artifactType,
    artifactId: binding.artifactId,
    unitType: binding.unitType,
    unitId: binding.unitId,
    comparedView: comparedView(view),
    eligibility: 'assessable',
    status,
    activeFactIds,
    inactiveFactIds,
    unresolvedFactIds,
    activeOperationRefs,
    inactiveOperationRefs,
    reasons,
  });
}

export function createIneligibleArtifactCanonAssessment(input: {
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  unitType: string;
  unitId: string;
  eligibility: 'unbound' | 'binding-missing';
  view: CanonResolvedView | ArtifactCanonAssessmentTargetView;
}): ArtifactCanonAssessment {
  const view = normalizeTargetView(input.view);
  if (!input.artifactId.trim() || !input.unitType.trim() || !input.unitId.trim()) {
    throw new Error('Artifact assessment unit identity is empty');
  }
  return finalizeAssessment({
    schema: ARTIFACT_CANON_ASSESSMENT_SCHEMA,
    artifactType: input.artifactType,
    artifactId: input.artifactId,
    unitType: input.unitType,
    unitId: input.unitId,
    comparedView: comparedView(view),
    eligibility: input.eligibility,
    activeFactIds: [],
    inactiveFactIds: [],
    unresolvedFactIds: [],
    activeOperationRefs: [],
    inactiveOperationRefs: [],
    reasons: [{ code: input.eligibility }],
  });
}

export function assessArtifactCanonBindingsSafely(input: {
  bindings: ArtifactCanonBinding[];
  view: CanonResolvedView | ArtifactCanonAssessmentTargetView;
  branch?: CanonBranch;
}): {
  assessments: ArtifactCanonAssessment[];
  failures: ArtifactCanonAssessmentDiagnostic[];
} {
  const assessments: ArtifactCanonAssessment[] = [];
  const failures: ArtifactCanonAssessmentDiagnostic[] = [];
  for (const binding of input.bindings) {
    try {
      assessments.push(assessArtifactCanonBinding({
        binding,
        view: input.view,
        branch: input.branch,
      }));
    } catch (error) {
      failures.push({
        code: 'assessment-failed',
        artifactType: binding.artifactType,
        artifactId: binding.artifactId,
        unitType: binding.unitType,
        unitId: binding.unitId,
        bindingId: binding.bindingId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    assessments: assessments.sort(compareAssessments),
    failures: failures.sort(compareFailures).slice(0, 64),
  };
}

function classifyOperation(
  operationRef: OperationRef,
  view: ArtifactCanonAssessmentTargetView,
  branch: CanonBranch | undefined,
  causalRebase: CanonCausalRebaseProjection | undefined,
  activeFactIds: Set<string>,
  inactiveFactIds: Set<string>,
): 'active' | 'inactive' | 'orphaned' | 'unresolved' {
  if (!branch) return 'unresolved';
  const delta = branch.deltas.find(item => item.deltaId === operationRef.deltaId);
  if (!delta || delta.branchId !== view.branchId) return 'unresolved';
  const operation = delta.operations.find(item => item.factKey === operationRef.factKey);
  if (!operation) return 'unresolved';
  const revision = branch.revisions.find(item => item.deltaId === delta.deltaId);
  if (causalRebase?.status === 'projected') {
    const state = operationRebaseState(causalRebase, operationRef);
    if (state === 'orphaned') return 'orphaned';
    if (state === 'superseded' || state === 'reverted') return 'inactive';
    if (state === 'uncertain' || state === undefined) return 'unresolved';
  }
  if (delta.status === 'reverted' || revision?.status === 'reverted'
    || delta.status === 'superseded'
    || view.resolutionReceipt.supersededDeltaIds.includes(delta.deltaId)
    || delta.revision > view.resolvedRevision) {
    return 'inactive';
  }
  if (!delta.verified) return 'unresolved';
  if (!view.resolutionReceipt.appliedDeltaIds.includes(delta.deltaId)) {
    return 'unresolved';
  }
  if (causalRebase?.status !== 'projected') {
    const laterAppliedSameKey = branch.deltas.some(candidate =>
      candidate.deltaId !== delta.deltaId
      && candidate.revision > delta.revision
      && candidate.revision <= view.resolvedRevision
      && view.resolutionReceipt.appliedDeltaIds.includes(candidate.deltaId)
      && candidate.operations.some(candidateOperation =>
        candidateOperation.factKey === operationRef.factKey));
    if (laterAppliedSameKey) return 'inactive';
  }
  if (operation.op === 'retract') return 'active';
  const currentFactId = operation.current.factId;
  if (activeFactIds.has(currentFactId) && !inactiveFactIds.has(currentFactId)) return 'active';
  if (inactiveFactIds.has(currentFactId) && !activeFactIds.has(currentFactId)) return 'inactive';
  return 'unresolved';
}

function normalizeTargetView(
  view: CanonResolvedView | ArtifactCanonAssessmentTargetView,
): ArtifactCanonAssessmentTargetView {
  return 'activeFacts' in view
    ? artifactCanonAssessmentTargetView(view)
    : {
      branchId: view.branchId,
      viewId: view.viewId,
      resolvedRevision: view.resolvedRevision,
      activeFactIds: uniqueSorted(view.activeFactIds),
      inactiveFactIds: uniqueSorted(view.inactiveFactIds),
      resolutionReceipt: {
        appliedDeltaIds: uniqueSorted(view.resolutionReceipt.appliedDeltaIds),
        skippedDeltaIds: uniqueSorted(view.resolutionReceipt.skippedDeltaIds),
        supersededDeltaIds: uniqueSorted(view.resolutionReceipt.supersededDeltaIds),
        uncertainItems: uniqueSorted(view.resolutionReceipt.uncertainItems),
      },
    };
}

function comparedView(view: ArtifactCanonAssessmentTargetView) {
  return {
    branchId: view.branchId,
    viewId: view.viewId,
    resolvedRevision: view.resolvedRevision,
  };
}

function finalizeAssessment(
  input: Omit<ArtifactCanonAssessment, 'assessmentId'>,
): ArtifactCanonAssessment {
  const canonical = {
    ...input,
    activeFactIds: uniqueSorted(input.activeFactIds),
    inactiveFactIds: uniqueSorted(input.inactiveFactIds),
    unresolvedFactIds: uniqueSorted(input.unresolvedFactIds),
    activeOperationRefs: uniqueOperationRefs(input.activeOperationRefs),
    inactiveOperationRefs: uniqueOperationRefs(input.inactiveOperationRefs),
    reasons: uniqueReasons(input.reasons).slice(0, 64),
  };
  return {
    ...canonical,
    assessmentId: `artifact-assessment:${fingerprint(JSON.stringify(canonical))}`,
  };
}

function assertBindingIdentity(binding: ArtifactCanonBinding): void {
  if (!binding.bindingId.trim() || !binding.branchId.trim()
    || !binding.artifactId.trim() || !binding.unitType.trim() || !binding.unitId.trim()) {
    throw new Error('Artifact binding identity is incomplete');
  }
}

function uniqueOperationRefs(values: OperationRef[]): OperationRef[] {
  const unique = new Map<string, OperationRef>();
  for (const value of values) {
    const normalized = { deltaId: value.deltaId.trim(), factKey: value.factKey.trim() };
    unique.set(`${normalized.deltaId}\u0000${normalized.factKey}`, normalized);
  }
  return [...unique.values()]
    .filter(value => value.deltaId && value.factKey)
    .sort(compareOperationRefs);
}

function uniqueReasons(values: AssessmentReason[]): AssessmentReason[] {
  const unique = new Map(values.map(value => [JSON.stringify(value), value]));
  return [...unique.values()].sort((left, right) =>
    compareText(left.code, right.code)
    || compareText(left.factId ?? '', right.factId ?? '')
    || compareText(left.deltaId ?? '', right.deltaId ?? '')
    || compareText(left.factKey ?? '', right.factKey ?? ''));
}

function compareOperationRefs(left: OperationRef, right: OperationRef): number {
  return compareText(left.deltaId, right.deltaId) || compareText(left.factKey, right.factKey);
}

function compareAssessments(left: ArtifactCanonAssessment, right: ArtifactCanonAssessment): number {
  return compareText(left.artifactType, right.artifactType)
    || compareText(left.artifactId, right.artifactId)
    || compareText(left.unitType, right.unitType)
    || compareText(left.unitId, right.unitId)
    || compareText(left.assessmentId, right.assessmentId);
}

function compareFailures(
  left: ArtifactCanonAssessmentDiagnostic,
  right: ArtifactCanonAssessmentDiagnostic,
): number {
  return compareText(left.artifactType, right.artifactType)
    || compareText(left.artifactId, right.artifactId)
    || compareText(left.unitType, right.unitType)
    || compareText(left.unitId, right.unitId);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
