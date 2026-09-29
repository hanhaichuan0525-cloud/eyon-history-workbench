import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  EvidencePassage,
  EventFrame,
  RetrievalTaskType,
  WorldKnowledgeCatalog,
} from '../src/retrieval/contracts.ts';
import { buildQualifiedEvidenceView } from '../src/retrieval/qualification.ts';
import { buildEventFrame } from '../src/retrieval/cast.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';

const empireId = 'entity:empire';
const ruinId = 'entity:crying-sky-ruin';
const cloudId = 'entity:cloud-sea';
const islandId = 'entity:star-sleep-island';
const nordId = 'entity:nordgaard';
const continentId = 'entity:astalia';

const frame: EventFrame = {
  schema: 'eyon.retrieval.event-frame.v1',
  action: '英雄纪元，奥古斯提姆帝国，第二次位面入侵时帝国军方的英雄群像',
  directEntityIds: [empireId],
  temporalTerms: ['英雄纪元'],
  // 模拟正文/MVU 里还出现了当前场景地点；它不得污染玩家表单地点。
  locationEntityIds: [empireId, islandId],
  collectiveTargets: [],
};

const catalog: WorldKnowledgeCatalog = {
  schema: 'eyon.retrieval.world-knowledge-catalog.v1',
  entities: [
    entity(empireId, '奥古斯提姆帝国', ['place', 'faction'], ['snapshot:empire']),
    entity(ruinId, '泣空遗迹', ['place'], ['snapshot:ruin']),
    entity(cloudId, '泣歌云海', ['place'], ['snapshot:ruin']),
    entity(islandId, '星眠之岛', ['place'], []),
    entity(nordId, '诺斯加德联盟', ['place', 'faction'], ['snapshot:nord']),
    entity(continentId, '阿斯塔利亚大陆', ['place'], []),
  ],
  relations: [
    {
      relationId: 'relation:ruin-cloud',
      subjectEntityId: ruinId,
      predicate: 'located_in',
      objectEntityId: cloudId,
      status: 'explicit',
      sourceSnapshotIds: ['snapshot:ruin'],
      spans: [],
    },
    {
      relationId: 'relation:empire-continent',
      subjectEntityId: empireId,
      predicate: 'located_in',
      objectEntityId: continentId,
      status: 'explicit',
      sourceSnapshotIds: ['snapshot:empire'],
      spans: [],
    },
    {
      relationId: 'relation:nord-continent',
      subjectEntityId: nordId,
      predicate: 'located_in',
      objectEntityId: continentId,
      status: 'explicit',
      sourceSnapshotIds: ['snapshot:nord'],
      spans: [],
    },
  ],
  adjacency: { [ruinId]: [cloudId] },
  reverseAdjacency: { [cloudId]: [ruinId] },
  coverage: [
    {
      snapshotId: 'snapshot:empire',
      status: 'indexed',
      entityIds: [empireId],
      fullTextIndexed: true,
      reason: 'fixture',
    },
    {
      snapshotId: 'snapshot:ruin',
      status: 'indexed',
      entityIds: [ruinId, cloudId],
      fullTextIndexed: true,
      reason: 'fixture',
    },
    {
      snapshotId: 'snapshot:nord',
      status: 'indexed',
      entityIds: [nordId],
      fullTextIndexed: true,
      reason: 'fixture',
    },
  ],
  temporalEligibility: {
    schema: 'eyon.retrieval.temporal-eligibility.v1',
    eraOrder: ['神明纪元', '英雄纪元', '复兴纪元'],
    rules: [],
  },
  buildDurationMs: 0,
};

const passages: EvidencePassage[] = [
  passage(
    'passage:empire',
    'snapshot:empire',
    'worldbook:empire',
    '奥古斯提姆帝国军方',
    '英雄纪元的奥古斯提姆帝国军队抵抗第二次位面入侵。',
    ['英雄纪元'],
  ),
  passage(
    'passage:ruin',
    'snapshot:ruin',
    'worldbook:ruin',
    '泣空遗迹',
    '泣空遗迹位于三万米高空的泣歌云海，是战争结束时留下的遗产。',
    ['英雄纪元'],
  ),
  passage(
    'passage:nord',
    'snapshot:nord',
    'worldbook:nord',
    '诺斯加德联盟-奥古斯提姆帝国威胁评估',
    '该联盟长期把奥古斯提姆帝国视为南方威胁，并与帝国保持外交往来。',
    [],
  ),
];

