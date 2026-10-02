import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextSource, RuinContextBundle } from '../src/core/context.ts';
import {
  EVIDENCE_BUNDLE_SCHEMA,
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  RETRIEVAL_RECEIPT_SCHEMA,
  SOURCE_SNAPSHOT_SCHEMA,
  type EvidenceBundle,
  type TemporalEligibilityLedger,
} from '../src/retrieval/contracts.ts';
import { createButtonCommand, parseTextCommand } from '../src/core/commands.ts';
import {
  isValidMvuLocation,
  resolveRuinEntryLocation,
} from '../src/core/ruinLocation.ts';
import type {
  RuntimeChatMessage,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  createRuinIdentityAssertion,
  RuinController,
  RuinTransactionGuard,
} from '../src/runtime/ruinController.ts';
import {
  TavernRuinEntryShellAdapter,
  type RuinEntryFloorLock,
} from '../src/runtime/tavernRuinEntryShell.ts';
import {
  buildCompactRuinExpansionRecoveryPrompt,
  buildRuinEarlierWindowCutoffReviewPrompt,
  buildRuinEarlierWindowCutoffVerdictPrompt,
  buildRuinEvidenceLedger,
  buildRuinExpansionApiPrompt,
  buildRuinOutlineBatchApiPrompt,
  buildRuinOutlineRepairPrompt,
  buildRuinTaskSpine,
  projectRuinContinuityForScope,
  requiresRuinEarlierWindowCutoffReview,
  renderRuinHistoricalAmbiguityGuidance,
  selectRuinReferenceSources,
} from '../src/prompts/ruin.ts';
import type { ContinuityView } from '../src/core/continuityAnchors.ts';
import {
  digestBiographySource,
  extractBiographyTimeline,
  biographyFullReference,
  chineseYearToNumber,
  extractObjectBands,
} from '../src/runtime/biographyContext.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import { resolveAutomaticRuinRange } from '../src/runtime/ruinAutomaticRange.ts';
import { WorkbenchLifecycle } from '../src/runtime/workbenchLifecycle.ts';
import type {
  RuinCandidates,
  RuinGenerationInput,
} from '../src/schemas/ruin.ts';
import { RuinGenerationInputSchema } from '../src/schemas/ruin.ts';
import {
  MemoryRuinCandidateRepository,
  ruinCandidateRecordKey,
  ruinCandidateState,
  type RuinCandidateRecord,
} from '../src/storage/ruins.ts';
import {
  parseAndNormalizeExpandedRuinCandidate,
  parseAndNormalizeRuinOutlines,
  parseAndValidateRuinCandidateResponse,
  parseAndValidateRuinCandidates,
  collectRuinCastNameWarnings,
  RuinValidationError,
} from '../src/validators/ruin.ts';
import {
  buildRuinRetrievalDirective,
  parseRuinEarlierWindowCutoffVerdict,
  RuinWorkflow,
} from '../src/workflows/ruin.ts';
import {
  buildRuinEntryContract,
  buildRuinEntryVariableRules,
  buildRuinRunId,
  resolveRuinEntryPlayerText,
  RUIN_ENTRY_DEFAULT_PHRASE,
  RUIN_ENTRY_PATCH_FIELDS,
  RuinEntryWorkflow,
} from '../src/workflows/ruinEntry.ts';
import { RUNTIME_FIELDS } from '../src/runtime/ruinTimeKernel.ts';
import {
  formatRuinNodeTimeCard,
  formatRuinSpanLabel,
} from '../src/renderers/ruinTimeLabel.ts';
import { insertRuinTrace } from '../src/workflows/messageAssembly.ts';
import { scopeRuinGenealogy } from '../src/runtime/ruinActorPolicy.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';

const namespace = {
  characterKey: '命定之诗',
  chatId: '存档-墟境测试',
};
const requestId = 'ruin-test-001';
const sourceId = 'worldbook:布劳尔旧堡';

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
    taskType: 'ruin',
    query: 'fixture',
    sourceSnapshots: snapshots,
    passages,
    claims: [],
    conflictGroupIds: [],
    receipt: {
      schema: RETRIEVAL_RECEIPT_SCHEMA,
      requestId,
      mode: 'active',
      taskType: 'ruin',
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

function makeInput(): RuinGenerationInput {
  return {
    era: '复兴纪元',
    start: { year: 145, month: 5, day: 1 },
    end: { year: 145, month: 5, day: 31 },
    location: '布劳尔旧堡',
    supplementaryDirection: '寻找一处能够由个人选择改变的历史裂点',
    selectedCharacters: [],
    wave: {
      level: 'stable',
      candidateCount: 3,
    },
    materials: Array.from({ length: 3 }, (_, index) => ({
      candidateKey: `candidate-${index + 1}`,
      periodType: 'transition' as const,
      background: `边地婚盟正在重排旧有秩序${index + 1}`,
      conflict: `档案继承权与地方供给发生冲突${index + 1}`,
      trigger: `一份被替换的名册暴露出制度裂缝${index + 1}`,
    })),
  };
}

test('墟境输入接受真实自定义纪年名，拒绝占位符与标签注入', () => {
  const custom = { ...makeInput(), era: '  星辉历  ' };
  assert.equal(RuinGenerationInputSchema.parse(custom).era, '星辉历');
  assert.throws(
    () => RuinGenerationInputSchema.parse({ ...makeInput(), era: '<custom>' }),
  );
});

test('掷骰基调与候选材料不进入史料检索，但仍保留玩家事实范围', () => {
  const input = makeInput();
  input.era = '英雄纪元';
  input.location = '奥古斯提姆帝国';
  input.supplementaryDirection = '第二次位面入侵时帝国军方的英雄群像';
  const query = buildRuinRetrievalDirective(
    '墟境探索\n月桂源生匣(物品/史诗)\n史诗基调\n骰材背景',
    input,
  );
  assert.match(query, /英雄纪元/u);
  assert.match(query, /奥古斯提姆帝国/u);
  assert.match(query, /第二次位面入侵/u);
  assert.doesNotMatch(query, /月桂源生匣|物品\/史诗|骰材背景/u);
});

test('玩家输入被固定为任务主轴，骰材只能在其后提供创作支持', () => {
  const input = makeInput();
  input.era = '英雄纪元';
  input.location = '奥古斯提姆帝国';
  input.supplementaryDirection = '第二次位面入侵时帝国军方的英雄群像';
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context: makeContext(),
    rules: { generationContract: 'generation contract' },
  });

  assert.match(prompt, /<PLAYER_TASK_SPINE_READ_ONLY>/u);
  assert.match(prompt, /第二次位面入侵时帝国军方的英雄群像/u);
  assert.match(prompt, /事件、主体、关系、群体规模与叙事焦点/u);
  assert.match(prompt, /people and organizations/u);
  assert.match(prompt, /"priority":\["hardScope","sourceText","qualifiedCanon","creativeMaterials"\]/u);
  assert.match(prompt, /one complete request/u);
  // 认知脚手架回归（76 三轮覆盖）：taskInterpretation/taskFit 恢复为纯输出脚手架——
  // 只写不判（脚本仅查 sourceText 防偷换与 materialRole 防覆盖），不再逐字段打分。
  assert.match(prompt, /taskInterpretation is a written-out reasoning scaffold/u);
  assert.match(prompt, /taskFit is a soft self-record/u);
  assert.match(prompt, /does NOT grade your wording/u);
  // 当代人物防错位引导（internal.76 覆盖包）：MVU/关系列表的当代人不得以本名进入历史候选。
  assert.match(prompt, /contemporary person under their real name/u);
  // 原创人物与造名规范（76 二轮覆盖）：不得为当代人制造历史前身；新人须有独立记忆点名字。
  assert.match(prompt, /Do not arrange a historical predecessor/u);
  assert.match(prompt, /original, memorable name/u);
  assert.match(prompt, /History is history, the present is the present/u);
});

test('墟境与传记共享对象边界：当前具名地点只证明现状，集合与行业原话保持完整', () => {
  const currentLocation = '奥古斯提姆帝国-艾瑟嘉德-皇宫高塔-黄昏花室';
  const currentContext = makeContext();
  currentContext.currentWorld.location = currentLocation;
  currentContext.currentSceneSnapshot = {
    location: currentLocation,
    evidence: [{
      sourceId: 'recent:41',
      title: '当前正文',
      content: '维奥莱塔女皇回到作为私人寝宫的黄昏花室。',
    }],
  };
  const currentInput = makeInput();
  currentInput.location = '黄昏花室';
  currentInput.supplementaryDirection = '围绕女皇寝宫黄昏花室修缮时发生的三次险境';
  const currentPromptInput = {
    requestId,
    directive: '墟境探索',
    generationInput: currentInput,
    context: currentContext,
    rules: { generationContract: 'generation contract' },
  };
  const currentSpine = buildRuinTaskSpine(currentPromptInput);
  const currentPrompt = buildRuinOutlineBatchApiPrompt(currentPromptInput);

  assert.equal(currentSpine.subjectBoundary.currentIdentityLocation, currentLocation);
  assert.match(currentPrompt, /<TASK_SUBJECT_BOUNDARY>/u);
  assert.match(currentPrompt, /<CURRENT_SCENE_SEMANTIC_SNAPSHOT>/u);
  assert.match(currentPrompt, /作为私人寝宫/u);
  assert.match(currentPrompt, /当前正文只直接证明对象在“现在”/u);
  assert.match(currentPrompt, /围绕女皇寝宫黄昏花室修缮时发生的三次险境/u);

  const collectionInput = makeInput();
  collectionInput.location = '艾瑟嘉德';
  collectionInput.supplementaryDirection = '艾瑟嘉德的所有井盖在战争中的修缮史';
  const industryInput = makeInput();
  industryInput.location = '艾瑟嘉德';
  industryInput.supplementaryDirection = '艾瑟嘉德的井盖业在战争中的兴衰史';
  const collectionSpine = buildRuinTaskSpine({
    ...currentPromptInput,
    generationInput: collectionInput,
  });
  const industrySpine = buildRuinTaskSpine({
    ...currentPromptInput,
    generationInput: industryInput,
  });
  assert.equal(collectionSpine.sourceText, '艾瑟嘉德的所有井盖在战争中的修缮史');
  assert.equal(industrySpine.sourceText, '艾瑟嘉德的井盖业在战争中的兴衰史');
  assert.equal(collectionSpine.subjectBoundary.currentIdentityLocation, null);
  assert.equal(industrySpine.subjectBoundary.currentIdentityLocation, null);
});

function makeContext(): RuinContextBundle {
  const source = {
    sourceId,
    sourceType: 'worldbook' as const,
    title: '布劳尔旧堡',
    content: '旧堡保存着地方婚盟与供给名册。',
    authority: 90,
  };
  return {
    schema: 'eyon.context.v1',
    taskType: 'ruin',
    requestId,
    scope: {
      ...namespace,
      triggerMessageId: 8,
    },
    currentWorld: {
      time: '复兴纪元488年',
      location: '布劳尔子爵领',
    },
    worldbookContext: [source],
    recentContext: [],
    characterContext: [],
    genealogyRefs: [],
    biographyRefs: [],
    butterflyRefs: [],
    sourceIndex: [source],
    evidenceBundle: makeEvidenceBundle([source]),
    warnings: [],
    sourceHash: 'ruin-source-hash',
  };
}

test('已选蝴蝶历史跨地点进入墟境大纲与扩写，不被外部事实摘录再次裁尾', async () => {
  const source: ContextSource = { sourceId: 'butterfly:continuity', sourceType: 'butterfly',
    title: '《蝴蝶效应锚定日志3》', authority: 70, content: [
      '### 《蝴蝶效应锚定日志3》', '',
      '| 墟境跨度 | 内容 |', '|:---|:---|',
      '| 进入时墟境时间 | 神明纪元126年-8月-15日-09:00 |', '',
      '| 墟境行动记录 | 玩家在幽谷溪畔启动泉眼机关，二叶由泉水重组并首次获得诅咒。 |',
      `| 历史演变 | 德鲁伊目击后记录《切芽圣典》。${'后世传播。'.repeat(500)}末尾证据：此事由玩家介入引发。 |`,
    ].join('\n') };
  const bundle = makeEvidenceBundle([source]);
  const result = await new UnifiedShadowRetrievalEngine(bundle.sourceSnapshots).retrieve({
    requestId, taskType: 'ruin', query: '神明纪元126年，艾尔文海姆，二叶事件后的目击者遭遇',
  });
  const context = makeContext();
  context.evidenceBundle = result.bundle;
  context.sourceIndex = [source];
  context.butterflyRefs = [source];
  const input = makeInput();
  input.era = '神明纪元'; input.location = '艾尔文海姆';
  input.supplementaryDirection = '二叶事件后的目击者遭遇';
  const promptInput = { requestId, directive: '墟境探索', generationInput: input,
    context, rules: { generationContract: '' } };
  // 强制走异地 reference 路径：旧版 factExcerpt 会仅保留开头而丢失演变末尾。
  for (const passage of context.evidenceBundle.qualifiedEvidence?.passages ?? []) {
    passage.allowedUses = ['background', 'reference'];
  }
  const outline = makeCandidates().candidates[0];
  const expansion = buildRuinExpansionApiPrompt(promptInput, input.materials[0]!, outline);
  const recovery = buildCompactRuinExpansionRecoveryPrompt(expansion);
  assert.ok(recovery);
  for (const prompt of [buildRuinOutlineBatchApiPrompt(promptInput), expansion, recovery]) {
    assert.ok(prompt.includes(source.content), '完整行动记录与历史演变必须进入模型提示词');
    assert.match(prompt, /不得把已定事件的起因换成/u);
  }
});

function makeHistoricalAmbiguityView(
  dimension: ContinuityView['relationGroups'][number]['dimension'] = 'time',
): ContinuityView {
  return {
    schema: 'eyon.continuity.view.v1',
    branchId: 'branch:fixture',
    canonRevision: 7,
    queryScopeHash: 'scope:暮潮手札',
    anchors: [
      {
        anchorId: 'continuity-anchor:484', handle: 'C1',
        claim: '洛安在复兴纪元484年秋将《暮潮手札》交给弥拉。',
        time: '复兴纪元四八四年秋', participants: ['洛安', '弥拉'],
        locations: ['艾瑟嘉德外港第七泊位'], objects: ['《暮潮手札》'],
        stance: 'hypothesis', origin: '传记段落',
      },
      {
        anchorId: 'continuity-anchor:485', handle: 'C2',
        claim: '洛安在复兴纪元485年秋将《暮潮手札》交给弥拉。',
        time: '复兴纪元485年8月—11月', participants: ['洛安', '弥拉'],
        locations: ['艾瑟嘉德外港第七泊位'], objects: ['《暮潮手札》'],
        stance: 'hypothesis', origin: '传记段落',
        finalProseExcerpt: '未来摘录机密：485年秋全帙正式入库。',
        statusExcerpt: '未来现状机密：后世认定485年为唯一移交年。',
      },
    ],
    relationGroups: [{
      kind: 'parallelView', dimension, handles: ['C1', 'C2'], omittedMemberCount: 0,
    }],
    omittedCount: 0,
    warnings: [],
  };
}

test('P4-C2/HM-01—03 暮潮时间窗分别承担前置引子、后置残迹与分裂过程', () => {
  const view = makeHistoricalAmbiguityView();
  const earlier = renderRuinHistoricalAmbiguityGuidance(view, {
    era: '复兴纪元', start: { year: 484, month: 1, day: 1 },
    end: { year: 484, month: 12, day: 31 },
  }).join('\n');
  assert.match(earlier, /只触及较早视角/u);
  assert.match(earlier, /因果种子/u);
  assert.match(earlier, /不得提前宣告较晚视角/u);
  assert.match(earlier, /叙事认知必须截止于本候选 span 的终点/u);
  assert.match(earlier, /只能写成当时人物的计划、条件、担忧、尚未履行的约定或不确定可能/u);
  assert.match(earlier, /不能用全知回顾确认后来、次年或最终确实发生了什么/u);
  assert.match(earlier, /演变短句、史稿正文、转向说明和结尾总结都不得补叙未来结果/u);

  const later = renderRuinHistoricalAmbiguityGuidance(view, {
    era: '复兴纪元', start: { year: 485, month: 1, day: 1 },
    end: { year: 485, month: 12, day: 31 },
  }).join('\n');
  assert.match(later, /只触及较晚视角/u);
  assert.match(later, /较早说法/u);
  assert.match(later, /无声消失/u);

  const spanning = renderRuinHistoricalAmbiguityGuidance(view, {
    era: '复兴纪元', start: { year: 484, month: 1, day: 1 },
    end: { year: 485, month: 12, day: 31 },
  }).join('\n');
  assert.match(spanning, /同时触及两个版本/u);
  assert.match(spanning, /从何处分岔/u);
  assert.match(spanning, /不可只把两段年份并排复述/u);
});

test('P4-C2/HM-04—08 优先既有成因、拒绝原因菜单且无关时间窗不强行疑云', () => {
  const view = makeHistoricalAmbiguityView();
  const guidance = renderRuinHistoricalAmbiguityGuidance(view, {
    era: '复兴纪元', start: { year: 470, month: 1, day: 1 },
    end: { year: 470, month: 12, day: 31 },
  }).join('\n');
  assert.match(guidance, /已有材料/u);
  assert.match(guidance, /忠实沿用其核心因果/u);
  assert.match(guidance, /禁止套固定原因表、万能阴谋或重复模板/u);
  assert.match(guidance, /不触及任一版本/u);
  assert.match(guidance, /否则不要把疑云写进候选与史稿/u);
  assert.doesNotMatch(guidance, /causeType|mysteryType/u);
  assert.deepEqual(renderRuinHistoricalAmbiguityGuidance(undefined, {
    era: '复兴纪元', start: null, end: null,
  }), []);
});

test('P4-C2/HM-12 非时间差异采用统一自然叙事责任而不套时间模板', () => {
  const guidance = renderRuinHistoricalAmbiguityGuidance(
    makeHistoricalAmbiguityView('objectState'),
    {
      era: '复兴纪元', start: { year: 485, month: 1, day: 1 },
      end: { year: 485, month: 12, day: 31 },
    },
  ).join('\n');
  assert.match(guidance, /物品状态差异/u);
  assert.match(guidance, /不要套用时间冲突的前后年模板/u);
});

test('P4-C2 提纲、扩写与精简恢复共享同一非结构化疑云纪律', () => {
  const input = makeInput();
  input.start = { year: 484, month: 1, day: 1 };
  input.end = { year: 485, month: 12, day: 31 };
  input.location = '艾瑟嘉德外港第七泊位';
  input.supplementaryDirection = '探查《暮潮手札》的移交经过';
  const context = makeContext();
  context.continuityView = makeHistoricalAmbiguityView();
  const promptInput = {
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  };
  const outlinePrompt = buildRuinOutlineBatchApiPrompt(promptInput);
  assert.match(outlinePrompt, /<HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>/u);
  assert.match(outlinePrompt, /至少一份可进入候选/u);

  const outline = makeCandidates().candidates[0]!;
  outline.span.start.year = 485;
  outline.span.end.year = 485;
  const expansionPrompt = buildRuinExpansionApiPrompt(promptInput, input.materials[0]!, outline);
  assert.match(expansionPrompt, /本轮只触及较晚视角/u);
  assert.match(expansionPrompt, /只落实所选提纲已经承载/u);

  const recoveryPrompt = buildCompactRuinExpansionRecoveryPrompt(expansionPrompt);
  assert.ok(recoveryPrompt);
  assert.match(recoveryPrompt, /<GENERATED_CONTINUITY_READ_ONLY>/u);
  assert.match(recoveryPrompt, /<HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>/u);
  assert.match(recoveryPrompt, /本轮只触及较晚视角/u);
});

test('P4-C2/HM-01 较早候选在扩写与精简恢复中保留未来知识截止线', () => {
  const input = makeInput();
  input.start = { year: 484, month: 1, day: 1 };
  input.end = { year: 484, month: 12, day: 31 };
  input.location = '艾瑟嘉德外港第七泊位';
  input.supplementaryDirection = '探查《暮潮手札》的移交经过，不指定哪一种年份记载为真';
  const context = makeContext();
  context.continuityView = makeHistoricalAmbiguityView();
  const promptInput = {
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  };
  const outline = makeCandidates().candidates[0]!;
  outline.span.start = { year: 484, month: 8, day: 1 };
  outline.span.end = { year: 484, month: 11, day: 30 };
  const expansionPrompt = buildRuinExpansionApiPrompt(promptInput, input.materials[0]!, outline);
  assert.match(expansionPrompt, /叙事认知必须截止于本候选 span 的终点/u);
  assert.match(expansionPrompt, /不能用全知回顾确认后来、次年或最终确实发生了什么/u);
  assert.match(expansionPrompt, /结尾总结都不得补叙未来结果/u);

  const recoveryPrompt = buildCompactRuinExpansionRecoveryPrompt(expansionPrompt);
  assert.ok(recoveryPrompt);
  assert.match(recoveryPrompt, /叙事认知必须截止于本候选 span 的终点/u);
  assert.match(recoveryPrompt, /只能写成当时人物的计划、条件、担忧/u);
});

test('P4-C2 较早时间窗只保留未来冲突的存在，不投递未来正文与结局', () => {
  const view = makeHistoricalAmbiguityView();
  const earlyScope = {
    era: '复兴纪元',
    start: { year: 484, month: 1, day: 1 },
    end: { year: 484, month: 12, day: 31 },
  };
  const projected = projectRuinContinuityForScope(view, earlyScope);
  assert.equal(projected.requiresCutoffReview, true);
  assert.deepEqual(projected.hiddenHandles, ['C2']);
  assert.equal(projected.view?.anchors[0]?.claim, view.anchors[0]?.claim);
  assert.match(projected.view?.anchors[1]?.claim ?? '', /具体过程与结局对本轮现场不可知/u);
  assert.equal(projected.view?.anchors[1]?.time, '本轮时间窗之后（具体年份对本轮现场不可知）');
  assert.equal(projected.view?.anchors[1]?.finalProseExcerpt, undefined);
  assert.equal(projected.view?.anchors[1]?.statusExcerpt, undefined);

  const input = makeInput();
  input.start = earlyScope.start;
  input.end = earlyScope.end;
  const context = makeContext();
  context.continuityView = view;
  const outline = makeCandidates().candidates[0]!;
  outline.span.start = { year: 484, month: 8, day: 1 };
  outline.span.end = { year: 484, month: 11, day: 30 };
  const prompt = buildRuinExpansionApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  }, input.materials[0]!, outline);
  assert.match(prompt, /具体过程与结局对本轮现场不可知/u);
  assert.doesNotMatch(prompt, /复兴纪元485年/u);
  assert.doesNotMatch(prompt, /洛安在复兴纪元485年秋将《暮潮手札》交给弥拉/u);
  assert.doesNotMatch(prompt, /未来摘录机密|未来现状机密/u);
});

test('P4-C2 未来证据投影不影响较晚、跨窗、普通与非时间差异', () => {
  const view = makeHistoricalAmbiguityView();
  for (const scope of [
    {
      era: '复兴纪元',
      start: { year: 485, month: 1, day: 1 },
      end: { year: 485, month: 12, day: 31 },
    },
    {
      era: '复兴纪元',
      start: { year: 484, month: 1, day: 1 },
      end: { year: 485, month: 12, day: 31 },
    },
  ]) {
    const projected = projectRuinContinuityForScope(view, scope);
    assert.equal(projected.requiresCutoffReview, false);
    assert.equal(projected.view, view);
  }
  const objectStateView = makeHistoricalAmbiguityView('objectState');
  assert.equal(projectRuinContinuityForScope(objectStateView, {
    era: '复兴纪元',
    start: { year: 484, month: 1, day: 1 },
    end: { year: 484, month: 12, day: 31 },
  }).view, objectStateView);
  assert.equal(projectRuinContinuityForScope(undefined, {
    era: '复兴纪元',
    start: { year: 484, month: 1, day: 1 },
    end: { year: 484, month: 12, day: 31 },
  }).requiresCutoffReview, false);
});

