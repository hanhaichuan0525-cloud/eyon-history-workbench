import assert from 'node:assert/strict';
import test from 'node:test';

import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import type {
  CanonFact,
  CanonQueryScope,
  CanonResolutionBranch,
  CanonResolvedView,
  EvidenceBundle,
  EvidencePassage,
  PersonCanonView,
  SourceSnapshot,
} from '../src/retrieval/contracts.ts';
import {
  projectEvidenceBundleCanon,
  resolveCanon,
} from '../src/retrieval/canonResolver.ts';
import { inspectCanonBranch } from '../src/runtime/canonDiagnostics.ts';
import {
  MemoryCanonRepository,
  type CommitCanonInterventionInput,
} from '../src/storage/canon.ts';

const namespace: WorkbenchNamespace = {
  characterKey: '伊雍',
  chatId: 'canon-p0b',
};

function deathChange(input: {
  runId: string;
  assistantMessageId: number;
  year: number;
  now: number;
  dependsOnDeltaIds?: string[];
}): CommitCanonInterventionInput {
  const current: CanonFact = {
    factId: `fact:death:${input.runId}`,
    subjectEntityId: 'entity:person-a',
    predicate: 'death_time',
    object: `复兴纪元${input.year}年`,
    statement: `A于复兴纪元${input.year}年死亡`,
    temporalScope: `复兴纪元${input.year}年`,
    spatialScope: '旧堡',
    epistemicStatus: 'user-asserted',
    confidence: 'high',
    sourceRefs: [`chat:${input.assistantMessageId}`],
    sourceSnapshotIds: [`chat:${input.assistantMessageId}`],
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
      actionRecord: `玩家使A的死亡时间变为复兴纪元${input.year}年`,
      sourceRefs: [`chat:${input.assistantMessageId}`],
      occurredAt: { label: `复兴纪元${input.year}年` },
      createdAt: input.now,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: `复兴纪元${input.year}年`, era: '复兴纪元', year: input.year },
      operations: [{
        op: 'replace',
        factKey: 'entity:person-a|death_time|world',
        originalFactIds: ['fact:base:person-a-death-470'],
        current,
      }],
      preconditionFactIds: ['fact:base:person-a-alive-before-change'],
      dependsOnDeltaIds: input.dependsOnDeltaIds ?? [],
      cascadeScope: {
        entityIds: ['entity:person-a'],
        time: { start: { label: `复兴纪元${input.year}年` } },
        locations: ['旧堡'],
      },
      preserves: ['人物A的稳定身份', '玩家行动原稿'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: input.now,
    },
  };
}

function birthChange(input: {
  runId: string;
  assistantMessageId: number;
  year: number;
  now: number;
}): CommitCanonInterventionInput {
  const current: CanonFact = {
    factId: `fact:birth:${input.runId}`,
    subjectEntityId: 'entity:person-a',
    predicate: 'birth_time',
    object: `复兴纪元${input.year}年`,
    statement: `A的出生时间改为复兴纪元${input.year}年`,
    temporalScope: `复兴纪元${input.year}年`,
    spatialScope: '旧堡',
    epistemicStatus: 'user-asserted',
    confidence: 'high',
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
      actionRecord: current.statement,
      sourceRefs: current.sourceRefs,
      occurredAt: { label: `复兴纪元${input.year}年` },
      createdAt: input.now,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: `复兴纪元${input.year}年`, era: '复兴纪元', year: input.year },
      operations: [{
        op: 'replace',
        factKey: 'entity:person-a|birth_time|world',
        originalFactIds: ['fact:base:person-a-birth-461'],
        current,
      }],
      preconditionFactIds: [],
      dependsOnDeltaIds: [],
      cascadeScope: {
        entityIds: ['entity:person-a'],
        time: { start: { label: `复兴纪元${input.year}年` } },
        locations: ['旧堡'],
      },
      preserves: ['同一人物身份'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: input.now,
    },
  };
}

