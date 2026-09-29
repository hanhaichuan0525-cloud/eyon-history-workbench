import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessArtifactCanonBinding,
  artifactCanonAssessmentTargetView,
  createIneligibleArtifactCanonAssessment,
} from '../src/core/artifactCanonAssessment.ts';
import { inspectArtifactCanonAssessments } from '../src/runtime/artifactCanonDiagnostics.ts';
import {
  clearCanonResolvedViewDiagnosticsForTest,
  latestArtifactCanonAssessmentTarget,
  recordCanonResolvedViewDiagnostic,
} from '../src/runtime/canonViewDiagnostics.ts';
import type {
  ArtifactCanonBinding,
  CanonBranch,
  CanonFact,
  CanonInactiveFact,
  CanonResolvedView,
  InterventionDelta,
} from '../src/retrieval/contracts.ts';

const F1 = fact('fact:one');
const F2 = fact('fact:two');

test('AS-01 同生成 revision 的事实与 operation 均有效，重复评估确定性等价', () => {
  const delta = operationDelta('delta:one', 1, F1);
  const branch = canonBranch([delta]);
  const view = canonView({
    active: [F1], revision: 1, appliedDeltaIds: [delta.deltaId],
  });
  const source = binding({ factIds: [F1.factId], operationRefs: [{
    deltaId: delta.deltaId, factKey: delta.operations[0]!.factKey,
  }] });
  const first = assessArtifactCanonBinding({ binding: source, view, branch });
  const second = assessArtifactCanonBinding({ binding: source, view, branch });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'current');
  assert.deepEqual(first.activeFactIds, [F1.factId]);
  assert.equal(first.activeOperationRefs.length, 1);
});

test('AS-02 revision 前进但无关 delta 不会把旧依赖判 stale', () => {
  const unrelated = operationDelta('delta:unrelated', 2, F2);
  const branch = canonBranch([unrelated]);
  const result = assessArtifactCanonBinding({
    binding: binding({ factIds: [F1.factId], boundRevision: 0 }),
    view: canonView({ active: [F1, F2], revision: 2, appliedDeltaIds: [unrelated.deltaId] }),
    branch,
  });
  assert.equal(result.status, 'current');
});

test('AS-03 单事实退休只使依赖它的局部单位 partially-stale', () => {
  const view = canonView({ active: [F2], inactive: [inactive(F1, 'delta:replace')], revision: 1 });
  const affected = assessArtifactCanonBinding({
    binding: binding({ unitId: 'affected', factIds: [F1.factId, F2.factId] }), view,
  });
  const sibling = assessArtifactCanonBinding({
    binding: binding({ unitId: 'sibling', factIds: [F2.factId] }), view,
  });
  assert.equal(affected.status, 'partially-stale');
  assert.equal(sibling.status, 'current');
});

test('AS-04 全部依赖确定性退休时仅局部 assessment 为 stale', () => {
  const source = binding({ factIds: [F1.factId, F2.factId] });
  const result = assessArtifactCanonBinding({
    binding: source,
    view: canonView({ inactive: [inactive(F1), inactive(F2)], revision: 2 }),
  });
  assert.equal(result.status, 'stale');
  assert.deepEqual(source.factIds, [F1.factId, F2.factId]);
});

test('AS-05 明确上游 orphaned 时只把依赖 operation 的单位判 orphaned', () => {
  const upstream = { ...operationDelta('delta:upstream', 1, F1), status: 'orphaned' as const };
  const dependent = {
    ...operationDelta('delta:dependent', 2, F2),
    dependsOnDeltaIds: [upstream.deltaId],
  };
  const branch = canonBranch([upstream, dependent], {
    'delta:upstream': 'orphaned',
    'delta:dependent': 'active',
  });
  const result = assessArtifactCanonBinding({
    binding: binding({ factIds: [], operationRefs: [{
      deltaId: dependent.deltaId,
      factKey: dependent.operations[0]!.factKey,
    }] }),
    view: canonView({ active: [F2], revision: 2, appliedDeltaIds: [dependent.deltaId] }),
    branch,
  });
  assert.equal(result.status, 'orphaned');
  assert.equal(result.reasons[0]?.code, 'operation-orphaned');
});

