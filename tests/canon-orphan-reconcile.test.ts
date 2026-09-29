import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type {
  CommitCanonInterventionInput,
} from '../src/storage/canon.ts';
import type {
  CanonBranch,
  CanonFact,
} from '../src/retrieval/contracts.ts';
import { MemoryCanonRepository } from '../src/storage/canon.ts';
import {
  findOrphanedActiveMessageIds,
  reconcileCanonOrphans,
  runtimeMessageExistenceProbe,
} from '../src/runtime/canonOrphanReconcile.ts';

const namespace: WorkbenchNamespace = {
  characterKey: '伊雍',
  chatId: 'canon-orphan',
};

function intervention(input: {
  runId: string;
  assistantMessageId: number;
  year: number;
  now: number;
}): CommitCanonInterventionInput {
  const subject = `entity:generated:${encodeURIComponent(input.runId)}`;
  const timeLabel = `复兴纪元${input.year}年`;
  const fact: CanonFact = {
    factId: `fact:orphan:${input.runId}`,
    subjectEntityId: subject,
    predicate: 'historical_change',
    object: '测试干涉事实',
    statement: `${input.runId} 在复兴纪元${input.year}年改变了黄昏花室`,
    temporalScope: timeLabel,
    spatialScope: '黄昏花室',
    epistemicStatus: 'generated',
    confidence: 'medium',
    sourceRefs: [`chat:${input.assistantMessageId}`],
    sourceSnapshotIds: [],
    sourceSpans: [],
    revisionIntroduced: 0,
    revisionRetired: null,
  };
  return {
    namespace,
    action: {
      schema: 'eyon.canon.intervention-action.v1',
      runId: input.runId,
      userMessageId: input.assistantMessageId - 1,
      assistantMessageId: input.assistantMessageId,
      rawCommand: '遣返',
      actionRecord: `${input.runId} 在黄昏花室行动`,
      sourceRefs: [`chat:${input.assistantMessageId}`],
      occurredAt: { label: timeLabel },
      createdAt: input.now,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: timeLabel },
      operations: [{
        op: 'assert',
        factKey: `${subject}|historical_change|${timeLabel}`,
        originalFactIds: [],
        current: fact,
      }],
      preconditionFactIds: [],
      dependsOnDeltaIds: [],
      cascadeScope: {
        entityIds: [subject],
        locations: ['黄昏花室'],
      },
      preserves: ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: input.now,
    },
  };
}

test('孤儿判定：只返回宿主明确不存在的楼号；异常跳过；去重升序', async () => {
  const branch = {
    revisions: [
      { revision: 1, assistantMessageId: 52, status: 'active' as const },
      { revision: 2, assistantMessageId: 58, status: 'active' as const },
      { revision: 3, assistantMessageId: 58, status: 'active' as const },
      { revision: 4, assistantMessageId: 64, status: 'active' as const },
      { revision: 5, assistantMessageId: 55, status: 'reverted' as const },
      { revision: 6, assistantMessageId: 0, status: 'active' as const },
    ],
  } as unknown as CanonBranch;
  const orphans = await findOrphanedActiveMessageIds(branch, async messageId => {
    if (messageId === 52 || messageId === 58) return false;
    if (messageId === 64) return true;
    if (messageId === 70) throw new Error('probe failed');
    return true;
  });
  assert.deepEqual(orphans, [52, 58], '只含宿主明确不存在的楼号（去重、升序）');
});

test('孤儿判定：probe 抛错跳过该 id（宁漏勿错）', async () => {
  const branch = {
    revisions: [
      { revision: 1, assistantMessageId: 52, status: 'active' as const },
      { revision: 2, assistantMessageId: 58, status: 'active' as const },
    ],
  } as unknown as CanonBranch;
  const orphans = await findOrphanedActiveMessageIds(branch, async messageId => {
    if (messageId === 52) throw new Error('host unavailable');
    return messageId !== 58;
  });
  assert.deepEqual(orphans, [58], '52 查询异常应被跳过');
});

test('清扫：绑定楼已消失的 active 全部干净回滚，独立后继保持 active', async () => {
  const repository = new MemoryCanonRepository();
  await repository.commitIntervention(intervention({
    runId: 'a', assistantMessageId: 52, year: 320, now: 100,
  }));
  await repository.commitIntervention(intervention({
    runId: 'b', assistantMessageId: 58, year: 321, now: 200,
  }));
  await repository.commitIntervention(intervention({
    runId: 'c', assistantMessageId: 64, year: 322, now: 300,
  }));
  // 另加一条没有声明任何因果依赖、且「楼健在」的 active：清扫不得触碰。
  // P3-B 禁止仅凭修订先后把独立后继连坐为 orphaned。
  await repository.commitIntervention(intervention({
    runId: 'd', assistantMessageId: 70, year: 323, now: 400,
  }));

  const { orphanedMessageIds, receipts } = await reconcileCanonOrphans(
    repository,
    namespace,
    async messageId => messageId !== 52 && messageId !== 58 && messageId !== 64,
    500,
  );
  assert.deepEqual(orphanedMessageIds, [52, 58, 64]);
  assert.equal(receipts.length, 3, '三个孤儿楼各产生一次回滚回执');

  const branch = await repository.getBranch(namespace);
  const byRevision = new Map(branch.revisions.map(item => [item.revision, item.status]));
  assert.equal(byRevision.get(1), 'reverted', '绑 52 的 revision 应回滚');
  assert.equal(byRevision.get(2), 'reverted', '绑 58 的 revision 应回滚');
  assert.equal(byRevision.get(3), 'reverted', '绑 64 的 revision 应回滚');
  assert.equal(byRevision.get(4), 'active', '绑 70（楼健在）的独立 revision 应保持有效');
  assert.equal(branch.headRevision, 4);

  // 二次清扫幂等
  const second = await reconcileCanonOrphans(
    repository,
    namespace,
    async messageId => messageId !== 52 && messageId !== 58 && messageId !== 64,
    600,
  );
  assert.equal(second.receipts.length, 0, '二次清扫无变化');
  assert.equal((await repository.getBranch(namespace)).headRevision, 4);
});

test('清扫：绑定楼健在时完全不动', async () => {
  const repository = new MemoryCanonRepository();
  await repository.commitIntervention(intervention({
    runId: 'keep', assistantMessageId: 80, year: 330, now: 100,
  }));
  const { orphanedMessageIds, receipts } = await reconcileCanonOrphans(
    repository,
    namespace,
    async () => true,
    200,
  );
  assert.deepEqual(orphanedMessageIds, []);
  assert.equal(receipts.length, 0);
  const branch = await repository.getBranch(namespace);
  assert.equal(branch.revisions[0]?.status, 'active');
});

test('存在性探测适配：空列表=不存在；含目标=存在；宿主不可用=视为存在', () => {
  const probe = runtimeMessageExistenceProbe(messageId => {
    if (messageId === 0) return undefined; // 宿主不可用
    return messageId === 52
      ? [{ message_id: 52 }]
      : [];
  });
  assert.equal(probe(52), true);
  assert.equal(probe(58), false);
  assert.equal(probe(0), true, '宿主不可用 → 视为存在（防误杀）');
});
