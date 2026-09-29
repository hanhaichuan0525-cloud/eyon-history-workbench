import assert from 'node:assert/strict';
import test from 'node:test';

import {
  currentArtifactCanonAssessmentTarget,
  decideArtifactCanonConsumption,
} from '../src/core/artifactCanonConsumption.ts';
import {
  assessArtifactCanonBinding,
  createIneligibleArtifactCanonAssessment,
} from '../src/core/artifactCanonAssessment.ts';
import { inspectArtifactCanonConsumption } from '../src/runtime/artifactCanonDiagnostics.ts';
import type {
  ArtifactCanonBinding,
  CanonBranch,
  CanonFact,
  InterventionDelta,
} from '../src/retrieval/contracts.ts';

const F1 = fact('fact:old');
const F2 = fact('fact:stable');
const F3 = fact('fact:new', 1);

test('PC-01 当前 head 投影无需等待下一次生成即可反映 replace', () => {
  const delta = replaceDelta(F1, F3);
  const target = currentArtifactCanonAssessmentTarget({
    bindings: [binding({ factIds: [F1.factId, F2.factId] })],
    branch: branch({ delta }),
  });
  assert.equal(target.resolvedRevision, 1);
  assert.deepEqual(target.activeFactIds, [F2.factId, F3.factId].sort());
  assert.deepEqual(target.inactiveFactIds, [F1.factId]);
});

test('PC-02 无关 revision 不会阻断旧局部单位', () => {
  const unrelated = assertDelta(fact('fact:unrelated', 1));
  const source = binding({ factIds: [F1.factId] });
  const currentBranch = branch({ delta: unrelated });
  const assessment = assessArtifactCanonBinding({
    binding: source,
    view: currentArtifactCanonAssessmentTarget({ bindings: [source], branch: currentBranch }),
    branch: currentBranch,
  });
  assert.equal(decideArtifactCanonConsumption(assessment).disposition, 'available');
});

test('PC-03 部分事实失效只警告并保留单位', () => {
  const delta = replaceDelta(F1, F3);
  const source = binding({ factIds: [F1.factId, F2.factId] });
  const currentBranch = branch({ delta });
  const assessment = assessArtifactCanonBinding({
    binding: source,
    view: currentArtifactCanonAssessmentTarget({ bindings: [source], branch: currentBranch }),
    branch: currentBranch,
  });
  const decision = decideArtifactCanonConsumption(assessment);
  assert.equal(assessment.status, 'partially-stale');
  assert.equal(decision.disposition, 'available-with-warning');
  assert.equal(decision.excludesAutomaticReuse, false);
});

test('PC-04 全部依赖失效时只阻止该单位自动复用', () => {
  const delta = replaceDelta(F1, F3);
  const source = binding({ factIds: [F1.factId] });
  const sibling = binding({ unitId: 'sibling', factIds: [F2.factId] });
  const currentBranch = branch({ delta });
  const view = currentArtifactCanonAssessmentTarget({ bindings: [source, sibling], branch: currentBranch });
  const affected = decideArtifactCanonConsumption(assessArtifactCanonBinding({
    binding: source, view, branch: currentBranch,
  }));
  const unaffected = decideArtifactCanonConsumption(assessArtifactCanonBinding({
    binding: sibling, view, branch: currentBranch,
  }));
  assert.equal(affected.disposition, 'excluded');
  assert.equal(unaffected.disposition, 'available');
});

test('PC-05 orphaned operation 明确阻止自动复用但不改写 binding', () => {
  const delta = { ...assertDelta(F3), status: 'orphaned' as const };
  const source = binding({ factIds: [], operationRefs: [{
    deltaId: delta.deltaId, factKey: delta.operations[0]!.factKey,
  }] });
  const currentBranch = branch({ delta, revisionStatus: 'orphaned', headRevision: 0 });
  const before = structuredClone(source);
  const decision = decideArtifactCanonConsumption(assessArtifactCanonBinding({
    binding: source,
    view: currentArtifactCanonAssessmentTarget({ bindings: [source], branch: currentBranch }),
    branch: currentBranch,
  }));
  assert.equal(decision.disposition, 'excluded');
  assert.deepEqual(source, before);
});

