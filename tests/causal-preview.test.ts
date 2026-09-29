import assert from 'node:assert/strict';
import test from 'node:test';

import { previewCanonCausalConflicts } from '../src/core/causalPreview.ts';
import { MemoryCanonRepository } from '../src/storage/canon.ts';
import type {
  CanonBranch,
  CanonCausalSupportUnit,
  CanonFact,
  InterventionDelta,
} from '../src/retrieval/contracts.ts';

test('P3-A 无冲突时零影响且不修改原分支', () => {
  const current = branch([baseDelta()]);
  const before = structuredClone(current);
  const preview = previewCanonCausalConflicts(current);
  assert.equal(preview.status, 'no-conflict');
  assert.equal(preview.modelCalls, 0);
  assert.equal(preview.counts.conflictRoots, 0);
  assert.deepEqual(current, before);
});

test('P3-A 明确替换根操作后，只读预演沿唯一支撑标出断裂', () => {
  const preview = previewCanonCausalConflicts(branch([baseDelta(), replacementDelta()]));
  assert.equal(preview.status, 'conflict-preview');
  assert.equal(preview.counts.conflictRoots > 0, true);
  assert.equal(preview.supports.find(item => item.supportId === 'support:one')?.status, 'broken');
  assert.equal(
    preview.affectedOperations.find(item => item.operationRef.factKey === 'entity:child|state|now')?.state,
    'would-be-orphaned',
  );
});

test('P3-A 替代支撑仍成立时在该节点停止，不把后续误判为断裂', () => {
  const first = baseDelta(true);
  const preview = previewCanonCausalConflicts(branch([first, replacementDelta()]));
  assert.equal(preview.supports.find(item => item.supportId === 'support:one')?.status, 'broken');
  assert.equal(preview.supports.find(item => item.supportId === 'support:alternative')?.status, 'satisfied');
  assert.equal(
    preview.affectedOperations.find(item => item.operationRef.factKey === 'entity:child|state|now')?.state,
    'would-remain-active',
  );
  assert.equal(preview.stopPoints.some(item => item.reason === 'alternative-support-survives'), true);
});

test('P3-A 旧 delta 没有因果元数据时兼容为 opaque，不报错不判废', () => {
  const legacy = baseDelta();
  delete legacy.causalBasis;
  delete legacy.causalSupportUnits;
  const preview = previewCanonCausalConflicts(branch([legacy]));
  assert.equal(preview.status, 'no-conflict');
  assert.equal(preview.counts.opaqueOperations, 2);
  assert.deepEqual(preview.affectedOperations, []);
});

test('P3-A 单条坏支撑局部降级为 opaque，不能截断 Canon 提交', async () => {
  const repository = new MemoryCanonRepository();
  const result = await repository.commitIntervention({
    namespace: { characterKey: '伊雍', chatId: 'chat:bad-support' },
    action: {
      schema: 'eyon.canon.intervention-action.v1',
      runId: 'run:bad-support',
      userMessageId: 1,
      assistantMessageId: 2,
      rawCommand: '改变历史',
      actionRecord: '改变历史',
      sourceRefs: ['chat:1'],
      occurredAt: { label: '407年' },
      createdAt: 1,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '407年' },
      operations: [
        { op: 'assert', factKey: 'root', originalFactIds: [], current: fact('fact:root', 0) },
        { op: 'assert', factKey: 'child', originalFactIds: [], current: fact('fact:child', 0) },
      ],
      preconditionFactIds: [],
      dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:root', 'entity:child'], locations: [] },
      preserves: [],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: 1,
    },
    causalPlan: {
      directOperationFactKeys: ['root'],
      supports: [{
        inputRefs: [{ kind: 'operation', factKey: 'missing' }],
        outputFactKey: 'child',
        claimText: '这条支撑含有坏引用',
        sourceRefs: ['chat:1'],
      }],
    },
  });
  assert.equal(result.branch.headRevision, 1);
  assert.equal(result.delta.causalBasis?.find(item =>
    item.operationRef.factKey === 'root')?.basis, 'direct');
  assert.deepEqual(result.delta.causalBasis?.find(item =>
    item.operationRef.factKey === 'child'), {
    basis: 'opaque',
    operationRef: { deltaId: result.delta.deltaId, factKey: 'child' },
    reason: 'causal-support-unresolved',
  });
  assert.deepEqual(result.delta.causalSupportUnits, []);
});

