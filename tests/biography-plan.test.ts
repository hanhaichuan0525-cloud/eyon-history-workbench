import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyContextBundle, ContextSource } from '../src/core/context.ts';
import type { BiographyStagePlan } from '../src/runtime/biographyDiceCore.ts';
import type { BiographyPlan } from '../src/schemas/biography.ts';
import {
  buildBiographyContinuityJudgePrompt,
  buildBiographyPassageBatchPrompt,
  buildBiographyPassagePrompt,
  buildBiographyPlanPrompt,
} from '../src/prompts/biography.ts';
import { buildActiveEvidenceView } from '../src/prompts/activeEvidence.ts';
import {
  BiographyValidationError,
  parseAndValidateBiographyPlan,
} from '../src/validators/biography.ts';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  RETRIEVAL_RECEIPT_SCHEMA,
  SOURCE_SNAPSHOT_SCHEMA,
  type EvidenceBundle,
} from '../src/retrieval/contracts.ts';

const requestId = 'bio-plan-001';
const sourceId = 'worldbook:维奥莱塔';
const directive = '对维奥莱塔进行寻根溯源';

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

function makeContext(): BiographyContextBundle {
  const source = { sourceId, sourceType: 'worldbook' as const, title: '维奥莱塔', content: '奥古斯提姆帝国女皇', authority: 100 };
  return {
    schema: 'eyon.context.v1',
    taskType: 'biography',
    requestId,
    scope: { characterKey: '命定之诗', chatId: '存档', triggerMessageId: 1 },
    currentWorld: { time: '复兴纪元488年', location: '奥古斯提姆帝国' },
    worldbookContext: [],
    recentContext: [],
    characterContext: [],
    genealogyContext: [],
    biographyRefs: [],
    butterflyRefs: [],
    sourceIndex: [source],
    evidenceBundle: makeEvidenceBundle([source]),
    warnings: [],
    sourceHash: 'hash',
  };
}

function makeStagePlan(): BiographyStagePlan {
  return {
    count: 5,
    stages: [
      { id: 'stage-1', type: 'stable', diceMaterial: 'a｜a｜a' },
      { id: 'stage-2', type: 'turbulent', diceMaterial: 'b｜b｜b' },
      { id: 'stage-3', type: 'transition', diceMaterial: 'c｜c｜c' },
      { id: 'stage-4', type: 'stable', diceMaterial: 'd｜d｜d' },
      { id: 'stage-5', type: 'transition', diceMaterial: 'e｜e｜e' },
    ],
  };
}

function makePlan(): BiographyPlan {
  return {
    schema: 'eyon.biography.plan.v1',
    requestId,
    playerDirective: {
      raw: directive,
      interpretedTarget: '维奥莱塔',
      hardTimeScope: '',
      primaryDirection: '猎艳史',
      secondaryInterests: [],
      reconciliation: '',
    },
    target: { type: 'person', name: '维奥莱塔', aliases: [], sourceRefs: [sourceId] },
    subjectAnchor: '她与奥古斯提姆帝国的权贵关系网绑定',
    changeAxis: '年龄与身份的变化',
    meaningCarrier: '她的选择与行动如何改变周围',
    dramaticQuestion: '她如何在身份与欲望之间活出自己',
    dominantAxis: 'dramaticQuestion',
    span: {
      mode: 'age',
      start: { year: null, month: null, day: null, age: 24 },
      end: { year: null, month: null, day: null, age: 28 },
      label: '24岁至28岁',
    },
    originTitle: '起源(二十四岁)',
    statusTitle: '现状(二十八岁)',
    eventAssignments: ['origin', ...makeStagePlan().stages.map(stage => stage.id), 'status'].map((passageId, index) => ({
      passageId,
      eventId: `invented:${passageId}:fixture-${index + 1}`,
      summary: [
        '在北门雨夜拒绝权贵递来的秘密契约',
        '于旧剧院后台救下一名受伤的信使',
        '拆穿港口仓库里被调包的盐税账册',
        '在冬猎宴席上主动终止一桩政治婚约',
        '协助工坊女匠夺回被侵占的发明署名',
        '从洪水中的钟楼取回失落的家族印章',
        '现今主持公开听证并重订报社守则',
      ][index]!,
      usage: 'occurs' as const,
      sourceRefs: [sourceId],
    })),
    stages: makeStagePlan().stages.map((stage, index) => ({
      ...stage,
      title: `第${index + 1}时期`,
      span: {
        start: { year: null, month: null, day: null, hour: null, age: 24 + index },
        end: { year: null, month: null, day: null, hour: null, age: 25 + index },
      },
      theme: `主题${index + 1}`,
      introduced: [`新面孔${index + 1}`],
      sourceRefs: [sourceId],
    })),
    summary: '这是一段关于欲望与责任逐步成形的传记。',
    indexes: { people: [], factions: [], objects: [], locations: [], themes: [], potentialRuinLinks: [] },
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

test('合法规划通过校验', () => {
  const plan = parseAndValidateBiographyPlan(JSON.stringify(makePlan()), {
    requestId,
    directive,
    stagePlan: makeStagePlan(),
    context: makeContext(),
  });
  assert.equal(plan.subjectAnchor, directive);
  assert.equal(plan.stages.length, 5);
});

test('最小规划无需派生玩家指令、四性质、索引或质量自评', () => {
  const raw = JSON.parse(JSON.stringify(makePlan())) as Record<string, unknown>;
  for (const key of [
    'playerDirective',
    'subjectAnchor',
    'changeAxis',
    'meaningCarrier',
    'dramaticQuestion',
    'dominantAxis',
    'indexes',
    'qualityChecks',
  ]) delete raw[key];
  const plan = parseAndValidateBiographyPlan(JSON.stringify(raw), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(plan.playerDirective.raw, directive);
  assert.deepEqual(plan.indexes.people, []);
});

test('同一传记事件不能换时间槽再次发生，但可作为后果被引用', () => {
  const plan = makePlan();
  const origin = plan.eventAssignments.find(item => item.passageId === 'origin')!;
  const stage = plan.eventAssignments.find(item => item.passageId === 'stage-1')!;
  stage.eventId = origin.eventId;
  stage.summary = origin.summary;
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    (error: unknown) => error instanceof BiographyValidationError && error.code === 'PLAN_EVENT_REUSED',
  );

  stage.usage = 'aftermath';
  assert.doesNotThrow(() => parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  }));
});

