import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { extractRecordedAge } from '../src/retrieval/catalog.ts';
import {
  buildBiographyPassagePrompt,
  buildBiographyPassageBatchPrompt,
  buildBiographyPlanPrompt,
  extractTargetBornYear,
  resolveTargetBornYear,
} from '../src/prompts/biography.ts';

import type { BiographyContextBundle, ContextSource } from '../src/core/context.ts';
import { parseTextCommand } from '../src/core/commands.ts';
import { BIOGRAPHY_CONTRACT } from '../src/core/biographyContract.ts';
import { buildBiographyContinuityAnchorsSafely } from '../src/core/continuityAnchors.ts';
import { listContinuityRelationDiagnostics } from '../src/core/continuityRelations.ts';
import { buildBiographyShellInstruction } from '../src/prompts/biography.ts';
import { sanitizeRepairErrorText } from '../src/prompts/biography.ts';
import { renderBiographyRootTrace } from '../src/renderers/rootTrace.ts';
import type { Biography, BiographyPassageResponse, BiographyPlan } from '../src/schemas/biography.ts';
import {
  biographyRecordKey,
  MemoryBiographyRepository,
} from '../src/storage/biographies.ts';
import { parseAndValidateBiography } from '../src/validators/biography.ts';
import { parseAndValidateBiographyPassage } from '../src/validators/biography.ts';
import { parseAndValidateBiographyPlan } from '../src/validators/biography.ts';
import { BiographyWorkflow } from '../src/workflows/biography.ts';
import { insertRootTrace } from '../src/workflows/messageAssembly.ts';
import type { BiographyStagePlan } from '../src/runtime/biographyDiceCore.ts';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  RETRIEVAL_RECEIPT_SCHEMA,
  SOURCE_SNAPSHOT_SCHEMA,
  type EvidenceBundle,
  type ArtifactCanonBinding,
} from '../src/retrieval/contracts.ts';

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
    softLimitChars: 12_000,
    hardLimitChars: 16_000,
    fullSourceLimitChars: 8_000,
    maxWindowChars: 2_400,
    usedChars: passages.reduce((total, passage) => total + passage.charCount, 0),
  };
  return {
    schema: EVIDENCE_BUNDLE_SCHEMA,
    requestId,
    taskType: 'biography',
    query: 'fixture',
    sourceSnapshots: snapshots,
    passages,
    claims: [],
    conflictGroupIds: [],
    receipt: {
      schema: RETRIEVAL_RECEIPT_SCHEMA,
      requestId,
      mode: 'active',
      taskType: 'biography',
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

const directive = '对维奥莱塔进行寻根溯源,主要方向是她24岁到28岁的猎艳史';
const namespace = {
  characterKey: '命定之诗',
  chatId: '存档-传记测试',
};
const requestId = 'bio-test-001';
const sourceId = 'mvu:维奥莱塔';

function makeBiography(): Biography {
  const types = ['stable', 'turbulent', 'transition', 'stable', 'transition'] as const;
  const stages = Array.from({ length: 5 }, (_, index) => ({
    id: `stage-${index + 1}`,
    type: types[index],
    title: `第${index + 1}时期`,
    // age 模式下 renderSpanLabel 恒输出「x岁至x岁」：单点段跨度（起止同龄）
    // 渲染为「24岁至24岁」等，fixture 文案与组装结果保持一致。
    span: `${24 + index}岁至${24 + index}岁`,
    diceMaterial: `骰面${index + 1}`,
    content: longText(`维奥莱塔在第${index + 1}时期留下的独特经历。`),
    people: ['维奥莱塔'],
    factions: ['奥古斯提姆帝国'],
    objects: [],
    locations: ['皇宫'],
    introduced: [],
    sourceRefs: [sourceId],
    biographyUsage: [],
    inference: true,
    // 校验器归一化输出固定携带这两个键（停滞期标记 / 推进者），fixture 对齐
    stalled: false,
    driver: undefined,
  }));

  const origin = {
    title: '起源(二十四岁)',
    content: longText('她在二十四岁时第一次主动选择亲密关系。'),
    sourceRefs: [sourceId],
    inference: true,
  };
  const status = {
    title: '现状(二十八岁)',
    content: longText('这些经历最终塑造了她看待亲密与权力的方式。'),
    sourceRefs: [sourceId],
    inference: true,
  };
  const summary = '这是一段关于欲望、责任与自我判断逐步成形的传记。';
  const rootTrace = [
    '[RootTrace]',
    'Title:: 《维奥莱塔猎艳史》',
    'Target:: 维奥莱塔',
    'Span:: 24岁至28岁',
    `Origin:: ${origin.title} ${origin.content}`,
    'Periods::',
    ...stages.map(stage =>
      `<details class="eybi-stage"><summary>${stage.title}</summary><div>${stage.content}</div></details>`),
    `Status:: ${status.title} ${status.content}`,
    `Summary:: ${summary}`,
    '[/RootTrace]',
  ].join('\n');

  const biography: Biography = {
    schema: 'eyon.biography.v1',
    requestId,
    playerDirective: {
      raw: directive,
      interpretedTarget: '维奥莱塔',
      hardTimeScope: '24岁至28岁',
      primaryDirection: '猎艳史',
      secondaryInterests: ['亲密关系', '帝国责任'],
      reconciliation: '以玩家指定方向为主，世界资料用于约束事实。',
    },
    target: {
      type: 'person',
      name: '维奥莱塔',
      aliases: ['铁血女皇'],
      sourceRefs: [sourceId],
    },
    span: {
      mode: 'age',
      // 校验器归一化输出固定携带 hour（缺省 null）与 era（缺省 undefined）
      start: { year: null, month: null, day: null, hour: null, age: 24, era: undefined },
      end: { year: null, month: null, day: null, hour: null, age: 28, era: undefined },
      label: '24岁至28岁',
    },
    origin,
    stages,
    status,
    summary,
    indexes: {
      people: ['维奥莱塔'],
      factions: ['奥古斯提姆帝国'],
      objects: [],
      locations: ['皇宫'],
      themes: ['亲密关系', '责任'],
      potentialRuinLinks: ['第一次宫廷会面'],
    },
    rootTrace,
    qualityChecks: {
      playerDirectionFulfilled: true,
      hardTimeScopeRespected: true,
      worldbookConsistent: true,
      diceIntegratedWithoutHijacking: true,
      existingBiographiesUsedResponsibly: true,
      rootTraceMatchesStructuredData: true,
    },
  };
  biography.rootTrace = renderBiographyRootTrace({
    ...biography,
    bookId: biography.requestId.slice(-8),
  });
  return biography;
}

function longText(seed: string): string {
  const passage = '她没有把这段关系当作宫廷传闻中的点缀，而是在一次次会面、书信、误解与和解中衡量欲望、责任和权力的边界。身边人的选择不断改变局势，她也必须为自己的决定承担真实后果。多年以后，这些具体经历仍留在她处理亲密关系与帝国事务的方式里，成为旁人能够察觉却无法轻易说破的旧痕。';
  return `${seed}${passage}${passage}${passage}${passage}${passage}`;
}

function makeStagePlan(biography = makeBiography()): BiographyStagePlan {
  return {
    count: biography.stages.length,
    stages: biography.stages.map(stage => ({
      id: stage.id,
      type: stage.type,
      diceMaterial: stage.diceMaterial,
    })),
  };
}

function makeContext(): BiographyContextBundle {
  const source = {
    sourceId,
    sourceType: 'mvu' as const,
    title: '维奥莱塔变量',
    content: '维奥莱塔是奥古斯提姆帝国女皇。',
    authority: 100,
  };
  return {
    schema: 'eyon.context.v1',
    taskType: 'biography',
    requestId,
    scope: {
      ...namespace,
      triggerMessageId: 42,
    },
    currentWorld: {
      time: '复兴纪元488年',
      location: '奥古斯提姆帝国',
    },
    worldbookContext: [],
    recentContext: [],
    characterContext: [source],
    genealogyContext: [],
    biographyRefs: [],
    butterflyRefs: [],
    sourceIndex: [source],
    evidenceBundle: makeEvidenceBundle([source]),
    warnings: [],
    sourceHash: 'fixture-source-hash',
  };
}

function makePlan(biography: Biography): BiographyPlan {
  return {
    schema: 'eyon.biography.plan.v1',
    requestId,
    playerDirective: biography.playerDirective,
    target: biography.target,
    subjectAnchor: '她与奥古斯提姆帝国的权贵关系网绑定',
    changeAxis: '年龄与身份的变化',
    meaningCarrier: '她的选择与行动如何改变周围',
    dramaticQuestion: '她如何在身份与欲望之间活出自己',
    dominantAxis: 'dramaticQuestion',
    span: biography.span,
    originTitle: biography.origin.title,
    statusTitle: biography.status.title,
    eventAssignments: ['origin', ...biography.stages.map(stage => stage.id), 'status'].map((passageId, index) => ({
      passageId,
      eventId: `invented:${passageId}:workflow`,
      summary: ['边关初遇商队', '港口查出走私', '雪夜救援伤兵', '宫廷拒绝联姻', '工坊保护匠人', '河谷重建驿站', '现今整理旧档'][index]!,
      usage: 'occurs' as const,
      sourceRefs: [sourceId],
    })),
    stages: biography.stages.map((stage, index) => ({
      id: stage.id,
      type: stage.type,
      diceMaterial: stage.diceMaterial,
      title: stage.title,
      // 每段自己的起止锚点（单点），与 fixture 的段跨度文案（24岁/25岁…）一致，
      // 组装时 renderSpanLabel 才能渲染出与 fixture RootTrace 相同的段标签。
      span: {
        start: { year: null, month: null, day: null, hour: null, age: 24 + index },
        end: { year: null, month: null, day: null, hour: null, age: 24 + index },
      },
      theme: `${stage.id}的主题`,
      introduced: [`新面孔${index + 1}`],
      sourceRefs: stage.sourceRefs,
    })),
    summary: biography.summary,
    indexes: biography.indexes,
    qualityChecks: {
      playerDirectionFulfilled: true,
      hardTimeScopeRespected: true,
      worldbookConsistent: true,
      diceIntegratedWithoutHijacking: true,
      existingBiographiesUsedResponsibly: true,
    },
    sourceRefs: [sourceId],
  };
}

function makePassage(
  biography: Biography,
  passageId: string,
  kind: 'origin' | 'stage' | 'status',
): BiographyPassageResponse {
  const base = {
    schema: 'eyon.biography.passage.v1' as const,
    requestId,
    passageId,
    kind,
    people: [] as string[],
    factions: [] as string[],
    objects: [] as string[],
    locations: [] as string[],
    biographyUsage: [] as BiographyPassageResponse['biographyUsage'],
    eventId: `invented:${passageId}:workflow`,
    eventUsage: 'occurs' as const,
    inference: true,
    elementChecklist: {
      sceneGrounded: true,
      figureVivid: true,
      decisiveMoment: true,
    },
  };
  if (kind === 'origin') {
    return {
      ...base,
      title: biography.origin.title,
      content: biography.origin.content,
      sourceRefs: biography.origin.sourceRefs,
    };
  }
  if (kind === 'status') {
    return {
      ...base,
      title: biography.status.title,
      content: biography.status.content,
      sourceRefs: biography.status.sourceRefs,
    };
  }
  const stage = biography.stages.find(item => item.id === passageId);
  if (!stage) throw new Error(`stage ${passageId} not found`);
  return {
    ...base,
    title: stage.title,
    content: stage.content,
    people: stage.people,
    factions: stage.factions,
    objects: stage.objects,
    locations: stage.locations,
    sourceRefs: stage.sourceRefs,
    biographyUsage: stage.biographyUsage,
    inference: stage.inference,
  };
}

function buildResponses(biography: Biography): string[] {
  const plan = makePlan(biography);
  const origin = makePassage(biography, 'origin', 'origin');
  const stagePassages = biography.stages.map(stage =>
    makePassage(biography, stage.id, 'stage'));
  const status = makePassage(biography, 'status', 'status');
  const all = [origin, ...stagePassages, status];
  const batches: string[] = [];
  for (let index = 0; index < all.length; index += BIOGRAPHY_CONTRACT.batchSize) {
    const response = JSON.stringify({
      schema: 'eyon.biography.passage.batch.v1',
      requestId,
      passages: all.slice(index, index + BIOGRAPHY_CONTRACT.batchSize),
    });
    // 每批首稿完成后紧跟一次完整语义复核；无冲突时复核稿可原样返回。
    batches.push(response, response);
  }
  return [JSON.stringify(plan), ...batches];
}

test('规划顶层 span.mode 容错：枚举外值/中文/缺失回落合法枚举', () => {
  const biography = makeBiography();
  const expected = {
    requestId,
    directive,
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  };

  // 枚举外自造值：按 start/end 的 age 锚点推断为 age（两侧皆 age、无 year）
  const direct = buildResponses(biography)[0];
  const withMode = JSON.parse(direct);
  withMode.span.mode = 'chronological_period';
  let parsed = parseAndValidateBiographyPlan(JSON.stringify(withMode), expected);
  assert.equal(parsed.span.mode, 'age');

  // 中文词：日历 → calendar
  withMode.span.mode = '年龄';
  parsed = parseAndValidateBiographyPlan(JSON.stringify(withMode), expected);
  assert.equal(parsed.span.mode, 'age');

  // 枚举值直通：calendar 保持
  withMode.span.mode = 'calendar';
  parsed = parseAndValidateBiographyPlan(JSON.stringify(withMode), expected);
  assert.equal(parsed.span.mode, 'calendar');

  // 数字：非可识别值 → 按锚点推断为 age（两侧皆 age、无 year）
  withMode.span.mode = 42;
  parsed = parseAndValidateBiographyPlan(JSON.stringify(withMode), expected);
  assert.equal(parsed.span.mode, 'age');
  // 缺失：同样按锚点推断为 age
  delete withMode.span.mode;
  parsed = parseAndValidateBiographyPlan(JSON.stringify(withMode), expected);
  assert.equal(parsed.span.mode, 'age');
});

test('传记结果只接受单个严格 JSON，核对来源并确定性生成 RootTrace', () => {
  const biography = makeBiography();
  const context = makeContext();
  assert.deepEqual(
    parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive,
      context,
      stagePlan: makeStagePlan(biography),
    }),
    biography,
  );

  const stalePresentation = structuredClone(biography);
  stalePresentation.rootTrace = '[RootTrace]\nTitle:: 旧的重复展示文本\n[/RootTrace]';
  stalePresentation.qualityChecks.rootTraceMatchesStructuredData = false;
  const rebuilt = parseAndValidateBiography(
    JSON.stringify(stalePresentation),
    { requestId, directive, context, stagePlan: makeStagePlan(stalePresentation) },
  );
  const renderWithBook = (input: Biography) => renderBiographyRootTrace({
    ...input,
    bookId: input.requestId.slice(-8),
  });
  assert.equal(rebuilt.rootTrace, renderWithBook(stalePresentation));
  assert.equal(rebuilt.qualityChecks.rootTraceMatchesStructuredData, true);

  const structuredOnly = structuredClone(biography) as unknown as Record<string, unknown>;
  delete structuredOnly.rootTrace;
  const structuredOnlyQuality = structuredOnly.qualityChecks as Record<string, unknown>;
  delete structuredOnlyQuality.rootTraceMatchesStructuredData;
  const renderedFromStructuredOnly = parseAndValidateBiography(
    JSON.stringify(structuredOnly),
    { requestId, directive, context, stagePlan: makeStagePlan(biography) },
  );
  assert.equal(renderedFromStructuredOnly.rootTrace, renderWithBook(biography));
  assert.equal(renderedFromStructuredOnly.qualityChecks.rootTraceMatchesStructuredData, true);

  assert.deepEqual(
    parseAndValidateBiography(
      `\`\`\`json\n${JSON.stringify(biography)}\n\`\`\``,
      { requestId, directive, context, stagePlan: makeStagePlan(biography) },
    ),
    biography,
  );

  const wrongSource = structuredClone(biography);
  wrongSource.origin.sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateBiography(
      JSON.stringify(wrongSource),
      { requestId, directive, context, stagePlan: makeStagePlan(wrongSource) },
    ),
    /Unknown source reference/u,
  );
});