test('PC-06 uncertain 永远进入人工判断而非脚本判废', () => {
  const source = binding({ factIds: ['fact:unknown'], branchId: 'branch:other' });
  const assessment = assessArtifactCanonBinding({
    binding: source,
    view: currentArtifactCanonAssessmentTarget({ bindings: [], branch: branch({}) }),
    branch: branch({}),
  });
  const decision = decideArtifactCanonConsumption(assessment);
  assert.equal(decision.disposition, 'manual-review');
  assert.equal(decision.excludesAutomaticReuse, false);
});

test('PC-07 unbound/binding-missing 不会被自动排除', () => {
  const view = currentArtifactCanonAssessmentTarget({ bindings: [], branch: branch({}) });
  for (const eligibility of ['unbound', 'binding-missing'] as const) {
    const assessment = createIneligibleArtifactCanonAssessment({
      artifactType: 'ruin', artifactId: eligibility, unitType: 'artifact',
      unitId: eligibility, eligibility, view,
    });
    assert.equal(decideArtifactCanonConsumption(assessment).disposition, 'manual-review');
  }
});

test('PC-08 回滚后原事实立即恢复 current', () => {
  const delta = { ...replaceDelta(F1, F3), status: 'reverted' as const };
  const source = binding({ factIds: [F1.factId] });
  const rolledBack = branch({ delta, revisionStatus: 'reverted', headRevision: 0 });
  const assessment = assessArtifactCanonBinding({
    binding: source,
    view: currentArtifactCanonAssessmentTarget({ bindings: [source], branch: rolledBack }),
    branch: rolledBack,
  });
  assert.equal(assessment.status, 'current');
});

test('PC-09 只读报告同时暴露变更日志、operation 与局部消费结论', () => {
  const delta = replaceDelta(F1, F3);
  const source = binding({ factIds: [F1.factId] });
  const report = inspectArtifactCanonConsumption({
    biographies: [{ biographyId: 'bio:one', canonBindings: [source] } as never],
    genealogies: [], ruins: [], butterflies: [], branch: branch({ delta }),
  });
  assert.equal(report.branch.headRevision, 1);
  assert.equal(report.changes[0]?.actionRecord, '玩家改变了一项历史事实');
  assert.equal(report.changes[0]?.operations[0]?.op, 'replace');
  assert.equal(report.counts.excluded, 1);
});

test('PC-10 相同输入的投影与消费报告确定性等价', () => {
  const delta = replaceDelta(F1, F3);
  const source = binding({ factIds: [F1.factId, F2.factId] });
  const currentBranch = branch({ delta });
  const input = {
    biographies: [{ biographyId: 'bio:one', canonBindings: [source] } as never],
    genealogies: [], ruins: [], butterflies: [], branch: currentBranch,
  };
  assert.deepEqual(
    inspectArtifactCanonConsumption(input),
    inspectArtifactCanonConsumption(input),
  );
});

test('PC-11 蝴蝶产出操作回滚后立即失效，旧档案可由 deltaRef 兼容补全', () => {
  const activeDelta = assertDelta(F3);
  const legacyBinding: ArtifactCanonBinding = {
    ...binding({ factIds: [] }),
    bindingId: 'binding:legacy-butterfly',
    artifactType: 'butterfly',
    artifactId: 'run:one',
    unitType: 'operation',
    unitId: `${activeDelta.deltaId}:${activeDelta.operations[0]!.factKey}`,
    operationRefs: [],
  };
  const artifact = {
    runId: 'run:one',
    deltaRef: activeDelta.deltaId,
    canonBindings: [legacyBinding],
  } as never;
  const active = inspectArtifactCanonConsumption({
    biographies: [], genealogies: [], ruins: [], butterflies: [artifact],
    branch: branch({ delta: activeDelta }),
  });
  assert.equal(active.decisions[0]?.disposition, 'available');

  const revertedDelta = { ...activeDelta, status: 'reverted' as const };
  const reverted = inspectArtifactCanonConsumption({
    biographies: [], genealogies: [], ruins: [], butterflies: [artifact],
    branch: branch({ delta: revertedDelta, revisionStatus: 'reverted', headRevision: 0 }),
  });
  assert.equal(reverted.decisions[0]?.disposition, 'excluded');
  assert.equal(reverted.decisions[0]?.excludesAutomaticReuse, true);
  assert.deepEqual(legacyBinding.operationRefs, []);
});

