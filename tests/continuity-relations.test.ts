import assert from 'node:assert/strict';
import test from 'node:test';

import type { GeneratedContinuityAnchor } from '../src/core/continuityAnchors.ts';
import {
  buildContinuityViewRelationsSafely,
  clearContinuityRelationDiagnosticsForTest,
  continuityRelationsFromCommittedRecords,
  listContinuityRelationDiagnostics,
  parseContinuityEventJudgeText,
  recallContinuityEventPairCandidates,
  type ContinuityViewRelation,
} from '../src/core/continuityRelations.ts';
import {
  buildContinuityViewSafely,
  inspectContinuityAnchors,
  renderContinuityView,
} from '../src/runtime/continuityAnchors.ts';
import type { ArtifactCanonBinding } from '../src/retrieval/contracts.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';
import { namespaceKey } from '../src/core/namespace.ts';

const namespace = { characterKey: '角色', chatId: '聊天' };
const namespaceId = namespaceKey(namespace);

test('独立自然语言裁判只接纳已投递 P 编号，并解析三种结果与七种差异', () => {
  const pairs = [
    { pairId: 'P1', producerUnitRef: 'stage-1', currentEventRef: 'event:new:1', otherHandle: 'C1', otherAnchorId: 'old:1' },
    { pairId: 'P2', producerUnitRef: 'stage-2', currentEventRef: 'event:new:2', otherHandle: 'C2', otherAnchorId: 'old:2' },
    { pairId: 'P3', producerUnitRef: 'stage-3', currentEventRef: 'event:new:3', otherHandle: 'C3', otherAnchorId: 'old:3' },
  ];
  const parsed = parseContinuityEventJudgeText([
    'P1：同一事件；主要差异：时间；理由：都是暮潮移交，但年份不同。',
    'P2：不同事件；理由：一个是发现，一个是移交。',
    'P3：无法确认；主要差异：物品状态；理由：旧稿证据不足。',
    'P99：同一事件；主要差异：结果；理由：不应接纳未知编号。',
  ].join('\n'), pairs);
  assert.deepEqual(parsed.map(item => [item.pairId, item.verdict, item.dimension]), [
    ['P1', 'sameEvent', 'time'],
    ['P2', 'differentEvent', undefined],
    ['P3', 'uncertain', undefined],
  ]);
  assert.match(parsed[0]?.note ?? '', /暮潮移交/u);
});

test('PV-01/PV-02/PV-03 创建并存视角与有双边来源的冲突；没有候选不推断', () => {
  clearContinuityRelationDiagnosticsForTest();
  const old = anchor('old', 'bio-old', '旧稿记载沉睡之眼在486年秋焚毁。', 'source:old');
  const current = anchor('new', 'bio-new', '新稿记载沉睡之眼在486年秋仅被查封。', 'source:new');
  const parallel = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current], existingAnchors: [old],
    proposals: [{ kind: 'parallelView', currentEventRef: current.eventId, otherHandle: 'C1',
      dimension: 'outcome', producerUnitRef: 'stage-1', otherAnchorId: old.anchorId }], createdAt: 20,
  });
  const conflict = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current], existingAnchors: [old],
    proposals: [{ kind: 'sourceConflict', currentEventRef: current.eventId, otherHandle: 'C1',
      dimension: 'outcome', producerUnitRef: 'stage-1', otherAnchorId: old.anchorId }], createdAt: 20,
  });
  assert.equal(parallel[0]?.kind, 'parallelView');
  assert.equal(conflict[0]?.kind, 'sourceConflict');
  assert.deepEqual(buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current], existingAnchors: [old],
    proposals: [], createdAt: 20,
  }), []);
});

