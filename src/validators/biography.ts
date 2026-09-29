import type { BiographyContextBundle, ContextSource } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  BiographyErrorSchema,
  BiographyPassageBatchSchema,
  BiographyPassageResponseSchema,
  BiographyPlanSchema,
  BiographySchema,
  type Biography,
  type BiographyPassageResponse,
  type BiographyPlan,
} from '../schemas/biography.ts';
import { BIOGRAPHY_CONTRACT } from '../core/biographyContract.ts';
import {
  assertBiographyRootTraceMatchesStructuredData,
  renderBiographyRootTrace,
} from '../renderers/rootTrace.ts';
import type { BiographyStagePlan } from '../runtime/biographyDiceCore.ts';
import type { TaskCitationRegistry } from '../retrieval/contracts.ts';
import {
  extendTaskCitationRegistry,
  resolveTaskCitationValues,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import { absoluteYear } from '../retrieval/temporal.ts';

export class BiographyValidationError extends Error {
  readonly code: string;
  /** 生成层错误码信封的 kind：校验错误 → validation（走 repair，永不重试网络） */
  readonly kind: 'validation' = 'validation';

  constructor(
    message: string,
    code = 'BIOGRAPHY_INVALID',
  ) {
    super(message);
    this.name = 'BiographyValidationError';
    this.code = code;
  }
}

function compareBiographyCalendarPoints(
  left: BiographyPlan['span']['start'],
  right: BiographyPlan['span']['start'],
  fallbackEra: string | null | undefined,
): number | null {
  if (left.year === null || right.year === null) return null;
  const leftEra = left.era ?? fallbackEra;
  const rightEra = right.era ?? fallbackEra;
  // 旧模型常在同一篇规划中省略所有纪元名。两侧都省略时仍可按同一
  // 局部年表比较；只有一侧有纪元而又无顶层回退时，才因不可比而跳过。
  if (!leftEra && !rightEra) {
    if (left.year !== right.year) return left.year - right.year;
  } else {
    const leftAbsolute = absoluteYear(leftEra, left.year);
    const rightAbsolute = absoluteYear(rightEra, right.year);
    if (leftAbsolute === null || rightAbsolute === null) return null;
    if (leftAbsolute !== rightAbsolute) return leftAbsolute - rightAbsolute;
  }
  for (const key of ['month', 'day', 'hour'] as const) {
    const leftPart = left[key];
    const rightPart = right[key];
    if (leftPart === null || leftPart === undefined
      || rightPart === null || rightPart === undefined) continue;
    if (leftPart !== rightPart) return leftPart - rightPart;
  }
  return 0;
}

function normalizeText(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

/** 模型负责语义消歧；脚本只核对原文指代、主角身份和可追溯来源，不做碎词推断。 */
function assertTargetMatchesDirective(
  target: {
    name: string;
    aliases: string[];
    sourceRefs?: string[];
    playerReference?: string;
    inference?: boolean;
  },
  interpretedTarget: string,
  directive: string,
  protagonistName: string,
  context: BiographyContextBundle,
): void {
  const candidates = [target.name, ...target.aliases]
    .map(normalizeText)
    .filter(Boolean);
  const normalizedDirective = normalizeText(directive);
  const normalizedProtagonist = normalizeText(protagonistName);
  const declared = normalizeText(target.playerReference ?? '');
  const reference = declared || normalizeText(interpretedTarget);
  if (!reference) throw targetMismatchError();

  // 1) 主角特判：指令明确指主角本人时，目标必须是主角。
  const refersToProtagonist = normalizedProtagonist.length > 0 && (
    reference === normalizedProtagonist
    || reference === '我'
    || reference === '自己'
    || reference === '主角'
    || reference === '本人'
    || normalizedDirective.includes(normalizedProtagonist)
  );
  if (refersToProtagonist) {
    if (candidates.includes(normalizedProtagonist)) return;
    throw targetMismatchError();
  }

  // 2) 指代必须逐字来自玩家原话；不再以二字滑窗猜测“相近含义”。
  if (declared && !normalizedDirective.includes(declared)) throw targetMismatchError();

  // 3) 权威名或别名在玩家原话中直接出现时通过。
  if (candidates.some(candidate =>
    normalizedDirective.includes(candidate)
    || candidate.includes(reference)
    || reference.includes(candidate))) return;

  // 4) 称呼/关系指代交给模型解释，但必须有一条资料同时承载该称呼与权威名。
  const resolvedEntries = reference.length >= 2
    ? context.sourceIndex.filter(entry =>
      normalizeText(`${entry.title} ${entry.content}`).includes(reference))
    : [];
  if (resolvedEntries.length > 0) {
    const identityLinked = resolvedEntries.some(entry =>
      candidates.some(candidate =>
        normalizeText(`${entry.title} ${entry.content}`).includes(candidate)));
    if (!identityLinked) throw targetMismatchError();
    return;
  }

  // 5) 没有显式称呼映射时，权威名在冻结语料中完整出现也可锚定。
  const anchoredByCanonicalName = context.sourceIndex.some(entry => {
    const corpus = normalizeText(`${entry.title} ${entry.content}`);
    return candidates.some(candidate => {
      if (corpus.includes(candidate)) return true;
      // 仅处理「权威名的器官/物件」这类明确属格，不做任意短词滑窗。
      const possessiveRoot = candidate.split('的', 1)[0] ?? '';
      return possessiveRoot.length >= 4 && corpus.includes(possessiveRoot);
    });
  });
  if (anchoredByCanonicalName) return;

  // 6) 关系/描述性指代可由模型推理，但必须至少给出可核验来源。
  if (target.sourceRefs?.length) return;
  if (target.inference === true && !candidates.includes(normalizedProtagonist)) return;

  throw targetMismatchError();
}

function targetMismatchError(): BiographyValidationError {
  return new BiographyValidationError(
    'Biography target does not match player directive; '
    + 'fix target: (1) playerReference must be the exact substring of the player directive '
    + 'that refers to the target; (2) target.name/aliases must correspond to a real entity '
    + 'found in the sourceIndex, or share its name; '
    + '(3) set target.inference=true only for blank-layer invented objects with no source entity',
    'TARGET_MISMATCH',
  );
}

function assertContentDoesNotCiteSources(
  content: string,
  sourceTitles: Set<string>,
): void {
  if (sourceTitles.size === 0) return;
  const matches = content.match(/《([^》]+)》/gu) ?? [];
  for (const match of matches) {
    const title = normalizeText(match.slice(1, -1));
    if (sourceTitles.has(title)) {
      throw new BiographyValidationError(
        `Biography content must not cite source titles: ${title}`,
        'SOURCE_TITLE_IN_BODY',
      );
    }
  }
}

function matchesBiographyResponseIdentity(
  value: unknown,
  requestId: string,
): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schema === 'eyon.biography.v1' && record.requestId === requestId;
}

function collectSourceRefs(biography: Biography): string[] {
  return [
    ...biography.target.sourceRefs,
    ...biography.origin.sourceRefs,
    ...biography.status.sourceRefs,
    ...biography.stages.flatMap(stage => stage.sourceRefs),
  ];
}

export function parseAndValidateBiography(
  raw: string,
  expected: {
    requestId: string;
    directive: string;
    context: BiographyContextBundle;
    stagePlan?: BiographyStagePlan;
  },
): Biography {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.biography.v1',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'Biography response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }

  if (!matchesBiographyResponseIdentity(parsed, expected.requestId)) {
    throw new BiographyValidationError(
      'Biography response is not the result for this request; it may be a context echo or legacy contract',
      'RESPONSE_IDENTITY_MISMATCH',
    );
  }

  parsed = normalizeBiographyModelOutput(parsed);

  const apiError = BiographyErrorSchema.safeParse(parsed);
  if (apiError.success) {
    if (apiError.data.requestId !== expected.requestId) {
      throw new BiographyValidationError('Biography error response requestId mismatch', 'REQUEST_MISMATCH');
    }
    throw new BiographyValidationError(apiError.data.error.message, apiError.data.error.code);
  }

  const result = BiographySchema.safeParse(parsed);
  if (!result.success) {
    throw new BiographyValidationError(result.error.message, 'SCHEMA_INVALID');
  }

  const rootTrace = renderBiographyRootTrace({
    ...result.data,
    // 唯一书签键（internal.79 v9）：同名传记共存时书签 id 不冲突。
    bookId: result.data.requestId.slice(-8),
  });
  try {
    assertBiographyRootTraceMatchesStructuredData(result.data, rootTrace);
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'RootTrace semantic validation failed',
      'ROOT_TRACE_SEMANTIC_MISMATCH',
    );
  }
  const biography: Biography = {
    ...result.data,
    rootTrace,
    qualityChecks: {
      ...result.data.qualityChecks,
      rootTraceMatchesStructuredData: true,
    },
  };
  if (biography.requestId !== expected.requestId) {
    throw new BiographyValidationError('Biography requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (normalizeText(biography.playerDirective.raw) !== normalizeText(expected.directive)) {
    throw new BiographyValidationError('Biography player directive mismatch', 'DIRECTIVE_MISMATCH');
  }

  // 残缺 sourceRef 自动修正：模型记住编号却丢前缀段时按唯一编号补全，再校验。
  const resolveSourceRef = buildSourceRefResolver(expected.context.sourceIndex);
  biography.target.sourceRefs = biography.target.sourceRefs.map(resolveSourceRef);
  biography.origin.sourceRefs = biography.origin.sourceRefs.map(resolveSourceRef);
  biography.status.sourceRefs = biography.status.sourceRefs.map(resolveSourceRef);
  biography.stages = biography.stages.map(stage => ({
    ...stage,
    sourceRefs: stage.sourceRefs.map(resolveSourceRef),
  }));

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
  for (const sourceRef of collectSourceRefs(biography)) {
    if (!knownSources.has(sourceRef)) {
      throw new BiographyValidationError(`Unknown source reference: ${sourceRef}`, 'SOURCE_NOT_FOUND');
    }
  }

  // 正文是历史叙事：不得以《…》形式引用资料条目标题（如世界书条目名）。
  const sourceTitles = new Set(
    expected.context.sourceIndex
      .map(source => normalizeText(source.title))
      .filter(Boolean),
  );
  for (const passage of [biography.origin, ...biography.stages, biography.status]) {
    assertContentDoesNotCiteSources(passage.content, sourceTitles);
  }

  assertTargetMatchesDirective(
    biography.target,
    biography.playerDirective.interpretedTarget,
    expected.directive,
    expected.context.scope.characterKey,
    expected.context,
  );

  const stageIds = new Set(biography.stages.map(stage => stage.id));
  if (stageIds.size !== biography.stages.length) {
    throw new BiographyValidationError('Biography stage IDs must be unique', 'STAGE_ID_DUPLICATE');
  }

  validatePassage('起源', biography.origin.title, biography.origin.content);
  validatePassage('现状', biography.status.title, biography.status.content);
  biography.stages.forEach((stage, index) => {
    // 字数下限弹性（internal.79 v5）：300 是推荐下限，260~299 软放行——
    // 字数下限是「防敷衍」的软质量代理，不是机器协议；低于软下限才拒并带扩写指引。
    if (visibleCharacterCount(stage.content) < BIOGRAPHY_CONTRACT.softMinPassageChars) {
      throw new BiographyValidationError(
        `Biography stage ${index + 1} content must contain at least ${BIOGRAPHY_CONTRACT.softMinPassageChars} characters`
        + biographyPassageExpansionGuidance(visibleCharacterCount(stage.content)),
        'STAGE_CONTENT_TOO_SHORT',
      );
    }
    const next = biography.stages[index + 1];
    if (next?.type === stage.type) {
      throw new BiographyValidationError(
        'Adjacent biography stages cannot have the same type',
        'STAGE_SEQUENCE_INVALID',
      );
    }
    if (stage.type === 'turbulent' && next?.type !== 'transition') {
      throw new BiographyValidationError(
        'A turbulent biography stage must be followed by a transition stage',
        'STAGE_SEQUENCE_INVALID',
      );
    }
  });

  if (expected.stagePlan) {
    if (biography.stages.length !== expected.stagePlan.count) {
      throw new BiographyValidationError(
        `Biography must contain exactly ${expected.stagePlan.count} planned stages`,
        'STAGE_PLAN_MISMATCH',
      );
    }
    expected.stagePlan.stages.forEach((planned, index) => {
      const actual = biography.stages[index];
      if (
        actual.id !== planned.id
        || actual.type !== planned.type
        || actual.diceMaterial !== planned.diceMaterial
      ) {
        throw new BiographyValidationError(
          `Biography stage ${index + 1} does not match the locked stage plan`,
          'STAGE_PLAN_MISMATCH',
        );
      }
    });
  }

  return biography;
}

