import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTaskCitationRegistry,
  extendTaskCitationRegistry,
  mergeTaskCitationRegistries,
  maskTaskCitationIdentifiers,
  projectTaskCitationRegistrySources,
  renderTaskCitationContract,
  resolveTaskCitationHandles,
  resolveTaskCitationValues,
} from '../src/retrieval/citations.ts';
import type {
  EvidencePassage,
  PersonCanonView,
  SourceSnapshot,
} from '../src/retrieval/contracts.ts';

const sourceId = 'worldbook:命定之诗:42';
const snapshotId = `${sourceId}@sha256:snapshot`;
const passageId = `${snapshotId}#chars:10-40@sha256:passage`;
const factId = 'fact:lingshan:book-gift';

const snapshot: SourceSnapshot = {
  schema: 'eyon.retrieval.source-snapshot.v1',
  logicalId: sourceId,
  snapshotId,
  versionHash: 'snapshot',
  sourceType: 'worldbook',
  title: '人物条目',
  content: '梅薇娜赠予玲山《白日尽头》。',
  metadata: {},
};

const passage: EvidencePassage = {
  passageId,
  snapshotId,
  sourceId,
  sourceType: 'worldbook',
  title: '人物条目',
  sectionPath: ['背景口述'],
  startOffset: 10,
  endOffset: 40,
  extractionMode: 'section',
  content: '梅薇娜赠予玲山《白日尽头》。',
  contentHash: 'passage',
  charCount: 16,
  matchedAnchors: ['玲山', '梅薇娜'],
  temporalScopes: [],
  selectionReasons: ['fixture'],
};

const personCanonView: PersonCanonView = {
  schema: 'eyon.retrieval.person-canon-view.v1',
  entityId: 'entity:lingshan',
  canonicalName: '玲山·哈姆斯沃思',
  aliases: ['玲山'],
  requiredFactIds: [factId],
  relevantFactIds: [],
  facts: [{
    factId,
    subjectEntityId: 'entity:lingshan',
    predicate: 'life-event:received',
    object: '梅薇娜赠予《白日尽头》',
    statement: '梅薇娜赠予玲山《白日尽头》。',
    temporalScope: null,
    spatialScope: null,
    epistemicStatus: 'explicit',
    confidence: 'high',
    sourceRefs: [sourceId],
    sourceSnapshotIds: [snapshotId],
    sourceSpans: [{ snapshotId, startOffset: 10, endOffset: 40 }],
    revisionIntroduced: 0,
    revisionRetired: null,
  }],
  sourceSnapshotIds: [snapshotId],
};

test('任务证据句柄按 bundle 顺序稳定建立，并只在脚本侧解析内部主键', () => {
  const registry = buildTaskCitationRegistry({
    passages: [passage],
    personCanonViews: [personCanonView],
    sourceSnapshots: [snapshot],
  });

  assert.deepEqual(registry.passages, [{ handle: 'P1', passageId }]);
  assert.deepEqual(registry.facts, [{ handle: 'F1', factId }]);
  assert.deepEqual(registry.events, []);
  assert.deepEqual(registry.sources, [{ handle: 'S1', sourceId, snapshotIds: [snapshotId] }]);
  assert.deepEqual(
    resolveTaskCitationHandles(registry, 'passage', ['P1']),
    { targetIds: [passageId], unknownHandles: [] },
  );
  assert.deepEqual(
    resolveTaskCitationHandles(registry, 'fact', ['P999']),
    { targetIds: [], unknownHandles: ['P999'] },
  );
});

test('Citation Contract v2 明示空事实表，禁止模型凭空使用 F1', () => {
  const registry = buildTaskCitationRegistry({
    passages: [passage],
    sourceSnapshots: [snapshot],
  });
  const contract = renderTaskCitationContract(registry);
  assert.match(contract, /<TASK_CITATION_CONTRACT_V2>/u);
  assert.match(contract, /"allowedFactRefs":\[\]/u);
  assert.match(contract, /"allowedEventRefs":\["SELF"\]/u);
  assert.doesNotMatch(contract, /F1/u);
});

test('跨阶段合并引用表保留旧编号并只在表尾追加', () => {
  const base = buildTaskCitationRegistry({
    passages: [passage],
    personCanonViews: [personCanonView],
    sourceSnapshots: [snapshot],
  });
  const nextPassage = { ...passage, passageId: `${passageId}:next`, contentHash: 'next' };
  const incoming = buildTaskCitationRegistry({
    passages: [nextPassage, passage],
    sourceSnapshots: [snapshot],
  });
  const merged = mergeTaskCitationRegistries(base, incoming);
  assert.deepEqual(merged.passages.map(item => item.handle), ['P1', 'P2']);
  assert.equal(merged.passages[0]?.passageId, passageId);
  assert.equal(merged.passages[1]?.passageId, nextPassage.passageId);
  assert.equal(merged.facts[0]?.handle, 'F1');
});

test('模型边界屏蔽 passage、snapshot、source 与 fact 内部主键', () => {
  const registry = buildTaskCitationRegistry({
    passages: [passage],
    personCanonViews: [personCanonView],
    sourceSnapshots: [snapshot],
  });
  const masked = maskTaskCitationIdentifiers(
    `${passageId}\n${snapshotId}\n${sourceId}\n${factId}`,
    registry,
  );

  assert.equal(masked, 'P1\nS1\nS1\nF1');
  assert.doesNotMatch(masked, /sha256|#chars:|fact:/u);
});

test('世界书编码 logicalId 与宿主原名 sourceId 统一为一个 S 来源', () => {
  const encodedSourceId = 'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97:42';
  const encodedSnapshotId = `${encodedSourceId}@sha256:encoded`;
  const encodedSnapshot = {
    ...snapshot,
    logicalId: encodedSourceId,
    snapshotId: encodedSnapshotId,
  };
  const encodedPassage = {
    ...passage,
    sourceId: encodedSourceId,
    snapshotId: encodedSnapshotId,
    passageId: `${encodedSnapshotId}#chars:0-20@sha256:encoded-passage`,
  };
  const registry = buildTaskCitationRegistry({
    passages: [encodedPassage],
    sourceSnapshots: [encodedSnapshot],
  });
  const extended = extendTaskCitationRegistry(registry, [sourceId, encodedSourceId]);
  const projected = projectTaskCitationRegistrySources(extended, [sourceId]);

  assert.deepEqual(projected.sources, [{
    handle: 'S1',
    sourceId,
    snapshotIds: [encodedSnapshotId],
  }]);
  assert.deepEqual(
    resolveTaskCitationValues(projected, 'source', ['S1'], [sourceId]),
    { targetIds: [sourceId], unknownRefs: [] },
  );
  assert.equal(
    maskTaskCitationIdentifiers(`${encodedSourceId}\n${sourceId}\n${encodedSnapshotId}`, projected),
    'S1\nS1\nS1',
  );
});