test('PV-01 真机回归：宽松召回交给语义复核，只有 sameEvent 裁决形成关系', () => {
  clearContinuityRelationDiagnosticsForTest();
  const old = handoverAnchor({
    id: 'old-handover', artifactId: 'bio-old', unitId: 'stage-4',
    eventId: 'invented:stage-4:tide_handover', year: 484,
    claim: '复兴纪元484年秋，在艾瑟嘉德外港雾气中，洛安将手札正式交付给水文学者弥拉，完成暮潮移交。',
  });
  const current = handoverAnchor({
    id: 'new-handover', artifactId: 'bio-new', unitId: 'stage-5',
    eventId: 'invented:stage-5:autumn_handover', year: 485,
    claim: '复兴纪元485年秋外港第七泊位洛安正式将手札移交弥拉，完成暮潮移交',
  });
  const pairs = recallContinuityEventPairCandidates({
    currentEvents: [{
      producerUnitRef: 'stage-5', currentEventRef: current.eventId,
      participants: current.participants.map(item => item.name),
      locations: current.locations.map(item => item.name),
      objects: (current.objects ?? []).map(item => item.name),
    }],
    continuityView: viewOf(old),
  });
  assert.equal(pairs.length, 1);
  const relations = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current],
    existingAnchors: [old], proposals: [{
      kind: 'auto', currentEventRef: current.eventId, otherHandle: pairs[0]!.otherHandle,
      dimension: 'time', producerUnitRef: 'stage-5', otherAnchorId: pairs[0]!.otherAnchorId,
    }], createdAt: 20,
  });
  assert.equal(relations.length, 1);
  assert.equal(relations[0]?.kind, 'parallelView');
  assert.equal(relations[0]?.dimension, 'time');
  assert.ok(listContinuityRelationDiagnostics().some(item => item.code === 'relation-created'));
});

test('语义裁决为同一事件且有双边不同来源时，脚本自动形成 sourceConflict', () => {
  const old = {
    ...handoverAnchor({
      id: 'old-source', artifactId: 'bio-old', unitId: 'stage-4',
      eventId: 'invented:stage-4:tide_handover', year: 484,
      claim: '来源甲记载暮潮移交发生于复兴纪元484年秋。',
    }),
    sourceRefs: ['worldbook:source-a'], stance: 'asserted' as const,
  };
  const current = {
    ...handoverAnchor({
      id: 'new-source', artifactId: 'bio-new', unitId: 'stage-5',
      eventId: 'invented:stage-5:autumn_handover', year: 485,
      claim: '来源乙记载暮潮移交发生于复兴纪元485年秋。',
    }),
    sourceRefs: ['worldbook:source-b'], stance: 'asserted' as const,
  };
  const relations = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current],
    existingAnchors: [old], proposals: [{
      kind: 'auto', currentEventRef: current.eventId, otherHandle: 'C1', dimension: 'time',
      producerUnitRef: 'stage-5', otherAnchorId: old.anchorId,
    }], createdAt: 20,
  });
  assert.equal(relations[0]?.kind, 'sourceConflict');
  assert.equal(relations[0]?.dimension, 'time');
  assert.deepEqual(relations[0]?.sourceRefs, ['worldbook:source-a', 'worldbook:source-b']);
});

test('宽松召回可以包含相似事件，但没有 sameEvent 裁决绝不自动建关系', () => {
  const old = handoverAnchor({
    id: 'old-safe', artifactId: 'bio-old', unitId: 'stage-4',
    eventId: 'invented:stage-4:tide_handover', year: 484,
    claim: '复兴纪元484年秋洛安在第七泊位将暮潮手札交给弥拉。',
  });
  const otherEvent = handoverAnchor({
    id: 'other-event', artifactId: 'bio-other', unitId: 'stage-5',
    eventId: 'invented:stage-5:chapel_pledge', year: 485,
    claim: '复兴纪元485年秋，洛安与弥拉在第七泊位以暮潮手札共同立誓。',
  });
  const pairs = recallContinuityEventPairCandidates({
    currentEvents: [{
      producerUnitRef: 'stage-5', currentEventRef: otherEvent.eventId,
      participants: otherEvent.participants.map(item => item.name),
      locations: otherEvent.locations.map(item => item.name),
      objects: (otherEvent.objects ?? []).map(item => item.name),
    }],
    continuityView: viewOf(old),
  });
  assert.equal(pairs.length, 1, '召回可以宁可多给模型看，但不得直接当作关系');
  assert.deepEqual(buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-other', newAnchors: [otherEvent],
    existingAnchors: [old], proposals: [], createdAt: 20,
  }), []);
});