test('AS-06 不在完整比较结果中的 fact 与不可识别 operation 均保持 uncertain', () => {
  const result = assessArtifactCanonBinding({
    binding: binding({
      factIds: ['fact:missing'],
      operationRefs: [{ deltaId: 'delta:missing', factKey: 'missing|state|now' }],
    }),
    view: canonView({ revision: 3 }),
    branch: canonBranch([]),
  });
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.unresolvedFactIds, ['fact:missing']);
  assert.ok(result.reasons.some(item => item.code === 'operation-unresolved'));
});

test('AS-07 unbound 与 binding-missing 不产生五态 assessment', () => {
  const view = canonView({ revision: 0 });
  const unbound = createIneligibleArtifactCanonAssessment({
    artifactType: 'biography', artifactId: 'legacy', unitType: 'artifact', unitId: 'legacy',
    eligibility: 'unbound', view,
  });
  const missing = createIneligibleArtifactCanonAssessment({
    artifactType: 'biography', artifactId: 'partial', unitType: 'stage', unitId: 's1',
    eligibility: 'binding-missing', view,
  });
  assert.equal(unbound.status, undefined);
  assert.equal(missing.status, undefined);
  assert.equal(unbound.bindingId, undefined);

  const inspection = inspectArtifactCanonAssessments({
    biographies: [{ biographyId: 'legacy' } as never],
    genealogies: [], ruins: [], butterflies: [],
    view: artifactCanonAssessmentTargetView(view), branch: canonBranch([]),
  });
  assert.equal(inspection.counts.unbound, 1);
  assert.equal(inspection.counts.current, 0);
});

test('AS-08 跨分支目标视图不会借用另一分支事实', () => {
  const result = assessArtifactCanonBinding({
    binding: binding({ factIds: [F1.factId], branchId: 'branch:a' }),
    view: canonView({ active: [F1], branchId: 'branch:b' }),
    branch: canonBranch([], {}, 'branch:b'),
  });
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.unresolvedFactIds, [F1.factId]);
  assert.equal(result.reasons[0]?.code, 'branch-mismatch');
  const emptyDependency = assessArtifactCanonBinding({
    binding: binding({ factIds: [], branchId: 'branch:a' }),
    view: canonView({ branchId: 'branch:b' }),
  });
  assert.equal(emptyDependency.status, 'uncertain');
});

test('AS-09 回滚后重新计算恢复 current，不改写 binding 或旧 assessment', () => {
  const source = binding({ factIds: [F1.factId] });
  const changed = assessArtifactCanonBinding({
    binding: source,
    view: canonView({ inactive: [inactive(F1)], revision: 1 }),
  });
  const rolledBack = assessArtifactCanonBinding({
    binding: source,
    view: canonView({ active: [F1], revision: 0, viewId: 'view:rollback' }),
  });
  assert.equal(changed.status, 'stale');
  assert.equal(rolledBack.status, 'current');
  assert.equal(changed.status, 'stale');
  assert.deepEqual(source.factIds, [F1.factId]);
});

test('AS-10 sourceRefs 不参与裁决，合法空依赖绑定为 current', () => {
  const view = canonView({ active: [F1] });
  const first = assessArtifactCanonBinding({
    binding: binding({ factIds: [F1.factId], sourceRefs: ['source:old'] }), view,
  });
  const second = assessArtifactCanonBinding({
    binding: binding({ factIds: [F1.factId], sourceRefs: ['source:new'] }), view,
  });
  const empty = assessArtifactCanonBinding({ binding: binding({ factIds: [] }), view });
  assert.equal(first.status, 'current');
  assert.equal(second.status, 'current');
  assert.equal(empty.status, 'current');
});

test('P2-B 只读诊断只缓存无正文目标投影，并可按 requestId 选择', () => {
  clearCanonResolvedViewDiagnosticsForTest();
  const view = canonView({ active: [F1], revision: 4, viewId: 'view:diagnostic' });
  recordCanonResolvedViewDiagnostic({ requestId: 'request:one', taskType: 'ruin', view });
  const target = latestArtifactCanonAssessmentTarget({
    branchId: view.branchId,
    requestId: 'request:one',
  });
  assert.deepEqual(target?.activeFactIds, [F1.factId]);
  assert.equal(JSON.stringify(target).includes(F1.statement), false);
  assert.equal(latestArtifactCanonAssessmentTarget({
    branchId: view.branchId,
    requestId: 'request:missing',
  }), null);
});

