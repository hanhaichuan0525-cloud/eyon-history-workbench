import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerationAdapter } from '../src/adapters/host.ts';
import { operationRebaseState, projectCanonCausalRebase } from '../src/core/causalRebase.ts';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type { CanonFact, CanonOperationRef } from '../src/retrieval/contracts.ts';
import {
  MemoryCanonRepository,
  type CommitCanonInterventionInput,
} from '../src/storage/canon.ts';
import { reconcileCanonIntervention } from '../src/workflows/canonReconcile.ts';

const namespace: WorkbenchNamespace = { characterKey: '伊雍', chatId: 'p3-c' };

test('CR-29 确定性无冲突严格零模型调用', async () => {
  const repository = new MemoryCanonRepository();
  let calls = 0;
  const intervention = directIntervention('d1', 10, 'fact:unrelated', []);
  const result = await reconcileCanonIntervention({
    repository,
    intervention,
    generator: generator(async () => {
      calls += 1;
      return '{}';
    }),
  });
  assert.equal(calls, 0);
  assert.equal(result.causalReconcilePlan, undefined);
});

test('CR-20/30 坏句柄局部丢弃，两个合法提案同事务落盘且只计一次协调', async () => {
  const repository = await seededRepository();
  let calls = 0;
  const intervention = replacementIntervention('d2', 20);
  const prepared = await reconcileCanonIntervention({
    repository,
    intervention,
    generator: generator(async () => {
      calls += 1;
      return JSON.stringify({
        schema: 'eyon.canon.reconcile-proposal.v1',
        proposals: [
          { target: 'O99', decision: 'retire', sources: ['R1'] },
          {
            target: 'O1', decision: 'reconnect', inputs: ['N1'],
            claim: '新的获释状态使第一个后果仍能成立', sources: ['R1'],
          },
          { target: 'O2', decision: 'retire', claim: '第二个后果不再成立', sources: ['R1'] },
        ],
      });
    }),
  });
  assert.equal(calls, 1);
  assert.ok(prepared.causalReconcilePlan);
  const committed = await repository.commitIntervention(prepared);
  const receipt = committed.receipt.causalReconcile;
  assert.equal(receipt?.status, 'partial');
  assert.equal(receipt?.modelCalls, 1);
  assert.equal(receipt?.repairCalls, 0);
  assert.equal(receipt?.acceptedProposalCount, 2);
  assert.equal(receipt?.droppedProposalCount, 1);

  const projection = projectCanonCausalRebase(committed.branch);
  assert.equal(operationRebaseState(projection, oldRef(committed.branch, 'child-a')), 'active');
  assert.equal(operationRebaseState(projection, oldRef(committed.branch, 'child-b')), 'orphaned');
});

test('结构信封只允许一次 repair，成功后记录 repairCalls=1', async () => {
  const repository = await seededRepository();
  let calls = 0;
  const prepared = await reconcileCanonIntervention({
    repository,
    intervention: replacementIntervention('d2-repair', 30),
    generator: generator(async () => {
      calls += 1;
      if (calls === 1) return 'not json';
      return JSON.stringify({
        schema: 'eyon.canon.reconcile-proposal.v1',
        proposals: [
          { target: 'O1', decision: 'uncertain', claim: '证据不足', sources: ['R1'] },
          { target: 'O2', decision: 'retire', claim: '旧后果终止', sources: ['R1'] },
        ],
      });
    }),
  });
  assert.equal(calls, 2);
  const committed = await repository.commitIntervention(prepared);
  assert.equal(committed.receipt.causalReconcile?.modelCalls, 1);
  assert.equal(committed.receipt.causalReconcile?.repairCalls, 1);
});

test('CR-21 模型失败不截断提交，局部结果进入 uncertain', async () => {
  const repository = await seededRepository();
  const prepared = await reconcileCanonIntervention({
    repository,
    intervention: replacementIntervention('d2-fail', 40),
    generator: generator(async () => {
      throw new Error('upstream timeout');
    }),
  });
  const committed = await repository.commitIntervention(prepared);
  assert.equal(committed.receipt.causalReconcile?.status, 'failed');
  assert.equal(committed.receipt.causalReconcile?.failureCode, 'RECONCILE_GENERATION_FAILED');
  const projection = projectCanonCausalRebase(committed.branch);
  assert.equal(operationRebaseState(projection, oldRef(committed.branch, 'child-a')), 'uncertain');
  assert.equal(operationRebaseState(projection, oldRef(committed.branch, 'child-b')), 'uncertain');
  assert.equal(committed.receipt.resolutionMode, 'safe-with-uncertainty');
});