test('对象是主角本人时，主角名不触发 TARGET_MISMATCH', () => {
  const biography = structuredClone(makeBiography());
  biography.target = { ...biography.target, name: namespace.characterKey, aliases: [] };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对我进行寻根溯源',
    interpretedTarget: '我',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对我进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, namespace.characterKey);

  const wrong = structuredClone(biography);
  wrong.target = { ...wrong.target, name: '马库斯', aliases: [] };
  assert.throws(
    () => parseAndValidateBiography(JSON.stringify(wrong), {
      requestId,
      directive: '对我进行寻根溯源',
      context: makeContext(),
      stagePlan: makeStagePlan(wrong),
    }),
    /target does not match player directive/u,
  );
});

test('玩家用称呼指代目标时，只要资料条目锚定该实体就不触发 TARGET_MISMATCH', () => {
  // 玩家说「铁血女皇」，模型解析为权威名「维奥莱塔」但 aliases 漏填：
  // 字面匹配不中，但 target.sourceRefs 命中的资料条目内容包含权威名 → 实体锚定放行。
  const biography = structuredClone(makeBiography());
  biography.target = { ...biography.target, name: '维奥莱塔', aliases: [] };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对那位铁血女皇进行寻根溯源',
    interpretedTarget: '铁血女皇',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对那位铁血女皇进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '维奥莱塔');
});

test('玩家用关系指代（父亲）时，只要谱系/世界书条目承载该关系就不触发 TARGET_MISMATCH', () => {
  const biography = structuredClone(makeBiography());
  biography.target = { ...biography.target, name: '马库斯', aliases: [] };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对父亲的过去进行寻根溯源',
    interpretedTarget: '父亲',
  };
  const context = makeContext();
  context.sourceIndex = [
    ...context.sourceIndex,
    {
      sourceId: 'genealogy:马库斯',
      sourceType: 'genealogy',
      title: '马库斯（主角之父）',
      content: '马库斯是维奥莱塔的父亲，年轻时曾在边境军团服役。',
      authority: 75,
    },
  ];
  biography.target = {
    ...biography.target,
    name: '马库斯',
    aliases: [],
    sourceRefs: ['genealogy:马库斯'],
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对父亲的过去进行寻根溯源',
    context,
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '马库斯');
});

test('玩家用描述性短语指代时，共享实体证据（金谷城）放行', () => {
  const biography = structuredClone(makeBiography());
  biography.target = { ...biography.target, name: '莉迪娅', aliases: [] };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '寻根溯源：那位建立金谷城的女人',
    interpretedTarget: '建立金谷城的女人',
  };
  const context = makeContext();
  context.sourceIndex = [
    ...context.sourceIndex,
    {
      sourceId: 'worldbook:金谷城',
      sourceType: 'worldbook',
      title: '金谷城',
      content: '金谷城由莉迪娅于旧历三百年建立，是东西商路的中转要塞。',
      authority: 100,
    },
  ];
  biography.target = {
    ...biography.target,
    name: '莉迪娅',
    aliases: [],
    sourceRefs: ['worldbook:金谷城'],
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '寻根溯源：那位建立金谷城的女人',
    context,
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '莉迪娅');
});