test('不同 eventId 的自然语言摘要相近时不以碎词相似度误杀', () => {
  const plan = makePlan();
  const origin = plan.eventAssignments.find(item => item.passageId === 'origin')!;
  const stage = plan.eventAssignments.find(item => item.passageId === 'stage-1')!;
  origin.summary = '复兴纪元469年祭司宣布铃羽被女神选中前往无尽地城守卫';
  stage.summary = '复兴纪元472年祭司宣布铃羽被女神选中前往无尽地城担任守卫';
  assert.doesNotThrow(() => parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  }));
});

test('旧四性质字段不再参与语义校验，兼容值由玩家原话确定性生成', () => {
  const plan = makePlan();
  plan.subjectAnchor = '太短';
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(parsed.subjectAnchor, directive);
  assert.equal(parsed.playerDirective.raw, directive);
});

test('阶段数量与 stagePlan 不符报 PLAN_STAGE_COUNT_MISMATCH', () => {
  const plan = makePlan();
  const stagePlan = {
    ...makeStagePlan(),
    count: 6,
    stages: [
      ...makeStagePlan().stages,
      { id: 'stage-6', type: 'stable' as const, diceMaterial: 'f｜f｜f' },
    ],
  };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan, context: makeContext(),
    }),
    /stage count mismatch/u,
  );
});

test('阶段 id/type 与 stagePlan 不符报 PLAN_STAGE_MISMATCH', () => {
  const plan = makePlan();
  plan.stages[0] = { ...plan.stages[0], type: 'turbulent' };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    /does not match locked stage plan/u,
  );
});

test('编造 sourceId 报 PLAN_SOURCE_NOT_FOUND', () => {
  const plan = makePlan();
  plan.sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    /unknown source reference/u,
  );
});

test('阶段时间过于粗略（无年/岁锚点）报 PLAN_SPAN_TOO_VAGUE', () => {
  const plan = makePlan();
  plan.stages[1] = {
    ...plan.stages[1]!,
    span: {
      start: { year: null, month: 3, day: null, hour: null, age: null },
      end: { year: null, month: null, day: null, hour: null, age: null },
    },
  };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    /too vague/u,
  );
});

test('相邻阶段时间倒置报 PLAN_SPAN_INVERSION', () => {
  const plan = makePlan();
  plan.stages[1] = {
    ...plan.stages[1]!,
    span: {
      start: { year: 400, month: null, day: null, hour: null, age: null },
      end: { year: 410, month: null, day: null, hour: null, age: null },
    },
  };
  plan.stages[2] = {
    ...plan.stages[2]!,
    span: {
      start: { year: 405, month: null, day: null, hour: null, age: null },
      end: { year: 420, month: null, day: null, hour: null, age: null },
    },
  };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    /chronological/u,
  );
});

test('跨不同纪元的相邻段不做倒置比较（纪元基准不同）', () => {
  const plan = makePlan();
  plan.stages[1] = {
    ...plan.stages[1]!,
    span: {
      start: { year: 300, month: null, day: null, hour: null, age: null, era: '复兴纪元' },
      end: { year: 310, month: null, day: null, hour: null, age: null, era: '复兴纪元' },
    },
  };
  plan.stages[2] = {
    ...plan.stages[2]!,
    span: {
      start: { year: 1, month: null, day: null, hour: null, age: null, era: '新纪元' },
      end: { year: 10, month: null, day: null, hour: null, age: null, era: '新纪元' },
    },
  };
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(parsed.stages.length, 5);
});

test('已知纪元顺序可识别跨纪元的阶段倒置', () => {
  const plan = makePlan();
  plan.span = {
    mode: 'calendar',
    start: { era: '英雄纪元', year: 1, month: null, day: null, hour: null, age: null },
    end: { era: '复兴纪元', year: 500, month: null, day: null, hour: null, age: null },
    label: '英雄纪元1年至复兴纪元500年',
  };
  plan.stages[1] = {
    ...plan.stages[1]!,
    span: {
      start: { era: '复兴纪元', year: 300, month: null, day: null, hour: null, age: null },
      end: { era: '复兴纪元', year: 310, month: null, day: null, hour: null, age: null },
    },
  };
  plan.stages[2] = {
    ...plan.stages[2]!,
    span: {
      start: { era: '英雄纪元', year: 1, month: null, day: null, hour: null, age: null },
      end: { era: '英雄纪元', year: 10, month: null, day: null, hour: null, age: null },
    },
  };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLAN_SPAN_INVERSION',
  );
});

test('日历段超出传记顶层总跨度时进入规划修复', () => {
  const plan = makePlan();
  plan.span = {
    mode: 'calendar',
    start: { era: '复兴纪元', year: 400, month: null, day: null, hour: null, age: null },
    end: { era: '复兴纪元', year: 500, month: null, day: null, hour: null, age: null },
    label: '复兴纪元400年至500年',
  };
  plan.stages[0] = {
    ...plan.stages[0]!,
    span: {
      start: { era: '复兴纪元', year: 390, month: null, day: null, hour: null, age: null },
      end: { era: '复兴纪元', year: 410, month: null, day: null, hour: null, age: null },
    },
  };
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PLAN_STAGE_OUTSIDE_OVERALL_SPAN',
  );
});