test('P4-C2 整段截止复核只携带候选草稿，不重新暴露较晚证据', () => {
  const outline = makeCandidates().candidates[0]!;
  outline.span.start = { year: 484, month: 8, day: 1 };
  outline.span.end = { year: 484, month: 11, day: 30 };
  const candidate = structuredClone(outline);
  candidate.historyProse = '次年全帙正式入库，后世由此认定唯一年份。';
  const prompt = buildRuinEarlierWindowCutoffReviewPrompt({
    requestId,
    candidateKey: candidate.candidateKey,
    era: '复兴纪元',
    outline,
    candidate,
  });
  assert.match(prompt, /<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>/u);
  assert.match(prompt, /ends at 复兴纪元484年11月30日/u);
  assert.match(prompt, /Judge the meaning of the complete sentence/u);
  assert.match(prompt, /次年全帙正式入库/u);
  assert.doesNotMatch(prompt, /未来摘录机密|未来现状机密/u);
  assert.equal(requiresRuinEarlierWindowCutoffReview(makeHistoricalAmbiguityView(), {
    era: '复兴纪元',
    start: outline.span.start,
    end: outline.span.end,
  }), true);

  const verdictPrompt = buildRuinEarlierWindowCutoffVerdictPrompt({
    requestId,
    candidateKey: candidate.candidateKey,
    era: '复兴纪元',
    outline,
    candidate,
  });
  assert.match(verdictPrompt, /<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>/u);
  assert.match(verdictPrompt, /Return BLOCK if any wording confirms/u);
  assert.match(verdictPrompt, /次年全帙正式入库/u);
  assert.doesNotMatch(verdictPrompt, /未来摘录机密|未来现状机密/u);
  assert.equal(parseRuinEarlierWindowCutoffVerdict('{"verdict":"PASS"}'), 'PASS');
  assert.equal(parseRuinEarlierWindowCutoffVerdict('{"verdict":"BLOCK"}'), 'BLOCK');
  assert.throws(
    () => parseRuinEarlierWindowCutoffVerdict('{"verdict":"PASS","reason":"extra"}'),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'CUTOFF_VERDICT_INVALID',
  );
});

function makeTemporalEligibility(): TemporalEligibilityLedger {
  return {
    schema: 'eyon.retrieval.temporal-eligibility.v1',
    eraOrder: ['神明纪元', '混乱纪元', '复兴纪元'],
    rules: [{
      ruleId: 'temporal:human-empire',
      subject: '人类帝国',
      scope: 'entity',
      availableFromEra: '混乱纪元',
      affectedEntityIds: ['entity:augustim'],
      affectedEntityNames: ['奥古斯提姆帝国'],
      sourceSnapshotId: 'worldbook:main@sha256:fixture',
      evidence: '混乱纪元：人类帝国诞生',
      span: { snapshotId: 'worldbook:main@sha256:fixture', startOffset: 10, endOffset: 25 },
    }],
  };
}

function makeNode(
  id: string,
  kind: 'origin' | 'process' | 'anomaly' | 'result',
  day: number,
) {
  const anomaly = kind === 'anomaly';
  return {
    id,
    kind,
    time: {
      year: 145,
      month: 5,
      day,
      hour: anomaly ? 23 : null,
      minute: anomaly ? 15 : null,
      label: `复兴纪元145年5月${day}日`,
    },
    location: '大陆中西部-奥古斯提姆帝国-布劳尔子爵领-布劳尔旧堡-内堡',
    title: `${kind}-${day}`,
    summary: '名册、供给与婚盟在同一条制度链上发生变化。',
    cause: '旧有的继承安排无法消化新的供给压力。',
    causalMechanism: '掌握名册的人能够改变物资和婚盟的分配顺序。',
    participants: ['档案官'],
    interests: [{
      actor: '档案官',
      wants: '保住名册解释权',
      fears: '替换行为被公开',
    }],
    materialConditions: ['纸张短缺', '封蜡由少数人保管'],
    opposition: '地方家族拒绝承认未经见证的新名册。',
    visibleTrace: '封蜡颜色与登记年份不一致。',
    intervention: anomaly
      ? '在名册被封存前揭露或替换关键页。'
      : '进入该阶段调查并影响正在形成的因果。',
    possibleBranches: [
      { condition: '公开证据', consequence: '婚盟被迫重新议定' },
      { condition: '秘密替换', consequence: '继承顺序在暗处改变' },
    ],
    enterable: true,
    inference: true,
    sourceRefs: [sourceId],
  };
}

function makeCandidates(): RuinCandidates {
  const candidates = Array.from({ length: 3 }, (_, index) => {
    const number = index + 1;
    return {
      id: `ruin-${number}`,
      candidateKey: `candidate-${number}`,
      title: `被替换的婚盟名册${number}`,
      periodType: 'transition' as const,
      span: {
        start: { year: 145, month: 5, day: 2 },
        end: { year: 145, month: 5, day: 22 },
        label: '复兴纪元145年5月',
      },
      premise: `一份名册让地方秩序偏离原有轨迹${number}。`,
      summary: `婚盟、供给和继承权围绕一份被替换的名册重新排列${number}。`,
      historyProse: '史'.repeat(500),
      fusion: {
        normalOrder: '地方家族按旧名册完成婚盟和供给。',
        latentFault: '名册解释权长期被少数档案官垄断。',
        pressuredActors: ['档案官', '地方家族'],
        bridge: {
          type: 'institution' as const,
          name: '婚盟名册制度',
          explanation: '名册同时决定婚盟承认与供给次序。',
        },
        triggerImpact: '替换页让原有的继承顺序失去凭证。',
        forcedDecision: '档案官必须公开证据或继续掩盖。',
        irreversibleTurn: '新名册被盖上正式封蜡。',
        historicalResult: '地方秩序以一套错误凭证延续。',
      },
      shift: {
        from: 'stable' as const,
        to: 'transition' as const,
        explanation: '制度仍在运行，但解释权已经发生转移。',
      },
      nodes: [
        makeNode('node-origin', 'origin', 2),
        makeNode('node-process', 'process', 12),
        makeNode('node-anomaly', 'anomaly', 20),
        makeNode('node-result', 'result', 22),
      ],
      cast: [{
        name: '档案官',
        kind: 'person' as const,
        identity: '旧堡名册保管人',
        role: '控制证据与封蜡',
        desire: '维持自身的解释权',
        constraint: '必须让替换页通过公开见证',
        sourceRefs: [sourceId],
        inference: true,
      }],
      selectedCharacterUsage: [],
      historicalTexture: {
        dailyLife: ['仆役按名册领取灯油与粮食'],
        institutions: ['婚盟见证与档案封存'],
        materialCulture: ['封蜡、羊皮纸与手抄副本'],
        socialDivisions: ['档案官、地方家族与仆役'],
      },
      sourceRefs: [sourceId],
      biographyUsage: [],
      inferenceNotes: ['档案官姓名无资料，因此仅按职业推断。'],
      qualityChecks: {
        threeMaterialsIntegrated: true,
        causalChainComplete: true,
        anomalyEnterable: true,
        timelineConsistent: true,
        distinctFromOtherCandidates: true,
        supplementaryDirectionFulfilled: true,
        selectedCharactersReconciled: true,
        clicheDependence: false,
      },
    };
  });
  return {
    schema: 'eyon.ruin.candidates.v2',
    requestId,
    era: '复兴纪元',
    location: '布劳尔旧堡',
    wave: {
      level: 'stable',
      candidateCount: 3,
    },
    candidates,
    castNameWarnings: [],
  };
}

function makeRecord(): RuinCandidateRecord {
  const result = makeCandidates();
  return {
    key: ruinCandidateRecordKey(namespace, requestId),
    namespace,
    requestId,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    sourceHash: 'source',
    input: makeInput(),
    result,
    expandedCandidateIds: result.candidates.map(candidate => candidate.id),
    candidateStates: Object.fromEntries(result.candidates.map(candidate => [
      candidate.id,
      {
        status: 'ready' as const,
        attempt: 1,
        generationEpoch: 1,
        updatedAt: 1000,
      },
    ])),
    createdAt: 1000,
  };
}

function makeOutlineResponse(input = makeInput()) {
  const result = makeCandidates();
  const taskRequirement = '个人选择能够改变历史';
  return {
    schema: 'eyon.ruin.outlines.v1',
    requestId,
    taskInterpretation: {
      sourceText: input.supplementaryDirection,
      primarySubject: '能够由个人选择改变的历史裂点',
      eventAnchor: '旧堡制度裂缝',
      castDemand: {
        mode: 'single',
        minimumDistinctActors: 1,
        requiredKinds: ['能够作出选择的历史行动者'],
        selectionRule: '选择能够改变名册因果链的行动者',
      },
      mustServe: [taskRequirement],
      materialRole: 'support-only',
    },
    candidates: result.candidates.map((candidate, index) => ({
      candidateKey: candidate.candidateKey,
      branchSignature: [
        { actor: '档案官', action: '替换婚盟名册', object: '继承顺序', mechanism: '伪造封蜡见证', outcome: '地方婚盟被迫重排' },
        { actor: '守粮队', action: '截断冬季供给', object: '旧堡粮仓', mechanism: '封锁山道车队', outcome: '仆役组织共同配给' },
        { actor: '石匠行会', action: '拆除议事厅地基', object: '旧堡权力中心', mechanism: '揭露地下水脉裂缝', outcome: '议事权转移到外城' },
      ][index],
      taskFit: {
        subjectServed: '候选围绕个人选择如何改变旧堡历史展开',
        eventAnchorServed: '决定集中在名册、供给或议事权的历史裂点',
        servedRequirements: [taskRequirement],
        contributions: [{
          actor: candidate.cast[0].name,
          action: '在制度链条的关键时刻作出可改变结果的选择',
          reason: '其掌握候选事件不可替代的行动条件',
        }],
      },
      title: candidate.title,
      premise: candidate.premise,
      summary: candidate.summary,
      historicalResult: candidate.fusion.historicalResult,
      span: candidate.span,
      shift: candidate.shift,
      cast: candidate.cast.map(member => ({
        name: member.name,
        kind: member.kind,
        identity: member.identity,
        role: member.role,
      })),
      nodes: candidate.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        time: node.time,
        location: node.location,
        title: node.title,
        summary: node.summary,
        visibleTrace: node.visibleTrace,
        participants: node.participants,
      })),
    })),
  };
}

function makeExpansionResponse(candidateId = 'ruin-candidate-1', historyProse?: string) {
  const candidateKey = candidateId.replace(/^ruin-/u, '');
  const candidate = makeCandidates().candidates.find(item =>
    item.id === candidateId || item.candidateKey === candidateKey
  );
  assert.ok(candidate);
  return {
    schema: 'eyon.ruin.expansion.v1',
    requestId: `${requestId}:expand:${candidateId}`,
    candidateKey: candidate.candidateKey,
    candidate: {
      title: candidate.title,
      premise: candidate.premise,
      summary: candidate.summary,
      historyProse: historyProse ?? candidate.historyProse,
      fusion: candidate.fusion,
      shift: { explanation: candidate.shift.explanation },
      nodes: candidate.nodes.map(node => ({
        id: node.id,
        title: node.title,
        summary: node.summary,
        cause: node.cause,
        causalMechanism: node.causalMechanism,
        participants: node.participants,
        interests: node.interests,
        materialConditions: node.materialConditions,
        opposition: node.opposition,
        visibleTrace: node.visibleTrace,
        intervention: node.intervention,
        possibleBranches: node.possibleBranches,
        inference: node.inference,
      })),
      cast: candidate.cast.map(member => ({
        name: member.name,
        kind: member.kind,
        identity: member.identity,
        role: member.role,
        desire: member.desire,
        constraint: member.constraint,
        inference: member.inference,
      })),
      historicalTexture: candidate.historicalTexture,
      inferenceNotes: candidate.inferenceNotes,
    },
  };
}

test('史稿必须从缘起节点的真实季节开场，不得被后续节点的深秋覆盖', () => {
  const input = makeInput();
  const context = makeContext();
  const outline = makeCandidates().candidates[0]!;
  const response = makeExpansionResponse(
    outline.id,
    `复兴纪元145年深秋，旧堡尚未入夜。${'史'.repeat(470)}`,
  );
  assert.throws(
    () => parseAndNormalizeExpandedRuinCandidate(JSON.stringify(response), {
      requestId: `${requestId}:expand:${outline.id}`,
      input,
      material: input.materials[0],
      context,
      outline,
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'PROSE_ORIGIN_SEASON_MISMATCH',
  );
});

test('墟境候选不能把同一事件换年份后当成不同支线', () => {
  const input = makeInput();
  const raw = makeOutlineResponse();
  raw.candidates[0]!.branchSignature = {
    actor: '帝国军后勤官',
    action: '焚毁军功名册',
    object: '前线指挥体系',
    mechanism: '异界渗透者纵火并伪造撤退令',
    outcome: '基层士兵脱离军衔体系自发集结',
  };
  raw.candidates[1]!.branchSignature = {
    actor: '帝国军后勤官',
    action: '焚毁军功名册',
    object: '前线指挥体系',
    mechanism: '异界渗透者纵火并伪造撤退令',
    outcome: '基层士兵脱离军衔体系自发集结',
  };
  raw.candidates[1]!.span.start.year = 146;
  raw.candidates[1]!.span.end.year = 146;
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
      requestId, directive: '墟境探索', input, context: makeContext(),
    }),
    (error: unknown) => error instanceof RuinValidationError && error.code === 'OUTLINE_BRANCH_DUPLICATE',
  );
});

test('批量墟境把已选人物作为重点参考，不自动污染实际演员表', () => {
  const input = makeInput();
  input.selectedCharacters = [{
    mvuId: '维奥莱塔',
    name: '维奥莱塔',
    source: 'mvu',
    race: '人类',
    identities: ['女皇'],
    professions: ['统治者'],
    relations: [],
    lifespan: '复兴纪元120年—复兴纪元190年',
    contextSummary: '曾经主持布劳尔旧堡的档案清查',
  }];
  const raw = makeOutlineResponse();
  raw.candidates.forEach((candidate, index) => {
    candidate.cast = [{
      name: `地方见证人${index + 1}`,
      kind: 'person',
      identity: `第${index + 1}条支线的见证人`,
      role: '推动本支线的地方行动',
    }];
  });

  const result = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });

  assert.deepEqual(
    result.candidates.map(candidate => candidate.cast[0]?.name),
    ['地方见证人1', '地方见证人2', '地方见证人3'],
  );
  for (const candidate of result.candidates) {
    assert.ok(!candidate.cast.some(member => member.name === '维奥莱塔'));
    assert.ok(!candidate.nodes.some(node => node.participants.includes('维奥莱塔')));
    assert.equal(candidate.selectedCharacterUsage[0]?.mode, 'notApplicable');
  }
});

test('墟境扩写不能替换提纲演员或移除锚点参与记录', () => {
  const input = makeInput();
  input.selectedCharacters = [{
    mvuId: '维奥莱塔',
    name: '维奥莱塔',
    source: 'mvu',
    race: '人类',
    identities: ['女皇'],
    professions: ['统治者'],
    relations: [],
    lifespan: '复兴纪元120年—复兴纪元190年',
    contextSummary: '曾经主持布劳尔旧堡的档案清查',
  }];
  const context = makeContext();
  const outlineResponse = makeOutlineResponse();
  outlineResponse.candidates[0]!.cast.unshift({
    name: '维奥莱塔',
    kind: 'person',
    identity: '女皇',
    role: '主持档案清查',
  });
  outlineResponse.candidates[0]!.nodes[0]!.participants.push('维奥莱塔');
  const outlines = parseAndNormalizeRuinOutlines(
    JSON.stringify(outlineResponse),
    { requestId, directive: '墟境探索', input, context },
  );
  const outline = outlines.candidates[0];
  const raw = makeExpansionResponse(outline.id);
  raw.candidate.cast = [{
    name: '无关替代者',
    kind: 'person',
    identity: '不应进入结果的人物',
    role: '替换演员',
    desire: '夺取位置',
    constraint: '无',
    inference: true,
  }];
  raw.candidate.nodes.forEach(node => {
    node.participants = ['无关替代者'];
  });

  const result = parseAndNormalizeExpandedRuinCandidate(JSON.stringify(raw), {
    requestId: `${requestId}:expand:${outline.id}`,
    input,
    material: input.materials[0],
    context,
    outline,
  });

  assert.deepEqual(
    result.cast.map(member => member.name),
    outline.cast.map(member => member.name),
  );
  assert.ok(result.nodes.some(node => node.participants.includes('维奥莱塔')));
  assert.ok(!result.cast.some(member => member.name === '无关替代者'));
});

test('谱系多身份人物统一为规范身份，既有单身份提纲也不会被误判为改写身份', () => {
  const input = makeInput();
  input.start = { year: 480, month: 1, day: 1 };
  input.end = { year: 481, month: 12, day: 31 };
  input.selectedCharacters = [{
    referenceId: 'genealogy:lingshan:lingyu',
    mvuId: 'ref',
    name: '铃羽·哈姆斯沃思',
    source: 'genealogy',
    identities: ['无尽地城守卫者', '圣国奉献者'],
    race: '翼族',
    professions: ['地城圣卫', '神殿侍从'],
    relations: ['玲山·哈姆斯沃思 → 姐妹 → 铃羽·哈姆斯沃思'],
    lifespan: '约复兴纪元465年—在世',
    contextSummary: '玲山之妹，现为无尽地城守卫者与圣国奉献者。',
  }];
  const context = makeContext();
  const raw = makeOutlineResponse(input);
  raw.candidates.forEach(candidate => {
    candidate.span = {
      start: { year: 480, month: 1, day: 1 },
      end: { year: 481, month: 12, day: 31 },
      label: '复兴纪元480年 - 481年',
    };
    candidate.nodes = candidate.nodes.map((node, index) => ({
      ...node,
      time: { ...node.time, year: 480 + Math.min(index, 1) },
    }));
    candidate.cast.unshift({
      name: '铃羽·哈姆斯沃思',
      kind: 'person',
      identity: '无尽地城守卫者',
      role: '参与地城守备决策',
    });
    candidate.nodes[0]!.participants.push('铃羽·哈姆斯沃思');
  });
  const outline = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId, directive: '墟境探索', input, context,
  }).candidates[0];
  assert.equal(
    outline.cast.find(member => member.name === '铃羽·哈姆斯沃思')?.identity,
    '无尽地城守卫者、圣国奉献者',
  );

  const expansion = makeExpansionResponse(outline.id);
  assert.doesNotThrow(() => parseAndNormalizeExpandedRuinCandidate(JSON.stringify(expansion), {
    requestId: `${requestId}:expand:${outline.id}`,
    input,
    material: input.materials[0],
    context,
    outline,
  }));

  const legacyOutline = structuredClone(outline);
  legacyOutline.cast.find(member => member.name === '铃羽·哈姆斯沃思')!.identity = '无尽地城守卫者';
  assert.doesNotThrow(() => parseAndNormalizeExpandedRuinCandidate(JSON.stringify(expansion), {
    requestId: `${requestId}:expand:${legacyOutline.id}`,
    input,
    material: input.materials[0],
    context,
    outline: legacyOutline,
  }));
});

test('已知人物生卒与候选年代冲突时不会被强塞进历史演员表', () => {
  const input = makeInput();
  input.selectedCharacters = [{
    mvuId: '维奥莱塔',
    name: '维奥莱塔',
    source: 'mvu',
    race: '人类',
    identities: ['女皇'],
    professions: ['统治者'],
    relations: [],
    lifespan: '复兴纪元462年—在世',
    contextSummary: '复兴纪元488年的奥古斯提姆帝国女皇',
  }];

  const result = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeOutlineResponse()),
    { requestId, directive: '墟境探索', input, context: makeContext() },
  );

  for (const candidate of result.candidates) {
    assert.ok(!candidate.cast.some(member => member.name === '维奥莱塔'));
    assert.equal(candidate.selectedCharacterUsage[0]?.mode, 'notApplicable');
  }
});

function makeCandidateResponse(prompt: string) {
  const candidateKey = /"targetMaterial":\{"candidateKey":"([^"]+)"/u
    .exec(prompt)?.[1];
  if (prompt.includes('<RUIN_SELECTED_CANDIDATE_EXPANSION>') && candidateKey) {
    return makeExpansionResponse(`ruin-${candidateKey}`);
  }
  const result = makeCandidates();
  const candidate = result.candidates.find(item => item.candidateKey === candidateKey);
  assert.ok(candidate, `prompt did not identify a known candidate: ${candidateKey}`);
  return {
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey,
    candidate,
  };
}

function makePlanResponse() {
  return {
    schema: 'eyon.ruin.plan.v1',
    requestId,
    plans: makeInput().materials.map((material, index) => ({
      candidateKey: material.candidateKey,
      periodType: material.periodType,
      titleDirection: `第${index + 1}条独立历史岔路`,
      centralIncident: `第${index + 1}种制度失序事件`,
      causalDifference: `由第${index + 1}种资源与见证关系推动`,
      anomalyDirection: `第${index + 1}个可由个人选择改变的封存瞬间`,
      castDirection: [{
        name: `规划人物${index + 1}`,
        identity: `第${index + 1}条岔路的关键见证者`,
      }],
    })),
  };
}

test('墟境利益项的空 fears 会被本地补为具体风险而不废弃整份候选', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.nodes[3].interests[0].fears = '';
  const parsed = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey: candidate.candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context: makeContext(),
  });

  assert.equal(
    parsed.nodes[3].interests[0].fears,
    '其既有立场、资源或安全保障遭到破坏',
  );
});

test('墟境出场者的明确类型别名会被本地归一化而不废弃整份候选', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.cast.push({
    name: '地方教会',
    kind: 'institution' as 'person',
    identity: '管理地方礼仪与账册的常设机构',
    role: '保存并解释关键记录',
    desire: '维持既有解释权',
    constraint: '必须服从公开见证程序',
    sourceRefs: [],
    inference: true,
  });
  const parsed = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey: candidate.candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context: makeContext(),
  });

  assert.equal(parsed.cast.at(-1)?.kind, 'organization');
});

test('墟境出场者不会把资源或地点伪装成合法人物类型', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.cast[0].kind = 'resource' as 'person';

  assert.throws(
    () => parseAndValidateRuinCandidateResponse(JSON.stringify({
      schema: 'eyon.ruin.candidate.v1',
      requestId,
      era: result.era,
      location: result.location,
      candidateKey: candidate.candidateKey,
      candidate,
    }), {
      requestId,
      input,
      material: input.materials[0],
      context: makeContext(),
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'SCHEMA_INVALID'
      && error.message.includes('candidate.cast[0].kind received="resource"'),
  );
});

test('墟境节点的常见布尔表达会归一化且缺失 inference 保守标为推断', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.nodes[0].inference = 'false' as unknown as boolean;
  candidate.nodes[1].inference = '是' as unknown as boolean;
  delete (candidate.nodes[2] as Partial<typeof candidate.nodes[number]>).inference;
  candidate.nodes[2].enterable = 'true' as unknown as boolean;
  candidate.qualityChecks.timelineConsistent = '通过' as unknown as boolean;

  const parsed = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey: candidate.candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context: makeContext(),
  });

  assert.equal(parsed.nodes[0].inference, false);
  assert.equal(parsed.nodes[1].inference, true);
  assert.equal(parsed.nodes[2].inference, true);
  assert.equal(parsed.nodes[2].enterable, true);
  assert.equal(parsed.qualityChecks.timelineConsistent, true);
});

test('略微超长的墟境史稿会在本地收束，不会废弃候选并重新请求', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.historyProse = `${'史'.repeat(705)}。`;
  const parsed = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey: candidate.candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context: makeContext(),
  });

  assert.ok((parsed.historyProse.match(/\p{Script=Han}/gu)?.length ?? 0) <= 650);
  assert.match(parsed.historyProse, /。$/u);
});

test('B+A：正常目标仍为 320 字，300-319 字完整史稿容错通过，真正短稿继续拦截', () => {
  const input = makeInput();
  const context = makeContext();
  const validate = (historyProse: string) =>
    parseAndValidateRuinCandidateResponse(JSON.stringify({
      schema: 'eyon.ruin.candidate.v1',
      requestId,
      era: input.era,
      location: input.location,
      candidateKey: input.materials[0].candidateKey,
      candidate: {
        ...structuredClone(makeCandidates().candidates[0]),
        historyProse,
      },
    }), {
      requestId,
      input,
      material: input.materials[0],
      context,
    });

  // 用户实测的 349 字（含标点、去除空白后中文字符数）→ 通过。
  const lean = `${'这是一段完整的墟境史稿，交代了本时期的局势、在场人物的选择与事件的因果推进。'.repeat(11)}${'收束余波。'}`;
  const leanChars = lean.match(/\p{Script=Han}/gu)?.length ?? 0;
  assert.ok(leanChars >= 320 && leanChars <= 700, `夹具长度 ${leanChars} 应落在正常区间`);
  assert.doesNotThrow(() => validate(lean));

  // 真机失败样本为 313 字：低于正常目标，但已是完整史稿，不应触发整次失败。
  const tolerated = '史'.repeat(313);
  assert.equal(tolerated.match(/\p{Script=Han}/gu)?.length, 313);
  assert.doesNotThrow(() => validate(tolerated));

  // 真正敷衍（<300）→ 拒绝，且报错信息给出可操作扩写指引。
  const stub = '神明纪元，泰珂恶作剧，金铎生气。';
  assert.throws(
    () => validate(stub),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'PROSE_LENGTH_INVALID'
      && /扩写/.test(error.message)
      && /至少 300 字/.test(error.message)
      && /不要只补几个字/.test(error.message),
  );
});

