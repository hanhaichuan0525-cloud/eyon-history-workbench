import assert from 'node:assert/strict';
import test from 'node:test';

import {
  biographyBindingUnits,
  buildArtifactCanonBindings,
  buildArtifactCanonBindingsSafely,
  butterflyBindingUnits,
  clearArtifactCanonBindingDiagnosticsForTest,
  genealogyBindingUnits,
  listArtifactCanonBindingDiagnostics,
  ruinBindingUnits,
} from '../src/core/artifactCanonBinding.ts';
import { inspectArtifactCanonBindings } from '../src/runtime/artifactCanonDiagnostics.ts';
import type { BiographyPassageResponse } from '../src/schemas/biography.ts';
import type { ButterflyResult } from '../src/schemas/butterfly.ts';
import type { GenealogyResult } from '../src/schemas/genealogy.ts';
import type { RuinCandidates } from '../src/schemas/ruin.ts';
import type {
  CanonBranch,
  CanonFact,
  CanonResolvedView,
  InterventionDelta,
} from '../src/retrieval/contracts.ts';

const factOne = fact('fact:one', 'entity:one', 'source:one');
const factTwo = fact('fact:two', 'entity:two', 'source:two');

test('AB-01 传记 origin/stage/status 只绑定各自采用的事件事实', () => {
  const view = canonView([factOne, factTwo]);
  const passages = [
    biographyPassage('origin', 'origin', factOne.factId, ['玲山'], ['source:one']),
    biographyPassage('stage', 'stage-1', factTwo.factId, ['铃羽'], ['source:two']),
    biographyPassage('status', 'status', 'SELF', ['玲山'], []),
  ];
  const bindings = buildArtifactCanonBindings({
    artifactType: 'biography',
    artifactId: 'bio-1',
    view,
    units: biographyBindingUnits(passages, ['玲山']),
    createdAt: 1,
  });
  assert.deepEqual(byUnit(bindings, 'origin').factIds, [factOne.factId]);
  assert.deepEqual(byUnit(bindings, 'stage-1').factIds, [factTwo.factId]);
  assert.deepEqual(byUnit(bindings, 'status').factIds, []);
});

test('AB-02 谱系 node 与 edge 分别消费证据名册中的人物和亲缘事实', () => {
  const result = {
    nodes: [
      { id: 'n1', name: '玲山', aliases: [], sourceRefs: ['source:one'] },
      { id: 'n2', name: '铃羽', aliases: [], sourceRefs: ['source:two'] },
    ],
    edges: [{
      id: 'e1', from: 'n1', to: 'n2', relationType: 'sibling', sourceRefs: ['source:two'],
    }],
  } as unknown as GenealogyResult;
  const roster = {
    policy: 'existing-people-and-explicit-kinship-only' as const,
    persons: [
      { canonicalName: '玲山', aliases: [], sourceRefs: ['source:one'], factIds: [factOne.factId], isFocus: true },
      { canonicalName: '铃羽', aliases: [], sourceRefs: ['source:two'], factIds: [factTwo.factId], isFocus: false },
    ],
    relations: [{
      fromName: '玲山', toName: '铃羽', relationType: 'sibling' as const,
      sourceRefs: ['source:two'], factIds: [factTwo.factId],
    }],
  };
  const bindings = buildArtifactCanonBindings({
    artifactType: 'genealogy', artifactId: 'tree-1', view: canonView([factOne, factTwo]),
    units: genealogyBindingUnits(result, roster), createdAt: 1,
  });
  assert.deepEqual(byUnit(bindings, 'n1').factIds, [factOne.factId]);
  assert.deepEqual(byUnit(bindings, 'n2').factIds, [factTwo.factId]);
  assert.deepEqual(byUnit(bindings, 'e1').factIds, [factTwo.factId]);
});

test('AB-03 同一墟境证据包不会把一个候选的事实批量绑定给兄弟候选或节点', () => {
  const result = {
    candidates: [
      ruinCandidate('c1', factOne.factId, 'node-1', 'source:one'),
      ruinCandidate('c2', factTwo.factId, 'node-2', 'source:two'),
    ],
  } as unknown as RuinCandidates;
  const bindings = buildArtifactCanonBindings({
    artifactType: 'ruin', artifactId: 'ruin-1', view: canonView([factOne, factTwo]),
    units: ruinBindingUnits(result), createdAt: 1,
  });
  assert.deepEqual(byUnit(bindings, 'c1:history').factIds, [factOne.factId]);
  assert.deepEqual(byUnit(bindings, 'c2:history').factIds, [factTwo.factId]);
  assert.deepEqual(byUnit(bindings, 'c1:node-1').factIds, []);
  assert.deepEqual(byUnit(bindings, 'c2:node-2').factIds, []);
});

