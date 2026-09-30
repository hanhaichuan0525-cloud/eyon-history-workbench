import type { ContextSource, RuinContextBundle } from '../core/context.ts';
import type { EvidencePassage, TaskCitationRegistry } from '../retrieval/contracts.ts';
import {
  maskTaskCitationIdentifiers,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import { activeTemporalEligibilityRules, assessStagePerson } from '../retrieval/temporal.ts';
import { ruinProseLengthInstruction } from '../core/ruinProseContract.ts';
import {
  buildActiveEvidenceView,
  renderActiveEvidenceBlock,
  requestedEraFromText,
} from './activeEvidence.ts';
import type {
  RuinCandidate,
  RuinGenerationInput,
  RuinMaterial,
} from '../schemas/ruin.ts';
import { KNOWN_EYON_ERAS } from '../schemas/ruin.ts';
import {
  findPersonTimelineEntry,
  personMentionedIn,
  personNameMatches,
} from '../retrieval/temporal.ts';
import {
  renderCurrentSceneSemanticSnapshot,
  renderTaskSubjectBoundary,
  resolveCurrentSceneReference,
} from '../core/currentSceneReference.ts';
import { renderContinuityView } from '../runtime/continuityAnchors.ts';
import type { ContinuityView } from '../core/continuityAnchors.ts';

const REFERENCE_TOTAL_LIMIT = 9_000;
const REFERENCE_ITEM_LIMIT = 1_800;
const REFERENCE_ITEM_COUNT_LIMIT = 8;
const RECENT_CHAT_FALLBACK_LIMIT = 2;
const RECENT_CHAT_ITEM_LIMIT = 1_200;

const PERIOD_ANCHORING_BLOCK = [
  '<PERIOD_ANCHORING>',
  '写任何节点或史稿前，先在内部把它锚定到世界书的一个明确历史时期，并确认三件事同时成立：',
  '1. 人物在场：每个出场人物在该时期必须「已经出生、尚未死亡、年龄合适、且有可信的到场渠道」。生卒年与年龄判断一旦建立就全程一致；年代不相容的人物只能通过先祖、组织传承、遗物、记录或后世影响建立联系，不得伪造成当时在世。',
  '2. 背景在场：该时期的制度、势力、技术、地缘、器物与风气必须符合世界书对该时期与地点的设定。不得把后来的制度、人物或器物提前，也不得把已消亡的残留到后来。',
  '3. 时间在场：节点与 span 的纪年必须落在所选历史时期内，并与地点在该时期的真实状态呼应；未填写起止时间时，根据地点、纪元与史料推断一个具体且自洽的历史跨度；任何节点与跨度都不得晚于当前剧情时间（currentWorld.time 即剧情现在，穿越只能回到过去）。',
  '4. 借名即查证：凡使用史料（EVIDENCE_LEDGER / REFERENCE_DATA）中已具名的角色，其身份与条目必须一致——不得移植、不得改名、不得安到别的身份或年代；同一名字全局只能指同一个人。年龄 = 事件年代 − 出生年，无出生数据不得捏造精确年龄。',
  '5. 推断有尺度：可大胆补全局部人物、家族惯例与制度、场景、动机和连接因果；只有把局部补史无依据地扩张成无关的大陆/世界级制度、神明契约、国家法典或文明重写时，才要求 EVIDENCE_LEDGER / HISTORICAL_AUTHORITY 的直接支持。',
  '</PERIOD_ANCHORING>',
];

export interface RuinRuleSet {
  generationContract: string;
}

export interface RuinPromptInput {
  requestId: string;
  directive: string;
  generationInput: RuinGenerationInput;
  context: RuinContextBundle;
  rules: RuinRuleSet;
  automaticTimeRange?: boolean;
  citationRegistry?: TaskCitationRegistry;
}

interface RuinHistoricalAmbiguityScope {
  era: string;
  start: RuinGenerationInput['start'];
  end: RuinGenerationInput['end'];
  automaticTimeRange?: boolean;
}

export interface RuinEarlierWindowProjection {
  view: ContinuityView | undefined;
  requiresCutoffReview: boolean;
  hiddenHandles: string[];
}

/**
 * P4-C2 的任务级证据投影：只在候选完整落于时间冲突的较早端时，
 * 隐去较晚低权记录的具体过程与结局。时间差异本身仍然可见，因此模型
 * 仍能写出疑云的前置引子，却不能把未来传记当成当时人物已经知道的答案。
 *
 * 这不会修改持久化 ContinuityView，也不会作用于普通墟境、较晚视角、
 * 跨越两端的视角或非时间差异。
 */
export function projectRuinContinuityForScope(
  view: ContinuityView | undefined,
  scope: RuinHistoricalAmbiguityScope,
): RuinEarlierWindowProjection {
  if (!view?.relationGroups.length || scope.automaticTimeRange) {
    return { view, requiresCutoffReview: false, hiddenHandles: [] };
  }
  const requested = requestedTimeBand(scope);
  if (!requested) return { view, requiresCutoffReview: false, hiddenHandles: [] };

  const byHandle = new Map(view.anchors.map(anchor => [anchor.handle, anchor]));
  const hiddenHandles = new Set<string>();
  for (const group of view.relationGroups) {
    if (group.dimension !== 'time') continue;
    const left = byHandle.get(group.handles[0]);
    const right = byHandle.get(group.handles[1]);
    if (!left || !right) continue;
    const leftBand = continuityTimeBand(left.time, scope.era);
    const rightBand = continuityTimeBand(right.time, scope.era);
    if (!leftBand || !rightBand || leftBand.start === rightBand.start) continue;
    const [earlierBand, later] = leftBand.start < rightBand.start
      ? [leftBand, right] as const
      : [rightBand, left] as const;
    const laterBand = later === left ? leftBand : rightBand;
    if (bandsOverlap(requested, earlierBand) && !bandsOverlap(requested, laterBand)) {
      hiddenHandles.add(later.handle);
    }
  }
  if (hiddenHandles.size === 0) {
    return { view, requiresCutoffReview: false, hiddenHandles: [] };
  }

  const projected: ContinuityView = {
    ...view,
    anchors: view.anchors.map(anchor => hiddenHandles.has(anchor.handle)
      ? {
          ...anchor,
          time: '本轮时间窗之后（具体年份对本轮现场不可知）',
          claim: '在本轮时间窗之后，存在一份指向同一事实面、但年份不同的较晚低权记录；其具体过程与结局对本轮现场不可知。',
          origin: '较晚低权记录（本轮仅保留时间差异）',
          finalProseExcerpt: undefined,
          statusExcerpt: undefined,
        }
      : anchor),
  };
  return {
    view: projected,
    requiresCutoffReview: true,
    hiddenHandles: [...hiddenHandles],
  };
}

export function requiresRuinEarlierWindowCutoffReview(
  view: ContinuityView | undefined,
  scope: RuinHistoricalAmbiguityScope,
): boolean {
  return projectRuinContinuityForScope(view, scope).requiresCutoffReview;
}

/**
 * P4-C2 只把已由 P4-C 识别的关系翻译成墟境叙事责任。
 * 它不抽取冲突成因、不新增模型字段，也不决定哪个视角是真相。
 */
export function renderRuinHistoricalAmbiguityGuidance(
  view: ContinuityView | undefined,
  scope: RuinHistoricalAmbiguityScope,
  hiddenHandles: readonly string[] = [],
): string[] {
  if (!view?.relationGroups.length) return [];
  const byHandle = new Map(view.anchors.map(anchor => [anchor.handle, anchor]));
  const responsibilities = view.relationGroups.flatMap(group => {
    const left = byHandle.get(group.handles[0]);
    const right = byHandle.get(group.handles[1]);
    if (!left || !right) return [];
    if (group.dimension !== 'time') {
      return [
        `[${continuityDifferenceLabel(group.dimension)}差异·${group.handles.join('/')}] `
          + '只有当它与玩家任务及本候选强相关时，才让差异通过人物行动、制度过程、物质痕迹或现场后果自然形成；不要套用时间冲突的前后年模板，也不要把相邻但不同的事件强行合并。',
      ];
    }
    return [renderTimeAmbiguityResponsibility(left, right, scope, new Set(hiddenHandles))];
  });
  if (responsibilities.length === 0) return [];
  return [
    '<HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>',
    '下列关系仍是未裁定的低权史料差异。它们若与本轮墟境强相关，必须成为世界内部可感知、可调查、可干涉的历史疑云，而不是后台说明或两段互斥事实的并排抄写。',
    '先阅读本轮全部已有材料：若正文、玩家说明或合格来源已经明确差异如何形成，忠实沿用其核心因果，只补现场行动与痕迹；不得另造更戏剧化的竞争解释，也不得把“据说、怀疑、官方声称”升级为客观事实。',
    '若没有现成解释，结合当时当地的人物选择、制度、媒介、物件、环境与世界机制，自由编织影响半径最小的局部成因假说。冻结的是叙事责任，不是解释类型；禁止套固定原因表、万能阴谋或重复模板。',
    '相关性很强时，提纲中至少一份可进入候选应真正承载疑云；扩写时则只落实所选提纲已经承载、或与其不可分割的疑云。冲突只是背景时自然融入主线，不得抢走玩家任务。',
    '至少留下一种人物能够在场感知或追查的世界内痕迹。局部解释可以供本次探索采用，但不因此选出全局赢家、写回 Canon 或证明任何一篇传记是真正正史。',
    ...responsibilities,
    '输出中不得出现本区块名称、C 句柄、parallelView、sourceConflict、revision、低权锚或其他系统术语；只能让玩家从叙事本身感到两种历史为何会同时存在。',
    '</HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>',
  ];
}

function renderTimeAmbiguityResponsibility(
  left: ContinuityView['anchors'][number],
  right: ContinuityView['anchors'][number],
  scope: RuinHistoricalAmbiguityScope,
  hiddenHandles: ReadonlySet<string> = new Set(),
): string {
  const leftBand = continuityTimeBand(left.time, scope.era);
  const rightBand = continuityTimeBand(right.time, scope.era);
  if (!leftBand || !rightBand || leftBand.start === rightBand.start) {
    return `[时间差异·${left.handle}/${right.handle}] `
      + '根据候选实际跨度与两种说法的先后位置决定责任：较早现场留出能通向后续分歧的未完成条件，较晚现场保留早期说法的可查痕迹，跨越两端时让分歧的形成与保存过程进入行动；不得直接替史料选边。';
  }
  const [earlier, later] = leftBand.start < rightBand.start
    ? [[left, leftBand], [right, rightBand]] as const
    : [[right, rightBand], [left, leftBand]] as const;
  if (scope.automaticTimeRange) {
    return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
      + '自动范围只是可行包络；按每份候选最终选定的实际 span 判断：只触及较早端就留下尚未完成的因果种子，只触及较晚端就保留较早说法的残迹，跨越两端则让分歧的形成、传播或保存过程进入剧情。';
  }
  const requested = requestedTimeBand(scope);
  if (!requested) {
    return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
      + '本轮没有可机械比较的完整年份；结合候选实际 span 承担前置引子、后置残迹或分裂过程，不得把两个年份都当成无须解释的既成事实。';
  }
  const touchesEarlier = bandsOverlap(requested, earlier[1]);
  const touchesLater = bandsOverlap(requested, later[1]);
  if (touchesEarlier && touchesLater) {
    return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
      + '本轮时间窗同时触及两个版本：让玩家在行动与后果中经历差异从何处分岔、如何被保存或传播，并留下两套说法可以持续存在的世界内证据；不可只把两段年份并排复述。';
  }
  if (touchesEarlier) {
    const laterTimeLabel = hiddenHandles.has(later[0].handle)
      ? '本轮时间窗之后的具体时点'
      : (later[0].time || '较晚时点');
    return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
      + `本轮只触及较早视角（${earlier[0].time || '较早时点'}）：留下未完成状态、人物选择、手续或物质痕迹等因果种子，使后续差异有可能生长；不得提前宣告较晚视角（${laterTimeLabel}）已经发生或必然成立。只写候选时间窗内尚未收束的现场：未完手续、未交付物件、待定选择、可追查痕迹或当时人物并不能确定的可能性。在本窗内停笔，不得解释、命名或总结后世为何形成两种史料说法。叙事认知必须截止于本候选 span 的终点：终点之后的事情只能写成当时人物的计划、条件、担忧、尚未履行的约定或不确定可能，不能用全知回顾确认后来、次年或最终确实发生了什么；演变短句、史稿正文、转向说明和结尾总结都不得补叙未来结果。`;
  }
  if (touchesLater) {
    return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
      + `本轮只触及较晚视角（${later[0].time || '较晚时点'}）：让较早说法以人物记忆、旧手续、物品痕迹或其他合乎现场的证据继续产生影响；不得让较早视角（${earlier[0].time || '较早时点'}）无声消失，也不得未经解释把较晚现场写成毫无争议的首次发生。`;
  }
  return `[时间差异·${earlier[0].handle}/${later[0].handle}] `
    + '本轮时间窗不触及任一版本：除非这组差异是玩家任务不可缺少的前史、后果或调查对象，否则不要把疑云写进候选与史稿。';
}

interface NumericTimeBand {
  start: number;
  end: number;
}

function continuityTimeBand(value: string, fallbackEra: string): NumericTimeBand | null {
  const years: number[] = [];
  let activeEra = recognizedEra(fallbackEra);
  const pattern = /(?:(创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)\s*)?(前)?\s*([0-9零〇一二两三四五六七八九十百千]+)\s*年/gu;
  for (const match of value.matchAll(pattern)) {
    activeEra = match[1] ?? activeEra;
    const year = parseHistoricalYear(match[3] ?? '');
    const absolute = historicalAbsoluteYear(activeEra, year === null ? null : (match[2] ? -year : year));
    if (absolute !== null) years.push(absolute);
  }
  if (years.length === 0) return null;
  return { start: Math.min(...years), end: Math.max(...years) };
}

function requestedTimeBand(scope: RuinHistoricalAmbiguityScope): NumericTimeBand | null {
  if (!scope.start || !scope.end) return null;
  const start = historicalAbsoluteYear(recognizedEra(scope.era), scope.start.year);
  const end = historicalAbsoluteYear(recognizedEra(scope.era), scope.end.year);
  if (start === null || end === null) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function bandsOverlap(left: NumericTimeBand, right: NumericTimeBand): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function recognizedEra(value: string): string | null {
  return value.match(/创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元/u)?.[0] ?? null;
}

function historicalAbsoluteYear(era: string | null, year: number | null): number | null {
  if (!era || year === null) return null;
  const index = ['创世纪元', '神明纪元', '混乱纪元', '英雄纪元', '复兴纪元'].indexOf(era);
  return index >= 0 ? index * 100_000 + year : null;
}

function parseHistoricalYear(value: string): number | null {
  if (/^[0-9]+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (!/[十百千]/u.test(value)) {
    let result = 0;
    for (const character of value) {
      const digit = digits[character];
      if (digit === undefined) return null;
      result = result * 10 + digit;
    }
    return result;
  }
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (digits[character] !== undefined) {
      current = digits[character]!;
      continue;
    }
    const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1_000 : 0;
    if (!unit) return null;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}

function continuityDifferenceLabel(
  dimension: ContinuityView['relationGroups'][number]['dimension'],
): string {
  return {
    time: '时间', location: '地点', participant: '参与者', relationship: '关系',
    ownership: '所有权', objectState: '物品状态', outcome: '结果',
  }[dimension];
}

export function buildRuinTaskSpine(input: RuinPromptInput) {
  const primaryRequest = input.generationInput.supplementaryDirection.trim()
    || '探索所选时代与地点中的可进入历史事件';
  const currentSceneReference = resolveCurrentSceneReference(
    `${input.generationInput.location}\n${primaryRequest}`,
    input.context.currentWorld.location,
  );
  return {
    schema: 'eyon.ruin.task-spine.v1',
    sourceText: primaryRequest,
    hardScope: {
      era: input.generationInput.era,
      start: input.generationInput.start,
      end: input.generationInput.end,
      location: input.generationInput.location,
    },
    selectedCharacters: input.generationInput.selectedCharacters.map(character => character.name),
    subjectBoundary: {
      focusText: primaryRequest,
      stageLocation: input.generationInput.location,
      currentIdentityLocation: currentSceneReference?.location ?? null,
      evidenceBoundary: currentSceneReference
        ? 'current-scene facts prove current identity only; dated evidence is required to lock earlier history'
        : 'historically attested when supplied, otherwise a player-defined open subject',
    },
    reasoningOrder: [
      '先理解 sourceText 要探索的事件、主体、关系、群体规模与叙事焦点',
      '再从已知实体中权衡谁在该时代与地点有资格、有动机且能实际贡献',
      '史料没有合适具名者时，允许创造受限于当地与当时的历史人物或组织',
      '最后才用骰材决定表现角度、压力和触发方式，不得让骰材改写任务主体',
    ],
    priority: ['hardScope', 'sourceText', 'qualifiedCanon', 'creativeMaterials'],
  };
}

export interface RuinEvidenceLedger {
  schema: 'eyon.ruin.evidence.v1';
  requestedScope: {
    era: string;
    start: RuinGenerationInput['start'];
    end: RuinGenerationInput['end'];
    location: string;
    locationHierarchy: string[];
    supplementaryDirection: string;
  };
  canonicalCharacters: Array<{
    mvuId: string;
    referenceId: string | null;
    name: string;
    source: 'mvu' | 'genealogy';
    race: string;
    identities: string[];
    professions: string[];
    relations: string[];
    lifespan: string;
    contextSummary: string;
  }>;
  authorityPolicy: Array<{
    sourceType: ContextSource['sourceType'];
    governs: string;
  }>;
  evidenceSources: Array<{
    passageId: string;
    snapshotId: string;
    sourceId: string;
    sourceType: ContextSource['sourceType'];
    title: string;
    sectionPath: string[];
    contentHash: string;
    authority: number;
    directMatches: string[];
    namedAnchors: string[];
    dateMentions: string[];
    qualification: {
      zone: 'locked' | 'guided' | 'open';
      temporalFit: string;
      geographicFit: string;
      eventPhase: string;
      revisionFit: string;
      allowedUses: string[];
      forbiddenUses: string[];
    } | null;
  }>;
  inferencePolicy: {
    immutableFacts: string[];
    allowed: string[];
    forbidden: string[];
  };
}

export function buildRuinOutlineBatchApiPrompt(input: RuinPromptInput): string {
  const fixedHeader = {
    schema: 'eyon.ruin.outlines.v1',
    requestId: input.requestId,
  };
  const prompt = [
    '<RUIN_OUTLINE_BATCH_TASK>',
    'Create all requested ruin candidates in one compact batch. This stage is an outline, not the final historical prose.',
    'A great ruin manuscript: era-credible (location, institutions, peoples fit the era), characters independent and vivid (every named person carries their own identity, motive and price), events with causality and reversal (not a mechanical war report), ending with resonance. History is history, the present is the present: never arrange a historical predecessor for anything contemporary.',
    'Treat explicit LOCKED facts in EVIDENCE_LEDGER_READ_ONLY as immutable canon. QUALIFIED_EVIDENCE_VIEW decides whether a related passage may serve as stage, actor, cause, background, aftermath or reference; only then invent missing connective history.',
    'Build one shared historical stage first, then create different causal branches from it. Reuse only a small canonical anchor cast; each branch must still have its own indispensable local actors and must not merely rename the same roles.',
    'The candidates must be genuinely different historical events, not the same incident moved to another year or rewritten with cosmetic details. Dates, renamed local actors and changed adjectives never count as branch differentiation.',
    'Fuse each material set into natural in-world history. Never expose dice labels, seed names, writing stages, or phrases such as background/conflict/trigger.',
    'Source and worldbook titles are script labels, not in-world names: never write a book name, character-card name or worldbook version (e.g. a title containing an era name plus a work name, or "v4.2") into the manuscript, and never use such a label as an item, technique or organization name.',
    'Use the requested location, focus references, supplementary direction and relevant sources. A related external place or later relic is not automatically the event stage. Inference may freely fill OPEN local gaps, but may not rewrite an established fact.',
    'The form location is the sole target stage. Current-scene places and places mentioned only by related passages are retrieval references, never alternative stages. A newly invented street, camp, fort or district is allowed only as a local sub-location inside the form location.',
    'PLAYER_TASK_SPINE_READ_ONLY is the task-completion contract. Analyze its sourceText as a whole before selecting actors: identify the requested historical subject, event anchor, relationships, collective scale and narrative focus. Do not reduce it to isolated keywords.',
    'TASK_SUBJECT_BOUNDARY is shared with biography generation. Keep stage, subject and requested direction distinct: the form location is where events happen; sourceText says what history is being explored; dice only changes pressure and texture. Decide in natural language whether the subject is an individual, a collection, an industry, a group, a place or another phenomenon, and what keeps it the same subject through time. Do not output or validate a fixed type enum.',
    'A current MVU object is attested in the present, not automatically throughout the requested past. If a requested period predates its earliest evidence, write the site, lineage, predecessor or conditions that later produce it, unless dated evidence or the player explicitly establishes that the object itself already existed.',
    'Choose people and organizations because their period, place, allegiance, abilities, motives and contribution fit the interpreted task. Known entities are optional unless directly required; invented local historical actors are valid when the evidence has no suitable named actor.',
    'A selected biography is continuity evidence, not an actor quota. Preserve its established states when the requested history touches them, but do not pull every named person into the ruin. A known person may appear only when the whole player request needs them and their identity, profession, period and route to the location can naturally fit; otherwise create a local actor. Travel is allowed when plausibly established, not banned by distance alone.',
    'UI-selected characters are focus references, not mandatory actors. They raise retrieval priority and may guide relationships, identity or historical leads. Put one in sharedCast, candidate.cast and node participants only when this candidate truly makes that person act, speak, decide, suffer or otherwise participate. Merely being selected, related to an actor, or useful as background is never enough. A name in candidate.cast is a claim of actual participation, not a reference list.',
    'Retrieval may return current-chat contemporary people (MVU/relationship-list personas such as judges, nobles or companions, and DLC character cards) — they are living people of the present era. A historical candidate must never adopt a contemporary person under their real name — if their role fits the task, invent an original person of that era, or use a same-named historical person only when the worldbook explicitly records one. Do not arrange a historical predecessor for a contemporary person, their family name, or their title (e.g. no "ancestor of this judge" or "proto-version of that title"): history stands on its own. Passages tagged as contemporary references are listed only for relationships, current state or naming conventions; they are never actor candidates for a historical era task.',
    'Every newly introduced historical person needs an original, memorable name with era, region or racial flavor — no generic placeholders like "craftsman A / lord B", no reusing the same good name across people or branches, and no borrowing names, family names or titles of contemporary (MVU) people. Prefer worldbook-named historical persons when suitable; otherwise invent someone who belongs to that era.',
    'Objects and equipment belong to the time band where they first appear in reference material (e.g. an seal-suppression ring first seen in 476-479 band); they may persist into later periods, but must not be re-introduced as newly acquired in a later candidate unless the sources describe a replacement or a change of ownership. Respect the original prose context of an object (who holds it, what it does, where it stays): do not transfer, gift or repurpose an object against that context unless the source describes the transfer; if you do create a transfer, make the story self-consistent with both the old and the new holder.',
    'Stable landmarks and key destinations of established events keep the exact name from the reference narrative (for example the dungeon a person is sent into, the pass they escape through). Do not merge or rename them into a semantically similar place from another entry — a different real location (like winged-people seal ruins versus a post-war prison-dungeon) must not stand in for the established one, and one story must not use two names for the same destination.',
    'CAST_MANIFEST_READ_ONLY is the event-role contract. Every temporally eligible required and group-required canonical actor must remain in sharedCast, every candidate.cast, and at least one node participant list. A person proven unborn or dead by CHARACTER_TIME_ANCHORS is the only override: keep that canonical identity as an absent subject, but do not put the person in sharedCast, candidate.cast or node participants. Preserve every eligible actor\'s canonical name and identity; never substitute an invented actor for it.',
    'Historical blanks may be filled generously. A durable local family custom, obligation or institution is allowed when it grows from the event causes and contradicts no supplied fact. Direct evidence is required only before turning that local invention into an unrelated continent-wide law, divine treaty or civilizational rewrite.',
    'Keep the answer short. Do not write a 500-character history yet.',
    '</RUIN_OUTLINE_BATCH_TASK>',
    '<PROTAGONIST_ANCHOR>',
    `当前玩家扮演的主角是「${input.context.scope.characterKey}」，是活着的当代人。`,
    '主角可以出现在墟境历史中——但工作台勾选只表示重点参考；只有玩家在补充方向明确要求其进入、或候选因果确实需要其作为穿越者行动时，才以当代人的身份合理出场。',
    '但墟境历史期中的历史人物（包括与主角同名的）是几百年前的人；主角只能以「穿越者 / 参与人物」的身份出场，绝不能把当前主角错位成历史期里本来就存在的历史人物。',
    '</PROTAGONIST_ANCHOR>',
    ...PERIOD_ANCHORING_BLOCK,
    ...renderTaskSubjectBoundary({
      taskType: 'ruin',
      directive: input.directive,
      focusText: input.generationInput.supplementaryDirection,
      explicitLocation: input.generationInput.location,
      currentLocation: input.context.currentWorld.location,
    }),
    ...renderCurrentSceneSemanticSnapshot(input.context.currentSceneSnapshot),
    '<PLAYER_TASK_SPINE_READ_ONLY>',
    JSON.stringify(buildRuinTaskSpine(input)),
    '</PLAYER_TASK_SPINE_READ_ONLY>',
    buildReferenceDataSection(input),
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>',
    'Return exactly one JSON object. No Markdown, analysis, comments, or additional JSON objects.',
    `Copy these fixed fields exactly: ${JSON.stringify(fixedHeader)}`,
    'The only additional top-level fields are taskInterpretation, sharedCast and candidates.',
    'taskInterpretation is a written-out reasoning scaffold, not a graded exam: write your understanding of the player request before selecting anything. Understand PLAYER_TASK_SPINE_READ_ONLY.sourceText as one complete request inside your reasoning. It must contain: sourceText copied exactly from PLAYER_TASK_SPINE_READ_ONLY; primarySubject; eventAnchor; castDemand; mustServe; materialRole. The script only checks sourceText (anti-substitution), materialRole === support-only (dice may not become the subject) and basic field presence — it does NOT grade your wording.',
    'castDemand contains mode (single/ensemble/open), minimumDistinctActors (1-5), requiredKinds (short natural-language actor categories) and selectionRule. Interpret the player wording rather than matching a fixed keyword list. Ensemble means at least three consequential contributors.',
    'mustServe is a 1-5 item array of concrete requirements derived from sourceText. materialRole must be exactly support-only.',
    'Each candidate may contain only: candidateKey, branchSignature, taskFit, canonInterpretation, title, premise, summary, historicalResult, span, shift, cast, nodes.',
    'taskFit is a soft self-record of how this candidate serves the task: subjectServed, eventAnchorServed, servedRequirements and contributions (actor, action, reason). The script does NOT grade it field-by-field: keep it honest and self-consistent, but wording may differ from taskInterpretation. Do not make contributions exist only on paper — the cast and the prose must genuinely perform them. Dice/material may shape how these contributions unfold but cannot become the subject.',
    'sharedCast normally contains 1 to 2 actors who genuinely participate across every candidate as {name, kind, identity, role}; however every temporally eligible required/group-required CAST_MANIFEST actor must be included even when that exceeds the normal count. Hard absence from CHARACTER_TIME_ANCHORS takes priority over required presence for this ruin task only. Selected focus references are not preferred by default: include them only when every branch actually needs their participation. Otherwise prefer source-backed named people, families or organizations that truly act. Copy established names and identities exactly, including punctuation and surname order.',
    'Every candidate.cast must include sharedCast unchanged and in the same order. A candidate normally adds 1 to 2 event-local actors, but may add enough local actors to satisfy an ensemble minimum up to five. Prefer source-backed actors when the sources support them. Local actors should differ across branches when their causal roles differ.',
    'Before using any established person, compare the candidate date with the person lifespan, age or dated deeds in the sources. Never place a person before birth or after death. Match authority, occupation, independence and action to the person\'s age in that exact year: do not back-project a later adult office into childhood or adolescence unless the evidence explicitly establishes exceptional physiology or a special social custom. If age is not explicit, infer one plausible age once and keep that identity and chronology consistent across all candidates.',
    'Before using any known entity, audit its CAST_MANIFEST capsule after drafting: kind, identities, affiliations and temporal scopes remain binding. Never relabel an organization as another polity\'s institution. If a known entity is unsuitable, omit it and invent a local actor instead of rewriting its allegiance or era.',
    'Do not invent a substitute for a relevant source-backed person, family or organization. A new local actor is allowed only when no supplied source names anyone who can perform that necessary role; keep that actor local to the event and do not grant unsupported world-scale status.',
    'The player may give a short place name. Keep every node inside that requested location hierarchy, but write each node.location as the rolecard MVU full path with 4 to 8 levels from large to small, joined by ASCII hyphens: 大陆名+方位-势力/区域-子级势力-聚落/地标-区位-详细位置. Reconstruct established parent levels from qualified evidence; a more specific room, street or site is allowed. Never jump to an unrelated city, province or realm, never use unknown/placeholder levels, and never repeat one short name merely to reach the count.',
    'When the complete player request calls for a collective or group portrait, make several suitable people, units or organizations perform consequential actions across different functions. Do not replace the requested collective with one mysterious savior or one scenic landmark.',
    'candidates must follow generationRequest.materials one-to-one and in the same order.',
    'Dice/material may shape how the requested history unfolds but cannot become its subject. The player request remains the center of actor selection, event design and historical result.',
    'branchSignature is a machine-only event identity object with exactly actor, action, object, mechanism, outcome (all concise strings). Describe what is actually done, to what, by what mechanism, and what concrete result follows; omit dates and decorative wording. It will not be shown to players.',
    'Across candidates, branchSignature must differ in the substantive action/mechanism/outcome. The same event with a different date, title, place-name detail or actor alias will be rejected and the whole outline batch regenerated.',
    'canonInterpretation is the machine-readable reasoning receipt. It contains mode, hypothesis, evidenceFactRefs, evidencePassageRefs, eventUsages and assumptions. Copy only handles literally listed in TASK_CITATION_CONTRACT_V2. An empty allowed list requires an empty output list.',
    'eventUsages items contain eventRef, usage and explanation. eventRef is SELF for this candidate\'s genuinely open local event, or one supplied F/E handle for a canonical fact/event. A canonical event may use occurs in only one independent-event candidate. Reusing it across candidates is allowed only when every such candidate declares alternative-interpretation and presents genuinely different, evidence-compatible hypotheses—not cosmetic redating.',
    'assumptions contain claim, evidenceFactRefs, evidencePassageRefs, confidence and alternatives. Facts/source order is never chronology: respect eventRelations and dates, and use cross-entry location/relationship/current-state prerequisites to choose a coherent explanation. When chronology remains ambiguous, keep at least one plausible alternative instead of silently promoting the chosen hypothesis to immutable canon. reported/contested facts remain claims, not sole objective truth.',
    input.automaticTimeRange
      ? 'span contains start, end and label. Dates contain year, month and day. generationRequest.start/end is an automatically computed feasible envelope, not a demand to start at a person’s birth. Choose each candidate’s exact, distinct span inside that envelope by reasoning from the event prerequisites, dated deeds and life stage; keep the chosen chronology consistent across the whole candidate.'
      : 'span contains start, end and label. Dates contain year, month and day. generationRequest contains the player’s binding concrete range; copy explicit calendar dates inside it.',
    'shift contains from, to and explanation. from is the state at the start of this candidate, to is the state at its end. They must differ (stable/transition/turbulent). Either endpoint may equal the dominant periodType; it is NOT a fourth forbidden value. Example: a stable-dominant candidate may turn stable → transition. Keep explanation within 20-45 Chinese characters.',
    'cast is the actual cast, not a reference list. It contains only shared actors and indispensable local actors who visibly participate in this candidate as {name, kind, identity, role}. Every listed member must appear in at least one node and genuinely act in the final prose. kind must be person, family, organization, faction or community; keep the total at five or fewer.',
    'nodes contains exactly 4 chronological items, one each in this order: origin, process, anomaly, result. The anomaly machine key is the player-visible 高潮 stage and remains for old-record compatibility. Each item contains only id, kind, time, location, title, summary, visibleTrace and participants. participants is a short array using names copied from this candidate.cast.',
    'All four stages are playable entry points: origin explores or changes the cause, process affects accumulation, anomaly is the causal climax, and result explores evidence, rescue and downstream consequences. Keep motives, branches, texture and secondary actors for the later expansion stage.',
    'time contains year, month, day, hour, minute and label. Keep every node inside the player time range when one was supplied. Never place any node or span at or after the current story time shown in currentWorld.time — time travel reaches the past only; the latest allowed instant is the current story time, and everything must stay before it.',
    'Node dates must be explicit, distinct and chronologically ordered inside generationRequest.start/end. Never use relative chronology, null calendar parts, “未详”, or 0 as a date placeholder. Include hour and minute for every node.',
    'Keep premise, summary and historicalResult within 20-50 Chinese characters each; each node summary within 20-45; each visibleTrace within 10-30. The entire response must remain compact.',
    '<PRE_SUBMISSION_CHECK>',
    'Before responding, silently read any selected biography as a chronology rather than an actor quota. For each candidate date, distinguish what already exists from what is only established in a later biography stage. Do not move a later named person, unique object, ritual, institution, construction or final closure into an earlier period, and do not permanently end something that the later biography still records as active. An earlier local precursor remains allowed when historically plausible, but give it its own local identity instead of borrowing the later proper name or claiming the later event has already happened. For every known person retained in cast, calculate that event-year age from CHARACTER_TIME_ANCHORS and make the role and agency fit that life stage.',
    'If a draft conflicts with an earlier or later biography state, correct the outline itself before sending. Keep uncertain gaps open to plausible invention; do not add fields, explanations or a printed checklist.',
    '</PRE_SUBMISSION_CHECK>',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
  ].join('\n\n');
  return maskTaskCitationIdentifiers(
    prompt,
    input.citationRegistry ?? taskCitationRegistry(input.context.evidenceBundle),
  );
}

export function buildRuinOutlineRepairPrompt(
  originalPrompt: string,
  validationError: string,
): string {
  return [
    originalPrompt,
    '<RUIN_OUTLINE_REPAIR_TASK>',
    `The previous outline batch was rejected: ${validationError.slice(0, 1200)}`,
    'Structural rules that commonly break a batch: keep every candidate id and candidateKey unique; keep node ids unique inside each candidate (usually n1-n4, one per kind origin/process/anomaly/result); keep node times monotonic and inside the candidate span; keep every node.location as a 4–8 level ASCII-hyphen MVU path; keep cast participants copied from the candidate.cast. Fix every violation by rewriting, not by patching around it.',
    'Repair citation handles as part of regeneration: evidenceFactRefs accepts only listed F handles; evidencePassageRefs accepts only listed P handles; eventRef accepts SELF or one listed F/E handle. Empty allowed lists require empty output lists. Never invent, extend, combine or transform a handle.',
    'Regenerate the whole outline batch from scratch against the contract above. Do not repeat, explain, quote, or patch the rejected response.',
    'Return exactly one JSON object satisfying the mandatory output contract above.',
    '</RUIN_OUTLINE_REPAIR_TASK>',
  ].join('\n\n');
}

export function buildRuinExpansionApiPrompt(
  input: RuinPromptInput,
  material: RuinMaterial,
  outline: RuinCandidate,
): string {
  const fixedHeader = {
    schema: 'eyon.ruin.expansion.v1',
    requestId: input.requestId,
    candidateKey: material.candidateKey,
  };
  const compactOutline = {
    id: outline.id,
    candidateKey: outline.candidateKey,
    title: outline.title,
    periodType: outline.periodType,
    span: outline.span,
    premise: outline.premise,
    summary: outline.summary,
    nodes: outline.nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      time: node.time,
      location: node.location,
      title: node.title,
      summary: node.summary,
    })),
    cast: outline.cast.map(member => ({
      name: member.name,
      kind: member.kind,
      identity: member.identity,
      role: member.role,
    })),
    canonInterpretation: outline.canonInterpretation,
  };
  const prompt = [
    '<RUIN_SELECTED_CANDIDATE_EXPANSION>',
    'Expand only the selected outline into a vivid, causally coherent historical dossier for immediate entry.',
    'EVIDENCE_LEDGER_READ_ONLY remains binding during expansion. Added texture may explain a gap, but may never alter a canonical name, identity, lifespan, allegiance, dated deed or location hierarchy.',
    'Preserve every node id, node kind, structured time and full 4–8 level MVU location exactly. Add detail; do not move, replace or reorder the four playable stages.',
    'The selected outline cast is a read-only canonical ledger. Keep every name, kind, identity and role exactly; do not add, remove, rename, merge or replace actors. Only desire, constraint and inference may be enriched. Preserve the lifespan and age logic already implied by the outline.',
    'Selected biographies remain continuity evidence rather than an actor quota. When this event overlaps a biography stage, keep its already-established survival, profession, ownership and later continuation intact. Do not declare a person, craft line, institution or object totally ended in an earlier event when the supplied later biography still records it, unless the prose naturally explains a remnant, revival, succession or narrowed meaning.',
    'The player task remains the narrative center during expansion. Dice/material supplies pressure and texture only; every major paragraph must advance the selected outline actors, event anchor or requested historical subject.',
    'Keep the whole subject reading from TASK_SUBJECT_BOUNDARY: a collection must not collapse into one decorative object, an industry must not become an object inventory, and an individual organism must not appear before its own life begins. A predecessor, habitat, lineage or site history may be written, but must not masquerade as the subject itself.',
    'Write one continuous history. Smoothly transform the semantic seeds into concrete people, institutions, resources, pressures, decisions and consequences.',
    'Historical blanks may be filled generously, including durable family customs or institutions when they grow naturally from the local causes and do not contradict supplied evidence. Do not turn a local connective invention into an unrelated continent-wide law, divine treaty or civilizational rewrite.',
    'Never mention dice labels, seed stages, backstage terms or how materials were combined.',
    ruinProseLengthInstruction(),
    'Keep every other string compact: usually 10-45 Chinese characters. Each list should normally contain one item, and never more than two unless the selected outline makes a second item indispensable.',
    '</RUIN_SELECTED_CANDIDATE_EXPANSION>',
    ...PERIOD_ANCHORING_BLOCK,
    ...renderTaskSubjectBoundary({
      taskType: 'ruin',
      directive: input.directive,
      focusText: input.generationInput.supplementaryDirection,
      explicitLocation: input.generationInput.location,
      currentLocation: input.context.currentWorld.location,
    }),
    ...renderCurrentSceneSemanticSnapshot(input.context.currentSceneSnapshot),
    '<PLAYER_TASK_SPINE_READ_ONLY>',
    JSON.stringify(buildRuinTaskSpine(input)),
    '</PLAYER_TASK_SPINE_READ_ONLY>',
    '<RUIN_RULES>',
    input.rules.generationContract.trim().slice(0, 8_000),
    '</RUIN_RULES>',
    buildReferenceDataSection(input, material, {
      era: input.generationInput.era,
      start: outline.span.start,
      end: outline.span.end,
      automaticTimeRange: false,
    }),
    '<SELECTED_OUTLINE_READ_ONLY>',
    JSON.stringify(compactOutline),
    '</SELECTED_OUTLINE_READ_ONLY>',
    '<TEMPORAL_BEAT_LEDGER_READ_ONLY>',
    JSON.stringify({
      era: input.generationInput.era,
      calendarMode: KNOWN_EYON_ERAS.includes(
        input.generationInput.era as typeof KNOWN_EYON_ERAS[number],
      ) ? 'known-four-season-calendar' : 'custom-calendar-no-season-assumptions',
      beats: outline.nodes.map(node => ({
        kind: node.kind,
        time: node.time,
        title: node.title,
      })),
    }),
    '</TEMPORAL_BEAT_LEDGER_READ_ONLY>',
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>',
    'Return exactly one JSON object. No Markdown, analysis, comments, examples, or additional JSON objects.',
    `Copy these fixed fields exactly: ${JSON.stringify(fixedHeader)}`,
    'The only additional top-level field is candidate.',
    'candidate contains only the creative fields: title, premise, summary, historyProse, fusion, shift, nodes, cast, historicalTexture, inferenceNotes.',
    'fusion contains normalOrder, latentFault, pressuredActors, bridge, triggerImpact, forcedDecision, irreversibleTurn, historicalResult.',
    'bridge contains type, name and explanation. shift only needs explanation.',
    'Each node repeats its existing id and adds title, summary, cause, causalMechanism, participants, interests, materialConditions, opposition, visibleTrace, intervention, possibleBranches and inference.',
    'Each node has one interests item containing actor, wants and fears, a non-empty intervention suited to that stage, and one possibleBranches item containing condition and consequence. Every stage is enterable: origin may alter causes, process may alter accumulation, anomaly is the climax, and result may alter aftermath without pretending the established earlier event never happened.',
    'cast items contain name, kind, identity, role, desire, constraint and inference.',
    'historicalTexture contains dailyLife, institutions, materialCulture and socialDivisions; each is a one-item short string array.',
    'Do not output sourceRefs, qualityChecks, selectedCharacterUsage, biographyUsage, IDs other than existing node IDs, dates, locations, schema fields, or any fixed field the script can supply.',
    '<PRE_SUBMISSION_CHECK>',
    'Before responding, silently verify: one JSON object only; the fixed header is copied verbatim; candidate is the only added top-level key; cast names and kinds are unchanged; all four node ids, kinds, times, locations and order match the outline; every inference is boolean; every interests item has non-empty actor, wants and fears.',
    'Then perform one natural-language consistency read: title, premise, summary, historicalResult, cast and historyProse must describe the same event; the same named person keeps one identity and role (for example, not chief in the outline but apprentice in prose); every known actor\'s authority, occupation, independence and manner of action must fit that person\'s age during this event, without back-projecting a later adult career into childhood or adolescence unless the supplied evidence explicitly establishes an exceptional physiology or social custom; any relevant earlier/later state in the selected biography remains possible; the complete player subject keeps the same scope and continuity carrier. Correct contradictions inside the prose before sending. This is a reasoning check, not an instruction to print more fields.',
    'History prose must open at the origin beat\'s exact date, then traverse process, anomaly/climax and result in ledger order. When months or seasons change, write a natural transition before using the later weather or season. Never describe an April origin as deep autumn merely because later nodes occur in October.',
    'For a custom calendar, use its exact written dates and neutral environmental description unless the supplied worldbook explicitly maps its months to seasons. Never import Earth-like spring/summer/autumn/winter assumptions into an unknown calendar.',
    'If any check fails, correct it before sending. Never print this checklist or its result.',
    '</PRE_SUBMISSION_CHECK>',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
  ].join('\n\n');
  return maskTaskCitationIdentifiers(
    prompt,
    input.citationRegistry ?? taskCitationRegistry(input.context.evidenceBundle),
  );
}