test('候选跨度遗漏首尾节点时会在玩家范围内自动校正', () => {
  const input = makeInput();
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);
  candidate.span.start = { year: 145, month: 5, day: 10 };
  candidate.span.end = { year: 145, month: 5, day: 15 };

  const parsed = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: result.era,
    location: result.location,
    candidateKey: candidate.candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context: makeContext(),
  });

  assert.deepEqual(parsed.span.start, { year: 145, month: 5, day: 2 });
  assert.deepEqual(parsed.span.end, { year: 145, month: 5, day: 22 });
  assert.equal(parsed.span.label, '复兴纪元145年5月2日 —— 145年5月22日');
});

test('节点真正越过玩家填写的时间范围时仍然拒绝', () => {
  const input = makeInput();
  input.end = { year: 145, month: 5, day: 20 };
  const result = makeCandidates();
  const candidate = structuredClone(result.candidates[0]);

  assert.throws(
    () => parseAndValidateRuinCandidateResponse(JSON.stringify({
      schema: 'eyon.ruin.candidate.v1',
      requestId,
      era: result.era,
      location: result.location,
      candidateKey: candidate.candidateKey,
      candidate,
    }), {
      requestId,
      input,
      material: input.materials[0],
      context: makeContext(),
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'NODE_OUT_OF_REQUEST_RANGE',
  );
});

class RuinRuntime implements TavernRuntime {
  characterKey = namespace.characterKey;
  chatId = namespace.chatId;
  lastMessageId = 8;
  messages = new Map<number, RuntimeChatMessage>([[
    8,
    {
      message_id: 8,
      role: 'user',
      message: '墟境探索',
      swipe_id: 0,
    },
  ]]);
  extensionPrompts: Array<{
    key: string;
    value: string;
    position: number;
    depth: number;
    shouldScan: boolean;
    role: number;
  }> = [];
  chatWrites: Array<{
    messages: Array<{
      message_id: number;
      message?: string;
      extra?: Record<string, unknown>;
    }>;
  }> = [];
  /** 可配置的生成中状态:undefined=宿主不提供该能力 */
  generating: boolean | undefined = undefined;

  getCurrentCharacterName() {
    return this.characterKey;
  }

  getCurrentChatId() {
    return this.chatId;
  }

  getLastMessageId() {
    return this.lastMessageId;
  }

  getMessageSwipeId(messageId: number) {
    return this.messages.get(messageId)?.swipe_id ?? null;
  }

  isGenerating() {
    return this.generating;
  }

  getChatMessages(range: number | string) {
    if (typeof range === 'number') {
      const message = this.messages.get(range);
      return message ? [structuredClone(message)] : [];
    }
    const [start, end] = range.split('-').map(Number);
    return [...this.messages.values()]
      .filter(message => message.message_id >= start && message.message_id <= end)
      .map(message => structuredClone(message));
  }

  async setChatMessages(
    messages: Array<{
      message_id: number;
      message?: string;
      extra?: Record<string, unknown>;
    }>,
  ) {
    this.chatWrites.push({ messages: structuredClone(messages) });
    // 真实写回:后续 requireMessage/attach 读到组装后的正文(与宿主行为一致)
    for (const write of messages) {
      const existing = this.messages.get(write.message_id);
      if (!existing) continue;
      if (write.message !== undefined) existing.message = write.message;
      if (write.extra !== undefined) {
        existing.extra = { ...(existing.extra ?? {}), ...write.extra };
      }
      this.messages.set(write.message_id, existing);
    }
  }

  setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    shouldScan: boolean,
    role: number,
  ) {
    this.extensionPrompts.push({ key, value, position, depth, shouldScan, role });
  }

  addMessage(message: RuntimeChatMessage) {
    this.messages.set(message.message_id, message);
    this.lastMessageId = Math.max(this.lastMessageId, message.message_id);
  }

  async generate() {
    return '';
  }

  async generateRaw() {
    return '';
  }
}

test('进入特异点注入壳:武装/清理/渲染断言/元数据写回', async () => {
  const runtime = new RuinRuntime();
  const shell = new TavernRuinEntryShellAdapter(runtime);
  const playerText = '我踏入这处历史特异点。';
  const contractText = [
    '进入节点',
    '【历史工作台·单楼进入契约】',
    '目标纪元：复兴纪元',
    '目标墟境地点：布劳尔旧堡',
    '史案标题：旧堡史案',
    '特异点：失踪的议员',
    '节点局势：议会封锁旧堡',
    '直接成因：密约外泄',
    '请直接承接上一楼尚未结束的动作',
  ].join('\n');
  runtime.addMessage({
    message_id: 8,
    role: 'user',
    message: playerText,
    swipe_id: 0,
  });
  const lock: RuinEntryFloorLock = {
    requestId: 'ruin-entry-test-001',
    recordKey: 'record-1',
    candidateId: 'candidate-1',
    nodeId: 'node-anomaly',
    triggerMessageId: 8,
    playerText,
    contractText,
    traceText: '[RuinTrace]\nTitle:: 测试\nType:: 稳定期\nSpan:: 测试\nHistory:: 测试\nShift:: 测试\nNodeTime:: 测试\n[/RuinTrace]',
    triggerTextHash: fingerprintText(playerText),
    triggerSwipeId: runtime.getMessageSwipeId(8),
    namespace: { characterKey: namespace.characterKey, chatId: namespace.chatId },
  };

  // 武装:注入 key 唯一、内容=契约全文、in_chat/depth 0/system
  await shell.arm(lock);
  assert.equal(runtime.extensionPrompts.length, 1);
  assert.deepEqual(runtime.extensionPrompts[0], {
    key: 'eyon-history-ruin-entry-ruin-entry-test-001',
    value: contractText,
    position: 1,
    depth: 0,
    shouldScan: false,
    role: 0,
  });

  // 渲染断言:紧邻助手楼通过
  runtime.addMessage({
    message_id: 9,
    role: 'assistant',
    message: '你踏入了历史切口，尘埃扑面而来。',
    swipe_id: 0,
  });
  await shell.assertRenderedFloor(lock, 9);

  // 渲染断言拒绝:触发楼被改动
  runtime.messages.set(8, {
    message_id: 8,
    role: 'user',
    message: '被篡改的玩家楼',
    swipe_id: 0,
  });
  await assert.rejects(
    () => shell.assertRenderedFloor(lock, 9),
    /trigger floor changed before commit/u,
  );
  runtime.messages.set(8, {
    message_id: 8,
    role: 'user',
    message: playerText,
    swipe_id: 0,
  });

  // 渲染断言拒绝:新楼不紧邻触发楼
  runtime.addMessage({
    message_id: 10,
    role: 'assistant',
    message: '间隔楼',
    swipe_id: 0,
  });
  await assert.rejects(
    () => shell.assertRenderedFloor(lock, 10),
    /does not belong to the ruin entry request/u,
  );

  // 渲染断言拒绝:助手楼被隐藏
  const hiddenRuntime = new RuinRuntime();
  hiddenRuntime.addMessage({
    message_id: 8,
    role: 'user',
    message: playerText,
    swipe_id: 0,
  });
  const hiddenLock: RuinEntryFloorLock = { ...lock, triggerSwipeId: 0 };
  hiddenRuntime.addMessage({
    message_id: 9,
    role: 'assistant',
    message: '隐藏楼',
    is_hidden: true,
    swipe_id: 0,
  });
  await assert.rejects(
    () => new TavernRuinEntryShellAdapter(hiddenRuntime).assertRenderedFloor(hiddenLock, 9),
    /does not belong to the ruin entry request/u,
  );

  // 元数据写回:带 message 分支触发器 + 保留原 extra + 元数据双写形状
  const writeRuntime = new RuinRuntime();
  writeRuntime.addMessage({
    message_id: 8,
    role: 'user',
    message: playerText,
    swipe_id: 0,
  });
  const writeLock: RuinEntryFloorLock = { ...lock, triggerSwipeId: 0 };
  writeRuntime.addMessage({
    message_id: 9,
    role: 'assistant',
    message: '你踏入了历史切口。',
    extra: { original: 'keep' },
    swipe_id: 0,
  });
  const writeShell = new TavernRuinEntryShellAdapter(writeRuntime);
  await writeShell.attachRequestMetadata(writeLock, 9);
  assert.equal(writeRuntime.chatWrites.length, 1);
  const write = writeRuntime.chatWrites[0].messages[0];
  assert.equal(write.message, '你踏入了历史切口。');
  assert.equal(write.extra?.original, 'keep');
  assert.deepEqual(write.extra?.eyonHistoryRuinEntryRequest, {
    requestId: 'ruin-entry-test-001',
    triggerMessageId: 8,
    triggerTextHash: fingerprintText(playerText),
    playerText,
    swipeId: 0,
    ruinHistory: {
      title: '旧堡史案',
      era: '复兴纪元',
      stage: '',
      nodeTime: '',
      nodeLocation: '布劳尔旧堡',
      nodeTitle: '',
      originalTrajectory: '议会封锁旧堡',
      historicalBackground: '密约外泄',
      enteredAnomaly: '失踪的议员',
      locationChain: ['布劳尔旧堡'],
      visibleTrace: '',
      intervention: '',
      possibleBranches: '',
      participants: '',
      selectedDirection: '',
    },
  });

  // 清理:同 key 置空
  await shell.clear('ruin-entry-test-001');
  assert.equal(runtime.extensionPrompts.length, 2);
  assert.deepEqual(runtime.extensionPrompts[1], {
    key: 'eyon-history-ruin-entry-ruin-entry-test-001',
    value: '',
    position: 1,
    depth: 0,
    shouldScan: false,
    role: 0,
  });
});

test('模型把 label 写成标题时被丢弃,由脚本确定性渲染为时间格式', () => {
  const input = makeInput();
  const result = makeCandidates();
  result.candidates.forEach(candidate => {
    candidate.span = { ...candidate.span, label: '清洗之夜' };
    candidate.nodes = candidate.nodes.map(node => ({
      ...node,
      time: { ...node.time, label: '秘密处刑' },
    }));
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  for (const candidate of parsed.candidates) {
    // 跨度标签:确定性渲染(纪元起止),模型标题被丢弃
    assert.match(candidate.span.label, /复兴纪元/u);
    assert.doesNotMatch(candidate.span.label, /清洗之夜/u);
    for (const node of candidate.nodes) {
      // 节点时间标签:确定性渲染(角色卡风格 纪元+年-月-日-时:分),模型标题被丢弃,无编号后缀
      assert.match(node.time.label, /复兴纪元/u);
      assert.doesNotMatch(node.time.label, /秘密处刑/u);
      assert.doesNotMatch(node.time.label, /\(\d+\)$/u);
      assert.match(node.time.label, /-5月-2日|-\d+月-\d+日/u);
    }
  }
});

test('大纲 shift from==to 报 SHIFT_SAME_PERIOD；任一端点可等于主导时期', () => {
  const input = makeInput();
  const context = makeContext();

  // 两端同值必须重写真实转向；不能靠篡改骰定主导时期过检。
  const same = makeCandidates();
  same.candidates.forEach(candidate => {
    (candidate as { shift?: unknown }).shift = {
      from: 'stable',
      to: 'stable',
      explanation: '解释',
    };
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(same), {
      requestId,
      directive: '墟境探索',
      input,
      context,
    }),
    /SHIFT_SAME_PERIOD|shift is degenerate/u,
  );

  // 模型写不同值:通过
  const distinct = makeCandidates();
  distinct.candidates.forEach(candidate => {
    (candidate as { shift?: unknown }).shift = {
      from: candidate.periodType,
      to: 'turbulent',
      explanation: '动荡取代过渡',
    };
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(distinct), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(parsed.candidates[0]?.shift.from, 'transition');
  assert.equal(parsed.candidates[0]?.shift.to, 'turbulent');
});

test('缺失转向不能被主导时期默默填成两端同值，提示词不再禁止合法的主导期端点', () => {
  const input = makeInput();
  const context = makeContext();
  const candidates = makeCandidates();
  (candidates.candidates[0] as { shift?: unknown }).shift = {};
  assert.throws(() => parseAndNormalizeRuinOutlines(JSON.stringify(candidates), { requestId, directive: '墟境探索', input, context }),
    (error: unknown) => error instanceof RuinValidationError && error.code === 'SHIFT_INVALID');
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId, directive: '墟境探索', generationInput: input, context, rules: { generationContract: '' } });
  assert.doesNotMatch(prompt, /Never make from equal to to or equal to periodType/u);
  assert.match(prompt, /Either endpoint may equal/u);
});

test('新出场边界在提纲和扩写两端阻止未指定谱系人物偷渡进演员表', () => {
  const input = makeInput();
  const context = makeContext();
  const candidates = makeCandidates();
  const name = candidates.candidates[0]!.cast[0]!.name;
  context.actorPolicy = scopeRuinGenealogy([{ sourceId: 'genealogy:blocked', title: '族谱', content: JSON.stringify({
    schema: 'eyon.genealogy.current.v1', nodes: [{ id: 'father', name, aliases: [], relationToFocus: '父亲', summary: '生活于梵尼亚。' }], edges: [],
  }) }], input).policy;
  assert.throws(() => parseAndNormalizeRuinOutlines(JSON.stringify(candidates), { requestId, directive: '墟境探索', input, context }),
    (error: unknown) => error instanceof RuinValidationError && error.code === 'GENEALOGY_ACTOR_NOT_REQUESTED');
  assert.throws(() => parseAndValidateRuinCandidates(JSON.stringify(candidates), { requestId, directive: '墟境探索', input, context }),
    (error: unknown) => error instanceof RuinValidationError && error.code === 'GENEALOGY_ACTOR_NOT_REQUESTED');
});

test('指定父亲的自动历史跨度不再被女儿出生年抬高，参考资料只加边界而不改原话', () => {
  const input = { ...makeInput(), start: null, end: null, supplementaryDirection: '探讨玲山父亲的发家史' };
  const context = makeContext();
  context.actorPolicy = { autoGenealogy: false, requestedSubjects: ['瓦伦·哈姆斯沃思'], referenceNames: ['玲山·哈姆斯沃思'], genealogyActors: ['瓦伦·哈姆斯沃思'], blockedGenealogy: [{ name: '玲山·哈姆斯沃思', aliases: ['玲山'] }], unresolvedRelatives: [] };
  context.evidenceBundle.personTimeline = [
    { name: '瓦伦·哈姆斯沃思', state: 'deceased', narrative: '', lifespan: { born: { era: '复兴纪元', year: 435 }, died: { era: '复兴纪元', year: 482 } } },
    { name: '玲山·哈姆斯沃思', state: 'alive', narrative: '', lifespan: { born: { era: '复兴纪元', year: 461 }, died: null } },
  ];
  const range = resolveAutomaticRuinRange(input, context, [input.supplementaryDirection]);
  assert.equal(range.input.start?.year, 435);
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId, directive: '墟境探索', generationInput: range.input, context, rules: { generationContract: '' } });
  assert.match(prompt, /<RUIN_ACTOR_POLICY_READ_ONLY>/u);
  assert.match(prompt, /探讨玲山父亲的发家史/u);
});

test('P0-C：同一 Canon 事件不得在多个独立墟境候选中换年份重复发生', () => {
  const input = makeInput();
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personCanonViews: [{
      schema: 'eyon.retrieval.person-canon-view.v1',
      entityId: 'entity:lingshan',
      canonicalName: '玲山·哈姆斯沃思',
      aliases: ['玲山'],
      requiredFactIds: ['fact:lingshan:lingyu-selected'],
      relevantFactIds: [],
      facts: [{
        factId: 'fact:lingshan:lingyu-selected',
        subjectEntityId: 'entity:lingshan',
        predicate: 'life-event:selected',
        object: '铃羽被选中前往无尽地城担任守卫',
        statement: '官方说铃羽被辉煌女神的幻梦选中去无尽地城担任守卫。',
        temporalScope: null,
        spatialScope: '梵尼亚',
        epistemicStatus: 'reported',
        confidence: 'medium',
        sourceRefs: ['worldbook:lingshan'],
        sourceSnapshotIds: ['worldbook:lingshan@sha256:fixture'],
        sourceSpans: [{ snapshotId: 'worldbook:lingshan@sha256:fixture', startOffset: 0, endOffset: 32 }],
        revisionIntroduced: 0,
        revisionRetired: null,
      }],
      sourceSnapshotIds: ['worldbook:lingshan@sha256:fixture'],
    }],
  };
  const raw = makeOutlineResponse();
  raw.candidates.forEach((candidate, index) => {
    Object.assign(candidate, {
      canonInterpretation: {
        mode: 'independent-event',
        hypothesis: `候选${index + 1}把铃羽被选中写成本候选发生的事件`,
        evidenceFactRefs: ['F1'],
        eventUsages: [{
          eventRef: 'F1',
          usage: index < 2 ? 'occurs' : 'background',
          explanation: '使用人物条目中的选中事件',
        }],
        assumptions: [],
      },
    });
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
      requestId,
      directive: '墟境探索',
      input,
      context,
    }),
    /CANON_EVENT_REUSED|multiple independent ruin candidates/u,
  );
});

test('P0-C：同一语焉不详事件允许形成有证据、彼此不同的候选解释', () => {
  const input = makeInput();
  const context = makeContext();
  const passageId = context.evidenceBundle.passages[0]!.passageId;
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personCanonViews: [{
      schema: 'eyon.retrieval.person-canon-view.v1',
      entityId: 'entity:lingshan',
      canonicalName: '玲山·哈姆斯沃思',
      aliases: ['玲山'],
      requiredFactIds: ['fact:lingshan:book-gift'],
      relevantFactIds: [],
      facts: [{
        factId: 'fact:lingshan:book-gift',
        subjectEntityId: 'entity:lingshan',
        predicate: 'life-event:received',
        object: '梅薇娜赠予《白日尽头》',
        statement: '梅薇娜当年递给我《白日尽头》。',
        temporalScope: null,
        spatialScope: null,
        epistemicStatus: 'explicit',
        confidence: 'high',
        sourceRefs: ['worldbook:lingshan'],
        sourceSnapshotIds: ['worldbook:lingshan@sha256:fixture'],
        sourceSpans: [{ snapshotId: 'worldbook:lingshan@sha256:fixture', startOffset: 0, endOffset: 20 }],
        revisionIntroduced: 0,
        revisionRetired: null,
      }],
      sourceSnapshotIds: ['worldbook:lingshan@sha256:fixture'],
    }],
  };
  const raw = makeOutlineResponse();
  const hypotheses = [
    '玲山刚抵达帝国时在边境驿站获赠此书，赠书成为她进入新闻业的启蒙。',
    '玲山已在报界调查数年后结识梅薇娜，此书成为两位业内人的正式传承信物。',
  ];
  raw.candidates.forEach((candidate, index) => {
    Object.assign(candidate, {
      canonInterpretation: index < 2 ? {
        mode: 'alternative-interpretation',
        hypothesis: hypotheses[index],
        evidenceFactRefs: ['F1'],
        evidencePassageRefs: ['P1'],
        eventUsages: [{
          eventRef: 'F1',
          usage: 'occurs',
          explanation: '保留赠书事实，只解释未写明的发生阶段',
        }],
        assumptions: [{
          claim: index === 0 ? '二人在玲山抵达帝国初期相识' : '二人在玲山进入新闻圈后相识',
          evidenceFactRefs: ['F1'],
          evidencePassageRefs: ['P1'],
          confidence: 'low',
          alternatives: [index === 0 ? hypotheses[1] : hypotheses[0]],
        }],
      } : {
        mode: 'independent-event',
        hypothesis: '第三候选讲述另一桩独立历史事件',
        evidenceFactRefs: [],
        evidencePassageRefs: ['P1'],
        eventUsages: [{
          eventRef: 'SELF',
          usage: 'occurs',
          explanation: '不重复赠书事件',
        }],
        assumptions: [],
      },
    });
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(parsed.candidates.length, 3);
  assert.deepEqual(
    parsed.candidates.slice(0, 2).map(candidate => candidate.canonInterpretation?.mode),
    ['alternative-interpretation', 'alternative-interpretation'],
  );
  assert.deepEqual(
    parsed.candidates[0]?.canonInterpretation?.evidencePassageIds,
    [passageId],
  );
});

test('P0-D：墟境 Canon 回执只接受任务短句柄，并在脚本侧解析为内部 ID', () => {
  const input = makeInput();
  const context = makeContext();
  const passageId = context.evidenceBundle.passages[0]!.passageId;
  const raw = makeOutlineResponse();
  raw.candidates.forEach((candidate, index) => {
    Object.assign(candidate, {
      canonInterpretation: {
        mode: 'independent-event',
        hypothesis: `候选${index + 1}使用本轮世界书段落解释地方历史`,
        evidenceFactRefs: [],
        evidencePassageRefs: ['P1'],
        eventUsages: [{
          eventRef: 'SELF',
          usage: 'occurs',
          explanation: '从段落证据支持的空白层构造局部事件',
        }],
        assumptions: [{
          claim: '具体执行者属于史料允许的地方空白',
          evidenceFactRefs: [],
          evidencePassageRefs: ['P1'],
          confidence: 'medium',
          alternatives: ['也可能由另一地方机构执行'],
        }],
      },
    });
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.deepEqual(parsed.candidates[0]?.canonInterpretation?.evidencePassageIds, [passageId]);

  const forged = structuredClone(raw);
  const forgedInterpretation = (forged.candidates[0] as unknown as {
    canonInterpretation: {
      evidencePassageRefs: string[];
    };
  }).canonInterpretation;
  forgedInterpretation.evidencePassageRefs = ['P999'];
  const tolerated = parseAndNormalizeRuinOutlines(JSON.stringify(forged), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.deepEqual(tolerated.candidates[0]?.canonInterpretation?.evidencePassageIds, []);
  assert.ok(tolerated.candidates[0]?.inferenceNotes.includes(
    'citation-ref-dropped:passage:P999',
  ));

  for (const legacySourceRef of [
    'worldbook:命定之诗与黄昏之歌v4.2:697939',
    'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97%E4%B8%8E%E9%BB%84%E6%98%8F%E4%B9%8B%E6%AD%8Cv4.2:697939',
  ]) {
    const misplacedSource = structuredClone(raw);
    const interpretation = (misplacedSource.candidates[0] as unknown as {
      canonInterpretation: { evidenceFactRefs: string[] };
    }).canonInterpretation;
    interpretation.evidenceFactRefs = [legacySourceRef];
    const recovered = parseAndNormalizeRuinOutlines(JSON.stringify(misplacedSource), {
      requestId,
      directive: '墟境探索',
      input,
      context,
    });
    assert.deepEqual(recovered.candidates[0]?.canonInterpretation?.evidenceFactIds, []);
    assert.ok(recovered.candidates[0]?.inferenceNotes.includes(
      `citation-ref-dropped:fact:${legacySourceRef}`,
    ));
  }
});

test('P0-D：P 句柄不能冒充事件 F 句柄，修复提示只允许任务短句柄', () => {
  const input = makeInput();
  const context = makeContext();
  const passageId = context.evidenceBundle.passages[0]!.passageId;
  const raw = makeOutlineResponse();
  raw.candidates.forEach((candidate, index) => {
    Object.assign(candidate, {
      canonInterpretation: {
        mode: 'independent-event',
        hypothesis: `候选${index + 1}解释`,
        evidenceFactRefs: [],
        evidencePassageRefs: ['P1'],
        eventUsages: [{
          eventRef: index === 0 ? 'P1' : 'SELF',
          usage: 'occurs',
          explanation: '局部事件',
        }],
        assumptions: [],
      },
    });
  });
  const tolerated = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(
    tolerated.candidates[0]?.canonInterpretation?.eventUsages[0]?.eventId,
    'invented:candidate-1:central-event',
  );
  assert.ok(tolerated.candidates[0]?.inferenceNotes.includes(
    'citation-ref-dropped:fact:P1',
  ));

  const repairPrompt = buildRuinOutlineRepairPrompt(
    'original prompt',
    'Ruin canon interpretation cites unknown fact handle: P1',
  );
  assert.match(repairPrompt, /evidenceFactRefs accepts only listed F handles/u);
  assert.match(repairPrompt, /eventRef accepts SELF or one listed F\/E handle/u);
});

test('跨度标签汉字化:同纪元省略后段纪元名,跨纪元带纪元名', () => {
  const sameEra = formatRuinSpanLabel(
    '创世纪元',
    { year: 240, month: 1, day: 15 },
    { year: 250, month: 12, day: 31 },
  );
  assert.equal(sameEra, '创世纪元240年1月15日 —— 250年12月31日');

  const crossEra = formatRuinSpanLabel(
    '创世纪元',
    { year: 240, month: 1, day: 15 },
    { year: 3, month: 5, day: 1 },
    '黄昏纪元',
  );
  assert.equal(crossEra, '创世纪元240年1月15日 —— 黄昏纪元3年5月1日');

  const partial = formatRuinSpanLabel(
    '创世纪元',
    { year: 240, month: null, day: null },
    { year: null, month: null, day: null },
  );
  assert.equal(partial, '创世纪元240年 —— （相对纪年）');
});

test('节点时间标签为角色卡风格(年-月-日-时:分,无编号后缀)', () => {
  assert.equal(
    formatRuinNodeTimeCard('创世纪元', { year: 247, month: 7, day: 7, hour: 19, minute: 30 }),
    '创世纪元247年-7月-7日-19:30',
  );
  assert.equal(
    formatRuinNodeTimeCard('创世纪元', { year: 247, month: 7, day: 7, hour: null, minute: null }),
    '创世纪元247年-7月-7日',
  );
  assert.equal(
    formatRuinNodeTimeCard('创世纪元', { year: null, month: 3, day: 5, hour: 9, minute: 5 }),
    '（相对纪年）-3月-5日-09:05',
  );
  assert.equal(
    formatRuinNodeTimeCard('创世纪元', { year: null, month: null, day: null, hour: null, minute: null }),
    '（相对纪年）',
  );
});

test('候选墟境严格核对材料、来源、时间轴和可进入特异点', () => {
  const result = makeCandidates();
  assert.deepEqual(
    parseAndValidateRuinCandidates(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input: makeInput(),
      context: makeContext(),
    }),
    result,
  );

  const reversed = structuredClone(result);
  reversed.candidates[0].nodes[2].time.day = 10;
  const normalized = parseAndValidateRuinCandidates(JSON.stringify(reversed), {
    requestId,
    directive: '墟境探索',
    input: makeInput(),
    context: makeContext(),
  });
  assert.deepEqual(
    normalized.candidates[0].nodes.map(node => node.time.day),
    [2, 10, 12, 22],
  );

  const unknownSource = structuredClone(result);
  unknownSource.candidates[0].sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateRuinCandidates(JSON.stringify(unknownSource), {
      requestId,
      directive: '墟境探索',
      input: makeInput(),
      context: makeContext(),
    }),
    /Unknown source reference/u,
  );
});

test('候选生成只落入当前聊天命名空间，不改世界变量也不自动进入', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const prompts: string[] = [];
  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const workflow = new RuinWorkflow({
    contextAssembler: {
      async assemble() {
        return makeContext();
      },
    },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'ruin');
        assert.match(prompt, /寻找一处能够由个人选择改变的历史裂点/u);
        prompts.push(prompt);
        return JSON.stringify(
          prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')
            ? makeOutlineResponse()
            : makeCandidateResponse(prompt),
        );
      },
    },
    repository,
    rules: {
      generationContract: '生成契约',
    },
    createRequestId() {
      return requestId;
    },
    now() {
      return 1000;
    },
    async assertCurrent() {},
  });

  const record = await workflow.generate(command, makeInput(), {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.equal(
    (await repository.get(ruinCandidateRecordKey(namespace, requestId)))?.requestId,
    requestId,
  );
  assert.equal(prompts.length, 4);
  assert.match(prompts[0], /<RUIN_OUTLINE_BATCH_TASK>/u);
  assert.match(prompts[0], /eyon\.ruin\.outlines\.v1/u);
  assert.match(prompts[0], /selected biography is continuity evidence, not an actor quota/iu);
  assert.match(prompts[0], /silently read any selected biography as a chronology/iu);
  assert.match(prompts[0], /do not move a later named person, unique object, ritual, institution, construction or final closure/iu);
  assert.match(prompts[0], /earlier local precursor remains allowed/iu);
  assert.doesNotMatch(prompts[0], /historyProse/u);
  assert.ok(prompts.slice(1).every(prompt =>
    prompt.includes('<RUIN_SELECTED_CANDIDATE_EXPANSION>')));
  assert.ok(prompts.slice(1).every(prompt =>
    /natural-language consistency read/iu.test(prompt)));
  assert.deepEqual(
    new Set(record.expandedCandidateIds),
    new Set(record.result.candidates.map(candidate => candidate.id)),
  );
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );
  assert.equal(record.result.candidates[0].nodes[2].enterable, true);
  const entryText = buildRuinEntryContract(
    record,
    record.result.candidates[0].id,
    'node-anomaly',
    {
      time: '复兴纪元488年5月10日 14:28',
      location: '布劳尔子爵城堡仪式大厅',
    },
  );
  assert.match(entryText, /^进入节点\n\n【历史工作台·单楼进入契约】/u);
  assert.match(entryText, /现实锚点时间：复兴纪元488年5月10日 14:28/u);
  assert.match(entryText, /直接承接上一楼尚未结束的动作/u);
  assert.equal(entryText.split('[RuinTrace]').length - 1, 1);
  assert.match(entryText, /Type:: 过渡期/u);
  // 转变方向只显示时期演变,不含解说(模型 explanation 不进入面板)
  assert.match(entryText, /Shift:: 稳定期 → 过渡期/u);
  assert.doesNotMatch(entryText, /解释权已经发生转移/u);
  // 变量更新规则段:完整 11 条 JSON Patch 路径
  assert.match(entryText, /<VARIABLE_UPDATE_RULES>/u);
  assert.match(entryText, /<\/VARIABLE_UPDATE_RULES>/u);
  for (const path of RUIN_ENTRY_PATCH_FIELDS) {
    assert.ok(entryText.includes(`"path":"${path}"`), `契约应包含路径 ${path}`);
  }
  // internal.84 墟境轮次规范化：脚本给定轮次标识，模型逐字照抄。
  const runIdMatch = entryText.match(/本轮轮次标识：(Ruin-[^\n]+)/u);
  assert.ok(runIdMatch, '契约应包含脚本给定的本轮轮次标识');
  const runId = runIdMatch![1]!.trim();
  assert.match(runId, /^Ruin-node-anomaly-[0-9a-z]{1,8}$/u, '轮次标识应由脚本按统一格式生成');
  assert.ok(
    entryText.includes(`"path":"/墟境系统/运行状态/墟境轮次","value":"${runId}"`),
    '变量更新规则中墟境轮次的确切值应等于脚本给定的轮次标识',
  );
  assert.match(entryText, /轮次必须逐字复制上方「本轮轮次标识」/u);
  assert.doesNotMatch(entryText, /本轮唯一新轮次/u, '不再让模型自造轮次值');
  const originEntry = buildRuinEntryContract(
    record,
    record.result.candidates[0].id,
    'node-origin',
    {
      time: '复兴纪元488年5月10日 14:28',
      location: '布劳尔子爵城堡仪式大厅',
    },
  );
  assert.match(originEntry, /历史阶段：缘起/u);
  assert.match(originEntry, /可调查、阻止或改变关键前提/u);

  const projectedEntries = record.result.candidates[0].nodes.map(node =>
    buildRuinEntryContract(
      record,
      record.result.candidates[0].id,
      node.id,
      {
        time: '复兴纪元488年5月10日 14:28',
        location: '布劳尔子爵城堡仪式大厅',
      },
    ));
  const sceneProjections = projectedEntries.map(contract => {
    assert.match(contract, /节点场景投影（本楼唯一当前现场）/u);
    assert.match(contract, /禁止提前演出后续节点/u);
    const history = contract.match(/^History:: (.+)$/mu)?.[1];
    assert.equal(
      history,
      record.result.candidates[0].historyProse,
      '四个入口的可见 History 都应使用同一份完整墟境史稿',
    );
    const projection = contract.match(/^节点场景投影（本楼唯一当前现场）：(.+)$/mu)?.[1];
    assert.ok(projection, '每个进入契约都应保留节点专属隐藏场景投影');
    return projection;
  });
  assert.equal(
    new Set(sceneProjections).size,
    4,
    '缘起、经过、高潮、结果必须拥有四份不同的隐藏当前现场投影',
  );
});

