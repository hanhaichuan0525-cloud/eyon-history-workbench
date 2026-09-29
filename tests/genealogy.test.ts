import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextSource, GenealogyContextBundle } from '../src/core/context.ts';
import { parseTextCommand } from '../src/core/commands.ts';
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
import { buildGenealogyApiPrompt } from '../src/prompts/genealogy.ts';
import type { GenealogyResult } from '../src/schemas/genealogy.ts';
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
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
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
  const record = await workflow.generate(parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系')!, input,
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
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
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
  assert.match(prompt, /同世界原肉身时间穿越者/u);
  assert.match(prompt, /每代尽量达到的目标，也是绝不能超过的硬上限/u);
  assert.match(prompt, /authoritative-kinship-locks-with-generated-fill/u);
  assert.match(prompt, /事实锁.*不是人物准入白名单/u);
  assert.match(prompt, /至少兼顾父系和母系/u);
  assert.match(prompt, /generated 人物与原创关系必须使用空 sourceRefs/u);
  assert.doesNotMatch(prompt, /"taskType":"genealogy"/u);
  assert.doesNotMatch(prompt, /"scope":/u);
  assert.ok(prompt.length < 75_000);
});

test('宗族资料包回显会触发一次干净纠正，纠正请求不复述错误回答', async () => {
  const repository = new MemoryGenealogyRepository();
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
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
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  assert.deepEqual(await provider.getInput(command), {
    ...input,
    focusCharacter: { ...input.focusCharacter, aliases: [] },
  });
  const missing = parseTextCommand('对不存在的人生成宗族谱系');
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

test('严格宗族命令只路由宗族工作流，不触发传记或墟境', async () => {
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
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.deepEqual(calls, [
    'input:genealogy.generate',
    'genealogy:对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系',
  ]);
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
