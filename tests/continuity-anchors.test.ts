import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBiographyContinuityAnchorsSafely,
  clearContinuityAnchorDiagnosticsForTest,
  CONTINUITY_VIEW_BUDGET,
  listContinuityAnchorDiagnostics,
} from '../src/core/continuityAnchors.ts';
import {
  buildContinuityViewSafely,
  inspectContinuityAnchors,
  renderContinuityView,
} from '../src/runtime/continuityAnchors.ts';
import type { ArtifactCanonBinding } from '../src/retrieval/contracts.ts';
import type { ArtifactCanonAssessmentTargetView } from '../src/core/artifactCanonAssessment.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';

const binding: ArtifactCanonBinding = {
  schema: 'eyon.canon.artifact-binding.v1',
  bindingId: 'binding:bio-a:stage-1',
  branchId: 'branch:a',
  artifactType: 'biography',
  artifactId: 'bio-a',
  unitType: 'stage',
  unitId: 'stage-1',
  boundView: { viewId: 'view:a', resolvedRevision: 3, queryScopeHash: 'scope:a' },
  entityIds: ['entity:玲山', 'entity:梅薇娜'],
  factIds: [],
  operationRefs: [],
  sourceRefs: ['worldbook:玲山'],
  createdAt: 10,
};

test('CA-01 committed biography occurs slot derives a scoped low-authority anchor', () => {
  clearContinuityAnchorDiagnosticsForTest();
  const anchors = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a',
    canonBindings: [binding],
    personCanonViews: [
      personView('entity:玲山', '玲山·哈姆斯沃思'),
      personView('entity:梅薇娜', '梅薇娜·王尔德'),
    ],
    units: [unit()],
    createdAt: 10,
  });
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].canonRevision, 3);
  assert.equal(anchors[0].stance, 'hypothesis');
  assert.equal(anchors[0].producer.bindingId, binding.bindingId);
  assert.deepEqual(anchors[0].participants.map(item => item.entityId), [
    'entity:玲山',
    'entity:梅薇娜',
  ]);
  assert.equal(listContinuityAnchorDiagnostics().at(-1)?.code, 'anchor-created');
});

test('CA-03 aftermath and local atmosphere do not publish continuity anchors', () => {
  const aftermath = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a', canonBindings: [binding], createdAt: 10,
    units: [{ ...unit(), eventUsage: 'aftermath' }],
  });
  const atmosphere = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a', canonBindings: [binding], createdAt: 10,
    units: [{
      ...unit(),
      eventId: 'invented:stage-1:rain',
      claim: '玲山·哈姆斯沃思在窗边听雨。',
      locations: [], objects: [], sourceRefs: [],
    }],
  });
  assert.deepEqual(aftermath, []);
  assert.deepEqual(atmosphere, []);
});

test('P4-A2 final prose critical fact refines the same event without consuming a second view slot', () => {
  const storeBinding: ArtifactCanonBinding = {
    ...binding,
    bindingId: 'binding:bio-a:stage-1:store',
    entityIds: [],
    sourceRefs: ['worldbook:沉睡之眼书店'],
  };
  const units = [
    {
      ...unit(),
      eventId: 'invented:stage-1:raid',
      claim: '复兴纪元四八六年，沉睡之眼书店遭到帝国侦查队搜查。',
      people: [],
      factions: ['沉睡之眼书店', '帝国侦查队'],
      objects: [],
      locations: ['艾瑟嘉德学者区'],
    },
    {
      ...unit(),
      eventId: 'invented:stage-1:raid',
      claimSource: 'final-prose' as const,
      claim: '复兴纪元四八六年秋，沉睡之眼书店在帝国侦查队搜查后化为焦土，未获修复。',
      people: [],
      factions: ['沉睡之眼书店', '帝国侦查队'],
      objects: [],
      locations: ['艾瑟嘉德学者区'],
    },
  ];
  const anchors = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a',
    canonBindings: [storeBinding],
    units,
    createdAt: 10,
  });
  assert.equal(anchors.length, 2, '记录内保留事件槽 fallback 与最终正文补充');
  assert.equal(anchors.filter(anchor => anchor.claimSource === 'final-prose').length, 1);

  const view = buildContinuityViewSafely({
    records: [record('committed', anchors, 'bio-a', [storeBinding])],
    branchId: 'branch:a',
    canonRevision: 3,
    query: '沉睡之眼书店的建筑与存续历史',
  });
  assert.equal(view.anchors.length, 1, '同一冻结事件不得挤占两个投递槽');
  assert.match(view.anchors[0]?.claim ?? '', /四八六年秋.*化为焦土.*未获修复/u);
  assert.doesNotMatch(view.anchors[0]?.claim ?? '', /仅遭到.*搜查/u);
});

