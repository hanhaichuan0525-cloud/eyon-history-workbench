import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextSource, GenealogyContextBundle } from '../src/core/context.ts';
import { createButtonCommand, parseTextCommand } from '../src/core/commands.ts';
import {
  extractGenealogyFocusName,
  TavernGenealogyInputProvider,
} from '../src/runtime/genealogyInput.ts';
import {
  createGenealogyIdentityAssertion,
  GenealogyTransactionGuard,
} from '../src/runtime/genealogyController.ts';
import type {
  RuntimeChatMessage,
  RuntimeContextSourceProvider,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  MemoryGenealogyRepository,
  genealogyRecordKey,
} from '../src/storage/genealogies.ts';
import { parseAndValidateGenealogy } from '../src/validators/genealogy.ts';
import { GenealogyWorkflow } from '../src/workflows/genealogy.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import { WorkbenchLifecycle } from '../src/runtime/workbenchLifecycle.ts';
import { buildGenealogyApiPrompt, buildGenealogyRepairPrompt } from '../src/prompts/genealogy.ts';
import type { GenealogyResult } from '../src/schemas/genealogy.ts';
import { GenealogyResultSchema } from '../src/schemas/genealogy.ts';
import { genealogyDisplayDates, genealogyEdgeDescription, genealogyFamilyView, genealogyRelationText, hasOriginFamily } from '../src/core/genealogyIdentity.ts';
import { createGenealogyBoardConnectors, createGenealogyBoardLayout } from '../src/ui/genealogyLayout.ts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { WorkbenchSettingsSchema } from '../src/runtime/workbenchSettings.ts';
import { WorkbenchUiClient } from '../src/ui/workbenchClient.ts';
import { buildGenealogyEvidenceRoster } from '../src/core/genealogyEvidence.ts';
import { genealogyBindingUnits } from '../src/core/artifactCanonBinding.ts';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  RETRIEVAL_RECEIPT_SCHEMA,
  SOURCE_SNAPSHOT_SCHEMA,
  type EvidenceBundle,
} from '../src/retrieval/contracts.ts';

const namespace = { characterKey: '命定之诗', chatId: '存档一' };
const requestId = 'genealogy-request-1';
const input = {
  focusCharacter: {
    mvuId: '维奥莱塔·马克西姆·奥古斯塔',
    name: '维奥莱塔·马克西姆·奥古斯塔',
    aliases: ['铁血女皇'],
  },
  depth: { ancestors: 4, descendants: 3, maxPerGeneration: 4 },
};

function makeEvidenceBundle(sources: ContextSource[]): EvidenceBundle {
  const snapshots = sources.map((source, index) => ({
    schema: SOURCE_SNAPSHOT_SCHEMA,
    logicalId: source.sourceId,
    snapshotId: `${source.sourceId}@sha256:fixture-${index}`,
    versionHash: `fixture-${index}`,
    sourceType: source.sourceType,
    title: source.title,
    content: source.content,
    sourceOrder: index,
    metadata: { sourceId: source.sourceId },
  }));
  const passages = snapshots.map((snapshot, index) => ({
    passageId: `${snapshot.snapshotId}#chars:0-${snapshot.content.length}@sha256:passage-${index}`,
    snapshotId: snapshot.snapshotId,
    sourceId: snapshot.logicalId,
    sourceType: snapshot.sourceType,
    title: snapshot.title,
    sectionPath: [],
    startOffset: 0,
    endOffset: snapshot.content.length,
    extractionMode: 'full' as const,
    content: snapshot.content,
    contentHash: `passage-${index}`,
    charCount: snapshot.content.length,
    matchedAnchors: [],
    temporalScopes: [],
    selectionReasons: ['fixture'],
  }));
  const passageBudget = {
    strategyVersion: EVIDENCE_PASSAGE_STRATEGY_VERSION,
    softLimitChars: 14_000,
    hardLimitChars: 18_000,
    fullSourceLimitChars: 8_000,
    maxWindowChars: 2_400,
    usedChars: passages.reduce((total, passage) => total + passage.charCount, 0),
  };
  return {
    schema: EVIDENCE_BUNDLE_SCHEMA,
    requestId,
    taskType: 'genealogy',
    query: 'fixture',
    sourceSnapshots: snapshots,
    passages,
    claims: [],
    conflictGroupIds: [],
    personCanonViews: [{
      schema: 'eyon.retrieval.person-canon-view.v1',
      entityId: 'entity:维奥莱塔·马克西姆·奥古斯塔',
      canonicalName: input.focusCharacter.name,
      aliases: input.focusCharacter.aliases,
      requiredFactIds: ['fact:father'],
      relevantFactIds: ['fact:father'],
      facts: [{
        factId: 'fact:father',
        subjectEntityId: 'entity:维奥莱塔·马克西姆·奥古斯塔',
        predicate: 'father',
        object: '马克西姆三世',
        statement: '父亲：马克西姆三世',
        temporalScope: null,
        spatialScope: null,
        epistemicStatus: 'explicit',
        confidence: 'high',
        sourceRefs: ['worldbook:核心:1'],
        sourceSnapshotIds: [snapshots[0].snapshotId],
        sourceSpans: [{
          snapshotId: snapshots[0].snapshotId,
          startOffset: 0,
          endOffset: snapshots[0].content.length,
        }],
        revisionIntroduced: 0,
        revisionRetired: null,
      }],
      sourceSnapshotIds: [snapshots[0].snapshotId],
    }],
    receipt: {
      schema: RETRIEVAL_RECEIPT_SCHEMA,
      requestId,
      mode: 'active',
      taskType: 'genealogy',
      profileId: 'fixture',
      queryHash: 'fixture',
      candidateSnapshotIds: snapshots.map(snapshot => snapshot.snapshotId),
      selected: snapshots.map(snapshot => ({ snapshotId: snapshot.snapshotId, reason: 'fixture' })),
      rejected: [],
      passageBudget,
      selectedPassages: passages.map(passage => ({
        snapshotId: passage.snapshotId,
        startOffset: passage.startOffset,
        endOffset: passage.endOffset,
        passageId: passage.passageId,
        reason: 'fixture',
        charCount: passage.charCount,
      })),
      rejectedPassages: [],
      warnings: [],
      omittedAnchors: [],
      passageDurationMs: 0,
      fallback: 'none',
      durationMs: 0,
    },
  };
}

function makeContext(): GenealogyContextBundle {
  const sources = [
    {
      sourceId: 'worldbook:核心:1',
      sourceType: 'worldbook' as const,
      title: '奥古斯塔皇室',
      content: '维奥莱塔继承奥古斯塔皇室。',
      authority: 100,
    },
    {
      sourceId: 'mvu-character:维奥莱塔·马克西姆·奥古斯塔',
      sourceType: 'mvu' as const,
      title: '维奥莱塔·马克西姆·奥古斯塔',
      content: '{"种族":"人类"}',
      authority: 95,
    },
  ];
  const evidenceBundle = makeEvidenceBundle(sources);
  const focus = evidenceBundle.personCanonViews![0];
  focus.facts.push({ ...focus.facts[0], factId: 'fact:birth-focus', predicate: 'birth_time', object: '复兴纪元464年' });
  evidenceBundle.personCanonViews!.push({ ...structuredClone(focus), entityId: 'entity:father', canonicalName: '马克西姆三世', aliases: [], facts: [
    { ...focus.facts[0], factId: 'fact:birth-father', subjectEntityId: 'entity:father', predicate: 'birth_time', object: '复兴纪元430年' },
    { ...focus.facts[0], factId: 'fact:death-father', subjectEntityId: 'entity:father', predicate: 'death_time', object: '复兴纪元479年' },
  ] });
  return {
    schema: 'eyon.context.v1',
    taskType: 'genealogy',
    requestId,
    scope: { ...namespace, triggerMessageId: 8 },
    currentWorld: { time: '复兴纪元488年', location: '帝都' },
    worldbookContext: [sources[0]],
    recentContext: [],
    characterContext: [sources[1]],
    biographyRefs: [],
    sourceIndex: sources,
    evidenceBundle,
    warnings: [],
    sourceHash: 'source-hash',
  };
}

