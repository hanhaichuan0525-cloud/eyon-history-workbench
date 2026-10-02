import type { ContextSource } from '../core/context.ts';

interface SelectRelevantSourceOptions {
  limit: number;
  /** @deprecated 来源按数量筛选，正文不再按字符截断。 */
  contentLimit?: number;
  fallbackCount?: number;
  /** 可选的确定性相关度门；旧调用缺省时保持原有“权威保底召回”行为。 */
  minScore?: number;
}

const GENERIC_TERMS = new Set([
  '寻根溯源', '溯源', '历史', '传记', '人物', '地点', '物品', '对象',
  '进行', '关于', '主要', '方向', '当前', '世界', '资料', '生成',
]);

/** 关键词扫描最大递归深度：命中条目的正文会加入扫描基底，可再触发其关联条目 */
const SCAN_DEPTH = 3;
/** 命中扫描基底（关键词/递归触发）的额外加分 */
const SCAN_HIT_BONUS = 50;
/** 人设类条目的高召回加分 */
const PERSONA_BONUS = 20;

/**
 * 世界书检索（参考工作流助手 worldbook/scan.ts 的「关键词 + 递归触发」思路）：
 * - **全体可入选**（仅按分数排序、预算截断），保住「谱系/传记/世界书必须带进来」的召回面；
 * - constant 条目常驻优先；
 * - selective 条目按「作者手写 keys / 查询词」命中并加分，命中条目的正文进入扫描基底，
 *   让关联条目（如某人物条目命中后才触发其制度/关系条目）递归浮现；
 * - 人设类条目（标题含「·」或正文含身份标记）高召回加分，
 *   确保「模型要用谁，谁的身份证就到场」，减少借名却不知其性别/生卒/身份。
 */
export function selectRelevantContextSources(
  sources: ContextSource[],
  query: string,
  options: SelectRelevantSourceOptions,
): ContextSource[] {
  const { limit } = options;
  const terms = retrievalTerms(query);
  const constants = sources.filter(source => source.strategyType === 'constant');
  const selective = sources.filter(source => source.strategyType !== 'constant');

  // 扫描阶段：标记关键词/查询命中（含递归触发），供排序加分。
  const scanHit = new Set<string>();
  const selected: ContextSource[] = [...constants];
  let remaining = selective;
  for (let depth = 0; depth < SCAN_DEPTH && remaining.length > 0; depth += 1) {
    const base = buildScanBase(query, selected);
    const next: ContextSource[] = [];
    for (const source of remaining) {
      if (matches(source, terms, base)) {
        scanHit.add(source.sourceId);
        selected.push(source);
      } else {
        next.push(source);
      }
    }
    if (next.length === remaining.length) break;
    remaining = next;
  }

  return sources
    .map((source, index) => ({
      source,
      index,
      score: rank(source, terms, scanHit.has(source.sourceId)),
    }))
    .filter(item => options.minScore === undefined || item.score >= options.minScore)
    .sort((left, right) =>
      right.score - left.score
      || right.source.authority - left.source.authority
      || left.index - right.index)
    .slice(0, limit)
    .map(({ source }) => ({
      ...source,
      content: source.content,
    }));
}

/** 扫描基底 = 查询 + 已命中条目正文（用于触发作者手写 keys） */
function buildScanBase(query: string, selected: ContextSource[]): string {
  const parts = [normalize(query)];
  for (const source of selected) parts.push(normalize(source.content));
  return parts.join(' ');
}

/**
 * 命中判定（只用于扫描加分）：作者 keys 命中扫描基底 或 查询词命中标题/正文/keys。
 * 不做「门槛剔除」——即使不命中，条目仍凭权威地板参与排序（保底召回）。
 */
function matches(
  source: ContextSource,
  terms: string[],
  scanBase: string,
): boolean {
  const title = normalize(source.title);
  const own = normalize(source.content);
  const keywords = (source.keywords ?? []).map(normalize).filter(Boolean);
  if (keywords.length > 0 && keywords.some(keyword => scanBase.includes(keyword))) {
    return true;
  }
  return terms.some(term =>
    title.includes(term)
    || own.includes(term)
    || keywords.some(keyword => keyword.includes(term) || term.includes(keyword)));
}

/**
 * 排序分：constant 恒前；关键词/查询命中（含扫描递归加分）；人设加分；权威地板
 * （让无词面重合但重要的锁定资料如谱系/传记始终能进预算，与旧行为一致）。
 */
function rank(source: ContextSource, terms: string[], scanHit: boolean): number {
  const title = normalize(source.title);
  const own = normalize(source.content);
  const keywords = (source.keywords ?? []).map(normalize).filter(Boolean);
  let score = source.strategyType === 'constant' ? 1_000_000 : 0;
  for (const term of terms) {
    if (keywords.some(keyword => keyword.includes(term) || term.includes(keyword))) {
      score += term.length >= 4 ? 45 : 30;
    }
    if (title.includes(term)) score += term.length >= 4 ? 90 : 55;
    const first = own.indexOf(term);
    if (first >= 0) {
      score += term.length >= 4 ? 24 : 12;
      if (first < 600) score += 8;
    }
  }
  if (scanHit) score += SCAN_HIT_BONUS;
  if (source.strategyType !== 'constant' && isPersonLikeSource(source)) score += PERSONA_BONUS;
  return score + Math.min(10, Math.floor(source.authority / 20));
}

/**
 * 人设类条目高召回信号：标题含「·」（复合人名，如 汀瓦尔·贾维）
 * 或正文开头出现身份标记（性别/生于/寿命/身份…）。
 */
function isPersonLikeSource(source: ContextSource): boolean {
  if (/·/u.test(source.title)) return true;
  return /(?:性别|生于|出生|逝世|寿命|种族|身份)[:：]/u.test(source.content.slice(0, 240));
}

function retrievalTerms(query: string): string[] {
  const normalized = normalize(query);
  const chunks = normalized.match(/[\p{Script=Han}·]{2,}|[a-z0-9_-]{3,}/giu) ?? [];
  const terms = new Set<string>();
  for (const chunk of chunks) {
    if (GENERIC_TERMS.has(chunk)) continue;
    terms.add(chunk);
    if (chunk.includes('·')) {
      for (const part of chunk.split('·')) {
        if (part.length >= 2 && !GENERIC_TERMS.has(part)) terms.add(part);
      }
    }
  }
  return [...terms].sort((left, right) => right.length - left.length).slice(0, 32);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}