test('人物全名及关系标题不会被误当作请求地点', () => {
  const person = entity('entity:lingshan', '玲山·哈姆斯沃思', ['person'], ['snapshot:person']);
  const falseSurnamePlace = entity('entity:hamsworth-place', '哈姆斯沃思', ['place'], ['snapshot:voice']);
  const falseHeadingPlace = entity('entity:to-lingshan-place', '对玲山·哈姆斯沃思', ['place'], ['snapshot:voice']);
  const localCatalog: WorldKnowledgeCatalog = {
    ...catalog,
    entities: [person, falseSurnamePlace, falseHeadingPlace],
    relations: [],
    adjacency: {},
    reverseAdjacency: {},
    coverage: [],
  };
  const result = buildEventFrame('对玲山·哈姆斯沃思进行寻根溯源', localCatalog);
  assert.ok(result.directEntityIds.includes(person.entityId));
  assert.deepEqual(result.locationEntityIds, []);
});

test('Qualified Evidence：相关的外部遗迹不自动成为本轮地理舞台', () => {
  const view = buildQualifiedEvidenceView({
    taskType: 'ruin',
    frame,
    passages,
    claims: [],
    catalog,
    requestedLocations: ['奥古斯提姆帝国'],
  });

  const empire = view.passages.find(item => item.passageId === 'passage:empire');
  const ruin = view.passages.find(item => item.passageId === 'passage:ruin');
  assert.equal(empire?.geographic.fit, 'stage');
  assert.ok(empire?.allowedUses.includes('stage'));
  assert.equal(ruin?.geographic.fit, 'external');
  assert.equal(ruin?.eventPhase, 'reference');
  assert.ok(!ruin?.allowedUses.includes('stage'));
  assert.match(ruin?.forbiddenUses.join('\n') ?? '', /不得仅凭相关性/u);
  assert.deepEqual(view.requestedScope.locations, ['奥古斯提姆帝国']);
});

test('Qualified Evidence：正文顺带提及目标地点不取得舞台或历史演员资格', () => {
  const view = buildQualifiedEvidenceView({
    taskType: 'ruin',
    frame,
    passages,
    claims: [],
    catalog,
    requestedLocations: ['奥古斯提姆帝国'],
  });
  const nord = view.passages.find(item => item.passageId === 'passage:nord');
  assert.equal(nord?.geographic.fit, 'external');
  assert.ok(!nord?.allowedUses.includes('stage'));
  assert.ok(!nord?.allowedUses.includes('actor'));
  assert.match(nord?.forbiddenUses.join('\n') ?? '', /年代未知/u);
});

test('P0-D：同一来源其他段落的地点不会投射到当前 passage', () => {
  const sharedPassage = passage(
    'passage:shared-local',
    'snapshot:shared-local',
    'worldbook:shared-local',
    '帝国边境战报',
    '英雄纪元的帝国边境守军正在抵挡位面入侵。',
    ['英雄纪元'],
  );
  const empire = entity(empireId, '奥古斯提姆帝国', ['place'], ['snapshot:shared-local']);
  const bania = entity('entity:bania', '梵尼亚', ['place'], ['snapshot:shared-local']);
  const view = buildQualifiedEvidenceView({
    taskType: 'ruin',
    frame: { ...frame, directEntityIds: [], locationEntityIds: [] },
    passages: [sharedPassage],
    claims: [],
    catalog: {
      ...catalog,
      entities: [empire, bania],
      relations: [],
      adjacency: {},
      reverseAdjacency: {},
      coverage: [{
        snapshotId: 'snapshot:shared-local',
        status: 'indexed',
        entityIds: [empire.entityId, bania.entityId],
        fullTextIndexed: true,
        reason: 'fixture-source-wide-coverage',
      }],
    },
    requestedLocations: ['梵尼亚'],
  });

  assert.equal(view.passages[0].geographic.fit, 'unknown');
  assert.ok(!view.passages[0].allowedUses.includes('stage'));
  assert.ok(!view.passages[0].entityRoles.some(role => role.name === '梵尼亚'));
});