test('P0-B：死亡改写以 action + delta + receipt 原子追加，保留原值、现值、前提和 preserves', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'd1',
    assistantMessageId: 10,
    year: 458,
    now: 100,
  }));
  assert.equal(committed.branch.headRevision, 1);
  assert.equal(committed.delta.parentRevision, 0);
  assert.equal(committed.delta.revision, 1);
  assert.equal(committed.delta.operations[0]?.op, 'replace');
  assert.deepEqual(
    committed.delta.operations[0]?.originalFactIds,
    ['fact:base:person-a-death-470'],
  );
  assert.equal(committed.delta.operations[0]?.current.object, '复兴纪元458年');
  assert.equal(committed.delta.operations[0]?.current.revisionIntroduced, 1);
  assert.deepEqual(committed.delta.preconditionFactIds, ['fact:base:person-a-alive-before-change']);
  assert.deepEqual(committed.delta.preserves, ['人物A的稳定身份', '玩家行动原稿']);
  assert.deepEqual(committed.receipt.appliedDeltaIds, [committed.delta.deltaId]);
  assert.equal(committed.receipt.resolutionMode, 'deterministic');

  const replay = await repository.commitIntervention(deathChange({
    runId: 'd1',
    assistantMessageId: 10,
    year: 458,
    now: 101,
  }));
  assert.equal(replay.branch.headRevision, 1, '同一活动 run 重试必须幂等，不能重复分配 revision');
  assert.equal(replay.branch.actions.length, 1);
});

test('P0-B：删最新遣返楼回滚到父 revision，行动与旧 delta 仍可审计', async () => {
  const repository = new MemoryCanonRepository();
  const d1 = await repository.commitIntervention(deathChange({
    runId: 'd1', assistantMessageId: 10, year: 458, now: 100,
  }));
  const d2 = await repository.commitIntervention(deathChange({
    runId: 'd2',
    assistantMessageId: 20,
    year: 455,
    now: 200,
    dependsOnDeltaIds: [d1.delta.deltaId],
  }));
  assert.equal(d2.branch.headRevision, 2);
  const rolled = await repository.rollbackByMessageId(namespace, 20, 300);
  assert.ok(rolled);
  assert.equal(rolled?.branch.headRevision, 1);
  assert.equal(rolled?.branch.revisions.find(item => item.revision === 1)?.status, 'active');
  assert.equal(rolled?.branch.revisions.find(item => item.revision === 2)?.status, 'reverted');
  assert.equal(rolled?.branch.actions.length, 2, '玩家实际行动必须保留，不因回滚静默删除');
  assert.equal(rolled?.branch.deltas.find(item => item.revision === 2)?.status, 'reverted');
  assert.deepEqual(rolled?.receipt.revertedDeltaIds, [d2.delta.deltaId]);
  assert.equal(inspectCanonBranch(namespace, rolled!.branch).healthy, true);
});

test('P3-B：删较早遣返楼时只孤立依赖结果，后继 revision 与行动仍可审计', async () => {
  const repository = new MemoryCanonRepository();
  const d1 = await repository.commitIntervention(deathChange({
    runId: 'd1', assistantMessageId: 10, year: 458, now: 100,
  }));
  const d2 = await repository.commitIntervention(deathChange({
    runId: 'd2',
    assistantMessageId: 20,
    year: 455,
    now: 200,
    dependsOnDeltaIds: [d1.delta.deltaId],
  }));
  const rolled = await repository.rollbackByMessageId(namespace, 10, 300);
  assert.equal(rolled?.branch.headRevision, 2);
  assert.equal(rolled?.branch.deltas.find(item => item.deltaId === d1.delta.deltaId)?.status, 'reverted');
  assert.equal(rolled?.branch.deltas.find(item => item.deltaId === d2.delta.deltaId)?.status, 'orphaned');
  assert.equal(rolled?.branch.revisions.find(item => item.deltaId === d2.delta.deltaId)?.status, 'active');
  assert.deepEqual(rolled?.receipt.orphanedDeltaIds, [d2.delta.deltaId]);
  assert.equal(rolled?.receipt.resolutionMode, 'deterministic');
  assert.equal(rolled?.receipt.causalRebase?.modelCalls, 0);
  assert.equal(rolled?.branch.actions.length, 2);
  assert.equal(inspectCanonBranch(namespace, rolled!.branch).healthy, true);
});