test('全篇零新面孔的规划仍通过（选角自适应，不机械要求新面孔）', () => {
  const plan = makePlan();
  plan.stages = plan.stages.map(stage => ({ ...stage, introduced: [] }));
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(parsed.stages.length, 5);
});

test('缺字段鲁棒：起止时间允许缺失月/日/时，不影响通过', () => {
  const plan = makePlan();
  plan.stages[0] = {
    ...plan.stages[0]!,
    span: {
      start: { year: 400, month: null, day: null, hour: null, age: null },
      end: { year: 410, month: null, day: null, hour: null, age: null },
    },
  };
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(parsed.stages[0]!.span.start.year, 400);
});

test('废弃的规划 indexes 不再由模型控制，脚本确定性置空', () => {
  const plan = makePlan();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  raw.indexes = {
    ...(raw.indexes as Record<string, unknown>),
    people: [{ name: '维奥莱塔' }],
    factions: [42],
  };
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(raw), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.deepEqual(parsed.indexes.people, []);
  assert.deepEqual(parsed.indexes.factions, []);
});

test('规划响应的 span.label 缺失或为 null 时不再报错（标签由脚本渲染）', () => {
  const plan = makePlan();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const span = raw.span as Record<string, unknown>;
  span.label = null;
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(raw), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  assert.equal(parsed.span.label, '');
});

test('目标 type 仍容错，废弃的模型 qualityChecks 不再被信任', () => {
  const plan = makePlan();
  const raw = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const target = raw.target as Record<string, unknown>;
  target.type = '器官';
  const checks = raw.qualityChecks as Record<string, unknown>;
  checks.playerDirectionFulfilled = 'true';
  checks.hardTimeScopeRespected = '否';
  (raw as Record<string, unknown>).content = '多余字段'; // 非契约字段，被忽略
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(raw), {
    requestId, directive, stagePlan: makeStagePlan(), context: makeContext(),
  });
  // 中文类型名映射到枚举（器官 → organ）
  assert.equal(parsed.target.type, 'organ');
  // 模型自报的通过不进入权威结果
  assert.equal(parsed.qualityChecks.playerDirectionFulfilled, false);
  assert.equal(parsed.qualityChecks.hardTimeScopeRespected, false);
});

test('残缺 sourceRef（丢前缀段）按唯一编号自动修正', () => {
  const plan = makePlan();
  plan.sourceRefs = ['worldbook:693201'];
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
  const parsed = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId, directive, stagePlan: makeStagePlan(), context,
  });
  assert.deepEqual(parsed.sourceRefs, ['worldbook:帝国史:693201']);
});

test('残缺 sourceRef 编号不唯一时不修正并报 PLAN_SOURCE_NOT_FOUND', () => {
  const plan = makePlan();
  plan.sourceRefs = ['worldbook:7'];
  const context = makeContext();
  context.sourceIndex = [
    ...context.sourceIndex,
    {
      sourceId: 'worldbook:甲:7',
      sourceType: 'worldbook',
      title: '甲',
      content: '内容一',
      authority: 100,
    },
    {
      sourceId: 'worldbook:乙:7',
      sourceType: 'worldbook',
      title: '乙',
      content: '内容二',
      authority: 100,
    },
  ];
  assert.throws(
    () => parseAndValidateBiographyPlan(JSON.stringify(plan), {
      requestId, directive, stagePlan: makeStagePlan(), context,
    }),
    /unknown source reference/u,
  );
});

test('规划、扩写与批量复核区分资料用途，混合核心不包装成历史身份证', () => {
  const rules = { sharedContext: '伊雍讲述规则与契约约束仍保留', retrievalContract: '',
    validationContract: '', generationContract: '生成契约' };
  const core: ContextSource = { sourceId: 'worldbook:mechanism', sourceType: 'worldbook',
    title: '伊雍核心', content: '工作台操作说明：命定契约原文完整保留。', authority: 100 };
  const plan = makePlan();
  const passage = { passageId: 'stage-1', kind: 'stage' as const, title: '片段',
    sourceRefs: [sourceId], eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-1')! };
  const ordinary = [
    buildBiographyPlanPrompt({ requestId, directive, context: makeContext(), rules, stagePlan: makeStagePlan() }),
    buildBiographyPassagePrompt({ requestId, plan, passage, rules, evidence: [core] }),
    buildBiographyPassageBatchPrompt({ requestId, plan, passages: [passage], rules, evidence: [core] }),
  ];
  for (const prompt of ordinary) {
    assert.match(prompt, /<BIOGRAPHY_SOURCE_PURPOSE>/u);
    assert.match(prompt, /规划或首稿造出的名称只触发查证/u);
    assert.match(prompt, /补查到同名条目并不证明/u);
    assert.doesNotMatch(prompt, /工作台操作说明：命定契约原文完整保留/u);
  }
  assert.match(ordinary[0]!, /伊雍讲述规则与契约约束仍保留/u);
  plan.playerDirective.raw = '对伊雍核心进行寻根溯源';
  const explicit = buildBiographyPassageBatchPrompt({ requestId, plan, passages: [passage], rules, evidence: [core] });
  assert.match(explicit, /伊雍核心｜机制与设定参考，不作历史身份证/u);
  assert.match(explicit, /工作台操作说明：命定契约原文完整保留/u);
  assert.match(explicit, /所有命定系统的核心机制/u);
  assert.match(explicit, /不可把任何系统核心无据实体化/u);
});

test('规划提示词只注入一份上下文（sourceIndex 权威清单，分组数组置空）', () => {
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive,
    context: makeContext(),
    rules: {
      sharedContext: '共享规则',
      retrievalContract: '',
      validationContract: '',
      generationContract: '生成契约',
    },
    stagePlan: makeStagePlan(),
  });
  // 条目文本只出现一次（sourceIndex 内），不再随分组数组重复注入。
  const snippet = '奥古斯提姆帝国女皇';
  assert.equal((prompt.match(new RegExp(snippet, 'gu')) ?? []).length, 1);
  assert.match(prompt, /"worldbookContext":\[\]/u);
  assert.match(prompt, /"recentContext":\[\]/u);
  assert.match(prompt, /"sourceIndex":\[/u);
  // 脚本契约（检索/校验）不再注入模型提示词；世界观与生成规则保留。
  assert.doesNotMatch(prompt, /<retrieval_contract>/u);
  assert.doesNotMatch(prompt, /<validation_contract>/u);
  assert.match(prompt, /<shared_context>/u);
  assert.match(prompt, /<generation_contract>/u);
});