export function buildRuinExpansionRepairPrompt(
  originalPrompt: string,
  validationError: string,
): string {
  return [
    '<RUIN_EXPANSION_LOCAL_REPAIR>',
    'The previous answer reached the client but failed local parsing or validation.',
    'Regenerate the same selected candidate once. Do not change its requestId, candidateKey, cast, node ids, dates, locations or order.',
    `Local error summary: ${validationError.slice(0, 1_200)}`,
    'Return only the single JSON object required below. Do not explain the correction.',
    '</RUIN_EXPANSION_LOCAL_REPAIR>',
    originalPrompt,
  ].join('\n\n');
}

/**
 * 已通过结构校验的史稿，只在脚本发现明确人物岁数与已知时间窗冲突时做一次窄修订。
 * 这是可选质量复核，不改变大纲、演员、节点或引用契约。
 */
export function buildRuinKnownPersonReviewPrompt(
  originalPrompt: string,
  conflictNames: readonly string[],
): string {
  return [
    '<RUIN_KNOWN_PERSON_LOCAL_REVIEW>',
    'The first answer already passed structural validation. Perform one narrow natural-language correction only.',
    `Known people whose explicit written age conflicts with their supplied time window: ${[...new Set(conflictNames)].join('、')}`,
    'Keep the selected outline, cast, identities, dates, locations, nodes, causal direction and player subject unchanged.',
    'Correct the conflicting explicit age in historyProse, or remove the unnecessary precise age. Do not add new fields, new actors or new history.',
    'Return only the same single JSON object required below. Do not explain the correction.',
    '</RUIN_KNOWN_PERSON_LOCAL_REVIEW>',
    originalPrompt,
  ].join('\n\n');
}

