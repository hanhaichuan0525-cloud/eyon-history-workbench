import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCanonCausalRebase,
  operationRebaseState,
  projectCanonCausalRebase,
} from '../src/core/causalRebase.ts';
import {
  assessArtifactCanonBinding,
  artifactCanonAssessmentTargetView,
} from '../src/core/artifactCanonAssessment.ts';
import { currentArtifactCanonAssessmentTarget } from '../src/core/artifactCanonConsumption.ts';
import { resolveCanon } from '../src/retrieval/canonResolver.ts';
import type {
  ArtifactCanonBinding,
  CanonBranch,
  CanonCausalSupportUnit,
  CanonFact,
  CanonOperationCausalBasis,
  CanonOperationRef,
  CanonResolutionBranch,
  InterventionDelta,
} from '../src/retrieval/contracts.ts';
import { buildCanonMemorySnapshot } from '../src/runtime/canonMemoryChannel.ts';
import type { ButterflyRecord } from '../src/storage/butterflies.ts';

test('CR-01/12/13/29 无显式冲突就是零模型 no-op，不按同年同地背景串线', () => {
  const first = directDelta('d1', 1, 'root', 'fact:root', '409年');
  const second = directDelta('d2', 2, 'war', 'fact:war', '409年');
  const before = branch([first]);
  const candidate = branch([first, second]);
  const receipt = applyCanonCausalRebase(candidate, before);
  assert.equal(receipt.status, 'no-conflict');
  assert.equal(receipt.modelCalls, 0);
  assert.deepEqual(receipt.changedOperations, []);
  assert.equal(candidate.deltas[0]?.status, 'active');
  assert.equal(candidate.deltas[1]?.status, 'active');
});

test('CR-02/04/05 唯一支撑断裂只孤立对应结果，direct 根与同 delta 兄弟继续活动', () => {
  const first = causalDelta({ sibling: true });
  const second = replacementDelta();
  const candidate = branch([first, second]);
  const receipt = applyCanonCausalRebase(candidate, branch([first]));
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'root')), 'superseded');
  assert.equal(state(projection, ref('d1', 'child')), 'orphaned');
  assert.equal(state(projection, ref('d1', 'sibling')), 'active');
  assert.equal(state(projection, ref('d2', 'root')), 'active');
  assert.equal(candidate.deltas[0]?.status, 'partially-active');
  assert.equal(receipt.status, 'rebased');
  assert.deepEqual(receipt.brokenSupportIds, ['support:root-child']);
});

test('CR-03 一条支撑断裂但替代支撑仍在，结果保持 active 并停止传播', () => {
  const first = causalDelta({ alternative: true });
  const candidate = branch([first, replacementDelta()]);
  const receipt = applyCanonCausalRebase(candidate, branch([first]));
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'child')), 'active');
  assert.ok(receipt.brokenSupportIds.includes('support:root-child'));
  assert.ok(receipt.survivingSupportIds.includes('support:action-child'));
});

test('CR-06 后提交但世界时间更早的显式替换仍按 revision 仲裁', () => {
  const laterInWorld = causalDelta({ effective: '409年' });
  const earlierInWorld = replacementDelta('407年');
  const candidate = branch([laterInWorld, earlierInWorld]);
  applyCanonCausalRebase(candidate, branch([laterInWorld]));
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'root')), 'superseded');
  assert.equal(state(projection, ref('d2', 'root')), 'active');
});

test('CR-07 后来摧毁资源不会把已经发生的成立事件改写成从未发生', () => {
  const founded = directDelta('d1', 1, 'press-founded', 'fact:press-founded', '408年');
  const destroyed = directDelta('d2', 2, 'ledger-destroyed', 'fact:ledger-destroyed', '409年');
  const candidate = branch([founded, destroyed]);
  applyCanonCausalRebase(candidate, branch([founded]));
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'press-founded')), 'active');
  assert.equal(state(projection, ref('d2', 'ledger-destroyed')), 'active');
});