test('P3-C 回滚当前协调 revision 后，旧支撑与旧结果自动恢复', async () => {
  const repository = await seededRepository();
  const prepared = await reconcileCanonIntervention({
    repository,
    intervention: replacementIntervention('d2-rollback', 50),
    generator: generator(async () => JSON.stringify({
      schema: 'eyon.canon.reconcile-proposal.v1',
      proposals: [
        { target: 'O1', decision: 'retire', sources: ['R1'] },
        { target: 'O2', decision: 'retire', sources: ['R1'] },
      ],
    })),
  });
  await repository.commitIntervention(prepared);
  const rolled = await repository.rollbackByMessageId(namespace, 50, 999);
  assert.ok(rolled);
  const projection = projectCanonCausalRebase(rolled!.branch);
  assert.equal(operationRebaseState(projection, oldRef(rolled!.branch, 'root')), 'active');
  assert.equal(operationRebaseState(projection, oldRef(rolled!.branch, 'child-a')), 'active');
  assert.equal(operationRebaseState(projection, oldRef(rolled!.branch, 'child-b')), 'active');
});

test('R3 型本次新生孤儿结果可进入协调，直接行动根仍受保护且回滚可恢复', async () => {
  const repository = await rootOnlyRepository();
  let calls = 0;
  const prepared = await reconcileCanonIntervention({
    repository,
    intervention: currentOrphanIntervention('r3-current', 60),
    generator: generator(async () => {
      calls += 1;
      return JSON.stringify({
        schema: 'eyon.canon.reconcile-proposal.v1',
        proposals: [
          {
            target: 'O1', decision: 'reconnect', inputs: ['N1'],
            claim: '新的获释状态重新支撑后续报业活动', sources: ['R1'],
          },
        ],
      });
    }),
  });
  assert.equal(calls, 1);
  assert.deepEqual(prepared.causalReconcilePlan?.consideredTargets, [
    { kind: 'current', factKey: 'current-child' },
  ]);

  const committed = await repository.commitIntervention(prepared);
  const currentDelta = committed.delta.deltaId;
  const projection = projectCanonCausalRebase(committed.branch);
  assert.equal(operationRebaseState(projection, { deltaId: currentDelta, factKey: 'root' }), 'active');
  assert.equal(
    operationRebaseState(projection, { deltaId: currentDelta, factKey: 'current-child' }),
    'active',
  );
  assert.deepEqual(committed.receipt.causalReconcile?.consideredOperationRefs, [
    { deltaId: currentDelta, factKey: 'current-child' },
  ]);

  const rolled = await repository.rollbackByMessageId(namespace, 60, 999);
  assert.ok(rolled);
  const rolledProjection = projectCanonCausalRebase(rolled!.branch);
  assert.equal(operationRebaseState(rolledProjection, oldRef(rolled!.branch, 'root')), 'active');
  assert.equal(
    rolled!.branch.revisions.find(revision => revision.deltaId === currentDelta)?.status,
    'reverted',
  );
});

async function seededRepository(): Promise<MemoryCanonRepository> {
  const repository = new MemoryCanonRepository();
  const root = fact('fact:root', 'custody_status', '玲山正在服刑');
  const childA = fact('fact:child-a', 'historical_change', '旧报社路线继续发展');
  const childB = fact('fact:child-b', 'historical_change', '旧政治联盟继续存在');
  await repository.commitIntervention({
    namespace,
    action: action('d1', 9, 10),
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '复兴纪元480年' },
      operations: [
        operation('root', root, []),
        operation('child-a', childA, []),
        operation('child-b', childB, []),
      ],
      preconditionFactIds: [], dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:玲山'], locations: ['梵尼亚'] },
      preserves: ['player-action-record'], supersedesDeltaIds: [],
      status: 'active', verified: true, createdAt: 10,
    },
    causalPlan: {
      directOperationFactKeys: ['root'],
      supports: [
        {
          inputRefs: [{ kind: 'operation', factKey: 'root' }],
          outputFactKey: 'child-a', claimText: '服刑状态支撑旧报社路线', sourceRefs: ['chat:10'],
        },
        {
          inputRefs: [{ kind: 'operation', factKey: 'root' }],
          outputFactKey: 'child-b', claimText: '服刑状态支撑旧政治联盟', sourceRefs: ['chat:10'],
        },
      ],
    },
  });
  return repository;
}