function life(
  status: 'known' | 'unknown' | 'alive' | 'deceased',
  year: number | null,
  label: string,
) {
  return {
    status,
    era: year === null ? '' as const : '复兴纪元' as const,
    year,
    month: null,
    day: null,
    precision: year === null ? 'unknown' as const : 'exact' as const,
    label,
  };
}

function makeResult() {
  return {
    schema: 'eyon.genealogy.v2' as const,
    requestId,
    focusCharacterId: input.focusCharacter.mvuId,
    focusCharacterName: input.focusCharacter.name,
    depth: input.depth,
    nodes: [
      {
        id: 'focus',
        mvuId: input.focusCharacter.mvuId,
        name: input.focusCharacter.name,
        aliases: ['铁血女皇'],
        generation: 0,
        isFocus: true,
        isMvuCharacter: true,
        viewable: true as const,
        canInjectToRuin: true,
        provenance: 'explicit' as const,
        birth: life('known', 464, '复兴纪元464年'),
        death: life('alive', null, '在世'),
        race: '人类',
        identities: ['奥古斯提姆帝国女皇'],
        professions: ['统治者'],
        lifeLevel: '第六层级',
        relationToFocus: '本人',
        summary: '奥古斯提姆帝国现任女皇。',
        profile: {
          personality: '威严克制，对亲近之人保留少见的依赖。',
          lifeExperience: '在先帝牺牲后继承皇位，以强硬手段整合帝国并承担人类存续压力。',
        },
        sourceRefs: ['mvu-character:维奥莱塔·马克西姆·奥古斯塔'],
        historyRefs: [],
      },
      {
        id: 'father',
        mvuId: '',
        name: '马克西姆三世',
        aliases: [],
        generation: -1,
        isFocus: false,
        isMvuCharacter: false,
        viewable: true as const,
        canInjectToRuin: false,
        provenance: 'inferred' as const,
        birth: life('known', 430, '约复兴纪元430年'),
        death: life('deceased', 479, '复兴纪元479年'),
        race: '人类',
        identities: ['先帝'],
        professions: ['帝国统治者'],
        lifeLevel: '',
        relationToFocus: '父亲',
        summary: '维奥莱塔的父亲与前任皇帝。',
        profile: {
          personality: '审慎而重视秩序，对继承人要求近乎苛刻。',
          lifeExperience: '长期维系皇室与旧贵族的平衡，并在晚年将帝国重担交给维奥莱塔。',
        },
        sourceRefs: ['worldbook:核心:1'],
        historyRefs: [],
      },
    ],
    edges: [{
      id: 'edge-parent',
      from: 'father',
      to: 'focus',
      relationType: 'parent' as const,
      label: '父女',
      sourceRefs: ['worldbook:核心:1'],
    }],
    referenceSummary: {
      familyNames: ['奥古斯塔皇室'],
      knownResidences: ['帝都'],
      knownOrganizations: ['奥古斯提姆帝国'],
      brief: '以维奥莱塔为中心的奥古斯塔皇室谱系。',
    },
    qualityChecks: {
      focusIsMvuCharacter: true,
      generatedNodesHaveProvenance: true,
      allNodesHaveLifeDates: true,
      allNodesHaveBasicProfiles: true,
      onlyMvuNodesCanInjectToRuin: true,
      noConflictNarrative: true,
    },
  };
}

test('特殊谱系：异界肉身原点与本界抵达分开，不倒推现世界父母', () => {
  const context = makeContext();
  const result: GenealogyResult = makeResult();
  result.nodes = [result.nodes[0]]; result.edges = [];
  result.nodes[0].identity = { lineageKind: 'cross-world-travel',
    body: { world: '地球', birth: { ...life('known', 1950, '公元1950年'), era: '公元' } },
    arrival: life('known', 480, '复兴纪元480年'), originAge: { years: 60, at: life('known', 480, '复兴纪元480年') } };
  context.evidenceBundle.personCanonViews![0].facts = [];
  const before = JSON.stringify(context);
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'cross-world-travel' }, context });
  assert.equal(parsed.nodes[0].birth.era, '公元');
  assert.equal(parsed.nodes[0].identity?.arrival?.year, 480);
  assert.equal(parsed.edges.length, 0); assert.equal(JSON.stringify(context), before);
});
test('特殊谱系：机器人可保留创造者，不套生父年龄差，也不强造血亲', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'creation', activation: life('known', 485, '复兴纪元485年') };
  result.nodes[1].name = '铸造师'; result.nodes[1].birth = life('known', 484, '复兴纪元484年'); result.nodes[1].death = life('alive', null, '在世');
  result.nodes[1].sourceRefs = [];
  result.edges[0].relationType = 'creator'; result.edges[0].track = 'creation'; result.edges[0].label = '创造者'; result.edges[0].sourceRefs = [];
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'creation' }, context });
  assert.equal(parsed.nodes.find(node => node.isFocus)?.birth.status, 'unknown');
  assert.equal(parsed.edges[0].relationType, 'creator'); assert.equal(parsed.nodes.length, 2);
});
test('特殊谱系的可选说明损坏不丢失身份类别，也不逼迫重写长传', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult(); result.nodes = [result.nodes[0]]; result.edges = [];
  result.nodes[0].identity = { lineageKind: 'creation', activation: life('known', 480, '复兴纪元480年'), note: '冗长说明'.repeat(100) };
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input, context });
  assert.equal(parsed.nodes[0].identity?.lineageKind, 'creation');
  assert.equal(parsed.nodes[0].identity?.activation?.year, 480);
  assert.equal(parsed.nodes[0].identity?.note, undefined);
  assert.equal(parsed.nodes[0].profile.lifeExperience, result.nodes[0].profile.lifeExperience);
});
test('特殊谱系：灵魂源年与宿主肉身生卒分开，收养不受血亲年龄差限制', () => {
  const context = makeContext();
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'possession', soul: { world: '原界', birth: { ...life('known', 100, '神明纪元100年'), era: '神明纪元' } }, incarnation: life('known', 487, '复兴纪元487年') };
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'possession' }, context });
  assert.equal(parsed.nodes[0].identity?.body?.birth?.year, 464);
  assert.equal(parsed.nodes[0].identity?.soul?.birth?.year, 100);
  const adopted: GenealogyResult = makeResult(); context.evidenceBundle.personCanonViews = [];
  adopted.nodes[0].identity = { lineageKind: 'adoption' };
  adopted.nodes[1].name = '养父'; adopted.nodes[1].birth = life('known', 480, '复兴纪元480年'); adopted.nodes[1].death = life('alive', null, '在世'); adopted.nodes[1].sourceRefs = [];
  adopted.edges[0].relationType = 'adoptiveParent'; adopted.edges[0].track = 'social'; adopted.edges[0].sourceRefs = [];
  assert.equal(parseAndValidateGenealogy(JSON.stringify(adopted), { requestId, input, context }).nodes.length, 2);
});

test('特殊源流：创造者兼主人一个节点两条边，前代个体单独成线', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'creation', activation: life('known', 485, '复兴纪元485年') };
  result.nodes[1].name = '工匠'; result.nodes[1].sourceRefs = []; result.nodes[1].birth = life('known', 484, '复兴纪元484年');
  result.nodes[1].death = life('alive', null, '在世');
  const previous = structuredClone(result.nodes[1]); previous.id = 'previous'; previous.name = '艾琳零号';
  previous.identity = { lineageKind: 'creation', activation: life('known', 483, '复兴纪元483年') };
  result.nodes.push(previous);
  result.edges = [
    { id: 'creator', from: 'father', to: 'focus', relationType: 'creator', track: 'creation', label: '创造者', sourceRefs: [] },
    { id: 'owner', from: 'father', to: 'focus', relationType: 'owner', track: 'social', label: '主人', sourceRefs: [] },
    { id: 'previous', from: 'previous', to: 'focus', relationType: 'predecessor', track: 'creation', label: '前代个体', sourceRefs: [] },
  ];
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'creation' }, context });
  assert.equal(parsed.nodes.length, 3); assert.equal(parsed.edges.length, 3);
  const creator = parsed.nodes.find(node => node.name === '工匠')!;
  assert.equal(creator.birth.year, 484);
  assert.equal(genealogyRelationText(parsed, creator), '创造者 · 主人');
  const layout = createGenealogyBoardLayout(parsed), lines = createGenealogyBoardConnectors(parsed, layout);
  assert.ok(layout.generationLabels.some(row => row.label === '源流 · 1层'));
  assert.equal(lines.length, 2); assert.equal(lines.find(line => line.edgeIds.length === 2)?.kind, 'source');
});