test('《暮潮手札》真机错配回归：河床事件可召回但只连接语义判定的移交事件', () => {
  const oldHandover = handoverAnchor({
    id: 'old-real-handover', artifactId: 'bio-old', unitId: 'stage-4',
    eventId: 'invented:stage-4:tide_handover', year: 484,
    claim: '复兴纪元484年秋，洛安将《暮潮手札》正式移交给弥拉。',
  });
  const oldRiverbed = {
    ...handoverAnchor({
      id: 'old-riverbed', artifactId: 'bio-old', unitId: 'stage-2',
      eventId: 'invented:stage-2:riverbed_migration', year: 479,
      claim: '复兴纪元479年，洛安依据手札重画旱季河床走向。',
    }),
    locations: [{ name: '双岔石滩' }],
    participants: [{ name: '暮潮手札' }, { name: '洛安' }],
  };
  const newHandover = handoverAnchor({
    id: 'new-real-handover', artifactId: 'bio-new', unitId: 'stage-5',
    eventId: 'invented:stage-5:autumn_handover', year: 485,
    claim: '复兴纪元485年秋，洛安在第七泊位将《暮潮手札》正式移交给弥拉。',
  });
  const newRiverbed = {
    ...handoverAnchor({
      id: 'new-riverbed', artifactId: 'bio-new', unitId: 'stage-1',
      eventId: 'invented:stage-1:riverbed_charting', year: 476,
      claim: '复兴纪元476年，洛安用手札记录河床泥沙折线。',
    }),
    locations: [{ name: '双岔石滩' }],
    participants: [{ name: '暮潮手札' }, { name: '洛安' }],
  };
  const currentEvents = [newHandover, newRiverbed].map(value => ({
    producerUnitRef: value.producer.unitId,
    currentEventRef: value.eventId,
    participants: value.participants.map(item => item.name),
    locations: value.locations.map(item => item.name),
    objects: (value.objects ?? []).map(item => item.name),
  }));
  const pairs = recallContinuityEventPairCandidates({
    currentEvents,
    continuityView: viewOfMany([oldHandover, oldRiverbed]),
  });
  assert.ok(pairs.some(pair => pair.currentEventRef === newRiverbed.eventId
    && pair.otherAnchorId === oldRiverbed.anchorId), '河床候选允许被宽松召回');
  const handoverPair = pairs.find(pair => pair.currentEventRef === newHandover.eventId
    && pair.otherAnchorId === oldHandover.anchorId);
  assert.ok(handoverPair, '移交候选必须被召回');
  const relations = buildContinuityViewRelationsSafely({
    namespace: namespaceId,
    artifactId: 'bio-new',
    newAnchors: [newHandover, newRiverbed],
    existingAnchors: [oldHandover, oldRiverbed],
    proposals: [{
      kind: 'auto',
      currentEventRef: newHandover.eventId,
      otherHandle: handoverPair.otherHandle,
      dimension: 'time',
      producerUnitRef: newHandover.producer.unitId,
      otherAnchorId: handoverPair.otherAnchorId,
    }],
    createdAt: 20,
  });
  assert.equal(relations.length, 1);
  assert.deepEqual(relations[0]?.memberAnchorIds,
    [oldHandover.anchorId, newHandover.anchorId].sort());
});

test('PV-06/PV-07 未知句柄局部丢弃，合法重复候选稳定折叠', () => {
  const old = anchor('old', 'bio-old', '玲山在486年持有《白日尽头》。', 'source:old');
  const current = anchor('new', 'bio-new', '玲山在486年把《白日尽头》封存。', 'source:new');
  const proposal = { kind: 'parallelView' as const, currentEventRef: current.eventId,
    otherHandle: 'C1', dimension: 'objectState' as const, producerUnitRef: 'stage-1',
    otherAnchorId: old.anchorId };
  const relations = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current], existingAnchors: [old],
    proposals: [{ ...proposal, otherHandle: 'C99', otherAnchorId: '' }, proposal, proposal], createdAt: 20,
  });
  assert.equal(relations.length, 1);
  assert.match(relations[0]!.relationId, /^continuity-relation:/u);
  assert.ok(listContinuityRelationDiagnostics().some(item => item.code === 'unknown-handle'));
});

test('PV-11 来源不足的 sourceConflict 被丢弃且不会自动降级', () => {
  const old = anchor('old', 'bio-old', '玲山说书店已焚毁。', 'source:same');
  const current = anchor('new', 'bio-new', '玲山说书店仍然开放。', 'source:same');
  const relations = buildContinuityViewRelationsSafely({
    namespace: namespaceId, artifactId: 'bio-new', newAnchors: [current], existingAnchors: [old],
    proposals: [{ kind: 'sourceConflict', currentEventRef: current.eventId, otherHandle: 'C1',
      dimension: 'outcome', producerUnitRef: 'stage-1', otherAnchorId: old.anchorId }], createdAt: 20,
  });
  assert.deepEqual(relations, []);
  assert.equal(listContinuityRelationDiagnostics().at(-1)?.code, 'source-conflict-source-insufficient');
});