test('当前场景指示语或末端具名对象把同一条 MVU 地点链注入规划与扩写', () => {
  const currentDirective = '伊雍，对这皇宫中的黄昏花室进行寻根溯源，要求写它的建筑史';
  const currentLocation = '奥古斯提姆帝国-艾瑟嘉德-皇宫-黄昏花室';
  const context = makeContext();
  context.currentWorld.location = currentLocation;
  context.currentSceneSnapshot = {
    location: currentLocation,
    evidence: [{
      sourceId: 'recent:41',
      title: '当前正文',
      content: '维奥莱塔女皇回到作为私人寝宫的黄昏花室，海因里希守在门外。',
    }],
  };
  const rules = { sharedContext: '共享规则', retrievalContract: '', validationContract: '', generationContract: '生成契约' };
  const planPrompt = buildBiographyPlanPrompt({
    requestId,
    directive: currentDirective,
    context,
    rules,
    stagePlan: makeStagePlan(),
  });
  assert.match(planPrompt, /<CURRENT_SCENE_REFERENCE>/u);
  assert.match(planPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(planPrompt, /作为私人寝宫/u);
  assert.match(planPrompt, new RegExp(currentLocation, 'u'));
  assert.match(planPrompt, /不能替换对象的父级地点/u);

  const plan = makePlan();
  plan.playerDirective.raw = currentDirective;
  plan.target.name = '黄昏花室';
  const passage = {
    passageId: 'stage-1',
    kind: 'stage' as const,
    title: '花室初建',
    sourceRefs: [sourceId],
    eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-1')!,
  };
  const singlePrompt = buildBiographyPassagePrompt({
    requestId, plan, passage, rules, currentSceneLocation: currentLocation,
  });
  const batchPrompt = buildBiographyPassageBatchPrompt({
    requestId, plan, passages: [passage], rules, currentSceneLocation: currentLocation,
  });
  assert.match(singlePrompt, /<CURRENT_SCENE_REFERENCE>/u);
  assert.match(batchPrompt, /<CURRENT_SCENE_REFERENCE>/u);
  assert.doesNotMatch(singlePrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.doesNotMatch(batchPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(singlePrompt, /不得新造具名皇帝\/皇后与皇室谱系/u);
  assert.match(singlePrompt, new RegExp(currentLocation, 'u'));
  assert.match(batchPrompt, new RegExp(currentLocation, 'u'));

  const finalStage = plan.stages.at(-1)!;
  const finalHistoryPassage = {
    passageId: finalStage.id,
    kind: 'stage' as const,
    title: finalStage.title,
    span: '最后历史阶段',
    theme: finalStage.theme,
    diceMaterial: finalStage.diceMaterial,
    sourceRefs: finalStage.sourceRefs,
    eventAssignment: plan.eventAssignments.find(item => item.passageId === finalStage.id)!,
  };
  const finalHistoryPrompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: finalHistoryPassage,
    rules,
    currentSceneLocation: currentLocation,
    currentSceneSnapshot: context.currentSceneSnapshot,
  });
  const finalHistoryBatchPrompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan,
    passages: [passage, finalHistoryPassage],
    rules,
    currentSceneLocation: currentLocation,
    currentSceneSnapshot: context.currentSceneSnapshot,
  });
  assert.match(finalHistoryPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(finalHistoryPrompt, /现状前最后一个历史阶段/u);
  assert.match(finalHistoryPrompt, /最近一步、决定或可见前兆/u);
  assert.match(finalHistoryBatchPrompt, new RegExp(`同批更早的 passageId=${passage.passageId}`, 'u'));
  assert.match(finalHistoryBatchPrompt, /不得使用这份当代快照决定其时代的用途、归属或居住者/u);

  const statusPassage = {
    passageId: 'status',
    kind: 'status' as const,
    title: '现状',
    sourceRefs: [sourceId],
    eventAssignment: plan.eventAssignments.find(item => item.passageId === 'status')!,
  };
  const statusPrompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: statusPassage,
    rules,
    currentSceneLocation: currentLocation,
    currentSceneSnapshot: context.currentSceneSnapshot,
  });
  const statusBatchPrompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan,
    passages: [statusPassage],
    rules,
    currentSceneLocation: currentLocation,
    currentSceneSnapshot: context.currentSceneSnapshot,
  });
  assert.match(statusPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(statusBatchPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(statusBatchPrompt, /作为私人寝宫/u);
  assert.match(statusPrompt, /保持同等事实强度/u);
  assert.match(statusPrompt, /不得擅自降格成附属区/u);

  const ordinaryPrompt = buildBiographyPlanPrompt({
    requestId,
    directive: '对黄昏花室进行寻根溯源',
    context,
    rules,
    stagePlan: makeStagePlan(),
  });
  assert.match(ordinaryPrompt, /<CURRENT_SCENE_REFERENCE>/u);
  assert.match(ordinaryPrompt, /当前正文只直接证明对象在“现在”/u);
});