async function rootOnlyRepository(): Promise<MemoryCanonRepository> {
  const repository = new MemoryCanonRepository();
  await repository.commitIntervention({
    namespace,
    action: action('r3-base', 58, 59),
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '复兴纪元480年' },
      operations: [operation('root', fact('fact:root', 'custody_status', '玲山正在服刑'), [])],
      preconditionFactIds: [], dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:玲山'], locations: ['梵尼亚'] },
      preserves: ['player-action-record'], supersedesDeltaIds: [],
      status: 'active', verified: true, createdAt: 59,
    },
    causalPlan: { directOperationFactKeys: ['root'], supports: [] },
  });
  return repository;
}

function currentOrphanIntervention(
  runId: string,
  assistantMessageId: number,
): CommitCanonInterventionInput {
  return {
    namespace,
    action: action(runId, assistantMessageId - 1, assistantMessageId),
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '复兴纪元481年' },
      operations: [
        operation(
          'root',
          fact(`fact:${runId}:root`, 'custody_status', '玲山已经越狱'),
          ['fact:root'],
        ),
        operation(
          'current-child',
          fact(`fact:${runId}:child`, 'historical_change', '玲山在帝国继续报业活动'),
          [],
        ),
      ],
      preconditionFactIds: [], dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:玲山'], locations: ['梵尼亚'] },
      preserves: ['player-action-record'], supersedesDeltaIds: [],
      status: 'active', verified: true, createdAt: assistantMessageId,
    },
    causalPlan: {
      directOperationFactKeys: ['root'],
      supports: [{
        inputRefs: [{ kind: 'fact', factId: 'fact:root' }],
        outputFactKey: 'current-child',
        claimText: '旧监禁状态支撑后续活动',
        sourceRefs: [`chat:${assistantMessageId}`],
      }],
    },
  };
}

function replacementIntervention(runId: string, assistantMessageId: number): CommitCanonInterventionInput {
  return {
    namespace,
    action: action(runId, assistantMessageId - 1, assistantMessageId),
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: '复兴纪元481年' },
      operations: [operation(
        'root',
        fact(`fact:${runId}:root`, 'custody_status', '玲山已经越狱'),
        ['fact:root'],
      )],
      preconditionFactIds: ['fact:root'], dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:玲山'], locations: ['梵尼亚'] },
      preserves: ['player-action-record'], supersedesDeltaIds: [],
      status: 'active', verified: true, createdAt: assistantMessageId,
    },
    causalPlan: { directOperationFactKeys: ['root'], supports: [] },
  };
}

function directIntervention(
  runId: string,
  assistantMessageId: number,
  factId: string,
  originalFactIds: string[],
): CommitCanonInterventionInput {
  return {
    namespace,
    action: action(runId, assistantMessageId - 1, assistantMessageId),
    delta: {
      schema: 'eyon.canon.intervention-delta.v1', effectiveFrom: { label: '复兴纪元481年' },
      operations: [operation('unrelated', fact(factId, 'historical_change', '无关变化'), originalFactIds)],
      preconditionFactIds: [], dependsOnDeltaIds: [],
      cascadeScope: { entityIds: ['entity:other'], locations: ['别处'] },
      preserves: ['player-action-record'], supersedesDeltaIds: [],
      status: 'active', verified: true, createdAt: assistantMessageId,
    },
    causalPlan: { directOperationFactKeys: ['unrelated'], supports: [] },
  };
}

function action(runId: string, userMessageId: number, assistantMessageId: number) {
  return {
    schema: 'eyon.canon.intervention-action.v1' as const,
    runId, userMessageId, assistantMessageId, rawCommand: '遣返',
    actionRecord: '玩家明确改变了玲山的监禁状态',
    sourceRefs: [`chat:${assistantMessageId}`],
    occurredAt: { label: '复兴纪元481年' }, createdAt: assistantMessageId,
  };
}

function fact(factId: string, predicate: string, statement: string): CanonFact {
  return {
    factId, subjectEntityId: 'entity:玲山', predicate, object: statement, statement,
    temporalScope: '复兴纪元481年', spatialScope: '梵尼亚',
    epistemicStatus: 'generated', confidence: 'medium', sourceRefs: ['chat:10'],
    sourceSnapshotIds: [], sourceSpans: [], revisionIntroduced: 0, revisionRetired: null,
  };
}

function operation(factKey: string, current: CanonFact, originalFactIds: string[]) {
  return { op: originalFactIds.length > 0 ? 'replace' as const : 'assert' as const, factKey, originalFactIds, current };
}

function generator(generate: () => Promise<string>): GenerationAdapter {
  return { generate: async () => generate() };
}

function oldRef(branch: Awaited<ReturnType<MemoryCanonRepository['getBranch']>>, factKey: string): CanonOperationRef {
  return { deltaId: branch.deltas[0]!.deltaId, factKey };
}