test('AB-03 墟境只把候选实际引用 passage 的来源投影到对应 history 绑定', () => {
  const result = {
    candidates: [{
      ...ruinCandidate('c1', factOne.factId, 'node-1', ''),
      sourceRefs: [],
      nodes: [{ id: 'node-1', participants: [], interests: [], sourceRefs: [] }],
      canonInterpretation: {
        evidenceFactIds: [factOne.factId],
        evidencePassageIds: ['passage:selected-biography'],
        assumptions: [{
          evidenceFactIds: [],
          evidencePassageIds: ['passage:local-context'],
        }],
      },
    }],
  } as unknown as RuinCandidates;
  const bindings = buildArtifactCanonBindings({
    artifactType: 'ruin', artifactId: 'ruin-passage-sources', view: canonView([factOne]),
    units: ruinBindingUnits(result, [
      { passageId: 'passage:selected-biography', sourceId: 'biography:玲山' },
      { passageId: 'passage:local-context', sourceId: 'worldbook:黄昏花室' },
      { passageId: 'passage:visible-but-unused', sourceId: 'worldbook:无关条目' },
    ]),
    createdAt: 1,
  });
  assert.deepEqual(byUnit(bindings, 'c1:history').sourceRefs, [
    'biography:玲山',
    'worldbook:黄昏花室',
  ]);
  assert.deepEqual(byUnit(bindings, 'c1').sourceRefs, []);
  assert.deepEqual(byUnit(bindings, 'c1:node-1').sourceRefs, []);
});

test('AB-04 蝴蝶只以本地 action/operation/panel 建立绑定并追踪对应 delta', () => {
  const priorDelta = interventionDelta(factOne);
  const delta = {
    ...interventionDelta(factTwo),
    deltaId: 'delta:2',
    revision: 2,
    parentRevision: 1,
    operations: [{
      ...interventionDelta(factTwo).operations[0],
      originalFactIds: [factOne.factId],
    }],
  } as InterventionDelta;
  const branch = {
    ...canonBranch(delta),
    headRevision: 2,
    deltas: [priorDelta, delta],
  };
  const result = { sourceIds: ['chat:10'] } as unknown as ButterflyResult;
  const bindings = buildArtifactCanonBindings({
    artifactType: 'butterfly', artifactId: 'run-1',
    view: { branchId: 'branch:a', viewId: 'view:before', resolvedRevision: 0, queryScopeHash: 'scope:a' },
    appliedDeltaIds: [priorDelta.deltaId],
    branch,
    units: butterflyBindingUnits({ result, actionId: 'action:1', delta, runId: 'run-1' }),
    createdAt: 1,
  });
  assert.deepEqual(byUnit(bindings, `${delta.deltaId}:${delta.operations[0].factKey}`).operationRefs, [{
    deltaId: priorDelta.deltaId,
    factKey: priorDelta.operations[0].factKey,
  }, {
    deltaId: delta.deltaId,
    factKey: delta.operations[0].factKey,
  }]);
  assert.deepEqual(byUnit(bindings, 'run-1:panel').factIds, [factOne.factId]);
  assert.equal(
    byUnit(bindings, 'run-1:panel')
      .operationRefs.some(item => item.deltaId === delta.deltaId),
    true,
  );
});

test('AB-05/AB-08 绑定保持 branch/view 隔离且相同输入确定性等价', () => {
  const input = {
    artifactType: 'biography' as const,
    artifactId: 'bio-deterministic',
    view: canonView([factOne]),
    units: [{ unitType: 'stage', unitId: 's1', factIds: [factOne.factId] }],
    createdAt: 10,
  };
  assert.deepEqual(buildArtifactCanonBindings(input), buildArtifactCanonBindings(input));
  const otherView = canonView([factOne], 'branch:other', 'view:other');
  const other = buildArtifactCanonBindings({ ...input, view: otherView });
  assert.equal(other[0].branchId, 'branch:other');
  assert.notEqual(other[0].bindingId, buildArtifactCanonBindings(input)[0].bindingId);
  assert.equal(JSON.stringify(other).includes('正文'), false);
});

test('AB-08 同一单元重生成时追加新绑定，不原位篡改旧记录', () => {
  const base = {
    artifactType: 'ruin' as const,
    artifactId: 'ruin-regenerated',
    view: canonView([factOne]),
    units: [{ unitType: 'candidate-history', unitId: 'c1:history', factIds: [factOne.factId] }],
  };
  const first = buildArtifactCanonBindings({ ...base, createdAt: 10 });
  const second = buildArtifactCanonBindings({ ...base, createdAt: 11 });
  assert.notEqual(first[0].bindingId, second[0].bindingId);
  assert.equal(first[0].createdAt, 10);
  assert.equal(second[0].createdAt, 11);
});

