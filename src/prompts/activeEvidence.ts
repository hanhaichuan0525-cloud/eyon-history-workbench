import type {
  EvidenceBundle,
  EvidencePassage,
  KnowledgeEntity,
  PersonCanonView,
  QualifiedEvidenceView,
  TaskCitationRegistry,
} from '../retrieval/contracts.ts';
import {
  maskTaskCitationIdentifiers,
  renderTaskCitationContract,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import { projectContinuousStates, renderContinuousStateContract, renderContinuousStatesAtTimes, type ContinuousStateInterval } from '../retrieval/continuousState.ts';
import {
  activeTemporalEligibilityRules,
  assessPersonTimeline,
  buildEraProfile,
  describePersonLifespanWindow,
  resolveLifespanFromBaseline,
} from '../retrieval/temporal.ts';

/**
 * 模块无关的 Active 证据视图：四模块 prompt 只序列化这份精简视图
 * （时代画像、人物时间锚、CastManifest 处置、活跃时间规则与 passage 元数据，不含 passage 正文）。
 * 时间冲突不再致命：模型基于时代画像与人物时间锚自行判断与合理化，validator 只保结构与证据完整性。
 */

export interface ActiveEvidenceView {
  continuousStates?: ContinuousStateInterval[];
  /** Citation Contract v2：同一顶层任务/冻结快照内的唯一句柄表。 */
  citationRegistry?: TaskCitationRegistry;
  /** P1 当前分支/版本在本任务 scope 内的只读投影。 */
  canonResolvedView?: {
    viewId: string;
    branchId: string;
    resolvedRevision: number;
    queryScopeHash: string;
    activeRevisionFacts: Array<{
      statement: string;
      temporalScope: string | null;
      spatialScope: string | null;
      epistemicStatus: string;
    }>;
    currentTemporalOrigins?: Array<{
      statement: string;
      predicate: 'birth_time' | 'established_time' | 'created_time';
      time: string;
      source: 'baseline' | 'intervention';
    }>;
    uncertainItems: string[];
    /** F-02 v5：命中干涉的行动摘要（actionRecord 人话断言）。 */
    interventionSummaries?: Array<{
      revision: number;
      record: string;
      time?: string;
      locations: string[];
    }>;
  };
  /**
   * 仅供脚本在提交下一次干涉时复用当前 active Canon 的稳定状态身份。
   * 不渲染进模型提示词；旧冻结快照缺省即保持原有 generated 兜底。
   */
  activeCanonStateFacts?: Array<{
    factId: string;
    subjectEntityId: string;
    predicate: string;
    continuousState?: import('../retrieval/continuousState.ts').ContinuousState;
    epistemicStatus?: import('../retrieval/contracts.ts').CanonFact['epistemicStatus'];
    confidence?: import('../retrieval/contracts.ts').CanonFact['confidence'];
  }>;
  requestedEra: string | null;
  /** 四模块共用的时间/地理/叙事用途资格，不包含 passage 正文。 */
  qualifiedEvidence?: QualifiedEvidenceView | null;
  /** 时代画像：该纪元已存在 / 尚不存在 / 已灭绝与时代特征（供模型判断与合理化时间错位）。 */
  eraProfile: {
    requestedEra: string;
    exists: string[];
    notYet: string[];
    extinct: string[];
    eraFeatures: string[];
  } | null;
  /** 人物时间锚：入选人物的出生/在世/缺席结论与叙事方针（脚本算好给模型，不让模型心算）。 */
  personTimeline: Array<{
    name: string;
    state: 'alive' | 'not-born' | 'deceased' | 'unknown';
    narrative: string;
    /** 机器可读生卒/抵达窗口（时期分区逐段推断在场与年龄用）。 */
    lifespan?: KnowledgeEntity['lifespan'];
  }>;
  /** 规划与扩写共用的稳定人物事实投影。 */
  personCanonViews?: PersonCanonView[];
  castManifest: Array<{
    canonicalName: string;
    disposition: 'required' | 'group-required' | 'recommended' | 'optional' | 'excluded';
    role: 'actor' | 'target' | 'participant' | 'context';
    reasons: string[];
    identity: {
      aliases: string[];
      kinds: string[];
      identities: string[];
      temporalScopes: string[];
      locationScopes: string[];
    };
  }> | null;
  temporalRules: Array<{
    subject: string;
    scope: 'entity' | 'institution';
    availableFromEra: string;
    affectedEntityNames: string[];
    evidence: string;
  }>;
  /** 疆域引用降级说明：玩家把某实体当地点范围填，目标纪元该实体尚不存在。 */
  territorial: Array<{
    name: string;
    requestedEra: string;
    message: string;
  }>;
  passages: Array<{
    passageId: string;
    sourceId: string;
    sourceType: EvidencePassage['sourceType'];
    title: string;
    sectionPath: string[];
    matchedAnchors: string[];
    temporalScopes: string[];
  }>;
}

export function buildActiveEvidenceView(
  bundle: EvidenceBundle,
  requestedEra: string | null,
  options: {
    /** 开局锁定的年龄基准时间（baselineWorldTime）；传了才做年龄换算。 */
    baselineWorldTime?: string | null;
    /** catalog 实体集合（用于人物时间锚评估）；传了才生成 personTimeline。 */
    entities?: KnowledgeEntity[];
    /** 目标纪元的具体年份（可选，用于更精确的 in-era 判定）。 */
    targetYear?: number | null;
  } = {},
): ActiveEvidenceView {
  const rules = requestedEra
    ? activeTemporalEligibilityRules(bundle.temporalEligibility, requestedEra)
    : [];
  // 从 receipt.warnings 提取「is unavailable … treated as territorial reference」降级项。
  const territorial: ActiveEvidenceView['territorial'] = [];
  for (const warning of bundle.receipt.warnings ?? []) {
    const match = warning.match(
      /^(.+?) is unavailable in (.+?); treated as territorial reference/u,
    );
    if (match) {
      territorial.push({
        name: match[1],
        requestedEra: match[2],
        message: warning,
      });
    }
  }
  // 人物时间锚：显式传入 catalog 实体时按目标纪元重建评估；否则直接消费引擎已算好的
  // bundle.personTimeline（引擎按同一 baselineWorldTime 算好，prompt 只读不二次心算）。
  const personTimeline: ActiveEvidenceView['personTimeline'] = [];
  if (requestedEra && options.entities && options.entities.length > 0) {
    for (const entity of options.entities) {
      if (!entity.kinds.includes('person')) continue;
      const lifespan = resolveLifespanFromBaseline(entity, options.baselineWorldTime);
      const effective = lifespan ?? entity.lifespan;
      if (!effective?.born && !effective?.ageAtRecord && !effective?.identityTracks) continue;
      const assessment = assessPersonTimeline(
        { ...entity, lifespan: effective },
        requestedEra,
        options.targetYear ?? null,
      );
      personTimeline.push({
        name: entity.canonicalName,
        state: assessment.state,
        narrative: assessment.narrative,
        lifespan: effective,
      });
    }
  } else if (bundle.personTimeline && bundle.personTimeline.length > 0) {
    personTimeline.push(...bundle.personTimeline);
  }
  const canonResolved = bundle.canonResolvedView;
  if (canonResolved) {
    const byName = new Map<string, PersonCanonView>();
    for (const view of canonResolved.personViews) {
      for (const name of [view.canonicalName, ...view.aliases]) byName.set(name, view);
    }
    for (const item of personTimeline) {
      const resolved = byName.get(item.name);
      if (!resolved?.lifespan) continue;
      const entity: KnowledgeEntity = {
        entityId: resolved.entityId,
        canonicalName: resolved.canonicalName,
        normalizedName: resolved.canonicalName,
        aliases: resolved.aliases,
        kinds: ['person'],
        tags: [],
        temporalScopes: [],
        locationScopes: [],
        identities: [],
        sourceSnapshotIds: resolved.sourceSnapshotIds,
        spans: [],
        lifespan: resolved.lifespan,
      };
      if (requestedEra) {
        const assessment = assessPersonTimeline(entity, requestedEra, options.targetYear ?? null);
        item.state = assessment.state;
        item.narrative = assessment.narrative;
      } else {
        item.state = 'unknown';
        item.narrative = describePersonLifespanWindow(resolved.canonicalName, resolved.lifespan);
      }
      item.lifespan = resolved.lifespan;
    }
  }
  return {
    continuousStates: projectContinuousStates(canonResolved?.activeFacts
      ?? (bundle.personCanonViews ?? []).flatMap(person => person.facts)),
    citationRegistry: taskCitationRegistry(bundle),
    canonResolvedView: canonResolved
      ? {
          viewId: canonResolved.viewId,
          branchId: canonResolved.branchId,
          resolvedRevision: canonResolved.resolvedRevision,
          queryScopeHash: canonResolved.queryScopeHash,
          activeRevisionFacts: canonResolved.activeFacts
            .filter(fact => fact.revisionIntroduced > 0)
            .map(fact => ({
              statement: fact.statement,
              temporalScope: fact.temporalScope,
              spatialScope: fact.spatialScope,
              epistemicStatus: fact.epistemicStatus,
            })),
          currentTemporalOrigins: uniqueTemporalOrigins(canonResolved.activeFacts),
          uncertainItems: [...canonResolved.uncertainItems],
          interventionSummaries: canonResolved.interventionSummaries,
        }
      : undefined,
    activeCanonStateFacts: canonResolved
      ? canonResolved.activeFacts
          .filter(fact => fact.revisionIntroduced > 0)
          .map(fact => ({
            factId: fact.factId,
            subjectEntityId: fact.subjectEntityId,
            predicate: fact.predicate,
            continuousState: fact.continuousState,
            epistemicStatus: fact.epistemicStatus,
            confidence: fact.confidence,
          }))
      : undefined,
    requestedEra,
    qualifiedEvidence: bundle.qualifiedEvidence ?? null,
    eraProfile: requestedEra
      ? buildEraProfile(bundle.temporalEligibility, requestedEra)
      : null,
    personTimeline,
    personCanonViews: bundle.personCanonViews ?? [],
    castManifest: bundle.castManifest
      ? bundle.castManifest.entries.map(entry => ({
        canonicalName: entry.identity.canonicalName,
        disposition: entry.disposition,
        role: entry.role,
        reasons: entry.reasons,
        identity: {
          aliases: [...entry.identity.aliases],
          kinds: [...entry.identity.kinds],
          identities: [...entry.identity.identities],
          temporalScopes: [...entry.identity.temporalScopes],
          locationScopes: [...entry.identity.locationScopes],
        },
      }))
      : null,
    temporalRules: rules.map(rule => ({
      subject: rule.subject,
      scope: rule.scope,
      availableFromEra: rule.availableFromEra,
      affectedEntityNames: [...rule.affectedEntityNames],
      evidence: rule.evidence,
    })),
    territorial,
    passages: bundle.passages.map(passage => ({
      passageId: passage.passageId,
      sourceId: passage.sourceId,
      sourceType: passage.sourceType,
      title: passage.title,
      sectionPath: [...passage.sectionPath],
      matchedAnchors: [...passage.matchedAnchors],
      temporalScopes: [...passage.temporalScopes],
    })),
  };
}

/** 提取查询/任务输入中声明的目标纪元（第一个「X纪元」），无则 null。 */
export function requestedEraFromText(value: string | undefined | null): string | null {
  if (!value) return null;
  const match = value.match(/[\p{Script=Han}]{2,8}纪元/u);
  if (!match) return null;
  // 剥离前置虚词/介词（「对神明纪元」「在复兴纪元」→「神明纪元」「复兴纪元」），
  // 避免纪元名被污染成「对神明纪元」导致 eraOrder 索引失效。
  return match[0].replace(/^(?:对|在|于|从|至|到|的|和|与|或|及|当|每逢|位于)/u, '');
}

/**
 * 生成模型可见的只读证据区块。passage 正文不进本区块：
 * sourceIndex 已按 receipt 顺序携带正文投影，这里只补时代画像、Cast 与时间事实。
 * 时间冲突不是禁令：模型应基于时代画像识别错位并合理处理（异界来源/疆域语义/时间锚）。
 */
export function renderActiveEvidenceBlock(
  view: ActiveEvidenceView,
  options: { citationRegistry?: TaskCitationRegistry; atTimes?: string[] } = {},
): string {
  const citationRegistry = options.citationRegistry ?? view.citationRegistry;
  const lines = [
    ...(citationRegistry ? [renderTaskCitationContract(citationRegistry)] : []),
    ...renderContinuousStateContract(view.continuousStates ?? []),
    ...renderContinuousStatesAtTimes(view.continuousStates ?? [], options.atTimes ?? []),
    ...(view.canonResolvedView ? [
      '<CANON_CURRENT_VIEW>',
      '以下内容是当前聊天分支、当前 revision、当前任务范围内的正史投影；只约束本次命中的对象，不得外推污染其他人物、地点或时期。',
      `当前版本：revision ${view.canonResolvedView.resolvedRevision}`,
      ...(view.canonResolvedView.activeRevisionFacts.length > 0
        ? [
          ...view.canonResolvedView.activeRevisionFacts.map(fact => JSON.stringify(fact)),
          // F-02：generated 条目为本聊天演绎产生的叙事状态，非档案史实——
          // 同窗口叙事以其为当前状态，但不得把演绎身份当作史料外推。
          ...(view.canonResolvedView.activeRevisionFacts.some(fact =>
            fact.epistemicStatus === 'generated')
            ? ['注：以上条目中的 generated 事实来自本聊天玩家的历史干涉（演绎层，非档案原文）；同窗口叙事应以其为当前状态，但不得将其外推为其他人物/地点/时期的档案史实。']
            : []),
        ]
        : ['本任务范围没有 revision 0 之后的新状态；沿用下方已召回的基线资料。']),
      ...((view.canonResolvedView.currentTemporalOrigins?.length ?? 0) > 0
        ? [
          '<CURRENT_TEMPORAL_ORIGINS_READ_ONLY>',
          '以下是当前 revision 对本任务命中对象采用的时间原点。人物年龄、建筑存续时长、机构历史长度都只能由具体事件年份减去对应原点得到；不得拿某次事件中的年龄或时长反推另一套原点。',
          '若原点来自 intervention，表示玩家干涉后的现行值，已经取代该对象在旧 revision 的原点；回看旧 revision 才恢复旧值。',
          ...view.canonResolvedView.currentTemporalOrigins!.map(origin => JSON.stringify(origin)),
          '</CURRENT_TEMPORAL_ORIGINS_READ_ONLY>',
        ]
        : []),
      // F-02 v5：命中干涉的行动断言（人话）——「谁在何时何地做了什么」。
      // 事实卡只陈述各阶段变化；此处给出完整行动记录，模型须把同窗口叙事
      // 建立在「该事件确已发生」之上，不得与行动断言冲突地另写版本。
      ...((view.canonResolvedView.interventionSummaries ?? []).length > 0
        ? [
          '<INTERVENTION_ACTIONS_READ_ONLY>',
          '以下为本聊天玩家历史干涉的行动断言（按 revision 排序）；所涉事件在该窗口内确已发生，'
          + '相关人物/地点的后续叙事不得与这些断言矛盾（可写其后果与余波，不得改写事件本身）。',
          ...view.canonResolvedView.interventionSummaries!.map(summary =>
            `R${summary.revision}（${summary.time ?? '时间不详'}，${summary.locations.join('、') || '地点不详'}）：${summary.record}`),
          '</INTERVENTION_ACTIONS_READ_ONLY>',
        ]
        : []),
      ...(view.canonResolvedView.uncertainItems.length > 0
        ? ['未决项（不得擅自升级为既定事实）：', ...view.canonResolvedView.uncertainItems]
        : []),
      '已被当前 revision 撤回或替换的旧事实不会作为普通史实进入正文；允许玩家明确行动在当前状态上继续制造新的变化。',
      '</CANON_CURRENT_VIEW>',
    ] : []),
    '<ACTIVE_CAST_AND_TIMELINE_READ_ONLY>',
    '以下是本次任务的确定性角色编排与时代事实，不是写作建议，不得回显本区块。',
    `requestedEra：${view.requestedEra ?? '（未声明目标纪元）'}`,
  ];
  if (view.eraProfile) {
    lines.push(
      '<ERA_PROFILE>',
      `目标纪元：${view.eraProfile.requestedEra}`,
      `本纪元已存在：${view.eraProfile.exists.length
        ? view.eraProfile.exists.join('、')
        : '（年表未列明具体实体）'}`,
      `本纪元尚不存在（时间错位风险）：${view.eraProfile.notYet.length
        ? view.eraProfile.notYet.join('、')
        : '（年表未列明）'}`,
      `本纪元之前已灭绝：${view.eraProfile.extinct.length
        ? view.eraProfile.extinct.join('、')
        : '（年表未列明）'}`,
      ...(view.eraProfile.eraFeatures.length > 0
        ? [`时代特征：${view.eraProfile.eraFeatures.join('；')}`]
        : []),
      '错位处理契约：当设定/输入要求出现与本纪元冲突的元素（人物缺席/种族灭绝/科技未出/疆土未属/制度未建），必须：',
      '1. 承认冲突是历史事实（不得无声当作本纪元原生事物）；',
      '2. 二选一：',
      '   A. 缺席叙事：描写该元素缺席时世界的状态、其到来前的空白、其遗产在当下的痕迹（如「梅薇娜尚未穿越至阿斯塔利亚时，晨曙书局……」；「该种族灭绝百年后，其城市成为废墟」）；',
      '   B. 异界来源：位面交汇残留/异界造物/古神遗物/穿越异常/传说误传，并在正文明示来源；',
      '3. 无法自洽时降级为同功能的本纪元对应物（蒸汽机→魔导蒸汽机关/神术动力装置）；',
      '4. 「已存在」清单中的元素是安全默认，优先直接使用。',
      '</ERA_PROFILE>',
    );
  }
  if (view.personTimeline.length > 0) {
    lines.push(
      '<PERSON_TIMELINE>',
      '以下人物的出生/在世/缺席结论由脚本按基准时间与年龄/生卒数据算好，直接遵守，不要自行心算：',
      ...view.personTimeline.map(item => `【${item.name}】${item.narrative}`),
      '</PERSON_TIMELINE>',
    );
  }
  if ((view.personCanonViews?.length ?? 0) > 0) {
    lines.push(...renderPersonCanonViewBlock(view.personCanonViews ?? []));
  }
  if (view.qualifiedEvidence) {
    lines.push(
      '<QUALIFIED_EVIDENCE_VIEW>',
      '证据“相关”不等于可充当本轮舞台、同时发生事实或当前版本。allowedUses 与 forbiddenUses 是脚本从明确时空/版本事实生成的硬边界。',
      `LOCKED：${view.qualifiedEvidence.creativePolicy.locked}`,
      `GUIDED：${view.qualifiedEvidence.creativePolicy.guided}`,
      `OPEN：${view.qualifiedEvidence.creativePolicy.open}`,
      ...view.qualifiedEvidence.passages.map(item => JSON.stringify({
        passageId: item.passageId,
        zone: item.zone,
        temporal: item.temporal,
        geographic: item.geographic,
        eventPhase: item.eventPhase,
        revision: item.revision,
        entityRoles: item.entityRoles,
        allowedUses: item.allowedUses,
        forbiddenUses: item.forbiddenUses,
      })),
      '</QUALIFIED_EVIDENCE_VIEW>',
    );
  }
  lines.push(
    `castManifest（${view.castManifest?.length ?? 0} 项）：${view.castManifest
      ? JSON.stringify(view.castManifest)
      : 'null'}`,
    `activeTemporalRules（${view.temporalRules.length} 条）：${view.temporalRules.length
      ? JSON.stringify(view.temporalRules)
      : '[]'}`,
    '时间规则语义：availableFromEra 晚于 requestedEra 的实体/制度在目标纪元尚不存在；若其必须出现，按 ERA_PROFILE 错位处理契约给出来源或降级对应物，不得无声当作原生事物。',
  );
  if (view.territorial.length > 0) {
    lines.push(
      '<TERRITORIAL_REFERENCE>',
      '以下名称是玩家作为「地点范围/疆域」填写的，不是要求该势力在目标纪元出场：',
      ...view.territorial.map(item =>
        `${item.name}：目标纪元（${item.requestedEra}）尚未建立/不存在。`
        + '把它作为疆域引用处理：不描写其政权实体（军队/法令/皇帝/官员/建立痕迹），'
        + '描写该疆域上目标纪元实际存在的聚落、部族与事件，'
        + '允许以「此地日后将成为/正是后来的……（该名称）」点明时间错位。',
      ),
      '</TERRITORIAL_REFERENCE>',
    );
  }
  if (view.passages.length > 0) {
    lines.push(
      `selectedPassages（${view.passages.length} 项，正文见 sourceIndex，此处仅元数据）：${JSON.stringify(
        view.passages.map(passage => ({
          passageId: passage.passageId,
          sourceId: passage.sourceId,
          sourceType: passage.sourceType,
          title: passage.title,
          sectionPath: passage.sectionPath,
          matchedAnchors: passage.matchedAnchors,
          temporalScopes: passage.temporalScopes,
        })),
      )}`,
    );
  }
  lines.push('</ACTIVE_CAST_AND_TIMELINE_READ_ONLY>');
  const block = lines.join('\n');
  return citationRegistry ? maskTaskCitationIdentifiers(block, citationRegistry) : block;
}

export function stateTimesFromSpan(span: string | undefined, fallbackEra?: string | null): string[] {
  if (!span) return [];
  const parts = span.split(/[—–～]|至|\s-\s/u).map(part => part.trim()).filter(Boolean);
  let era = fallbackEra ?? '';
  return parts.flatMap(part => {
    const match = part.match(/^(.+?)(?:前)?\d+年/u);
    if (match && !/^\d/u.test(part)) era = match[1];
    const label = /^\d/u.test(part) ? `${era}${part}` : part;
    return /\d+年/u.test(label) && era ? [label] : [];
  });
}

type CurrentTemporalOrigin = NonNullable<
  NonNullable<ActiveEvidenceView['canonResolvedView']>['currentTemporalOrigins']
>[number];

function uniqueTemporalOrigins(
  facts: NonNullable<EvidenceBundle['canonResolvedView']>['activeFacts'],
): CurrentTemporalOrigin[] {
  const predicates = new Set(['birth_time', 'established_time', 'created_time']);
  const byKey = new Map<string, {
    statement: string;
    predicate: 'birth_time' | 'established_time' | 'created_time';
    time: string;
    source: 'baseline' | 'intervention';
  }>();
  for (const fact of facts) {
    if (!predicates.has(fact.predicate)) continue;
    const time = fact.object || fact.temporalScope;
    if (!time || !/(?:创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(?:前)?\s*\d+\s*年/u.test(time)) {
      continue;
    }
    const predicate = fact.predicate as 'birth_time' | 'established_time' | 'created_time';
    byKey.set(`${fact.subjectEntityId}|${predicate}`, {
      statement: fact.statement,
      predicate,
      time,
      source: fact.revisionIntroduced > 0 ? 'intervention' : 'baseline',
    });
  }
  return [...byKey.values()];
}

/** 扩写阶段复用同一 factId，不再退回 1500 字人物卡切片作为唯一真源。 */
export function renderPersonCanonViewBlock(views: PersonCanonView[]): string[] {
  if (views.length === 0) return [];
  return [
    '<PERSON_CANON_VIEW>',
    '以下是本任务的人物规范事实。requiredFactIds 必须遵守；不得把未列明的亲属关系、同行状态或动机升级为既定事实。',
    '重要：facts 的数组顺序、sourceSpans 顺序和世界书条目排列都不是历史时间线。只有 eventRelations 或明确 temporalScope 可以锁定先后；其余事件必须保持未决，并可基于跨条目证据提出一个或多个自洽解释。',
    'reported/contested 是“有人如此声称/存在争议”，不能静默升级为客观真相。允许选择任何证据相容的解释，但必须保留其前置条件、替代解释与不确定性。',
    ...views.map(person => JSON.stringify({
      entityId: person.entityId,
      canonicalName: person.canonicalName,
      aliases: person.aliases,
      requiredFactIds: person.requiredFactIds,
      relevantFactIds: person.relevantFactIds,
      eventRelations: person.eventRelations ?? [],
      facts: person.facts.map(fact => ({
        factId: fact.factId,
        predicate: fact.predicate,
        object: fact.object,
        statement: fact.statement,
        temporalScope: fact.temporalScope,
        spatialScope: fact.spatialScope,
        epistemicStatus: fact.epistemicStatus,
        confidence: fact.confidence,
        ...(fact.continuousState ? { continuousState: fact.continuousState } : {}),
        sourceRefs: fact.sourceRefs,
        sourceSnapshotIds: fact.sourceSnapshotIds,
        sourceSpans: fact.sourceSpans,
      })),
    })),
    '</PERSON_CANON_VIEW>',
  ];
}