test('Qualified Evidence：四模块消费同一资格合同且保留 OPEN 创作区', () => {
  const taskTypes: RetrievalTaskType[] = ['biography', 'genealogy', 'ruin', 'butterfly'];
  const views = taskTypes.map(taskType => buildQualifiedEvidenceView({
    taskType,
    frame,
    passages,
    claims: [],
    catalog,
    requestedLocations: ['奥古斯提姆帝国'],
  }));
  const sharedProjection = views.map(view => view.passages.map(item => ({
    passageId: item.passageId,
    temporal: item.temporal.fit,
    geographic: item.geographic.fit,
    uses: item.allowedUses,
  })));
  assert.deepEqual(sharedProjection[1], sharedProjection[0]);
  assert.deepEqual(sharedProjection[2], sharedProjection[0]);
  assert.deepEqual(sharedProjection[3], sharedProjection[0]);
  assert.match(views[0].creativePolicy.open, /自由创造/u);
  assert.match(views[0].creativePolicy.open, /局部人物/u);
});

test('Qualified Evidence：旧生成产物保持 GUIDED 且不能覆盖当前有效历史', () => {
  const generated = passage(
    'passage:old-biography',
    'snapshot:old-biography',
    'biography:old',
    '旧传记',
    '旧版本人物经历。',
    ['英雄纪元'],
    'biography',
  );
  const view = buildQualifiedEvidenceView({
    taskType: 'butterfly',
    frame,
    passages: [generated],
    claims: [],
    catalog: {
      ...catalog,
      coverage: [{
        snapshotId: 'snapshot:old-biography',
        status: 'opaque',
        entityIds: [],
        fullTextIndexed: true,
        reason: 'fixture',
      }],
    },
    requestedLocations: ['奥古斯提姆帝国'],
  });
  assert.equal(view.passages[0].zone, 'guided');
  assert.equal(view.passages[0].revision.fit, 'unresolved');
  assert.match(view.passages[0].forbiddenUses.join('\n'), /不得用未仲裁的旧产物覆盖/u);
});

test('Qualified Evidence：公开回执保留资格详情但不泄露 passage 正文', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    await createSourceSnapshot({
      logicalId: 'worldbook:empire',
      sourceType: 'worldbook',
      title: '奥古斯提姆帝国军方',
      content: '英雄纪元的奥古斯提姆帝国军队抵抗第二次位面入侵。',
      sourceOrder: 0,
      metadata: {},
    }),
  ]);
  const result = await engine.retrieve({
    requestId: 'qualification-receipt',
    taskType: 'ruin',
    mode: 'active',
    query: frame.action,
  });
  const detail = result.bundle.receipt.qualification?.details[0];
  assert.ok(detail);
  assert.ok(Array.isArray(detail.allowedUses));
  assert.equal('content' in detail, false);
});

function entity(
  entityId: string,
  canonicalName: string,
  kinds: WorldKnowledgeCatalog['entities'][number]['kinds'],
  sourceSnapshotIds: string[],
): WorldKnowledgeCatalog['entities'][number] {
  return {
    entityId,
    canonicalName,
    normalizedName: canonicalName,
    aliases: [],
    kinds,
    tags: [],
    temporalScopes: ['英雄纪元'],
    locationScopes: [],
    identities: [],
    sourceSnapshotIds,
    spans: [],
  };
}

function passage(
  passageId: string,
  snapshotId: string,
  sourceId: string,
  title: string,
  content: string,
  temporalScopes: string[],
  sourceType: EvidencePassage['sourceType'] = 'worldbook',
): EvidencePassage {
  return {
    passageId,
    snapshotId,
    sourceId,
    sourceType,
    title,
    sectionPath: [],
    startOffset: 0,
    endOffset: content.length,
    extractionMode: 'full',
    content,
    contentHash: `hash:${passageId}`,
    charCount: content.length,
    matchedAnchors: [],
    temporalScopes,
    selectionReasons: [],
  };
}