test('P0-B：空分支诊断只读返回当前聊天且判定健康', async () => {
  const repository = new MemoryCanonRepository();
  const branch = await repository.getBranch(namespace);
  const inspection = inspectCanonBranch(namespace, branch);
  assert.equal(inspection.schema, 'eyon.canon.inspection.v1');
  assert.equal(inspection.branch.headRevision, 0);
  assert.deepEqual(inspection.counts, { revisions: 0, actions: 0, deltas: 0, receipts: 0 });
  assert.equal(inspection.healthy, true);
  inspection.branch.headRevision = 99;
  assert.equal(branch.headRevision, 0, '诊断结果不得持有仓库分支的可变引用');
});

test('P0-B：提交后的诊断同时暴露 revision、action、delta、receipt 链', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'diagnostic', assistantMessageId: 30, year: 456, now: 400,
  }));
  const inspection = inspectCanonBranch(namespace, await repository.getBranch(namespace));
  assert.deepEqual(inspection.counts, { revisions: 1, actions: 1, deltas: 1, receipts: 1 });
  assert.equal(inspection.revisions[0]?.actionId, inspection.actions[0]?.actionId);
  assert.equal(inspection.revisions[0]?.deltaId, inspection.deltas[0]?.deltaId);
  assert.equal(inspection.revisions[0]?.receiptId, inspection.receipts[0]?.receiptId);
  assert.deepEqual(inspection.receipts[0]?.appliedDeltaIds, [committed.delta.deltaId]);
  assert.equal(inspection.healthy, true);
});

test('P0-B：诊断能发现 head 与引用链损坏但不会自动修复', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'broken', assistantMessageId: 40, year: 454, now: 500,
  }));
  const broken = structuredClone(committed.branch);
  broken.headRevision = 0;
  broken.actions = [];
  const inspection = inspectCanonBranch(namespace, broken);
  assert.equal(inspection.healthy, false);
  assert.ok(inspection.issues.some(issue => issue.includes('headRevision')));
  assert.ok(inspection.issues.some(issue => issue.includes('action 不存在')));
  assert.equal(broken.headRevision, 0, '诊断不得自动纠正输入分支');
});

const baseText = 'A的身份是旧堡记录官。A于复兴纪元470年死亡。';
const deathText = 'A于复兴纪元470年死亡。';
const deathStart = baseText.indexOf(deathText);
const sourceSnapshot: SourceSnapshot = {
  schema: 'eyon.retrieval.source-snapshot.v1',
  logicalId: 'worldbook:a',
  snapshotId: 'worldbook:a@sha256:test',
  versionHash: 'sha256:test',
  sourceType: 'worldbook',
  title: '人物A',
  content: baseText,
  metadata: {},
};
const passage: EvidencePassage = {
  passageId: 'worldbook:a#chars:0-26',
  snapshotId: sourceSnapshot.snapshotId,
  sourceId: sourceSnapshot.logicalId,
  sourceType: 'worldbook',
  title: '人物A',
  sectionPath: [],
  startOffset: 0,
  endOffset: baseText.length,
  extractionMode: 'full',
  content: baseText,
  contentHash: 'hash:passage-a',
  charCount: baseText.length,
  matchedAnchors: ['A'],
  temporalScopes: ['复兴纪元470年'],
  selectionReasons: ['fixture'],
};
const identityFact: CanonFact = {
  factId: 'fact:base:person-a-identity',
  subjectEntityId: 'entity:person-a',
  predicate: 'identity',
  object: '旧堡记录官',
  statement: 'A的身份是旧堡记录官',
  temporalScope: null,
  spatialScope: '旧堡',
  epistemicStatus: 'explicit',
  confidence: 'high',
  sourceRefs: [sourceSnapshot.logicalId],
  sourceSnapshotIds: [sourceSnapshot.snapshotId],
  sourceSpans: [{ snapshotId: sourceSnapshot.snapshotId, startOffset: 0, endOffset: deathStart }],
  revisionIntroduced: 0,
  revisionRetired: null,
};
const aliveFact: CanonFact = {
  ...identityFact,
  factId: 'fact:base:person-a-alive-before-change',
  predicate: 'state',
  object: '复兴纪元470年前在世',
  statement: 'A在死亡前仍然在世',
  sourceSpans: [],
};
const deathFact: CanonFact = {
  ...identityFact,
  factId: 'fact:base:person-a-death-470',
  predicate: 'death_time',
  object: '复兴纪元470年',
  statement: deathText.slice(0, -1),
  temporalScope: '复兴纪元470年',
  sourceSpans: [{
    snapshotId: sourceSnapshot.snapshotId,
    startOffset: deathStart,
    endOffset: deathStart + deathText.length,
  }],
};
const personView: PersonCanonView = {
  schema: 'eyon.retrieval.person-canon-view.v1',
  entityId: 'entity:person-a',
  canonicalName: 'A',
  aliases: [],
  requiredFactIds: [identityFact.factId],
  relevantFactIds: [identityFact.factId, aliveFact.factId, deathFact.factId],
  facts: [identityFact, aliveFact, deathFact],
  sourceSnapshotIds: [sourceSnapshot.snapshotId],
  lifespan: { born: { era: '复兴纪元', year: 400 }, died: { era: '复兴纪元', year: 470 } },
};
const scope: CanonQueryScope = {
  subjectEntityIds: ['entity:person-a'],
  temporalScopes: [],
  spatialScopes: ['旧堡'],
  sourceIds: [sourceSnapshot.logicalId, sourceSnapshot.snapshotId],
};

