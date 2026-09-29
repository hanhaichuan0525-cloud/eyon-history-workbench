import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type { CanonFact } from '../src/retrieval/contracts.ts';
import {
  MemoryCanonRepository,
  type CommitCanonInterventionInput,
} from '../src/storage/canon.ts';
import {
  MemoryButterflyRepository,
  type ButterflyRecord,
} from '../src/storage/butterflies.ts';
import { reconcileCanonOrphans } from '../src/runtime/canonOrphanReconcile.ts';
import { syncButterflyCanonStatuses } from '../src/runtime/canonRecordStatus.ts';

const namespace: WorkbenchNamespace = {
  characterKey: '伊雍',
  chatId: 'canon-record-status',
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
    factId: `fact:record-status:${input.runId}`,
    subjectEntityId: subject,
    predicate: 'historical_change',
    object: '测试干涉事实',
    statement: `${input.runId} 改变了第三麦庄`,
    temporalScope: timeLabel,
    spatialScope: '第三麦庄',
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
      actionRecord: `${input.runId} 在第三麦庄行动`,
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
      cascadeScope: { entityIds: [subject], locations: ['第三麦庄'] },
      preserves: ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: input.now,
    },
  };
}

function butterflyRecord(input: {
  runId: string;
  assistantMessageId: number;
  deltaRef?: string;
  canonStatus?: ButterflyRecord['canonStatus'];
  revision?: number;
}): ButterflyRecord {
  return {
    key: `butterfly:${input.runId}`,
    namespace,
    runId: input.runId,
    requestId: `request-${input.runId}`,
    request: {} as never,
    result: {} as never,
    sourceHash: 'hash',
    panel: '[标题|测试]',
    archiveEntry: '### 测试',
    assistantMessageId: input.assistantMessageId,
    status: 'committed',
    revision: input.revision ?? 1,
    ...(input.deltaRef ? { deltaRef: input.deltaRef } : {}),
    ...(input.canonStatus ? { canonStatus: input.canonStatus } : {}),
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ButterflyRecord;
}

test('G-12 回归：清扫路径回滚 canon 后，记录 canonStatus 被对齐为 reverted', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const first = await canon.commitIntervention(intervention({
    runId: 'aa', assistantMessageId: 52, year: 320, now: 100,
  }));
  const second = await canon.commitIntervention(intervention({
    runId: 'bb', assistantMessageId: 58, year: 321, now: 200,
  }));
  await butterflies.saveRecord(butterflyRecord({
    runId: 'aa', assistantMessageId: 52, deltaRef: first.delta.deltaId, canonStatus: 'active',
  }));
  await butterflies.saveRecord(butterflyRecord({
    runId: 'bb', assistantMessageId: 58, deltaRef: second.delta.deltaId, canonStatus: 'active',
  }));

  // F-03 清扫（批量删楼场景：宿主不派发 messageDeleted）只回滚 canon，不标记记录。
  const { receipts } = await reconcileCanonOrphans(canon, namespace, async () => false, 300);
  assert.equal(receipts.length, 2);
  const before = await butterflies.list(namespace);
  assert.ok(
    before.every(record => record.canonStatus === 'active'),
    '清扫本身不改记录（病历现场：字段停在旧值）',
  );

  // internal.87 修复入口：按当前分支状态对账。
  const result = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 400,
  });
  assert.equal(result.checked, 2);
  assert.equal(result.synced, 2);
  const after = await butterflies.list(namespace);
  const byRun = new Map(after.map(record => [record.runId, record]));
  assert.equal(byRun.get('aa')?.canonStatus, 'reverted');
  assert.equal(byRun.get('bb')?.canonStatus, 'reverted');
  // v21 闸判据：`canonStatus !== 'reverted'` 为 false ⇒ 该轮重新生成而非复用旧文本。
  assert.equal(
    byRun.get('aa')?.canonStatus !== 'reverted',
    false,
    'v21「reverted → 重新生成」闸应放行',
  );
});

test('对账幂等：状态一致不再写库；orphaned 如实对齐', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const kept = await canon.commitIntervention(intervention({
    runId: 'keep', assistantMessageId: 70, year: 322, now: 100,
  }));
  await butterflies.saveRecord(butterflyRecord({
    runId: 'keep', assistantMessageId: 70, deltaRef: kept.delta.deltaId, canonStatus: 'active',
  }));

  const first = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 200,
  });
  assert.equal(first.synced, 0, '状态一致时不写库');
  const record = (await butterflies.list(namespace))[0]!;

  // 模拟上游断裂：楼健在但更早的 active 被回滚 → 该 delta 孤儿化。
  await canon.rollbackByMessageId(namespace, 71, 300);
  const branch = await canon.getBranch(namespace);
  const orphanedDelta = branch.deltas.find(delta => delta.deltaId === kept.delta.deltaId);
  assert.equal(orphanedDelta?.status, 'active', '同楼回滚不影响该 delta（前置校验）');

  const second = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: {
      ...branch,
      deltas: branch.deltas.map(delta =>
        delta.deltaId === kept.delta.deltaId ? { ...delta, status: 'orphaned' as const } : delta),
    },
    now: 400,
  });
  assert.equal(second.synced, 1);
  const synced = (await butterflies.list(namespace))[0]!;
  assert.equal(synced.canonStatus, 'orphaned');
  assert.equal(synced.revision > record.revision, true, '写库时递增 revision');
});

test('对账留痕：附带回执写入受影响记录，receiptId 去重', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const target = await canon.commitIntervention(intervention({
    runId: 'cc', assistantMessageId: 90, year: 323, now: 100,
  }));
  await butterflies.saveRecord(butterflyRecord({
    runId: 'cc', assistantMessageId: 90, deltaRef: target.delta.deltaId, canonStatus: 'active',
  }));

  const rollback = await canon.rollbackByMessageId(namespace, 90, 200);
  assert.ok(rollback, '删楼回滚应产生回执');
  const first = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 300,
    receipt: rollback!.receipt,
  });
  assert.equal(first.synced, 1);
  const synced = (await butterflies.list(namespace))[0]!;
  assert.equal(synced.canonStatus, 'reverted');
  assert.equal(synced.canonReceipt?.receiptId, rollback!.receipt.receiptId, '回执落库留痕');

  const second = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 400,
    receipt: rollback!.receipt,
  });
  assert.equal(second.synced, 0, '同一回执不重复写库');
});

test('对账保守：缺 deltaRef 或分支里找不到 delta 时不臆断状态', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  await butterflies.saveRecord(butterflyRecord({
    runId: 'legacy', assistantMessageId: 95, canonStatus: 'active',
  }));
  await butterflies.saveRecord(butterflyRecord({
    runId: 'ghost', assistantMessageId: 96, deltaRef: 'delta:missing', canonStatus: 'active',
  }));

  const result = await syncButterflyCanonStatuses({
    repository: butterflies,
    namespace,
    branch: await canon.getBranch(namespace),
    now: 100,
  });
  assert.equal(result.checked, 2);
  assert.equal(result.synced, 0);
  const byRun = new Map((await butterflies.list(namespace)).map(record => [record.runId, record]));
  assert.equal(byRun.get('legacy')?.canonStatus, 'active');
  assert.equal(byRun.get('ghost')?.canonStatus, 'active');
});