test('开放对象保留完整自然语言边界，集合与行业不被压成同一关键词', () => {
  const context = makeContext();
  context.currentWorld.location = '奥古斯提姆帝国-艾瑟嘉德-皇宫-黄昏花室';
  const rules = { sharedContext: '共享规则', retrievalContract: '', validationContract: '', generationContract: '生成契约' };
  const allCovers = buildBiographyPlanPrompt({
    requestId,
    directive: '对艾瑟嘉德的所有井盖进行寻根溯源',
    context,
    rules,
    stagePlan: makeStagePlan(),
  });
  const industry = buildBiographyPlanPrompt({
    requestId,
    directive: '对艾瑟嘉德的井盖业进行寻根溯源',
    context,
    rules,
    stagePlan: makeStagePlan(),
  });

  for (const prompt of [allCovers, industry]) {
    assert.match(prompt, /<TASK_SUBJECT_BOUNDARY>/u);
    assert.match(prompt, /不得因缺少专门条目而输出 TARGET_NOT_FOUND 或中断生成/u);
    assert.doesNotMatch(prompt, /<CURRENT_SCENE_REFERENCE>/u);
  }
  assert.match(allCovers, /对艾瑟嘉德的所有井盖进行寻根溯源/u);
  assert.match(allCovers, /设施集合/u);
  assert.match(industry, /对艾瑟嘉德的井盖业进行寻根溯源/u);
  assert.match(industry, /行业生态/u);
});

test('R-01：同一「神明纪元 + 后世帝国」夹具下，传记 prompt 含活跃时间规则且 validator 能本地检出违规', () => {
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
  const rules = {
    sharedContext: '共享规则',
    retrievalContract: '',
    validationContract: '',
    generationContract: '生成契约',
  };
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive: '对神明纪元时期的帝国起源进行寻根溯源',
    context,
    rules,
    stagePlan: makeStagePlan(),
  });
  // prompt 必须携带时代画像（神明纪元时奥古斯提姆帝国尚不存在）+ 错位处理契约。
  assert.match(prompt, /<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>/u);
  assert.match(prompt, /<ERA_PROFILE>/u);
  assert.match(prompt, /奥古斯提姆帝国/u);
  assert.match(prompt, /混乱纪元/u);
  assert.match(prompt, /错位处理契约/u);

  // 时代错位不再致命：plan 在神明纪元引用后世帝国 → 通过（模型按错位契约处理）。
  const plan = makePlan();
  plan.playerDirective = {
    ...plan.playerDirective,
    raw: '对神明纪元时期的帝国起源进行寻根溯源',
    interpretedTarget: '奥古斯提姆帝国',
  };
  plan.target = { type: 'entity', name: '奥古斯提姆帝国', aliases: [], sourceRefs: [sourceId] };
  const validatedPlan = parseAndValidateBiographyPlan(JSON.stringify(plan), {
    requestId,
    directive: '对神明纪元时期的帝国起源进行寻根溯源',
    stagePlan: makeStagePlan(),
    context,
  });
  assert.equal(validatedPlan.target.name, '奥古斯提姆帝国');

  // 同账本下引用已在纪元内的实体不误伤。
  const cleanPlan = makePlan();
  cleanPlan.stages = cleanPlan.stages.map(stage => ({
    ...stage,
    introduced: ['泰珂'],
  }));
  const validated = parseAndValidateBiographyPlan(JSON.stringify(cleanPlan), {
    requestId,
    directive,
    stagePlan: makeStagePlan(),
    context,
  });
  assert.equal(validated.stages.length, 5);
});

test('Plan A：规划 prompt 注入人物在场窗口（STAGE_PERSON_TIMELINE）与 PERSON_TIMELINE 回退渲染', () => {
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '梅薇娜·王尔德',
      state: 'not-born',
      narrative: '梅薇娜·王尔德出生于复兴纪元400年（由基准时间复兴纪元488年时88岁推算），目标纪元（复兴纪元）早于其出生/抵达：她不在场。',
      lifespan: {
        born: { era: '复兴纪元', year: 400 },
        ageAtRecord: 88,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
      },
    }],
  };
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive: '对梅薇娜·王尔德进行寻根溯源',
    context,
    rules: {
      sharedContext: '共享规则',
      retrievalContract: '',
      validationContract: '',
      generationContract: '生成契约',
    },
    stagePlan: makeStagePlan(),
  });
  // 引擎已算好的锚点经视图回退渲染（此前传记 prompt 从不显示 PERSON_TIMELINE）。
  assert.match(prompt, /<PERSON_TIMELINE>/u);
  assert.match(prompt, /梅薇娜·王尔德出生于复兴纪元400年/u);
  // Plan A 窗口块：机器可读窗口 + 段内年龄公式 + 窗口外处理规则。
  assert.match(prompt, /<STAGE_PERSON_TIMELINE>/u);
  assert.match(prompt, /【梅薇娜·王尔德】出生\/抵达复兴纪元400年（由基准时间复兴纪元488年时88岁推算）— 在世（无死亡记录）/u);
  assert.match(prompt, /段内年龄 = 段年份 − 出生（抵达）年/u);
  assert.match(prompt, /缺席叙事/u);
});

test('Plan A：无人物时间锚时规划 prompt 不注入窗口块', () => {
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive,
    context: makeContext(),
    rules: {
      sharedContext: '共享规则',
      retrievalContract: '',
      validationContract: '',
      generationContract: '生成契约',
    },
    stagePlan: makeStagePlan(),
  });
  assert.doesNotMatch(prompt, /<STAGE_PERSON_TIMELINE>/u);
});