function withBase(branch: Awaited<ReturnType<MemoryCanonRepository['getBranch']>>): CanonResolutionBranch {
  return {
    ...branch,
    baseCanon: {
      facts: [identityFact, aliveFact, deathFact],
      eventRelations: [],
      personViews: [personView],
      passages: [passage],
      sourceSnapshots: [sourceSnapshot],
    },
  };
}

test('RC-01：revision 0 只读返回 BaseCanon，重复解析完全确定', async () => {
  const repository = new MemoryCanonRepository();
  const branch = withBase(await repository.getBranch(namespace));
  const first = resolveCanon(branch, 0, scope);
  const second = resolveCanon(branch, 0, scope);
  assert.equal(first.viewId, second.viewId);
  assert.deepEqual(first.activeFacts, second.activeFacts);
  assert.deepEqual(first.resolutionReceipt.appliedDeltaIds, []);
  assert.equal(first.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元470年');
});

test('RC-02/03：已验证死亡改写覆盖旧值但保留身份，解析旧 revision 恢复基线', async () => {
  const repository = new MemoryCanonRepository();
  const baselineView = resolveCanon(withBase(await repository.getBranch(namespace)), 0, scope);
  const committed = await repository.commitIntervention(deathChange({
    runId: 'rc02', assistantMessageId: 10, year: 458, now: 600,
  }));
  const branch = withBase(committed.branch);
  const current = resolveCanon(branch, 1, scope);
  assert.equal(current.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元458年');
  assert.ok(current.inactiveFacts.some(item => item.fact.factId === deathFact.factId));
  assert.ok(current.activeFacts.some(fact => fact.factId === identityFact.factId));
  assert.equal(current.personViews[0]?.lifespan?.died?.year, 458);
  const old = resolveCanon(branch, 0, scope);
  assert.equal(old.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元470年');
  assert.equal(old.viewId, baselineView.viewId, '回滚到 revision 0 必须恢复同一当前视图身份');
});

test('当前 revision 改写出生原点后清除旧年龄反推，并同步投影到各模块消费的 personTimeline', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(birthChange({
    runId: 'birth-r1', assistantMessageId: 30, year: 463, now: 650,
  }));
  const birthFact: CanonFact = {
    ...identityFact,
    factId: 'fact:base:person-a-birth-461',
    predicate: 'birth_time',
    object: '复兴纪元461年',
    statement: 'A出生于复兴纪元461年',
    temporalScope: '复兴纪元461年',
    sourceSpans: [],
  };
  const basePerson: PersonCanonView = {
    ...personView,
    relevantFactIds: [...personView.relevantFactIds, birthFact.factId],
    facts: [...personView.facts, birthFact],
    lifespan: {
      born: { era: '复兴纪元', year: 461 },
      ageAtRecord: 27,
      basedOnEra: '复兴纪元',
      basedOnYear: 488,
      ageBased: true,
    },
  };
  const branch: CanonResolutionBranch = {
    ...committed.branch,
    baseCanon: {
      facts: [identityFact, birthFact],
      eventRelations: [],
      personViews: [basePerson],
      passages: [passage],
      sourceSnapshots: [sourceSnapshot],
    },
  };
  const current = resolveCanon(branch, 1, scope);
  assert.equal(current.personViews[0]?.lifespan?.born?.year, 463);
  assert.equal(current.personViews[0]?.lifespan?.ageBased, undefined);
  assert.equal(current.personViews[0]?.lifespan?.ageAtRecord, undefined);

  const projected = projectEvidenceBundleCanon({
    query: '对A进行寻根溯源',
    personTimeline: [{
      name: 'A',
      state: 'unknown',
      narrative: '旧出生年',
      lifespan: basePerson.lifespan,
    }],
  } as EvidenceBundle, current as CanonResolvedView);
  assert.equal(projected.personTimeline?.[0]?.lifespan?.born?.year, 463);
  assert.match(projected.personTimeline?.[0]?.narrative ?? '', /复兴纪元463年/u);
  assert.doesNotMatch(projected.personTimeline?.[0]?.narrative ?? '', /复兴纪元461年/u);

  const old = resolveCanon(branch, 0, scope);
  assert.equal(old.personViews[0]?.lifespan?.born?.year, 461, '回看旧 revision 仍恢复旧原点');
  assert.equal(old.personViews[0]?.lifespan?.ageBased, true);
});

test('RC-04：局部作用域不命中时不把同一改写外推到其他地点', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'rc04', assistantMessageId: 20, year: 458, now: 700,
  }));
  const branch = withBase(committed.branch);
  const outside = resolveCanon(branch, 1, { ...scope, spatialScopes: ['新港'] });
  assert.equal(outside.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元470年');
  assert.deepEqual(outside.resolutionReceipt.appliedDeltaIds, []);
  const inside = resolveCanon(branch, 1, scope);
  assert.equal(inside.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元458年');
});