function validatePassage(kind: '起源' | '现状', title: string, content: string): void {
  if (!new RegExp(`^${kind}\\([^()]+\\)$`, 'u').test(title)) {
    throw new BiographyValidationError(
      `${kind}标题必须使用“${kind}(时间)”格式`,
      'PASSAGE_TITLE_INVALID',
    );
  }
  // 字数下限弹性（internal.79 v5）：与 stage/passage 同口径，读契约不手写魔法数字。
  const chars = visibleCharacterCount(content);
  if (chars < BIOGRAPHY_CONTRACT.softMinPassageChars) {
    throw new BiographyValidationError(
      `${kind}正文必须至少${BIOGRAPHY_CONTRACT.softMinPassageChars}字` + biographyPassageExpansionGuidance(chars),
      'PASSAGE_CONTENT_TOO_SHORT',
    );
  }
}

function visibleCharacterCount(value: string): number {
  return Array.from(value.replace(/\s/gu, '')).length;
}

/**
 * 过短扩写指引（internal.79 v5，借鉴墟境 ruinProseExpansionGuidance）：
 * 段落过短的报错不再只有一句数字，而是给出具体补充方向，repair 一次即可自愈。
 */
function biographyPassageExpansionGuidance(chars: number): string {
  return `。本段正文仅 ${chars} 字，请扩写到 ${BIOGRAPHY_CONTRACT.targetPassageCharsMin}~${BIOGRAPHY_CONTRACT.targetPassageCharsMax} 字再重写本段（不要补前情摘要、不要新增与既定事件冲突的事实）：补充方向——①场景感官锚：该地点的光线/气味/声响/触感；②人物动作与对话的具体瞬间（至少一个决定性时刻的代价与结果）；③本段人物/物件在场使用的细节；④事件的前因后果在本段内的自洽闭环。`
    + '禁止重复前后段内容、禁止把前文改造成剧情钩子、禁止凭空立新约定。';
}