test('特殊源流：主人与同源个体横向关联，不画父母线', () => {
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'creation' };
  result.nodes[1].generation = 0;
  result.edges[0].relationType = 'owner'; result.edges[0].track = 'social';
  const layout = createGenealogyBoardLayout(result), lines = createGenealogyBoardConnectors(result, layout);
  assert.equal(lines.length, 1); assert.equal(lines[0].kind, 'social');
  assert.match(lines[0].path, / H/u); assert.doesNotMatch(lines[0].path, / V/u);
  assert.equal(genealogyDisplayDates(result.nodes[0]).label, '启动时间不详—运行中');
});

test('原界无纪年：中心与亲属保留相对文本，不被本界年龄锚覆盖', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult();
  const relative = { ...life('unknown', null, '穿越前约24年'), era: '' };
  result.nodes[0].identity = { lineageKind: 'cross-world-travel', body: { world: '原界', birth: relative }, arrival: life('known', 480, '复兴纪元480年') };
  result.nodes[1].name = '原界父亲'; result.nodes[1].birth = { ...relative, label: '穿越前约50年' }; result.nodes[1].death = life('unknown', null, '去向不详');
  result.nodes[1].sourceRefs = []; result.edges[0].sourceRefs = [];
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'cross-world-travel' }, context });
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.nodes[0].birth.label, '穿越前约24年'); assert.equal(parsed.nodes[0].birth.year, null);
  assert.equal(parsed.nodes[1].birth.label, '穿越前约50年'); assert.equal(parsed.nodes[1].birth.era, '');
});

test('夺舍两家族：分别计数，不混父母、不改中心、不修改存档', () => {
  const context = makeContext(); const result: GenealogyResult = makeResult();
  const originParent = structuredClone(result.nodes[1]);
  originParent.id = 'origin-father'; originParent.name = '原身份父亲'; originParent.sourceRefs = [];
  originParent.birth = { ...life('unknown', null, '原界早年'), era: '' }; originParent.death = life('unknown', null, '卒年不详');
  result.nodes.push(originParent);
  result.nodes[0].identity = { lineageKind: 'possession', body: { birth: result.nodes[0].birth },
    soul: { name: '原界旅人', birth: { ...life('unknown', null, '原界幼年'), era: '' }, death: { ...life('deceased', 2010, '公元2010年'), era: '公元' } },
    incarnation: life('known', 487, '复兴纪元487年') };
  result.edges[0].track = 'body';
  result.edges.push({ id: 'original-parent', from: originParent.id, to: 'focus', relationType: 'parent', track: 'soul', label: '原身份父亲', sourceRefs: [] });
  const scopedInput = { ...input, lineageKind: 'possession' as const, depth: { ...input.depth, maxPerGeneration: 1 } };
  result.depth = scopedInput.depth;
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: scopedInput, context });
  const before = JSON.stringify(parsed), body = genealogyFamilyView(parsed, 'body'), soul = genealogyFamilyView(parsed, 'soul');
  assert.equal(parsed.nodes.length, 3); assert.ok(hasOriginFamily(parsed));
  assert.deepEqual(body.nodes.map(node => node.name), [input.focusCharacter.name, '马克西姆三世']);
  assert.deepEqual(soul.nodes.map(node => node.name), [input.focusCharacter.name, '原身份父亲']);
  assert.equal(soul.nodes.find(node => node.isFocus)?.id, 'focus');
  assert.equal(genealogyDisplayDates(parsed.nodes[0], 'soul').label, '原界幼年—公元2010年');
  assert.equal(genealogyDisplayDates(parsed.nodes[0], 'body').label, '复兴纪元464年—在世');
  assert.equal(JSON.stringify(parsed), before);
});

test('身体死亡与原身份死亡不直接宣告当前人格终止', () => {
  const node: GenealogyResult['nodes'][number] = makeResult().nodes[0];
  node.death = life('deceased', 479, '复兴纪元479年');
  node.identity = { lineageKind: 'possession', body: { birth: node.birth, death: node.death },
    incarnation: life('known', 487, '复兴纪元487年') };
  assert.doesNotMatch(genealogyDisplayDates(node).label, /479/u);
  assert.match(genealogyDisplayDates(node).label, /状态不详/u);
  node.identity.identityEnd = life('deceased', 490, '复兴纪元490年');
  assert.match(genealogyDisplayDates(node).label, /490/u);
});

test('第二套家族没有可显示关系时不出空切换，旧v2无需迁移', () => {
  const old: GenealogyResult = makeResult();
  assert.ok(GenealogyResultSchema.safeParse(old).success);
  assert.equal(genealogyFamilyView(old, 'body'), old);
  old.nodes[0].identity = { lineageKind: 'possession', soul: { world: '原界' } };
  assert.equal(hasOriginFamily(old), false);
  assert.equal(genealogyFamilyView(old, 'soul'), old);
});

test('两套家族同一对人物也不能借肉身亲缘事实证明原身份亲缘', () => {
  const context = makeContext(), result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'possession' };
  result.edges[0].track = 'body';
  result.edges.push({ ...result.edges[0], id: 'soul-parent', track: 'soul', label: '原身份父亲' });
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input, context });
  assert.equal(parsed.edges.length, 2);
  const soul = parsed.edges.find(edge => edge.track === 'soul')!;
  assert.deepEqual(soul.sourceRefs, []);
  const units = genealogyBindingUnits(parsed, buildGenealogyEvidenceRoster(input, context));
  assert.deepEqual(units.find(unit => unit.unitId === soul.id)?.factIds, []);
  assert.ok(units.find(unit => unit.unitId === parsed.edges.find(edge => edge.track === 'body')?.id)?.factIds?.length);
});

test('同名纪年但明确不同世界的出生日期不相减', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'cross-world-travel', body: { world: '原界', birth: life('known', 480, '复兴纪元480年') } };
  result.nodes[1].name = '本界后裔'; result.nodes[1].generation = 1; result.nodes[1].birth = life('known', 481, '复兴纪元481年'); result.nodes[1].death = life('alive', null, '在世'); result.nodes[1].sourceRefs = [];
  result.nodes[1].identity = { lineageKind: 'native', body: { world: '本界' } };
  result.edges = [{ id: 'child', from: 'focus', to: 'father', relationType: 'parent', track: 'body', label: '子女', sourceRefs: [] }];
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input, context });
  assert.equal(parsed.nodes.find(node => node.name === '本界后裔')?.birth.year, 481);
});

test('可选原点和关系时期损坏只局部略去，不截断整图', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const result: GenealogyResult = makeResult();
  result.nodes[0].identity = { lineageKind: 'creation', body: { birth: { ...life('unknown', null, '不详'), year: 500 } }, activation: life('known', 485, '复兴纪元485年') };
  result.nodes[1].name = '匠人'; result.nodes[1].sourceRefs = [];
  result.edges[0].relationType = 'creator'; result.edges[0].track = 'creation'; result.edges[0].sourceRefs = [];
  result.edges[0].period = { from: life('known', 488, '复兴纪元488年'), to: life('deceased', 480, '复兴纪元480年') };
  const warnings: string[] = [];
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input, context, onWarning: warning => warnings.push(warning) });
  assert.equal(parsed.nodes.length, 2); assert.equal(parsed.nodes[0].identity?.activation?.year, 485);
  assert.equal(parsed.nodes[0].identity?.body?.birth, undefined); assert.equal(parsed.edges[0].period, undefined);
  assert.ok(warnings.some(warning => warning.startsWith('optional-identity-date-omitted')));
});

test('关系成立时期与原身份归属保留到参考文本', () => {
  const edge: GenealogyResult['edges'][number] = { ...makeResult().edges[0], relationType: 'spouse', track: 'body', label: '宿主旧配偶',
    period: { from: life('known', 478, '复兴纪元478年'), to: life('deceased', 486, '复兴纪元486年') } };
  assert.equal(genealogyEdgeDescription(edge), '宿主旧配偶 · 肉身家族 · 复兴纪元478年—复兴纪元486年');
});