test('Plan A：无纪元条目（state=unknown）窗口行照常渲染，传记 prompt 真实拿到出生年锚', () => {
  // 传记真实入口：指令无纪元 → 引擎输出 state=unknown 条目（lifespan 照常）。
  // unknown state 不得阻塞窗口块注入——这是本次「传记时间锚不早退」修复的落点。
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '玲山·哈姆斯沃思',
      state: 'unknown',
      narrative: '玲山·哈姆斯沃思出生/抵达复兴纪元461年（由基准时间复兴纪元488年时27岁推算）— 在世（无死亡记录）；当前指令未限定纪元，不做整篇在场判定，各段在场与年龄按该段具体年份另行判定。',
      lifespan: {
        born: { era: '复兴纪元', year: 461 },
        ageAtRecord: 27,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
      },
    }],
  };
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive: '对玲山·哈姆斯沃思进行寻根溯源',
    context,
    rules: {
      sharedContext: '共享规则',
      retrievalContract: '',
      validationContract: '',
      generationContract: '生成契约',
    },
    stagePlan: makeStagePlan(),
  });
  // 窗口块：出生年锚行必须出现（禁止自行心算年龄）。
  assert.match(prompt, /<STAGE_PERSON_TIMELINE>/u);
  assert.match(prompt, /【玲山·哈姆斯沃思】出生\/抵达复兴纪元461年/u);
  assert.match(prompt, /禁止自行心算年龄/u);
  // PERSON_TIMELINE 回退渲染：中性文案（无空洞目标纪元）。
  assert.match(prompt, /<PERSON_TIMELINE>/u);
  assert.match(prompt, /未限定纪元/u);
  assert.doesNotMatch(prompt, /目标纪元（\s*）/u);
});

test('Plan A：扩写 prompt 注入逐段在场结论（STAGE_PERSON_WINDOW），单块按 passageId 过滤', () => {
  const plan = makePlan();
  const notes = [
    {
      passageId: 'stage-1',
      assessments: [
        {
          name: '梅薇娜·王尔德',
          state: 'alive' as const,
          ageRange: { start: 48, end: 58 },
          guidance: '梅薇娜·王尔德在场：本段年龄约 48~58 岁。',
        },
        {
          name: '凡多·灰袍',
          state: 'before-birth' as const,
          ageRange: { start: null, end: null },
          guidance: '凡多·灰袍本段尚不存在（出生/抵达复兴纪元400年晚于本段）：禁止直接在场。用缺席叙事，或异界来源并明示。',
        },
      ],
    },
    {
      passageId: 'stage-2',
      assessments: [
        {
          name: '梅薇娜·王尔德',
          state: 'alive' as const,
          ageRange: { start: 58, end: 68 },
          guidance: '梅薇娜·王尔德在场：本段年龄约 58~68 岁。',
        },
      ],
    },
  ];
  const batchPrompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan,
    passages: [
      { passageId: 'stage-1', kind: 'stage', title: '第1时期', sourceRefs: [sourceId], eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-1')! },
      { passageId: 'stage-2', kind: 'stage', title: '第2时期', sourceRefs: [sourceId], eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-2')! },
    ],
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    stagePersonNotes: notes,
  });
  assert.match(batchPrompt, /<STAGE_PERSON_WINDOW>/u);
  assert.match(batchPrompt, /【stage-1】/u);
  assert.match(batchPrompt, /【stage-2】/u);
  assert.match(batchPrompt, /梅薇娜·王尔德在场：本段年龄约 48~58 岁/u);
  assert.match(batchPrompt, /凡多·灰袍本段尚不存在/u);
  assert.match(batchPrompt, /禁止直接在场/u);

  // 单块 prompt 只注入本段结论。
  const singlePrompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: { passageId: 'stage-1', kind: 'stage', title: '第1时期', sourceRefs: [sourceId], eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-1')! },
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    stagePersonNotes: notes,
  });
  assert.match(singlePrompt, /梅薇娜·王尔德在场：本段年龄约 48~58 岁/u);
  assert.doesNotMatch(singlePrompt, /本段年龄约 58~68 岁/u);
});

test('Plan A：全部 unknown 结论不注入窗口块（避免噪音）', () => {
  const plan = makePlan();
  const prompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan,
    passages: [
      { passageId: 'stage-1', kind: 'stage', title: '第1时期', sourceRefs: [sourceId], eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-1')! },
    ],
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    stagePersonNotes: [{
      passageId: 'stage-1',
      assessments: [
        {
          name: '路人甲',
          state: 'unknown',
          ageRange: { start: null, end: null },
          guidance: '路人甲的生卒窗口缺失，按世界书资料与时代画像自行判断。',
        },
      ],
    }],
  });
  assert.doesNotMatch(prompt, /<STAGE_PERSON_WINDOW>/u);
});

test('扩写只注入静默物件与地点状态，不把它们变成强制登场或剧情钩子', () => {
  const plan = makePlan();
  const prompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: {
      passageId: 'stage-2',
      kind: 'stage',
      title: '第2时期',
      sourceRefs: [sourceId],
      eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-2')!,
    },
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    continuityPassages: [{
      schema: 'eyon.biography.passage.v1',
      requestId,
      passageId: 'stage-1',
      kind: 'stage',
      title: '旧货摊的快门',
      content: '玲山在艾瑟嘉德的旧货摊买下了一台旧式留影相机，随后将它带回琉璃塔信报社。',
      people: ['玲山'],
      factions: ['琉璃塔信报社'],
      objects: ['旧式留影相机'],
      locations: ['艾瑟嘉德', '旧货摊'],
      sourceRefs: [sourceId],
      biographyUsage: [],
      eventId: 'invented:stage-1:camera',
      eventUsage: 'occurs',
      inference: true,
      elementChecklist: {
        sceneGrounded: true,
        figureVivid: true,
        decisiveMoment: true,
      },
    }],
    continuityNames: ['旧式留影相机', '琉璃塔信报社', '艾瑟嘉德'],
  });
  assert.match(prompt, /<BIOGRAPHY_CONTINUITY_CONTEXT>/u);
  assert.match(prompt, /旧式留影相机/u);
  assert.match(prompt, /玲山在艾瑟嘉德的旧货摊买下/u);
  assert.match(prompt, /不是剧情钩子、登场要求或前情摘要/u);
  assert.match(prompt, /无关实体不要提/u);
  assert.match(prompt, /可以自由写变化，但要在本段自然写出发生过程/u);
  assert.doesNotMatch(prompt, /<THREAD_SO_FAR>/u);
});