test('进入变量更新规则段与时间内核白名单不漂移', () => {
  const rules = buildRuinEntryVariableRules('Ruin-node-1-1-abc12345');
  // 规则段包含全部进入路径
  for (const path of RUIN_ENTRY_PATCH_FIELDS) {
    assert.ok(rules.includes(`"path":"${path}"`), `规则段应包含 ${path}`);
  }
  // 每个运行状态路径都在内核白名单内(世界时地由内核 isAllowedPatchPath 单独放行)
  for (const path of RUIN_ENTRY_PATCH_FIELDS) {
    if (path === '/世界/时间' || path === '/世界/地点') continue;
    const field = path.slice('/墟境系统/运行状态/'.length);
    assert.ok(RUNTIME_FIELDS.has(field), `内核白名单应包含 ${field}`);
  }
  // 规则段禁止整根替换的说明
  assert.match(rules, /禁止整根 insert\/replace/u);
  // internal.84：轮次字段使用脚本给定的确切值（逐字复制，不自造）
  assert.ok(
    rules.includes('"path":"/墟境系统/运行状态/墟境轮次","value":"Ruin-node-1-1-abc12345"'),
    '轮次字段示例值应为脚本给定的轮次标识',
  );
  assert.match(rules, /禁止自造、改写或沿用旧轮次/u);
});

test('G-01 简写地点只用于玩家输入，入境写回采用同一条4～8层MVU路径', () => {
  const record = makeRecord();
  assert.equal(record.input.location, '布劳尔旧堡');
  const expected = '大陆中西部-奥古斯提姆帝国-布劳尔子爵领-布劳尔旧堡-内堡';
  assert.equal(isValidMvuLocation(expected), true);
  const contract = buildRuinEntryContract(
    record,
    'ruin-1',
    'node-process',
    { time: '复兴纪元488年5月10日 14:28', location: '现实地点' },
  );
  assert.match(contract, new RegExp(`目标墟境地点：${expected}`, 'u'));
  assert.equal(contract.split('（即上方「目标墟境地点」，逐字复制）').length - 1, 3);
  assert.match(contract, /按实际情况保留4～8层/u);
});

test('G-01 旧候选可用完整父级路径补足末端地点，双方都为简称时拒绝伪造', () => {
  assert.equal(
    resolveRuinEntryLocation(
      '东廊档案室',
      '大陆东部-奥古斯提姆帝国-艾瑟嘉德-观潮阁',
    ),
    '大陆东部-奥古斯提姆帝国-艾瑟嘉德-观潮阁-东廊档案室',
  );
  assert.throws(
    () => resolveRuinEntryLocation('东廊档案室', '观潮阁'),
    /无法安全写入角色卡要求的 4～8 层地点路径/u,
  );
});

test('G-01 缘起、经过、高潮、结果四阶段都能构建进入契约', () => {
  const record = makeRecord();
  const expected = [
    ['node-origin', '缘起'],
    ['node-process', '经过'],
    ['node-anomaly', '高潮'],
    ['node-result', '结果'],
  ] as const;
  for (const [nodeId, label] of expected) {
    const contract = buildRuinEntryContract(
      record,
      'ruin-1',
      nodeId,
      { time: '复兴纪元488年5月10日 14:28', location: '现实地点' },
    );
    assert.match(contract, new RegExp(`历史阶段：${label}`, 'u'));
  }
});

test('internal.84：轮次标识确定性生成（同输入同值、不同轮次不同值、非法字符清洗）', () => {
  assert.equal(
    buildRuinRunId('ad6910f2-60ee-4060-8622-95e20a9fabbb', 'node-2-3'),
    'Ruin-node-2-3-ad6910f2',
  );
  assert.equal(
    buildRuinRunId('ad6910f2-60ee-4060-8622-95e20a9fabbb', 'node-2-3'),
    buildRuinRunId('ad6910f2-60ee-4060-8622-95e20a9fabbb', 'node-2-3'),
    '同输入确定性同值',
  );
  assert.notEqual(
    buildRuinRunId('ad6910f2-60ee-4060-8622-95e20a9fabbb', 'node-2-3'),
    buildRuinRunId('ffffffff-0000-0000-0000-000000000000', 'node-2-3'),
    '不同轮次（requestId）不同值',
  );
  assert.equal(buildRuinRunId('', 'node-1-1'), 'Ruin-node-1-1-run');
});

test('进入特异点的玩家楼文本决议:空/空白/命令格式回退默认语,正常输入原样保留', () => {
  assert.equal(resolveRuinEntryPlayerText(null), RUIN_ENTRY_DEFAULT_PHRASE);
  assert.equal(resolveRuinEntryPlayerText(''), RUIN_ENTRY_DEFAULT_PHRASE);
  assert.equal(resolveRuinEntryPlayerText('   \n\t '), RUIN_ENTRY_DEFAULT_PHRASE);
  // 仍存在的文本命令格式回退默认语（防止玩家楼被 beforeGeneration 误判为命令）
  assert.equal(resolveRuinEntryPlayerText('进入节点，我准备好了'), RUIN_ENTRY_DEFAULT_PHRASE);
  // β1.1：「墟境探索」已不是命令，作为玩家原话原样保留（聊天里它只换来引导）
  assert.equal(
    resolveRuinEntryPlayerText('请墟境探索：帮我看看这处裂点'),
    '请墟境探索：帮我看看这处裂点',
  );
  // contains 陷阱:自然语言中包含「寻根溯源」也会被 parseTextCommand 判定为命令
  assert.equal(resolveRuinEntryPlayerText('我们一起去寻根溯源吧'), RUIN_ENTRY_DEFAULT_PHRASE);
  // 正常玩家输入:原样保留(仅 trim)
  assert.equal(
    resolveRuinEntryPlayerText(' 我踏入这处特异点，看看墙上的壁画 '),
    '我踏入这处特异点，看看墙上的壁画',
  );
  assert.equal(
    resolveRuinEntryPlayerText('我踏入这处历史特异点。'),
    RUIN_ENTRY_DEFAULT_PHRASE,
  );
});

test('未完成史稿不能绕过界面直接进入特异点', () => {
  const record = makeRecord();
  record.expandedCandidateIds = record.expandedCandidateIds.filter(id => id !== 'ruin-1');
  if (record.candidateStates) {
    record.candidateStates['ruin-1'] = {
      status: 'pending',
      attempt: 0,
      generationEpoch: 0,
      updatedAt: 1000,
    };
  }
  assert.throws(
    () => buildRuinEntryContract(record, 'ruin-1', 'node-anomaly', {
      time: '复兴纪元488年5月10日 14:28',
      location: '布劳尔子爵城堡仪式大厅',
    }),
    /先完成并查看这份墟境史稿/u,
  );
});

test('GB-09 墟境生成先重投影已选谱系人物，旧关系不进入检索或正文请求', async () => {
  const input = makeInput();
  input.selectedCharacters = [{ referenceId: 'genealogy:tree:node', mvuId: 'ref', name: '阿黛拉', source: 'genealogy',
    race: '人类', identities: [], professions: ['史官'], relations: ['已经失效的亲缘'], lifespan: '不详', contextSummary: '旧短传残留' }];
  let resolved = false;
  const workflow = new RuinWorkflow({
    async resolveSelectedCharacters(selected) {
      resolved = true;
      return selected.map(person => ({ ...person, relations: [], contextSummary: '仅供辨识' }));
    },
    contextAssembler: { async assemble(request) {
      assert.ok(resolved);
      assert.doesNotMatch(request.directive, /已经失效的亲缘|旧短传残留/);
      return makeContext();
    } },
    generator: { async generate(_task, prompt) {
      assert.doesNotMatch(prompt, /已经失效的亲缘|旧短传残留/);
      return JSON.stringify(prompt.includes('<RUIN_OUTLINE_BATCH_TASK>') ? makeOutlineResponse() : makeCandidateResponse(prompt));
    } },
    repository: new MemoryRuinCandidateRepository(), rules: { generationContract: '测试' },
    createRequestId: () => requestId, now: () => 1, async assertCurrent() {},
  });
  const record = await workflow.generate(createButtonCommand('ruin.generate', '墟境探索'), input,
    { namespace, triggerMessageId: 8, triggerTextHash: 'hash', triggerSwipeId: 0, lifecycleEpoch: 0 });
  assert.equal(record.input.selectedCharacters[0].contextSummary, '仅供辨识');
  assert.equal(input.selectedCharacters[0].contextSummary, '旧短传残留');
});

test('谱系人物节点只进入墟境初始检索，候选扩写与重试复用冻结证据', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const directives: string[] = [];
  const input = makeInput();
  input.selectedCharacters = [{
    mvuId: 'genealogy-aunt-1',
    referenceId: 'genealogy:genealogy-1:aunt-1',
    name: '阿黛拉',
    source: 'genealogy',
    race: '人类',
    identities: ['父系姑母'],
    professions: ['宫廷史官'],
    relations: ['谱系中心人物的父系姑母'],
    lifespan: '复兴纪元400年—复兴纪元470年',
    contextSummary: '整理过布劳尔旧堡的继承档案，但不会在复兴纪元145年亲自出场。',
  }];
  const workflow = new RuinWorkflow({
    contextAssembler: {
      async assemble(request) {
        directives.push(request.directive);
        return makeContext();
      },
    },
    generator: {
      async generate(_taskType, prompt) {
        return JSON.stringify(
          prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')
            ? makeOutlineResponse()
            : makeCandidateResponse(prompt),
        );
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  };

  const record = await workflow.generate(command, input, identity);

  assert.equal(directives.length, 1);
  assert.match(directives[0], /genealogy:genealogy-1:aunt-1/u);
  assert.match(directives[0], /阿黛拉/u);
  assert.match(directives[0], /宫廷史官/u);
  assert.match(directives[0], /整理过布劳尔旧堡的继承档案/u);

  const firstCandidate = record.result.candidates[0];
  const failedRecord = structuredClone(record);
  assert.ok(failedRecord.candidateStates);
  failedRecord.candidateStates[firstCandidate.id] = {
    status: 'failed',
    attempt: 1,
    generationEpoch: 1,
    updatedAt: 1001,
    error: { phase: 'transport', message: 'temporary failure' },
  };
  await repository.replace(failedRecord);
  await workflow.retryCandidate(record.key, firstCandidate.id, identity);

  assert.equal(directives.length, 1);
  assert.equal(record.frozenContext?.sourceHash, record.sourceHash);
});

test('候选提纲建立后先扩写全部史稿，再交给玩家比较选择', async () => {
  const repository = new MemoryRuinCandidateRepository();
  let calls = 0;
  let contextCalls = 0;
  const workflow = new RuinWorkflow({
    contextAssembler: {
      async assemble() {
        contextCalls += 1;
        return makeContext();
      },
    },
    generator: {
      async generate(_taskType, prompt) {
        calls += 1;
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
          return JSON.stringify(makeOutlineResponse());
        }
        const response = makeCandidateResponse(prompt);
        response.candidate.historyProse = `${'史'.repeat(705)}。`;
        return JSON.stringify(response);
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });

  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  };
  const record = await workflow.generate(command, makeInput(), identity);

  assert.equal(calls, 4);
  assert.equal(contextCalls, 1);
  assert.deepEqual(
    new Set(record.expandedCandidateIds),
    new Set(record.result.candidates.map(candidate => candidate.id)),
  );
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );

  const selectedId = record.result.candidates[0].id;
  const expanded = await workflow.expandCandidate(record.key, selectedId, identity);
  const candidate = expanded.result.candidates.find(item => item.id === selectedId);
  assert.ok(candidate);
  assert.equal(calls, 4);
  assert.equal(contextCalls, 1);
  assert.deepEqual(
    expanded.result.candidates.map(item => ruinCandidateState(expanded, item.id).status),
    ['ready', 'ready', 'ready'],
  );
  assert.ok((candidate.historyProse.match(/\p{Script=Han}/gu)?.length ?? 0) <= 650);
  assert.match(candidate.historyProse, /。$/u);
});

test('P4-C2 较早时间窗的全部候选通过整段截止复核后才进入 ready', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const context = makeContext();
  context.continuityView = makeHistoricalAmbiguityView();
  const input = makeInput();
  input.start = { year: 484, month: 1, day: 1 };
  input.end = { year: 484, month: 12, day: 31 };
  const outlineResponse = makeOutlineResponse(input);
  for (const candidate of outlineResponse.candidates) {
    candidate.span.start = { year: 484, month: 8, day: 1 };
    candidate.span.end = { year: 484, month: 11, day: 30 };
    candidate.span.label = '复兴纪元484年8月 - 11月';
    candidate.nodes.forEach((node, index) => {
      node.time = {
        ...node.time,
        year: 484,
        month: 8 + index,
        day: 1,
        label: `复兴纪元484年${8 + index}月1日`,
      };
    });
  }
  const prompts: string[] = [];
  const workflow = new RuinWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(_taskType, prompt) {
        prompts.push(prompt);
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
          return JSON.stringify(outlineResponse);
        }
        if (prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>')) {
          return '{"verdict":"PASS"}';
        }
        const fixed = /Copy these fixed fields exactly:\s*(\{[^\r\n]+\})/u.exec(prompt)?.[1];
        assert.ok(fixed);
        const header = JSON.parse(fixed) as {
          requestId: string;
          candidateKey: string;
        };
        const response = makeExpansionResponse(`ruin-${header.candidateKey}`);
        response.requestId = header.requestId;
        if (prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>')) {
          response.candidate.summary = '截至484年冬，交接仍待后续手续确认。';
          response.candidate.fusion.historicalResult = '当时只留下未结案收执与待勘条件。';
          response.candidate.shift.explanation = '未结案手续让两种可能继续并存。';
          response.candidate.nodes[3]!.summary = '泊位只留下尚待履行的交割约定。';
          response.candidate.historyProse = `截至复兴纪元484年冬，众人只完成临时交验；正本是否会在别的时点正式入库仍无人知晓。${'史'.repeat(520)}。`;
        } else {
          response.candidate.summary = '次年正式入库并被后世定为唯一版本。';
          response.candidate.fusion.historicalResult = '485年全帙入库成为最终结论。';
          response.candidate.shift.explanation = '后世因此确认485年才是真正移交。';
          response.candidate.nodes[3]!.summary = '次年手续完成并永久结案。';
          response.candidate.historyProse = `次年全帙正式入库，后世据此确认唯一移交年份。${'史'.repeat(520)}。`;
        }
        return JSON.stringify(response);
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const record = await workflow.generate(createButtonCommand('ruin.generate', '墟境探索'), input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });

  assert.equal(
    prompts.filter(prompt => prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>')).length,
    3,
  );
  assert.equal(
    prompts.filter(prompt => prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>')).length,
    3,
  );
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );
  for (const candidate of record.result.candidates) {
    assert.match(candidate.historyProse, /仍无人知晓/u);
    assert.doesNotMatch(candidate.historyProse, /后世据此确认唯一移交年份/u);
    assert.match(candidate.summary, /仍待后续手续确认/u);
    assert.match(candidate.fusion.historicalResult, /未结案/u);
    assert.match(candidate.shift.explanation, /继续并存/u);
    assert.match(candidate.nodes[3]!.summary, /尚待履行/u);
  }
});

test('P4-C2 较早时间窗裁决 BLOCK 时只让该候选进入可重试失败态', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const context = makeContext();
  context.continuityView = makeHistoricalAmbiguityView();
  const input = makeInput();
  input.start = { year: 484, month: 1, day: 1 };
  input.end = { year: 484, month: 12, day: 31 };
  const outlineResponse = makeOutlineResponse(input);
  for (const candidate of outlineResponse.candidates) {
    candidate.span.start = { year: 484, month: 8, day: 1 };
    candidate.span.end = { year: 484, month: 11, day: 30 };
    candidate.span.label = '复兴纪元484年8月 - 11月';
    candidate.nodes.forEach((node, index) => {
      node.time = { ...node.time, year: 484, month: 8 + index, day: 1 };
    });
  }
  let blockedOnce = false;
  const workflow = new RuinWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(_taskType, prompt) {
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) return JSON.stringify(outlineResponse);
        if (prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>')) {
          if (prompt.includes('candidate candidate-1') && !blockedOnce) {
            blockedOnce = true;
            return '{"verdict":"BLOCK"}';
          }
          return '{"verdict":"PASS"}';
        }
        const fixed = /Copy these fixed fields exactly:\s*(\{[^\r\n]+\})/u.exec(prompt)?.[1];
        assert.ok(fixed);
        const header = JSON.parse(fixed) as { requestId: string; candidateKey: string };
        const response = makeExpansionResponse(`ruin-${header.candidateKey}`);
        response.requestId = header.requestId;
        return JSON.stringify(response);
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const record = await workflow.generate(createButtonCommand('ruin.generate', '墟境探索'), input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['failed', 'ready', 'ready'],
  );
  assert.equal(record.expandedCandidateIds.includes('ruin-candidate-1'), false);
});