test('AB-06/AB-07 旧产物保持 unbound，绑定缺失只留下有界诊断', () => {
  clearArtifactCanonBindingDiagnosticsForTest();
  const artifact = { artifactType: 'biography' as const, artifactId: 'legacy-bio' };
  const bindings = buildArtifactCanonBindingsSafely({
    ...artifact,
    units: [{ unitType: 'origin', unitId: 'origin' }],
    createdAt: 12,
  });
  assert.deepEqual(bindings, []);
  assert.equal(listArtifactCanonBindingDiagnostics()[0].code, 'binding-missing');
  const inspection = inspectArtifactCanonBindings({
    biographies: [{ biographyId: 'legacy-bio' } as never],
    genealogies: [], ruins: [], butterflies: [],
  });
  assert.equal(inspection.artifacts[0].binding, 'unbound');
  assert.equal(inspection.counts.bindingMissing, 1);
});

test('AB-07 单个单元绑定失败不吞掉同产物其他正常绑定', () => {
  clearArtifactCanonBindingDiagnosticsForTest();
  const bindings = buildArtifactCanonBindingsSafely({
    artifactType: 'biography', artifactId: 'bio-partial', view: canonView([factOne]),
    units: [
      { unitType: 'stage', unitId: 'good', factIds: [factOne.factId] },
      { unitType: 'stage', unitId: '', factIds: [factOne.factId] },
    ],
    createdAt: 13,
  });
  assert.deepEqual(bindings.map(item => item.unitId), ['good']);
  assert.equal(listArtifactCanonBindingDiagnostics()[0].unitType, 'stage');
});

function fact(factId: string, subjectEntityId: string, sourceRef: string): CanonFact {
  return {
    factId, subjectEntityId, predicate: 'state', object: factId, statement: factId,
    temporalScope: null, spatialScope: null, epistemicStatus: 'explicit', confidence: 'high',
    sourceRefs: [sourceRef], sourceSnapshotIds: [], sourceSpans: [],
    revisionIntroduced: 0, revisionRetired: null,
  };
}

function canonView(
  facts: CanonFact[],
  branchId = 'branch:a',
  viewId = 'view:a',
): CanonResolvedView {
  return {
    schema: 'eyon.canon.resolved-view.v1', viewId, branchId,
    requestedRevision: 0, resolvedRevision: 0, queryScopeHash: 'scope:a',
    activeFacts: facts, inactiveFacts: [], uncertainItems: [], eventRelations: [],
    personViews: facts.map(item => ({
      schema: 'eyon.retrieval.person-canon-view.v1', entityId: item.subjectEntityId,
      canonicalName: item.subjectEntityId === 'entity:one' ? '玲山' : '铃羽', aliases: [],
      requiredFactIds: [item.factId], relevantFactIds: [], facts: [item], sourceSnapshotIds: [],
    })),
    passageViews: [],
    resolutionReceipt: {
      schema: 'eyon.canon.resolve-receipt.v1', branchId, requestedRevision: 0,
      resolvedRevision: 0, queryScopeHash: 'scope:a', appliedDeltaIds: [],
      skippedDeltaIds: [], supersededDeltaIds: [], uncertainItems: [],
    },
  };
}

function biographyPassage(
  kind: BiographyPassageResponse['kind'],
  passageId: string,
  eventId: string,
  people: string[],
  sourceRefs: string[],
): BiographyPassageResponse {
  return {
    schema: 'eyon.biography.passage.v1', requestId: 'request-1', passageId, kind,
    title: passageId, content: '正文', people, factions: [], objects: [], locations: [],
    sourceRefs, biographyUsage: [], eventId, eventUsage: 'occurs', inference: false,
    elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
  };
}

function ruinCandidate(id: string, factId: string, nodeId: string, sourceRef: string) {
  return {
    id, sourceRefs: [sourceRef], cast: [], selectedCharacterUsage: [],
    canonInterpretation: { evidenceFactIds: [factId], assumptions: [] },
    nodes: [{ id: nodeId, participants: [], interests: [], sourceRefs: [sourceRef] }],
  };
}

function interventionDelta(current: CanonFact): InterventionDelta {
  return {
    schema: 'eyon.canon.intervention-delta.v1', deltaId: 'delta:1', branchId: 'branch:a',
    revision: 1, parentRevision: 0, actionRef: 'action:1', effectiveFrom: { label: '现在' },
    operations: [{ op: 'assert', factKey: 'entity:one|state|now', originalFactIds: [], current }],
    preconditionFactIds: [], dependsOnDeltaIds: [],
    cascadeScope: { entityIds: ['entity:one'], locations: [] }, preserves: [],
    supersedesDeltaIds: [], status: 'active', verified: true, createdAt: 1,
  };
}

function canonBranch(delta: InterventionDelta): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1', branchId: delta.branchId, characterKey: '伊雍', chatId: 'chat',
    headRevision: 1, revisions: [], actions: [], deltas: [delta], receipts: [],
    createdAt: 1, updatedAt: 1,
  };
}

function byUnit(bindings: ReturnType<typeof buildArtifactCanonBindings>, unitId: string) {
  const binding = bindings.find(item => item.unitId === unitId);
  assert.ok(binding, `missing binding for ${unitId}`);
  return binding;
}