test('RC-05：未验证、缺依赖、缺原事实的 delta 均局部跳过并保留基线', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'rc05', assistantMessageId: 30, year: 458, now: 800,
  }));
  const variants = [
    (branch: CanonResolutionBranch) => { branch.deltas[0]!.verified = false; },
    (branch: CanonResolutionBranch) => { branch.deltas[0]!.dependsOnDeltaIds = ['delta:missing']; },
    (branch: CanonResolutionBranch) => { branch.deltas[0]!.operations[0]!.originalFactIds = ['fact:missing']; },
  ];
  for (const mutate of variants) {
    const branch = withBase(committed.branch);
    mutate(branch);
    const view = resolveCanon(branch, 1, scope);
    assert.equal(view.activeFacts.find(fact => fact.predicate === 'death_time')?.object, '复兴纪元470年');
    assert.equal(view.resolutionReceipt.appliedDeltaIds.length, 0);
    assert.ok(view.uncertainItems.length > 0);
  }
});

test('RC-06：替换事实只遮蔽对应 passage 片段，身份内容仍可引用', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'rc06', assistantMessageId: 40, year: 458, now: 900,
  }));
  const view = resolveCanon(withBase(committed.branch), 1, scope);
  const currentPassage = view.passageViews[0];
  assert.equal(currentPassage?.status, 'partial');
  assert.match(currentPassage?.content ?? '', /旧堡记录官/u);
  assert.doesNotMatch(currentPassage?.content ?? '', /470年死亡/u);
});

