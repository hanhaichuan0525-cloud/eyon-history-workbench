import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type { CanonFact } from '../src/retrieval/contracts.ts';
import {
  MemoryCanonRepository,
  type CanonRepository,
  type CommitCanonInterventionInput,
} from '../src/storage/canon.ts';
import {
  MemoryButterflyRepository,
  type ButterflyRecord,
} from '../src/storage/butterflies.ts';
import {
  buildButterflySourceScope,
  loadCurrentButterflySources,
} from '../src/runtime/butterflySources.ts';

/**
 * internal.87 · 蓝图 §6 步 B：蝴蝶史料源从世界书镜像迁到本地记录 + 唯一当前视图投影。
 * 这里锁住四件事：有效片段入选、已回滚片段剔除、未归档/无 deltaRef 记录剔除、
 * 以及作用域并集不会把 delta 提前筛掉。
 */

const namespace: WorkbenchNamespace = {
  characterKey: '伊雍',
  chatId: 'butterfly-sources',
};

function intervention(input: {
  runId: string;
  assistantMessageId: number;
  location: string;
  subjectName: string;
}): CommitCanonInterventionInput {
  const subject = `entity:generated:${encodeURIComponent(input.subjectName)}`;
  const timeLabel = '复兴纪元321年';
  const fact: CanonFact = {
    factId: `fact:${input.runId}`,
    subjectEntityId: subject,
    predicate: 'historical_change',
    object: '改写历史',
    statement: `${input.subjectName} 在 ${input.location} 被改写`,
    temporalScope: timeLabel,
    spatialScope: input.location,
    epistemicStatus: 'generated',
    confidence: 'medium',
    sourceRefs: ['chat:8'],
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
      actionRecord: `${input.runId} 行动记录`,
      sourceRefs: ['chat:8'],
      occurredAt: { label: timeLabel },
      createdAt: 100,
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
        locations: [input.location],
        subjectNames: [input.subjectName],
      },
      preserves: ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: 100,
    },
  };
}

function record(input: {
  runId: string;
  deltaRef?: string;
  canonRevision?: number;
  status?: ButterflyRecord['status'];
  title: string;
}): ButterflyRecord {
  return {
    key: `butterfly:${input.runId}`,
    namespace,
    runId: input.runId,
    requestId: `request-${input.runId}`,
    request: {} as never,
    result: {} as never,
    sourceHash: 'hash',
    panel: `[标题|${input.title}]`,
    archiveEntry: `### ${input.title}\n档案正文`,
    assistantMessageId: 60,
    status: input.status ?? 'committed',
    revision: 1,
    ...(input.deltaRef ? { deltaRef: input.deltaRef } : {}),
    ...(input.canonRevision !== undefined ? { canonRevision: input.canonRevision } : {}),
    createdAt: 0,
    updatedAt: 0,
  } as unknown as ButterflyRecord;
}

test('蝴蝶源：只放行当前视图里仍被应用的 delta（已回滚/未归档/旧档案剔除）', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const kept = await canon.commitIntervention(intervention({
    runId: 'keep', assistantMessageId: 60, location: '第三麦庄', subjectName: '托马斯',
  }));
  const dropped = await canon.commitIntervention(intervention({
    runId: 'dropped', assistantMessageId: 61, location: '金谷城', subjectName: '贝瑟那',
  }));
  await butterflies.saveRecord(record({
    runId: 'keep', deltaRef: kept.delta.deltaId, canonRevision: 1, title: '《保留案》',
  }));
  await butterflies.saveRecord(record({
    runId: 'dropped', deltaRef: dropped.delta.deltaId, canonRevision: 2, title: '《回滚案》',
  }));
  await butterflies.saveRecord(record({
    runId: 'validating', deltaRef: kept.delta.deltaId, canonRevision: 3,
    status: 'validated', title: '《未归档》',
  }));
  await butterflies.saveRecord(record({ runId: 'legacy', title: '《镜像时代旧档案》' }));

  // 回滚后一条：其 delta 变 reverted，不得再作为史料候选。
  await canon.rollbackByMessageId(namespace, 61, 200);

  const sources = await loadCurrentButterflySources({
    butterflies,
    canon,
    namespace,
  });
  assert.deepEqual(sources.map(source => source.sourceId), ['butterfly:keep']);
  assert.equal(sources[0]?.title, '《保留案》');
  assert.match(sources[0]?.content ?? '', /档案正文/u);
});