test('CR-08/17 回滚替换 revision 后旧支撑与旧结果自动恢复', () => {
  const first = causalDelta({});
  const second = replacementDelta();
  const changed = branch([first, second]);
  applyCanonCausalRebase(changed, branch([first]));
  assert.equal(state(projectCanonCausalRebase(changed), ref('d1', 'child')), 'orphaned');

  const rolled = structuredClone(changed);
  rolled.revisions[1]!.status = 'reverted';
  rolled.headRevision = 1;
  const receipt = applyCanonCausalRebase(rolled, changed);
  const projection = projectCanonCausalRebase(rolled);
  assert.equal(state(projection, ref('d1', 'root')), 'active');
  assert.equal(state(projection, ref('d1', 'child')), 'active');
  assert.ok(receipt.restoredOperationRefs.some(item =>
    item.factKey === ref('d1', 'child').factKey));
});

test('CR-09 后续不同载体可用新 support 接续同一旧结果，不覆盖旧 operation', () => {
  const first = causalDelta({});
  const second = replacementDelta();
  const carrier = directDelta('d3', 3, 'alternate-carrier', 'fact:alternate', '410年');
  carrier.causalSupportUnits = [{
    schema: 'eyon.canon.causal-support.v1',
    supportId: 'support:alternate-carrier-child',
    branchId: 'branch:test',
    introducedRevision: 3,
    introducedByDeltaId: 'd3',
    inputRefs: [{ kind: 'operation', operationRef: ref('d3', 'alternate-carrier') }],
    outputRef: { kind: 'operation', operationRef: ref('d1', 'child') },
    claimText: '替代载体承接原结果',
    sourceRefs: ['chat:3'],
  }];
  const candidate = branch([first, second, carrier]);
  applyCanonCausalRebase(candidate, branch([first, second]));
  assert.equal(state(projectCanonCausalRebase(candidate), ref('d1', 'child')), 'active');
  assert.equal(candidate.deltas[0]?.operations.find(item =>
    item.factKey === ref('d1', 'child').factKey)?.current.factId, 'fact:child');
});

test('CR-08 明确恢复同一稳定 fact 后，fact 支撑的旧结果重新 active', () => {
  const first = causalDelta({});
  first.causalSupportUnits![0]!.inputRefs = [{ kind: 'fact', factId: 'fact:root' }];
  const second = replacementDelta();
  const restored = delta({
    deltaId: 'd3', revision: 3, effective: '411年',
    operations: [{
      ...operation('root', 'fact:root', 3, '原事实与适用范围被明确恢复'),
      op: 'replace', originalFactIds: ['fact:root:new'],
    }],
    bases: [{ basis: 'direct', operationRef: ref('d3', 'root') }], supports: [],
  });
  const changed = branch([first, second]);
  applyCanonCausalRebase(changed, branch([first]));
  assert.equal(state(projectCanonCausalRebase(changed), ref('d1', 'child')), 'orphaned');
  const candidate = branch([first, second, restored]);
  const receipt = applyCanonCausalRebase(candidate, changed);
  assert.equal(state(projectCanonCausalRebase(candidate), ref('d1', 'child')), 'active');
  assert.ok(receipt.restoredOperationRefs.some(item =>
    item.factKey === ref('d1', 'child').factKey));
});

test('旧 revision 投影不会被未来同 fact 恢复者或替代 support 倒灌', () => {
  const first = causalDelta({});
  first.causalSupportUnits![0]!.inputRefs = [{ kind: 'fact', factId: 'fact:root' }];
  const second = replacementDelta();
  const future = delta({
    deltaId: 'd3', revision: 3, effective: '411年',
    operations: [{
      ...operation('root', 'fact:root', 3, '未来恢复同一稳定事实'),
      op: 'replace', originalFactIds: ['fact:root:new'],
    }],
    bases: [{ basis: 'direct', operationRef: ref('d3', 'root') }],
    supports: [{
      schema: 'eyon.canon.causal-support.v1', supportId: 'support:future-child',
      branchId: 'branch:test', introducedRevision: 3, introducedByDeltaId: 'd3',
      inputRefs: [{ kind: 'operation', operationRef: ref('d3', 'root') }],
      outputRef: { kind: 'operation', operationRef: ref('d1', 'child') },
      claimText: '未来才出现的替代支撑', sourceRefs: ['chat:3'],
    }],
  });
  const history = branch([first, second, future]);

  const atRevisionOne = projectCanonCausalRebase({ ...history, headRevision: 1 });
  assert.equal(state(atRevisionOne, ref('d1', 'root')), 'active');
  assert.equal(state(atRevisionOne, ref('d1', 'child')), 'active');

  const atRevisionTwo = projectCanonCausalRebase({ ...history, headRevision: 2 });
  assert.equal(state(atRevisionTwo, ref('d1', 'child')), 'orphaned');

  const atRevisionThree = projectCanonCausalRebase(history);
  assert.equal(state(atRevisionThree, ref('d1', 'child')), 'active');
});

