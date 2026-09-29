import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyContextBundle, ContextSource } from '../src/core/context.ts';
import type { BiographyStagePlan } from '../src/runtime/biographyDiceCore.ts';
import type { BiographyPassageResponse, BiographyPlan } from '../src/schemas/biography.ts';
import { assembleBiography, buildPassageBlocks } from '../src/workflows/biography.ts';
import { parseAndValidateBiography } from '../src/validators/biography.ts';
import { assertBiographyRootTraceMatchesStructuredData } from '../src/renderers/rootTrace.ts';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  RETRIEVAL_RECEIPT_SCHEMA,
  SOURCE_SNAPSHOT_SCHEMA,
  type EvidenceBundle,
} from '../src/retrieval/contracts.ts';

const requestId = 'bio-assembly-001';
const sourceId = 'worldbook:维奥莱塔';
const directive = '对维奥莱塔进行寻根溯源';

function longText(seed: string): string {
  const passage = '她没有把这段关系当作宫廷传闻中的点缀，而是在一次次会面、书信、误解与和解中衡量欲望、责任和权力的边界。身边人的选择不断改变局势，她也必须为自己的决定承担真实后果。多年以后，这些具体经历仍留在她处理亲密关系与帝国事务的方式里，成为旁人能够察觉却无法轻易说破的旧痕。';
  return `${seed}${passage}${passage}${passage}${passage}`;
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
      eventId: `invented:${passageId}:assembly-${index + 1}`,
      summary: ['边关初遇商队', '港口查出走私', '雪夜救援伤兵', '宫廷拒绝联姻', '工坊保护匠人', '河谷重建驿站', '现今整理旧档'][index]!,
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
    indexes: { people: ['维奥莱塔'], factions: [], objects: [], locations: ['皇宫'], themes: ['亲密关系'], potentialRuinLinks: [] },
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

function makePassage(passageId: string, kind: 'origin' | 'stage' | 'status'): BiographyPassageResponse {
  return {
    schema: 'eyon.biography.passage.v1',
    requestId,
    passageId,
    kind,
    title: kind === 'stage' ? `第${passageId.replace('stage-', '')}时期` : kind === 'origin' ? '起源(二十四岁)' : '现状(二十八岁)',
    content: longText(kind === 'origin' ? '她在二十四岁时第一次主动选择亲密关系。' : kind === 'status' ? '这些经历最终塑造了她看待亲密与权力的方式。' : `维奥莱塔在${passageId}留下的独特经历。`),
    people: ['维奥莱塔'],
    factions: [],
    objects: [],
    locations: ['皇宫'],
    sourceRefs: [sourceId],
    biographyUsage: [],
    eventId: `invented:${passageId}:assembly`,
    eventUsage: 'occurs',
    inference: true,
    elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
  };
}

function makePassages(): Map<string, BiographyPassageResponse> {
  const passages = new Map<string, BiographyPassageResponse>();
  passages.set('origin', makePassage('origin', 'origin'));
  for (const stage of makeStagePlan().stages) {
    passages.set(stage.id, makePassage(stage.id, 'stage'));
  }
  passages.set('status', makePassage('status', 'status'));
  return passages;
}

test('buildPassageBlocks 按 origin → stages → status 顺序产出', () => {
  const blocks = buildPassageBlocks(makePlan());
  assert.equal(blocks[0].passageId, 'origin');
  assert.equal(blocks.at(-1)?.passageId, 'status');
  assert.match(blocks[0].span ?? '', /24/u);
  assert.doesNotMatch(blocks[0].span ?? '', /28/u, '起源不得携带整篇终点');
  assert.match(blocks.at(-1)?.span ?? '', /28/u);
  assert.doesNotMatch(blocks.at(-1)?.span ?? '', /24/u, '现状不得携带整篇起点');
  assert.deepEqual(
    blocks.slice(1, -1).map(block => block.passageId),
    ['stage-1', 'stage-2', 'stage-3', 'stage-4', 'stage-5'],
  );
});

test('assembleBiography 产出能通过整体校验并确定性渲染 RootTrace', () => {
  const plan = makePlan();
  const biography = assembleBiography(plan, makePassages());

  const validated = parseAndValidateBiography(JSON.stringify(biography), {
    requestId,
    directive,
    context: makeContext(),
    stagePlan: makeStagePlan(),
  });

  assert.equal(validated.stages.length, 5);
  assert.equal(validated.origin.title, '起源(二十四岁)');
  assert.equal(validated.status.title, '现状(二十八岁)');
  assert.doesNotThrow(() =>
    assertBiographyRootTraceMatchesStructuredData(validated, validated.rootTrace));
  assert.match(validated.rootTrace, /\[RootTrace\]/u);
});

test('assembleBiography 的同年跨月阶段保留年份，最终正文标题不会只剩月份', () => {
  const base = makePlan();
  const plan: BiographyPlan = {
    ...base,
    span: {
      mode: 'calendar',
      start: { era: '复兴纪元', year: 481, month: 1, day: null, age: null },
      end: { era: '复兴纪元', year: 485, month: 12, day: null, age: null },
      label: '复兴纪元481年 - 485年',
    },
    stages: base.stages.map((stage, index) => ({
      ...stage,
      span: {
        start: {
          era: '复兴纪元',
          year: 481 + index,
          month: 1,
          day: null,
          hour: null,
          age: null,
        },
        end: {
          era: '复兴纪元',
          year: 481 + index,
          month: 12,
          day: null,
          hour: null,
          age: null,
        },
      },
    })),
  };

  const biography = assembleBiography(plan, makePassages());
  assert.equal(biography.stages[0]?.span, '复兴纪元481年1月 - 12月');
  assert.ok(biography.stages.every(stage => /复兴纪元\d+年/u.test(stage.span)));
});