test('墟境已校验史稿写错已知人物明确年龄时只做一次软复核', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '档案官',
      state: 'alive',
      narrative: '档案官出生于复兴纪元125年。',
      lifespan: { born: { era: '复兴纪元', year: 125 } },
    }],
  };
  const prompts: string[] = [];
  const workflow = new RuinWorkflow({
    contextAssembler: { async assemble() { return context; } },
    generator: {
      async generate(_taskType, prompt) {
        prompts.push(prompt);
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
          return JSON.stringify(makeOutlineResponse());
        }
        if (prompt.includes('<RUIN_KNOWN_PERSON_LOCAL_REVIEW>')) {
          const response = makeCandidateResponse(prompt);
          response.candidate.historyProse = `二十岁的档案官核对封蜡见证。${'史'.repeat(705)}。`;
          return JSON.stringify(response);
        }
        const response = makeCandidateResponse(prompt);
        response.candidate.historyProse = prompt.includes('"candidateKey":"candidate-1"')
          ? `十二岁的档案官核对封蜡见证。${'史'.repeat(705)}。`
          : `${'史'.repeat(705)}。`;
        return JSON.stringify(response);
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  };
  const record = await workflow.generate(command, makeInput(), identity);
  const first = record.result.candidates.find(candidate => candidate.candidateKey === 'candidate-1');
  assert.ok(first);
  assert.match(first.historyProse, /二十岁的档案官/u);
  assert.doesNotMatch(first.historyProse, /十二岁的档案官/u);
  assert.equal(prompts.filter(prompt => prompt.includes('<RUIN_KNOWN_PERSON_LOCAL_REVIEW>')).length, 1);
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );
});

test('墟境人物年龄软复核失败时保留已校验史稿，不截断整批', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '档案官',
      state: 'alive',
      narrative: '',
      lifespan: { born: { era: '复兴纪元', year: 125 } },
    }],
  };
  let reviewAttempts = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const workflow = new RuinWorkflow({
      contextAssembler: { async assemble() { return context; } },
      generator: {
        async generate(_taskType, prompt) {
          if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
            return JSON.stringify(makeOutlineResponse());
          }
          if (prompt.includes('<RUIN_KNOWN_PERSON_LOCAL_REVIEW>')) {
            reviewAttempts += 1;
            throw new Error('optional ruin review transport failed');
          }
          const response = makeCandidateResponse(prompt);
          response.candidate.historyProse = prompt.includes('"candidateKey":"candidate-1"')
            ? `十二岁的档案官核对封蜡见证。${'史'.repeat(705)}。`
            : `${'史'.repeat(705)}。`;
          return JSON.stringify(response);
        },
      },
      repository,
      rules: { generationContract: '生成契约' },
      createRequestId: () => requestId,
      now: () => 1000,
      async assertCurrent() {},
    });
    const command = createButtonCommand('ruin.generate', '墟境探索');
    assert.ok(command);
    const record = await workflow.generate(command, makeInput(), {
      namespace,
      triggerMessageId: 8,
      triggerTextHash: 'hash',
      triggerSwipeId: 0,
      lifecycleEpoch: 0,
    });
    assert.equal(reviewAttempts, 1);
    assert.deepEqual(
      record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
      ['ready', 'ready', 'ready'],
    );
    assert.match(
      record.result.candidates.find(candidate => candidate.candidateKey === 'candidate-1')?.historyProse ?? '',
      /十二岁的档案官/u,
    );
  } finally {
    console.warn = originalWarn;
  }
});

test('候选首次格式偏差在槽位内部纠正，不触发整批重试', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const prompts: string[] = [];
  let firstCandidateCalls = 0;
  const workflow = new RuinWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(_taskType, prompt) {
        prompts.push(prompt);
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
          return JSON.stringify(makeOutlineResponse());
        }
        if (prompt.includes('"candidateKey":"candidate-1"')) {
          firstCandidateCalls += 1;
          if (firstCandidateCalls === 1) return '不是合法 JSON';
        }
        return JSON.stringify(makeCandidateResponse(prompt));
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  };
  const record = await workflow.generate(command, makeInput(), identity);

  assert.equal(firstCandidateCalls, 2);
  assert.equal(prompts.length, 5);
  assert.match(prompts[2], /LOCAL_REPAIR/u);
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );
  assert.deepEqual(
    record.result.candidates.map(candidate => ruinCandidateState(record, candidate.id).attempt),
    [1, 1, 1],
  );
});

test('单个候选连续失败后可手动重试，且不改写其他成功候选', async () => {
  const repository = new MemoryRuinCandidateRepository();
  let failFirstCandidate = true;
  const progress: string[] = [];
  const workflow = new RuinWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(_taskType, prompt) {
        if (prompt.includes('<RUIN_OUTLINE_BATCH_TASK>')) {
          return JSON.stringify(makeOutlineResponse());
        }
        if (
          failFirstCandidate
          && prompt.includes('"candidateKey":"candidate-1"')
        ) {
          return '仍然不是合法 JSON';
        }
        return JSON.stringify(makeCandidateResponse(prompt));
      },
    },
    repository,
    rules: { generationContract: '生成契约' },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
    onCandidateProgress(event) {
      progress.push(`${event.stage}:${event.candidateIndex}`);
    },
  });
  const command = createButtonCommand('ruin.generate', '墟境探索');
  assert.ok(command);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  };
  const generated = await workflow.generate(command, makeInput(), identity);
  const failedCandidateId = generated.result.candidates[0].id;
  const partial = await repository.get(generated.key);
  assert.ok(partial);
  assert.deepEqual(
    partial.result.candidates.map(candidate => ruinCandidateState(partial, candidate.id).status),
    ['failed', 'ready', 'ready'],
  );
  assert.equal(
    ruinCandidateState(partial, failedCandidateId).error?.phase,
    'parse',
  );
  assert.ok(progress.includes('failed:1'));
  const preserved = structuredClone(partial.result.candidates.slice(1));

  failFirstCandidate = false;
  const retried = await workflow.retryCandidate(
    partial.key,
    failedCandidateId,
    identity,
  );
  assert.equal(ruinCandidateState(retried, failedCandidateId).status, 'ready');
  assert.equal(ruinCandidateState(retried, failedCandidateId).attempt, 2);
  assert.deepEqual(retried.result.candidates.slice(1), preserved);
  assert.deepEqual(
    new Set(retried.expandedCandidateIds),
    new Set(retried.result.candidates.map(candidate => candidate.id)),
  );
  assert.deepEqual(
    retried.result.candidates.map(candidate => ruinCandidateState(retried, candidate.id).status),
    ['ready', 'ready', 'ready'],
  );
});

test('楼层、swipe、聊天或生命周期变化后，候选事务拒绝提交', async () => {
  const mutations: Array<(runtime: RuinRuntime, guard: RuinTransactionGuard) => void> = [
    runtime => {
      runtime.chatId = '另一存档';
    },
    runtime => {
      runtime.messages.get(8)!.message = '编辑后的内容';
    },
    runtime => {
      runtime.messages.get(8)!.swipe_id = 1;
    },
    (_runtime, guard) => {
      guard.cancelAll();
    },
  ];

  for (const mutate of mutations) {
    const runtime = new RuinRuntime();
    const guard = new RuinTransactionGuard();
    const assertCurrent = createRuinIdentityAssertion(runtime, guard);
    const identity = {
      namespace,
      triggerMessageId: 8,
      triggerTextHash: fingerprintText('墟境探索'),
      triggerSwipeId: 0,
      lifecycleEpoch: guard.currentEpoch(),
    };
    mutate(runtime, guard);
    await assert.rejects(() => assertCurrent(identity));
  }
});

test('候选生成期间允许聊天自然推进，但原始锚点必须保持不变', async () => {
  const runtime = new RuinRuntime();
  const guard = new RuinTransactionGuard();
  const assertCurrent = createRuinIdentityAssertion(runtime, guard);
  const identity = {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: fingerprintText('墟境探索'),
    triggerSwipeId: 0,
    lifecycleEpoch: guard.currentEpoch(),
  };

  runtime.lastMessageId = 9;
  await assert.doesNotReject(() => assertCurrent(identity));
});

test('聊天文本不再触发任何候选生成链路（β1.1：探索与谱系只能在工作台发起）', async () => {
  const runtime = new RuinRuntime();
  const calls: string[] = [];
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText(text) {
        calls.push(`biography:${text}`);
        return {};
      },
      async commitRendered() {
        return null;
      },
      async cancelPending() {
        calls.push('biography:cancel');
      },
    },
    ruin: {
      async generateFromText(text) {
        calls.push(`ruin:${text}`);
        return {};
      },
      cancelPending() {
        calls.push('ruin:cancel');
      },
    },
    ruinInputProvider: {
      async getInput(command) {
        calls.push(`input:${command.type}`);
        return makeInput();
      },
    },
    genealogy: {
      async generateFromText() {
        calls.push('genealogy');
        return {};
      },
      cancelPending() {
        calls.push('genealogy:cancel');
      },
    },
    genealogyInputProvider: {
      async getInput() {
        throw new Error('genealogy input should not be requested');
      },
    },
  });

  // β1.1：聊天文本不再进入任何候选生成链路——「墟境探索」在聊天里只会被角色卡
  // 引导去工作台，因此生命周期不得路由、不得请求生成条件、更不得掐掉生成。
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.deepEqual(calls, []);

  runtime.messages.get(8)!.message = '我只是在讨论一段墟境历史';
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.equal(await lifecycle.beforeGeneration('continue'), false);
  await lifecycle.onChatChanged();
  assert.deepEqual(
    calls.slice(-3),
    ['ruin:cancel', 'genealogy:cancel', 'biography:cancel'],
  );
});

test('遣返玩家楼由 MESSAGE_SENT 启动一次准备，生成前等待同一事务', async () => {
  const runtime = new RuinRuntime();
  runtime.messages.get(8)!.message = '好了，我跑到了他们看不到的地方，任务完成，遣返吧，伊雍——';
  let prepareCount = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText() { return null; },
      async commitRendered() { return null; },
      async cancelPending() {},
    },
    ruin: {
      async generateFromText() { return null; },
      cancelPending() {},
    },
    ruinInputProvider: {
      async getInput() { throw new Error('ruin input should not be requested'); },
    },
    genealogy: {
      async generateFromText() { return null; },
      cancelPending() {},
    },
    genealogyInputProvider: {
      async getInput() { throw new Error('genealogy input should not be requested'); },
    },
    butterfly: {
      async prepareText(text) {
        prepareCount += 1;
        assert.equal(text, runtime.messages.get(8)!.message);
        await gate;
        return {};
      },
      async commitRendered() { return null; },
      async onChatChanged() {},
    },
  });

  const sent = lifecycle.onUserMessageSent(8);
  const beforeGeneration = lifecycle.beforeGeneration('normal');
  let generationReleased = false;
  void beforeGeneration.then(() => { generationReleased = true; });
  await Promise.resolve();
  assert.equal(generationReleased, false, '蝴蝶准备未完成时，生成前钩子仍须等待');
  assert.equal(prepareCount, 1);
  release?.();
  assert.equal(await sent, true);
  assert.equal(await beforeGeneration, true);
  assert.equal(prepareCount, 1);
});

test('MESSAGE_SENT 对普通正文零副作用，缺失事件时生成前仍可兜底遣返', async () => {
  const runtime = new RuinRuntime();
  let prepareCount = 0;
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText() { return null; },
      async commitRendered() { return null; },
      async cancelPending() {},
    },
    ruin: {
      async generateFromText() { return null; },
      cancelPending() {},
    },
    ruinInputProvider: {
      async getInput() { throw new Error('ruin input should not be requested'); },
    },
    genealogy: {
      async generateFromText() { return null; },
      cancelPending() {},
    },
    genealogyInputProvider: {
      async getInput() { throw new Error('genealogy input should not be requested'); },
    },
    butterfly: {
      async prepareText() {
        prepareCount += 1;
        return {};
      },
      async commitRendered() { return null; },
      async onChatChanged() {},
    },
  });

  runtime.messages.get(8)!.message = '我只是再吃一串烤肉';
  assert.equal(await lifecycle.onUserMessageSent(8), false);
  assert.equal(await lifecycle.beforeGeneration('normal'), false);
  assert.equal(prepareCount, 0);

  runtime.messages.get(8)!.message = '任务完成，遣返吧';
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.equal(prepareCount, 1);

  await lifecycle.onUserMessageSent(8);
  assert.equal(prepareCount, 2);
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.equal(prepareCount, 2, '同楼未变动仍复用 MESSAGE_SENT 准备');
  let release!: () => void;
  const rollback = new Promise<void>(resolve => { release = resolve; });
  lifecycle.resetReturnPreparation(rollback);
  let releaseSecond!: () => void;
  const secondRollback = new Promise<void>(resolve => { releaseSecond = resolve; });
  lifecycle.resetReturnPreparation(secondRollback);
  lifecycle.resetReturnPreparation(); // 点击停止也不能绕过尚在对账的回滚。
  const afterRollback = lifecycle.beforeGeneration('normal');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepareCount, 2, '须等待回滚存储对账完成');
  releaseSecond(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(prepareCount, 2, '连续删楼需等全部回滚屏障，不只最后一个');
  release(); assert.equal(await afterRollback, true);
  assert.equal(prepareCount, 3, '回滚后不能复用同楼旧 Promise');
});

test('同一楼层同一输入的重复调用复用同一生成事务', async () => {
  const runtime = new RuinRuntime();
  let calls = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const record = makeRecord();
  const workflow = {
    async generate() {
      calls += 1;
      await pending;
      return record;
    },
  } as unknown as RuinWorkflow;
  const guard = new RuinTransactionGuard();
  const controller = new RuinController(workflow, runtime, {}, guard);

  // β1.1：文本入口已撤，界面路径改用 generateFromPanel（同一 generate 事务与去重键）。
  const first = controller.generateFromPanel(makeInput());
  const second = controller.generateFromPanel(makeInput());
  assert.equal(calls, 1);
  release?.();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
});

test('进入特异点:玩家楼=玩家原话(空输入回退默认语),契约进注入层', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const sent: string[] = [];
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() {
        return namespace;
      },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() {
        return '';
      },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        sent.push(text);
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  const submission = await workflow.enter(
    record.key,
    record.result.candidates[0].id,
    'node-anomaly',
    '我踏入这处特异点，看看墙上的壁画',
  );
  assert.equal(submission.messageId, 9);
  assert.equal(submission.playerText, '我踏入这处特异点，看看墙上的壁画');
  // 玩家楼 = 玩家原话,不含契约
  assert.equal(sent.length, 1);
  assert.equal(sent[0], '我踏入这处特异点，看看墙上的壁画');
  // 契约进入注入层(常驻注入 in_chat / depth 0 / system,与传记同款通道)
  assert.equal(runtime.extensionPrompts.length, 1);
  const injection = runtime.extensionPrompts[0];
  assert.equal(injection.position, 1);
  assert.equal(injection.depth, 0);
  assert.equal(injection.role, 0);
  assert.match(injection.value, /现实锚点时间：复兴纪元488年5月10日 14:31/u);
  assert.match(injection.value, /目标墟境地点：大陆中西部-奥古斯提姆帝国-布劳尔子爵领-布劳尔旧堡-内堡/u);
  assert.match(injection.value, /流程状态更新为 exploring/u);
  assert.match(submission.contractText, /【历史工作台·单楼进入契约】/u);
  // 同节点二次进入被拒
  await assert.rejects(
    () => workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '再来一次'),
    /already been submitted/u,
  );
  assert.equal(sent.length, 1);

  // 空输入回退默认语(独立实例,避开同节点防重)
  const emptyWorkflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() {
        return namespace;
      },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() {
        return '';
      },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        sent.push(text);
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });
  const emptySubmission = await emptyWorkflow.enter(
    record.key,
    record.result.candidates[0].id,
    'node-anomaly',
    '',
  );
  assert.equal(emptySubmission.playerText, RUIN_ENTRY_DEFAULT_PHRASE);
  assert.equal(sent[1], RUIN_ENTRY_DEFAULT_PHRASE);
  assert.equal(sent.length, 2);
});

test('进入特异点提交:断言通过后清注入并写回元数据', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  const submission = await workflow.enter(
    record.key,
    record.result.candidates[0].id,
    'node-anomaly',
    '我踏入这处特异点',
  );
  assert.equal(submission.messageId, 9);
  assert.equal(runtime.extensionPrompts.length, 1);

  // 助手楼渲染(紧邻触发楼 9)
  runtime.addMessage({
    message_id: 10,
    role: 'assistant',
    message: '你踏入了历史切口，尘埃扑面而来。',
    swipe_id: 0,
  });
  const committed = await workflow.commitRendered(10);
  assert.ok(committed);
  assert.equal(committed?.messageId, 9);
  assert.equal(committed?.playerText, '我踏入这处特异点');
  // 注入已清
  assert.equal(runtime.extensionPrompts.length, 2);
  assert.equal(runtime.extensionPrompts[1].value, '');
  // 组装:权威 [RuinTrace] 已追加进助手楼(正文无自发块 → 末尾追加,flat 单行)
  assert.equal(runtime.chatWrites.length, 2);
  const assembledWrite = runtime.chatWrites[0].messages[0];
  assert.match(assembledWrite.message ?? '', /^你踏入了历史切口，尘埃扑面而来。\n\[RuinTrace\]/u);
  assert.doesNotMatch(assembledWrite.message ?? '', /\nTitle/u);
  assert.match(assembledWrite.message ?? '', /Title:: /u);
  // 元数据写回(带 message 分支触发器,正文为组装后文本)
  const write = runtime.chatWrites[1].messages[0];
  assert.equal(write.message, assembledWrite.message);
  const metadata = write.extra?.eyonHistoryRuinEntryRequest as
    | { triggerMessageId?: number; triggerTextHash?: string; playerText?: string }
    | undefined;
  assert.equal(metadata?.triggerMessageId, 9);
  assert.equal(metadata?.triggerTextHash, fingerprintText('我踏入这处特异点'));
  assert.equal(metadata?.playerText, '我踏入这处特异点');
  // 提交后再渲染:无锁,返回 null
  assert.equal(await workflow.commitRendered(10), null);
});

test('进入特异点提交:流式中保留锁,流式结束后才提交', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  await workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '我踏入这处特异点');
  runtime.addMessage({
    message_id: 10,
    role: 'assistant',
    message: '你踏入了历史切口，尘埃扑面而来。',
    swipe_id: 0,
  });

  // 流式中:保留锁,不提交、不清注入
  runtime.generating = true;
  assert.equal(await workflow.commitRendered(10), null);
  assert.equal(runtime.extensionPrompts.length, 1);
  assert.equal(runtime.chatWrites.length, 0);

  // 流式结束:提交成功(组装写入 + 元数据写回)
  runtime.generating = false;
  const committed = await workflow.commitRendered(10);
  assert.ok(committed);
  assert.equal(runtime.extensionPrompts.length, 2);
  assert.equal(runtime.extensionPrompts[1].value, '');
  assert.equal(runtime.chatWrites.length, 2);
});

test('进入特异点失败兜底:发送失败必清注入、丢锁', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        // 先武装(模拟 beforeCreate 已执行),再失败
        await options?.beforeCreate?.(9);
        throw new Error('trigger failed');
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  await assert.rejects(
    () => workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '我踏入这处特异点'),
    /trigger failed/u,
  );
  // 注入被清(arm 1 条 + clear 1 条)
  assert.equal(runtime.extensionPrompts.length, 2);
  assert.equal(runtime.extensionPrompts[1].value, '');
  // 锁已丢:后续渲染事件不会误提交
  runtime.addMessage({
    message_id: 10,
    role: 'assistant',
    message: '无关的正文楼',
    swipe_id: 0,
  });
  assert.equal(await workflow.commitRendered(10), null);
  assert.equal(runtime.chatWrites.length, 0);
});

test('权威 RuinTrace 组装:替换自发块(含错拼)、面板前插入、末尾追加、flat 单行', () => {
  const trace = [
    '[RuinTrace]',
    'Title:: 布劳尔旧堡婚盟名册失踪案',
    'Type:: 过渡期',
    'Span:: 复兴纪元145年5月10日 - 5月31日',
    'History:: 名册在一夜之间消失。',
    'Shift:: 稳定 → 动荡：名册失踪引发联姻中断',
    'NodeTime:: 复兴纪元145年5月20日',
    '[/RuinTrace]',
  ].join('\n');

  // 主路径:替换模型自发块(含 RuinTeance 错拼)
  const spontaneous = '我踏入了历史切口。\n[RuinTeance]\nTitle:: 旧名\nType:: 稳定期\nSpan:: 旧\nHistory:: 旧文\nShift:: 旧\nNodeTime:: 旧\n[/RuinTeance]';
  const replaced = insertRuinTrace(spontaneous, trace);
  assert.match(replaced, /我踏入了历史切口。\n\[RuinTrace\] Title:: 布劳尔旧堡婚盟名册失踪案/u);
  assert.doesNotMatch(replaced, /RuinTeance|旧名/u);
  // flat:字段间无换行(美化正则 markdownOnly 只认空格)
  assert.doesNotMatch(replaced, /\]\nTitle/u);
  assert.doesNotMatch(replaced, /\nType::/u);

  // 多个自发块:只保留第一个(替换为权威块),其余删除
  const multi = `${spontaneous}\n\n[RuinTrace]\nTitle:: 第二块\nType:: 稳定期\nSpan:: 二\nHistory:: 二\nShift:: 二\nNodeTime:: 二\n[/RuinTrace]`;
  const deduped = insertRuinTrace(multi, trace);
  assert.equal(deduped.match(/\[RuinTrace\]/gu)?.length, 1);
  assert.doesNotMatch(deduped, /第二块/u);

  // 兜底 1:文末 MVU 面板之前插入
  const withPanel = '正文收尾。\n<UpdateVariable>\n[{"op":"replace","path":"/墟境系统/运行状态/墟境流程状态","value":"exploring"}]\n</UpdateVariable>';
  const paneled = insertRuinTrace(withPanel, trace);
  assert.match(paneled, /正文收尾。\n\[RuinTrace\] Title:: .*?\n<UpdateVariable>/u);

  // 兜底 2:无块无面板,末尾追加
  const plain = insertRuinTrace('只有正文。', trace);
  assert.match(plain, /只有正文。\n\[RuinTrace\] Title:: /u);
});

test('进入特异点通知时序:打开时空之门(计时)→指令已发送→已进入', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const runtime = new RuinRuntime();
  const notices: Array<{ status: string; detail: string; extra?: Record<string, unknown> }> = [];
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
    hooks: {
      onStatus(status, detail, extra) {
        notices.push({ status, detail, extra });
      },
    },
  });

  await workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '我踏入这处特异点');
  // 前两条:校对进入契约(running+计时)→ 时光之门洞开(running 同 startedAt)
  assert.equal(notices.length, 2);
  assert.equal(notices[0]?.status, 'entering_ruin');
  assert.match(notices[0]?.detail ?? '', /时间、地点与进入契约/u);
  assert.equal(notices[0]?.extra?.phase, 'running');
  const started = (notices[0]?.extra?.progress as { startedAt?: number } | undefined)?.startedAt;
  assert.equal(typeof started, 'number');
  const laterStarted = (notices[1]?.extra?.progress as { startedAt?: number } | undefined)?.startedAt;
  assert.equal(laterStarted, started);

  // 渲染提交:已进入(success)
  runtime.addMessage({
    message_id: 10,
    role: 'assistant',
    message: '你踏入了历史切口。',
    swipe_id: 0,
  });
  await workflow.commitRendered(10);
  assert.equal(notices.length, 3);
  assert.equal(notices[2]?.status, 'ready');
  assert.equal(notices[2]?.extra?.phase, 'success');
});