test('整批语义复核读取完整前段与首稿，但不再承载连续性结构字段', () => {
  const plan = makePlan();
  const passage = (passageId: string, content: string) => ({
    schema: 'eyon.biography.passage.v1' as const,
    requestId,
    passageId,
    kind: 'stage' as const,
    title: passageId,
    content,
    people: ['玲山'],
    factions: [],
    objects: [],
    locations: [],
    sourceRefs: [sourceId],
    biographyUsage: [],
    eventId: plan.eventAssignments.find(item => item.passageId === passageId)!.eventId,
    eventUsage: plan.eventAssignments.find(item => item.passageId === passageId)!.usage,
    inference: true,
    elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
  });
  const history = passage(
    'stage-1',
    '海因里希没有执行逮捕，而是用重剑亲手撬毁了玲山颈间的圣纹压制环。',
  );
  const draft = passage(
    'stage-2',
    '玲山在晨曙书局习惯性地摩挲领口下冰冷的圣纹压制环。',
  );
  const prompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan,
    passages: [{
      passageId: 'stage-2',
      kind: 'stage',
      title: 'stage-2',
      sourceRefs: [sourceId],
      eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-2')!,
    }],
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    continuityPassages: [history],
    continuityNames: [],
    draftPassages: [draft],
  });
  assert.match(prompt, /<BIOGRAPHY_FULL_PASSAGE_SEMANTIC_REVIEW>/u);
  assert.match(prompt, /不得以关键词是否命中决定要不要审阅/u);
  assert.match(prompt, /没有执行逮捕，而是用重剑亲手撬毁/u);
  assert.match(prompt, /摩挲领口下冰冷的圣纹压制环/u);
  assert.match(prompt, /禁止插入技术判定句/u);
  assert.doesNotMatch(prompt, /continuityClaim|continuityEventVerdicts|CONTINUITY_EVENT_PAIR_SEMANTIC_REVIEW/u);
});

test('P4-C 独立裁判只读取自然语言事件对，并以中文短行回执', () => {
  const plan = makePlan();
  const passage = {
    schema: 'eyon.biography.passage.v1' as const,
    requestId,
    passageId: 'stage-2',
    kind: 'stage' as const,
    title: '暮潮移交',
    content: '复兴纪元485年秋，洛安在外港第七泊位把《暮潮手札》交给弥拉。',
    people: ['洛安', '弥拉'], factions: [], objects: ['《暮潮手札》'], locations: ['外港第七泊位'],
    sourceRefs: [sourceId], biographyUsage: [],
    eventId: plan.eventAssignments.find(item => item.passageId === 'stage-2')!.eventId,
    eventUsage: plan.eventAssignments.find(item => item.passageId === 'stage-2')!.usage,
    inference: true,
    elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
  };
  const prompt = buildBiographyContinuityJudgePrompt({
    requestId,
    passages: [passage],
    eventPairs: [{ pairId: 'P1', producerUnitRef: 'stage-2', currentEventRef: passage.eventId,
      otherHandle: 'C1', otherAnchorId: 'continuity-anchor:old' }],
    continuityView: {
      schema: 'eyon.continuity.view.v1',
      branchId: 'branch:test', canonRevision: 3, queryScopeHash: 'scope',
      anchors: [{
        handle: 'C1', anchorId: 'continuity-anchor:old',
        claim: '复兴纪元484年秋，洛安在外港把《暮潮手札》交给弥拉。',
        time: '484年秋', participants: ['洛安', '弥拉'], locations: ['外港'], objects: ['《暮潮手札》'],
        stance: 'hypothesis', origin: '旧传记 stage-4',
        finalProseExcerpt: '雾气中，洛安把手札交给弥拉。',
      }],
      relationGroups: [], omittedCount: 0, warnings: [],
    },
  });
  assert.match(prompt, /<BIOGRAPHY_CONTINUITY_EVENT_JUDGE>/u);
  assert.match(prompt, /P1：同一事件；主要差异：时间；理由/u);
  assert.match(prompt, /485年秋.*外港第七泊位/u);
  assert.match(prompt, /484年秋.*《暮潮手札》交给弥拉/u);
  assert.match(prompt, /不要 JSON/u);
  assert.doesNotMatch(prompt, /continuityEventVerdicts|continuityClaim/u);
});

test('连续状态只携带本段相关实体的原句，不把前段人物编成硬性登场表', () => {
  const plan = makePlan();
  const prompt = buildBiographyPassagePrompt({
    requestId,
    plan,
    passage: {
      passageId: 'stage-2',
      kind: 'stage',
      title: '第2时期',
      sourceRefs: [sourceId],
      eventAssignment: plan.eventAssignments.find(item => item.passageId === 'stage-2')!,
    },
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    continuityPassages: [{
      schema: 'eyon.biography.passage.v1',
      requestId,
      passageId: 'stage-1',
      kind: 'stage',
      title: '两家报社的会面',
      content: '伊莲娜·A·梦露以白鲸杂志社社长的身份与玲山会面。另有装订师赛拉斯在门外等候。',
      people: ['伊莲娜·A·梦露', '赛拉斯'],
      factions: ['白鲸杂志社'],
      objects: [],
      locations: [],
      sourceRefs: [sourceId],
      biographyUsage: [],
      eventId: 'invented:stage-1:meeting',
      eventUsage: 'occurs',
      inference: true,
      elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
    }],
    continuityNames: ['伊莲娜·A·梦露'],
  });

  assert.match(prompt, /伊莲娜·A·梦露以白鲸杂志社社长的身份/u);
  assert.doesNotMatch(prompt, /装订师赛拉斯在门外等候/u);
  assert.match(prompt, /骰表仍决定本段讲什么/u);
  assert.match(prompt, /确实要求变化时，可以自由写变化/u);
  assert.match(prompt, /后段年龄不得小于两段纪年的自然间隔/u);
  assert.match(prompt, /资料不足时宁可不写精确年龄/u);
});