test('CR-10/11 新结果保持独立，多输入 support 仅在明确输入断裂时局部 orphan', () => {
  const first = causalDelta({ sibling: true });
  first.causalSupportUnits![0]!.inputRefs = [
    { kind: 'operation', operationRef: ref('d1', 'root') },
    { kind: 'operation', operationRef: ref('d1', 'sibling') },
  ];
  const differentResult = directDelta('d2', 2, 'different-result', 'fact:different', '410年');
  const beforeConflict = branch([first, differentResult]);
  applyCanonCausalRebase(beforeConflict, branch([first]));
  assert.equal(state(projectCanonCausalRebase(beforeConflict), ref('d1', 'child')), 'active');
  assert.equal(state(projectCanonCausalRebase(beforeConflict), ref('d2', 'different-result')), 'active');

  const replace = replacementDelta('411年');
  replace.revision = 3;
  replace.parentRevision = 2;
  replace.deltaId = 'd3';
  replace.actionRef = 'action:d3';
  replace.causalBasis = [{ basis: 'direct', operationRef: ref('d3', 'root') }];
  const candidate = branch([first, differentResult, replace]);
  applyCanonCausalRebase(candidate, beforeConflict);
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'child')), 'orphaned');
  assert.equal(state(projection, ref('d1', 'sibling')), 'active');
  assert.equal(state(projection, ref('d2', 'different-result')), 'active');
});

test('CR-19/28 跨分支坏引用与相似名称不会自动接线', () => {
  const first = causalDelta({});
  first.causalSupportUnits![0]!.branchId = 'branch:other';
  const projection = projectCanonCausalRebase(branch([first]));
  assert.equal(state(projection, ref('d1', 'root')), 'active');
  assert.equal(state(projection, ref('d1', 'child')), 'uncertain');
  assert.ok(projection.warnings.includes('cross-branch-support:support:root-child'));
});

test('CR-22 缺 causal basis 的旧兄弟 operation 未被精确冲突触及时保持原行为', () => {
  const legacy = causalDelta({ sibling: true });
  delete legacy.causalBasis;
  delete legacy.causalSupportUnits;
  const candidate = branch([legacy, replacementDelta()]);
  applyCanonCausalRebase(candidate, branch([legacy]));
  const projection = projectCanonCausalRebase(candidate);
  assert.equal(state(projection, ref('d1', 'root')), 'superseded');
  assert.equal(state(projection, ref('d1', 'sibling')), 'active');
});

test('CR-27 回滚越狱 revision 不抹除监禁前史，也不反向删除后续直接赦免', () => {
  const jailed = directDelta('d1', 1, 'jailed-occurrence', 'fact:jailed', '407年');
  const escaped = directDelta('d2', 2, 'escaped-occurrence', 'fact:escaped', '408年');
  const pardoned = directDelta('d3', 3, 'pardoned-occurrence', 'fact:pardoned', '409年');
  const changed = branch([jailed, escaped, pardoned]);
  applyCanonCausalRebase(changed, branch([jailed, escaped]));
  const rolled = structuredClone(changed);
  rolled.revisions[1]!.status = 'reverted';
  rolled.headRevision = 3;
  applyCanonCausalRebase(rolled, changed);
  const projection = projectCanonCausalRebase(rolled);
  assert.equal(state(projection, ref('d1', 'jailed-occurrence')), 'active');
  assert.equal(state(projection, ref('d2', 'escaped-occurrence')), 'reverted');
  assert.equal(state(projection, ref('d3', 'pardoned-occurrence')), 'active');
});