test('把主角错位成历史人物且无实体支撑时仍触发 TARGET_MISMATCH', () => {
  // 玩家明确要维奥莱塔，模型把 target 写成主角名（命定之诗），
  // 且主角名不在任何资料条目内容中 → 主角特判/字面/实体锚定/称呼映射全部不中。
  const biography = structuredClone(makeBiography());
  biography.target = { ...biography.target, name: namespace.characterKey, aliases: [] };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对维奥莱塔进行寻根溯源',
    interpretedTarget: '维奥莱塔',
  };
  assert.throws(
    () => parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive: '对维奥莱塔进行寻根溯源',
      context: makeContext(),
      stagePlan: makeStagePlan(biography),
    }),
    /target does not match player directive/u,
  );
});

test('玩家用属格短语（女皇的肉体）指代身体对象时，组合权威名放行', () => {
  // 语料中不存在「女皇的肉体」或「维奥莱塔的躯体」字样，
  // 但权威名片段「维奥莱塔」与语料条目共享 → 锚定放行，不再卡「的」字。
  const biography = structuredClone(makeBiography());
  biography.target = {
    type: 'object',
    name: '维奥莱塔的躯体',
    aliases: [],
    sourceRefs: [],
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '伊雍，对女皇的肉体进行寻根溯源，要求从它发育成熟开始到现在',
    interpretedTarget: '女皇的肉体',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '伊雍，对女皇的肉体进行寻根溯源，要求从它发育成熟开始到现在',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '维奥莱塔的躯体');
});

test('空白层原创对象（他的马桶）声明 inference 后放行', () => {
  // 语料中不存在马桶实体；玩家指代含「他」非纯名字，模型声明空白层原创 → 放行。
  const biography = structuredClone(makeBiography());
  biography.target = {
    type: 'object',
    name: '阿黄的马桶',
    aliases: [],
    sourceRefs: [],
    inference: true,
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对他的马桶进行寻根溯源',
    interpretedTarget: '他的马桶',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对他的马桶进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '阿黄的马桶');
});

test('抽象概念目标（帝国的经济发展）通过实体片段锚定放行', () => {
  const biography = structuredClone(makeBiography());
  biography.target = {
    type: 'object',
    name: '帝国的经济发展',
    aliases: [],
    sourceRefs: [],
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对帝国的经济发展进行寻根溯源',
    interpretedTarget: '帝国的经济发展',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对帝国的经济发展进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '帝国的经济发展');
});

test('玩家指名（路西法）但目标换成主角且无任何关联时拒绝', () => {
  // 指名守卫：纯名字指代（路西法）未在语料解析、也未锚定，target 名与其毫无关联 → 拒绝。
  const biography = structuredClone(makeBiography());
  biography.target = {
    type: 'person',
    name: namespace.characterKey,
    aliases: [],
    sourceRefs: [],
    inference: true,
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对路西法进行寻根溯源',
    interpretedTarget: '路西法',
  };
  assert.throws(
    () => parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive: '对路西法进行寻根溯源',
      context: makeContext(),
      stagePlan: makeStagePlan(biography),
    }),
    /target does not match player directive/u,
  );
});

test('sourceRefs 与 aliases 全空但权威名在语料中时照常放行（宽松锚定）', () => {
  // 模型只给出权威名、漏填称呼与引用：只要权威名能在语料中解析即放行。
  const biography = structuredClone(makeBiography());
  biography.target = {
    ...biography.target,
    name: '维奥莱塔',
    aliases: [],
    sourceRefs: [],
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '对那位铁血女皇进行寻根溯源',
    interpretedTarget: '铁血女皇',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '对那位铁血女皇进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '维奥莱塔');
});

test('声明 playerReference 时按声明校验，interpretedTarget 可为权威名', () => {
  // 模型把 interpretedTarget 规范化为权威名（维奥莱塔），但声明 playerReference=女皇：
  // 声明必须逐字来自指令，且解析到真实实体后 target 与其共享身份 → 放行。
  const biography = structuredClone(makeBiography());
  biography.target = {
    type: 'person',
    name: '维奥莱塔',
    aliases: [],
    sourceRefs: [sourceId],
    playerReference: '女皇',
    inference: false,
  };
  biography.playerDirective = {
    ...biography.playerDirective,
    raw: '伊雍，对女皇的肉体进行寻根溯源',
    interpretedTarget: '维奥莱塔',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive: '伊雍，对女皇的肉体进行寻根溯源',
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.target.name, '维奥莱塔');
});

test('正文引用资料条目标题时被拒绝，正常《》书名不误伤', () => {
  const biography = structuredClone(makeBiography());
  biography.origin = {
    ...biography.origin,
    content: `根据《维奥莱塔变量》的记载，她的命运自此改变。${biography.origin.content}`,
  };
  assert.throws(
    () => parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive,
      context: makeContext(),
      stagePlan: makeStagePlan(biography),
    }),
    /must not cite source titles/u,
  );

  const clean = structuredClone(makeBiography());
  clean.origin = {
    ...clean.origin,
    content: `她在灯下翻开一本《风物志》。${clean.origin.content}`,
  };
  assert.doesNotThrow(
    () => parseAndValidateBiography(JSON.stringify(clean), {
      requestId,
      directive,
      context: makeContext(),
      stagePlan: makeStagePlan(clean),
    }),
  );
});

test('传记结果将阶段单值、缺失集合、伪推断来源和字符串布尔值确定性归一化', () => {
  const biography = structuredClone(makeBiography()) as unknown as {
    stages: Array<Record<string, unknown>>;
    status: Record<string, unknown>;
  };
  biography.stages[0].people = '维奥莱塔';
  biography.stages[0].factions = { name: '奥古斯提姆帝国' };
  biography.stages[0].objects = null;
  biography.stages[0].locations = undefined;
  biography.stages[0].biographyUsage = null;
  biography.stages[0].sourceRefs = ['inference：初期构思推断'];
  biography.stages[0].inference = 'false';
  biography.status.inference = '是';

  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive,
    context: makeContext(),
    stagePlan: makeStagePlan(makeBiography()),
  });
  assert.deepEqual(parsed.stages[0].people, ['维奥莱塔']);
  assert.deepEqual(parsed.stages[0].factions, ['奥古斯提姆帝国']);
  assert.deepEqual(parsed.stages[0].objects, []);
  assert.deepEqual(parsed.stages[0].locations, []);
  assert.deepEqual(parsed.stages[0].biographyUsage, []);
  assert.deepEqual(parsed.stages[0].sourceRefs, []);
  assert.equal(parsed.stages[0].inference, true);
  assert.equal(parsed.status.inference, true);
});

test('传记结果将日期 label 确定性收束为标准合同', () => {
  const biography = structuredClone(makeBiography()) as unknown as {
    span: {
      start: Record<string, unknown>;
      end: Record<string, unknown>;
    };
  };
  biography.span.start = {
    year: '125',
    month: '',
    day: null,
    age: '未知',
    label: '复兴纪元125年5月2日',
  };
  biography.span.end = {
    year: undefined,
    month: undefined,
    day: undefined,
    age: '28',
    label: '复兴纪元488年12月31日，28岁',
  };

  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive,
    context: makeContext(),
    stagePlan: makeStagePlan(makeBiography()),
  });
  assert.deepEqual(parsed.span.start, { year: 125, month: 5, day: 2, hour: null, age: null, era: undefined });
  assert.deepEqual(parsed.span.end, { year: 488, month: 12, day: 31, hour: null, age: 28, era: undefined });
});

test('传记插槽替换不改写正文模型自然生成的伊雍对话', () => {
  const biography = makeBiography();
  const slot = '[EYON_ROOTTRACE_SLOT::bio-test-001]';
  const dialogue = [
    '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
    '<eyon_court/>',
  ].join('\n');
  const assembled = insertRootTrace(`${dialogue}\n${slot}`, slot, biography.rootTrace);

  assert.match(assembled.content, /让我替你翻开这段旧史/u);
  assert.equal(assembled.content.includes(slot), false);
  assert.equal(assembled.content.split('[RootTrace]').length - 1, 1);
  assert.equal(assembled.warning, 'none');
});