/**
 * P4-C2 较早视角的整段语义截止复核。它不重新投递世界书、传记正文或
 * 较晚 Continuity 锚，只让模型审阅已经通过结构校验的候选本身。
 * 因而这是对叙事认知边界的窄修订，不是第二次自由生成。
 */
export function buildRuinEarlierWindowCutoffReviewPrompt(input: {
  requestId: string;
  candidateKey: string;
  era: string;
  outline: RuinCandidate;
  candidate: RuinCandidate;
}): string {
  const fixedHeader = {
    schema: 'eyon.ruin.expansion.v1',
    requestId: input.requestId,
    candidateKey: input.candidateKey,
  };
  const cutoff = formatRuinCutoff(input.era, input.outline.span.end);
  return [
    '<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>',
    'The first answer already passed structural validation. Perform one whole-candidate semantic time-cutoff review, not a new historical invention.',
    `The selected candidate ends at ${cutoff}. The narrative viewpoint may know only facts, actions and traces available by that cutoff.`,
    'Read every narrative string as one connected account: title, premise, summary, fusion, shift explanation, every node, cast motives, historical texture, inference notes and historyProse.',
    'If any sentence confirms something after the cutoff as already completed, later proven, eventually finalized, officially archived, publicly recognized or historically remembered, rewrite it into an in-period plan, condition, fear, pending procedure, unresolved clue or uncertain possibility.',
    'Do not merely replace a few trigger words. Judge the meaning of the complete sentence and its causal role. A sentence still fails if it indirectly guarantees the later record while avoiding words such as later, next year or finally.',
    'Preserve all facts and consequences that occur on or before the cutoff. Preserve the selected outline cast, identities, dates, locations, node order, player subject and causal direction. Do not choose which conflicting history is true, add a new explanation, or introduce new actors and events.',
    'Return the corrected candidate once. Do not explain the review and do not add review fields.',
    '</RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>',
    '<SELECTED_OUTLINE_READ_ONLY>',
    JSON.stringify(compactRuinOutlineForReview(input.outline)),
    '</SELECTED_OUTLINE_READ_ONLY>',
    '<VALIDATED_DRAFT_TO_REVIEW>',
    JSON.stringify({ candidate: creativeRuinCandidateForReview(input.candidate) }),
    '</VALIDATED_DRAFT_TO_REVIEW>',
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>',
    'Return exactly one JSON object. No Markdown, analysis, comments or additional JSON objects.',
    `Copy these fixed fields exactly: ${JSON.stringify(fixedHeader)}`,
    'The only additional top-level field is candidate.',
    'candidate contains only the creative fields already present in VALIDATED_DRAFT_TO_REVIEW: title, premise, summary, historyProse, fusion, shift, nodes, cast, historicalTexture and inferenceNotes.',
    'Keep all node ids and cast names unchanged. Do not output dates, locations, sourceRefs, qualityChecks, selectedCharacterUsage, biographyUsage or schema fields inside candidate.',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
  ].join('\n\n');
}