test('CR-14/15 unresolved 输入与循环只在局部变成 uncertain，不无限传播', () => {
  const cycle = causalDelta({});
  cycle.operations = [
    operation('a', 'fact:a', 1),
    operation('b', 'fact:b', 1),
    operation('safe', 'fact:safe', 1),
  ];
  cycle.causalBasis = [
    { basis: 'supported', operationRef: ref('d1', 'a'), supportIds: ['support:b-a'] },
    { basis: 'supported', operationRef: ref('d1', 'b'), supportIds: ['support:a-b'] },
    { basis: 'direct', operationRef: ref('d1', 'safe') },
  ];
  cycle.causalSupportUnits = [
    support('support:b-a', ref('d1', 'b'), ref('d1', 'a')),
    support('support:a-b', ref('d1', 'a'), ref('d1', 'b')),
  ];
  const projection = projectCanonCausalRebase(branch([cycle]));
  assert.equal(state(projection, ref('d1', 'a')), 'uncertain');
  assert.equal(state(projection, ref('d1', 'b')), 'uncertain');
  assert.equal(state(projection, ref('d1', 'safe')), 'active');
  assert.ok(projection.warnings.some(item => item.startsWith('causal-cycle:')));
});

test('CR-23 超过 operation 上限时有界停止，不抛错也不扫描发布局部状态', () => {
  const huge = directDelta('d1', 1, 'op-0', 'fact:0', '409年');
  huge.operations = Array.from({ length: 513 }, (_, index) =>
    operation(`op-${index}`, `fact:${index}`, 1));
  huge.causalBasis = huge.operations.map(item => ({
    basis: 'direct' as const,
    operationRef: ref('d1', item.factKey),
  }));
  const projection = projectCanonCausalRebase(branch([huge]));
  assert.equal(projection.status, 'bounded-overflow');
  assert.deepEqual(projection.operationStates, []);
  assert.equal(projection.modelCalls, 0);
});

test('CR-23 上限只计算目标 head 的活动子图，大量已回滚历史不会永久锁死分支', () => {
  const archived = Array.from({ length: 513 }, (_, index) =>
    directDelta(`d${index + 1}`, index + 1, `op-${index}`, `fact:${index}`, `${index + 1}年`));
  const history = branch(archived);
  for (const revision of history.revisions) revision.status = 'reverted';
  history.headRevision = 0;
  const projection = projectCanonCausalRebase(history);
  assert.equal(projection.status, 'projected');
  assert.equal(projection.modelCalls, 0);
  assert.ok(projection.operationStates.every(item => item.state === 'reverted'));
});

test('CR-25 P1/P2 只消费 active operation，兄弟段落保持 current', () => {
  const first = causalDelta({ sibling: true });
  const candidate = branch([first, replacementDelta()]);
  applyCanonCausalRebase(candidate, branch([first]));
  const resolved = resolveCanon(resolutionBranch(candidate), 2, {
    subjectEntityIds: ['entity:test'], temporalScopes: [], spatialScopes: ['同一地点'], sourceIds: [],
  });
  assert.ok(resolved.activeFacts.some(item => item.factId === 'fact:sibling'));
  assert.ok(resolved.activeFacts.some(item => item.factId === 'fact:root:new'));
  assert.equal(resolved.activeFacts.some(item => item.factId === 'fact:child'), false);

  const target = currentArtifactCanonAssessmentTarget({
    branch: candidate,
    bindings: [binding('child', ref('d1', 'child')), binding('sibling', ref('d1', 'sibling'))],
  });
  const child = assessArtifactCanonBinding({
    binding: binding('child', ref('d1', 'child')),
    view: target,
    branch: candidate,
  });
  const sibling = assessArtifactCanonBinding({
    binding: binding('sibling', ref('d1', 'sibling')),
    view: target,
    branch: candidate,
  });
  assert.equal(child.status, 'orphaned');
  assert.equal(sibling.status, 'current');
  assert.equal(artifactCanonAssessmentTargetView(resolved).branchId, candidate.branchId);
});