test('传记提交会移除模型误抄的通用占位符', () => {
  const biography = makeBiography();
  const assembled = insertRootTrace(
    '<eyon_court/>\n**[EYON_ROOTTRACE_SLOT::requestId]**',
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  assert.doesNotMatch(assembled.content, /EYON_ROOTTRACE_SLOT/u);
  assert.match(assembled.content, /\[RootTrace\]/u);
});

test('insertRootTrace 将 RootTrace 压成单行，字段间用空格以匹配美化正则', () => {
  const biography = makeBiography();
  // 脚本渲染的 RootTrace 原本是多行（字段间换行）
  assert.match(biography.rootTrace, /\nTitle::/u);

  const assembled = insertRootTrace(
    '<eyon_court/>',
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  // 写入正文楼后字段间不再有真实换行，而是空格
  assert.doesNotMatch(assembled.content, /\nTitle::/u);
  assert.match(assembled.content, /\[RootTrace\] BookId:: [\s\S]*? Title:: /u);
});

test('insertRootTrace 丢弃 court 之后模型仿写的无美化 [RootTrace] 假传记块', () => {
  const biography = makeBiography();
  const assembled = insertRootTrace(
    [
      '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
      '<eyon_court/>',
      '[RootTrace]',
      'Title:: 《假传记》',
      'Summary:: 模型模仿旧楼自行编造的传记',
      '[/RootTrace]',
    ].join('\n'),
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  // 伊雍开场保留
  assert.match(assembled.content, /让我替你翻开这段旧史/u);
  // 模型仿写的无美化假传记块被剥离，只保留脚本权威 RootTrace
  assert.doesNotMatch(assembled.content, /《假传记》/u);
  assert.doesNotMatch(assembled.content, /自行编造的传记/u);
  assert.equal(assembled.content.split('[RootTrace]').length - 1, 1);
  assert.equal(assembled.warning, 'trailing_discarded');
});

test('insertRootTrace 保留 court 之后的伊雍短尾台词（置于 RootTrace 之后）', () => {
  const biography = makeBiography();
  const assembled = insertRootTrace(
    [
      '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
      '<eyon_court/>',
      '她的故事，就写在这里了。',
    ].join('\n'),
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  // 短尾台词不被吞：保留在权威 RootTrace 之后
  assert.match(assembled.content, /她的故事，就写在这里了。/u);
  const courtIndex = assembled.content.indexOf('<eyon_court/>');
  const rootTraceIndex = assembled.content.indexOf('[RootTrace]');
  const tailIndex = assembled.content.indexOf('她的故事');
  assert.ok(courtIndex >= 0);
  assert.ok(courtIndex < rootTraceIndex);
  assert.ok(rootTraceIndex < tailIndex);
  assert.equal(assembled.warning, 'none');
});

test('insertRootTrace 保留 court 后的正文延续与文末 MVU 面板（方案 A）', () => {
  const biography = makeBiography();
  const assembled = insertRootTrace(
    [
      '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
      '<eyon_court/>',
      '她在烛火下替他拢了拢衣襟，声音低下去：「睡吧……明天黎明之前，这里只有你和我。」',
      '',
      '<bbs_end>1988/10/16 22:35</bbs_end>',
      '</gametxt>',
      '<!-- SDC-end 复兴纪元488年10月16日 22时 -->',
      '',
      '<UpdateVariable>',
      '<Analysis>',
      '- calculate time passed: 5 minutes',
      '</Analysis>',
      '<JSONPatch>',
      '[{ "op": "replace", "path": "/世界/时间", "value": "复兴纪元488年-10月-16日-星期日-22:35" }]',
      '</JSONPatch>',
      '</UpdateVariable>',
    ].join('\n'),
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  // 文末 MVU 面板（<UpdateVariable> 块）必须保留
  assert.match(assembled.content, /<UpdateVariable>/u);
  assert.match(assembled.content, /<JSONPatch>/u);
  assert.match(assembled.content, /复兴纪元488年-10月-16日-星期日-22:35/u);
  // court 后的正文延续（对白 + 收尾标签）也全部保留
  assert.match(assembled.content, /明天黎明之前/u);
  assert.match(assembled.content, /<bbs_end>/u);
  assert.match(assembled.content, /SDC-end/u);
  // 顺序：伊雍开场 → court → 权威 RootTrace → 正文延续/面板
  const headIndex = assembled.content.indexOf('让我替你翻开');
  const courtIndex = assembled.content.indexOf('<eyon_court/>');
  const rootTraceIndex = assembled.content.indexOf('[RootTrace]');
  const panelIndex = assembled.content.indexOf('<UpdateVariable>');
  assert.ok(headIndex >= 0 && headIndex < courtIndex);
  assert.ok(courtIndex < rootTraceIndex);
  assert.ok(rootTraceIndex < panelIndex);
  // 只有一份权威 RootTrace
  assert.equal(assembled.content.split('[RootTrace]').length - 1, 1);
  assert.equal(assembled.warning, 'none');
});

test('insertRootTrace 在 court 后无违规内容时不产生丢弃警告', () => {
  const biography = makeBiography();
  const assembled = insertRootTrace(
    [
      '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
      '<eyon_court/>',
    ].join('\n'),
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
    biography.rootTrace,
  );
  assert.equal(assembled.warning, 'none');
});

test('正文协作提示要求完整普通剧情，同时只禁止模型仿写传记', () => {
  const biography = makeBiography();
  const instruction = buildBiographyShellInstruction(
    biography,
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
  );
  assert.match(instruction, /生成伊雍对此次传记的简短开场/u);
  assert.match(instruction, /生成这一楼完整的自然剧情回应/u);
  assert.match(instruction, /随后继续生成角色卡与预设原本要求的普通剧情/u);
  assert.match(instruction, /<UpdateVariable>/u);
  assert.match(instruction, /禁止自行生成、复述、概括、改写或评论传记正文/u);
  assert.match(instruction, /不得因本轮是寻根溯源而省略正常剧情正文/u);
  assert.doesNotMatch(instruction, /立即结束|之后不得再输出任何字符/u);
  assert.doesNotMatch(instruction, /必须说/u);
});

test('寻根溯源事务分阶段生成后落库，再注入同一条正文消息', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  let assistantMessage = '';
  const command = parseTextCommand(directive);
  assert.ok(command);

  const responses = buildResponses(biography);
  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate(taskType) {
        assert.equal(taskType, 'biography');
        return responses.shift() ?? '';
      },
    },
    shell: {
      async readAssistantMessage() {
        return assistantMessage;
      },
      async writeAssistantMessage(_messageId, content) {
        assistantMessage = content;
      },
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() {
      return {
        namespace,
        triggerMessageId: 42,
      };
    },
    createRequestId() {
      return requestId;
    },
    createStagePlan() {
      return makeStagePlan(biography);
    },
    now() {
      return 1000;
    },
  });

  const preparation = await workflow.prepare(command);
  assistantMessage = [
    '<eyon name="伊雍" mood="bright">「旧纸页上的墨迹已经醒来。」</eyon>',
    '<eyon_court/>',
  ].join('\n');
  const result = await workflow.commit(preparation, 77);
  const record = await repository.get(
    biographyRecordKey(namespace, result.biographyId),
  );
  assert.equal(record?.status, 'committed');
  assert.equal(record?.assistantMessageId, 77);
  assert.match(assistantMessage, /旧纸页上的墨迹已经醒来/u);
  assert.match(assistantMessage, /\[RootTrace\]/u);
});

test('批扩写失败会降级为单块，单块失败触发定向修复后再落库', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);

  const origin = makePassage(biography, 'origin', 'origin');
  const stages = biography.stages.map(stage => makePassage(biography, stage.id, 'stage'));
  const status = makePassage(biography, 'status', 'status');

  const responses = [
    JSON.stringify(makePlan(biography)),
    // 第一批批请求（origin + stage-1）：返回单块 origin（非法批 schema）→ 触发降级为逐块
    JSON.stringify(origin),
    // 降级后逐块：origin 第一次失败（太短）→ 单块 repair
    JSON.stringify({ ...origin, content: '太短' }),
    JSON.stringify(origin),
    JSON.stringify(stages[0]),
    // 第一批全文连续性复核
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [origin, stages[0]] }),
    // 后续批：有效批响应（每批 2 块，status 单独 1 块）
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [stages[1], stages[2]] }),
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [stages[1], stages[2]] }),
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [stages[3], stages[4]] }),
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [stages[3], stages[4]] }),
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [status] }),
    JSON.stringify({ schema: 'eyon.biography.passage.batch.v1', requestId, passages: [status] }),
  ];
  const prompts: string[] = [];

  const workflow = new BiographyWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        prompts.push(prompt);
        return responses.shift() ?? '';
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  assert.ok(prompts.some(prompt => /BIOGRAPHY_PASSAGE_REPAIR_TASK/u.test(prompt)));
  assert.match(preparation.rootTrace, /Subtitle:: 这是一段关于欲望、责任与自我判断逐步成形的传记。/u);
  assert.doesNotMatch(preparation.rootTrace, new RegExp(`Subtitle:: ${directive}`, 'u'));
  assert.equal((await repository.list(namespace)).length, 1);
});

test('规划阶段返回旧版字段时拒绝，不写入任何存档', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);

  const workflow = new BiographyWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate() {
        return JSON.stringify({ targetName: '维奥莱塔', currentStatus: '仍在统治帝国', stages: [] });
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  await assert.rejects(() => workflow.prepare(command), /eyon\.biography\.plan\.v1/u);
  assert.deepEqual(await repository.list(namespace), []);
});

test('生成期间切换聊天时停止事务，不写入任何存档', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);
  let scopeReadCount = 0;

  const responses = buildResponses(biography);
  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate() {
        return responses.shift() ?? '';
      },
    },
    shell: {
      async readAssistantMessage() {
        return '';
      },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '',
      retrievalContract: '',
      validationContract: '',
      generationContract: '',
    },
    async getScope() {
      scopeReadCount += 1;
      return {
        namespace: scopeReadCount === 1
          ? namespace
          : { ...namespace, chatId: '另一个存档' },
        triggerMessageId: 42,
      };
    },
    createRequestId() {
      return requestId;
    },
    createStagePlan() {
      return makeStagePlan(biography);
    },
    now() {
      return 1000;
    },
  });

  await assert.rejects(() => workflow.prepare(command), /Chat changed/u);
  assert.deepEqual(await repository.list(namespace), []);
});

test('legacy biography contract rejects a missing planned period', () => {
  const biography = makeBiography();
  const stagePlan = makeStagePlan(biography);
  biography.stages.pop();
  assert.throws(
    () => parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive,
      context: makeContext(),
      stagePlan,
    }),
    /stages/u,
  );
});