/**
 * internal.116：较早视角改写后的独立语义裁决。裁判只看截止时间
 * 与候选全文，不接收世界书、传记或较晚锚，也不产生业务事实。
 */
export function buildRuinEarlierWindowCutoffVerdictPrompt(input: {
  requestId: string;
  candidateKey: string;
  era: string;
  outline: RuinCandidate;
  candidate: RuinCandidate;
}): string {
  const cutoff = formatRuinCutoff(input.era, input.outline.span.end);
  return [
    '<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>',
    `Request ${input.requestId}; candidate ${input.candidateKey}. Independently judge whether this candidate obeys the narrative knowledge cutoff at ${cutoff}.`,
    'Read every narrative string together, including title, premise, summary, fusion, shift, nodes, cast motives, historicalTexture, inferenceNotes and historyProse. Judge meaning, not isolated keywords.',
    'Return BLOCK if any wording confirms, guarantees or retrospectively explains an event after the cutoff: a procedure completed later, an object delivered later, a next-year or exact future date, later official filing or recognition, a duration extending past the cutoff, or a claim that the present scene became the known cause of a later historiographic split.',
    'Return PASS only when everything after the cutoff remains merely a contemporaneous plan, condition, fear, unresolved clue, pending procedure or uncertain possibility, and the account stops inside the selected period. When uncertain, return BLOCK.',
    'This is a verdict only. Do not repair, summarize or explain the candidate.',
    '</RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>',
    '<CANDIDATE_TO_JUDGE>',
    JSON.stringify(creativeRuinCandidateForReview(input.candidate)),
    '</CANDIDATE_TO_JUDGE>',
    '<MANDATORY_VERDICT_OUTPUT_CONTRACT>',
    'Return exactly one JSON object and nothing else: {"verdict":"PASS"} or {"verdict":"BLOCK"}.',
    '</MANDATORY_VERDICT_OUTPUT_CONTRACT>',
  ].join('\n\n');
}