test('RC-07：四模块同分支同 revision 同 scope 得到同一视图，分支间隔离', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(deathChange({
    runId: 'rc07', assistantMessageId: 50, year: 458, now: 1000,
  }));
  const branch = withBase(committed.branch);
  const taskTypes = ['biography', 'ruin', 'genealogy', 'butterfly'] as const;
  const ids = taskTypes.map(() => resolveCanon(branch, 1, scope).viewId);
  assert.equal(new Set(ids).size, 1);
  const otherBranch = structuredClone(branch);
  otherBranch.branchId = `${branch.branchId}:other-chat`;
  otherBranch.chatId = 'other-chat';
  for (const delta of otherBranch.deltas) delta.branchId = otherBranch.branchId;
  for (const action of otherBranch.actions) action.branchId = otherBranch.branchId;
  assert.notEqual(resolveCanon(otherBranch, 1, scope).viewId, ids[0]);
});

test('P3-B：同楼跨 run 全部回滚，但无显式依赖的后继行动继续有效', async () => {
  const repository = new MemoryCanonRepository();
  await repository.commitIntervention(deathChange({
    runId: 'run-a', assistantMessageId: 10, year: 458, now: 100,
  }));
  // 异 run 复用同一楼（regenerate/删楼重来保持 message_id 不变）
  await repository.commitIntervention(deathChange({
    runId: 'run-b', assistantMessageId: 10, year: 459, now: 200,
  }));
  await repository.commitIntervention(deathChange({
    runId: 'run-c', assistantMessageId: 20, year: 460, now: 300,
  }));
  let branch = await repository.getBranch(namespace);
  assert.equal(branch.revisions.length, 3);
  assert.deepEqual(branch.revisions.map(item => item.status), ['active', 'active', 'active']);
  assert.equal(branch.headRevision, 3);

  const rolled = await repository.rollbackByMessageId(namespace, 10, 400);
  assert.ok(rolled, '删除被复用的楼应产生回滚');
  branch = await repository.getBranch(namespace);
  assert.equal(branch.revisions[0]?.status, 'reverted', 'run-a（楼10）应回滚');
  assert.equal(branch.revisions[1]?.status, 'reverted', 'run-b（楼10）应回滚');
  assert.equal(branch.revisions[2]?.status, 'active', 'run-c（楼20，无显式依赖）应继续活动');
  assert.equal(branch.deltas[2]?.status, 'active');
  assert.equal(branch.headRevision, 3);
  assert.equal(rolled!.receipt.revertedDeltaIds.length, 2);
  assert.equal(rolled!.receipt.orphanedDeltaIds.length, 0);

  const second = await repository.rollbackByMessageId(namespace, 20, 500);
  assert.ok(second, '仍活动的后继楼可以独立回滚');
  branch = await repository.getBranch(namespace);
  assert.equal(branch.revisions[2]?.status, 'reverted');
});

// F-02（internal.82 覆盖）：generated 叙事实体（原创层无档案）经地点/名称+时间投递。
function narrativeChange(input: {
  runId: string;
  assistantMessageId: number;
  year: number;
  now: number;
  locations?: string[];
  names?: string[];
  entityId?: string;
}): CommitCanonInterventionInput {
  const subjectEntityId = input.entityId ?? 'entity:generated:%E5%B0%A4%E5%A8%9C';
  const timeLabel = `复兴纪元${input.year}年`;
  const current: CanonFact = {
    factId: `fact:narrative:${input.runId}`,
    subjectEntityId,
    predicate: 'historical_change',
    object: '在海因里希的扼杀下死亡，捕光琉璃工艺传承断绝',
    statement: `尤娜在复兴纪元${input.year}年被扼杀，捕光琉璃工艺传承断绝`,
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
      actionRecord: `玩家在复兴纪元${input.year}年黄昏花室扼杀了尤娜`,
      sourceRefs: [`chat:${input.assistantMessageId}`],
      occurredAt: { label: timeLabel },
      createdAt: input.now,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: timeLabel },
      operations: [{
        op: 'assert',
        factKey: `${subjectEntityId}|historical_change|${timeLabel}`,
        originalFactIds: [],
        current,
      }],
      preconditionFactIds: [],
      dependsOnDeltaIds: [],
      cascadeScope: {
        entityIds: [subjectEntityId],
        time: {
          start: { label: timeLabel },
          end: { label: timeLabel },
        },
        locations: input.locations ?? ['黄昏花室'],
        subjectNames: input.names ?? ['尤娜'],
      },
      preserves: ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: true,
      createdAt: input.now,
    },
  };
}

