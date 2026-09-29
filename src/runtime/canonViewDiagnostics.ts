import type {
  CanonResolvedView,
  RetrievalTaskType,
} from '../retrieval/contracts.ts';
import {
  artifactCanonAssessmentTargetView,
  type ArtifactCanonAssessmentTargetView,
} from '../core/artifactCanonAssessment.ts';

export interface CanonResolvedViewDiagnostic {
  recordedAt: number;
  requestId: string;
  taskType: RetrievalTaskType;
  viewId: string;
  branchId: string;
  requestedRevision: number;
  resolvedRevision: number;
  queryScopeHash: string;
  counts: {
    activeFacts: number;
    inactiveFacts: number;
    uncertainItems: number;
    personViews: number;
    passageViews: number;
  };
  appliedDeltaIds: string[];
  skippedDeltaIds: string[];
  uncertainItems: string[];
}

const MAX_CANON_VIEW_DIAGNOSTICS = 32;
const diagnostics: CanonResolvedViewDiagnostic[] = [];
const assessmentTargets: Array<{
  recordedAt: number;
  requestId: string;
  taskType: RetrievalTaskType;
  view: ArtifactCanonAssessmentTargetView;
}> = [];

/** 只保存身份与计数，不复制世界书正文或 prompt。 */
export function recordCanonResolvedViewDiagnostic(input: {
  requestId: string;
  taskType: RetrievalTaskType;
  view: CanonResolvedView;
}): void {
  const recordedAt = Date.now();
  diagnostics.push({
    recordedAt,
    requestId: input.requestId,
    taskType: input.taskType,
    viewId: input.view.viewId,
    branchId: input.view.branchId,
    requestedRevision: input.view.requestedRevision,
    resolvedRevision: input.view.resolvedRevision,
    queryScopeHash: input.view.queryScopeHash,
    counts: {
      activeFacts: input.view.activeFacts.length,
      inactiveFacts: input.view.inactiveFacts.length,
      uncertainItems: input.view.uncertainItems.length,
      personViews: input.view.personViews.length,
      passageViews: input.view.passageViews.length,
    },
    appliedDeltaIds: [...input.view.resolutionReceipt.appliedDeltaIds],
    skippedDeltaIds: [...input.view.resolutionReceipt.skippedDeltaIds],
    uncertainItems: [...input.view.uncertainItems],
  });
  if (diagnostics.length > MAX_CANON_VIEW_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_CANON_VIEW_DIAGNOSTICS);
  }
  assessmentTargets.push({
    recordedAt,
    requestId: input.requestId,
    taskType: input.taskType,
    view: artifactCanonAssessmentTargetView(input.view),
  });
  if (assessmentTargets.length > MAX_CANON_VIEW_DIAGNOSTICS) {
    assessmentTargets.splice(0, assessmentTargets.length - MAX_CANON_VIEW_DIAGNOSTICS);
  }
}

export function listCanonResolvedViewDiagnostics(): CanonResolvedViewDiagnostic[] {
  return structuredClone(diagnostics);
}

/** 只向 P2-B 返回无正文的视图投影；可按 requestId 复验特定任务。 */
export function latestArtifactCanonAssessmentTarget(input: {
  branchId: string;
  requestId?: string;
}): ArtifactCanonAssessmentTargetView | null {
  const match = [...assessmentTargets].reverse().find(item =>
    item.view.branchId === input.branchId
    && (!input.requestId || item.requestId === input.requestId));
  return match ? structuredClone(match.view) : null;
}

export function clearCanonResolvedViewDiagnosticsForTest(): void {
  diagnostics.splice(0, diagnostics.length);
  assessmentTargets.splice(0, assessmentTargets.length);
}