test('biography contract rejects origin, period and status prose below the soft minimum', () => {
  for (const mutate of [
    (biography: Biography) => { biography.origin.content = '字'.repeat(100); },
    (biography: Biography) => { biography.stages[0].content = '字'.repeat(100); },
    (biography: Biography) => { biography.status.content = '字'.repeat(100); },
  ]) {
    const biography = makeBiography();
    const stagePlan = makeStagePlan(biography);
    mutate(biography);
    assert.throws(
      () => parseAndValidateBiography(JSON.stringify(biography), {
        requestId,
        directive,
        context: makeContext(),
        stagePlan,
      }),
      /(at least 260 characters|必须至少260字)/u,
    );
  }
});

test('串行扩写时各批顺序发起，各块独立成篇并静默继承既有物件状态', async () => {
  const biography = makeBiography();
  biography.stages[0]!.objects = ['旧式留影相机'];
  biography.stages[0]!.content = longText('她在旧货摊买下旧式留影相机，并从此随身携带。');
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);

  const prompts: string[] = [];
  let concurrent = 0;
  let peakConcurrent = 0;
  let completed = 0;

  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        prompts.push(prompt);
        concurrent += 1;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        // 串行：请求之间不允许并发交错
        await new Promise(resolve => globalThis.setTimeout(resolve, 0));
        concurrent -= 1;
        completed += 1;
        if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
          return JSON.stringify(makePlan(biography));
        }
        // 响应式回显：从请求的 request_data 读取块清单，回吐同条数同顺序的合法响应，
        // 与当前批次契约（条数严格匹配、每项单块 schema）保持一致。
        const data = prompt.match(/<request_data>([\s\S]*?)<\/request_data>/u)?.[1];
        if (data) {
          const request = JSON.parse(data) as {
            passages?: Array<{ passageId: string; kind: string }>;
            passage?: { passageId: string; kind: string };
          };
          if (Array.isArray(request.passages)) {
            return JSON.stringify({
              schema: 'eyon.biography.passage.batch.v1',
              requestId,
              passages: request.passages.map(block =>
                makePassage(biography, block.passageId, block.kind as 'origin' | 'stage' | 'status')),
            });
          }
          if (request.passage) {
            return JSON.stringify(makePassage(
              biography,
              request.passage.passageId,
              request.passage.kind as 'origin' | 'stage' | 'status',
            ));
          }
        }
        throw new Error(`unexpected prompt: ${prompt.slice(0, 120)}`);
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  // 串行：任何时刻只有 1 个请求在飞
  assert.equal(peakConcurrent, 1, `expected serial batches, got peak ${peakConcurrent}`);
  // plan + 4 批首稿 + 4 次整批全文复核（尾批 1 块）
  assert.equal(completed, 9);
  const batchPrompts = prompts.filter(prompt => /passage\.batch\.request\.v1/u.test(prompt));
  const reviewPrompts = batchPrompts.filter(prompt => /<BIOGRAPHY_FULL_PASSAGE_SEMANTIC_REVIEW>/u.test(prompt));
  const draftPrompts = batchPrompts.filter(prompt => !/<BIOGRAPHY_FULL_PASSAGE_SEMANTIC_REVIEW>/u.test(prompt));
  assert.equal(batchPrompts.length, 8);
  assert.equal(reviewPrompts.length, 4);
  assert.ok(reviewPrompts.every(prompt => /本批完整首稿（逐段审阅后返回）/u.test(prompt)));
  // 批请求不再携带前段 threadSummary（块间彼此独立）
  assert.ok(batchPrompts.every(prompt => !/<THREAD_SO_FAR>/u.test(prompt)));
  // 第一批尚无既成状态；第二批只收到静默连续状态，不要求复述前情。
  assert.doesNotMatch(draftPrompts[0] ?? '', /<BIOGRAPHY_CONTINUITY_CONTEXT>/u);
  assert.match(draftPrompts[1] ?? '', /<BIOGRAPHY_CONTINUITY_CONTEXT>/u);
  assert.match(draftPrompts[1] ?? '', /旧式留影相机/u);
  assert.match(draftPrompts[1] ?? '', /无关实体不要提/u);
  // 规划提示词注入世界观与生成规则，不再携带脚本契约（检索/校验）；扩写提示词同样
  const planPrompt = prompts.find(prompt => /eyon\.biography\.plan\.v1/u.test(prompt));
  assert.ok(planPrompt);
  assert.match(planPrompt, /<shared_context>/u);
  assert.match(planPrompt, /<generation_contract>/u);
  assert.doesNotMatch(planPrompt, /<retrieval_contract>/u);
  assert.doesNotMatch(planPrompt, /<validation_contract>/u);
  assert.doesNotMatch(draftPrompts[0] ?? '', /<retrieval_contract>/u);
  assert.doesNotMatch(draftPrompts[0] ?? '', /<validation_contract>/u);
  assert.doesNotMatch(draftPrompts[0] ?? '', /<shared_context>/u);
  assert.match(draftPrompts[0] ?? '', /MVU、当前状态与关系表中的人物默认属于当前剧情时代/u);
  // 扩写请求数据使用精简 plan 摘要，不携带完整 stages
  assert.doesNotMatch(draftPrompts[0] ?? '', /"stages"/u);
  assert.match(preparation.rootTrace, /Subtitle:: 这是一段关于欲望、责任与自我判断逐步成形的传记。/u);
  assert.doesNotMatch(preparation.rootTrace, new RegExp(`Subtitle:: ${directive}`, 'u'));
  assert.equal((await repository.list(namespace)).length, 1);
});