const narrativeScope: CanonQueryScope = {
  subjectEntityIds: ['entity:worldbook:unrelated'],
  temporalScopes: ['复兴纪元'],
  spatialScopes: ['黄昏花室'],
  sourceIds: [],
};

test('F-02：generated 叙事实体在稳定实体未命中时经地点命中进入视图（尤娜案形状）', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(narrativeChange({
    runId: 'f02a', assistantMessageId: 60, year: 321, now: 1000,
  }));
  const view = resolveCanon(withBase(committed.branch), 1, narrativeScope);
  assert.ok(
    view.resolutionReceipt.appliedDeltaIds.includes(committed.delta.deltaId),
    '同地点同纪元的 generated 干涉应被投递',
  );
  assert.ok(view.activeFacts.some(fact => fact.factId === committed.delta.operations[0]!.current.factId));
  assert.equal(
    view.activeFacts.find(fact => fact.predicate === 'historical_change')?.object,
    '在海因里希的扼杀下死亡，捕光琉璃工艺传承断绝',
  );
  // F-02 v5：行动断言（actionRecord 人话）随视图注入。
  assert.ok(
    (view.interventionSummaries ?? []).some(item =>
      item.record.includes('扼杀') && item.revision === 1),
    '视图应携带命中干涉的行动断言',
  );
});

test('F-02：不同地点且名称不命中时不投递（不污染无关窗口）', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(narrativeChange({
    runId: 'f02b', assistantMessageId: 60, year: 321, now: 1000,
  }));
  const view = resolveCanon(withBase(committed.branch), 1, {
    ...narrativeScope,
    spatialScopes: ['金谷界石田'],
    names: ['林氏家族'],
  });
  assert.deepEqual(view.resolutionReceipt.appliedDeltaIds, []);
  assert.equal(view.activeFacts.find(fact => fact.predicate === 'historical_change'), undefined);
  assert.ok(
    !view.interventionSummaries || view.interventionSummaries.length === 0,
    '未投递时不注入行动断言',
  );
});

test('F-02：地点不匹配但名称命中时可投递（名称通道）', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(narrativeChange({
    runId: 'f02c', assistantMessageId: 60, year: 321, now: 1000,
    locations: ['黄昏花室'],
  }));
  const view = resolveCanon(withBase(committed.branch), 1, {
    ...narrativeScope,
    spatialScopes: ['新港'],
    names: ['尤娜'],
  });
  assert.ok(
    view.resolutionReceipt.appliedDeltaIds.includes(committed.delta.deltaId),
    '名称命中（尤娜）应投递',
  );
});

test('F-02：旧数据形状（无 subjectNames/time）仅凭地点投递', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention({
    ...narrativeChange({ runId: 'f02d', assistantMessageId: 60, year: 321, now: 1000 }),
    delta: {
      ...narrativeChange({ runId: 'f02d', assistantMessageId: 60, year: 321, now: 1000 }).delta,
      cascadeScope: {
        entityIds: ['entity:generated:%E5%B0%A4%E5%A8%9C'],
        locations: ['黄昏花室'],
      },
    },
  });
  const view = resolveCanon(withBase(committed.branch), 1, narrativeScope);
  assert.ok(
    view.resolutionReceipt.appliedDeltaIds.includes(committed.delta.deltaId),
    '无 time/subjectNames 的旧数据：地点命中即投递',
  );
});

test('F-02：时间闸仍生效——纪元冲突的 generated 干涉不投递', async () => {
  const repository = new MemoryCanonRepository();
  const committed = await repository.commitIntervention(narrativeChange({
    runId: 'f02e', assistantMessageId: 60, year: 321, now: 1000,
  }));
  const view = resolveCanon(withBase(committed.branch), 1, {
    ...narrativeScope,
    temporalScopes: ['英雄纪元'],
  });
  assert.deepEqual(view.resolutionReceipt.appliedDeltaIds, [], '纪元冲突不投递');
});
