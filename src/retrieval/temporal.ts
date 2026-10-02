import type {
  CanonEventRelation,
  KnowledgeEntity,
  KnowledgeRelation,
  SourceSnapshot,
  TemporalConfidence,
  TemporalEligibilityLedger,
  TemporalEligibilityRule,
  TemporalEventType,
  TemporalFactStatus,
} from './contracts.ts';

const ERA_LINE = /^\s*(?:[-*]\s*)?([\p{Script=Han}]{2,8}纪元)(?:\s*\([^)]*\))?\s*[:：]\s*(.*)$/u;

/** 只规范纪元名称，不把“远古/战争末期”等相对阶段猜成精确年。 */
export function extractEraNames(value: string): string[] {
  return [...new Set([...value.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,32}纪元/gu)]
    .map(match => {
      const raw = match[0];
      const known = raw.match(/(?:创世|神明|混乱|英雄|复兴)纪元$/u)?.[0];
      const prefix = known ? raw.slice(0, -known.length) : '';
      // “新复兴纪元”可能是自定义纪元，不能只凭熟悉的后缀吞掉前缀。
      if (known && (!prefix || /(?:的|在|于|至|到|为|是|进入|回到|之后|及|与|和)$/u.test(prefix))) return known;
      return raw.replace(/^(?:发生在|属于|进入|回到|到了|在|于)(?=[\p{Script=Han}]{2,32}纪元$)/u, '');
    }))];
}

export function extractTemporalScopes(value: string): string[] {
  return [...new Set([...value.normalize('NFKC').matchAll(/[\p{Script=Han}]{2,32}纪元(?:前?\s*\d{1,6}年)?|\d{1,6}年/gu)]
    .map(match => match[0].includes('纪元')
      ? `${extractEraNames(match[0])[0]}${match[0].slice(match[0].indexOf('纪元') + 2)}` : match[0]))];
}
const INSTITUTION_SUBJECT = /(?:宗教|信仰|教会|教团|公会|制度|仪式)/u;

/** 权威年表标题（纪元顺序的唯一权威来源）。 */
const TIMELINE_TITLE = /历史年表|时间线|大事记/u;

/** 否定/排除标记：此类句子不建立「此后才存在」规则。 */
const NEGATION_MARKERS = [
  '不属于', '不隶属', '并非', '未曾', '没有', '尚未', '未建', '未形成', '不存在', '尚未建立',
];

/** 传说/不确定标记：此类事实降为 low + inferred，永不触发 fatal。 */
const LEGEND_MARKERS = [
  '传说', '据说', '相传', '据传', '传闻', '民间流传', '据说曾有', '也许', '或许', '可能', '据称', '神话中说',
];

/** 事件类型关键词 → Temporal v2 eventType。 */
const EVENT_TYPE_PATTERNS: Array<{ pattern: RegExp; eventType: TemporalEventType }> = [
  { pattern: /(?:建立|建造|创立|创建|缔造|建起|建成|落成)(?:了)?/u, eventType: 'created' },
  { pattern: /(?:形成|兴起|出现|诞生|萌芽|起源)(?:了)?/u, eventType: 'formed' },
  { pattern: /(?:改名|更名|改称|易名|更名为)/u, eventType: 'renamed' },
  { pattern: /(?:重建|复建|复兴|恢复|再度建立|重新建立)/u, eventType: 'reformed' },
  { pattern: /(?:灭亡|覆灭|毁灭|消亡|倾覆|败亡|摧毁)/u, eventType: 'destroyed' },
  { pattern: /(?:解散|瓦解|分裂|解体|分崩离析)/u, eventType: 'dissolved' },
];