test('CR-26 Canon Memory 对 partially-active 只注入 active 摘要，回滚后自动恢复原摘要', () => {
  const first = causalDelta({ sibling: true });
  const changed = branch([first, replacementDelta()]);
  applyCanonCausalRebase(changed, branch([first]));
  const record = butterflyRecord();
  const changedMemory = buildCanonMemorySnapshot({
    records: [record], branch: changed, matchText: '玲山', trigger: 'manual', now: 10,
  });
  assert.match(changedMemory.injectedText, /仍有效结果：兄弟结果仍在/u);
  assert.doesNotMatch(changedMemory.injectedText, /旧派生结果应该消失/u);

  const rolled = structuredClone(changed);
  rolled.revisions[1]!.status = 'reverted';
  rolled.headRevision = 1;
  applyCanonCausalRebase(rolled, changed);
  const restoredMemory = buildCanonMemorySnapshot({
    records: [record], branch: rolled, matchText: '玲山', trigger: 'manual', now: 11,
  });
  assert.match(restoredMemory.injectedText, /旧派生结果应该消失/u);
});

function causalDelta(input: {
  sibling?: boolean;
  alternative?: boolean;
  effective?: string;
}): InterventionDelta {
  const operations = [operation('root', 'fact:root', 1), operation('child', 'fact:child', 1)];
  if (input.sibling) operations.push(operation('sibling', 'fact:sibling', 1, '兄弟结果仍在'));
  const supports: CanonCausalSupportUnit[] = [support(
    'support:root-child', ref('d1', 'root'), ref('d1', 'child'),
  )];
  if (input.alternative) {
    supports.push({
      schema: 'eyon.canon.causal-support.v1', supportId: 'support:action-child',
      branchId: 'branch:test', introducedRevision: 1, introducedByDeltaId: 'd1',
      inputRefs: [{ kind: 'action', actionId: 'action:d1' }],
      outputRef: { kind: 'operation', operationRef: ref('d1', 'child') },
      claimText: '独立行动支撑结果', sourceRefs: ['chat:1'],
    });
  }
  const bases: CanonOperationCausalBasis[] = [
    { basis: 'direct', operationRef: ref('d1', 'root') },
    {
      basis: 'supported', operationRef: ref('d1', 'child'),
      supportIds: supports.map(item => item.supportId),
    },
  ];
  if (input.sibling) bases.push({ basis: 'direct', operationRef: ref('d1', 'sibling') });
  return delta({
    deltaId: 'd1', revision: 1, effective: input.effective ?? '409年', operations,
    bases, supports,
  });
}

function replacementDelta(effective = '410年'): InterventionDelta {
  return delta({
    deltaId: 'd2', revision: 2, effective,
    operations: [{
      ...operation('root', 'fact:root:new', 2, '根事实被明确替换'),
      op: 'replace', originalFactIds: ['fact:root'],
    }],
    bases: [{ basis: 'direct', operationRef: ref('d2', 'root') }], supports: [],
  });
}

function directDelta(
  deltaId: string,
  revision: number,
  factKey: string,
  factId: string,
  effective: string,
): InterventionDelta {
  return delta({
    deltaId, revision, effective,
    operations: [operation(factKey, factId, revision)],
    bases: [{ basis: 'direct', operationRef: ref(deltaId, factKey) }], supports: [],
  });
}

function delta(input: {
  deltaId: string;
  revision: number;
  effective: string;
  operations: InterventionDelta['operations'];
  bases: CanonOperationCausalBasis[];
  supports: CanonCausalSupportUnit[];
}): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1', deltaId: input.deltaId,
    branchId: 'branch:test', revision: input.revision,
    parentRevision: Math.max(0, input.revision - 1), actionRef: `action:${input.deltaId}`,
    effectiveFrom: { label: input.effective }, operations: input.operations,
    causalBasis: input.bases, causalSupportUnits: input.supports,
    preconditionFactIds: [], dependsOnDeltaIds: [],
    cascadeScope: { entityIds: ['entity:test'], locations: ['同一地点'], subjectNames: ['玲山'] },
    preserves: [], supersedesDeltaIds: [], status: 'active', verified: true,
    createdAt: input.revision,
  };
}

function operation(
  factKey: string,
  factId: string,
  revision: number,
  statement = factId,
): InterventionDelta['operations'][number] {
  const current = fact(factId, revision, statement);
  current.predicate = factKey;
  return {
    op: 'assert', factKey: stableFactKey(factKey), originalFactIds: [], current,
  };
}