function normalizeBiographyModelOutput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { presentation: rawPresentation, ...rest } = value;
  const presentation = normalizeBiographyPresentation(rawPresentation);
  const stages = Array.isArray(value.stages)
    ? value.stages.map(stage => normalizeBiographyStage(stage))
    : value.stages;
  return {
    ...rest,
    // Presentation is rebuilt locally after the structured record validates.
    rootTrace: '[RootTrace]\n[/RootTrace]',
    playerDirective: normalizeListContainer(value.playerDirective, ['secondaryInterests']),
    target: normalizeTarget(value.target),
    ...(presentation === undefined ? {} : { presentation }),
    span: normalizeBiographySpan(value.span),
    origin: normalizePassage(value.origin, '起源'),
    status: normalizePassage(value.status, '现状'),
    stages,
    indexes: normalizeListContainer(value.indexes, [
      'people',
      'factions',
      'objects',
      'locations',
      'themes',
      'potentialRuinLinks',
    ]),
    qualityChecks: normalizeQualityChecks(value.qualityChecks, [
      'playerDirectionFulfilled',
      'hardTimeScopeRespected',
      'worldbookConsistent',
      'diceIntegratedWithoutHijacking',
      'existingBiographiesUsedResponsibly',
      'rootTraceMatchesStructuredData',
    ]),
  };
}

/**
 * 规划响应的容错归一化：json_object 模式下模型会把数组元素对象化
 * （如 people 写成 [{"name":"…"}]）或写入数字/null——Biography 路径已有
 * normalize 容错，plan 路径此前直接走 schema 校验导致 PLAN_SCHEMA_INVALID。
 * 归一化只做类型收窄（对象取 name、数字丢弃），不修改语义。
 */
function normalizeBiographyPlan(value: unknown, directive: string): unknown {
  if (!isRecord(value)) return value;
  const { presentation: rawPresentation, ...rest } = value;
  const presentation = normalizeBiographyPresentation(rawPresentation);
  const target = normalizeTarget(value.target);
  const targetName = isRecord(target) ? normalizeNarrativeText(target.name) : '';
  const compatibilityText = directive.trim() || targetName;
  return {
    ...rest,
    // 旧存档/UI 仍消费这些字段，但它们不再由模型做语义拆分；脚本从原话确定性补齐。
    playerDirective: {
      raw: directive,
      interpretedTarget: targetName || directive,
      hardTimeScope: '',
      primaryDirection: directive,
      secondaryInterests: [],
      reconciliation: '',
    },
    target,
    ...(presentation === undefined ? {} : { presentation }),
    subjectAnchor: compatibilityText,
    changeAxis: compatibilityText,
    meaningCarrier: compatibilityText,
    dramaticQuestion: compatibilityText,
    dominantAxis: 'dramaticQuestion',
    span: normalizeBiographySpan(value.span),
    indexes: {
      people: [], factions: [], objects: [], locations: [], themes: [], potentialRuinLinks: [],
    },
    stages: Array.isArray(value.stages)
      ? value.stages.map(stage => {
        if (!isRecord(stage)) return stage;
        return {
          ...stage,
          span: normalizeBiographyStageSpan(stage.span),
          introduced: normalizeStringList(stage.introduced),
          stalled: normalizeBooleanField(stage.stalled),
          driver: normalizeDriver(stage.driver),
          sourceRefs: normalizeSourceRefs(stage.sourceRefs).refs,
        };
      })
      : value.stages,
    eventAssignments: Array.isArray(value.eventAssignments)
      ? value.eventAssignments.map(item => {
        if (!isRecord(item)) return item;
        return {
          ...item,
          passageId: normalizeNarrativeText(item.passageId),
          eventId: normalizeNarrativeText(item.eventId),
          summary: normalizeNarrativeText(item.summary),
          sourceRefs: normalizeSourceRefs(item.sourceRefs).refs,
        };
      })
      : value.eventAssignments,
    sourceRefs: normalizeSourceRefs(value.sourceRefs).refs,
    qualityChecks: {
      playerDirectionFulfilled: false,
      hardTimeScopeRespected: false,
      worldbookConsistent: false,
      diceIntegratedWithoutHijacking: false,
      existingBiographiesUsedResponsibly: false,
    },
  };
}