test('删楼回退释放进入防重:同一特异点可重新进入', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年5月10日 14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn(text, options) {
        await options?.beforeCreate?.(9);
        runtime.addMessage({ message_id: 9, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(9);
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  // 首次进入:发送成功,防重生效
  await workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '我踏入这处特异点');
  await assert.rejects(
    () => workflow.enter(record.key, record.result.candidates[0].id, 'node-anomaly', '再试一次'),
    /already been submitted/u,
  );

  // 删除触发楼(回退):防重释放,同节点可重进
  workflow.onMessageDeleted(9);
  const resubmitted = await workflow.enter(
    record.key,
    record.result.candidates[0].id,
    'node-anomaly',
    '回退后重进',
  );
  assert.equal(resubmitted.playerText, '回退后重进');
});

test('非idle状态或跨聊天候选不会创建进入玩家楼', async () => {
  for (const scenario of ['exploring', 'other-chat'] as const) {
    const repository = new MemoryRuinCandidateRepository();
    const record = makeRecord();
    await repository.save(record);
    let sent = 0;
    const runtime = new RuinRuntime();
    const workflow = new RuinEntryWorkflow({
      repository,
      host: {
        async getNamespace() {
          return scenario === 'other-chat'
            ? { ...namespace, chatId: '另一个存档' }
            : namespace;
        },
        async getRuinRuntimeSnapshot() {
          return {
            flowState: scenario === 'exploring' ? 'exploring' : 'idle',
            runId: scenario === 'exploring' ? 'run-active' : '',
            realityTime: '复兴纪元488年',
            realityLocation: '布劳尔子爵领',
            ruinTime: '',
            ruinLocation: '',
          };
        },
        async getLatestUserText() {
          return '';
        },
        async replaceAssistantSlot() {},
      },
      userTurns: {
        async sendUserTurn() {
          sent += 1;
          return { messageId: 9 };
        },
      },
      runtime,
      shell: new TavernRuinEntryShellAdapter(runtime),
    });

    await assert.rejects(
      () => workflow.enter(record.key, 'ruin-1', 'node-anomaly', '随便'),
    );
    assert.equal(sent, 0);
  }
});

test('墟境检索只保留命中史料并将最近正文兜底限制为三楼', () => {
  const input = makeInput();
  input.location = '布劳尔旧堡';
  input.supplementaryDirection = '追查失踪名册';
  input.selectedCharacters = [{
    mvuId: '维奥莱塔',
    name: '维奥莱塔',
    source: 'mvu',
    race: '人类',
    identities: ['女皇'],
    professions: ['统治者'],
    relations: [],
    lifespan: '复兴纪元462年—在世',
    contextSummary: '关注布劳尔旧堡失踪名册',
  }];
  const context = makeContext();
  const relevantBiography = {
    sourceId: 'biography:维奥莱塔',
    sourceType: 'biography' as const,
    title: '维奥莱塔旧堡调查录',
    content: '维奥莱塔曾经追查布劳尔旧堡的失踪名册。',
    authority: 70,
  };
  const irrelevantWorldbook = {
    sourceId: 'worldbook:远海盐业',
    sourceType: 'worldbook' as const,
    title: '远海盐业',
    content: '记录遥远海岛的盐业与渔猎。',
    authority: 100,
  };
  const selectedMvu = {
    sourceId: 'mvu-character:维奥莱塔',
    sourceType: 'mvu' as const,
    title: '维奥莱塔',
    content: '{"name":"维奥莱塔","身份":"女皇"}',
    authority: 95,
  };
  const chats = Array.from({ length: 24 }, (_, index) => ({
    sourceId: `chat:${index + 1}`,
    sourceType: 'chat' as const,
    title: `floor ${index + 1}`,
    content: `最近正文 ${index + 1}`,
    authority: 80,
  }));
  context.recentContext = chats;
  context.biographyRefs = [relevantBiography];
  context.characterContext = [selectedMvu];
  context.sourceIndex = [
    ...context.sourceIndex,
    irrelevantWorldbook,
    relevantBiography,
    selectedMvu,
    ...chats,
  ];

  const selected = selectRuinReferenceSources({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: '生成契约' },
  });

  assert.ok(selected.some(source => source.sourceId === selectedMvu.sourceId));
  assert.ok(selected.some(source => source.sourceId === relevantBiography.sourceId));
  assert.ok(!selected.some(source => source.sourceId === irrelevantWorldbook.sourceId));
  assert.equal(
    selected.filter(source => source.sourceType === 'chat').length,
    2,
  );
});

test('墟境检索沿已命中人物资料中的专名扩展到关联世界书', () => {
  const input = makeInput();
  input.location = '翡翠之心';
  input.selectedCharacters = [{
    mvuId: '伊伽',
    name: '伊伽',
    source: 'mvu',
    race: '精灵',
    identities: ['同行者'],
    professions: ['法师'],
    relations: [],
    lifespan: '复兴纪元460年—在世',
    contextSummary: '她曾保管赤槐议会的封存名册。',
  }];
  const context = makeContext();
  const selectedMvu = {
    sourceId: 'mvu-character:伊伽',
    sourceType: 'mvu' as const,
    title: '伊伽',
    content: '伊伽曾保管赤槐议会的封存名册。',
    authority: 95,
  };
  const linkedWorldbook = {
    sourceId: 'worldbook:赤槐议会',
    sourceType: 'worldbook' as const,
    title: '赤槐议会',
    content: '赤槐议会在复兴纪元145年发生过一次名册争夺。',
    authority: 100,
  };
  context.characterContext = [selectedMvu];
  context.worldbookContext = [linkedWorldbook];
  context.sourceIndex = [selectedMvu, linkedWorldbook];

  const selected = selectRuinReferenceSources({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: '生成契约' },
  });

  assert.deepEqual(
    selected.map(source => source.sourceId),
    ['mvu-character:伊伽', 'worldbook:赤槐议会'],
  );
});

test('本地校验拒绝把骰表显示标签写进候选史稿', () => {
  const input = makeInput();
  input.materials[0] = {
    ...input.materials[0],
    conflict: 'arcane_backlash｜魔工反噬｜仪式、炼金、工程与机关实验失控',
  };
  const result = makeCandidates();
  result.candidates[0].historyProse = `魔工反噬${'史'.repeat(450)}`;

  assert.throws(
    () => parseAndValidateRuinCandidates(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    /backstage dice label/u,
  );
});

test('preparing a ruin entry builds composer text without creating a user floor', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const record = makeRecord();
  await repository.save(record);
  let sent = 0;
  const runtime = new RuinRuntime();
  const workflow = new RuinEntryWorkflow({
    repository,
    host: {
      async getNamespace() { return namespace; },
      async getRuinRuntimeSnapshot() {
        return {
          flowState: 'idle',
          runId: '',
          realityTime: '复兴纪元488年-5月-10日-14:31',
          realityLocation: '布劳尔子爵城堡侧厅',
          ruinTime: '',
          ruinLocation: '',
        };
      },
      async getLatestUserText() { return ''; },
      async replaceAssistantSlot() {},
    },
    userTurns: {
      async sendUserTurn() {
        sent += 1;
        return { messageId: 9 };
      },
    },
    runtime,
    shell: new TavernRuinEntryShellAdapter(runtime),
  });

  const prepared = await workflow.prepareText(
    record.key,
    'ruin-1',
    'node-anomaly',
  );

  assert.equal(sent, 0);
  assert.match(prepared.text, /现实锚点时间：复兴纪元488年-5月-10日-14:31/u);
  assert.match(prepared.text, /流程状态更新为 exploring/u);
});

test('ruin evidence ledger preserves canonical people, scope and source authority', () => {
  const input = makeInput();
  input.location = 'Imperial Capital-Crimson Palace-West Archive';
  input.selectedCharacters = [{
    mvuId: 'violeta',
    name: 'Violeta Augusta',
    source: 'mvu',
    race: 'human',
    identities: ['Empress of Augustim'],
    professions: ['ruler', 'mythic warrior'],
    relations: ['the protagonist: trusted ally'],
    lifespan: 'Restoration Era 462-present',
    contextSummary: 'The current empress safeguards the imperial archive.',
  }];

  const context = makeContext();
  const mvuSource = {
    sourceId: 'mvu-character:violeta',
    sourceType: 'mvu' as const,
    title: 'Violeta Augusta',
    content: 'Violeta Augusta is the current Empress of Augustim.',
    authority: 95,
  };
  const worldbookSource = {
    sourceId: 'worldbook:crimson-palace',
    sourceType: 'worldbook' as const,
    title: 'Crimson Palace West Archive',
    content: 'The West Archive belongs to the Crimson Palace in the Imperial Capital.',
    authority: 100,
  };
  context.characterContext = [mvuSource];
  context.worldbookContext = [worldbookSource];
  context.sourceIndex = [mvuSource, worldbookSource];
  context.evidenceBundle = makeEvidenceBundle([worldbookSource, mvuSource]);

  const promptInput = {
    requestId,
    directive: 'ruin exploration',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  };
  const ledger = buildRuinEvidenceLedger(promptInput);
  const prompt = buildRuinOutlineBatchApiPrompt(promptInput);

  assert.deepEqual(ledger.requestedScope.locationHierarchy, [
    'Imperial Capital',
    'Crimson Palace',
    'West Archive',
  ]);
  assert.equal(ledger.canonicalCharacters[0].name, 'Violeta Augusta');
  assert.deepEqual(ledger.canonicalCharacters[0].identities, ['Empress of Augustim']);
  assert.deepEqual(
    ledger.evidenceSources.map(source => source.sourceId),
    ['worldbook:crimson-palace', 'mvu-character:violeta'],
  );
  assert.match(prompt, /<EVIDENCE_LEDGER_READ_ONLY>/u);
  assert.match(prompt, /immutable canon/u);
  assert.match(prompt, /Violeta Augusta/u);
  assert.match(prompt, /Empress of Augustim/u);
});

test('墟境提示词只消费 EvidenceBundle passages，不重扫 sourceIndex 噪声', () => {
  const input = makeInput();
  const context = makeContext();
  const legacyNoise = {
    sourceId: 'worldbook:legacy-noise',
    sourceType: 'worldbook' as const,
    title: '旧二次检索噪声',
    content: 'HIDDEN_LEGACY_NOISE 奥古斯提姆帝国当前议会。',
    authority: 100,
  };
  context.sourceIndex.push(legacyNoise);
  context.worldbookContext.push(legacyNoise);
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '布劳尔旧堡的历史裂点',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  const passage = context.evidenceBundle.passages[0]!;

  assert.match(prompt, /旧堡保存着地方婚盟与供给名册/u);
  assert.match(prompt, /"passageId":"P1"/u);
  assert.doesNotMatch(prompt, /#chars:0-/u);
  assert.equal(prompt.includes(passage.passageId), false);
  assert.equal(prompt.includes(passage.snapshotId), false);
  assert.equal(prompt.includes(passage.sourceId), false);
  assert.doesNotMatch(prompt, /HIDDEN_LEGACY_NOISE/u);
});

test('墟境提示词把舞台原文与外部地点事实卡分栏，外部景观不进入权威舞台', () => {
  const input = makeInput();
  input.location = '奥古斯提姆帝国';
  input.supplementaryDirection = '第二次位面入侵时帝国军方的英雄群像';
  const stageSource = {
    sourceId: 'worldbook:empire-stage',
    sourceType: 'worldbook' as const,
    title: '奥古斯提姆帝国',
    content: 'STAGE_CANON 帝国在目标纪元组织了边境防御。',
    authority: 100,
  };
  const externalSource = {
    sourceId: 'worldbook:external-ruin',
    sourceType: 'worldbook' as const,
    title: '泣空遗迹',
    content: 'EXTERNAL_SCENIC_SHELL 遗迹漂浮在三万米高空的云海。第二次位面入侵末期发生过自毁。',
    authority: 100,
  };
  const context = makeContext();
  context.evidenceBundle = makeEvidenceBundle([stageSource, externalSource]);
  const [stagePassage, externalPassage] = context.evidenceBundle.passages;
  context.evidenceBundle.qualifiedEvidence = {
    schema: 'eyon.retrieval.qualified-evidence.v1',
    taskType: 'ruin',
    requestedScope: { eras: ['英雄纪元'], locations: ['奥古斯提姆帝国'] },
    creativePolicy: {
      locked: 'locked',
      guided: 'guided',
      open: 'open',
    },
    passages: [
      {
        passageId: stagePassage.passageId,
        sourceId: stagePassage.sourceId,
        sourceType: stagePassage.sourceType,
        zone: 'locked',
        temporal: { fit: 'contemporary', requestedEras: ['英雄纪元'], evidenceEras: ['英雄纪元'] },
        geographic: { fit: 'stage', requestedLocations: ['奥古斯提姆帝国'], evidenceLocations: ['奥古斯提姆帝国'] },
        eventPhase: 'contemporary',
        revision: { fit: 'baseline', reason: 'fixture' },
        entityRoles: [],
        allowedUses: ['background', 'reference', 'stage'],
        forbiddenUses: [],
        reasons: ['fixture'],
      },
      {
        passageId: externalPassage.passageId,
        sourceId: externalPassage.sourceId,
        sourceType: externalPassage.sourceType,
        zone: 'locked',
        temporal: { fit: 'contemporary', requestedEras: ['英雄纪元'], evidenceEras: ['英雄纪元'] },
        geographic: { fit: 'external', requestedLocations: ['奥古斯提姆帝国'], evidenceLocations: ['泣空遗迹'] },
        eventPhase: 'reference',
        revision: { fit: 'baseline', reason: 'fixture' },
        entityRoles: [],
        allowedUses: ['background', 'reference'],
        forbiddenUses: ['不得仅凭相关性把该来源地点写成本轮事件发生地'],
        reasons: ['fixture'],
      },
    ],
  };
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: input.supplementaryDirection,
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });

  assert.match(prompt, /<HISTORICAL_AUTHORITY_READ_ONLY>[\s\S]*STAGE_CANON/u);
  assert.match(prompt, /<HISTORICAL_REFERENCE_FACTS_READ_ONLY>/u);
  assert.match(prompt, /第二次位面入侵末期发生过自毁/u);
  assert.doesNotMatch(prompt, /EXTERNAL_SCENIC_SHELL/u);
  assert.match(prompt, /不得把外部地点的专名、景观或遗迹搬成本轮舞台/u);
});

test('墟境提示词与提交校验共同执行共享时代资格账本', () => {
  const input = makeInput();
  input.era = '神明纪元';
  const context = makeContext();
  context.evidenceBundle.temporalEligibility = makeTemporalEligibility();
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '泰珂对其他神明所作的恶作剧',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  assert.match(prompt, /<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>/u);
  assert.match(prompt, /<ERA_PROFILE>/u);
  assert.match(prompt, /奥古斯提姆帝国/u);
  assert.match(prompt, /混乱纪元：人类帝国诞生/u);

  // 时代错位不再致命：史稿在神明纪元提及帝国 → 通过（模型按错位契约处理）。
  const candidate = structuredClone(makeCandidates().candidates[0]);
  candidate.historyProse = `神明纪元的奥古斯提姆帝国已经建立。${'史'.repeat(470)}`;
  const validated = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: input.era,
    location: input.location,
    candidateKey: input.materials[0].candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context,
  });
  assert.ok(validated.candidateKey);
});

test('时代画像：墟境 prompt 携带 ERA_PROFILE 与错位处理契约，时间错位表述一律放行', () => {
  const input = makeInput();
  input.era = '神明纪元';
  const context = makeContext();
  context.evidenceBundle.temporalEligibility = makeTemporalEligibility();
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '泰珂对其他神明所作的恶作剧',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  assert.match(prompt, /<ERA_PROFILE>/u);
  assert.match(prompt, /错位处理契约/u);

  const validateCandidate = (historyProse: string) =>
    parseAndValidateRuinCandidateResponse(JSON.stringify({
      schema: 'eyon.ruin.candidate.v1',
      requestId,
      era: input.era,
      location: input.location,
      candidateKey: input.materials[0].candidateKey,
      candidate: {
        ...structuredClone(makeCandidates().candidates[0]),
        historyProse,
      },
    }), {
      requestId,
      input,
      material: input.materials[0],
      context,
    });

  // 时间锚表述：帝国不实体出现，允许「此地日后成为帝国」式写法 → 通过。
  assert.doesNotThrow(() => validateCandidate(
    `神明纪元时，此地日后将成为奥古斯提姆帝国，如今只有散居部族。${'史'.repeat(460)}`,
  ));
  // 存在性表述：帝国作为在场政权出现 → 同样通过（交由模型按错位契约合理化）。
  assert.doesNotThrow(() => validateCandidate(
    `神明纪元的奥古斯提姆帝国皇帝下令征税。${'史'.repeat(460)}`,
  ));
});

test('鲁棒性：神明纪元出现蒸汽机不再被拦截（词表黑名单已废弃，交给模型按错位契约合理化）', () => {
  const input = makeInput();
  input.era = '神明纪元';
  const context = makeContext();
  context.evidenceBundle.temporalEligibility = makeTemporalEligibility();
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '泰珂对其他神明所作的恶作剧',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  // prompt 必须携带时代画像与错位处理契约（模型据此把蒸汽机解释为异界造物等来源）。
  assert.match(prompt, /<ERA_PROFILE>/u);
  assert.match(prompt, /错位处理契约/u);
  assert.match(prompt, /位面交汇残留/u);

  // 蒸汽机（任何词表外的新概念）在神明纪元出现 → 通过，不截断。
  const candidate = structuredClone(makeCandidates().candidates[0]);
  candidate.historyProse = `一位部族工匠从位面裂隙中拖出半台喷吐灼热蒸汽的青铜机械，众人称之为铁肺神。${'史'.repeat(430)}`;
  const validated = parseAndValidateRuinCandidateResponse(JSON.stringify({
    schema: 'eyon.ruin.candidate.v1',
    requestId,
    era: input.era,
    location: input.location,
    candidateKey: input.materials[0].candidateKey,
    candidate,
  }), {
    requestId,
    input,
    material: input.materials[0],
    context,
  });
  assert.ok(validated.candidateKey);
});

test('墟境提示词携带无正文 CastManifest，required 角色被确定性固定到每条支线', () => {
  const input = makeInput();
  input.era = '神明纪元';
  const context = makeContext();
  const passage = context.evidenceBundle.passages[0];
  context.evidenceBundle.castManifest = {
    schema: 'eyon.retrieval.cast-manifest.v1',
    entries: [{
      entityId: 'entity:%E6%B3%B0%E7%8F%82',
      disposition: 'required',
      role: 'actor',
      reasons: ['direct-query-entity'],
      identity: {
        canonicalName: '泰珂',
        aliases: ['狡黠少女'],
        kinds: ['person'],
        identities: ['旅途与幸运的女神'],
        temporalScopes: ['神明纪元'],
        locationScopes: ['阿斯塔利亚'],
        sourceSnapshotIds: [passage.snapshotId],
        passageIds: [passage.passageId],
      },
    }],
    groupCoverage: [],
  };
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '泰珂对其他神明所作的恶作剧',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  assert.match(prompt, /CAST_MANIFEST_READ_ONLY/u);
  assert.match(prompt, /旅途与幸运的女神/u);

  const raw = makeOutlineResponse();
  raw.candidates.forEach((candidate, index) => {
    candidate.cast = [{
      name: `地方人物${index}`,
      kind: 'person',
      identity: '地方见证者',
      role: '本地行动者',
    }];
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '泰珂对其他神明所作的恶作剧',
    input,
    context,
  });
  for (const candidate of parsed.candidates) {
    assert.equal(candidate.cast[0]?.name, '泰珂');
    assert.equal(candidate.cast[0]?.identity, '旅途与幸运的女神');
    assert.ok(candidate.nodes.some(node => node.participants.includes('泰珂')));
  }
});

test('玩家要求群像时，完整原话进入提示词，候选可由多类人物或组织实际贡献', () => {
  const input = makeInput();
  input.supplementaryDirection = '灾后重建中工匠、医者与商人的协作群像';
  const raw = makeOutlineResponse(input);
  const cast = [
    { name: '石匠行会', kind: 'organization' as const, identity: '旧堡本地营造组织', role: '修复城墙与水渠' },
    { name: '巡诊医师', kind: 'person' as const, identity: '旧堡本地医者', role: '控制疫病与伤亡' },
    { name: '山道商队', kind: 'organization' as const, identity: '旧堡本地运输组织', role: '恢复物资流通' },
  ];
  raw.candidates.forEach(candidate => {
    candidate.cast = cast;
    candidate.nodes.forEach(node => { node.participants = cast.map(member => member.name); });
  });

  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context: makeContext(),
    rules: { generationContract: 'generation contract' },
  });
  assert.ok(prompt.includes(input.supplementaryDirection));
  assert.ok(prompt.includes('one complete request'));
  // 认知脚手架回归（76 三轮覆盖）：taskInterpretation/taskFit 恢复为纯输出脚手架。
  assert.ok(prompt.includes('taskInterpretation is a written-out reasoning scaffold'));
  assert.ok(prompt.includes('taskFit is a soft self-record'));

  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  assert.ok(parsed.candidates.every(candidate => candidate.cast.length >= 3));
});

test('taskFit 是软记录：旧回执乱写不再造成报错或左右候选（sourceText 防偷换由硬锁另测）', () => {
  const input = makeInput();
  input.supplementaryDirection = '灾后重建中工匠、医者与商人的协作群像';
  const raw = makeOutlineResponse(input);
  raw.taskInterpretation = {
    sourceText: input.supplementaryDirection, // 正确原话——偷换场景由「理解层硬锁保留」测试覆盖
    primarySubject: '协作群像',
    eventAnchor: '旧堡灾后恢复秩序的关键阶段',
    castDemand: { mode: 'ensemble', minimumDistinctActors: 3, requiredKinds: [], selectionRule: '按贡献选择' },
    mustServe: ['灾后重建'],
    materialRole: 'support-only',
  };
  raw.candidates.forEach(candidate => {
    candidate.taskFit = {
      subjectServed: '与玩家原话无关的旧回执',
      eventAnchorServed: '旧字段已忽略',
      servedRequirements: [],
      contributions: [],
    };
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  assert.equal(parsed.candidates.length, raw.candidates.length);
});

test('已知实体在候选生成后复核类型、归属与时代，局部原创实体不受误伤', () => {
  const input = makeInput();
  const context = makeContext();
  context.evidenceBundle.castManifest = {
    schema: 'eyon.retrieval.cast-manifest.v1',
    entries: [{
      entityId: 'entity:holy-wing-order',
      disposition: 'recommended',
      role: 'participant',
      reasons: ['relation:belongs_to'],
      identity: {
        canonicalName: '圣翼骑士团',
        aliases: ['圣翼团'],
        kinds: ['organization'],
        identities: ['翼民空军骑士组织'],
        affiliations: ['梵尼亚'],
        temporalScopes: ['复兴纪元'],
        locationScopes: ['梵尼亚'],
        sourceSnapshotIds: [],
        passageIds: [],
      },
    }],
    groupCoverage: [],
  };
  const wrongAffiliation = makeOutlineResponse(input);
  wrongAffiliation.candidates.forEach(candidate => {
    candidate.cast.push({
      name: '圣翼骑士团',
      kind: 'organization',
      identity: '翼民空军骑士组织',
      role: '奥古斯提姆帝国直属军团',
    });
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(wrongAffiliation), {
      requestId,
      directive: '墟境探索',
      input,
      context,
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'KNOWN_ENTITY_AFFILIATION_CHANGED',
  );

  const wrongEraContext = structuredClone(context);
  const knownEntry = wrongEraContext.evidenceBundle.castManifest?.entries[0];
  assert.ok(knownEntry);
  knownEntry.disposition = 'excluded';
  knownEntry.reasons = ['temporal-scope-incompatible'];
  knownEntry.identity.temporalScopes = ['神明纪元'];
  const wrongEra = makeOutlineResponse(input);
  wrongEra.candidates.forEach(candidate => {
    candidate.cast.push({
      name: '圣翼骑士团',
      kind: 'organization',
      identity: '翼民空军骑士组织；所属：梵尼亚',
      role: '旧堡事件参与者',
    });
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(wrongEra), {
      requestId,
      directive: '墟境探索',
      input,
      context: wrongEraContext,
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'KNOWN_ENTITY_TEMPORAL_SCOPE_CHANGED',
  );
});

test('replacing a ruin namespace removes stale records only when replacement is committed', async () => {
  const repository = new MemoryRuinCandidateRepository();
  const oldRecord = makeRecord();
  await repository.save(oldRecord);

  const replacementRequestId = 'ruin-test-002';
  const replacement: RuinCandidateRecord = {
    ...structuredClone(oldRecord),
    key: ruinCandidateRecordKey(namespace, replacementRequestId),
    requestId: replacementRequestId,
    createdAt: 2000,
  };
  const removed = await repository.replaceNamespace(replacement);

  assert.equal(removed, 1);
  assert.equal(await repository.get(oldRecord.key), null);
  assert.equal(
    (await repository.list(namespace)).map(record => record.requestId).join(','),
    replacementRequestId,
  );
});

test('compact expansion response restores structural fields from the selected outline', () => {
  const input = makeInput();
  const context = makeContext();
  const outlines = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeOutlineResponse()),
    { requestId, directive: '墟境探索', input, context },
  );
  const outline = outlines.candidates[0];
  const expansionRequestId = `${requestId}:expand:${outline.id}`;
  const historyProse = '史'.repeat(450);
  const raw = JSON.stringify({
    schema: 'eyon.ruin.expansion.v1',
    requestId: expansionRequestId,
    candidateKey: input.materials[0].candidateKey,
    candidate: { historyProse },
  });

  const result = parseAndNormalizeExpandedRuinCandidate(raw, {
    requestId: expansionRequestId,
    input,
    material: input.materials[0],
    context,
    outline,
  });

  assert.equal(result.historyProse, historyProse);
  assert.deepEqual(result.nodes, outline.nodes);
  assert.deepEqual(result.cast, outline.cast);
  assert.deepEqual(result.span, outline.span);
});

test('玩家未给起止时间时，全节点同日（纪元元年1月1日）报 TIMELINE_DEGENERATE', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const result = makeCandidates();
  result.candidates.forEach(candidate => {
    candidate.span = {
      start: { year: 1, month: 1, day: 1 },
      end: { year: 1, month: 1, day: 1 },
      label: '复兴纪元1年1月1日',
    };
    candidate.nodes = candidate.nodes.map(node => ({
      ...node,
      time: {
        year: 1,
        month: 1,
        day: 1,
        hour: null,
        minute: null,
        label: '复兴纪元1年1月1日',
      },
    }));
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    /TIMELINE_DEGENERATE|degenerate/u,
  );
});

test('玩家未给起止时间时，相对纪年（year 缺省、month/day null、标签有区分度）正常通过', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const result = makeCandidates();
  result.candidates.forEach((candidate, index) => {
    candidate.span = {
      start: { year: null, month: null, day: null },
      end: { year: null, month: null, day: null },
      label: '复兴纪元·早期至晚期',
    };
    candidate.nodes = candidate.nodes.map((node, nodeIndex) => ({
      ...node,
      time: {
        year: null,
        month: null,
        day: null,
        hour: null,
        minute: null,
        label: `复兴纪元·第${nodeIndex + 1}代人（候选${index + 1}）`,
      },
    }));
  });
  const parsed = parseAndValidateRuinCandidates(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  const first = parsed.candidates[0]!.nodes[0]!.time;
  assert.equal(first.year, null);
  assert.equal(first.month, null);
  assert.equal(first.day, null);
  assert.match(first.label ?? '', /第1代人/u);
});

test('空日期会按纪元史料确定可复现跨度，并为所有因果节点补齐显式时刻', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const context = makeContext();
  context.sourceIndex[0]!.content += '\n复兴纪元145年，旧堡婚盟名册发生重排。';
  const first = resolveAutomaticRuinRange(input, context);
  const second = resolveAutomaticRuinRange(input, context);

  assert.equal(first.automatic, true);
  assert.deepEqual(first, second);
  assert.ok(first.input.start?.year && first.input.end?.year);
  assert.ok(first.input.start!.year! <= 145 && first.input.end!.year! >= 145);

  const result = makeCandidates();
  result.candidates.forEach(candidate => {
    candidate.span = {
      start: { year: null, month: null, day: null },
      end: { year: null, month: null, day: null },
      label: '',
    };
    candidate.nodes = candidate.nodes.map(node => ({
      ...node,
      time: {
        year: null,
        month: null,
        day: null,
        hour: null,
        minute: null,
        label: '',
      },
    }));
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input: first.input,
    context,
    automaticTimeRange: true,
  });
  for (const candidate of parsed.candidates) {
    assert.doesNotMatch(candidate.span.label, /相对纪年|未详/u);
    const calendarDates: string[] = [];
    const stamps = candidate.nodes.map(node => {
      assert.notEqual(node.time.year, null);
      assert.notEqual(node.time.month, null);
      assert.notEqual(node.time.day, null);
      assert.notEqual(node.time.hour, null);
      assert.notEqual(node.time.minute, null);
      assert.doesNotMatch(node.time.label, /相对纪年|未详/u);
      calendarDates.push([node.time.year, node.time.month, node.time.day].join('-'));
      return [node.time.year, node.time.month, node.time.day, node.time.hour, node.time.minute].join('-');
    });
    assert.equal(new Set(calendarDates).size, candidate.nodes.length);
    assert.equal(new Set(stamps).size, candidate.nodes.length);
  }
});

test('year 为 0 的「未详」占位被归一化为 null（0 年不存在）', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const result = makeCandidates();
  result.candidates.forEach((candidate, index) => {
    candidate.span = {
      start: { year: 0, month: null, day: null },
      end: { year: 0, month: null, day: null },
      label: '复兴纪元·早期至晚期',
    };
    candidate.nodes = candidate.nodes.map((node, nodeIndex) => ({
      ...node,
      time: {
        year: 0,
        month: null,
        day: null,
        hour: null,
        minute: null,
        label: `复兴纪元·第${nodeIndex + 1}代人（候选${index + 1}）`,
      },
    }));
  });
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  // 模型写 year:0 → 归一化为 null，不再出现「创世纪元0年」
  assert.equal(parsed.candidates[0]!.nodes[0]!.time.year, null);
  assert.equal(parsed.candidates[1]!.nodes[1]!.time.year, null);
});

test('未给时间时，节点全同且只有自动编号标签（模型未写标签）报 TIMELINE_DEGENERATE', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const result = makeCandidates();
  result.candidates.forEach(candidate => {
    candidate.span = {
      start: { year: null, month: null, day: null },
      end: { year: null, month: null, day: null },
      label: '',
    };
    candidate.nodes = candidate.nodes.map(node => ({
      ...node,
      time: {
        year: null,
        month: null,
        day: null,
        hour: null,
        minute: null,
        label: '',
      },
    }));
  });
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    /TIMELINE_DEGENERATE|degenerate/u,
  );
});