test('P4-A2/P4-C 保存全文复核确认的事实锚，并冻结可见句柄为低权关系', async () => {
  const biography = makeBiography();
  biography.stages[0]!.content = longText(
    '复兴纪元四八六年秋，维奥莱塔亲手封死旧港档案室，此后原址未再开放。',
  );
  const context = makeContext();
  context.evidenceBundle.canonResolvedView = {
    schema: 'eyon.canon.resolved-view.v1',
    viewId: 'view:p4-a2',
    branchId: 'branch:p4-a2',
    requestedRevision: 3,
    resolvedRevision: 3,
    queryScopeHash: 'scope:p4-a2',
    activeFacts: [],
    inactiveFacts: [],
    uncertainItems: [],
    eventRelations: [],
    personViews: [],
    passageViews: [],
    resolutionReceipt: {
      schema: 'eyon.canon.resolve-receipt.v1',
      branchId: 'branch:p4-a2',
      requestedRevision: 3,
      resolvedRevision: 3,
      queryScopeHash: 'scope:p4-a2',
      appliedDeltaIds: [],
      skippedDeltaIds: [],
      supersededDeltaIds: [],
      uncertainItems: [],
    },
  };
  const repository = new MemoryBiographyRepository();
  const priorBinding: ArtifactCanonBinding = {
    schema: 'eyon.canon.artifact-binding.v1',
    bindingId: 'binding:prior:stage-4',
    branchId: 'branch:p4-a2',
    artifactType: 'biography',
    artifactId: 'bio-prior',
    unitType: 'stage',
    unitId: 'stage-4',
    boundView: { viewId: 'view:p4-a2', resolvedRevision: 3, queryScopeHash: 'scope:p4-a2' },
    entityIds: [], factIds: [], operationRefs: [], sourceRefs: [], createdAt: 1,
  };
  const priorBiography = makeBiography();
  priorBiography.target.name = '沉睡之眼书店';
  priorBiography.stages[3]!.content = longText(
    '复兴纪元四八六年九月，沉睡之眼书店遭帝国侦查队搜检，油灯引燃书架，整座书店彻底焚毁。',
  );
  priorBiography.status.content = longText(
    '复兴纪元四八八年三月，沉睡之眼书店原址仍是一片焦黑空地，未经修缮，也未重新开业。',
  );
  await repository.saveValidated({
    key: biographyRecordKey(namespace, 'bio-prior'),
    namespace, biographyId: 'bio-prior', requestId: 'prior',
    triggerMessageId: 1, assistantMessageId: 2, sourceHash: 'prior',
    status: 'committed', revision: 1, biography: priorBiography,
    canonBindings: [priorBinding],
    continuityAnchors: buildBiographyContinuityAnchorsSafely({
      artifactId: 'bio-prior', canonBindings: [priorBinding], createdAt: 1,
      units: [{
        unitId: 'stage-4', eventId: 'invented:stage-4:fire', eventUsage: 'occurs',
        claim: '复兴纪元四八六年秋，沉睡之眼书店遭搜检并彻底焚毁。',
        temporalScope: { label: '486年秋', start: '复兴纪元486年' },
        people: ['维奥莱塔'], factions: ['沉睡之眼书店'], objects: [],
        locations: ['沉睡之眼书店'], sourceRefs: [], inference: true,
      }],
    }),
    createdAt: 1, updatedAt: 1,
  });
  const command = parseTextCommand(directive);
  assert.ok(command);
  const reviewPrompts: string[] = [];
  const judgePrompts: string[] = [];

  const workflow = new BiographyWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(_taskType, prompt) {
        if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
          return JSON.stringify(makePlan(biography));
        }
        if (/<BIOGRAPHY_CONTINUITY_EVENT_JUDGE>/u.test(prompt)) {
          judgePrompts.push(prompt);
          const stageOnePair = prompt.match(/<PAIR (P\d+)>\s*\n当前传记段（stage-1/u)?.[1];
          assert.ok(stageOnePair);
          return `${stageOnePair}：同一事件；主要差异：结果；理由：两段都在描述复兴纪元486年秋沉睡之眼书店的封闭毁坏。`;
        }
        const data = prompt.match(/<request_data>([\s\S]*?)<\/request_data>/u)?.[1];
        assert.ok(data);
        const request = JSON.parse(data) as {
          passages: Array<{ passageId: string; kind: 'origin' | 'stage' | 'status' }>;
        };
        const reviewed = /<BIOGRAPHY_FULL_PASSAGE_SEMANTIC_REVIEW>/u.test(prompt);
        if (reviewed) reviewPrompts.push(prompt);
        return JSON.stringify({
          schema: 'eyon.biography.passage.batch.v1',
          requestId,
          passages: request.passages.map(block => {
            const passage = makePassage(biography, block.passageId, block.kind);
            return reviewed && block.passageId === 'stage-1'
              ? {
                ...passage,
                locations: [...passage.locations, '沉睡之眼书店'],
                content: longText('复兴纪元四八六年秋，维奥莱塔亲手封死旧港档案室，此后原址未再开放。她后来走过沉睡之眼书店的焦黑旧址。'),
              }
              : block.passageId === 'stage-1'
              ? {
                ...passage,
                locations: [...passage.locations, '沉睡之眼书店'],
                content: longText('复兴纪元四八六年秋，维奥莱塔亲手封死旧港档案室，此后原址未再开放。她后来走进仍在营业的沉睡之眼书店。'),
              }
              : passage;
          }),
        });
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  const stored = await repository.get(biographyRecordKey(namespace, preparation.biographyId));
  const proseAnchors = stored?.continuityAnchors?.filter(anchor =>
    anchor.claimSource === 'final-prose') ?? [];
  const stageOneAnchor = proseAnchors.find(anchor => anchor.producer.unitId === 'stage-1');
  assert.ok(proseAnchors.length > 1);
  assert.ok(stageOneAnchor);
  assert.match(stageOneAnchor.claim, /24岁至24岁.*维奥莱塔相关事件：港口查出走私/u);
  assert.equal(stageOneAnchor.canonRevision, 3);
  assert.equal(stored?.continuityRelations?.length, 1);
  assert.equal(stored?.continuityRelations?.[0]?.kind, 'parallelView');
  assert.equal(stored?.continuityRelations?.[0]?.memberAnchorIds.length, 2);
  assert.ok(reviewPrompts.some(prompt =>
    /沉睡之眼书店遭搜检并彻底焚毁/u.test(prompt)),
  '首稿新提到的旁支地点，应在既有全文复核时召回同 revision 旧锚');
  assert.ok(reviewPrompts.some(prompt =>
    /四八六年九月.*沉睡之眼书店.*彻底焚毁/u.test(prompt)
    && /四八八年三月.*原址仍是一片焦黑空地/u.test(prompt)),
  '复核还须看见锚对应的已提交正文与同一作品的延续状态');
  assert.ok(reviewPrompts.some(prompt => /<COMMITTED_PROSE_FOCUSED_REVIEW>/u.test(prompt)),
    '原样返回的首轮复核应触发至多一次定点比较');
  assert.ok(reviewPrompts.every(prompt =>
    !/continuityClaim|continuityEventVerdicts|CONTINUITY_EVENT_PAIR_SEMANTIC_REVIEW/u.test(prompt)),
  '正文复核不应再承载连续性结构化字段');
  assert.ok(judgePrompts.some(prompt =>
    /<BIOGRAPHY_CONTINUITY_EVENT_JUDGE>/u.test(prompt)
    && /当前传记段（stage-1/u.test(prompt)
    && /既有作品原文/u.test(prompt)),
  '候选事件对应由独立自然语言裁判读取成稿与旧稿原文');
  assert.ok(listContinuityRelationDiagnostics().some(item =>
    item.artifactId === `bio-${requestId}`
    && item.unitId === 'stage-1'
    && item.code === 'event-pair-review-accepted'),
  '聚焦复核只补裁决、不改正文时，仍应留下可诊断的已接纳记录');
  assert.match(stored?.biography.stages[0]?.content ?? '', /沉睡之眼书店的焦黑旧址/u);
  assert.doesNotMatch(stored?.biography.stages[0]?.content ?? '', /仍在营业的沉睡之眼书店/u);
});

test('首稿借用已知人物但漏召回身份时，同一批次合并复核并保留原创空间', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);

  const ilenaSource: ContextSource = {
    sourceId: 'worldbook:伊莲娜',
    sourceType: 'worldbook',
    title: '[角色]伊莲娜·A·梦露',
    content: '伊莲娜·A·梦露:\n  身份: 白鲸杂志社社长\n  职业: 时尚杂志主编',
    authority: 100,
  };
  context.sourceIndex = [...context.sourceIndex, ilenaSource];
  const prompts: string[] = [];
  const originalSupportingCharacter = {
    ...makePassage(biography, 'stage-1', 'stage'),
    content: longText('原创装订师赛拉斯替她抢救了一册被雨水泡坏的账本。'),
    people: ['赛拉斯'],
  };
  const badStatus = {
    ...makePassage(biography, 'status', 'status'),
    content: longText('年轻的实习生伊莲娜·A·梦露抱着杂志走进办公室，帝国将军赛拉斯随行。'),
    people: ['伊莲娜·A·梦露', '赛拉斯'],
  };
  const correctedStatus = {
    ...badStatus,
    content: longText('白鲸杂志社社长伊莲娜·A·梦露抱着新刊，以同行身份走进办公室；装订师赛拉斯只来送回修好的账本。'),
  };

  const workflow = new BiographyWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        prompts.push(prompt);
        if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
          return JSON.stringify(makePlan(biography));
        }
        const data = prompt.match(/<request_data>([\s\S]*?)<\/request_data>/u)?.[1];
        assert.ok(data);
        const request = JSON.parse(data) as {
          passages?: Array<{ passageId: string; kind: string }>;
          passage?: { passageId: string; kind: string };
        };
        if (Array.isArray(request.passages)) {
          if (/<KNOWN_ENTITY_IDENTITY_REVIEW>/u.test(prompt)) {
            assert.match(prompt, /白鲸杂志社社长/u);
            assert.match(prompt, /保留骰表角度、冻结事件和独立片段结构/u);
            return JSON.stringify({
              schema: 'eyon.biography.passage.batch.v1',
              requestId,
              passages: request.passages.map(block => block.passageId === 'status'
                ? correctedStatus
                : makePassage(
                  biography,
                  block.passageId,
                  block.kind as 'origin' | 'stage' | 'status',
                )),
            });
          }
          return JSON.stringify({
            schema: 'eyon.biography.passage.batch.v1',
            requestId,
            passages: request.passages.map(block => {
              if (block.passageId === 'status') return badStatus;
              if (block.passageId === 'stage-1') return originalSupportingCharacter;
              return makePassage(
                biography,
                block.passageId,
                block.kind as 'origin' | 'stage' | 'status',
              );
            }),
          });
        }
        assert.ok(request.passage);
        return JSON.stringify(makePassage(
          biography,
          request.passage.passageId,
          request.passage.kind as 'origin' | 'stage' | 'status',
        ));
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    async resolveEvidence(names, sourceRefs) {
      const selected: ContextSource[] = [];
      if (sourceRefs.includes(sourceId) || names.includes('维奥莱塔')) {
        selected.push(context.sourceIndex[0]!);
      }
      if (names.includes('伊莲娜·A·梦露')) selected.push(ilenaSource);
      return selected;
    },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  assert.match(preparation.rootTrace, /白鲸杂志社社长伊莲娜·A·梦露/u);
  assert.match(preparation.rootTrace, /装订师赛拉斯只来送回修好的账本/u);
  assert.doesNotMatch(preparation.rootTrace, /实习生伊莲娜/u);
  assert.doesNotMatch(preparation.rootTrace, /帝国将军赛拉斯/u);
  assert.equal(prompts.filter(prompt => /<KNOWN_ENTITY_IDENTITY_REVIEW>/u.test(prompt)).length, 1);
});

test('首稿与复核稿都把已知人物写成明确错龄时，最终软护栏删去错龄且不扩大到全篇', async () => {
  const biography = makeBiography();
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '维奥莱塔',
      state: 'alive',
      narrative: '本段按规划年龄24岁在场。',
      lifespan: {
        born: { era: '复兴纪元', year: 464 },
        ageAtRecord: 24,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
      },
    }],
  };
  const command = parseTextCommand(directive);
  assert.ok(command);
  const prompts: string[] = [];
  const wrong = {
    ...makePassage(biography, 'stage-1', 'stage'),
    content: longText('十二岁的维奥莱塔在北门雨夜拒绝了密约。'),
  };
  const corrected = {
    ...wrong,
    // 模拟模型收到复核要求后仍原样重复错龄；脚本不得把这份复核稿直接放行。
    content: longText('十二岁的维奥莱塔在北门雨夜拒绝了密约。'),
  };

  const workflow = new BiographyWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        prompts.push(prompt);
        if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
          return JSON.stringify(makePlan(biography));
        }
        const data = prompt.match(/<request_data>([\s\S]*?)<\/request_data>/u)?.[1];
        assert.ok(data);
        const request = JSON.parse(data) as {
          passages?: Array<{ passageId: string; kind: string }>;
          passage?: { passageId: string; kind: string };
        };
        if (Array.isArray(request.passages)) {
          return JSON.stringify({
            schema: 'eyon.biography.passage.batch.v1',
            requestId,
            passages: request.passages.map(block => {
              if (block.passageId === 'stage-1') {
                return /<KNOWN_ENTITY_IDENTITY_REVIEW>/u.test(prompt) ? corrected : wrong;
              }
              return makePassage(
                biography,
                block.passageId,
                block.kind as 'origin' | 'stage' | 'status',
              );
            }),
          });
        }
        assert.ok(request.passage);
        return JSON.stringify(makePassage(
          biography,
          request.passage.passageId,
          request.passage.kind as 'origin' | 'stage' | 'status',
        ));
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository: new MemoryBiographyRepository(),
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  assert.doesNotMatch(preparation.rootTrace, /十二岁的维奥莱塔/u);
  assert.match(preparation.rootTrace, /维奥莱塔在北门雨夜拒绝了密约/u);
  const reviews = prompts.filter(prompt => /<KNOWN_ENTITY_IDENTITY_REVIEW>/u.test(prompt));
  assert.equal(reviews.length, 1);
  assert.match(reviews[0] ?? '', /明确写了某人“几岁”/u);
  assert.ok(
    prompts.some(prompt => /目标人物出生\/抵达锚为复兴纪元464年/u.test(prompt)),
    '扩写与局部复核必须收到人物时间轴生年，而不是从规划起源另造年龄基准',
  );
});