/** 展示字段永不成为生成硬门：只保留字符串，其他漂移值视为缺省。 */
function normalizeBiographyPresentation(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title : undefined;
  const subtitle = typeof value.subtitle === 'string' ? value.subtitle : undefined;
  if (title === undefined && subtitle === undefined) return undefined;
  return { title, subtitle };
}

/**
 * 归一化 target：aliases/sourceRefs 收窄为字符串数组；type 覆盖
 * 中文名称与提示词承诺的对象谱系（器官/机构/概念等），未知值回落 object。
 */
function normalizeTarget(value: unknown): unknown {
  const container = normalizeSourceContainer(value, ['aliases']);
  if (!isRecord(container)) return container;
  const typeMap: Record<string, string> = {
    person: 'person',
    region: 'region',
    object: 'object',
    organ: 'organ',
    institution: 'institution',
    concept: 'concept',
    entity: 'entity',
    '人': 'person',
    '人物': 'person',
    '地域': 'region',
    '地点': 'region',
    '区域': 'region',
    '器物': 'object',
    '物品': 'object',
    '物体': 'object',
    '器官': 'organ',
    '机构': 'institution',
    '组织': 'institution',
    '概念': 'concept',
    '制度': 'concept',
  };
  const key = typeof container.type === 'string' ? container.type.trim() : '';
  return {
    ...container,
    type: typeMap[key] ?? 'object',
  };
}

function normalizePlayerDirective(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    raw: normalizeNarrativeText(value.raw),
    interpretedTarget: normalizeNarrativeText(value.interpretedTarget),
    hardTimeScope: normalizeNarrativeText(value.hardTimeScope),
    primaryDirection: normalizeNarrativeText(value.primaryDirection),
    reconciliation: normalizeNarrativeText(value.reconciliation),
    secondaryInterests: normalizeStringList(value.secondaryInterests),
  };
}

/** 自检/质量布尔字段归一化：字符串布尔、0/1 收窄为 boolean；含混值保守 false。 */
function normalizeQualityChecks(value: unknown, keys: string[]): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  for (const key of keys) next[key] = normalizeBooleanField(value[key]);
  return next;
}

function normalizeBooleanField(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : value;
  if ([0, '0', 'false', 'no', '否', '否定'].includes(normalized as never)) return false;
  if ([1, '1', 'true', 'yes', '是'].includes(normalized as never)) return true;
  return false;
}

function normalizeBiographyStageSpan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    start: normalizeBiographyDate(value.start),
    end: normalizeBiographyDate(value.end),
  };
}

/**
 * 单块扩写响应的容错归一化：与规划响应同理，数组字段对象化/数字化的
 * 元素在 schema 校验前收窄为纯字符串数组，避免 PASSAGE_SCHEMA_INVALID 死循环。
 * 同时覆盖：布尔字段字符串化（inference/elementChecklist）。
 */
function normalizeBiographyPassageResponse(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    title: normalizeNarrativeText(value.title),
    content: normalizeNarrativeText(value.content),
    people: normalizeStringList(value.people),
    factions: normalizeStringList(value.factions),
    objects: normalizeStringList(value.objects),
    locations: normalizeStringList(value.locations),
    sourceRefs: normalizeSourceRefs(value.sourceRefs).refs,
    biographyUsage: normalizeObjectList(value.biographyUsage),
    eventId: normalizeNarrativeText(value.eventId),
    inference: normalizeInference(value.inference),
    elementChecklist: normalizeQualityChecks(value.elementChecklist, [
      'sceneGrounded',
      'figureVivid',
      'decisiveMoment',
    ]),
  };
}

function assertBiographyEventAssignments(
  plan: BiographyPlan,
  expected: { context: BiographyContextBundle },
): void {
  const requiredPassages = ['origin', ...plan.stages.map(stage => stage.id), 'status'];
  const actualPassages = plan.eventAssignments.map(item => item.passageId);
  if (
    actualPassages.length !== requiredPassages.length
    || new Set(actualPassages).size !== actualPassages.length
    || requiredPassages.some(passageId => !actualPassages.includes(passageId))
  ) {
    throw new BiographyValidationError(
      `Event assignments must cover exactly: ${requiredPassages.join(', ')}`,
      'PLAN_EVENT_SLOT_MISMATCH',
    );
  }

  const knownFactIds = new Set(
    (expected.context.evidenceBundle.personCanonViews ?? [])
      .flatMap(view => view.facts.map(fact => fact.factId)),
  );
  const seenOccurrence = new Set<string>();
  for (const item of plan.eventAssignments) {
    if (item.eventId.startsWith('fact:') && !knownFactIds.has(item.eventId)) {
      throw new BiographyValidationError(
        `Unknown canonical eventId: ${item.eventId}`,
        'PLAN_EVENT_FACT_NOT_FOUND',
      );
    }
    if (!item.eventId.startsWith('fact:') && !item.eventId.startsWith('invented:')) {
      throw new BiographyValidationError(
        `EventId must use fact: or invented: namespace: ${item.eventId}`,
        'PLAN_EVENT_ID_INVALID',
      );
    }
    if (item.usage === 'occurs') {
      if (seenOccurrence.has(item.eventId)) {
        throw new BiographyValidationError(
          `The same event occurs in more than one passage: ${item.eventId}`,
          'PLAN_EVENT_REUSED',
        );
      }
      seenOccurrence.add(item.eventId);
    }
  }
}