function baseDelta(withAlternative = false): InterventionDelta {
  const deltaId = 'delta:one';
  const rootRef = { deltaId, factKey: 'entity:root|state|now' };
  const childRef = { deltaId, factKey: 'entity:child|state|now' };
  const supports: CanonCausalSupportUnit[] = [
    {
      schema: 'eyon.canon.causal-support.v1',
      supportId: 'support:one',
      branchId: 'branch:one',
      introducedRevision: 1,
      introducedByDeltaId: deltaId,
      inputRefs: [{ kind: 'operation', operationRef: rootRef }],
      outputRef: { kind: 'operation', operationRef: childRef },
      claimText: '根事实支撑后续结果',
      sourceRefs: ['chat:1'],
    },
  ];
  if (withAlternative) {
    supports.push({
      schema: 'eyon.canon.causal-support.v1',
      supportId: 'support:alternative',
      branchId: 'branch:one',
      introducedRevision: 1,
      introducedByDeltaId: deltaId,
      inputRefs: [{ kind: 'action', actionId: 'action:one' }],
      outputRef: { kind: 'operation', operationRef: childRef },
      claimText: '另一路直接行动仍可支撑结果',
      sourceRefs: ['chat:1'],
    });
  }
  return {
    schema: 'eyon.canon.intervention-delta.v1',
    deltaId,
    branchId: 'branch:one',
    revision: 1,
    parentRevision: 0,
    actionRef: 'action:one',
    effectiveFrom: { label: '407年' },
    operations: [
      { op: 'assert', factKey: rootRef.factKey, originalFactIds: [], current: fact('fact:root', 1) },
      { op: 'assert', factKey: childRef.factKey, originalFactIds: [], current: fact('fact:child', 1) },
    ],
    causalBasis: [
      { basis: 'direct', operationRef: rootRef },
      {
        basis: 'supported', operationRef: childRef,
        supportIds: supports.map(support => support.supportId),
      },
    ],
    causalSupportUnits: supports,
    preconditionFactIds: [],
    dependsOnDeltaIds: [],
    cascadeScope: { entityIds: ['entity:root', 'entity:child'], locations: [] },
    preserves: [],
    supersedesDeltaIds: [],
    status: 'active',
    verified: true,
    createdAt: 1,
  };
}

function replacementDelta(): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1',
    deltaId: 'delta:two',
    branchId: 'branch:one',
    revision: 2,
    parentRevision: 1,
    actionRef: 'action:two',
    effectiveFrom: { label: '409年' },
    operations: [{
      op: 'replace',
      factKey: 'entity:root|state|now',
      originalFactIds: ['fact:root'],
      current: fact('fact:replacement', 2),
    }],
    causalBasis: [{
      basis: 'direct',
      operationRef: { deltaId: 'delta:two', factKey: 'entity:root|state|now' },
    }],
    causalSupportUnits: [],
    preconditionFactIds: ['fact:root'],
    dependsOnDeltaIds: [],
    cascadeScope: { entityIds: ['entity:root'], locations: [] },
    preserves: [],
    supersedesDeltaIds: [],
    status: 'active',
    verified: true,
    createdAt: 2,
  };
}

function fact(factId: string, revisionIntroduced: number): CanonFact {
  return {
    factId,
    subjectEntityId: factId.includes('child') ? 'entity:child' : 'entity:root',
    predicate: 'state',
    object: factId,
    statement: factId,
    temporalScope: null,
    spatialScope: null,
    epistemicStatus: 'generated',
    confidence: 'medium',
    sourceRefs: ['chat:1'],
    sourceSnapshotIds: [],
    sourceSpans: [],
    revisionIntroduced,
    revisionRetired: null,
  };
}

function branch(deltas: InterventionDelta[]): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1',
    branchId: 'branch:one',
    characterKey: '伊雍',
    chatId: 'chat',
    headRevision: deltas.length,
    revisions: deltas.map(delta => ({
      revision: delta.revision,
      parentRevision: delta.parentRevision,
      actionId: delta.actionRef,
      deltaId: delta.deltaId,
      assistantMessageId: delta.revision,
      status: 'active',
      receiptId: `receipt:${delta.revision}`,
      createdAt: delta.createdAt,
    })),
    actions: deltas.map(delta => ({
      schema: 'eyon.canon.intervention-action.v1',
      actionId: delta.actionRef,
      branchId: 'branch:one',
      runId: `run:${delta.revision}`,
      userMessageId: delta.revision,
      assistantMessageId: delta.revision,
      rawCommand: '改变历史',
      actionRecord: '改变历史',
      sourceRefs: ['chat:1'],
      occurredAt: delta.effectiveFrom,
      createdAt: delta.createdAt,
    })),
    deltas,
    receipts: [],
    createdAt: 0,
    updatedAt: deltas.at(-1)?.createdAt ?? 0,
  };
}