test('未来硬门：节点晚于当前剧情时间（488年）报 NODE_IN_FUTURE', () => {
  const input = makeInput();
  input.start = { year: 490, month: 1, day: 1 };
  input.end = { year: 500, month: 12, day: 31 };
  const result = makeCandidatesWithinRange(input);
  result.candidates[0]!.span = {
    start: { year: 495, month: 1, day: 1 },
    end: { year: 498, month: 1, day: 1 },
    label: '复兴纪元495年 - 498年',
  };
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 495 + index,
      month: 5,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${495 + index}年5月1日`,
    },
  }));
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    /NODE_IN_FUTURE|in the future/u,
  );
});

test('未来硬门：扩写端（parseAndValidateRuinCandidates）同样拦截未来节点', () => {
  const input = makeInput();
  input.start = { year: 490, month: 1, day: 1 };
  input.end = { year: 500, month: 12, day: 31 };
  const result = makeCandidates();
  result.candidates[0]!.span = {
    start: { year: 495, month: 1, day: 1 },
    end: { year: 498, month: 1, day: 1 },
    label: '复兴纪元495年 - 498年',
  };
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 495 + index,
      month: 5,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${495 + index}年5月1日`,
    },
  }));
  assert.throws(
    () => parseAndValidateRuinCandidates(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    /NODE_IN_FUTURE|in the future/u,
  );
});

test('未来硬门：节点不晚于当前剧情时间时放行；目标纪元早于现在也放行', () => {
  // 复兴纪元145年 < 现在488年：放行。
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(makeCandidates()), {
    requestId,
    directive: '墟境探索',
    input: makeInput(),
    context: makeContext(),
  });
  assert.equal(parsed.candidates.length, 3);

  // 目标纪元是更早的混乱纪元：整体在过去，放行。
  const input = makeInput();
  input.era = '混乱纪元';
  input.start = { year: 100, month: 1, day: 1 };
  input.end = { year: 150, month: 12, day: 31 };
  const parsedEarlier = parseAndNormalizeRuinOutlines(JSON.stringify(makeCandidates()), {
    requestId,
    directive: '墟境探索',
    input,
    context: makeContext(),
  });
  assert.equal(parsedEarlier.candidates.length, 3);
});

test('未来硬门：当前剧情时间解析失败时不拦截（避免误伤）', () => {
  const input = makeInput();
  input.start = { year: 490, month: 1, day: 1 };
  input.end = { year: 500, month: 12, day: 31 };
  const result = makeCandidatesWithinRange(input);
  result.candidates[0]!.span = {
    start: { year: 495, month: 1, day: 1 },
    end: { year: 498, month: 1, day: 1 },
    label: '复兴纪元495年 - 498年',
  };
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 495 + index,
      month: 5,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${495 + index}年5月1日`,
    },
  }));
  const context = makeContext();
  context.currentWorld.time = '未知时刻';
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(parsed.candidates.length, 3);
});

test('自动时间范围不越过当前剧情时间（穿越只能回到过去）', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  const context = makeContext();
  context.currentWorld.time = '复兴纪元300年-1月-1日';
  const resolved = resolveAutomaticRuinRange(input, context);
  assert.equal(resolved.automatic, true);
  assert.ok(resolved.input.start!.year !== null && resolved.input.start!.year! <= 300);
  assert.ok(resolved.input.end!.year !== null && resolved.input.end!.year! <= 300);
  assert.ok(resolved.input.start!.year! <= resolved.input.end!.year!);
});

test('伊莲娜（出生 472，晚于旧 470 兜底窗口）：自动范围下界 ≥472 且不越过剧情 488', () => {
  // 旧实现 maximum=min(470, capYear) 会把人物下限钳回 470 → 出生 472 的伊莲娜
  // 永远得不到覆盖她的窗口（诊断里表现为 470-10-20 → 470-1-3 倒置 + 拦截）。
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [{
    mvuId: 'm-elena',
    name: '伊莲娜·A·梦露',
    source: 'mvu' as const,
    identities: ['白鲸杂志社社长'],
    race: '半人鱼',
    professions: ['社长'],
    relations: [],
    lifespan: '16岁',
    contextSummary: '白鲸杂志社社长',
  }];
  const context = withLingshanTimeline(makeContext());
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [
      ...(context.evidenceBundle.personTimeline ?? []),
      {
        name: '伊莲娜·A·梦露',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 472 },
          ageAtRecord: 16,
          basedOnEra: '复兴纪元',
          basedOnYear: 488,
          ageBased: true,
        },
      },
    ],
  };
  const resolved = resolveAutomaticRuinRange(input, context);
  assert.equal(resolved.automatic, true);
  assert.ok(
    resolved.input.start!.year !== null && resolved.input.start!.year >= 472,
    `自动范围下界应为 ≥472，实际 ${resolved.input.start!.year}`,
  );
  assert.ok(
    resolved.input.end!.year !== null && resolved.input.end!.year <= 488,
    `自动范围上界不得越过剧情现在 488，实际 ${resolved.input.end!.year}`,
  );
  assert.ok(resolved.input.start!.year! <= resolved.input.end!.year!);
});

test('出生仅数年的婴儿（487，剧情现在 488）：自动范围必须覆盖其出生年', () => {
  // 旧实现 min(personFloor, maximum=470) 把下界钳到 470，出生 487 的婴儿
  // 同样得不到覆盖 → 时间硬门误拦。修复后人物下限只抬高不钳制。
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [{
    mvuId: 'm-baby',
    name: '铃铛',
    source: 'mvu' as const,
    identities: [],
    race: '翼族',
    professions: [],
    relations: ['玲山·哈姆斯沃思'],
    lifespan: '1岁',
    contextSummary: '玲山的妹妹',
  }];
  const context = withLingshanTimeline(makeContext());
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [
      ...(context.evidenceBundle.personTimeline ?? []),
      {
        name: '铃铛',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 487 },
          ageAtRecord: 1,
          basedOnEra: '复兴纪元',
          basedOnYear: 488,
          ageBased: true,
        },
      },
    ],
  };
  const resolved = resolveAutomaticRuinRange(input, context);
  assert.equal(resolved.automatic, true);
  assert.ok(
    resolved.input.start!.year !== null && resolved.input.start!.year <= 487,
    `窗口起点不得晚于婴儿出生年 487，实际 ${resolved.input.start!.year}`,
  );
  assert.ok(
    resolved.input.end!.year !== null && resolved.input.end!.year >= 487,
    `窗口终点不得早于婴儿出生年 487，实际 ${resolved.input.end!.year}`,
  );
});

test('剧情时间解析失败：自动范围不回落 470 兜底，人物出生年 472 仍可达', () => {
  // currentWorld.time 无法解析 → capYear 缺失。旧实现退回窗口上限 470 并钳制
  // 人物下限；新实现不设上界（只受下界与有限跨度约束），出生 472 的伊莲娜可达。
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [{
    mvuId: 'm-elena',
    name: '伊莲娜·A·梦露',
    source: 'mvu' as const,
    identities: ['白鲸杂志社社长'],
    race: '半人鱼',
    professions: ['社长'],
    relations: [],
    lifespan: '16岁',
    contextSummary: '白鲸杂志社社长',
  }];
  const context = withLingshanTimeline(makeContext());
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [
      ...(context.evidenceBundle.personTimeline ?? []),
      {
        name: '伊莲娜·A·梦露',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 472 },
          ageAtRecord: 16,
          basedOnEra: '复兴纪元',
          basedOnYear: 488,
          ageBased: true,
        },
      },
    ],
  };
  context.currentWorld.time = '破碎的时刻，无法解析';
  const first = resolveAutomaticRuinRange(input, context);
  const second = resolveAutomaticRuinRange(input, context);
  assert.equal(first.automatic, true);
  assert.deepEqual(first, second); // 仍可复现
  assert.ok(
    first.input.start!.year !== null && first.input.start!.year >= 472,
    `无上界时下界仍应 ≥472（不被 470 钳回），实际 ${first.input.start!.year}`,
  );
  assert.ok(
    first.input.end!.year !== null && first.input.end!.year >= first.input.start!.year! + 3,
    `窗口应保有完整跨度，实际 ${first.input.start!.year} → ${first.input.end!.year}`,
  );
  assert.ok(first.input.start!.year! <= first.input.end!.year!);
});

test('墟境 prompt 注入人物年龄锚：普通人物给出生年公式，界外来客给硬事实+推断线+一致性规则', () => {
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [
      {
        name: '凡多·灰袍',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 400 },
          died: { era: '复兴纪元', year: 479 },
        },
      },
      {
        name: '梅薇娜·王尔德',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 400 },
          ageAtRecord: 88,
          basedOnEra: '复兴纪元',
          basedOnYear: 488,
          ageBased: true,
          arrivalBased: true,
        },
      },
    ],
  };
  const input = makeInput();
  input.selectedCharacters = [
    {
      mvuId: 'm1',
      name: '凡多·灰袍',
      source: 'mvu',
      identities: ['灰袍学者'],
      race: '人类',
      professions: ['学者'],
      relations: [],
      lifespan: '复兴纪元400年-479年',
      contextSummary: '灰袍学者',
    },
    {
      mvuId: 'm2',
      name: '梅薇娜·王尔德',
      source: 'mvu',
      identities: ['晨曙书局局长'],
      race: '人类',
      professions: ['裁书人'],
      relations: [],
      lifespan: '88岁',
      contextSummary: '晨曙书局局长',
    },
  ];
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: '契约' },
  });
  assert.match(prompt, /<CHARACTER_TIME_ANCHORS>/u);
  // 普通人物：显式生卒 + 年龄公式 + 已故时段禁止在场。
  assert.match(prompt, /【凡多·灰袍】出生复兴纪元400年（已知资料显式记载）；已故于复兴纪元479年/u);
  assert.match(prompt, /事件在场年龄 = 事件年份 − 400/u);
  // 界外来客：硬事实 + 推断线 + 抵达线一致性规则（不把 400 年当铁律）。
  assert.match(prompt, /【梅薇娜·王尔德】硬事实：基准复兴纪元488年时88岁，界外来客/u);
  assert.match(prompt, /穿越\/抵达时间世界书未记载/u);
  assert.match(prompt, /抵达时0岁/u);
  assert.match(prompt, /禁止同一人物同时出现「已在此地数十年」与「初来乍到」两条互相矛盾的抵达线/u);
  // 未来上限指示同步注入。
  assert.match(prompt, /current story time/u);
});

test('墟境自动召回的谱系人物无需手选也会获得事件年龄与生命阶段约束', () => {
  const context = makeContext();
  const genealogySource = {
    sourceId: 'genealogy:lingshan:family',
    sourceType: 'genealogy' as const,
    title: '玲山·哈姆斯沃思宗族谱系（当前局部）',
    content: '瓦伦·哈姆斯沃思与玛丽斯·晨羽是本轮可用的谱系人物。',
    authority: 70,
  };
  context.evidenceBundle = makeEvidenceBundle([genealogySource]);
  context.evidenceBundle.personTimeline = [
    {
      name: '瓦伦·哈姆斯沃思', state: 'alive', narrative: '',
      lifespan: { born: { era: '复兴纪元', year: 435 }, died: { era: '复兴纪元', year: 482 } },
    },
    {
      name: '玛丽斯·晨羽', state: 'alive', narrative: '',
      lifespan: { born: { era: '复兴纪元', year: 442 }, died: null },
    },
  ];
  const input = makeInput();
  input.start = { year: 450, month: 2, day: 11 };
  input.end = { year: 450, month: 5, day: 19 };
  input.selectedCharacters = [];
  input.supplementaryDirection = '';
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '探索玲山宗族在复兴纪元450年的历史',
    generationInput: input,
    context,
    rules: { generationContract: '契约' },
  });
  assert.match(prompt, /【瓦伦·哈姆斯沃思】出生复兴纪元435年/u);
  assert.match(prompt, /事件在场年龄 = 事件年份 − 435/u);
  assert.match(prompt, /复兴纪元450年=15岁/u);
  assert.match(prompt, /【玛丽斯·晨羽】出生复兴纪元442年/u);
  assert.match(prompt, /事件在场年龄 = 事件年份 − 442/u);
  assert.match(prompt, /复兴纪元450年=8岁/u);
  assert.match(prompt, /不得把其后来成年后的身份倒灌进童年或少年期/u);
  assert.match(prompt, /make the role and agency fit that life stage/u);
});

/** 玲山·哈姆斯沃思：27 岁（基准 488）→ 出生 461 年，琉璃塔社长。 */
function makeLingshanSelectedCharacter() {
  return {
    mvuId: 'm-lingshan',
    name: '玲山·哈姆斯沃思',
    source: 'mvu' as const,
    identities: ['琉璃塔信报社社长', '头版女王'],
    race: '翼族',
    professions: ['调查记者', '报业掌权者'],
    relations: ['铃羽'],
    lifespan: '27岁',
    contextSummary: '琉璃塔信报社社长、头版女王',
  };
}

function withLingshanTimeline(context: RuinContextBundle): RuinContextBundle {
  return {
    ...context,
    evidenceBundle: {
      ...context.evidenceBundle,
      personTimeline: [{
        name: '玲山·哈姆斯沃思',
        state: 'alive',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: 461 },
          ageAtRecord: 27,
          basedOnEra: '复兴纪元',
          basedOnYear: 488,
          ageBased: true,
        },
      }],
    },
  };
}

test('场景A：未写时间时自动时间范围下界不低于选中人物出生年（玲山 27 岁 → ≥461）', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [makeLingshanSelectedCharacter()];
  const resolved = resolveAutomaticRuinRange(input, withLingshanTimeline(makeContext()));
  assert.equal(resolved.automatic, true);
  assert.ok(
    resolved.input.start!.year !== null && resolved.input.start!.year >= 461,
    `自动范围下界应为 ≥461，实际 ${resolved.input.start!.year}`,
  );
  assert.ok(
    resolved.input.end!.year !== null && resolved.input.end!.year >= resolved.input.start!.year!,
  );
  assert.equal(resolved.input.start!.year, 461, '短生涯自动范围应从人物可在场起点开始');
  assert.equal(resolved.input.end!.year, 488, '短生涯自动范围应延伸到当前剧情时间');
});

test('未指定方向或人物时仍保留短而可复现的自动历史窗口', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [];
  input.supplementaryDirection = '';
  const context = makeContext();
  context.currentWorld.time = '复兴纪元488年-1月-1日';
  const first = resolveAutomaticRuinRange(input, context);
  const second = resolveAutomaticRuinRange(input, context);
  assert.deepEqual(first, second);
  const duration = first.input.end!.year! - first.input.start!.year!;
  assert.ok(duration >= 3 && duration <= 12, `无人物锚时仍应使用 3–12 年窗口，实际 ${duration}`);
});

test('场景A2：寿命相容判定接引擎换算——「27岁」解析为出生 461，候选 258-269 判不兼容', () => {
  const input = makeInput();
  input.start = { year: 258, month: 1, day: 1 };
  input.end = { year: 269, month: 12, day: 31 };
  input.selectedCharacters = [makeLingshanSelectedCharacter()];
  const result = makeCandidatesWithinRange(input);
  result.candidates[0]!.span = {
    start: { year: 258, month: 1, day: 1 },
    end: { year: 269, month: 12, day: 31 },
    label: '复兴纪元258年 - 269年',
  };
  result.candidates[0]!.cast = [{
    name: '玲山·哈姆斯沃思',
    kind: 'person',
    identity: '琉璃塔信报社社长',
    role: '参与人物',
    desire: '调查真相',
    constraint: '当代人',
    sourceRefs: [],
    inference: false,
  }, ...result.candidates[0]!.cast];
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 258 + index,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${258 + index}年1月1日`,
    },
    participants: [...node.participants, '玲山·哈姆斯沃思'],
  }));
  // 不兼容（出生 461 > 候选最晚 269）却仍被写进 cast/参与者 → 硬校验拦截，带三路指引。
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: withLingshanTimeline(makeContext()),
    }),
    /CHARACTER_ABSENT_WINDOW|无法在场|三选一/u,
  );
});

test('场景B：214 年候选——玲山未出生（461 年后）且不出现在 cast/参与者时通过（缺席退路）', () => {  const input = makeInput();
  input.start = { year: 214, month: 1, day: 1 };
  input.end = { year: 214, month: 12, day: 31 };
  input.selectedCharacters = [makeLingshanSelectedCharacter()];
  const result = makeCandidates();
  result.candidates.forEach((candidate, index) => {
    candidate.span = {
      start: { year: 214, month: 1, day: 1 },
      end: { year: 214, month: 12, day: 31 },
      label: '复兴纪元214年',
    };
    candidate.nodes = candidate.nodes.map((node, nodeIndex) => ({
      ...node,
      time: {
        year: 214,
        month: 1,
        day: 1 + nodeIndex,
        hour: 12,
        minute: 0,
        label: `复兴纪元214年1月${1 + nodeIndex}日`,
      },
    }));
  });
  const context = withLingshanTimeline(makeContext());
  const passage = context.evidenceBundle.passages[0];
  context.evidenceBundle.castManifest = {
    schema: 'eyon.retrieval.cast-manifest.v1',
    entries: [{
      entityId: 'entity:%E7%8E%B2%E5%B1%B1',
      disposition: 'required',
      role: 'actor',
      reasons: ['direct-query-entity-temporal-conflict-degraded'],
      identity: {
        canonicalName: '玲山·哈姆斯沃思',
        aliases: [],
        kinds: ['person'],
        identities: ['琉璃塔信报社社长', '头版女王'],
        temporalScopes: ['复兴纪元461年—在世'],
        locationScopes: ['艾瑟嘉德'],
        sourceSnapshotIds: [passage.snapshotId],
        passageIds: [passage.passageId],
      },
    }],
    groupCoverage: [],
  };
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '探索玲山出生前的世界',
    generationInput: input,
    context,
    rules: { generationContract: '契约' },
  });
  assert.match(prompt, /未出生\/已故，高于本轮 CAST_MANIFEST 的 required 出场要求/u);

  // 模拟模型仍服从旧冲突合同，把 required 人物塞回三条支线；脚本必须确定性移除。
  result.candidates.forEach(candidate => {
    candidate.cast.unshift({
      name: '玲山·哈姆斯沃思',
      kind: 'person',
      identity: '琉璃塔信报社社长、头版女王',
      role: '玩家点名人物',
      desire: '调查真相',
      constraint: '出生于复兴纪元461年',
      sourceRefs: [],
      inference: false,
    });
    candidate.nodes = candidate.nodes.map(node => ({
      ...node,
      participants: [...node.participants, '玲山·哈姆斯沃思'],
    }));
  });
  // 即使 CastManifest 把点名人物列为 required，硬时间缺席仍让她不进入任何 cast/节点。
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(parsed.candidates.length, 3);
  const anyLingshan = parsed.candidates.some(candidate =>
    candidate.cast.some(member => member.name.includes('玲山'))
    || candidate.nodes.some(node => node.participants.some(participant => participant.includes('玲山'))));
  assert.equal(anyLingshan, false, '缺席模式下玲山不得出现在 cast 或节点参与者');
});

test('墟境 prompt 注入完整人物卡、缺席叙事模式与未排序事件证据', () => {
  const context = withLingshanTimeline(makeContext());
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '玲山·哈姆斯沃思',
      state: 'alive',
      narrative: '',
      lifespan: {
        born: { era: '复兴纪元', year: 461 },
        ageAtRecord: 27,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
      },
      lifeAnchors: [
        { event: '离开梵尼亚', relation: 'before-current', anchor: '梵尼亚', sourceLabel: '玲山·哈姆斯沃思' },
        { event: '抵达帝国', relation: 'before-current', anchor: '帝国', sourceLabel: '玲山·哈姆斯沃思' },
      ],
    }],
    taskAnchorAttachments: [{
      schema: 'eyon.retrieval.task-anchor-attachment.v1',
      attachmentId: 'attachment:lingshan:fixture',
      entityId: 'entity:lingshan',
      canonicalName: '玲山·哈姆斯沃思',
      sourceId: 'worldbook:lingshan',
      snapshotId: 'worldbook:lingshan@sha256:fixture',
      sourceType: 'worldbook',
      title: '[角色]玲山·哈姆斯沃思',
      content: '背景口述：我离开梵尼亚的时候，带走的东西其实不多。官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
      contentHash: 'a'.repeat(64),
      charCount: 58,
      purpose: 'direct-character-entry',
    }],
  };
  context.characterCards = [{
    sourceId: 'mvu-character:玲山·哈姆斯沃思',
    sourceType: 'mvu',
    title: '玲山·哈姆斯沃思',
    content: '旧兼容入口中的错误污染内容，不应在已有检索附件时进入 prompt。',
    authority: 95,
  }];
  const input = makeInput();
  input.selectedCharacters = [makeLingshanSelectedCharacter()];
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: '契约' },
  });
  assert.match(prompt, /<CHARACTER_CARDS_FULL>/u);
  assert.match(prompt, /我离开梵尼亚的时候/u);
  assert.match(prompt, /铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的/u);
  assert.match(prompt, /attachment:lingshan:fixture/u);
  assert.doesNotMatch(prompt, /旧兼容入口中的错误污染内容/u);
  assert.match(prompt, /<RUIN_ABSENCE_MODE>/u);
  assert.match(prompt, /绝对缺席只适用于 CHARACTER_TIME_ANCHORS 能确定的未出生或已故/u);
  assert.match(prompt, /受限状态，并不等于人物不存在/u);
  assert.match(prompt, /允许人物在限制所容许的地点、身份、能力、认知和行动范围内出现/u);
  assert.match(prompt, /可以把变化写成本任务候选中的局部状态转移/u);
  assert.match(prompt, /必须保留既有前史，不得改写成限制从未发生；候选本身不等于永久 Canon/u);
  assert.match(prompt, /其到来之前\/其影响之后/u);
  assert.doesNotMatch(prompt, /未出生\/已故\/失踪\/失能/u);
  assert.doesNotMatch(prompt, /禁止其以任何形态在场/u);
  assert.match(prompt, /事件证据（列出顺序不是时间线）：离开梵尼亚／顺序未定；抵达帝国／顺序未定/u);
  assert.doesNotMatch(prompt, /既定事件链|离开梵尼亚 → 抵达帝国/u);
});