function normalizeBiographyStage(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const sources = normalizeSourceRefs(value.sourceRefs);
  return {
    ...value,
    stalled: normalizeBooleanField(value.stalled),
    driver: normalizeDriver(value.driver),
    people: normalizeStringList(value.people),
    factions: normalizeStringList(value.factions),
    objects: normalizeStringList(value.objects),
    locations: normalizeStringList(value.locations),
    biographyUsage: normalizeObjectList(value.biographyUsage),
    sourceRefs: sources.refs,
    inference: normalizeInference(value.inference) || sources.inferred,
  };
}

/** 阶段推进者归一化：player/world 或中文（玩家/主角/世界）映射；未知回落 undefined。 */
function normalizeDriver(value: unknown): 'player' | 'world' | undefined {
  const map: Record<string, 'player' | 'world'> = {
    player: 'player',
    world: 'world',
    '玩家': 'player',
    '主角': 'player',
    '世界': 'world',
    '自演化': 'world',
  };
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return map[key];
}

function normalizeBiographySpan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    // mode 归一化：枚举值直通；中文（日历/纪年/岁数）映射；
    // 未知/缺失时按 start/end 锚点自推断（两侧皆 age 无 year → age，
    // 有日历锚 → calendar，混合 → mixed），仍未知回落 mixed（最宽容）。
    // 历史 bug：只归一化 label/start/end，漏了 mode——模型在 mode 上
    // 漂移一次（枚举外值/中文/多余词）就 invalid_value，PLAN_SCHEMA_INVALID
    // 死循环；现在与 target.type 的 typeMap 同级容错。
    mode: normalizeSpanMode(value.mode, value.start, value.end),
    // label 由脚本确定性重渲染；模型输出非字符串（null/对象/数字）时置空，
    // 不因 label 类型漂移卡死任务。
    label: typeof value.label === 'string' && value.label.trim()
      ? value.label.trim()
      : '',
    start: normalizeBiographyDate(value.start),
    end: normalizeBiographyDate(value.end),
  };
}

/** 传记跨度模式归一化：calendar | age | mixed（未知值按锚点自推断）。 */
function normalizeSpanMode(
  value: unknown,
  startValue: unknown,
  endValue: unknown,
): 'calendar' | 'age' | 'mixed' {
  const map: Record<string, 'calendar' | 'age' | 'mixed'> = {
    calendar: 'calendar',
    age: 'age',
    mixed: 'mixed',
    '日历': 'calendar',
    '纪年': 'calendar',
    '年份': 'calendar',
    '历法': 'calendar',
    '年龄': 'age',
    '岁数': 'age',
    '岁': 'age',
    '混合': 'mixed',
    '并存': 'mixed',
  };
  const key = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : '';
  const direct = map[key];
  if (direct) return direct;

  // 枚举外/缺失：按起止锚点自推断（与 renderSpanLabel 的判定一致）
  const startAge = inferAnchorAge(startValue);
  const endAge = inferAnchorAge(endValue);
  const hasCalendarStart = inferHasCalendarAnchor(startValue);
  const hasCalendarEnd = inferHasCalendarAnchor(endValue);
  if (startAge && endAge && !hasCalendarStart && !hasCalendarEnd) return 'age';
  if (hasCalendarStart || hasCalendarEnd) return 'mixed';
  return 'mixed';
}

function inferAnchorAge(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.age) && value.age !== null;
}

function inferHasCalendarAnchor(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [value.year, value.month, value.day, value.hour]
    .some(item => Number.isInteger(item) && item !== null);
}

function normalizeBiographyDate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const label = normalizeNarrativeText(value.label);
  const parsed = parseBiographyDateLabel(label);
  return {
    year: normalizeNullableInteger(value.year, parsed.year),
    month: normalizeNullableInteger(value.month, parsed.month),
    day: normalizeNullableInteger(value.day, parsed.day),
    hour: normalizeNullableInteger(value.hour, parsed.hour),
    age: normalizeNullableInteger(value.age, parsed.age),
    era: typeof value.era === 'string' && value.era.trim()
      ? value.era.trim()
      : undefined,
  };
}

function parseBiographyDateLabel(label: string): Record<'year' | 'month' | 'day' | 'hour' | 'age', number | null> {
  return {
    year: parseLabelInteger(label, /(-?\d+)\s*年/u),
    month: parseLabelInteger(label, /(\d+)\s*月/u),
    day: parseLabelInteger(label, /(\d+)\s*日/u),
    hour: parseLabelInteger(label, /(\d+)\s*时/u),
    age: parseLabelInteger(label, /(\d+)\s*岁/u),
  };
}

function parseLabelInteger(label: string, pattern: RegExp): number | null {
  const matched = label.match(pattern)?.[1];
  if (!matched) return null;
  const parsed = Number(matched);
  return Number.isInteger(parsed) ? parsed : null;
}

function normalizeNullableInteger(value: unknown, fallback: number | null): unknown {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || /^(?:unknown|n\/?a|null|未知|不详|无|在世)$/iu.test(normalized)) {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) ? parsed : value;
}

function normalizeNarrativeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(item => normalizeNarrativeText(item)).filter(Boolean).join('；');
  }
  if (!isRecord(value)) return '';
  for (const key of ['description', 'content', 'text', 'summary', 'value']) {
    const normalized = normalizeNarrativeText(value[key]);
    if (normalized) return normalized;
  }
  return '';
}

function normalizePassage(value: unknown, kind: '起源' | '现状'): unknown {
  if (!isRecord(value)) return value;
  const sources = normalizeSourceRefs(value.sourceRefs);
  return {
    ...value,
    title: normalizePassageTitle(value.title, kind),
    sourceRefs: sources.refs,
    inference: normalizeInference(value.inference) || sources.inferred,
  };
}