test('可选人物复核请求失败时保留已校验首稿，不截断整篇传记', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);
  const ilenaSource: ContextSource = {
    sourceId: 'worldbook:伊莲娜',
    sourceType: 'worldbook',
    title: '[角色]伊莲娜·A·梦露',
    content: '伊莲娜·A·梦露:\n  身份: 白鲸杂志社社长\n  籍贯: 索伦蒂斯',
    authority: 100,
  };
  context.sourceIndex = [...context.sourceIndex, ilenaSource];
  const borrowedStatus = {
    ...makePassage(biography, 'status', 'status'),
    content: longText('年轻实习生伊莲娜·A·梦露走进办公室递交账本。'),
    // 模型漏填 people 时，正文中的完整规范名仍应被发现。
    people: [],
  };
  let reviewAttempts = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const workflow = new BiographyWorkflow({
      contextAssembler: { async assemble() { return context; } },
      generator: {
        async generate(taskType, prompt) {
          assert.equal(taskType, 'biography');
          if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
            return JSON.stringify(makePlan(biography));
          }
          const data = prompt.match(/<request_data>([\s\S]*?)<\/request_data>/u)?.[1];
          assert.ok(data);
          const request = JSON.parse(data) as {
            passages?: Array<{ passageId: string; kind: string }>;
            passage?: { passageId: string; kind: string };
          };
          if (Array.isArray(request.passages)) {
            if (/<KNOWN_ENTITY_IDENTITY_REVIEW>/u.test(prompt)) {
              reviewAttempts += 1;
              assert.match(prompt, /已知姓名不是登场邀请/u);
              assert.match(prompt, /再按本段年份核对人物的时间资格/u);
              assert.match(prompt, /白鲸杂志社社长/u);
              throw new Error('optional entity review transport failed');
            }
            return JSON.stringify({
              schema: 'eyon.biography.passage.batch.v1',
              requestId,
              passages: request.passages.map(block => block.passageId === 'status'
                ? borrowedStatus
                : makePassage(
                  biography,
                  block.passageId,
                  block.kind as 'origin' | 'stage' | 'status',
                )),
            });
          }
          if (request.passage?.passageId === 'status') {
            return JSON.stringify(borrowedStatus);
          }
          assert.ok(request.passage);
          return JSON.stringify(makePassage(
            biography,
            request.passage.passageId,
            request.passage.kind as 'origin' | 'stage' | 'status',
          ));
        },
      },
      shell: {
        async readAssistantMessage() { return ''; },
        async writeAssistantMessage() {},
        async refreshAssistantMessage() {},
      },
      repository,
      rules: {
        sharedContext: '共享上下文',
        retrievalContract: '检索契约',
        validationContract: '校验契约',
        generationContract: '传记生成契约',
      },
      async getScope() { return { namespace, triggerMessageId: 42 }; },
      createRequestId() { return requestId; },
      createStagePlan() { return makeStagePlan(biography); },
      async resolveEvidence(names) {
        return names.includes('伊莲娜·A·梦露') ? [ilenaSource] : [];
      },
      now() { return 1000; },
    });

    const preparation = await workflow.prepare(command);
    assert.equal(reviewAttempts, 1);
    assert.match(preparation.rootTrace, /年轻实习生伊莲娜·A·梦露/u);
    assert.equal((await repository.list(namespace)).length, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('阶段 stalled/driver 容错：字符串布尔与中文推进者被归一化', () => {
  const biography = structuredClone(makeBiography());
  biography.stages[0] = {
    ...biography.stages[0]!,
    stalled: 'true' as unknown as boolean,
    driver: '玩家' as unknown as 'player' | 'world',
  };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive,
    context: makeContext(),
    stagePlan: makeStagePlan(biography),
  });
  assert.equal(parsed.stages[0]!.stalled, true);
  assert.equal(parsed.stages[0]!.driver, 'player');
});

test('成稿 sourceRef 残缺时按唯一编号自动修正', () => {
  const biography = structuredClone(makeBiography());
  const context = makeContext();
  context.sourceIndex = [
    ...context.sourceIndex,
    {
      sourceId: 'worldbook:帝国史:693201',
      sourceType: 'worldbook',
      title: '帝国史',
      content: '维奥莱塔相关记载',
      authority: 100,
    },
  ];
  biography.origin = { ...biography.origin, sourceRefs: ['worldbook:693201'] };
  const parsed = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive,
    context,
    stagePlan: makeStagePlan(biography),
  });
  assert.deepEqual(parsed.origin.sourceRefs, ['worldbook:帝国史:693201']);
});

test('批次响应截断时降级为逐块生成，任务仍能完成', async () => {  const biography = makeBiography();
  const context = makeContext();
  // 本用例只验证常规批次截断后的逐块降级；直接人物条目会主动采用逐块生成，
  // 因而需要从夹具中移除，避免绕过这里刻意制造的批次失败。
  context.evidenceBundle.taskAnchorAttachments = [];
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);

  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        if (/eyon\.biography\.plan\.v1/u.test(prompt)) {
          return JSON.stringify(makePlan(biography));
        }
        if (/eyon\.biography\.passage\.batch\.request\.v1/u.test(prompt)) {
          // 批次请求截断（max_tokens 顶格无法翻倍时的典型失败）
          throw new Error('API response was truncated (incomplete JSON object)');
        }
        // 单块请求：按 passageId 返回对应单块
        // Active Evidence 里也可能出现 passageId；真正待生成块位于后方 request_data，
        // 因此取最后一个 JSON passageId，而不是误取证据 passage 的标识。
        const id = [...prompt.matchAll(/"passageId":"([^"]+)"/gu)].at(-1)?.[1] ?? '';
        if (id === 'origin') return JSON.stringify(makePassage(biography, 'origin', 'origin'));
        if (id === 'status') return JSON.stringify(makePassage(biography, 'status', 'status'));
        return JSON.stringify(makePassage(biography, id, 'stage'));
      },
    },
    shell: {
      async readAssistantMessage() { return ''; },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() { return { namespace, triggerMessageId: 42 }; },
    createRequestId() { return requestId; },
    createStagePlan() { return makeStagePlan(biography); },
    now() { return 1000; },
  });

  const preparation = await workflow.prepare(command);
  // 全部 7 块（origin + 5 stages + status）都经单块路径生成成功
  assert.ok(preparation.rootTrace.includes('起源(二十四岁)'));
  assert.equal((await repository.list(namespace)).length, 1);
});

test('单块响应数组元素对象化/数字化时被容错吸收（不报 PASSAGE_SCHEMA_INVALID）', () => {
  const biography = makeBiography();
  const passage = makePassage(biography, 'stage-1', 'stage');
  const raw = JSON.parse(JSON.stringify(passage)) as Record<string, unknown>;
  raw.people = [{ name: '维奥莱塔' }, '铁血女皇'];
  raw.factions = [{ 名称: '奥古斯提姆帝国' }];
  raw.objects = [1, '王冠'];
  const validated = parseAndValidateBiographyPassage(JSON.stringify(raw), {
    requestId,
    passageId: 'stage-1',
    kind: 'stage',
    eventId: passage.eventId,
    eventUsage: passage.eventUsage,
    knownSources: new Set(biography.stages[0]!.sourceRefs),
  });
  // 带 name 的对象提取名称、无 name 的对象与数字丢弃
  assert.deepEqual(validated.people, ['维奥莱塔', '铁血女皇']);
  assert.deepEqual(validated.factions, []);
  assert.deepEqual(validated.objects, ['王冠']);
});