test('PV-04/PV-12 三视角簇只投递两条、共享六锚与1600字符预算且不泄露内部ID', () => {
  const a = anchor('a', 'bio-a', '沉睡之眼在486年秋焚毁。', 'source:a');
  const b = anchor('b', 'bio-b', '沉睡之眼在486年秋被查封。', 'source:b');
  const c = anchor('c', 'bio-c', '沉睡之眼在486年秋迁入暗渠。', 'source:c');
  const r1 = relation('r1', a, b, 'bio-b');
  const r2 = relation('r2', b, c, 'bio-c');
  const records = [record(a), record(b, [r1]), record(c, [r2])];
  const view = buildContinuityViewSafely({
    records, branchId: 'branch:a', canonRevision: 3, query: '沉睡之眼书店 486年',
  });
  assert.equal(view.relationGroups.length, 1);
  assert.equal(view.relationGroups[0]?.omittedMemberCount, 1);
  assert.equal(view.anchors.length, 2);
  assert.ok(view.anchors.length <= 6);
  const rendered = renderContinuityView(view, { includeRelations: true }).join('\n');
  assert.match(rendered, /并存视角/u);
  assert.doesNotMatch(rendered, /continuity-anchor:|continuity-relation:|binding:/u);
  const sharedCost = view.anchors.reduce((sum, item) => sum + item.claim.length
    + item.time.length + item.participants.join('').length + item.locations.join('').length + 48, 0) + 80;
  assert.ok(sharedCost <= 1_600);
});

test('PV-05/PV-09/PV-10 删除、revision 前进与回滚会确定性重算当前关系', () => {
  const a = anchor('a', 'bio-a', '沉睡之眼在486年秋焚毁。', 'source:a');
  const b = anchor('b', 'bio-b', '沉睡之眼在486年秋被查封。', 'source:b');
  const rel = relation('r', a, b, 'bio-b');
  const records = [record(a), record(b, [rel])];
  assert.equal(currentRelations(records, 3).length, 1);
  assert.equal(currentRelations([record(a)], 3).length, 0);
  assert.equal(currentRelations(records, 4).length, 0);
  assert.equal(currentRelations(records, 3).length, 1);
  records[0]!.canonBindings![0]!.factIds = ['fact:old-view'];
  const filtered = buildContinuityViewSafely({
    records, branchId: 'branch:a', canonRevision: 3, query: '沉睡之眼书店',
    targetView: {
      branchId: 'branch:a', viewId: 'view:changed-without-revision', resolvedRevision: 3,
      activeFactIds: [], inactiveFactIds: ['fact:old-view'],
      resolutionReceipt: {
        appliedDeltaIds: [], skippedDeltaIds: [], supersededDeltaIds: [], uncertainItems: [],
      },
    },
  });
  assert.equal(filtered.relationGroups.length, 0);
});

test('PV-08 旧存档与损坏关系记录 fail-open，诊断可读且不影响锚', () => {
  const a = anchor('a', 'bio-a', '沉睡之眼在486年秋焚毁。', 'source:a');
  const b = anchor('b', 'bio-b', '沉睡之眼在486年秋被查封。', 'source:b');
  const broken = { schema: 'eyon.continuity.relation.v1', memberAnchorIds: ['only-one'] };
  const oldRecord = record(a);
  const corruptRecord = { ...record(b), continuityRelations: [broken] } as unknown as BiographyRecord;
  const inspection = inspectContinuityAnchors({
    records: [oldRecord, corruptRecord], branchId: 'branch:a', canonRevision: 3,
  });
  assert.equal(inspection.counts.currentAnchors, 2);
  assert.equal(inspection.counts.currentRelations, 0);
  assert.ok(inspection.relationDiagnostics.some(item => item.code === 'corrupt-record'));
});

function currentRelations(records: BiographyRecord[], revision: number) {
  const anchors = records.flatMap(item => item.continuityAnchors ?? [])
    .filter(item => item.canonRevision === revision);
  return continuityRelationsFromCommittedRecords({
    records, anchors, namespace: namespaceId, branchId: 'branch:a', canonRevision: revision,
  });
}