function normalizePassageTitle(value: unknown, kind: '起源' | '现状'): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFKC').trim();
  const inner = normalized.match(new RegExp(`^${kind}\\s*\\((.+)\\)$`, 'u'))?.[1]?.trim();
  return inner ? `${kind}(${inner})` : normalized;
}

function normalizeSourceContainer(value: unknown, listKeys: string[]): unknown {
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {
    ...value,
    sourceRefs: normalizeSourceRefs(value.sourceRefs).refs,
  };
  for (const key of listKeys) normalized[key] = normalizeStringList(value[key]);
  return normalized;
}

function normalizeListContainer(value: unknown, listKeys: string[]): unknown {
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = { ...value };
  for (const key of listKeys) normalized[key] = normalizeStringList(value[key]);
  return normalized;
}

function normalizeStringList(value: unknown): string[] {
  const values = value === null || value === undefined
    ? []
    : Array.isArray(value)
    ? value
    : [value];
  return values
    .map(item => typeof item === 'string'
      ? item.trim()
      : isRecord(item) && typeof item.name === 'string'
      ? item.name.trim()
      : '')
    .filter(Boolean);
}

function normalizeObjectList(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const usages = new Set([
    'factAnchor',
    'parallelView',
    'relationshipBridge',
    'legacy',
    'sourceConflict',
  ]);
  return values.filter(item => (
    isRecord(item)
    && typeof item.biographyId === 'string'
    && Boolean(item.biographyId.trim())
    && typeof item.stageId === 'string'
    && Boolean(item.stageId.trim())
    && typeof item.usage === 'string'
    && usages.has(item.usage)
  ));
}

function normalizeSourceRefs(value: unknown): { refs: string[]; inferred: boolean } {
  let inferred = false;
  const refs = normalizeStringList(value).filter(sourceRef => {
    if (/^inference\s*[:：]/iu.test(sourceRef)) {
      inferred = true;
      return false;
    }
    return true;
  });
  return { refs, inferred };
}

/**
 * 残缺 sourceRef 自动修正器：模型有时记住了编号却丢了前缀段
 * （如输出 worldbook:693201，真实 id 是 worldbook:帝国史:693201）。
 * 末段编号在资料清单中唯一命中时返回完整 id；未命中/多命中返回原值（由调用方报错）。
 */
function buildSourceRefResolver(
  sourceIndex: ContextSource[],
): (ref: string) => string {
  const known = new Set(sourceIndex.map(source => source.sourceId));
  const byTail = new Map<string, string[]>();
  for (const source of sourceIndex) {
    const tail = source.sourceId.split(':').pop() ?? '';
    if (!tail) continue;
    const list = byTail.get(tail);
    if (list) list.push(source.sourceId);
    else byTail.set(tail, [source.sourceId]);
  }
  return (ref: string) => {
    if (known.has(ref)) return ref;
    const tail = ref.split(':').pop() ?? '';
    const matches = byTail.get(tail);
    if (matches && matches.length === 1) return matches[0]!;
    return ref;
  };
}