test('专用规则与附加提示一致：特殊源流不逼父母、不强制本体纪年', () => {
  const generationContract = readFileSync(new URL('../rules/09_宗族谱系生成规则-API.txt', import.meta.url), 'utf8');
  const prompt = buildGenealogyApiPrompt({ requestId, directive: '整理源流', generationInput: input, context: makeContext(), rules: { generationContract } });
  assert.match(prompt, /默认整理原世界家族/u); assert.match(prompt, /默认追溯原世界/u);
  assert.match(prompt, /原身份家族另用 soul/u); assert.match(prompt, /抽象型号.*不伪造人物/u);
  assert.match(prompt, /记忆继承不等于身份连续/u); assert.match(prompt, /双魂共存不编一方消灭/u);
  assert.doesNotMatch(prompt, /era` 只允许|分类只用于推理，不新增Schema字段|只有玩家明确要求追溯原世界/u);
});

test('默认自动识别消费MVU、上下文和世界书，不要求手动类型或额外调用', () => {
  const context = makeContext(); context.evidenceBundle.personCanonViews = [];
  const additions: ContextSource[] = [
    { ...context.characterContext[0], content: '{"介绍":"人工铸造的档案管理机仆，主人不是生父"}' },
    { sourceId: 'worldbook:core:identity', sourceType: 'worldbook', title: input.focusCharacter.name, authority: 100, content: '前代型号只是设计来源，并非血缘。' },
    { sourceId: 'chat:7', sourceType: 'chat', title: '近期正文', authority: 80, content: '她确认保留独立人格，并未继承前代的意识。' },
  ];
  context.sourceIndex = additions;
  const prompt = buildGenealogyApiPrompt({ requestId, directive: '构建谱系', generationInput: { ...input, lineageKind: 'auto' }, context, rules: { generationContract: '宗族规则' } });
  assert.match(prompt, /自动辨明中心人物身份/u); assert.match(prompt, /不额外请求分类API/u);
  for (const source of additions) assert.ok(prompt.includes(source.content.replaceAll('"', '\\"')) || prompt.includes(source.content));
  const result: GenealogyResult = makeResult(); result.nodes = [result.nodes[0]]; result.edges = [];
  result.nodes[0].identity = { lineageKind: 'creation', activation: life('known', 485, '复兴纪元485年') };
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: { ...input, lineageKind: 'auto' }, context });
  assert.equal(parsed.nodes[0].identity?.lineageKind, 'creation');
  assert.equal(parsed.nodes[0].birth.status, 'unknown');
});

test('玩家详情保持简约，家族切换有键盘与移动热区，不输出技术身份轨', () => {
  const source = readFileSync(new URL('../src/ui/genealogyWorkbench.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/genealogyWorkbench.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /身份时间轨|genealogyIdentityLines\(node\)|本次原创/u);
  assert.match(source, /肉身家族/u); assert.match(source, /原身份家族/u);
  assert.match(source, /escapeHtml\(node.identity.soul.name\)/u);
  assert.match(css, /\.family-switch button\s*\{\s*min-height: 44px/u);
  assert.match(css, /family-switch button:focus-visible/u);
});

test('正式组件预览的特殊谱系夹具沿用当前设置与外观契约', async () => {
  const page = readFileSync(new URL('../prototype/workbench-runtime.html', import.meta.url), 'utf8');
  const script = page.match(/<script>\s*([\s\S]+?)<\/script>/u)?.[1];
  assert.ok(script);
  for (const lineage of ['creation', 'possession', 'cross-world-travel']) {
    const globals: Record<string, unknown> = {};
    runInNewContext(script, {
      window: globals, URLSearchParams, structuredClone,
      location: { search: `?view=genealogy&lineage=${lineage}&mode=dark` },
      document: { querySelector: () => ({ dataset: {}, addEventListener() {} }) },
    });
    const client = new WorkbenchUiClient(globals, new EventTarget());
    assert.equal(client.isReady(), true);
    const snapshot = await client.readSnapshot();
    assert.equal(WorkbenchSettingsSchema.parse(snapshot.settings).appearance.mode, 'dark');
    assert.equal(snapshot.settings.retries.genealogy, 2);
    assert.equal(typeof snapshot.settings.generation.genealogy.apiurl, 'string');
    assert.equal(GenealogyResultSchema.parse(snapshot.genealogies[0].result).nodes[0].identity?.lineageKind, lineage);
  }
});

class GenealogyRuntime implements TavernRuntime {
  chatId = namespace.chatId;
  lastMessageId = 8;
  messages = new Map<number, RuntimeChatMessage>([[
    8,
    {
      message_id: 8,
      role: 'user',
      message: '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系',
      swipe_id: 0,
    },
  ]]);

  getCurrentCharacterName() { return namespace.characterKey; }
  getCurrentChatId() { return this.chatId; }
  getLastMessageId() { return this.lastMessageId; }
  getMessageSwipeId(id: number) { return this.messages.get(id)?.swipe_id ?? null; }
  getChatMessages(range: number | string) {
    if (typeof range === 'number') {
      const message = this.messages.get(range);
      return message ? [structuredClone(message)] : [];
    }
    return [...this.messages.values()].map(message => structuredClone(message));
  }
  async setChatMessages() {}
  setExtensionPrompt() {}
  async generate() { return ''; }
  async generateRaw() { return ''; }
}

test('宗族结果严格锁定MVU中心、代数、来源与连通关系', () => {
  const expected = makeResult();
  expected.nodes[1].canInjectToRuin = true;
  expected.nodes[1].provenance = 'explicit';
  assert.deepEqual(
    parseAndValidateGenealogy(JSON.stringify(makeResult()), {
      requestId,
      input,
      context: makeContext(),
    }),
    expected,
  );

  const invalid = structuredClone(makeResult());
  invalid.focusCharacterId = 'wrong-focus';
  assert.throws(
    () => parseAndValidateGenealogy(JSON.stringify(invalid), {
      requestId,
      input,
      context: makeContext(),
    }),
    /focus differs/u,
  );
});

test('谱系证据名册锁定已知事实，同时保留低权原创亲属', () => {
  const invented = structuredClone(makeResult());
  invented.nodes[1].name = '不存在的皇子';
  (invented.nodes[1] as unknown as { provenance: 'generated' }).provenance = 'generated';
  invented.nodes[1].sourceRefs = ['worldbook:核心:1'];
  invented.edges[0].sourceRefs = ['worldbook:核心:1'];
  const withGenerated = parseAndValidateGenealogy(JSON.stringify(invented), {
      requestId,
      input,
      context: makeContext(),
    });
  assert.equal(withGenerated.nodes.length, 2);
  assert.match(withGenerated.nodes[1].id, /^generated-node:/u);
  assert.equal(withGenerated.nodes[1].provenance, 'generated');
  assert.deepEqual(withGenerated.nodes[1].sourceRefs, []);
  assert.deepEqual(withGenerated.edges[0].sourceRefs, []);
  assert.match(withGenerated.edges[0].id, /^generated-edge:/u);
  const generatedBindings = genealogyBindingUnits(
    withGenerated,
    buildGenealogyEvidenceRoster(input, makeContext()),
  );
  assert.deepEqual(
    generatedBindings.find(unit => unit.unitId === withGenerated.nodes[1].id)?.factIds,
    [],
  );
  assert.deepEqual(
    generatedBindings.find(unit => unit.unitId === withGenerated.edges[0].id)?.factIds,
    [],
  );

  const unsupportedChild = structuredClone(makeResult());
  unsupportedChild.edges[0] = {
    ...unsupportedChild.edges[0],
    from: 'focus',
    to: 'father',
    relationType: 'parent',
  };
  const withoutUnsupported = parseAndValidateGenealogy(JSON.stringify(unsupportedChild), {
      requestId,
      input,
      context: makeContext(),
    });
  assert.deepEqual(withoutUnsupported.nodes.map(node => node.id), ['focus']);
  assert.deepEqual(withoutUnsupported.edges, []);
});

test('原创亲属的坏出生年只局部降级，不让整棵谱系失败', () => {
  const generated = structuredClone(makeResult());
  generated.nodes[1].name = '原创父亲';
  generated.nodes[1].birth = life('known', 480, '复兴纪元480年');
  generated.nodes[1].sourceRefs = [];
  generated.edges[0].sourceRefs = [];
  const parsed = parseAndValidateGenealogy(JSON.stringify(generated), {
    requestId,
    input,
    context: makeContext(),
  });
  assert.equal(parsed.nodes.length, 2);
  assert.equal(parsed.edges.length, 1);
  assert.equal(parsed.nodes[1].provenance, 'generated');
  assert.equal(parsed.nodes[1].birth.status, 'unknown');
  assert.equal(parsed.nodes[1].birth.year, null);
});

test('谱系证据名册把编码 logicalId 映射为本次可引用 sourceId', () => {
  const context = makeContext();
  const encodedLogicalId = 'worldbook:%E6%A0%B8%E5%BF%83:1';
  context.evidenceBundle.sourceSnapshots[0].logicalId = encodedLogicalId;
  context.evidenceBundle.personCanonViews![0].facts[0].sourceRefs = [encodedLogicalId];
  const parsed = parseAndValidateGenealogy(JSON.stringify(makeResult()), {
    requestId,
    input,
    context,
  });
  assert.equal(parsed.nodes[1].name, '马克西姆三世');
});

test('宗族结果要求人物短传；错误生卒由权威资料校准，不为模型算错中断整图', () => {
  const missingProfile = structuredClone(makeResult()) as unknown as {
    nodes: Array<Record<string, unknown>>;
  };
  delete missingProfile.nodes[1].profile;
  assert.throws(
    () => parseAndValidateGenealogy(JSON.stringify(missingProfile), {
      requestId,
      input,
      context: makeContext(),
    }),
    /性格侧写和经历短传/u,
  );

  const invalidAge = structuredClone(makeResult());
  invalidAge.nodes[1].birth = life('known', 460, '约复兴纪元460年');
  const corrected = parseAndValidateGenealogy(JSON.stringify(invalidAge), {
      requestId,
      input,
      context: makeContext(),
    });
  assert.equal(corrected.nodes[1].birth.year, 430);
});

test('宗族结果对单代超限做局部裁剪而非让整棵谱系报错', () => {
  const context = makeContext();
  const mother = structuredClone(context.evidenceBundle.personCanonViews![0].facts[0]);
  mother.factId = 'fact:mother'; mother.predicate = 'mother'; mother.object = '第二位父辈';
  context.evidenceBundle.personCanonViews![0].facts.push(mother);
  const limitedInput = structuredClone(input);
  limitedInput.depth.maxPerGeneration = 1;
  const result = structuredClone(makeResult()) as GenealogyResult;
  result.depth.maxPerGeneration = 1;
  const secondParent = structuredClone(result.nodes[1]);
  secondParent.id = 'mother';
  secondParent.name = '第二位父辈';
  secondParent.relationToFocus = '母亲';
  result.nodes.push(secondParent);
  result.edges.push({
    id: 'edge-mother-focus',
    from: 'mother',
    to: 'focus',
    relationType: 'parent',
    label: '母女',
    sourceRefs: [],
  });

  const parsed = parseAndValidateGenealogy(JSON.stringify(result), {
      requestId,
      input: limitedInput,
      context,
    });
  assert.equal(parsed.nodes.filter(node => node.generation === -1).length, 1);
  assert.equal(parsed.nodes.some(node => node.isFocus), true);
});

test('家庭展开合同在初次与纠正生成中保留人数目标，并隔离特殊源流例外', () => {
  const generationContract = readFileSync(new URL('../rules/09_宗族谱系生成规则-API.txt', import.meta.url), 'utf8');
  for (const lineageKind of ['auto', 'native', 'adoption', 'same-world-travel', 'cross-world-travel', 'possession', 'reincarnation', 'creation'] as const) {
    const params = { requestId, directive: '宗族谱系', context: makeContext(), rules: { generationContract },
      generationInput: { ...input, lineageKind, depth: { ...input.depth, maxPerGeneration: 7 } } };
    for (const prompt of [buildGenealogyApiPrompt(params), buildGenealogyRepairPrompt({ ...params, validationError: '夹具校验错误' })]) {
      assert.match(prompt, /普通生物及原界生物：每代尽量接近人数目标/u);
      assert.match(prompt, /先连接父母两侧的祖辈/u);
      assert.match(prompt, /不得只生成一条直线/u);
      assert.match(prompt, /资料未记载不等于关系不存在/u);
      assert.match(prompt, /构装体按有意义的源流展开/u);
      assert.match(prompt, /创造者与具体前代分线/u);
      assert.match(prompt, /人数不足不新增错误输出/u);
      assert.match(prompt, /两套家族分别计数/u);
      assert.match(prompt, /不编新纪元/u);
    }
  }
});

test('七人预算保留父母两侧家庭及旁系；不足目标不拒绝整图', () => {
  const context = makeContext(), result: GenealogyResult = makeResult();
  const scopedInput = { ...input, lineageKind: 'native' as const, depth: { ancestors: 4, descendants: 0, maxPerGeneration: 7 } };
  result.depth = scopedInput.depth;
  result.nodes[0].identity = { lineageKind: 'native' };
  const relatives = [
    ['mother', '母亲', -1], ['paternal-grandfather', '祖父', -2], ['paternal-grandmother', '祖母', -2],
    ['maternal-grandfather', '外祖父', -2], ['maternal-grandmother', '外祖母', -2], ['aunt', '姑母', -1],
    ['uncle', '舅父', -1], ['sister', '妹妹', 0], ['cousin', '表妹', 0],
  ] as const;
  for (const [id, relationToFocus, generation] of relatives) {
    result.nodes.push({ ...structuredClone(result.nodes[1]), id, name: `测试${relationToFocus}`, generation, relationToFocus,
      provenance: 'generated', sourceRefs: [], birth: life('unknown', null, '生年不详'), death: life('unknown', null, '卒年不详') });
  }
  for (const [from, to] of [
    ['mother', 'focus'], ['father', 'sister'], ['mother', 'sister'],
    ['paternal-grandfather', 'father'], ['paternal-grandmother', 'father'],
    ['paternal-grandfather', 'aunt'], ['paternal-grandmother', 'aunt'],
    ['maternal-grandfather', 'mother'], ['maternal-grandmother', 'mother'],
    ['maternal-grandfather', 'uncle'], ['maternal-grandmother', 'uncle'], ['uncle', 'cousin'],
  ]) result.edges.push({ id: `${from}-${to}`, from, to, relationType: 'parent', label: '亲子', sourceRefs: [] });
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), { requestId, input: scopedInput, context });
  assert.equal(parsed.nodes.length, 11);
  assert.equal(parsed.nodes.filter(node => node.generation === -2).length, 4);
  assert.equal(parsed.nodes.filter(node => node.generation === -1).length, 4);
  const lines = createGenealogyBoardConnectors(parsed, createGenealogyBoardLayout(parsed));
  const idFor = (name: string) => parsed.nodes.find(node => node.name === name)!.id;
  assert.ok(lines.some(line => line.parentIds.includes(idFor('测试祖父')) && line.childIds.includes(idFor('马克西姆三世'))));
  assert.ok(lines.some(line => line.parentIds.includes(idFor('测试外祖父')) && line.childIds.includes(idFor('测试母亲'))));
  const sparse = makeResult(); sparse.depth = scopedInput.depth;
  assert.equal(parseAndValidateGenealogy(JSON.stringify(sparse), { requestId, input: scopedInput, context }).nodes.length, 2);
});

test('没有亲缘资料时允许补足父系与母系人物，且不伪造来源或MVU身份', () => {
  const context = makeContext();
  const focusView = context.evidenceBundle.personCanonViews![0];
  focusView.facts = focusView.facts.filter(fact => fact.predicate !== 'father');
  context.evidenceBundle.personCanonViews = [focusView];
  const result = structuredClone(makeResult()) as GenealogyResult;
  result.nodes = [result.nodes[0]];
  result.edges = [];
  const additions = [
    ['father-model-id', '奥古斯塔父亲', '父亲', 'parent'],
    ['mother-model-id', '奥古斯塔母亲', '母亲', 'parent'],
    ['paternal-aunt-model-id', '父系姑母', '父系姑母', 'uncleAunt'],
    ['maternal-uncle-model-id', '母系舅父', '母系舅父', 'uncleAunt'],
  ] as const;
  for (const [id, name, relationToFocus, relationType] of additions) {
    const node = structuredClone(makeResult().nodes[1]);
    Object.assign(node, {
      id,
      name,
      aliases: [],
      generation: -1,
      relationToFocus,
      provenance: 'explicit',
      isMvuCharacter: true,
      mvuId: `fake:${name}`,
      sourceRefs: ['worldbook:核心:1'],
      birth: life('unknown', null, '生年不详'),
      death: life('unknown', null, '卒年不详'),
    });
    result.nodes.push(node);
    result.edges.push({
      id: `edge:${id}`,
      from: id,
      to: 'focus',
      relationType,
      label: relationToFocus,
      sourceRefs: ['worldbook:核心:1'],
    });
  }
  const parsed = parseAndValidateGenealogy(JSON.stringify(result), {
    requestId,
    input,
    context,
  });
  const generated = parsed.nodes.filter(node => !node.isFocus);
  assert.equal(generated.length, 4);
  assert.equal(generated.some(node => node.relationToFocus.includes('父系')), true);
  assert.equal(generated.some(node => node.relationToFocus.includes('母系')), true);
  assert.ok(generated.every(node => node.provenance === 'generated'));
  assert.ok(generated.every(node => !node.isMvuCharacter && node.mvuId === ''));
  assert.ok(generated.every(node => node.sourceRefs.length === 0));
  assert.ok(parsed.edges.every(edge => edge.sourceRefs.length === 0));
});

test('宗族结果将模型的未知日期零值和空职业规范为合法占位值', () => {
  const result = structuredClone(makeResult());
  (result.nodes[1].birth as { month: number | null }).month = 0;
  (result.nodes[1].birth as { day: number | null }).day = 0;
  (result.nodes[1].death as { month: number | null }).month = 0;
  (result.nodes[1].death as { day: number | null }).day = 0;
  result.nodes[1].professions = [];

  const parsed = parseAndValidateGenealogy(JSON.stringify(result), {
    requestId,
    input,
    context: makeContext(),
  });
  assert.equal(parsed.nodes[1].birth.month, null);
  assert.equal(parsed.nodes[1].birth.day, null);
  assert.equal(parsed.nodes[1].death.month, null);
  assert.equal(parsed.nodes[1].death.day, null);
  assert.deepEqual(parsed.nodes[1].professions, ['职业不详']);
});

test('宗族结果将 living 或在世死亡状态统一为无死亡日期的 alive', () => {
  for (const status of ['living', '在世']) {
    const result = structuredClone(makeResult()) as unknown as {
      nodes: Array<Record<string, unknown>>;
    };
    result.nodes[0].death = {
      status,
      era: '复兴纪元',
      year: 488,
      month: 8,
      day: 11,
      precision: 'exact',
      label: '仍然在世',
    };
    const parsed = parseAndValidateGenealogy(JSON.stringify(result), {
      requestId,
      input,
      context: makeContext(),
    });
    assert.deepEqual(parsed.nodes[0].death, {
      status: 'alive',
      era: '',
      year: null,
      month: null,
      day: null,
      precision: 'unknown',
      label: '仍然在世',
    });
  }
});

test('宗族生成只落当前聊天仓库，不写MVU、正文或墟境状态', async () => {
  const repository = new MemoryGenealogyRepository();
  const command = createButtonCommand('genealogy.generate', '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'genealogy');
        assert.match(prompt, /REFERENCE_DATA_READ_ONLY/u);
        return JSON.stringify(makeResult());
      },
    },
    repository,
    rules: {
      generationContract: '宗族契约',
    },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const record = await workflow.generate(command, input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.equal(
    (await repository.get(genealogyRecordKey(namespace, requestId)))?.requestId,
    requestId,
  );
  assert.equal(record.result.nodes.length, 2);
  assert.equal((await repository.list({ ...namespace, chatId: '另一存档' })).length, 0);
});

test('检索未选中MVU摘录时仍按当前MVU名册允许重复生成，旧档案不能授予准入', async () => {
  const context = makeContext();
  const currentMvuCharacters = context.characterContext.map(({ sourceId, title }) => ({ sourceId, title }));
  const selected = context.sourceIndex.filter(source => source.sourceType !== 'mvu');
  context.characterContext = [];
  context.sourceIndex = selected;
  context.evidenceBundle = makeEvidenceBundle(selected);
  const repository = new MemoryGenealogyRepository();
  let calls = 0;
  let roster = currentMvuCharacters;
  let currentRequestId = requestId;
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble({ requestId: id }) { return { ...context, requestId: id, currentMvuCharacters: roster }; } },
    generator: {
      async generate(_task, prompt) {
        calls++;
        assert.doesNotMatch(prompt, /"currentMvuCharacters"/u, '准入名册不加入模型资料包');
        return JSON.stringify({ ...makeResult(), requestId: currentRequestId });
      },
    },
    repository, rules: { generationContract: '测试合同' },
    createRequestId: () => (currentRequestId = `${requestId}-${calls + 1}`), now: () => calls, async assertCurrent() {},
  });
  const command = createButtonCommand('genealogy.generate', `宗族谱系 ${input.focusCharacter.name}`);
  const identity = { namespace, triggerMessageId: 8, triggerTextHash: 'hash', triggerSwipeId: 0, lifecycleEpoch: 0 };
  await workflow.generate(command, input, identity);
  await workflow.generate(command, input, identity);
  assert.equal(calls, 2, '已有族谱不影响仍在MVU中的中心人物再次生成');
  assert.equal((await repository.list(namespace)).length, 2);
  roster = [];
  context.characterContext = makeContext().characterContext;
  await assert.rejects(workflow.generate(command, input, identity), /只有当前聊天MVU关系列表/u);
  assert.equal(calls, 2, '当前完整名册为空时不回退到旧摘录或旧档案');
});

test('GB-07 坏引用局部降级，精确名册恢复真实来源，不额外调用模型', async () => {
  const raw = makeResult();
  raw.nodes.forEach(node => { node.sourceRefs = ['S9999', 'worldbook:%E6%A0%B8%E5%BF%83:<none>']; });
  raw.edges[0].sourceRefs = ['unknown-source'];
  let calls = 0;
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: { async generate() { calls++; return JSON.stringify(raw); } },
    repository: new MemoryGenealogyRepository(), rules: { generationContract: '测试合同' },
    createRequestId: () => requestId, now: () => 1, async assertCurrent() {},
  });
  const record = await workflow.generate(createButtonCommand('genealogy.generate', '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系'), input,
    { namespace, triggerMessageId: 8, triggerTextHash: 'hash', triggerSwipeId: 0, lifecycleEpoch: 0 });
  assert.equal(calls, 1);
  assert.equal(record.result.nodes.length, 2);
  assert.equal(record.result.edges.length, 1);
  assert.ok(record.validationWarnings?.length);
  assert.ok(record.result.edges[0].sourceRefs.includes('worldbook:核心:1'));
});

test('GB-08 权威时间覆盖错误生卒；世界书年龄反推中心生年；无条目时保留谱系约年', () => {
  const context = makeContext();
  const raw = makeResult(); raw.nodes[0].birth = life('known', 469, '复兴纪元469年');
  raw.nodes[0].profile.lifeExperience = '从军旅成长为帝国统治者，长期承担边境与内政压力。';
  raw.nodes[1].death = life('deceased', 488, '复兴纪元488年');
  const corrected = parseAndValidateGenealogy(JSON.stringify(raw), { requestId, input, context });
  assert.equal(corrected.nodes[0].birth.year, 464);
  assert.equal(corrected.nodes[0].profile.lifeExperience, raw.nodes[0].profile.lifeExperience);
  assert.equal(corrected.nodes[1].death.year, 479);
  const worldbookAge = makeContext();
  worldbookAge.evidenceBundle.personCanonViews![0].facts = worldbookAge.evidenceBundle.personCanonViews![0].facts
    .filter(fact => fact.predicate !== 'birth_time');
  worldbookAge.evidenceBundle.taskAnchorAttachments = [{
    schema: 'eyon.retrieval.task-anchor-attachment.v1',
    attachmentId: 'attachment:focus-worldbook',
    entityId: 'entity:维奥莱塔·马克西姆·奥古斯塔',
    canonicalName: input.focusCharacter.name,
    sourceId: 'worldbook:核心:1',
    snapshotId: worldbookAge.evidenceBundle.sourceSnapshots[0].snapshotId,
    sourceType: 'worldbook',
    title: input.focusCharacter.name,
    content: '姓名：维奥莱塔·马克西姆·奥古斯塔\n实际年龄：24岁\n外貌年龄：19岁',
    contentHash: 'focus-worldbook-age',
    charCount: 42,
    purpose: 'direct-character-entry',
  }];
  const ageDerived = parseAndValidateGenealogy(JSON.stringify(raw), {
    requestId,
    input,
    context: worldbookAge,
  });
  assert.equal(ageDerived.nodes[0].birth.year, 464);
  assert.equal(ageDerived.nodes[0].birth.precision, 'approximate');
  assert.match(ageDerived.nodes[0].birth.label, /按世界书年龄推算/u);
  assert.equal(ageDerived.nodes[0].profile.lifeExperience, raw.nodes[0].profile.lifeExperience);

  const worldbookExplicit = structuredClone(worldbookAge);
  worldbookExplicit.evidenceBundle.taskAnchorAttachments![0].content = '出生年份：复兴纪元461年\n实际年龄：27岁';
  const explicitDerived = parseAndValidateGenealogy(JSON.stringify(raw), {
    requestId,
    input,
    context: worldbookExplicit,
  });
  assert.equal(explicitDerived.nodes[0].birth.year, 461);
  assert.equal(explicitDerived.nodes[0].birth.precision, 'exact');

  const mvuAge = makeContext();
  mvuAge.evidenceBundle.personCanonViews![0].facts = mvuAge.evidenceBundle.personCanonViews![0].facts
    .filter(fact => fact.predicate !== 'birth_time');
  mvuAge.evidenceBundle.taskAnchorAttachments = [{
    ...worldbookAge.evidenceBundle.taskAnchorAttachments[0],
    attachmentId: 'attachment:focus-mvu',
    sourceId: 'mvu-character:维奥莱塔·马克西姆·奥古斯塔',
    snapshotId: mvuAge.evidenceBundle.sourceSnapshots[1].snapshotId,
    sourceType: 'mvu',
    content: '年龄：24岁\n外貌年龄：19岁',
    purpose: 'direct-character-entry',
  }];
  const mvuDerived = parseAndValidateGenealogy(JSON.stringify(raw), {
    requestId,
    input,
    context: mvuAge,
  });
  assert.equal(mvuDerived.nodes[0].birth.year, 464);
  assert.match(mvuDerived.nodes[0].birth.label, /按MVU年龄推算/u);

  const appearanceOnly = structuredClone(worldbookAge);
  appearanceOnly.evidenceBundle.taskAnchorAttachments![0].content = '外貌年龄：24岁\n心理年龄：30岁';
  const appearanceIgnored = parseAndValidateGenealogy(JSON.stringify(raw), {
    requestId,
    input,
    context: appearanceOnly,
  });
  assert.equal(appearanceIgnored.nodes[0].birth.year, 469);
  assert.match(appearanceIgnored.nodes[0].birth.label, /谱系推断/u);

  const inferred = makeContext();
  inferred.evidenceBundle.personCanonViews![0].facts = inferred.evidenceBundle.personCanonViews![0].facts
    .filter(fact => fact.predicate !== 'birth_time');
  const inferredResult = parseAndValidateGenealogy(JSON.stringify(raw), {
    requestId,
    input,
    context: inferred,
  });
  assert.equal(inferredResult.nodes[0].birth.year, 469);
  assert.equal(inferredResult.nodes[0].birth.precision, 'approximate');
  assert.match(inferredResult.nodes[0].birth.label, /谱系推断/u);
  assert.equal(inferredResult.nodes[0].profile.lifeExperience, raw.nodes[0].profile.lifeExperience);
});

test('GB-10 historyRefs 从已校验候选建立，模型漏写/乱写不触发结构失败', () => {
  for (const value of [undefined, '错误格式', [{ biographyId: 'fake', stageId: 'fake' }]]) {
    const context = makeContext();
    context.historyReferenceCandidates = [{ biographyId: 'real', stageId: 'gift', participants: [{ entityId: context.evidenceBundle.personCanonViews![0].entityId, name: input.focusCharacter.name }], claim: '唯一一次赠书' }];
    const raw = makeResult() as unknown as { nodes: Array<Record<string, unknown>> };
    raw.nodes[0].historyRefs = value;
    const result = parseAndValidateGenealogy(JSON.stringify(raw), { requestId, input, context });
    assert.deepEqual(result.nodes[0].historyRefs, [{ biographyId: 'real', stageId: 'gift' }]);
    assert.deepEqual(result.nodes[1].historyRefs, []);
  }
});

test('宗族旧式返回会触发一次严格 v2 纠正生成', async () => {
  const repository = new MemoryGenealogyRepository();
  const command = createButtonCommand('genealogy.generate', '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  const prompts: string[] = [];
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'genealogy');
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            target: input.focusCharacter.name,
            clan: '奥古斯塔皇室',
            origins: [],
            members: [],
            relationships: [],
            record_conflicts: [],
          });
        }
        return JSON.stringify(makeResult());
      },
    },
    repository,
    rules: {
      generationContract: '宗族契约',
    },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const record = await workflow.generate(command, input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /MANDATORY_FINAL_OUTPUT_CONTRACT/u);
  assert.match(prompts[1], /GENEALOGY_REPAIR_TASK/u);
  assert.match(prompts[1], /<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>/u);
  assert.match(prompts[1], /target、clan/u);
  assert.equal(record.result.schema, 'eyon.genealogy.v2');
});

test('宗族提示词只发送专用契约与限额只读资料，不携带通用上下文格式', () => {
  const context = makeContext();
  context.sourceIndex.push(...Array.from({ length: 40 }, (_, index) => ({
    sourceId: `worldbook:bulk:${index}`,
    sourceType: 'worldbook' as const,
    title: `无关条目${index}`,
    content: '无关资料'.repeat(4_000),
    authority: 100,
  })));
  const prompt = buildGenealogyApiPrompt({
    requestId,
    directive: `宗族谱系 ${input.focusCharacter.name}`,
    generationInput: input,
    context,
    rules: { generationContract: '宗族专用契约' },
  });

  assert.match(prompt, /<REFERENCE_DATA_READ_ONLY>/u);
  assert.match(prompt, /<MANDATORY_FINAL_OUTPUT_CONTRACT>/u);
  assert.match(prompt, /宗族专用契约/u);
  assert.match(prompt, new RegExp(input.focusCharacter.mvuId, 'u'));
  assert.match(prompt, /原肉身穿越者默认追溯原世界/u);
  assert.match(prompt, /每套家族每层的硬上限/u);
  assert.match(prompt, /authoritative-kinship-locks-with-generated-fill/u);
  assert.match(prompt, /事实锁.*不是人物准入白名单/u);
  assert.match(prompt, /普通生物\/原界生物兼顾父系母系/u);
  assert.match(prompt, /generated 人物与原创关系必须使用空 sourceRefs/u);
  assert.doesNotMatch(prompt, /"taskType":"genealogy"/u);
  assert.doesNotMatch(prompt, /"scope":/u);
  assert.ok(prompt.length < 75_000);
});

test('宗族资料包回显会触发一次干净纠正，纠正请求不复述错误回答', async () => {
  const repository = new MemoryGenealogyRepository();
  const command = createButtonCommand('genealogy.generate', '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  const prompts: string[] = [];
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(_taskType, prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) {
          return JSON.stringify({
            ...makeContext(),
            uniqueEchoMarker: 'DO_NOT_REPEAT_THIS_CONTEXT_ECHO',
          });
        }
        return JSON.stringify(makeResult());
      },
    },
    repository,
    rules: { generationContract: '宗族专用契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });

  const record = await workflow.generate(command, input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });

  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /<GENEALOGY_REPAIR_TASK>/u);
  assert.match(prompts[1], /回显了只读资料包/u);
  assert.doesNotMatch(prompts[1], /DO_NOT_REPEAT_THIS_CONTEXT_ECHO/u);
  assert.equal(record.result.schema, 'eyon.genealogy.v2');
});

test('文本入口必须给出当前MVU人物，不能靠模糊关系词猜中心', async () => {
  assert.equal(
    extractGenealogyFocusName('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系'),
    '维奥莱塔·马克西姆·奥古斯塔',
  );
  const sources: RuntimeContextSourceProvider = {
    async getCurrentWorld() { return { time: '', location: '' }; },
    async getWorldbookSources() { return []; },
    async getCharacterSources() {
      return [{
        sourceId: `mvu-character:${input.focusCharacter.mvuId}`,
        title: input.focusCharacter.name,
        content: '{}',
      }];
    },
    async getGenealogySources() { return []; },
    async getBiographySources() { return []; },
    async getButterflySources() { return []; },
  };
  const provider = new TavernGenealogyInputProvider(
    sources,
    { getGenealogyDepth: () => input.depth },
  );
  const command = createButtonCommand('genealogy.generate', '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  assert.deepEqual(await provider.getInput(command), {
    ...input,
    focusCharacter: { ...input.focusCharacter, aliases: [] },
  });
  const missing = createButtonCommand('genealogy.generate', '对不存在的人生成宗族谱系');
  assert.ok(missing);
  await assert.rejects(() => provider.getInput(missing), /没有找到人物/u);
});

test('聊天、楼层、swipe或生命周期变化后宗族事务拒绝提交', async () => {
  const mutations: Array<(
    runtime: GenealogyRuntime,
    guard: GenealogyTransactionGuard,
  ) => void> = [
    runtime => { runtime.chatId = '另一存档'; },
    runtime => { runtime.messages.get(8)!.message = '编辑后的命令'; },
    runtime => { runtime.messages.get(8)!.swipe_id = 1; },
    (_runtime, guard) => { guard.cancelAll(); },
  ];
  for (const mutate of mutations) {
    const runtime = new GenealogyRuntime();
    const guard = new GenealogyTransactionGuard();
    const identity = {
      namespace,
      triggerMessageId: 8,
      triggerTextHash: fingerprintText(runtime.messages.get(8)!.message),
      triggerSwipeId: 0,
      lifecycleEpoch: guard.currentEpoch(),
    };
    mutate(runtime, guard);
    await assert.rejects(
      () => createGenealogyIdentityAssertion(runtime, guard)(identity),
    );
  }
});

test('宗族生成期间允许聊天自然推进，但原始锚点必须保持不变', async () => {
  const runtime = new GenealogyRuntime();
  const guard = new GenealogyTransactionGuard();
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: fingerprintText(runtime.messages.get(8)!.message),
    triggerSwipeId: 0,
    lifecycleEpoch: guard.currentEpoch(),
  };

  runtime.lastMessageId = 9;
  await assert.doesNotReject(
    () => createGenealogyIdentityAssertion(runtime, guard)(identity),
  );
});

test('宗族谱系不再有文本入口，聊天提及不路由任何工作流（β1.1）', async () => {
  const runtime = new GenealogyRuntime();
  const calls: string[] = [];
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText() {
        calls.push('biography');
        return {};
      },
      async commitRendered() { return null; },
      async cancelPending() {},
    },
    ruin: {
      async generateFromText() {
        calls.push('ruin');
        return {};
      },
      cancelPending() {},
    },
    ruinInputProvider: {
      async getInput() {
        throw new Error('ruin input should not be requested');
      },
    },
    genealogy: {
      async generateFromText(text, receivedInput) {
        calls.push(`genealogy:${text}`);
        assert.deepEqual(receivedInput, input);
        return {};
      },
      cancelPending() {},
    },
    genealogyInputProvider: {
      async getInput(command) {
        calls.push(`input:${command.type}`);
        return input;
      },
    },
  });
  // β1.1：宗族谱系不再有文本入口——聊天里提到它不会请求输入、不会路由任何工作流，
  // 只由角色卡把玩家引导到工作台的宗族谱系面板。
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.deepEqual(calls, []);
});

test('R-01：同一「神明纪元 + 后世帝国」夹具下，谱系 prompt 含活跃时间规则且 validator 能本地检出违规', () => {
  const context = makeContext();
  const snapshot = context.evidenceBundle.sourceSnapshots[0];
  context.evidenceBundle = {
    ...context.evidenceBundle,
    temporalEligibility: {
      schema: 'eyon.retrieval.temporal-eligibility.v1',
      eraOrder: ['神明纪元', '混乱纪元', '复兴纪元'],
      rules: [{
        ruleId: 'temporal:fixture:0:奥古斯提姆帝国',
        subject: '奥古斯提姆帝国',
        scope: 'entity',
        availableFromEra: '混乱纪元',
        affectedEntityIds: ['entity:奥古斯提姆帝国'],
        affectedEntityNames: ['奥古斯提姆帝国'],
        sourceSnapshotId: snapshot.snapshotId,
        evidence: '混乱纪元：建立奥古斯提姆帝国',
        span: { snapshotId: snapshot.snapshotId, startOffset: 0, endOffset: 1 },
      }],
    },
  };
  const prompt = buildGenealogyApiPrompt({
    requestId,
    directive: '神明纪元 维奥莱塔宗族谱系',
    generationInput: input,
    context,
    rules: { generationContract: '生成契约' },
  });
  assert.match(prompt, /<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>/u);
  assert.match(prompt, /奥古斯提姆帝国/u);
  assert.match(prompt, /<ERA_PROFILE>/u);

  // 时代错位不再致命：结果在神明纪元引入后世帝国 → 通过（模型按错位契约处理）。
  const result = makeResult();
  result.nodes[0] = {
    ...result.nodes[0],
    summary: '奥古斯提姆帝国的女皇，在神明纪元执掌宫廷。',
    identities: ['奥古斯提姆帝国女皇'],
  };
  const validatedResult = parseAndValidateGenealogy(JSON.stringify(result), {
    requestId,
    input,
    context,
    directive: '神明纪元 维奥莱塔宗族谱系',
  });
  assert.equal(validatedResult.nodes.length, result.nodes.length);

  // 同账本下不引用后世实体同样通过：改写默认 fixture 中的违规词。
  const clean = makeResult();
  clean.nodes[0] = {
    ...clean.nodes[0],
    summary: '现任女皇，在复兴纪元执掌宫廷。',
    identities: ['女皇'],
  };
  const validated = parseAndValidateGenealogy(JSON.stringify(clean), {
    requestId,
    input,
    context,
    directive: '神明纪元 维奥莱塔宗族谱系',
  });
  assert.equal(validated.nodes.length, clean.nodes.length);
});

test('R-02：谱系 prompt 不再二次选源，sources 与 sourceIndex（receipt 顺序）逐条原样一致', () => {
  const context = makeContext();
  // 构造一个 receipt 顺序明确的 sourceIndex：低分来源也不得被二次排名丢弃。
  const extra = {
    sourceId: 'worldbook:低相关条目:9',
    sourceType: 'worldbook' as const,
    title: '低相关条目',
    content: '一句与焦点人物毫无关系的旁证。',
    authority: 100,
  };
  context.sourceIndex = [...context.sourceIndex, extra];
  context.worldbookContext = [...context.worldbookContext, extra];
  const prompt = buildGenealogyApiPrompt({
    requestId,
    directive: '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系',
    generationInput: input,
    context,
    rules: { generationContract: '生成契约' },
  });
  const match = prompt.match(/<REFERENCE_DATA_READ_ONLY>\n(.+?)\n<\/REFERENCE_DATA_READ_ONLY>/u);
  assert.ok(match, '谱系 prompt 必须包含只读资料包');
  const referenceData = JSON.parse(match[1]);
  assert.deepEqual(
    referenceData.sources.map((source: { sourceId: string }) => source.sourceId),
    context.sourceIndex.map((_, index) => `S${index + 1}`),
    'Citation Contract v2 只替换 sourceId 为稳定 S 句柄，不得二次打分/过滤或重排',
  );
  assert.ok(
    referenceData.sources.some((source: { sourceId: string }) =>
      source.sourceId === 'S3'),
    '低相关条目也不得被谱系 prompt 二次排名丢弃',
  );
});