test('蝴蝶源：无记录、无分支或投影失败时返回空（不退回镜像）', async () => {
  const canon = new MemoryCanonRepository();
  const empty = new MemoryButterflyRepository();
  assert.deepEqual(
    await loadCurrentButterflySources({ butterflies: empty, canon, namespace }),
    [],
  );

  const butterflies = new MemoryButterflyRepository();
  await butterflies.saveRecord(record({
    runId: 'ghost', deltaRef: 'delta:missing', canonRevision: 1, title: '《幽灵》',
  }));
  assert.deepEqual(
    await loadCurrentButterflySources({ butterflies, canon, namespace }),
    [],
    '分支为空 / delta 缺失时宁缺勿错',
  );
});

test('蝴蝶源：全部回退（head=0）返回空且不抛错；partially-active 不进候选', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const only = await canon.commitIntervention(intervention({
    runId: 'sole', assistantMessageId: 80, location: '草料库', subjectName: '托马斯',
  }));
  await butterflies.saveRecord(record({
    runId: 'sole', deltaRef: only.delta.deltaId, canonRevision: 1, title: '《唯一案》',
  }));
  // 删掉唯一承载楼：head 重算为 0（真机 r0 状态），此处必须返回空而不是抛错。
  await canon.rollbackByMessageId(namespace, 80, 300);
  const branch = await canon.getBranch(namespace);
  assert.equal(branch.headRevision, 0, '前置：全部回退后 head=0');
  assert.deepEqual(
    await loadCurrentButterflySources({ butterflies, canon, namespace }),
    [],
    'head=0 时无有效片段，且不得抛错（否则四模块检索会整段降级为日志空源）',
  );

  // partially-active：唯一当前视图只应用 active+verified delta，故不供料（与视图口径一致）。
  const partial = await canon.commitIntervention(intervention({
    runId: 'partial', assistantMessageId: 81, location: '荣誉墙', subjectName: '监察者神位',
  }));
  await butterflies.saveRecord(record({
    runId: 'partial', deltaRef: partial.delta.deltaId, canonRevision: 2, title: '《部分案》',
  }));
  const partialBranch = await canon.getBranch(namespace);
  const partialCanon = {
    getBranch: async () => ({
      ...partialBranch,
      deltas: partialBranch.deltas.map(delta =>
        delta.deltaId === partial.delta.deltaId
          ? { ...delta, status: 'partially-active' as const }
          : delta),
    }),
  } as unknown as CanonRepository;
  assert.deepEqual(
    await loadCurrentButterflySources({
      butterflies,
      canon: partialCanon,
      namespace,
    }),
    [],
    'partially-active 不进候选（唯一当前视图只应用 active+verified）',
  );
});

test('蝴蝶源作用域：并集自带实体/地点/名称，避免叙事 delta 被提前判 outside', async () => {
  const canon = new MemoryCanonRepository();
  const butterflies = new MemoryButterflyRepository();
  const generated = await canon.commitIntervention(intervention({
    runId: 'narrative', assistantMessageId: 70, location: '荣誉墙陈列室', subjectName: '监察者神位',
  }));
  await butterflies.saveRecord(record({
    runId: 'narrative', deltaRef: generated.delta.deltaId, canonRevision: 1,
    title: '《叙事案》',
  }));

  const scope = buildButterflySourceScope(await canon.getBranch(namespace));
  assert.deepEqual(scope.spatialScopes, ['荣誉墙陈列室']);
  assert.deepEqual(scope.names, ['监察者神位']);
  assert.equal(scope.temporalScopes.length, 0, '时间闸留空：投递窗口交给任务侧检索');

  const sources = await loadCurrentButterflySources({ butterflies, canon, namespace });
  assert.deepEqual(sources.map(source => source.sourceId), ['butterfly:narrative']);
});