function anchor(
  id: string,
  artifactId: string,
  claim: string,
  sourceRef: string,
): GeneratedContinuityAnchor {
  return {
    schema: 'eyon.continuity.anchor.v1', anchorId: `continuity-anchor:${id}`,
    branchId: 'branch:a', canonRevision: 3,
    producer: { artifactType: 'biography', artifactId, unitId: 'stage-1', bindingId: `binding:${artifactId}` },
    eventId: 'event:沉睡之眼:486', claimSource: 'final-prose', claim,
    temporalScope: { label: '复兴纪元486年秋' },
    participants: [{ entityId: 'entity:沉睡之眼', name: '沉睡之眼书店' }],
    locations: [{ name: '瓦伦蒂亚旧城区' }], objects: [], sourceRefs: [sourceRef],
    stance: 'asserted', createdAt: id.charCodeAt(0),
  };
}

function handoverAnchor(input: {
  id: string;
  artifactId: string;
  unitId: string;
  eventId: string;
  year: number;
  claim: string;
}): GeneratedContinuityAnchor {
  return {
    schema: 'eyon.continuity.anchor.v1', anchorId: `continuity-anchor:${input.id}`,
    branchId: 'branch:a', canonRevision: 3,
    producer: { artifactType: 'biography', artifactId: input.artifactId, unitId: input.unitId },
    eventId: input.eventId, claimSource: 'final-prose', claim: input.claim,
    temporalScope: {
      label: `${input.year}年 - ${input.year + 1}年`,
      start: `复兴纪元${input.year}年9月`,
    },
    participants: [{ name: '暮潮手札' }, { name: '洛安' }, { name: '弥拉' }],
    locations: [{ name: '艾瑟嘉德外港' }, { name: '第七泊位' }],
    objects: [{ name: '《暮潮手札》' }], sourceRefs: [],
    stance: 'hypothesis', createdAt: input.year,
  };
}

function viewOf(value: GeneratedContinuityAnchor) {
  return viewOfMany([value]);
}

function viewOfMany(values: GeneratedContinuityAnchor[]) {
  return {
    schema: 'eyon.continuity.view.v1' as const,
    branchId: values[0]!.branchId,
    canonRevision: values[0]!.canonRevision,
    queryScopeHash: 'scope:test',
    anchors: values.map((value, index) => ({
      anchorId: value.anchorId, handle: `C${index + 1}`, claim: value.claim,
      time: value.temporalScope.label,
      participants: value.participants.map(item => item.name),
      locations: value.locations.map(item => item.name),
      objects: (value.objects ?? []).map(item => item.name),
      stance: value.stance, origin: value.producer.unitId,
    })),
    relationGroups: [], omittedCount: 0, warnings: [],
  };
}

function relation(
  id: string,
  left: GeneratedContinuityAnchor,
  right: GeneratedContinuityAnchor,
  producerArtifactId: string,
): ContinuityViewRelation {
  return {
    schema: 'eyon.continuity.relation.v1', relationId: `continuity-relation:${id}`,
    namespace: namespaceId, branchId: 'branch:a', canonRevision: 3,
    kind: 'parallelView', dimension: 'outcome',
    memberAnchorIds: [left.anchorId, right.anchorId].sort() as [string, string],
    sourceRefs: [...left.sourceRefs, ...right.sourceRefs], producerArtifactId,
    producerUnitRef: 'stage-1', createdAt: 20,
  };
}

function record(
  value: GeneratedContinuityAnchor,
  continuityRelations?: ContinuityViewRelation[],
): BiographyRecord {
  const binding: ArtifactCanonBinding = {
    schema: 'eyon.canon.artifact-binding.v1', bindingId: value.producer.bindingId!,
    branchId: value.branchId, artifactType: 'biography', artifactId: value.producer.artifactId,
    unitType: 'stage', unitId: value.producer.unitId,
    boundView: { viewId: 'view:a', resolvedRevision: value.canonRevision, queryScopeHash: 'scope:a' },
    entityIds: ['entity:沉睡之眼'], factIds: [], operationRefs: [], sourceRefs: value.sourceRefs,
    createdAt: value.createdAt,
  };
  return {
    key: `key:${value.producer.artifactId}`, namespace, biographyId: value.producer.artifactId,
    requestId: `request:${value.producer.artifactId}`, triggerMessageId: 1, assistantMessageId: 2,
    sourceHash: 'hash', status: 'committed', revision: 2, biography: {} as BiographyRecord['biography'],
    canonBindings: [binding], continuityAnchors: [value],
    ...(continuityRelations ? { continuityRelations } : {}),
    createdAt: value.createdAt, updatedAt: value.createdAt,
  };
}