test('P4-A2 keeps named object destruction and unique transfer as separate low-authority events', () => {
  const cameraBinding: ArtifactCanonBinding = {
    ...binding,
    bindingId: 'binding:bio-a:stage-camera',
    unitId: 'stage-camera',
  };
  const giftBinding: ArtifactCanonBinding = {
    ...binding,
    bindingId: 'binding:bio-a:stage-gift',
    unitId: 'stage-gift',
  };
  const anchors = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a',
    canonBindings: [cameraBinding, giftBinding],
    units: [
      {
        ...unit(),
        unitId: 'stage-camera',
        eventId: 'invented:stage-camera:destroyed',
        claimSource: 'final-prose',
        claim: '复兴纪元四八一年，玲山·哈姆斯沃思的旧式留影相机原件在越境途中毁坏，此后只剩底片与记录。',
        objects: ['旧式留影相机'],
      },
      {
        ...unit(),
        unitId: 'stage-gift',
        eventId: 'invented:stage-gift:book',
        claimSource: 'final-prose',
        claim: '复兴纪元四八五年冬，梅薇娜·王尔德唯一一次把《白日尽头》赠予玲山·哈姆斯沃思，此后原书一直由玲山保存。',
        objects: ['《白日尽头》'],
      },
    ],
    createdAt: 10,
  });
  assert.equal(anchors.length, 2);
  const records = [record(
    'committed',
    anchors,
    'bio-a',
    [cameraBinding, giftBinding],
  )];
  const cameraView = buildContinuityViewSafely({
    records,
    branchId: 'branch:a',
    canonRevision: 3,
    query: '玲山旧式留影相机原件后来还能否使用',
  });
  assert.match(cameraView.anchors.map(item => item.claim).join('\n'), /相机原件.*毁坏/u);
  const giftView = buildContinuityViewSafely({
    records,
    branchId: 'branch:a',
    canonRevision: 3,
    query: '梅薇娜赠给玲山的白日尽头',
  });
  assert.match(giftView.anchors.map(item => item.claim).join('\n'), /唯一一次.*赠予.*一直由玲山保存/u);
});

test('CA-04/CA-06 only committed records from the same branch and revision enter the view', () => {
  const anchor = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a', canonBindings: [binding], units: [unit()], createdAt: 10,
  })[0];
  const committed = record('committed', [anchor]);
  const validated = record('validated', [anchor], 'bio-draft');
  const view = buildContinuityViewSafely({
    records: [committed, validated],
    branchId: 'branch:a', canonRevision: 3,
    query: '玲山·哈姆斯沃思与梅薇娜赠书的历史',
  });
  assert.equal(view.anchors.length, 1);
  assert.equal(view.anchors[0].handle, 'C1');
  assert.equal(buildContinuityViewSafely({
    records: [committed], branchId: 'branch:a', canonRevision: 4,
    query: '玲山·哈姆斯沃思与梅薇娜赠书的历史',
  }).anchors.length, 0);
  assert.equal(buildContinuityViewSafely({
    records: [committed], branchId: 'branch:b', canonRevision: 3,
    query: '玲山·哈姆斯沃思与梅薇娜赠书的历史',
  }).anchors.length, 0);
  assert.equal(buildContinuityViewSafely({
    records: [committed], branchId: 'branch:a', canonRevision: 3,
    query: '金谷城井盖行业',
  }).anchors.length, 0);
});

test('CA-08 removing the producer record removes future visibility without touching Canon', () => {
  const anchor = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a', canonBindings: [binding], units: [unit()], createdAt: 10,
  })[0];
  const before = inspectContinuityAnchors({
    records: [record('committed', [anchor])],
    branchId: 'branch:a', canonRevision: 3,
  });
  const after = inspectContinuityAnchors({
    records: [], branchId: 'branch:a', canonRevision: 3,
  });
  assert.equal(before.counts.currentAnchors, 1);
  assert.equal(after.counts.currentAnchors, 0);
});