function compactRuinOutlineForReview(outline: RuinCandidate) {
  return {
    id: outline.id,
    candidateKey: outline.candidateKey,
    span: outline.span,
    cast: outline.cast.map(member => ({
      name: member.name,
      kind: member.kind,
      identity: member.identity,
      role: member.role,
    })),
    nodes: outline.nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      time: node.time,
      location: node.location,
    })),
  };
}

function creativeRuinCandidateForReview(candidate: RuinCandidate) {
  return {
    title: candidate.title,
    premise: candidate.premise,
    summary: candidate.summary,
    historyProse: candidate.historyProse,
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
  };
}

function formatRuinCutoff(era: string, date: RuinCandidate['span']['end']): string {
  const parts = [date.year === null ? '' : `${date.year}年`];
  if (date.month !== null) parts.push(`${date.month}月`);
  if (date.day !== null) parts.push(`${date.day}日`);
  return `${era}${parts.join('') || '候选终点'}`;
}

/**
 * Builds a deliberately small second-line request for providers that closed a
 * full expansion response twice. The expansion normalizer restores every
 * omitted structural field from SELECTED_OUTLINE_READ_ONLY, so this recovery
 * request only asks the model for the one field that cannot be synthesized
 * locally: the finished historical prose.
 */
export function buildCompactRuinExpansionRecoveryPrompt(
  originalPrompt: string,
): string | null {
  if (!originalPrompt.includes('<RUIN_SELECTED_CANDIDATE_EXPANSION>')) return null;

  const fixedHeader = extractFixedHeader(originalPrompt);
  const evidenceLedger = extractTaggedBlock(
    originalPrompt,
    'EVIDENCE_LEDGER_READ_ONLY',
  );
  const selectedOutline = extractTaggedBlock(
    originalPrompt,
    'SELECTED_OUTLINE_READ_ONLY',
  );
  const continuityView = extractTaggedBlock(
    originalPrompt,
    'GENERATED_CONTINUITY_READ_ONLY',
  );
  const historicalAmbiguity = extractTaggedBlock(
    originalPrompt,
    'HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY',
  );
  if (!fixedHeader || !selectedOutline) return null;

  return [
    '<RUIN_COMPACT_EXPANSION_RECOVERY>',
    'The full expansion transport closed twice. Complete only the indispensable prose for the already selected outline.',
    'Treat the selected outline as immutable: preserve all names, identities, dates, locations, node order and causal direction exactly.',
    'Write one continuous in-world history of 420-520 Chinese characters. Use concrete actions, institutions, resources, pressures, decisions and consequences.',
    'Begin at the exact date of the origin node, make the opening month or season agree with that date, then carry time forward through process, climax and result with visible transitions. Never borrow a later node\'s season for the opening. If the era uses a custom calendar, keep the environment neutral unless the supplied evidence explicitly maps its months to seasons.',
    'Include the outline cast naturally and make the four outline nodes read as one causal sequence. Do not mention prompts, dice, seed labels, stages or recovery.',
    '</RUIN_COMPACT_EXPANSION_RECOVERY>',
    ...(evidenceLedger
      ? [
          '<EVIDENCE_LEDGER_READ_ONLY>',
          evidenceLedger,
          '</EVIDENCE_LEDGER_READ_ONLY>',
        ]
      : []),
    ...(continuityView
      ? [
          '<GENERATED_CONTINUITY_READ_ONLY>',
          continuityView,
          '</GENERATED_CONTINUITY_READ_ONLY>',
        ]
      : []),
    ...(historicalAmbiguity
      ? [
          '<HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>',
          historicalAmbiguity,
          '</HISTORICAL_AMBIGUITY_NARRATIVE_READ_ONLY>',
        ]
      : []),
    '<SELECTED_OUTLINE_READ_ONLY>',
    selectedOutline,
    '</SELECTED_OUTLINE_READ_ONLY>',
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>',
    'Return exactly one JSON object and nothing else.',
    `Copy these fixed fields exactly: ${fixedHeader}`,
    'The only additional top-level field is candidate.',
    'candidate contains exactly one field: historyProse.',
    'Do not output nodes, cast, dates, locations, fusion, shift, source data, Markdown, analysis or comments. The script restores all omitted structure from the selected outline.',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
  ].join('\n\n');
}