function support(
  supportId: string,
  input: CanonOperationRef,
  output: CanonOperationRef,
): CanonCausalSupportUnit {
  return {
    schema: 'eyon.canon.causal-support.v1', supportId, branchId: 'branch:test',
    introducedRevision: 1, introducedByDeltaId: 'd1',
    inputRefs: [{ kind: 'operation', operationRef: input }],
    outputRef: { kind: 'operation', operationRef: output },
    claimText: '明确支撑', sourceRefs: ['chat:1'],
  };
}

function fact(factId: string, revision: number, statement = factId): CanonFact {
  return {
    factId, subjectEntityId: 'entity:test', predicate: 'state', object: statement,
    statement, temporalScope: null, spatialScope: '同一地点', epistemicStatus: 'generated',
    confidence: 'medium', sourceRefs: [`chat:${revision}`], sourceSnapshotIds: [],
    sourceSpans: [], revisionIntroduced: revision, revisionRetired: null,
  };
}

function ref(deltaId: string, factKey: string): CanonOperationRef {
  return { deltaId, factKey: stableFactKey(factKey) };
}

function stableFactKey(predicate: string): string {
  return `entity:test|${predicate}|world`;
}

function branch(deltas: InterventionDelta[]): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1', branchId: 'branch:test', characterKey: '伊雍', chatId: 'chat',
    headRevision: Math.max(0, ...deltas.map(item => item.revision)),
    revisions: deltas.map(item => ({
      revision: item.revision, parentRevision: item.parentRevision, actionId: item.actionRef,
      deltaId: item.deltaId, assistantMessageId: item.revision, status: 'active',
      receiptId: `receipt:${item.deltaId}`, createdAt: item.createdAt,
    })),
    actions: deltas.map(item => ({
      schema: 'eyon.canon.intervention-action.v1', actionId: item.actionRef,
      branchId: 'branch:test', runId: `run:${item.deltaId}`, userMessageId: item.revision,
      assistantMessageId: item.revision, rawCommand: '改变历史',
      actionRecord: '玩家完成了确定性历史干涉', sourceRefs: [`chat:${item.revision}`],
      occurredAt: item.effectiveFrom, createdAt: item.createdAt,
    })),
    deltas: structuredClone(deltas), receipts: [], createdAt: 0,
    updatedAt: deltas.at(-1)?.createdAt ?? 0,
  };
}

function state(
  projection: ReturnType<typeof projectCanonCausalRebase>,
  operationRef: CanonOperationRef,
) {
  return operationRebaseState(projection, operationRef);
}

function resolutionBranch(source: CanonBranch): CanonResolutionBranch {
  return {
    ...structuredClone(source),
    baseCanon: {
      sourceSnapshots: [], facts: [], eventRelations: [], personViews: [], passages: [],
    },
  };
}

function binding(unitId: string, operationRef: CanonOperationRef): ArtifactCanonBinding {
  return {
    schema: 'eyon.canon.artifact-binding.v1', bindingId: `binding:${unitId}`,
    branchId: 'branch:test', artifactType: 'biography', artifactId: 'bio:test',
    unitType: 'stage', unitId,
    boundView: { viewId: 'view:1', resolvedRevision: 1, queryScopeHash: 'scope' },
    entityIds: [], factIds: [], operationRefs: [operationRef], sourceRefs: [], createdAt: 1,
  };
}

function butterflyRecord(): ButterflyRecord {
  return {
    key: 'butterfly:run:d1', namespace: { characterKey: '伊雍', chatId: 'chat' },
    runId: 'run:d1', requestId: 'request:d1', request: {} as never,
    result: {
      effect: {
        roll: 50, scope: '局部', presentLanding: '现在', perceptibleEvidence: ['证物'],
        ruinActionRecord: '玩家完成了确定性历史干涉',
        historicalEvolution: '旧派生结果应该消失，兄弟结果仍在。', historicalKeywords: ['玲山'],
      },
    } as never,
    sourceHash: 'hash', panel: '[标题|测试]', archiveEntry: '### 《测试》\n正文',
    assistantMessageId: 1, status: 'committed', revision: 1, deltaRef: 'd1',
    canonStatus: 'partially-active', canonRevision: 1,
    worldbookName: 'deprecated', worldbookUid: null, createdAt: 1, updatedAt: 1,
  } as unknown as ButterflyRecord;
}