function normalizeInference(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : value;
  if ([0, '0', 'false', 'no', '否', '否定', '明确事实'].includes(normalized as never)) return false;
  if ([1, '1', 'true', 'yes', '是', '推断', 'inferred'].includes(normalized as never)) return true;
  // Missing or ambiguous provenance must never be promoted to sourced fact.
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseAndValidateBiographyPlan(
  raw: string,
  expected: {
    requestId: string;
    directive: string;
    stagePlan: BiographyStagePlan;
    context: BiographyContextBundle;
  },
): BiographyPlan {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.biography.plan.v1',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'Biography plan is not valid JSON',
      'PLAN_JSON_PARSE_FAILED',
    );
  }

  // 容错归一化：json_object 模式下数组元素可能对象化/数字化，先收窄再校验
  parsed = normalizeBiographyPlan(parsed, expected.directive);

  const result = BiographyPlanSchema.safeParse(parsed);
  if (!result.success) {
    throw new BiographyValidationError(result.error.message, 'PLAN_SCHEMA_INVALID');
  }
  const plan = result.data;

  if (plan.requestId !== expected.requestId) {
    throw new BiographyValidationError('Plan requestId mismatch', 'PLAN_REQUEST_MISMATCH');
  }
  if (normalizeText(plan.playerDirective.raw) !== normalizeText(expected.directive)) {
    throw new BiographyValidationError('Plan player directive mismatch', 'PLAN_DIRECTIVE_MISMATCH');
  }

  assertTargetMatchesDirective(
    plan.target,
    plan.playerDirective.interpretedTarget,
    expected.directive,
    expected.context.scope.characterKey,
    expected.context,
  );

  // 每段起止必须有可读锚点（year 或 age），不允许「粗略概括」；
  // 校验宽松：只要求任一侧有锚点，缺失的月/日/时不影响通过。
  plan.stages.forEach((stage, index) => {
    const start = stage.span.start;
    const end = stage.span.end;
    const anchored = (start.year !== null || start.age !== null)
      || (end.year !== null || end.age !== null);
    if (!anchored) {
      // 报错信息带当前值与可操作修复指引（repair 会回灌给模型，模型据此自愈）
      const current = JSON.stringify({ start, end }).slice(0, 200);
      throw new BiographyValidationError(
        `Plan stage ${index + 1} span is too vague（起止时间过于粗略）; `
        + 'give a year or age anchor：请为该段 span.start 或 span.end 至少一侧填写 '
        + 'year（如 400）或 age（如 24）；month/day/hour 只是可选细化，不能代替年/岁锚点。'
        + `当前 span: ${current}`,
        'PLAN_SPAN_TOO_VAGUE',
      );
    }
  });

  // 相邻段时间连续（宽松）：只在两侧都有可比的日历锚点时检查。
  // 已知纪元可跨纪元比较；未知纪元、缺年份仍跳过，不因信息不全截断任务。
  for (let index = 1; index < plan.stages.length; index += 1) {
    const prevEnd = plan.stages[index - 1]!.span.end;
    const currStart = plan.stages[index]!.span.start;
    const ordering = compareBiographyCalendarPoints(
      currStart,
      prevEnd,
      plan.span.start.era ?? plan.span.end.era,
    );
    if (ordering !== null && ordering < 0) {
      throw new BiographyValidationError(
        `Plan stage ${index + 1} starts before stage ${index} ends; spans must be chronological`
        + '（相邻阶段时间倒置：后一段起点不得早于前一段终点，请按时间顺序重排各段 span）',
        'PLAN_SPAN_INVERSION',
      );
    }
  }

  // 每个阶段只能落在顶层总跨度内。仍然只检查明确可比的日历点；年龄模式与
  // 不完整纪年不猜、不拦。错误进入既有 plan repair，不触碰已生成正文。
  plan.stages.forEach((stage, index) => {
    const fallbackEra = plan.span.start.era ?? plan.span.end.era;
    const beforeStart = compareBiographyCalendarPoints(stage.span.start, plan.span.start, fallbackEra);
    const afterEnd = compareBiographyCalendarPoints(stage.span.end, plan.span.end, fallbackEra);
    if ((beforeStart !== null && beforeStart < 0) || (afterEnd !== null && afterEnd > 0)) {
      throw new BiographyValidationError(
        `Plan stage ${index + 1} falls outside the overall biography span`
        + '（阶段超出顶层时间边界：请只调整该段 span，使其落在顶层 span.start 与 span.end 之间）',
        'PLAN_STAGE_OUTSIDE_OVERALL_SPAN',
      );
    }
  });

  // 新面孔不设硬门槛：选角政策是自适应的（时间紧邻可零新面孔、常青角色可全程在场），
  // 「涌现/新鲜」交给模型 §六 内部自省与 elementChecklist.figureVivid 软自评。

  if (plan.stages.length !== expected.stagePlan.count) {
    throw new BiographyValidationError('Plan stage count mismatch', 'PLAN_STAGE_COUNT_MISMATCH');
  }
  expected.stagePlan.stages.forEach((planned, index) => {
    const actual = plan.stages[index];
    if (actual.id !== planned.id || actual.type !== planned.type || actual.diceMaterial !== planned.diceMaterial) {
      throw new BiographyValidationError(
        `Plan stage ${index + 1} does not match locked stage plan`,
        'PLAN_STAGE_MISMATCH',
      );
    }
  });

  const knownSourceIds = expected.context.sourceIndex.map(source => source.sourceId);
  const citationRegistry = extendTaskCitationRegistry(
    taskCitationRegistry(expected.context.evidenceBundle),
    knownSourceIds,
  );
  const resolveSourceRef = buildSourceRefResolver(expected.context.sourceIndex);
  const resolvePlanSources = (refs: string[]) => resolveBiographyCitationRefs(
    citationRegistry,
    'source',
    refs.map(resolveSourceRef),
    knownSourceIds,
    'PLAN_SOURCE_NOT_FOUND',
  );
  plan.target.sourceRefs = resolvePlanSources(plan.target.sourceRefs);
  plan.sourceRefs = resolvePlanSources(plan.sourceRefs);
  plan.eventAssignments = plan.eventAssignments.map(item => ({
    ...item,
    eventId: item.eventId.startsWith('invented:')
      ? item.eventId
      : resolveBiographyCitationRefs(
        citationRegistry,
        'fact',
        [item.eventId],
        (expected.context.evidenceBundle.personCanonViews ?? [])
          .flatMap(view => view.facts.map(fact => fact.factId)),
        'PLAN_CITATION_HANDLE_NOT_FOUND',
      )[0] ?? item.eventId,
    sourceRefs: resolvePlanSources(item.sourceRefs),
  }));
  plan.stages = plan.stages.map(stage => ({
    ...stage,
    sourceRefs: resolvePlanSources(stage.sourceRefs),
  }));

  assertBiographyEventAssignments(plan, expected);

  // 旧模型残缺 sourceRef 自动修正：编号尾段唯一时补全，再校验。
  plan.target.sourceRefs = plan.target.sourceRefs.map(resolveSourceRef);
  plan.sourceRefs = plan.sourceRefs.map(resolveSourceRef);
  plan.eventAssignments = plan.eventAssignments.map(item => ({
    ...item,
    sourceRefs: item.sourceRefs.map(resolveSourceRef),
  }));
  plan.stages = plan.stages.map(stage => ({
    ...stage,
    sourceRefs: stage.sourceRefs.map(resolveSourceRef),
  }));

  const knownSources = new Set(knownSourceIds);
  for (const ref of [
    ...plan.target.sourceRefs,
    ...plan.sourceRefs,
    ...plan.eventAssignments.flatMap(item => item.sourceRefs),
    ...plan.stages.flatMap(stage => stage.sourceRefs),
  ]) {
    if (!knownSources.has(ref)) {
      throw new BiographyValidationError(`Plan unknown source reference: ${ref}`, 'PLAN_SOURCE_NOT_FOUND');
    }
  }

  return plan;
}

export function parseAndValidateBiographyPassage(
  raw: string,
  expected: {
    requestId: string;
    passageId: string;
    kind: 'origin' | 'stage' | 'status';
    eventId: string;
    eventUsage: BiographyPassageResponse['eventUsage'];
    knownSources: Set<string>;
    citationRegistry?: TaskCitationRegistry;
    directive?: string;
    targetName?: string;
    currentSceneLocation?: string;
  },
): BiographyPassageResponse {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.biography.passage.v1',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'Biography passage is not valid JSON',
      'PASSAGE_JSON_PARSE_FAILED',
    );
  }

  /**
 * 单块扩写响应 schema 失败的包装指引（internal.79 v8）：
 * 把 Zod issues 转成可读修复指引——「空洞报错家族」传记侧的收尾。
 */