function fact(factId: string, revisionIntroduced = 0): CanonFact {
  return {
    factId, subjectEntityId: 'entity:one', predicate: 'state', object: factId,
    statement: factId, temporalScope: null, spatialScope: null,
    epistemicStatus: 'explicit', confidence: 'high', sourceRefs: ['chat:1'],
    sourceSnapshotIds: [], sourceSpans: [], revisionIntroduced, revisionRetired: null,
  };
}

function binding(input: {
  unitId?: string;
  factIds?: string[];
  operationRefs?: ArtifactCanonBinding['operationRefs'];
  branchId?: string;
}): ArtifactCanonBinding {
  return {
    schema: 'eyon.canon.artifact-binding.v1', bindingId: `binding:${input.unitId ?? 'one'}`,
    branchId: input.branchId ?? 'branch:one', artifactType: 'biography', artifactId: 'bio:one',
    unitType: 'stage', unitId: input.unitId ?? 'one',
    boundView: { viewId: 'view:bound', resolvedRevision: 0, queryScopeHash: 'scope' },
    entityIds: ['entity:one'], factIds: input.factIds ?? [],
    operationRefs: input.operationRefs ?? [], sourceRefs: ['chat:1'], createdAt: 1,
  };
}

function replaceDelta(original: CanonFact, current: CanonFact): InterventionDelta {
  return {
    ...assertDelta(current),
    operations: [{
      op: 'replace', factKey: 'entity:one|state|now',
      originalFactIds: [original.factId], current,
    }],
  };
}

function assertDelta(current: CanonFact): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1', deltaId: 'delta:one', branchId: 'branch:one',
    revision: 1, parentRevision: 0, actionRef: 'action:one', effectiveFrom: { label: '现在' },
    operations: [{ op: 'assert', factKey: 'entity:one|state|now', originalFactIds: [], current }],
    preconditionFactIds: [], dependsOnDeltaIds: [],
    cascadeScope: { entityIds: ['entity:one'], locations: [] },
    preserves: [], supersedesDeltaIds: [], status: 'active', verified: true, createdAt: 1,
  };
}

function branch(input: {
  delta?: InterventionDelta;
  revisionStatus?: 'active' | 'reverted' | 'orphaned';
  headRevision?: number;
}): CanonBranch {
  const delta = input.delta;
  const revisionStatus = input.revisionStatus ?? 'active';
  return {
    schema: 'eyon.canon.branch.v1', branchId: 'branch:one', characterKey: '伊雍', chatId: 'chat',
    headRevision: input.headRevision ?? (delta && revisionStatus === 'active' ? 1 : 0),
    revisions: delta ? [{
      revision: 1, parentRevision: 0, actionId: 'action:one', deltaId: delta.deltaId,
      assistantMessageId: 2, status: revisionStatus, receiptId: 'receipt:one', createdAt: 1,
    }] : [],
    actions: delta ? [{
      schema: 'eyon.canon.intervention-action.v1', actionId: 'action:one', branchId: 'branch:one',
      runId: 'run:one', userMessageId: 1, assistantMessageId: 2,
      rawCommand: '改变历史', actionRecord: '玩家改变了一项历史事实', sourceRefs: ['chat:1'],
      occurredAt: { label: '现在' }, createdAt: 1,
    }] : [],
    deltas: delta ? [{ ...delta, branchId: 'branch:one' }] : [],
    receipts: [], createdAt: 0, updatedAt: delta ? 1 : 0,
  };
}