test('CA-05 same revision anchor is excluded when its Canon dependency is no longer current', () => {
  const factBinding: ArtifactCanonBinding = {
    ...binding,
    bindingId: 'binding:bio-a:stage-1:fact',
    factIds: ['fact:gift'],
  };
  const anchor = buildBiographyContinuityAnchorsSafely({
    artifactId: 'bio-a', canonBindings: [factBinding], units: [unit()], createdAt: 10,
  })[0];
  const targetView: ArtifactCanonAssessmentTargetView = {
    branchId: 'branch:a',
    viewId: 'view:changed-without-revision-bump',
    resolvedRevision: 3,
    activeFactIds: [],
    inactiveFactIds: ['fact:gift'],
    resolutionReceipt: {
      appliedDeltaIds: [], skippedDeltaIds: [], supersededDeltaIds: [], uncertainItems: [],
    },
  };
  const view = buildContinuityViewSafely({
    records: [record('committed', [anchor], 'bio-a', [factBinding])],
    branchId: 'branch:a', canonRevision: 3,
    query: '玲山·哈姆斯沃思与梅薇娜赠书的历史',
    targetView,
  });
  assert.equal(view.anchors.length, 0);
});

test('P4-A view stays bounded and renders natural language without internal ids', () => {
  const anchors = Array.from({ length: CONTINUITY_VIEW_BUDGET.maxAnchors + 3 }, (_, index) => {
    const artifactId = `bio-${index}`;
    const ownBinding = { ...binding, artifactId, bindingId: `binding:${index}` };
    return {
      anchor: buildBiographyContinuityAnchorsSafely({
        artifactId, canonBindings: [ownBinding], units: [{
          ...unit(),
          eventId: `invented:stage-1:gift-${index}`,
          claim: `玲山·哈姆斯沃思在复兴纪元482年接受梅薇娜·王尔德赠予的第${index + 1}册旧书。`,
        }],
        createdAt: 10 + index,
      })[0],
      binding: ownBinding,
      artifactId,
    };
  });
  const records = anchors.map(item => record(
    'committed', [item.anchor], item.artifactId, [item.binding],
  ));
  const view = buildContinuityViewSafely({
    records, branchId: 'branch:a', canonRevision: 3,
    query: '玲山·哈姆斯沃思与梅薇娜·王尔德的赠书经历',
  });
  assert.ok(view.anchors.length <= CONTINUITY_VIEW_BUDGET.maxAnchors);
  assert.ok(view.omittedCount > 0);
  const rendered = renderContinuityView(view).join('\n');
  assert.match(rendered, /低权连续性/u);
  assert.match(rendered, /来源：已提交传记/u);
  assert.doesNotMatch(rendered, /continuity-anchor:|binding:|bio-/u);
});

function unit() {
  return {
    unitId: 'stage-1',
    eventId: 'invented:stage-1:gift',
    eventUsage: 'occurs' as const,
    claim: '玲山·哈姆斯沃思在复兴纪元482年接受梅薇娜·王尔德赠予的《白日尽头》。',
    temporalScope: {
      label: '复兴纪元482年', start: '复兴纪元482年', end: '复兴纪元482年',
    },
    people: ['玲山·哈姆斯沃思', '梅薇娜·王尔德'],
    factions: [],
    objects: ['《白日尽头》'],
    locations: ['晨曙书局'],
    sourceRefs: ['worldbook:玲山'],
    inference: true,
  };
}

function personView(entityId: string, canonicalName: string) {
  return {
    schema: 'eyon.retrieval.person-canon-view.v1' as const,
    entityId, canonicalName, aliases: [], requiredFactIds: [], relevantFactIds: [],
    facts: [], sourceSnapshotIds: [],
  };
}

function record(
  status: 'validated' | 'committed',
  continuityAnchors: NonNullable<BiographyRecord['continuityAnchors']>,
  biographyId = 'bio-a',
  canonBindings: ArtifactCanonBinding[] = [binding],
): BiographyRecord {
  return {
    key: `key:${biographyId}`,
    namespace: { characterKey: '角色', chatId: '聊天' },
    biographyId,
    requestId: `request:${biographyId}`,
    triggerMessageId: 1,
    assistantMessageId: status === 'committed' ? 2 : null,
    sourceHash: 'hash',
    status,
    revision: 1,
    biography: {} as BiographyRecord['biography'],
    canonBindings,
    continuityAnchors,
    createdAt: 10,
    updatedAt: 10,
  };
}