test('墟境规划和冻结扩写均先保留已知事件年龄/生日/时刻，不以候选差异改写', () => {
  const context = makeContext();
  const input = makeInput();
  const promptInput = { requestId, directive: '墟境探索', generationInput: input, context,
    rules: { generationContract: '契约' } };
  const response = makeOutlineResponse(input);
  const outline = parseAndNormalizeRuinOutlines(JSON.stringify(response), { requestId, directive: '墟境探索', input, context }).candidates[0]!;
  const prompts = [buildRuinOutlineBatchApiPrompt(promptInput),
    buildRuinExpansionApiPrompt(promptInput, input.materials[0]!, outline)];
  for (const prompt of prompts) {
    assert.match(prompt, /<KNOWN_EVENT_FAITHFULNESS_READ_ONLY>/u);
    assert.match(prompt, /不得为了制造不同候选给同一已知事件重排年份或改写年龄/u);
    assert.match(prompt, /出生年加N的同月同日/u);
    assert.match(prompt, /原句时刻同样保留/u);
    assert.match(prompt, /不能把兄弟姐妹的不同经历互相挪用/u);
    assert.match(prompt, /不能把事件搬入范围/u);
    assert.match(prompt, /不可通过删除年龄、模糊日期/u);
  }
  assert.match(prompts[0]!, /For one requested canonical incident/u);
  assert.match(prompts[1]!, /SELECTED_OUTLINE_READ_ONLY/u);
  const recovery = buildCompactRuinExpansionRecoveryPrompt(prompts[1]!);
  assert.match(recovery!, /KNOWN_EVENT_FAITHFULNESS_READ_ONLY/u);
});

test('不判错：界外来客（arrivalBased）自洽抵达线不参与不兼容硬判定（推断抵达年只是假说）', () => {
  // 梅薇娜：界外来客，推断抵达 400 年（基准 488 时 88 岁）。候选时段 380 年——
  // 模型若写「她 370 年穿越、380 年在场」是契约允许的自洽抵达线（internal.54 语义），
  // 不得因推断抵达年（400）晚于候选时段而被 CHARACTER_ABSENT_WINDOW 误拦。
  const input = makeInput();
  input.start = { year: 380, month: 1, day: 1 };
  input.end = { year: 385, month: 12, day: 31 };
  input.selectedCharacters = [{
    mvuId: 'm-mevina',
    name: '梅薇娜·王尔德',
    source: 'mvu',
    identities: ['晨曙书局局长'],
    race: '人类',
    professions: ['裁书人'],
    relations: [],
    lifespan: '88岁',
    contextSummary: '晨曙书局局长',
  }];
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '梅薇娜·王尔德',
      state: 'alive',
      narrative: '',
      lifespan: {
        born: { era: '复兴纪元', year: 400 },
        ageAtRecord: 88,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
        arrivalBased: true,
      },
    }],
  };
  const result = makeCandidatesWithinRange(input);
  result.candidates[0]!.span = {
    start: { year: 380, month: 1, day: 1 },
    end: { year: 385, month: 12, day: 31 },
    label: '复兴纪元380年 - 385年',
  };
  result.candidates[0]!.cast = [{
    name: '梅薇娜·王尔德',
    kind: 'person',
    identity: '晨曙书局局长',
    role: '参与人物',
    desire: '调查真相',
    constraint: '界外来客',
    sourceRefs: [],
    inference: false,
  }, ...result.candidates[0]!.cast];
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 380 + index,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${380 + index}年1月1日`,
    },
    participants: [...node.participants, '梅薇娜·王尔德'],
  }));
  // 不拦截（arrivalBased 保持宽松）——不判错原则。
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId,
    directive: '墟境探索',
    input,
    context,
  });
  assert.equal(parsed.candidates.length, 3);
});

test('名字保守匹配：关系列表 key 与选中人物名全/简称不一致时仍命中时间锚', () => {
  // 关系列表 key = 「玲山」，选中人物名 = 「玲山·哈姆斯沃思」——精确匹配会全线失效，
  // 保守包含匹配必须兜住：自动范围下界 ≥ 461。
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = [makeLingshanSelectedCharacter()]; // 全名
  const context = makeContext();
  context.evidenceBundle = {
    ...context.evidenceBundle,
    personTimeline: [{
      name: '玲山', // 关系列表短名
      state: 'alive',
      narrative: '',
      lifespan: {
        born: { era: '复兴纪元', year: 461 },
        ageAtRecord: 27,
        basedOnEra: '复兴纪元',
        basedOnYear: 488,
        ageBased: true,
      },
    }],
  };
  const resolved = resolveAutomaticRuinRange(input, context);
  assert.equal(resolved.automatic, true);
  assert.ok(
    resolved.input.start!.year !== null && resolved.input.start!.year >= 461,
    `保守匹配后自动范围下界应为 ≥461，实际 ${resolved.input.start!.year}`,
  );
});

test('点名即进入：未选参与人物，仅补充方向点名玲山，自动范围仍 ≥461 且锚块注入', () => {
  const input = makeInput();
  input.start = null;
  input.end = null;
  input.selectedCharacters = []; // 玩家未选择参与人物
  input.supplementaryDirection = '玲山·哈姆斯沃思与妹妹铃羽在梵尼亚遭遇的困苦之事';
  const context = withLingshanTimeline(makeContext());
  // 补充方向 + 指令文本传入 mentionTexts。
  const resolved = resolveAutomaticRuinRange(
    input,
    context,
    [input.supplementaryDirection, '墟境探索 玲山·哈姆斯沃思'],
  );
  assert.equal(resolved.automatic, true);
  assert.ok(
    resolved.input.start!.year !== null && resolved.input.start!.year >= 461,
    `点名后自动范围下界应为 ≥461，实际 ${resolved.input.start!.year}`,
  );

  // 锚块：未选参与人物但点名 → 仍注入她的窗口。
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: resolved.input,
    context,
    rules: { generationContract: '契约' },
  });
  assert.match(prompt, /【玲山·哈姆斯沃思】出生复兴纪元461年/u);
  assert.match(prompt, /<RUIN_ABSENCE_MODE>/u);
});

test('点名即进入：候选实际出现未选中的玲山（出生 461）在 258-269 → CHARACTER_ABSENT_WINDOW 拦截', () => {
  const input = makeInput();
  input.start = { year: 258, month: 1, day: 1 };
  input.end = { year: 269, month: 12, day: 31 };
  input.selectedCharacters = []; // 未选
  input.supplementaryDirection = '玲山·哈姆斯沃思与妹妹铃羽在梵尼亚遭遇的困苦之事';
  const result = makeCandidatesWithinRange(input);
  result.candidates[0]!.span = {
    start: { year: 258, month: 1, day: 1 },
    end: { year: 269, month: 12, day: 31 },
    label: '复兴纪元258年 - 269年',
  };
  result.candidates[0]!.cast = [{
    name: '玲山·哈姆斯沃思',
    kind: 'person',
    identity: '琉璃塔信报社社长',
    role: '参与人物',
    desire: '调查真相',
    constraint: '当代人',
    sourceRefs: [],
    inference: false,
  }, ...result.candidates[0]!.cast];
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: 258 + index,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${258 + index}年1月1日`,
    },
    participants: [...node.participants, '玲山·哈姆斯沃思'],
  }));
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
      requestId,
      directive: '墟境探索',
      input,
      context: withLingshanTimeline(makeContext()),
    }),
    /CHARACTER_ABSENT_WINDOW|无法在场|三选一/u,
  );
});

/** 构造「候选在 X-Y 年 + 玲山出现在 cast/节点」的候选集（供在场校验路径测试）。 */
function makeLingshanPresentCandidateSet(startYear: number, endYear: number): RuinCandidates {
  const fixtureInput = makeInput();
  fixtureInput.start = { year: startYear, month: 1, day: 1 };
  fixtureInput.end = { year: endYear, month: 12, day: 31 };
  const result = makeCandidatesWithinRange(fixtureInput);
  result.candidates[0]!.span = {
    start: { year: startYear, month: 1, day: 1 },
    end: { year: endYear, month: 12, day: 31 },
    label: `复兴纪元${startYear}年 - ${endYear}年`,
  };
  result.candidates[0]!.cast = [{
    name: '玲山·哈姆斯沃思',
    kind: 'person',
    identity: '琉璃塔信报社社长',
    role: '参与人物',
    desire: '调查真相',
    constraint: '当代人',
    sourceRefs: [],
    inference: false,
  }, ...result.candidates[0]!.cast];
  result.candidates[0]!.nodes = result.candidates[0]!.nodes.map((node, index) => ({
    ...node,
    time: {
      year: Math.min(startYear + index, endYear),
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
      label: `复兴纪元${startYear + index}年1月1日`,
    },
    participants: [...node.participants, '玲山·哈姆斯沃思'],
  }));
  return result;
}

/** 原夹具只改候选0，其余候选仍在145年；过去靠日期钳制掩盖了这些越界。 */
function makeCandidatesWithinRange(input: RuinGenerationInput): RuinCandidates {
  const result = makeCandidates();
  for (const candidate of result.candidates) {
    candidate.span.start = { ...input.start! };
    candidate.span.end = { ...input.end! };
    for (const [index, node] of candidate.nodes.entries()) {
      node.time = { ...input.start!, hour: 8 + index * 3, minute: 0, label: '' };
    }
  }
  return result;
}

test('0.14.3: 大纲的明确越界日期不再被静默改成年内日期', () => {
  const input = makeInput();
  const result = makeCandidates();
  result.candidates[0]!.nodes[0]!.time.year = 144;
  assert.throws(() => parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId, directive: '墟境探索', input, context: makeContext(),
  }), (error: unknown) => error instanceof RuinValidationError && error.code === 'NODE_OUT_OF_REQUEST_RANGE');
  assert.equal(result.candidates[0]!.nodes[0]!.time.year, 144);
});

test('0.14.3: 同一事件候选可共享日期，四阶段可在同日不同小时推进', () => {
  const input = makeInput();
  input.start = { year: 478, month: 7, day: 15 };
  input.end = { year: 478, month: 7, day: 15 };
  const result = makeCandidatesWithinRange(input);
  const parsed = parseAndNormalizeRuinOutlines(JSON.stringify(result), {
    requestId, directive: '墟境探索', input, context: makeContext(),
  });
  for (const candidate of parsed.candidates) {
    assert.deepEqual(candidate.span.start, input.start);
    assert.deepEqual(candidate.span.end, input.end);
    assert.equal(new Set(candidate.nodes.map(node => node.time.hour)).size, 4);
    for (const node of candidate.nodes) assert.equal(node.time.day, 15);
  }
});

function withLingshanTimelineOf(
  context: RuinContextBundle,
  bornYear: number,
  diedYear: number | null,
): RuinContextBundle {
  return {
    ...context,
    evidenceBundle: {
      ...context.evidenceBundle,
      personTimeline: [{
        name: '玲山·哈姆斯沃思',
        state: diedYear === null ? 'alive' : 'deceased',
        narrative: '',
        lifespan: {
          born: { era: '复兴纪元', year: bornYear },
          ...(diedYear === null
            ? { ageAtRecord: 27, basedOnEra: '复兴纪元', basedOnYear: 488, ageBased: true }
            : { died: { era: '复兴纪元', year: diedYear } }),
        },
      }],
    },
  };
}

test('防误判#1：只有出生年（无死亡记录）的人物，出生年后的候选时段放行', () => {
  const input = makeInput();
  input.start = { year: 464, month: 1, day: 1 };
  input.end = { year: 466, month: 12, day: 31 };
  input.selectedCharacters = [];
  const parsed = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeLingshanPresentCandidateSet(464, 466)),
    {
      requestId,
      directive: '墟境探索',
      input,
      context: withLingshanTimeline(makeContext()),
    },
  );
  assert.equal(parsed.candidates.length, 3);
});

test('防误判#2：生卒字符串倒写（479年 - 400年）按绝对年排序纠正，不误拦中间时段', () => {
  const input = makeInput();
  input.start = { year: 450, month: 1, day: 1 };
  input.end = { year: 460, month: 12, day: 31 };
  input.selectedCharacters = [];
  const parsed = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeLingshanPresentCandidateSet(450, 460)),
    {
      requestId,
      directive: '墟境探索',
      input,
      context: withLingshanTimelineOf(makeContext(), 400, 479),
    },
  );
  assert.equal(parsed.candidates.length, 3);
});

test('防误判#3：「活跃于400年-410年」是活动范围非生卒，不误判为死亡', () => {
  const input = makeInput();
  input.start = { year: 450, month: 1, day: 1 };
  input.end = { year: 460, month: 12, day: 31 };
  input.selectedCharacters = [{
    mvuId: 'm',
    name: '玲山·哈姆斯沃思',
    source: 'mvu',
    identities: ['琉璃塔信报社社长'],
    race: '翼族',
    professions: [],
    relations: [],
    lifespan: '活跃于复兴纪元400年-410年',
    contextSummary: '社长',
  }];
  const parsed = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeLingshanPresentCandidateSet(450, 460)),
    {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    },
  );
  assert.equal(parsed.candidates.length, 3);
});

test('防误判#4：「461年 - 至今」识别为在世，出生年后时段放行', () => {
  const input = makeInput();
  input.start = { year: 470, month: 1, day: 1 };
  input.end = { year: 480, month: 12, day: 31 };
  input.selectedCharacters = [{
    mvuId: 'm',
    name: '玲山·哈姆斯沃思',
    source: 'mvu',
    identities: ['琉璃塔信报社社长'],
    race: '翼族',
    professions: [],
    relations: [],
    lifespan: '复兴纪元461年 - 至今',
    contextSummary: '社长',
  }];
  const parsed = parseAndNormalizeRuinOutlines(
    JSON.stringify(makeLingshanPresentCandidateSet(470, 480)),
    {
      requestId,
      directive: '墟境探索',
      input,
      context: withLingshanTimeline(makeContext()),
    },
  );
  assert.equal(parsed.candidates.length, 3);
});

// ============ internal.76 收尾包 A/B 回归 ============

test('传记事件时间线：明确纪年按绝对年排序去重，无纪年不出行', () => {
  const body = [
    '起源(复兴纪元461年)：玲山出生在梵尼亚。',
    '复兴纪元四七六年，金雨降临，铃羽被选中去无尽地城。', // 中文数字纪年（77 覆盖）
    '复兴纪元477年，玲山深夜潜入圣纹工坊剥离圣纹。',
    '复兴纪元478年，她独自离开梵尼亚。',
    '复兴纪元477年，次日黎明莫兰发现圣纹异动。', // 同年代言去重（保留首见）
    '没有年份的事件不进入时间线。',
    '混a纪元的旧历不匹配。',
  ].join('\n');
  const timeline = extractBiographyTimeline(body);
  assert.equal(timeline.length, 4, `应提取 461/476/477/478 四行，实际 ${JSON.stringify(timeline)}`);
  assert.ok(timeline[0]!.includes('461年') && timeline[0]!.includes('玲山出生'));
  assert.ok(timeline[1]!.includes('四七六年'), '中文数字纪年应原样保留在行文本中');
  assert.ok(timeline[1]!.includes('金雨'), '中文数字行应按绝对年正确排序');
  assert.ok(timeline[2]!.includes('477年') && timeline[2]!.includes('剥离圣纹'));
  assert.ok(timeline[3]!.includes('478年') && timeline[3]!.includes('离开梵尼亚'));
  assert.equal(timeline[1]!.includes('莫兰'), false, '同年后续句按首见去重');
});

test('中文数字年份转换：阿拉伯/中文/带位权/零 全部确定性可译', () => {
  assert.equal(chineseYearToNumber('476'), 476);
  assert.equal(chineseYearToNumber('四七六'), 476);
  assert.equal(chineseYearToNumber('四百七十六'), 476);
  assert.equal(chineseYearToNumber('十二'), 12);
  assert.equal(chineseYearToNumber('一〇八'), 108);
  assert.equal(chineseYearToNumber('千零一夜'), null); // 非法组合不推断
});

test('传记全文参考：超长原文完整保留并带事件时间线尾注', () => {
  const body = '复兴纪元477年，玲山深夜潜入圣纹工坊。\n' + '内容。'.repeat(9000);
  const ref = biographyFullReference(body, 8000);
  assert.ok(ref.includes('【事件时间线】'));
  assert.ok(ref.includes('- 复兴纪元477年，玲山深夜潜入圣纹工坊'));
  assert.ok(ref.startsWith(body));
  assert.doesNotMatch(ref, /截断至/u);
  const noDate = biographyFullReference('没有任何纪年的传记正文。');
  assert.ok(!noDate.includes('【事件时间线】'));
});

test('传记 digest v2.2：顶层携带 timeline 与 objectBands（物件时间带+语境摘录）', () => {
  const digestText = digestBiographySource(JSON.stringify({
    target: { name: '玲山·哈姆斯沃思' },
    span: '复兴纪元461年-488年',
    summary: '报业女王',
    origin: { title: '起源(复兴纪元461年)', content: '' },
    stages: [
      { title: '圣民', span: '476年-479年', content: '一枚冰冷的圣纹压制环被死死扣在她的高领之下。', objects: ['圣纹压制环', '留影相机'] },
      { title: '流亡', span: '480年-482年', content: '', objects: [] },
    ],
    status: { title: '现状(复兴纪元488年)', content: '她摩挲着高领下滚烫的圣纹压制环。' },
  }));
  const parsed = JSON.parse(digestText) as { schema?: string; objectBands?: string[] };
  assert.match(parsed.schema ?? '', /digest\.v2\.2/u);
  const band = parsed.objectBands?.[0] ?? '';
  assert.ok(band.includes('476年-479年：圣纹压制环'), `物件时间带应含环与时段，实际 ${band}`);
  assert.ok(band.includes('原文：「一枚冰冷的圣纹压制环被死死扣在'), '物件应附原文语境句');
  const statusBand = parsed.objectBands?.find(line => line.includes('现状（延续）')) ?? '';
  assert.ok(statusBand.includes('滚烫的圣纹压制环'), '现状段提及的物件应追加现状语境行');
});

test('物件时间带：无物件段不出行；原文无语境时保持纯名单', () => {
  const withBands = extractObjectBands(JSON.stringify({
    stages: [{ span: '476年-479年', content: '', objects: ['圣纹压制环'] }],
  }));
  assert.deepEqual(withBands, ['476年-479年：圣纹压制环']);
  const none = extractObjectBands(JSON.stringify({
    stages: [{ span: '476年-479年', content: '', objects: [] }],
  }));
  assert.equal(none.length, 0);
});

test('物件时间带：同名物件在后段的损坏与封存状态不被首见语境覆盖', () => {
  const bands = extractObjectBands(JSON.stringify({
    stages: [
      { span: '461年-475年', content: '玲山在旧货摊上得到了旧式留影相机。', objects: ['旧式留影相机'] },
      { span: '480年-482年', content: '旧式留影相机在逃亡中摔裂，随后被封存在木匣内。', objects: ['旧式留影相机'] },
    ],
  }));
  assert.equal(bands.length, 2);
  assert.match(bands[0] ?? '', /得到了旧式留影相机/u);
  assert.match(bands[1] ?? '', /旧式留影相机在逃亡中摔裂/u);
  assert.match(bands[1] ?? '', /封存/u);
});

test('NODE_ID_DUPLICATE 报错可操作化：指明候选与重复节点 ID', () => {
  const input = makeInput();
  const raw = makeOutlineResponse(input);
  // 制造候选 0 节点 ID 重复
  raw.candidates[0]!.nodes[1]!.id = raw.candidates[0]!.nodes[0]!.id;
  assert.throws(
    () => parseAndNormalizeRuinOutlines(JSON.stringify(raw), {
      requestId,
      directive: '墟境探索',
      input,
      context: makeContext(),
    }),
    (error: unknown) => error instanceof RuinValidationError
      && error.code === 'NODE_ID_DUPLICATE'
      && /候选《.*》/.test(error.message)
      && /n1–n4/.test(error.message),
  );
});

test('大纲修复提示包含结构指引（节点 ID 唯一/时间单调/参与者来自 cast）', () => {
  // 使用既有大纲修复提示构造器（buildRuinOutlineRepairPrompt 已导入）
  const prompt = buildRuinOutlineRepairPrompt('原提示', 'Ruin node IDs must be unique');
  assert.match(prompt, /node ids unique inside each candidate/u);
  assert.match(prompt, /origin\/process\/anomaly\/result/u);
  assert.match(prompt, /node times monotonic/u);
});

test('候选重名 warning：同批同名不同身份 → 提示；同身份复用 → 不提示', () => {
  const castMember = (name: string, identity: string) => ({
    name, kind: 'person' as const, identity, role: 'r', desire: '', constraint: '', sourceRefs: [], inference: false,
  });
  const candidateWith = (casts: ReturnType<typeof castMember>[]) => ({ cast: casts }) as never;
  const different = collectRuinCastNameWarnings([
    candidateWith([castMember('尤利安', '导师')]),
    candidateWith([castMember('尤利安', '皇储')]),
    candidateWith([castMember('马库斯', '将军')]),
  ] as never);
  assert.ok(different.some(w => w.includes('尤利安')), `同名异身份应生成 warning，实际 ${JSON.stringify(different)}`);
  const same = collectRuinCastNameWarnings([
    candidateWith([castMember('石匠行会', '旧堡本地营造组织')]),
    candidateWith([castMember('石匠行会', '旧堡本地营造组织')]),
  ] as never);
  assert.equal(same.length, 0, '同身份跨候选复用不提示');
});

test('当代参考标注：mvu passage 渲染边界标签，已选人物仅为重点参考', () => {
  const input = makeInput();
  input.selectedCharacters = [{
    mvuId: 'm-lingshan',
    name: '玲山·哈姆斯沃思',
    source: 'mvu',
    identities: [],
    race: '翼族',
    professions: [],
    relations: [],
    lifespan: '27岁',
    contextSummary: '',
  }];
  const context = makeContext();
  context.sourceIndex = [
    { sourceId: 'mvu:汀瓦尔', sourceType: 'mvu', title: '汀瓦尔', content: '审判官。', authority: 95 },
    { sourceId: 'mvu:玲山·哈姆斯沃思', sourceType: 'mvu', title: '玲山·哈姆斯沃思', content: '社长。', authority: 95 },
  ];
  context.evidenceBundle = {
    ...context.evidenceBundle,
    passages: context.sourceIndex.map((source, index) => ({
      passageId: `P${index + 1}`,
      snapshotId: `S${index + 1}`,
      sourceId: source.sourceId,
      sourceType: source.sourceType as 'mvu',
      title: source.title,
      sectionPath: [],
      startOffset: 0,
      endOffset: source.content.length,
      extractionMode: 'full' as const,
      content: source.content,
      contentHash: `h${index}`,
      charCount: source.content.length,
      matchedAnchors: [],
      temporalScopes: [],
      selectionReasons: ['fixture'],
    })),
  };
  const prompt = buildRuinOutlineBatchApiPrompt({
    requestId,
    directive: '墟境探索',
    generationInput: input,
    context,
    rules: { generationContract: 'generation contract' },
  });
  assert.match(prompt, /当代参考·仅供关系\/现状\/命名惯例·不得采用为历史演员或舞台/u);
  assert.match(prompt, /已选重点参考·提高检索注意力·不保证出场/u);
  assert.match(prompt, /DLC character cards/u);
  assert.match(prompt, /Source and worldbook titles are script labels/u);
  // 既定事件关键地点名一致性软引导（internal.77 四轮覆盖，泣空遗迹病历后）。
  assert.match(prompt, /Stable landmarks and key destinations of established events/u);
  assert.match(prompt, /one story must not use two names for the same destination/u);
});