function fact(factId: string): CanonFact {
  return {
    factId, subjectEntityId: `entity:${factId}`, predicate: 'state', object: factId,
    statement: `statement:${factId}`, temporalScope: null, spatialScope: null,
    epistemicStatus: 'explicit', confidence: 'high', sourceRefs: [`source:${factId}`],
    sourceSnapshotIds: [], sourceSpans: [], revisionIntroduced: 0, revisionRetired: null,
  };
}

function inactive(source: CanonFact, deltaId = 'delta:retire'): CanonInactiveFact {
  return {
    fact: { ...source, revisionRetired: 1 }, retiredByDeltaId: deltaId,
    reason: 'replace:state',
  };
}

function binding(input: {
  unitId?: string;
  factIds?: string[];
  operationRefs?: ArtifactCanonBinding['operationRefs'];
  branchId?: string;
  boundRevision?: number;
  sourceRefs?: string[];
} = {}): ArtifactCanonBinding {
  return {
    schema: 'eyon.canon.artifact-binding.v1', bindingId: `binding:${input.unitId ?? 'unit'}`,
    branchId: input.branchId ?? 'branch:a', artifactType: 'biography', artifactId: 'bio:one',
    unitType: 'stage', unitId: input.unitId ?? 'unit',
    boundView: { viewId: 'view:bound', resolvedRevision: input.boundRevision ?? 0, queryScopeHash: 'scope' },
    entityIds: [], factIds: input.factIds ?? [], operationRefs: input.operationRefs ?? [],
    sourceRefs: input.sourceRefs ?? [], createdAt: 1,
  };
}

function canonView(input: {
  active?: CanonFact[];
  inactive?: CanonInactiveFact[];
  revision?: number;
  appliedDeltaIds?: string[];
  supersededDeltaIds?: string[];
  branchId?: string;
  viewId?: string;
}): CanonResolvedView {
  const revision = input.revision ?? 0;
  const branchId = input.branchId ?? 'branch:a';
  return {
    schema: 'eyon.canon.resolved-view.v1', viewId: input.viewId ?? `view:${revision}`,
    branchId, requestedRevision: revision, resolvedRevision: revision, queryScopeHash: 'scope',
    activeFacts: input.active ?? [], inactiveFacts: input.inactive ?? [], uncertainItems: [],
    eventRelations: [], personViews: [], passageViews: [],
    resolutionReceipt: {
      schema: 'eyon.canon.resolve-receipt.v1', branchId, requestedRevision: revision,
      resolvedRevision: revision, queryScopeHash: 'scope',
      appliedDeltaIds: input.appliedDeltaIds ?? [], skippedDeltaIds: [],
      supersededDeltaIds: input.supersededDeltaIds ?? [], uncertainItems: [],
    },
  };
}

function operationDelta(deltaId: string, revision: number, current: CanonFact): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1', deltaId, branchId: 'branch:a', revision,
    parentRevision: Math.max(0, revision - 1), actionRef: `action:${deltaId}`,
    effectiveFrom: { label: '现在' },
    operations: [{ op: 'assert', factKey: `${current.subjectEntityId}|state|now`, originalFactIds: [], current }],
    preconditionFactIds: [], dependsOnDeltaIds: [],
    cascadeScope: { entityIds: [current.subjectEntityId], locations: [] },
    preserves: [], supersedesDeltaIds: [], status: 'active', verified: true, createdAt: revision,
  };
}

function canonBranch(
  deltas: InterventionDelta[],
  revisionStatuses: Record<string, 'active' | 'reverted' | 'orphaned'> = {},
  branchId = 'branch:a',
): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1', branchId, characterKey: '伊雍', chatId: 'chat',
    headRevision: Math.max(0, ...deltas.filter(delta =>
      (revisionStatuses[delta.deltaId] ?? 'active') === 'active').map(delta => delta.revision)),
    revisions: deltas.map(delta => ({
      revision: delta.revision, parentRevision: delta.parentRevision,
      actionId: delta.actionRef, deltaId: delta.deltaId, assistantMessageId: delta.revision,
      status: revisionStatuses[delta.deltaId] ?? 'active', receiptId: `receipt:${delta.deltaId}`,
      createdAt: delta.createdAt,
    })),
    actions: [], deltas: deltas.map(delta => ({ ...delta, branchId })), receipts: [],
    createdAt: 0, updatedAt: 0,
  };
}