test('年龄公式只保留段年份减出生年，不再向模型注入错误加法', () => {
  const prompt = buildBiographyPlanPrompt({
    requestId,
    directive,
    context: makeContext(),
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '生成契约' },
    stagePlan: makeStagePlan(),
  });
  assert.match(prompt, /其年龄 = 本段年份 − 出生年/u);
  assert.doesNotMatch(prompt, /其年龄 = 出生年 \+（本段年份 − 出生年）/u);
});

test('P0-A：规划与扩写消费同一 PersonCanonView factId，不受旧 1500 字切片边界影响', () => {
  const context = makeContext();
  const factId = 'fact:lingshan-departed-from-v1';
  context.evidenceBundle.personCanonViews = [{
    schema: 'eyon.retrieval.person-canon-view.v1',
    entityId: 'entity:lingshan',
    canonicalName: '玲山·哈姆斯沃思',
    aliases: ['玲山'],
    requiredFactIds: [factId],
    relevantFactIds: [factId],
    sourceSnapshotIds: [context.evidenceBundle.sourceSnapshots[0]!.snapshotId],
    facts: [{
      factId,
      subjectEntityId: 'entity:lingshan',
      predicate: 'departed_from',
      object: '梵尼亚',
      statement: '离开梵尼亚',
      temporalScope: null,
      spatialScope: '梵尼亚',
      epistemicStatus: 'explicit',
      confidence: 'high',
      sourceRefs: [sourceId],
      sourceSnapshotIds: [context.evidenceBundle.sourceSnapshots[0]!.snapshotId],
      sourceSpans: [{
        snapshotId: context.evidenceBundle.sourceSnapshots[0]!.snapshotId,
        startOffset: 1700,
        endOffset: 1710,
      }],
      revisionIntroduced: 0,
      revisionRetired: null,
    }],
  }];
  const lateCanon = `${'人物资料。'.repeat(3000)}背景口述：玲山只知道官方声称铃羽被幻梦选中，她怀疑有人替女神写下了妹妹的名字。`;
  context.evidenceBundle.taskAnchorAttachments = [{
    schema: 'eyon.retrieval.task-anchor-attachment.v1',
    attachmentId: 'attachment:lingshan:fixture',
    entityId: 'entity:lingshan',
    canonicalName: '玲山·哈姆斯沃思',
    sourceId,
    snapshotId: context.evidenceBundle.sourceSnapshots[0]!.snapshotId,
    sourceType: 'worldbook',
    title: '玲山·哈姆斯沃思',
    content: lateCanon,
    contentHash: 'fixture-attachment',
    charCount: lateCanon.length,
    purpose: 'direct-character-entry',
  }];
  context.evidenceBundle.taskAnchorAttachments.push({ ...context.evidenceBundle.taskAnchorAttachments[0]!,
    attachmentId: 'attachment:duplicate-document', entityId: 'entity:related-person' });
  const passage = context.evidenceBundle.passages[0]!;
  context.evidenceBundle.qualifiedEvidence = {
    schema: 'eyon.retrieval.qualified-evidence.v1',
    taskType: 'biography',
    requestedScope: { eras: [], locations: [] },
    creativePolicy: { locked: '锁定事实', guided: '谨慎推演', open: '自由场景' },
    passages: [{
      passageId: passage.passageId,
      sourceId: passage.sourceId,
      sourceType: passage.sourceType,
      zone: 'locked',
      temporal: { fit: 'unknown', requestedEras: [], evidenceEras: [] },
      geographic: { fit: 'unknown', requestedLocations: [], evidenceLocations: [] },
      eventPhase: 'reference',
      revision: { fit: 'baseline', reason: 'fixture' },
      entityRoles: [],
      allowedUses: ['background', 'reference'],
      forbiddenUses: [],
      reasons: ['fixture'],
    }],
  };
  const rules = {
    sharedContext: '共享规则',
    retrievalContract: '',
    validationContract: '',
    generationContract: '生成契约',
  };
  const planPrompt = buildBiographyPlanPrompt({
    requestId,
    directive: '对玲山·哈姆斯沃思进行寻根溯源',
    context,
    rules,
    stagePlan: makeStagePlan(),
  });
  const expansionPrompt = buildBiographyPassageBatchPrompt({
    requestId,
    plan: makePlan(),
    passages: [{ passageId: 'stage-1', kind: 'stage', title: '第1时期', sourceRefs: [sourceId], eventAssignment: makePlan().eventAssignments.find(item => item.passageId === 'stage-1')! }],
    rules,
    personCanonViews: context.evidenceBundle.personCanonViews,
    activeEvidence: buildActiveEvidenceView(context.evidenceBundle, null),
    taskAnchorAttachments: context.evidenceBundle.taskAnchorAttachments,
  });
  for (const prompt of [planPrompt, expansionPrompt]) {
    assert.match(prompt, /<PERSON_CANON_VIEW>/u);
    assert.match(prompt, /"factId":"F1"/u);
    assert.doesNotMatch(prompt, new RegExp(factId, 'u'));
    assert.match(prompt, /离开梵尼亚/u);
    assert.match(prompt, /"startOffset":1700/u);
    assert.match(prompt, /<TASK_ANCHOR_ATTACHMENT>/u);
    assert.match(prompt, /官方声称铃羽被幻梦选中/u);
    assert.equal(prompt.split(lateCanon).length - 1, 1, '完整长人物附件只投递一次，不被12000字门裁掉尾部');
    assert.match(prompt, /不得把机制性猜测升级为正史/u);
  }
  assert.match(expansionPrompt, /<QUALIFIED_EVIDENCE_VIEW>/u);
});