function describeBiographyPassageSchemaFailure(
  issues: Array<{ path: Array<unknown>; code: string }>,
  rawMessage: string,
): string {
  const guidance: string[] = [
    '本块响应不符合单块扩写契约，请按本块冻结事件与契约修正后重写本段：',
  ];
  for (const issue of issues) {
    const field = String(issue.path[0] ?? '');
    if (field === 'eventId') {
      guidance.push('· eventId 缺失或为空——必须逐字等于本块冻结事件 eventId（见计划区「本段冻结事件」行）；复用 Canon 事件用列出的 F 句柄，空白层原创用 invented:<passageId>:<短标识>。');
    } else if (field === 'eventUsage') {
      guidance.push('· eventUsage 必须是 occurs / aftermath / recollection / evidence / background 之一——逐字使用本块冻结事件的 usage；承接旧事用 aftermath/recollection/evidence/background，不得重复 occurs。');
    } else if (field === 'sourceRefs') {
      guidance.push('· sourceRefs 只能逐字使用 TASK_CITATION_CONTRACT_V2.allowedSourceRefs 中实际列出的 S 句柄，禁止编造、改写或拼装。');
    } else {
      guidance.push(`· 字段「${field}」不符合契约（${issue.code}）。`);
    }
  }
  guidance.push(`原始校验问题（供诊断）：${rawMessage}`);
  return guidance.join('\n');
}

// 容错归一化：json_object 模式下数组元素可能对象化/数字化，先收窄再校验
  parsed = normalizeBiographyPassageResponse(parsed);

  const result = BiographyPassageResponseSchema.safeParse(parsed);
  if (!result.success) {
    // 报错可操作化（internal.79 v8）：不再把 Zod 原始 issues 直接抛给模型——
    // 包装成可读指引（eventId/eventUsage/sourceRefs 各自怎么说怎么改），
    // 原始 issues 追加尾部供诊断。校验强度不变。
    throw new BiographyValidationError(
      describeBiographyPassageSchemaFailure(result.error.issues, result.error.message),
      'PASSAGE_SCHEMA_INVALID',
    );
  }
  const passage = result.data;
  if (expected.citationRegistry) {
    passage.sourceRefs = resolveBiographyCitationRefs(
      expected.citationRegistry,
      'source',
      passage.sourceRefs,
      expected.knownSources,
      'PASSAGE_CITATION_HANDLE_NOT_FOUND',
    );
    if (!passage.eventId.startsWith('invented:')) {
      passage.eventId = resolveBiographyCitationRefs(
        expected.citationRegistry,
        'fact',
        [passage.eventId],
        [expected.eventId],
        'PASSAGE_CITATION_HANDLE_NOT_FOUND',
      )[0] ?? passage.eventId;
    }
  }

  if (passage.passageId !== expected.passageId || passage.kind !== expected.kind) {
    throw new BiographyValidationError('Passage identity mismatch', 'PASSAGE_IDENTITY_MISMATCH');
  }
  if (passage.eventId !== expected.eventId || passage.eventUsage !== expected.eventUsage) {
    throw new BiographyValidationError(
      'Passage event assignment mismatch',
      'PASSAGE_EVENT_MISMATCH',
    );
  }

  const chars = visibleCharacterCount(passage.content);
  // 字数下限弹性（internal.79 v5）：260~299 软放行；低于 260 拒绝并带扩写指引。
  if (chars < BIOGRAPHY_CONTRACT.softMinPassageChars) {
    throw new BiographyValidationError(
      `Passage content has ${chars} chars, minimum ${BIOGRAPHY_CONTRACT.softMinPassageChars}`
      + biographyPassageExpansionGuidance(chars),
      'PASSAGE_CONTENT_TOO_SHORT',
    );
  }

  for (const key of BIOGRAPHY_CONTRACT.passageElements) {
    if (passage.elementChecklist[key] !== true) {
      throw new BiographyValidationError(
        `Passage element ${key} is not satisfied`,
        'PASSAGE_ELEMENT_MISSING',
      );
    }
  }

  for (const ref of passage.sourceRefs) {
    if (!expected.knownSources.has(ref)) {
      throw new BiographyValidationError(
        `Passage unknown source reference: ${ref}`,
        'PASSAGE_SOURCE_NOT_FOUND',
      );
    }
  }

  return passage;
}

export function parseAndValidateBiographyPassageBatch(
  raw: string,
  expected: {
    requestId: string;
    passages: Array<{
      passageId: string;
      kind: 'origin' | 'stage' | 'status';
      eventId: string;
      eventUsage: BiographyPassageResponse['eventUsage'];
    }>;
    knownSources: Set<string>;
    citationRegistry?: TaskCitationRegistry;
    directive?: string;
    targetName?: string;
    currentSceneLocation?: string;
  },
): BiographyPassageResponse[] {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.biography.passage.batch.v1',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'Biography passage batch is not valid JSON',
      'BATCH_JSON_PARSE_FAILED',
    );
  }

  const result = BiographyPassageBatchSchema.safeParse(parsed);
  if (!result.success) {
    throw new BiographyValidationError(result.error.message, 'BATCH_SCHEMA_INVALID');
  }
  const batch = result.data;

  if (batch.passages.length !== expected.passages.length) {
    throw new BiographyValidationError('Batch passage count mismatch', 'BATCH_COUNT_MISMATCH');
  }

  return batch.passages.map((passage, index) =>
    parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId: expected.requestId,
      passageId: expected.passages[index].passageId,
      kind: expected.passages[index].kind,
      eventId: expected.passages[index].eventId,
      eventUsage: expected.passages[index].eventUsage,
      knownSources: expected.knownSources,
      citationRegistry: expected.citationRegistry,
      directive: expected.directive,
      targetName: expected.targetName,
      currentSceneLocation: expected.currentSceneLocation,
    }),
  );
}

function resolveBiographyCitationRefs(
  registry: TaskCitationRegistry,
  kind: 'source' | 'fact',
  refs: string[],
  allowedInternalIds: Iterable<string>,
  code: string,
): string[] {
  const resolved = resolveTaskCitationValues(registry, kind, refs, allowedInternalIds);
  if (resolved.unknownRefs.length) {
    const label = code === 'PLAN_SOURCE_NOT_FOUND'
      ? 'Plan unknown source reference'
      : `Unknown ${kind} citation handle`;
    throw new BiographyValidationError(
      `${label}: ${resolved.unknownRefs[0]}`,
      code,
    );
  }
  return resolved.targetIds;
}