export function buildTemporalEligibilityLedger(
  snapshots: SourceSnapshot[],
  entities: KnowledgeEntity[],
  relations: KnowledgeRelation[],
): TemporalEligibilityLedger {
  const eraOrder: string[] = [];
  const rules: TemporalEligibilityRule[] = [];
  // Temporal v2：纪元顺序与 high 置信只来自「年表章节」（标题或内部 heading 含
  // 历史年表/时间线/大事记）。无年表章节时回退到旧行为（按全部 ERA_LINE 遇见顺序）。
  let foundTimelineSection = false;

  // 第一遍：只收集权威年表章节的纪元顺序。
  for (const snapshot of snapshots) {
    let inTimeline = false;
    for (const line of snapshot.content.split(/\r?\n/u)) {
      const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u)?.[1] ?? '';
      if (heading) {
        inTimeline = TIMELINE_TITLE.test(heading);
        continue;
      }
      if (!inTimeline) continue;
      const match = line.match(ERA_LINE);
      if (match) {
        foundTimelineSection = true;
        const era = match[1];
        if (!eraOrder.includes(era)) eraOrder.push(era);
      }
    }
  }

  // 第二遍：构建规则（行级判定是否权威年表段落）。
  for (const snapshot of snapshots) {
    let offset = 0;
    let inTimeline = false;
    let currentEra = '';
    const lines = snapshot.content.split(/\r?\n/u);
    for (const line of lines) {
      const lineStart = offset;
      offset += line.length + 1;
      const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*$/u)?.[1] ?? '';
      if (heading) {
        inTimeline = TIMELINE_TITLE.test(heading);
        if (!inTimeline) currentEra = '';
        continue;
      }
      const match = line.match(ERA_LINE);
      if (match) {
        currentEra = match[1];
      } else if (!inTimeline || !currentEra) {
        continue;
      }
      const detail = match
        ? match[2]
        : line.replace(/^\s*[-*]\s*/u, '').replace(/^[^:：]{1,30}[:：]\s*/u, '').trim();
      for (const clause of detail.split(/[。；;，,]/u).map(value => value.trim()).filter(Boolean)) {
        if (isNegatedClause(clause)) continue; // 否定句不建「此后才存在」规则。
        const legend = isLegendaryClause(clause);
        for (const subject of temporalSubjects(clause)) {
          const scope = INSTITUTION_SUBJECT.test(subject) ? 'institution' : 'entity';
          const affected = affectedEntities(subject, scope, entities, relations);
          // Temporal v2 分级：权威年表直陈 = high+explicit；传说/不确定 = low+inferred；
          // 其余（普通来源明确陈述）= medium。
          const isAuthoritative = foundTimelineSection && inTimeline;
          const confidence: TemporalConfidence = legend
            ? 'low'
            : isAuthoritative ? 'high' : 'medium';
          const status: TemporalFactStatus = legend
            ? 'inferred'
            : isAuthoritative ? 'explicit' : 'explicit';
          rules.push({
            ruleId: `temporal:${encodeURIComponent(snapshot.snapshotId)}:${lineStart}:${encodeURIComponent(subject)}`,
            subject,
            scope,
            availableFromEra: currentEra,
            affectedEntityIds: affected.map(entity => entity.entityId),
            affectedEntityNames: affected.map(entity => entity.canonicalName),
            sourceSnapshotId: snapshot.snapshotId,
            evidence: `${currentEra}：${clause}`,
            span: {
              snapshotId: snapshot.snapshotId,
              startOffset: lineStart,
              endOffset: lineStart + line.length,
            },
            eventType: detectEventType(clause),
            confidence,
            status,
            isAuthoritative,
          });
        }
      }
    }
  }
  return {
    schema: 'eyon.retrieval.temporal-eligibility.v1',
    eraOrder,
    rules: dedupeRules(rules),
    authoritativeSourceSnapshotIds: foundTimelineSection
      ? snapshots
        .filter(snapshot => snapshot.content.split(/\r?\n/u)
          .some(line => TIMELINE_TITLE.test(line.match(/^\s*#{1,6}\s+(.+?)\s*$/u)?.[1] ?? '')))
        .map(snapshot => snapshot.snapshotId)
      : [],
  };
}

function isNegatedClause(clause: string): boolean {
  return NEGATION_MARKERS.some(marker => clause.includes(marker));
}

function isLegendaryClause(clause: string): boolean {
  return LEGEND_MARKERS.some(marker => clause.includes(marker));
}

function detectEventType(clause: string): TemporalEventType {
  for (const { pattern, eventType } of EVENT_TYPE_PATTERNS) {
    if (pattern.test(clause)) return eventType;
  }
  return 'unknown';
}

/**
 * 只返回可触发 fatal 的规则：Temporal v2 语义下只有
 * high 置信 + explicit 认识的规则（权威年表直陈）可以硬拦截。
 * medium/low 只降权或警告，不阻断 Active。
 */
export function fatalTemporalEligibilityRules(
  ledger: TemporalEligibilityLedger | undefined,
  requestedEra: string,
): TemporalEligibilityRule[] {
  if (!ledger) return [];
  const requestedIndex = ledger.eraOrder.indexOf(requestedEra);
  if (requestedIndex < 0) return [];
  return ledger.rules.filter(rule => {
    const availableIndex = ledger.eraOrder.indexOf(rule.availableFromEra);
    if (availableIndex < 0 || requestedIndex >= availableIndex) return false;
    const confidence = rule.confidence ?? 'high';
    const status = rule.status ?? 'explicit';
    return confidence === 'high' && status === 'explicit';
  });
}

export function activeTemporalEligibilityRules(
  ledger: TemporalEligibilityLedger | undefined,
  requestedEra: string,
): TemporalEligibilityRule[] {
  if (!ledger) return [];
  const requestedIndex = ledger.eraOrder.indexOf(requestedEra);
  if (requestedIndex < 0) return [];
  return ledger.rules.filter(rule => {
    const availableIndex = ledger.eraOrder.indexOf(rule.availableFromEra);
    return availableIndex >= 0 && requestedIndex < availableIndex;
  });
}

export function entityTemporallyEligible(
  entity: KnowledgeEntity,
  requestedEra: string,
  ledger: TemporalEligibilityLedger | undefined,
): boolean {
  // Temporal v2：实体硬排除只由 fatal 规则决定；低置信规则不排除。
  return !fatalTemporalEligibilityRules(ledger, requestedEra).some(rule =>
    rule.scope === 'entity' && rule.affectedEntityIds.includes(entity.entityId));
}

/**
 * 软冲突检测：返回目标纪元「尚不存在」的实体/制度规则命中项。
 * 不再是致命拦截——调用方只把它作为诊断/提示（写入 warnings 或 prompt 引导），
 * 不因词汇出现而拒绝任务。词表黑名单已废弃：模型基于时代画像自行判断与合理化。
 */
export function findTemporalEligibilityViolations(
  text: string,
  requestedEra: string,
  ledger: TemporalEligibilityLedger | undefined,
): Array<{ rule: TemporalEligibilityRule; matchedTerm: string }> {
  const normalized = normalize(text);
  const violations: Array<{ rule: TemporalEligibilityRule; matchedTerm: string }> = [];
  for (const rule of activeTemporalEligibilityRules(ledger, requestedEra)) {
    const directTerms = rule.scope === 'entity'
      ? [rule.subject, ...rule.affectedEntityNames]
      : [rule.subject];
    const matchedTerm = directTerms.find(term =>
      term.length >= 2 && normalized.includes(normalize(term)));
    if (matchedTerm) violations.push({ rule, matchedTerm });
  }
  return violations;
}

/**
 * 时代画像：从权威年表生成目标纪元的「已存在 / 尚不存在 / 已灭绝」清单与时代特征白描。
 * 供 prompt 的 ERA_PROFILE 区块使用——模型据此自行判断与合理化时间错位，
 * 而不是被词表硬拦。
 */
export interface EraProfile {
  requestedEra: string;
  exists: string[];
  notYet: string[];
  /** 目标纪元之前已灭绝的实体/种族（destroyed/dissolved 事件早于目标纪元）。 */
  extinct: string[];
  /** 时代特征白描：年表直陈的目标纪元底色（如「无国家制度、无宗教体系」）。 */
  eraFeatures: string[];
}

export function buildEraProfile(
  ledger: TemporalEligibilityLedger | undefined,
  requestedEra: string,
): EraProfile {
  if (!ledger) return { requestedEra, exists: [], notYet: [], extinct: [], eraFeatures: [] };
  const requestedIndex = ledger.eraOrder.indexOf(requestedEra);
  if (requestedIndex < 0) {
    return { requestedEra, exists: [], notYet: [], extinct: [], eraFeatures: [] };
  }
  const exists = new Set<string>();
  const notYet = new Set<string>();
  const extinct = new Set<string>();
  const eraFeatures = new Set<string>();
  for (const rule of ledger.rules) {
    const ruleIndex = ledger.eraOrder.indexOf(rule.availableFromEra);
    if (ruleIndex < 0) continue;
    const names = [rule.subject, ...rule.affectedEntityNames]
      .filter(name => name.length >= 2);
    const eventType = rule.eventType ?? 'unknown';
    if (eventType === 'destroyed' || eventType === 'dissolved') {
      if (ruleIndex < requestedIndex) {
        // 在目标纪元之前已灭绝。
        for (const name of names) extinct.add(name);
        eraFeatures.add(`「${rule.subject}」已灭绝/消亡于${rule.availableFromEra}`);
      }
      continue;
    }
    if (ruleIndex <= requestedIndex) {
      for (const name of names) exists.add(name);
    } else {
      for (const name of names) notYet.add(name);
      eraFeatures.add(`「${rule.subject}」至${rule.availableFromEra}才出现/形成`);
    }
  }
  return {
    requestedEra,
    exists: [...exists].sort(),
    notYet: [...notYet].sort(),
    extinct: [...extinct].sort(),
    eraFeatures: [...eraFeatures].sort(),
  };
}

/** 纪元顺序只供先后比较；各纪元长度未知，不能用于跨纪元年龄换算。 */
export const ERA_SEQUENCE = [
  '创世纪元',
  '神明纪元',
  '混乱纪元',
  '英雄纪元',
  '复兴纪元',
] as const;

/** 纪元相对序号（未知纪元返回 null）。 */
export function eraIndex(era: string | undefined | null): number | null {
  if (!era) return null;
  const index = ERA_SEQUENCE.indexOf(era as (typeof ERA_SEQUENCE)[number]);
  return index >= 0 ? index : null;
}

/** 纪元年份 → 排序键。100_000 是排序间隔，不是纪元时长，禁止用其差值计算年龄。 */
export function absoluteYear(era: string | undefined | null, year: number | null | undefined): number | null {
  const index = eraIndex(era);
  if (index === null || year === null || year === undefined) return null;
  return index * 100_000 + year;
}

/** 相同纪年可以直接比较（包括自定义纪年）；已知不同纪元只比较先后。 */
function relativeTimelineYear(era: string | null | undefined, year: number | null | undefined, referenceEra: string): number | null {
  if (!era || year == null) return null;
  if (era === referenceEra) return year;
  const index = eraIndex(era);
  const referenceIndex = eraIndex(referenceEra);
  return index === null || referenceIndex === null ? null : (index - referenceIndex) * 100_000 + year;
}

export interface ParsedWorldTime {
  era: string | null;
  year: number | null;
}

/** 解析「复兴纪元488年-10月-16日-星期日-22:45」或「复兴纪元488年」等世界时间串。 */
export function parseWorldTime(value: string | undefined | null): ParsedWorldTime {
  if (!value) return { era: null, year: null };
  const knownMatch = value.match(
    /(创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(前)?\s*(\d+)\s*年/u,
  );
  const match = knownMatch ?? value.normalize('NFKC').match(
    /^\s*([^\d\s，。；,:\uff1a()\uff08\uff09<>]{2,32}?)(前)?\s*(\d+)\s*年/u,
  );
  if (!match) return { era: null, year: null };
  return {
    era: match[1],
    year: match[2] ? -Number(match[3]) : Number(match[3]),
  };
}

/**
 * 从人物实体 + 基准世界时间换算出生年（人物时间锚）。
 * 优先显式生卒年；只有年龄字段时用「基准年 − 年龄」换算（ageBased）。
 * 基准年来自开局锁定的 baselineWorldTime，禁止用每楼动态时间。
 */
export function resolveLifespanFromBaseline(
  entity: KnowledgeEntity,
  baselineTime: string | undefined | null,
): KnowledgeEntity['lifespan'] | undefined {
  const existing = entity.lifespan;
  if (existing?.originKind && existing.originKind !== 'birth') return existing;
  if (existing?.born) return existing; // 显式生卒直接可用
  if (existing?.ageAtRecord == null) return undefined;
  const base = existing.basedOnEra && existing.basedOnYear != null
    ? { era: existing.basedOnEra, year: existing.basedOnYear } : parseWorldTime(baselineTime);
  if (base.era === null || base.year === null) return undefined;
  const ageText = existing.ageAtRecord;
  if (ageText < 0 || ageText > base.year) return undefined; // 年龄大于基准年：不兼容，不硬算
  return {
    born: { era: base.era, year: base.year - ageText },
    ageAtRecord: ageText,
    basedOnEra: base.era,
    basedOnYear: base.year,
    ageBased: true,
    arrivalBased: existing.arrivalBased,
  };
}

/**
 * 没有单一目标纪元时，向生成模块说明当前 revision 的人物时间原点。
 * 年龄始终由具体段落年份减 born 得出；这里不把“记录时年龄”重复当成事件年龄。
 */
export function describePersonLifespanWindow(
  name: string,
  lifespan: KnowledgeEntity['lifespan'],
): string {
  if (lifespan?.originKind && lifespan.originKind !== 'birth') return specialIdentityGuidance(name, lifespan);
  const born = lifespan?.born;
  const origin = lifespan?.ageBased
    ? `由基准时间${lifespan.basedOnEra ?? ''}${lifespan.basedOnYear ?? ''}年时${lifespan.ageAtRecord ?? ''}岁推算`
    : '当前版本的明确时间原点';
  const arrival = lifespan?.arrivalBased ? '（界外来客：此为抵达本世界的年份，非生理出生）' : '';
  const end = lifespan?.died?.era
    ? `— ${lifespan.died.era}${lifespan.died.year}年（已故）`
    : '— 在世（无死亡记录）';
  const window = born?.era
    ? `出生/抵达${born.era}${born.year}年（${origin}）${arrival}${end}`
    : '无明确出生/抵达原点';
  return `${name}${window}；当前指令未限定纪元，不做整篇在场判定；各段年龄只按该段年份与此原点计算，不得从事件中的裸年龄反推另一个出生年。`;
}

/**
 * 人物时间锚评估：目标纪元/年相对人物生卒的结论。
 * 返回叙事方针字符串（供 prompt 使用），strict 模式下调用方据此决定是否拦截。
 */
export function assessPersonTimeline(
  entity: KnowledgeEntity,
  targetEra: string,
  targetYear: number | null,
): {
  state: 'alive' | 'not-born' | 'deceased' | 'unknown';
  narrative: string;
} {
  const lifespan = entity.lifespan;
  if (lifespan?.originKind && lifespan.originKind !== 'birth') {
    const born = lifespan.born;
    const died = lifespan.died;
    const state = !born || targetYear === null || targetEra !== born.era ? 'unknown'
      : targetYear < born.year ? 'not-born'
      : died && died.era === targetEra && targetYear > died.year ? 'deceased' : 'alive';
    return { state, narrative: specialIdentityGuidance(entity.canonicalName, lifespan)
      + (state === 'not-born' ? '本段早于本界在场原点，不能把原世界血缘当作本界在场证据。'
        : state === 'deceased' ? '本段晚于明确身份终止，按遗产或原肉身另行叙事。' : '') };
  }
  if (!lifespan?.born) return { state: 'unknown', narrative: `${entity.canonicalName}的生卒信息缺失，按世界书资料与时代画像自行判断。` };
  const bornAbs = lifespan.born.year;
  const targetAbs = relativeTimelineYear(targetEra, targetYear, lifespan.born.era);
  if (targetAbs === null) return { state: 'unknown', narrative: `${entity.canonicalName}的目标年份或纪年关系不明，保留生卒原文，由模型判断，不能据此断言在世。` };
  if (targetAbs !== null && targetAbs < bornAbs) {
    return {
      state: 'not-born',
      narrative: `${entity.canonicalName}出生于${lifespan.born.era}${lifespan.born.year}年（${
        lifespan.ageBased ? `由基准时间${lifespan.basedOnEra}${lifespan.basedOnYear ?? ''}年时${lifespan.ageAtRecord}岁推算` : '世界书显式记载'
      }），目标纪元（${targetEra}）早于其出生/抵达：她不在场。请用缺席叙事（其到来前的世界/晨曙书局前史等），或异界来源并明示；不得虚构其在场。`,
    };
  }
  if (lifespan.died) {
    const diedAbs = relativeTimelineYear(lifespan.died.era, lifespan.died.year, lifespan.born.era);
    if (diedAbs === null) return { state: 'unknown', narrative: `${entity.canonicalName}的死亡纪年与目标纪年不可比较，按原文判断。` };
    if (diedAbs !== null && targetAbs !== null && targetAbs > diedAbs) {
      return {
        state: 'deceased',
        narrative: `${entity.canonicalName}于${lifespan.died.era}${lifespan.died.year}年已故，目标纪元（${targetEra}）晚于其死亡：她已不在场。请用缺席叙事（其遗产/影响在当下的痕迹），或异界来源并明示。`,
      };
    }
  }
  return {
    state: 'alive',
    narrative: `${entity.canonicalName}出生于${lifespan.born.era}${lifespan.born.year}年，在目标纪元（${targetEra}）在世，可正常出场。`,
  };
}

/**
 * 人物时间锚条目（Bundle 与视图共用；lifespan 为机器可读窗口，供时期分区逐段推断）。
 */
export interface PersonTimelineEntry {
  name: string;
  state: 'alive' | 'not-born' | 'deceased' | 'unknown';
  narrative: string;
  lifespan?: KnowledgeEntity['lifespan'];
  /** 人物事件证据；数组顺序不代表 chronology。 */
  lifeAnchors?: KnowledgeEntity['lifeAnchors'];
  /** 有证据支持的部分顺序关系。 */
  eventRelations?: CanonEventRelation[];
}

/**
 * 可行时间带（自动时间范围 / 传记 span 建议用）：
 * 下界 = 全体人物出生/抵达年中的最晚者；上界 = 当前剧情时间。
 */
export interface FeasibleWindow {
  /** 全体人物出生/抵达年中最晚者（下界）；无可用信息为 null */
  earliestBorn: { era: string; year: number } | null;
  /** 当前剧情时间（上界）；解析失败为 null */
  latestAllowed: { era: string; year: number } | null;
  /** 下界是否来自年龄推算（ageBased 推断） */
  earliestBornInferred: boolean;
  /** 全部人物无可用年龄/生卒信息 */
  empty: boolean;
}

/**
 * 推导可行时间带：人物出生年下限 + 当前剧情时间上限。
 * 供墟境自动范围（替代纪元窗口下限）与传记 span 建议消费；
 * 无人物年龄信息 → empty=true（调用方回退现状，不误伤）。
 */
export function deriveFeasibleWindow(
  persons: PersonTimelineEntry[],
  currentTime: string | null | undefined,
): FeasibleWindow {
  const parsed = parseWorldTime(currentTime);
  const latestAllowed = parsed.era && parsed.year !== null
    ? { era: parsed.era, year: parsed.year }
    : null;
  let earliestBorn: FeasibleWindow['earliestBorn'] = null;
  let earliestBornInferred = false;
  for (const person of persons) {
    const born = person.lifespan?.born;
    if (!born?.era || born.year === null || born.year === undefined) continue;
    const bornAbs = absoluteYear(born.era, born.year);
    const currentAbs = earliestBorn
      ? absoluteYear(earliestBorn.era, earliestBorn.year)
      : null;
    if (
      earliestBorn === null
      || (bornAbs !== null && currentAbs !== null && bornAbs > currentAbs)
    ) {
      earliestBorn = { era: born.era, year: born.year };
      earliestBornInferred = Boolean(person.lifespan?.ageBased);
    }
  }
  return {
    earliestBorn,
    latestAllowed,
    earliestBornInferred,
    empty: earliestBorn === null,
  };
}

/** 区间在场判定（引擎公用入口；内部复用 assessStagePerson 四态区间逻辑）。 */
export function assessPresenceInWindow(
  person: PersonTimelineEntry,
  span: StageSpanLike,
  contextEra: string | null = null,
): StagePersonAssessment {
  return assessStagePerson(person, span, contextEra);
}

/**
 * 人物名保守匹配：归一化后完全相等，或短名（≥2 字）被长名包含。
 * 覆盖「关系列表 key=玲山」vs「选中人物名=玲山·哈姆斯沃思」这类真实不一致，
 * 防止精确匹配失败导致人物时间锚全线静默失效。
 */
export function personNameMatches(left: string, right: string): boolean {
  const a = normalizePersonName(left);
  const b = normalizePersonName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.includes(shorter);
}

/**
 * 人物是否被文本点名（补充方向/玩家指令）：文本包含全名，或包含短名
 * （「玲山·哈姆斯沃思」的「玲山」）。用于「无论玩家选不选，点名即进入时间锚」。
 */
export function personMentionedIn(
  text: string | null | undefined,
  name: string,
): boolean {
  if (!text) return false;
  const normalized = text.normalize('NFKC').replace(/\s+/gu, '');
  const full = normalizePersonName(name);
  if (!full || full.length < 2) return false;
  if (normalized.includes(full)) return true;
  const short = full.split(/[·•]/u)[0]?.trim();
  return Boolean(short && short.length >= 2 && normalized.includes(short));
}

/**
 * 人物时间锚条目查找（双源适配）：同名多条（MVU + worldbook）时，
 * 优先取「有机器可读生卒窗口」的条目——避免取到无信息那份导致整链失效。
 */
export function findPersonTimelineEntry(
  entries: PersonTimelineEntry[] | undefined,
  name: string,
): PersonTimelineEntry | undefined {
  const matched = (entries ?? []).filter(entry => personNameMatches(entry.name, name));
  if (matched.length === 0) return undefined;
  return matched.find(entry => entry.lifespan?.born)
    ?? matched.find(entry => entry.lifespan)
    ?? matched[0];
}

function normalizePersonName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function specialIdentityGuidance(name: string, lifespan: NonNullable<KnowledgeEntity['lifespan']>): string {
  const labels = { birth: '肉身出生', arrival: '本界抵达', activation: '启动/创造', incarnation: '夺舍/转生' };
  const identity = lifespan.identityTracks;
  const origin = lifespan.born ? `${lifespan.born.era}${lifespan.born.year}年` : '时间待考';
  const body = identity?.body?.birth?.label;
  const soul = identity?.soul?.birth?.label;
  return `${name}的${labels[lifespan.originKind ?? 'birth']}原点：${origin}；`
    + `此原点只用于本界身份在场，不是生理出生或年龄为0。`
    + (body ? `肉身原点：${identity?.body?.world ?? '世界待考'}／${body}；` : '')
    + (soul ? `灵魂原点：${identity?.soul?.world ?? '世界待考'}／${soul}；` : '')
    + (identity?.originAge ? `原点年龄：${identity.originAge.at.label}时${identity.originAge.years}岁；` : '')
    + '原世界年龄与本界经过时间分开，禁止跨世界减年、用宿主生卒判原灵魂死亡或把创造者当血亲。';
}

/** 单段单人的在场结论（区间相交：生卒窗口 × 段起止）。 */
export interface StagePersonAssessment {
  name: string;
  state: 'before-birth' | 'alive' | 'after-death' | 'unknown';
  /** 本段内年龄区间（段首/段末年龄；纯年龄锚点时直接用锚点值，均未知为 null）。 */
  ageRange: { start: number | null; end: number | null };
  /** 在场叙事方针（直接注入扩写 prompt）。 */
  guidance: string;
}

export interface StageSpanPoint {
  era?: string | null;
  year?: number | null;
  age?: number | null;
}

export interface StageSpanLike {
  start: StageSpanPoint;
  end: StageSpanPoint;
}

/** 人物在场窗口的一句话（供规划 prompt）；无可用生卒信息返回 null。 */
export function personAvailabilityLine(person: PersonTimelineEntry): string | null {
  const lifespan = person.lifespan;
  if (lifespan?.originKind && lifespan.originKind !== 'birth') return specialIdentityGuidance(person.name, lifespan);
  if (!lifespan?.born?.era || lifespan.born.year === null || lifespan.born.year === undefined) {
    return null;
  }
  const origin = lifespan.ageBased
    ? `由基准时间${lifespan.basedOnEra ?? ''}${lifespan.basedOnYear ?? ''}年时${lifespan.ageAtRecord ?? ''}岁推算`
    : '世界书显式记载';
  const arrival = lifespan.arrivalBased ? '（界外来客：此为抵达本世界的年份，非生理出生）' : '';
  const end = lifespan.died?.era
    ? `— ${lifespan.died.era}${lifespan.died.year}年（已故）`
    : '— 在世（无死亡记录）';
  return `【${person.name}】出生/抵达${lifespan.born.era}${lifespan.born.year}年（${origin}）${arrival}${end}`;
}

/**
 * 区间相交：人物的生卒窗口 × 一个时期分段的起止 → 该人物在本段的在场结论。
 * 四态：before-birth（整段早于出生/抵达）/ alive（在场，含段内出生/段内亡故的跨接）/
 * after-death（整段晚于亡故）/ unknown（生卒或锚点不足，不约束）。
 * 年龄换算以人物出生年为准（出生年 = 基准时间 − 年龄，由 resolveLifespanFromBaseline 完成）。
 * 段起止缺纪元时依次回退 contextEra → 人物出生纪元（同纪元常见写法「复兴纪元400年」省略纪元名）。
 */
export function assessStagePerson(
  person: PersonTimelineEntry,
  span: StageSpanLike,
  contextEra: string | null = null,
): StagePersonAssessment {
  const lifespan = person.lifespan;
  if (lifespan?.originKind && lifespan.originKind !== 'birth') {
    const born = lifespan.born;
    const era = span.end.era ?? span.start.era ?? contextEra;
    const comparable = !!born && era === born.era
      && !(span.start.era && span.end.era && span.start.era !== span.end.era)
      && (span.start.year != null || span.end.year != null);
    const before = born && era === born.era && span.end.year != null && span.end.year < born.year;
    const died = lifespan.died;
    const after = died && era === died.era && span.start.year != null && span.start.year > died.year;
    return {
      name: person.name, state: comparable && before ? 'before-birth' : comparable && after ? 'after-death' : comparable ? 'alive' : 'unknown',
      ageRange: { start: null, end: null },
      guidance: specialIdentityGuidance(person.name, lifespan)
        + (comparable ? `本段相对该原点的经过年数：${span.start.year == null ? '待考' : span.start.year - born!.year}至${span.end.year == null ? '待考' : span.end.year - born!.year}年（不是肉身年龄）。` : '')
        + (before ? '本段早于该原点，只可写其本界缺席前史或明确标注原世界/原肉身。'
          : after ? '本段晚于明确身份终止，不倒写其本界在场。'
          : '本段在场按上述原点与轨道核对；本界经过年数不是生理年龄。'),
    };
  }
  if (!lifespan?.born?.era || lifespan.born.year === null || lifespan.born.year === undefined) {
    return {
      name: person.name,
      state: 'unknown',
      ageRange: { start: null, end: null },
      guidance: `${person.name}的生卒窗口缺失，按世界书资料与时代画像自行判断在场与年龄。`,
    };
  }
  const bornAbs = lifespan.born.year;
  if (bornAbs === null) {
    return {
      name: person.name,
      state: 'unknown',
      ageRange: { start: null, end: null },
      guidance: `${person.name}的生卒窗口无法换算，按世界书资料与时代画像自行判断。`,
    };
  }
  const diedAbs = lifespan.died?.era
    ? relativeTimelineYear(lifespan.died.era, lifespan.died.year, lifespan.born.era)
    : null;
  const startAbs = stagePointAbsolute(span.start, contextEra, lifespan.born.era);
  const endAbs = stagePointAbsolute(span.end, contextEra, lifespan.born.era);
  const bornLabel = `${lifespan.born.era}${lifespan.born.year}年`;
  const diedLabel = diedAbs !== null && lifespan.died
    ? `${lifespan.died.era}${lifespan.died.year}年`
    : null;
  const arrivalNote = lifespan.arrivalBased
    ? '（界外来客：年龄为抵达本世界后的累计）'
    : '';

  // 无年锚点：年龄锚本身就是「在场」声明，直接用。
  if (startAbs === null && endAbs === null) {
    const startAge = span.start.age ?? null;
    const endAge = span.end.age ?? null;
    if (startAge === null && endAge === null) {
      return {
        name: person.name,
        state: 'unknown',
        ageRange: { start: null, end: null },
        guidance: `${person.name}的本段起止无年/岁锚点，按世界书资料与时代画像自行判断。`,
      };
    }
    return {
      name: person.name,
      state: 'alive',
      ageRange: { start: startAge, end: endAge },
      guidance: `${person.name}在场：本段年龄约 ${formatAgeRange(startAge, endAge)} 岁（规划年龄锚点）${arrivalNote}。`
        + `正文写到段内某一年时应按该年取龄（段首场景用段首年龄，段末场景用段末年龄，禁止把段末年龄套到段首年份的场景上）。`,
    };
  }

  // 整段早于出生/抵达：不在场，禁止虚构。
  if (endAbs !== null && endAbs < bornAbs) {
    return {
      name: person.name,
      state: 'before-birth',
      ageRange: { start: null, end: null },
      guidance: `${person.name}本段尚不存在（出生/抵达${bornLabel}晚于本段）：禁止直接在场。`
        + '用缺席叙事（其到来前的世界/其组织与地点的前史），或异界来源并明示。',
    };
  }
  // 整段晚于亡故：不在场，禁止虚构。
  if (diedAbs !== null && startAbs !== null && startAbs > diedAbs) {
    return {
      name: person.name,
      state: 'after-death',
      ageRange: { start: null, end: null },
      guidance: `${person.name}本段已不在世（${diedLabel}亡故早于本段）：禁止直接在场。`
        + '用缺席叙事（其遗产/影响在当下的痕迹），或异界来源并明示。',
    };
  }
  // 在场（含段内出生/段内亡故的跨接）。
  let ageStart: number | null = null;
  let ageEnd: number | null = null;
  const startEra = span.start.era?.trim() || contextEra || lifespan.born.era;
  const endEra = span.end.era?.trim() || contextEra || lifespan.born.era;
  if (startAbs !== null && startEra === lifespan.born.era) ageStart = Math.max(0, startAbs - bornAbs);
  if (endAbs !== null && endEra === lifespan.born.era) {
    ageEnd = endAbs - bornAbs;
    if (diedAbs !== null && lifespan.died?.era === lifespan.born.era && ageEnd > diedAbs - bornAbs) ageEnd = diedAbs - bornAbs;
  }
  const notes: string[] = [];
  if (startAbs !== null && startAbs < bornAbs) {
    notes.push(`本段横跨其出生/抵达（${bornLabel}）：出生前部分需缺席叙事或异界来源，不得倒写其在场。`);
  }
  if (diedAbs !== null && endAbs !== null && endAbs > diedAbs) {
    notes.push(`本段横跨其亡故（${diedLabel}）：亡故后部分需按缺席处理（遗产/影响），不得倒写其在场。`);
  }
  const ageText = ageStart !== null || ageEnd !== null
    ? `本段年龄约 ${formatAgeRange(ageStart, ageEnd)} 岁（正文写到段内某一年时按该年取龄：段首场景用段首年龄，段末场景用段末年龄，禁止把段末年龄套到段首年份的场景上）`
    : '年龄无法换算（跨纪元长度未记载时不得编造精确年龄）';
  const exactAgeGuide = renderExactAgeGuide(
    span,
    contextEra,
    lifespan.born.era,
    bornAbs,
    diedAbs,
  );
  return {
    name: person.name,
    state: 'alive',
    ageRange: { start: ageStart, end: ageEnd },
    guidance: [`${person.name}在场：${ageText}${arrivalNote}。`, exactAgeGuide, ...notes]
      .filter(Boolean)
      .join(''),
  };
}

/**
 * 时期分区 × 人物时间锚：对一组规划段逐段评估所有已知窗口人物的在场结论。
 * 供传记扩写阶段注入（纯软约束：模型据此写对在场与年龄，绝不因此硬拦任务）。
 */
export function buildStagePersonTimeline(
  stages: Array<{ id: string; span: StageSpanLike }>,
  persons: PersonTimelineEntry[],
  contextEra: string | null = null,
): Array<{ stageId: string; assessments: StagePersonAssessment[] }> {
  return stages.map(stage => ({
    stageId: stage.id,
    assessments: persons.map(person => assessStagePerson(person, stage.span, contextEra)),
  }));
}

function stagePointAbsolute(
  point: StageSpanPoint,
  contextEra: string | null,
  fallbackEra: string | null,
): number | null {
  if (point.year === null || point.year === undefined) return null;
  const era = (point.era && point.era.trim()) || contextEra || fallbackEra;
  if (!era) return null;
  return fallbackEra ? relativeTimelineYear(era, point.year, fallbackEra) : absoluteYear(era, point.year);
}

function formatAgeRange(start: number | null, end: number | null): string {
  if (start === null && end === null) return '未知';
  if (start === null) return `${end} 岁以下`;
  if (end === null) return `${start} 岁起`;
  if (start === end) return `${start}`;
  return `${start}~${end}`;
}

/**
 * 明确年份直接换成机器算好的年龄对照，避免模型从年龄区间中错取端点。
 * 常见短阶段逐年列出；长跨度只给首尾，避免把提示词扩成一张冗长年表。
 */
function renderExactAgeGuide(
  span: StageSpanLike,
  contextEra: string | null,
  fallbackEra: string,
  bornAbs: number,
  diedAbs: number | null,
): string {
  const startAbs = stagePointAbsolute(span.start, contextEra, fallbackEra);
  const endAbs = stagePointAbsolute(span.end, contextEra, fallbackEra);
  if (startAbs === null || endAbs === null || endAbs < startAbs) return '';

  const startEra = (span.start.era && span.start.era.trim()) || contextEra || fallbackEra;
  const endEra = (span.end.era && span.end.era.trim()) || contextEra || fallbackEra;
  if (startEra !== fallbackEra || endEra !== fallbackEra) return '';
  const startYear = span.start.year;
  const endYear = span.end.year;
  if (startYear === null || startYear === undefined || endYear === null || endYear === undefined) {
    return '';
  }

  const makeEntry = (year: number, absolute: number, era: string): string =>
    `${era}${year}年=${Math.max(0, absolute - bornAbs)}岁`;
  const entries: string[] = [];
  const width = endAbs - startAbs;
  if (startEra === endEra && width <= 32) {
    for (let offset = 0; offset <= width; offset += 1) {
      const absolute = startAbs + offset;
      if (absolute < bornAbs || (diedAbs !== null && absolute > diedAbs)) continue;
      entries.push(makeEntry(startYear + offset, absolute, startEra));
    }
  } else {
    if (startAbs >= bornAbs && (diedAbs === null || startAbs <= diedAbs)) {
      entries.push(makeEntry(startYear, startAbs, startEra));
    }
    if (endAbs !== startAbs && endAbs >= bornAbs && (diedAbs === null || endAbs <= diedAbs)) {
      entries.push(makeEntry(endYear, endAbs, endEra));
    }
  }
  if (entries.length === 0) return '';
  return `明确年份—年龄对照（写到哪一年就只能采用该项）：${entries.join('；')}。`;
}

function temporalSubjects(clause: string): string[] {
  const subjects: string[] = [];
  // 「建立/建造 X」句式：提取动词后的对象。
  const founded = clause.match(/^.{1,20}?(?:建立|建造)(?:了)?(.{2,30}?)(?:并.*)?$/u)?.[1];
  if (founded) subjects.push(...founded.split(/[、与和]/u).map(cleanSubject));
  // 「X 建立/诞生/形成…」句式：提取动词前的主体（含「据说/传说」前缀，由置信度分级兜底）。
  const foundedSubject = clause.match(/^(?:据说|传说|相传|据传)?(.{2,30}?)(?:已|早已|就)?(?:建立|建造|诞生|形成|兴起|出现|创立)(?:了|于|在)?/u)?.[1];
  if (foundedSubject) subjects.push(cleanSubject(foundedSubject));
  const emerged = clause.match(/^(.{2,30}?)(?:诞生|形成|兴起|出现|创立)(?:并.*)?$/u)?.[1];
  if (emerged) subjects.push(cleanSubject(emerged));
  // Temporal v2：生命周期事件（分裂/解体/灭亡/重建/改名）同样提取主体。
  const destroyed = clause.match(/^(.{2,30}?)(?:分裂|解体|瓦解|灭亡|覆灭|毁灭|消亡|倾覆|败亡)(?:并.*)?$/u)?.[1];
  if (destroyed) subjects.push(cleanSubject(destroyed));
  const reformed = clause.match(/^(.{2,30}?)(?:重建|复建|复兴|恢复)(?:并.*)?$/u)?.[1];
  if (reformed) subjects.push(cleanSubject(reformed));
  const renamed = clause.match(/^(.{2,30}?)(?:改名|更名|改称|易名|更名为)(?:为)?(.{2,30}?)(?:并.*)?$/u);
  if (renamed) {
    subjects.push(cleanSubject(renamed[1]));
    if (renamed[2]) subjects.push(cleanSubject(renamed[2]));
  }
  return [...new Set(subjects.filter(subject => subject.length >= 2))];
}

function cleanSubject(value: string): string {
  return value.trim()
    .replace(/^(?:首个|第一个|各大|一种|一套)/u, '')
    .replace(/^(?:文明|国家|城市|组织|势力)\s*/u, '')
    .replace(/^[“”"']|[“”"']$/gu, '')
    .replace(/[（(].*$/u, '')
    .trim();
}

function affectedEntities(
  subject: string,
  scope: TemporalEligibilityRule['scope'],
  entities: KnowledgeEntity[],
  relations: KnowledgeRelation[],
): KnowledgeEntity[] {
  const subjectKey = normalize(subject);
  const matched = entities.filter(entity => {
    const name = normalize(entity.canonicalName);
    if (/人类帝国/u.test(subject)) return entity.kinds.includes('faction') && /帝国/u.test(entity.canonicalName);
    if (/公会/u.test(subject)) return entity.kinds.includes('organization') && /公会/u.test(entity.canonicalName);
    if (scope === 'entity' && entitySubjectMatches(subjectKey, name)) return true;
    return false;
  });
  if (scope !== 'institution' || !/圣灵.*信仰|圣灵信仰/u.test(subject)) return matched;
  const groupIds = new Set(entities.filter(entity => /圣灵/u.test(entity.canonicalName)).map(entity => entity.entityId));
  const memberIds = new Set(relations.filter(relation =>
    relation.predicate === 'member_of' && groupIds.has(relation.objectEntityId))
    .map(relation => relation.subjectEntityId));
  return uniqueEntities([
    ...matched,
    ...entities.filter(entity =>
      memberIds.has(entity.entityId)
      && entity.kinds.includes('person')
      && entity.tags.includes('deity')),
  ]);
}

const ENTITY_QUALIFIERS = [
  '帝国', '王国', '国家', '城邦', '城市', '文明', '组织', '势力', '亚种', '地城',
] as const;

function entitySubjectMatches(subjectKey: string, entityName: string): boolean {
  if (entityName === subjectKey || entityName.includes(subjectKey)) return true;
  if (!subjectKey.includes(entityName)) return false;
  const qualifier = ENTITY_QUALIFIERS.find(marker => subjectKey.includes(marker));
  return !qualifier || entityName.includes(qualifier);
}

function dedupeRules(rules: TemporalEligibilityRule[]): TemporalEligibilityRule[] {
  const output = new Map<string, TemporalEligibilityRule>();
  for (const rule of rules) {
    const key = `${normalize(rule.subject)}|${rule.scope}|${rule.availableFromEra}`;
    const existing = output.get(key);
    if (!existing) output.set(key, rule);
    else {
      existing.affectedEntityIds = [...new Set([...existing.affectedEntityIds, ...rule.affectedEntityIds])];
      existing.affectedEntityNames = [...new Set([...existing.affectedEntityNames, ...rule.affectedEntityNames])];
    }
  }
  return [...output.values()];
}

function uniqueEntities(entities: KnowledgeEntity[]): KnowledgeEntity[] {
  return [...new Map(entities.map(entity => [entity.entityId, entity])).values()];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}