test('单块响应结构漂移被容错吸收：过渡字段/多余字段被忽略、布尔字符串化', () => {
  const biography = makeBiography();
  const passage = makePassage(biography, 'stage-1', 'stage');
  const raw = JSON.parse(JSON.stringify(passage)) as Record<string, unknown>;
  raw.transitionFromPrevious = null; // 已被移除的字段：忽略，不报错
  raw.inference = 'true';
  raw.elementChecklist = {
    sceneGrounded: 'true',
    figureVivid: '是',
    decisiveMoment: 1,
  };
  raw.span = '多余字段'; // strictObject 时代会 unrecognized_keys，现被忽略
  const validated = parseAndValidateBiographyPassage(JSON.stringify(raw), {
    requestId,
    passageId: 'stage-1',
    kind: 'stage',
    eventId: passage.eventId,
    eventUsage: passage.eventUsage,
    knownSources: new Set(biography.stages[0]!.sourceRefs),
  });
  // 布尔字符串/数字收窄为 boolean
  assert.equal(validated.inference, true);
  assert.equal(validated.elementChecklist.sceneGrounded, true);
  assert.equal(validated.elementChecklist.figureVivid, true);
  assert.equal(validated.elementChecklist.decisiveMoment, true);
  // transitionFromPrevious 已从结果中整组移除
  assert.equal((validated as unknown as Record<string, unknown>).transitionFromPrevious, undefined);
  // 字符串化 false 保留诚实软自评，不为了文学评分拒收正文。
  raw.elementChecklist = {
    sceneGrounded: 'true',
    figureVivid: '是',
    decisiveMoment: '否',
  };
  const withFalse = parseAndValidateBiographyPassage(JSON.stringify(raw), {
      requestId,
      passageId: 'stage-1',
      kind: 'stage',
      eventId: passage.eventId,
      eventUsage: passage.eventUsage,
      knownSources: new Set(biography.stages[0]!.sourceRefs),
  });
  assert.equal(withFalse.elementChecklist.decisiveMoment, false);
  assert.equal(withFalse.content, passage.content);
});

// ===== internal.79 v4 止血：repair 报错文本剥离 legacy 源 ID（G-07 最小止血）=====

test('repair 报错文本消毒：legacy worldbook ID 被剥离，不再回显给模型（防自激循环）', () => {
  const error = 'Passage unknown source reference: worldbook:命定之诗与黄昏之歌v4.2:264039（幻觉 ID 伴生）';
  const sanitized = sanitizeRepairErrorText(error);
  assert.ok(!sanitized.includes('264039'), `legacy ID 数字不应回显，实际 ${sanitized}`);
  assert.ok(!sanitized.includes('worldbook:命定之诗'), 'worldbook 前缀+书名不应回显');
  assert.ok(sanitized.includes('[source-id-hidden]'), '应替换为占位标记');
  assert.ok(sanitized.includes('幻觉 ID 伴生'), '错误文本其余部分原样保留');

  const plain = sanitizeRepairErrorText('The previous response was rejected: node id duplicated');
  assert.equal(plain, 'The previous response was rejected: node id duplicated', '无 legacy ID 的文本原样保留');
});

test('三处传记 repair 提示不再回显 legacy 源 ID', () => {
  // 三处 repair（plan/passage/batch）均经 sanitizeRepairErrorText 消毒，
  // 这里用多形态用例覆盖消毒器本身（函数级装配需要完整 fixture，源码三处调用已确认）。
  const cases: Array<[string, string]> = [
    ['Passage unknown source reference: worldbook:命定之诗与黄昏之歌v4.2:264039', 'no book id'],
    ['延续 worldbook:foo:12345 中段的错误', 'no inline id'],
    ['前后都有 [source-id-hidden]（合法允许列表）', 'keep short handles'],
  ];
  for (const [inputText] of cases) {
    const out = sanitizeRepairErrorText(inputText);
    assert.ok(!/worldbook:[\u4e00-\u9fff\w%:.\-·]+:\d{3,}/u.test(out), `应剥离 legacy ID：${inputText} → ${out}`);
  }
  assert.equal(sanitizeRepairErrorText('short handle S1 rejected'), 'short handle S1 rejected', '短句柄保留');
  assert.equal(sanitizeRepairErrorText('plain node id duplicated'), 'plain node id duplicated', '普通文本保留');
});

// ===== internal.79 v7：智能年龄提取 + 目标出生年回填 =====

test('智能年龄提取：双轨取实际、修饰剔除、歧义不猜', () => {
  assert.equal(extractRecordedAge('外貌16岁 (实际28岁)'), 28, '双轨卡取实际年龄');
  assert.equal(extractRecordedAge('年龄: 27岁'), 27, '普通年龄照常提取');
  assert.equal(extractRecordedAge('27岁'), 27, '裸数字照常提取');
  assert.equal(extractRecordedAge('外貌16岁'), undefined, '仅有外貌年龄不猜实际');
  assert.equal(extractRecordedAge('心理年龄25岁'), undefined, '心理年龄不提取');
  assert.equal(extractRecordedAge('约20岁'), undefined, '模糊表述不提取');
  assert.equal(extractRecordedAge('活了三千年的精灵'), undefined, '特殊年龄体系不提取');
});

test('目标出生年回填：从起源标题确定性提取，后续段落年龄有锚', () => {
  const withTitle: BiographyPlan = {
    originTitle: '起源(复兴纪元460年)',
  } as unknown as BiographyPlan;
  const bornTitle = extractTargetBornYear(withTitle);
  assert.equal(bornTitle?.era, '复兴纪元');
  assert.equal(bornTitle?.year, 460);

  const withChineseTitle: BiographyPlan = {
    originTitle: '起源(复兴纪元四六〇年)',
  } as unknown as BiographyPlan;
  const bornChinese = extractTargetBornYear(withChineseTitle);
  assert.equal(bornChinese?.year, 460, '中文数字年份兜底');

  const none: BiographyPlan = {
    originTitle: '起源(不详)',
  } as unknown as BiographyPlan;
  assert.equal(extractTargetBornYear(none), null, '无出生信息不推断');
});

test('目标年龄锚：只接受人物事实时间轴，绝不把规划起源反写成出生年', () => {
  const knownTarget = {
    target: { type: 'person', name: '玲山·哈姆斯沃思' },
    originTitle: '起源(复兴纪元469年)',
  } as unknown as BiographyPlan;
  assert.deepEqual(
    resolveTargetBornYear(knownTarget, [{
      name: '玲山·哈姆斯沃思',
      state: 'unknown',
      narrative: '出生于复兴纪元461年',
      lifespan: { born: { era: '复兴纪元', year: 461 } },
    }]),
    { era: '复兴纪元', year: 461, source: 'person-timeline' },
  );

  const unknownTarget = {
    target: { type: 'person', name: '原创人物' },
    originTitle: '起源(复兴纪元469年)',
  } as unknown as BiographyPlan;
  assert.equal(resolveTargetBornYear(unknownTarget), null, '未知人物不从规划起源猜出生年');

  const placeTarget = {
    target: { type: 'region', name: '黄昏花室' },
    originTitle: '起源(复兴纪元320年)',
  } as unknown as BiographyPlan;
  assert.equal(resolveTargetBornYear(placeTarget), null, '非人物对象不生成出生年龄锚');
});

test('真实传记装配统一事实寿命、软自评与篇幅，单段和批量不再互相矛盾', () => {
  const biography = makeBiography();
  const rules = {
    sharedContext: '', retrievalContract: '', validationContract: '',
    generationContract: readFileSync(new URL('../rules/13_寻根溯源生成规则-API.txt', import.meta.url), 'utf8'),
  };
  const planning = buildBiographyPlanPrompt({
    requestId, directive: biography.playerDirective.raw, context: makeContext(),
    rules, stagePlan: makeStagePlan(biography),
  });
  assert.match(planning, /所有种族.*明确的出生、死亡/u);
  assert.match(planning, /历史赎出后的原历史缺席/u);
  assert.match(planning, /本段年份 − 出生年/u);
  assert.doesNotMatch(planning, /允许跨任意时期|出生年 \+ \(本段年份/u);
  const plan = makePlan(biography);
  const passage = {
    passageId: 'origin', kind: 'origin' as const, title: plan.originTitle,
    sourceRefs: [sourceId], eventAssignment: plan.eventAssignments[0]!,
  };
  const single = buildBiographyPassagePrompt({ requestId, plan, passage, rules });
  const batch = buildBiographyPassageBatchPrompt({ requestId, plan, passages: [passage], rules });
  for (const prompt of [single, batch]) {
    assert.match(prompt, /允许 false|允许false/u);
    assert.match(prompt, /260~329.*同样有效/u);
    assert.match(prompt, /不必硬造转折/u);
    assert.doesNotMatch(prompt, /全部为 true 才可提交|必须全部为 true|少于 300 视为无效/u);
    assert.match(prompt, /eventId.*eventUsage/u, '事件归属协议仍保留');
  }
});

test('传记规划与扩写都把 revision 物品状态作为按时间生效的连续性事实，并保持 fail-soft', () => {
  const biography = makeBiography();
  const context = makeContext();
  const rules = {
    sharedContext: 'shared',
    retrievalContract: 'retrieval',
    validationContract: 'validation',
    generationContract: 'generation',
  };
  const planningPrompt = buildBiographyPlanPrompt({
    requestId,
    directive: biography.playerDirective.raw,
    context,
    rules,
    stagePlan: makeStagePlan(biography),
  });
  assert.match(planningPrompt, /REVISION_OBJECT_STATE_CONTINUITY/u);
  assert.match(planningPrompt, /同一原件无解释地完好出现/u);
  assert.match(planningPrompt, /部件、功能动作、代词和新产出物/u);
  assert.match(planningPrompt, /残片、伤痕、旧照片、回忆与既存记录不等于原件复活/u);
  assert.match(planningPrompt, /不得把同一句或相邻句中另一件物品的损毁状态串到本物品/u);
  assert.match(planningPrompt, /不得仅因无法精确判定物品状态而报错或中断/u);

  const plan = makePlan(biography);
  const passagePrompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: {
      passageId: 'origin',
      kind: 'origin',
      title: plan.originTitle,
      sourceRefs: [sourceId],
      eventAssignment: plan.eventAssignments[0]!,
    },
    rules,
  });
  assert.match(passagePrompt, /CANON_CURRENT_VIEW 的当前有效 revision 事实/u);
  assert.match(passagePrompt, /同名复制品、替代品或重制品/u);
  assert.match(passagePrompt, /部件、功能动作、代词和新产出物/u);
});