function extractFixedHeader(prompt: string): string | null {
  const match = prompt.match(/Copy these fixed fields exactly:\s*(\{[^\r\n]+\})/u);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (
      parsed.schema !== 'eyon.ruin.expansion.v1'
      || typeof parsed.requestId !== 'string'
      || typeof parsed.candidateKey !== 'string'
    ) {
      return null;
    }
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

function extractTaggedBlock(prompt: string, tag: string): string | null {
  const startToken = `<${tag}>`;
  const endToken = `</${tag}>`;
  const start = prompt.indexOf(startToken);
  if (start < 0) return null;
  const contentStart = start + startToken.length;
  const end = prompt.indexOf(endToken, contentStart);
  if (end < 0) return null;
  const content = prompt.slice(contentStart, end).trim();
  return content || null;
}

function buildReferenceDataSection(
  input: RuinPromptInput,
  targetMaterial?: RuinMaterial,
  ambiguityScope: RuinHistoricalAmbiguityScope = {
    era: input.generationInput.era,
    start: input.generationInput.start,
    end: input.generationInput.end,
    automaticTimeRange: input.automaticTimeRange,
  },
): string {
  const continuityProjection = projectRuinContinuityForScope(
    input.context.continuityView,
    ambiguityScope,
  );
  const citationRegistry = input.citationRegistry
    ?? taskCitationRegistry(input.context.evidenceBundle);
  const passages = input.context.evidenceBundle.passages;
  const temporalRules = activeTemporalEligibilityRules(
    input.context.evidenceBundle.temporalEligibility,
    input.generationInput.era,
  );
  const promptTemporalRules = temporalRules.map(rule => ({
    subject: rule.subject,
    scope: rule.scope,
    availableFromEra: rule.availableFromEra,
    affectedEntities: rule.affectedEntityNames,
    evidence: rule.evidence,
  }));
  const evidenceLedger = buildRuinEvidenceLedger(input, passages);
  const qualificationByPassageId = new Map(
    (input.context.evidenceBundle.qualifiedEvidence?.passages ?? [])
      .map(item => [item.passageId, item]),
  );
  const stageAuthority = passages.filter(passage => {
    const qualification = qualificationByPassageId.get(passage.passageId);
    return !qualification || qualification.allowedUses.includes('stage');
  });
  const referenceAuthority = passages.filter(passage =>
    !stageAuthority.some(stagePassage => stagePassage.passageId === passage.passageId));
  const scopeTerms = ruinScopeTerms(input);
  const referenceData = {
    requestId: input.requestId,
    playerDirective: input.directive,
    generationRequest: {
      era: input.generationInput.era,
      start: input.generationInput.start,
      end: input.generationInput.end,
      location: input.generationInput.location,
      supplementaryDirection: input.generationInput.supplementaryDirection,
      selectedCharacters: input.generationInput.selectedCharacters,
      autoGenealogy: input.generationInput.autoGenealogy === true,
      wave: input.generationInput.wave,
    },
    ...(targetMaterial
      ? { targetMaterial: toCreativeMaterial(targetMaterial) }
      : {
          materials: input.generationInput.materials.map(toCreativeMaterial),
        }),
    currentWorld: input.context.currentWorld,
    temporalEligibility: {
      requestedEra: input.generationInput.era,
      rules: promptTemporalRules,
    },
    castManifest: toPromptCastManifest(input.context.evidenceBundle.castManifest),
    passages: passages.map(({ content: _content, ...passage }) => passage),
  };
  return [
    ...(input.context.actorPolicy ? [
      '<RUIN_ACTOR_POLICY_READ_ONLY>',
      JSON.stringify(input.context.actorPolicy),
      'requestedSubjects 是完整方向明确指定的事件主体；genealogyActors 只是可出场名单，不是人数配额。blockedGenealogy 只可用于远处亲缘、引用或辨识，不得放入 cast、节点 participants 或让其在现场行动。referenceNames 是资料参照，不得仅凭提及将本人变成演员。',
      '指名亲属只指向该亲属，不连带本人、同族或其他亲属。原籍、血缘、种族与效忠不可重写；明确要求的跨境活动可补合理到场渠道。主体在事件年未出生或已故时，调整未指定的历史跨度，或保留为缺席主体，不伪造生卒。',
      '身份资料可有多个人生阶段、别名和组织关系；当前身份标签不等于童年已经担任该职位。描述当年的角色与能力，不把未来创始人、掌印官等地位提前。',
      '</RUIN_ACTOR_POLICY_READ_ONLY>',
    ] : []),
    ...renderContinuityView(continuityProjection.view, { includeRelations: true }),
    ...renderRuinHistoricalAmbiguityGuidance(
      input.context.continuityView,
      ambiguityScope,
      continuityProjection.hiddenHandles,
    ),
    '<EVIDENCE_LEDGER_READ_ONLY>',
    JSON.stringify(evidenceLedger),
    '</EVIDENCE_LEDGER_READ_ONLY>',
    renderActiveEvidenceBlock(buildActiveEvidenceView(
      input.context.evidenceBundle,
      requestedEraFromText(input.generationInput.era),
    ), { citationRegistry }),
    ...renderCharacterTimeAnchors(input),
    ...renderCharacterCardsFull(input),
    '<HISTORICAL_AUTHORITY_READ_ONLY>',
    'These passages are qualified to describe the requested geographic stage. They are factual anchors, not examples. A passage with temporal.fit=unknown may support stable geography or background, but its named rulers, offices, families and organizations are not automatically contemporary actors. Never echo this block.',
    '以下原文已取得本轮目标地点的舞台资格。它们是事实锚点，不是示例。年代资格为 unknown 时，只可先使用稳定地理与背景；其中具名统治者、官职、家族和组织未经同时代证据确认，不得直接当作本纪元演员。不得回显本区块。',
    ...stageAuthority.map(passage => [
      `[${passage.passageId}][${passage.sourceId}][${passage.sourceType}][${passage.title}]${passage.sectionPath.length ? `[${passage.sectionPath.join(' > ')}]` : ''}`,
      contemporaryReferenceTag(passage, selectedCharacterNames(input)),
      passage.content,
    ].join('\n')),
    '</HISTORICAL_AUTHORITY_READ_ONLY>',
    '<HISTORICAL_REFERENCE_FACTS_READ_ONLY>',
    '以下是与因果、前史、后果或外部地点有关的压缩事实卡。它们只能按各自 allowedUses 使用；尤其不得把外部地点的专名、景观或遗迹搬成本轮舞台。可以借用其明确因果事实，不可借用其舞台外壳。',
    ...referenceAuthority.map(passage => {
      const qualification = qualificationByPassageId.get(passage.passageId);
      return [
        `[${passage.passageId}][${passage.sourceType}][${passage.title}]`,
        `allowedUses=${JSON.stringify(qualification?.allowedUses ?? ['background', 'reference'])}`,
        `forbiddenUses=${JSON.stringify(qualification?.forbiddenUses ?? [])}`,
        `factExcerpt=${referenceFactExcerpt(passage.content, scopeTerms)}`,
        ...(contemporaryReferenceTag(passage, selectedCharacterNames(input)) ? [contemporaryReferenceTag(passage, selectedCharacterNames(input))] : []),
      ].join('\n');
    }),
    '</HISTORICAL_REFERENCE_FACTS_READ_ONLY>',
    '<REFERENCE_DATA_READ_ONLY>',
    JSON.stringify(referenceData),
    '</REFERENCE_DATA_READ_ONLY>',
  ].join('\n');
}

function ruinScopeTerms(input: RuinPromptInput): string[] {
  return uniqueTerms([
    input.generationInput.era,
    input.generationInput.location,
    ...input.generationInput.location.split(/[-—·/\\\s]/u),
    input.generationInput.supplementaryDirection,
    ...input.generationInput.selectedCharacters.map(character => character.name),
    ...requestedDateTerms(input.generationInput),
  ]);
}

function selectedCharacterNames(input: RuinPromptInput): Set<string> {
  return new Set((input.generationInput.selectedCharacters ?? [])
    .map(character => character.name.trim())
    .filter(Boolean));
}

/**
 * 当代参考标注（internal.76 收尾包 A1）：MVU/DLC 来源的 passage 是当代聊天人物卡。
 * 玩家明确选中的人物是重点参考，不等于参与者；所有 MVU 条目都保持当代参考边界。
 * 真正出场必须由补充方向或候选因果另行成立。
 */
function contemporaryReferenceTag(
  passage: { sourceType?: string; title?: string },
  selectedNames: Set<string>,
): string {
  if (passage.sourceType !== 'mvu') return '';
  const isSelected = Array.from(selectedNames).some(name =>
    (passage.title ?? '').includes(name) || name.includes(passage.title ?? ''));
  return isSelected
    ? '[已选重点参考·提高检索注意力·不保证出场]'
    : '[当代参考·仅供关系/现状/命名惯例·不得采用为历史演员或舞台]';
}

function referenceFactExcerpt(content: string, scopeTerms: string[]): string {
  const focusTerms = uniqueTerms([
    ...scopeTerms,
    ...scopeTerms.flatMap(term => [
      ...(term.match(/[\p{Script=Han}]{2,12}(?:入侵|战争|政变|革命|灾难|冲突|迁徙|瘟疫|建立|毁灭)/gu) ?? []),
      ...(term.match(/[\p{Script=Han}]{2,8}纪元/gu) ?? []),
    ]),
  ]);
  const units = content
    .split(/(?<=[。！？；\n])/u)
    .map(value => value.trim())
    .filter(Boolean);
  const ranked = units
    .map((value, index) => ({
      value,
      index,
      score: focusTerms.filter(term => normalize(value).includes(normalize(term))).length,
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected = (ranked.some(item => item.score > 0)
    ? ranked.filter(item => item.score > 0)
    : ranked.slice(0, 1))
    .slice(0, 4)
    .sort((left, right) => left.index - right.index)
    .map(item => item.value)
    .join(' ');
  return selected.slice(0, 640);
}

function toPromptCastManifest(manifest: RuinContextBundle['evidenceBundle']['castManifest']) {
  if (!manifest) return null;
  return {
    schema: manifest.schema,
    entries: manifest.entries.map(entry => ({
      entityId: entry.entityId,
      disposition: entry.disposition,
      role: entry.role,
      reasons: entry.reasons,
      identity: entry.identity,
    })),
    groupCoverage: manifest.groupCoverage,
  };
}

export function buildRuinEvidenceLedger(
  input: RuinPromptInput,
  passages: EvidencePassage[] = input.context.evidenceBundle.passages,
): RuinEvidenceLedger {
  const qualificationByPassageId = new Map(
    (input.context.evidenceBundle.qualifiedEvidence?.passages ?? [])
      .map(item => [item.passageId, item]),
  );
  const scopeTerms = ruinScopeTerms(input);
  return {
    schema: 'eyon.ruin.evidence.v1',
    requestedScope: {
      era: input.generationInput.era,
      start: input.generationInput.start,
      end: input.generationInput.end,
      location: input.generationInput.location,
      locationHierarchy: input.generationInput.location
        .split(/[-—·/\\]/u)
        .map(value => value.trim())
        .filter(Boolean),
      supplementaryDirection: input.generationInput.supplementaryDirection,
    },
    canonicalCharacters: input.generationInput.selectedCharacters.map(character => ({
      mvuId: character.mvuId,
      referenceId: character.referenceId ?? null,
      name: character.name,
      source: character.source,
      race: character.race,
      identities: [...character.identities],
      professions: [...character.professions],
      relations: [...character.relations],
      lifespan: character.lifespan,
      contextSummary: character.contextSummary,
    })),
    authorityPolicy: [
      { sourceType: 'worldbook', governs: 'Canonical setting, history, institutions, geography and named entities.' },
      { sourceType: 'mvu', governs: 'Exact current character names, race, identity, profession, relations and state.' },
      { sourceType: 'chat', governs: 'The visible current scene and events that actually occurred in this chat.' },
      { sourceType: 'genealogy', governs: 'Stored lineage evidence and previously inferred family links.' },
      { sourceType: 'biography', governs: 'Stored biographical stages and dated personal evidence.' },
      { sourceType: 'butterfly', governs: 'Archived consequences of completed ruin interventions.' },
    ],
    evidenceSources: passages.map(passage => {
      const qualification = qualificationByPassageId.get(passage.passageId);
      return {
        passageId: passage.passageId,
        snapshotId: passage.snapshotId,
        sourceId: passage.sourceId,
        sourceType: passage.sourceType,
        title: passage.title,
        sectionPath: [...passage.sectionPath],
        contentHash: passage.contentHash,
        authority: authorityForSourceType(passage.sourceType),
        directMatches: uniqueTerms([
          ...passage.matchedAnchors,
          ...scopeTerms.filter(term =>
            normalize(`${passage.title}\n${passage.content}`).includes(term)),
        ]).slice(0, 12),
        namedAnchors: extractNamedAnchors(passage.content).slice(0, 12),
        dateMentions: extractDateMentions(passage.content).slice(0, 12),
        qualification: qualification
          ? {
            zone: qualification.zone,
            temporalFit: qualification.temporal.fit,
            geographicFit: qualification.geographic.fit,
            eventPhase: qualification.eventPhase,
            revisionFit: qualification.revision.fit,
            allowedUses: [...qualification.allowedUses],
            forbiddenUses: [...qualification.forbiddenUses],
          }
          : null,
      };
    }),
    inferencePolicy: {
      immutableFacts: [
        'Established names and identity bindings',
        'Known race, profession, allegiance and family relations',
        'Explicit lifespan, age and dated deeds',
        'Requested era, time bounds and location hierarchy',
        'Events already established by worldbook, chat or archived records',
      ],
      allowed: [
        'Fill an unnamed minor local role when no relevant source-backed actor exists',
        'Add period texture, motives and connective causes that do not contradict evidence',
        'Create a more specific sub-location inside the requested location hierarchy',
        'Create unnamed local actors, motives, atmosphere and causal bridges in the OPEN layer',
      ],
      forbidden: [
        'Rename, merge, replace or duplicate a known entity under a new identity',
        'Use a person before birth or after death',
        'Move the event to an unrelated location or polity',
        'Promote an inferred local actor into an unsupported canonical authority',
        'Turn a local gap into an unrelated continent-wide institution, divine treaty, national code or civilizational rewrite without direct evidence',
        'Treat an inference as more authoritative than a supplied source',
        'Use a background/reference-only passage as proof that the event occurs at its place or time',
      ],
    },
  };
}

/**
 * 人物年龄锚：把引擎按开局锁定基准时间算好的出生/抵达窗口注入墟境 prompt。
 * 模型据此按「事件年份 − 出生（抵达）年」写在场年龄，禁止自行心算；
 * 未出生/已故时段禁止在场。
 * 界外来客（arrivalBased）特殊处理：穿越时间世界书未记载时，「抵达年」只是按
 * 「基准年 − 年龄」线性外推的推断线（相当于抵达时 0 岁的假说），不是硬事实——
 * 正文明示更晚抵达且抵达时年龄自洽是被允许的，但同一人物不得混用互相矛盾的
 * 抵达线（如一边「已在此地数十年」一边「初来乍到」）。
 */
export function renderCharacterTimeAnchors(input: RuinPromptInput): string[] {
  const selected = input.generationInput.selectedCharacters;
  const entries = input.context.evidenceBundle.personTimeline ?? [];
  // 名单 = 选中人物 + 补充方向点名人物 + 本轮检索史料或演员名册中的人物。
  // 后一项让自动召回的谱系亲属与世界书人物走同一时间锚，不再要求玩家手选。
  const mentionText = input.generationInput.supplementaryDirection;
  const names = new Set<string>();
  for (const character of selected) {
    const name = normalize(character.name);
    if (name) names.add(name);
  }
  for (const entry of entries) {
    if (personMentionedIn(mentionText, entry.name)) names.add(entry.name);
  }
  const evidenceText = input.context.evidenceBundle.passages
    .map(passage => `${passage.title}\n${passage.content}`)
    .join('\n');
  for (const entry of entries) {
    if (personMentionedIn(evidenceText, entry.name)) names.add(entry.name);
  }
  for (const castEntry of input.context.evidenceBundle.castManifest?.entries ?? []) {
    if (castEntry.identity.kinds.includes('person')) names.add(castEntry.identity.canonicalName);
  }
  if (names.size === 0) return [];
  const eventSpan = input.generationInput.start || input.generationInput.end
    ? {
        start: {
          era: input.generationInput.era,
          year: input.generationInput.start?.year ?? input.generationInput.end?.year ?? null,
        },
        end: {
          era: input.generationInput.era,
          year: input.generationInput.end?.year ?? input.generationInput.start?.year ?? null,
        },
      }
    : null;
  const lines: string[] = [];
  for (const name of names) {
    // 双源适配：同名多条（MVU + worldbook）时优先取有生卒窗口的条目。
    const entry = findPersonTimelineEntry(entries, name);
    const lifespan = entry?.lifespan;
    const born = lifespan?.born;
    if (!entry || !born?.era || born.year === null || born.year === undefined) continue;
    const eventEvidence = entry.lifeAnchors?.length
      ? `\n　事件证据（列出顺序不是时间线）：${entry.lifeAnchors.map(anchor => {
        const status = anchor.epistemicStatus === 'reported' ? '／转述' : '';
        const time = anchor.chronology === 'dated' ? '／有日期' : '／顺序未定';
        return `${anchor.factId ? `[${anchor.factId}]` : ''}${anchor.event}${status}${time}`;
      }).join('；')}`
      : '';
    const eventRelations = entry.eventRelations?.length
      ? `\n　有据关系：${entry.eventRelations.map(relation =>
        `${relation.fromFactId} ${relation.relation} ${relation.toFactId}（${relation.rationale}）`).join('；')}`
      : '';
    const chronology = `${eventEvidence}${eventRelations}`;
    const eventAgeGuidance = eventSpan
      ? assessStagePerson(entry, eventSpan, input.generationInput.era).guidance
      : '';
    const eventAgeLine = eventAgeGuidance ? `本轮事件年由脚本核算：${eventAgeGuidance}` : '';
    if (lifespan?.arrivalBased) {
      const hardFact = lifespan.ageAtRecord !== undefined
        ? `硬事实：基准${lifespan.basedOnEra ?? ''}${lifespan.basedOnYear ?? ''}年时${lifespan.ageAtRecord}岁，界外来客`
        : '界外来客';
      const died = lifespan.died?.era
        ? `；已故于${lifespan.died.era}${lifespan.died.year}年`
        : '';
      lines.push(
        `【${name}】${hardFact}，但穿越/抵达时间世界书未记载。`
        + `脚本推断线：按年龄线性外推，其在场/抵达约${born.era}${born.year}年起`
        + `（事件在场年龄 = 事件年份 − ${born.year}，「抵达时0岁」假说）${died}。`
        + '若剧情需要描写其抵达/初来场景：抵达时间与抵达时年龄必须自洽'
        + `（如${born.era}45X年抵达则当时约 5X 岁），且全文与各史稿保持一致——`
        + '禁止同一人物同时出现「已在此地数十年」与「初来乍到」两条互相矛盾的抵达线。'
        + eventAgeLine
        + chronology,
      );
      continue;
    }
    const origin = lifespan?.ageBased
      ? `（由基准时间${lifespan.basedOnEra ?? ''}${lifespan.basedOnYear ?? ''}年时${lifespan.ageAtRecord ?? ''}岁推算）`
      : '（已知资料显式记载）';
    const died = lifespan?.died?.era
      ? `；已故于${lifespan.died.era}${lifespan.died.year}年`
      : '；在世';
    lines.push(
      `【${name}】出生${born.era}${born.year}年${origin}${died}；`
      + `事件在场年龄 = 事件年份 − ${born.year}；未出生/已故时段禁止其在场；`
      + '出场时必须按该年龄安排可信的生命阶段、权限、职业与自主行动，不得把其后来成年后的身份倒灌进童年或少年期；'
      + `若资料明确说明长寿种、生长差异或特殊社会制度，则按原资料处理。${eventAgeLine}${chronology}`,
    );
  }
  if (!lines.length) return [];
  return [
    '<CHARACTER_TIME_ANCHORS>',
    '以下人物来自本轮重点参考、自动召回史料或演员名册；其出生/抵达窗口由脚本统一换算（禁止自行心算年龄）：',
    ...lines,
    '</CHARACTER_TIME_ANCHORS>',
    '<RUIN_ABSENCE_MODE>',
    '优先级：CHARACTER_TIME_ANCHORS 已坐实的未出生/已故，高于本轮 CAST_MANIFEST 的 required 出场要求。'
    + '这只豁免本轮在场，不改人物身份与 Canon；不得把该人物塞回 sharedCast、candidate.cast 或节点参与者。',
    '绝对缺席只适用于 CHARACTER_TIME_ANCHORS 能确定的未出生或已故：人物不得以任何形态在场，'
    + '不得出现在节点参与者或史稿本人描写中；',
    '失踪、失能、囚禁、放逐、身处异界、除名等只是自然语言史料中可能出现的受限状态，并不等于人物不存在。'
    + '结合当前有效 Canon 与证据原句理解具体限制，允许人物在限制所容许的地点、身份、能力、认知和行动范围内出现；',
    '不得无解释地让受限人物恢复自由、能力、身份或公开活动。玩家明确要求越狱、获释、回归、复职、治愈、迁徙等变化时，'
    + '可以把变化写成本任务候选中的局部状态转移，但必须保留既有前史，不得改写成限制从未发生；候选本身不等于永久 Canon。',
    '只有人物确属未出生或已故时，才把候选写成「其到来之前/其影响之后」的世界：其氏族/传统/地点的前史、其命运伏笔'
    + '（「日后将……」「传说中……」），不得改名影射出场。',
    '事件证据没有有据关系时，允许依据跨条目材料提出不同的可成立解释；不得按列出顺序强行编成年表。',
    '</RUIN_ABSENCE_MODE>',
  ];
}

/**
 * 中心人物整条目注入：优先使用 Retrieval P0-A 生成、带 contentHash/attachmentId 的
 * taskAnchorAttachments；旧 characterCards 只作兼容回退，不再充当不可追踪的第二真源。
 */
function renderCharacterCardsFull(input: RuinPromptInput): string[] {
  const attachments = input.context.evidenceBundle.taskAnchorAttachments ?? [];
  const cards = input.context.characterCards ?? [];
  const selected = input.generationInput.selectedCharacters;
  const mentionText = input.generationInput.supplementaryDirection;
  if (attachments.length === 0 && cards.length === 0) return [];
  // 名单 = 选中人物 + 补充方向点名人物（点名即进入）。
  const names = new Set<string>();
  for (const character of selected) {
    const name = normalize(character.name);
    if (name) names.add(name);
  }
  for (const card of cards) {
    if (personMentionedIn(mentionText, card.title)) names.add(card.title);
  }
  for (const attachment of attachments) {
    if (personMentionedIn(mentionText, attachment.canonicalName)) {
      names.add(attachment.canonicalName);
    }
  }
  if (names.size === 0) return [];
  const lines: string[] = [];
  for (const name of names) {
    const matchedAttachments = attachments.filter(item =>
      personNameMatches(item.canonicalName, name)
      || personNameMatches(item.title, name));
    if (matchedAttachments.length > 0) {
      for (const attachment of matchedAttachments) {
        lines.push(
          `【${attachment.canonicalName}｜attachmentId=${attachment.attachmentId}｜sha256=${attachment.contentHash}】`,
          attachment.content,
        );
      }
      continue;
    }
    const card = cards.find(item => personNameMatches(item.title, name));
    if (!card) continue;
    lines.push(`【${card.title}】`, card.content);
  }
  if (!lines.length) return [];
  return [
    '<CHARACTER_CARDS_FULL>',
    '以下为选中重点参考人物的可追踪完整条目（只读：身份/生卒/背景口述/性格/装备等锁定事实；选择不等于要求出场，'
    + '正文禁止改动其身份与既定背景，禁止复述本区块）：',
    ...lines,
    '</CHARACTER_CARDS_FULL>',
  ];
}

function authorityForSourceType(sourceType: ContextSource['sourceType']): number {
  if (sourceType === 'worldbook') return 100;
  if (sourceType === 'mvu') return 95;
  if (sourceType === 'chat') return 80;
  if (sourceType === 'genealogy') return 75;
  return 70;
}

export function selectRuinReferenceSources(
  input: RuinPromptInput,
  targetMaterial?: RuinMaterial,
): ContextSource[] {
  const materials = targetMaterial
    ? [targetMaterial]
    : input.generationInput.materials;
  const terms = uniqueTerms([
    input.generationInput.era,
    ...requestedDateTerms(input.generationInput),
    input.generationInput.location,
    ...input.generationInput.location.split(/[-—·•・\s]/u),
    input.generationInput.supplementaryDirection,
    ...input.generationInput.selectedCharacters.flatMap(character => [
      character.name,
      ...character.identities,
      character.race,
      ...character.professions,
      ...character.relations,
      character.contextSummary,
    ]),
    ...materials.flatMap(material => [
      materialDirection(material.background),
      materialDirection(material.conflict),
      materialDirection(material.trigger),
    ]),
  ]);
  const selectedCharacterIds = new Set(
    input.generationInput.selectedCharacters.flatMap(character => [
      `mvu-character:${character.mvuId}`,
      ...(character.referenceId ? [character.referenceId] : []),
    ]),
  );
  const ranked = input.context.sourceIndex
    .map((source, index) => ({
      source,
      index,
      score: sourceScore(source, terms, selectedCharacterIds),
    }))
    .filter(item =>
      selectedCharacterIds.has(item.source.sourceId)
      || item.score >= 5_000
    )
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const bridgeTerms = uniqueTerms(
    ranked
      .slice(0, 4)
      .flatMap(({ source }) => [
        source.title,
        ...extractNamedAnchors(source.content),
        ...linkedSourceTitles(source, input.context.sourceIndex),
      ]),
  );
  const expandedRanked = input.context.sourceIndex
    .map((source, index) => ({
      source,
      index,
      score: sourceScore(
        source,
        [...terms, ...bridgeTerms],
        selectedCharacterIds,
      ),
    }))
    .filter(item =>
      selectedCharacterIds.has(item.source.sourceId)
      || item.score >= 5_000
    )
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: ContextSource[] = [];
  const selectedIds = new Set<string>();
  let usedCharacters = 0;
  for (const { source } of expandedRanked) {
    if (selected.length >= REFERENCE_ITEM_COUNT_LIMIT) break;
    const remaining = REFERENCE_TOTAL_LIMIT - usedCharacters;
    if (remaining <= 0) break;
    const content = source.content.trim().slice(
      0,
      Math.min(REFERENCE_ITEM_LIMIT, remaining),
    );
    if (!content) continue;
    selected.push({ ...source, content });
    selectedIds.add(source.sourceId);
    usedCharacters += content.length;
  }

  const recentFallback = input.context.recentContext
    .filter(source => !selectedIds.has(source.sourceId))
    .sort((left, right) =>
      messageId(right.sourceId) - messageId(left.sourceId)
    )
    .slice(0, RECENT_CHAT_FALLBACK_LIMIT)
    .reverse();
  for (const source of recentFallback) {
    if (selected.length >= REFERENCE_ITEM_COUNT_LIMIT) break;
    const remaining = REFERENCE_TOTAL_LIMIT - usedCharacters;
    if (remaining <= 0) break;
    const content = source.content.trim().slice(
      0,
      Math.min(RECENT_CHAT_ITEM_LIMIT, remaining),
    );
    if (!content) continue;
    selected.push({ ...source, content });
    selectedIds.add(source.sourceId);
    usedCharacters += content.length;
  }
  return selected;
}

function toCreativeMaterial(material: RuinMaterial) {
  return {
    candidateKey: material.candidateKey,
    periodType: material.periodType,
    semanticSeeds: {
      socialBaseline: materialDirection(material.background),
      accumulatedPressure: materialDirection(material.conflict),
      decisiveCatalyst: materialDirection(material.trigger),
    },
  };
}

function materialDirection(value: string): string {
  const parts = value.split('｜').map(part => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(2).join('；') : value.trim();
}

function messageId(sourceId: string): number {
  return Number(sourceId.match(/(\d+)$/u)?.[1] ?? -1);
}

function requestedDateTerms(input: RuinGenerationInput): string[] {
  const dates = [input.start, input.end].filter(
    (date): date is NonNullable<RuinGenerationInput['start']> => Boolean(date),
  );
  return uniqueTerms(dates.flatMap(date => [
    `${input.era}${date.year}年`,
    `${date.year}年`,
    date.month === null ? '' : `${date.month}月`,
    date.day === null ? '' : `${date.day}日`,
  ]));
}

function extractDateMentions(content: string): string[] {
  const matches = content.matchAll(
    /(?:创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(?:前)?\s*\d{1,6}年(?:\s*\d{1,2}月)?(?:\s*\d{1,2}日)?/gu,
  );
  return [...new Set([...matches].map(match => match[0].replace(/\s+/gu, '')))].slice(0, 16);
}

function sourceScore(
  source: ContextSource,
  terms: string[],
  selectedCharacterIds: Set<string>,
): number {
  if (selectedCharacterIds.has(source.sourceId)) return 100_000;
  const haystack = normalize(`${source.title}\n${source.content}`);
  const title = normalize(source.title);
  const matches = terms.filter(term => term && haystack.includes(term)).length;
  const exactTitleMatches = terms.filter(term => term && title === term).length;
  const partialTitleMatches = terms.filter(term =>
    term.length >= 2 && (title.includes(term) || term.includes(title))
  ).length;
  const semanticOverlap = terms.reduce(
    (total, term) => total + bigramOverlapScore(term, haystack),
    0,
  );
  const typeScore: Record<ContextSource['sourceType'], number> = {
    worldbook: 1_000,
    mvu: 950,
    genealogy: 850,
    biography: 800,
    chat: 300,
    butterfly: 200,
  };
  const chatRecency = source.sourceType === 'chat'
    ? Number(source.sourceId.match(/(\d+)$/u)?.[1] ?? 0)
    : 0;
  return Math.min(matches, 10) * 10_000
    + Math.min(exactTitleMatches, 3) * 18_000
    + Math.min(partialTitleMatches, 4) * 4_000
    + Math.min(semanticOverlap, 4_500)
    + typeScore[source.sourceType]
    + source.authority
    + Math.min(chatRecency, 250);
}

function extractNamedAnchors(content: string): string[] {
  const anchors = [
    ...content.matchAll(/[“「『《]([^”」』》]{2,24})[”」』》]/gu),
    ...content.matchAll(/([\p{Script=Han}·]{2,18}(?:帝国|王国|公国|共和国|家族|氏族|教会|教团|神殿|学院|学派|商会|公会|议会|军团|卫队|骑士团|公司|工坊|法庭|城市|城堡|城|镇|村|省|郡|领|港|岛|山脉|森林|河|遗迹))/gu),
    ...content.matchAll(/([\p{Script=Han}]{1,8}(?:·[\p{Script=Han}]{1,12}){1,3})/gu),
  ];
  return anchors
    .map(match => normalize(match[1] ?? ''))
    .filter(value => value.length >= 2 && value.length <= 24)
    .slice(0, 18);
}

function linkedSourceTitles(
  source: ContextSource,
  sources: ContextSource[],
): string[] {
  const content = normalize(source.content);
  return sources
    .filter(candidate => candidate.sourceId !== source.sourceId)
    .map(candidate => candidate.title.trim())
    .filter(title => {
      const normalizedTitle = normalize(title);
      return normalizedTitle.length >= 2
        && normalizedTitle.length <= 32
        && content.includes(normalizedTitle);
    })
    .slice(0, 12);
}

function bigramOverlapScore(term: string, haystack: string): number {
  const normalized = normalize(term);
  if (normalized.length < 4 || normalized.length > 40) return 0;
  const grams = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  let matches = 0;
  for (const gram of grams) {
    if (haystack.includes(gram)) matches += 1;
  }
  const ratio = grams.size ? matches / grams.size : 0;
  return ratio >= 0.45 ? Math.round(ratio * 1_500) : 0;
}

function uniqueTerms(values: string[]): string[] {
  return [...new Set(values.flatMap(value =>
    value
      .split(/[，。；、,;：:\n（）()【】[\]]/u)
      .map(normalize)
      .filter(term => term.length >= 2 && term.length <= 40)
  ))];
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}
