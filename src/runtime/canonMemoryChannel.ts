/**
 * internal.86 · 蓝图 §6 蝴蝶效应面板记忆注入通道（步 A：源 A·蝴蝶）
 *
 * 目标：让「当前分支仍有效的改变后历史」作为可读内容直接进入正文模型，
 * 不依赖世界书激活（为后续镜像退役铺路）。
 *
 * 分层（§6.4）：
 * - 常驻：当前 revision 最近 1~2 个仍有效的变化（刚改完必然相关）；
 * - 触发：更早且仍有效的变化，按关键词命中（硬词 ≥1 即触发；软词需 ≥2 或 1 个特异词）；
 * - 过滤：`reverted/orphaned/superseded` 的 delta 或记录级失效 → 普通正文永不注入；
 * - 未命中：有效但未命中 → 不注入，只留在工作台档案。
 *
 * 关键词（§6.6）：
 * - 硬词：脚本确定性提取（cascadeScope.subjectNames/locations + operations 载体名），过泛词表；
 *   内部.87（G-10①）：仅保留专名形态——载体描述句与整条地点链被剔除（地点按层级拆分）；
 * - 软词：模型 historicalKeywords，低权，只作加分；
 *   内部.87（G-10②）：模型关键词**不再**并入硬词池（回到 §6.5.1 分层，避免误触发即注入）；
 * - 特异性 = 词在当前 chat 全部记录关键词中的稀有度（只出现一次 = 特异）。
 *
 * 有效性判定说明：注入层用「记录级 + delta 级」确定性子集（与 P2-B 评估同源，无需检索 Bundle），
 * 完整 CanonResolvedView 投影仍在生成任务内的 <CANON_CURRENT_VIEW> 生效。
 */

import { territorialFragments } from '../core/placeFragments.ts';
import { operationRebaseState, projectCanonCausalRebase } from '../core/causalRebase.ts';
import type { CanonBranch, InterventionDelta } from '../retrieval/contracts.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import {
  canonMemoryTombstoneKey,
  type ButterflyRecord,
  type CanonMemoryTombstone,
} from '../storage/butterflies.ts';
import {
  buildContinuityViewSafely,
  renderContinuityView,
} from './continuityAnchors.ts';

/** 泛词表（§6.6.2）：抽象名词、体裁词与万能地理词不参与触发。 */
export const CANON_MEMORY_STOPWORDS = new Set([
  '帝国', '王国', '城市', '大陆', '世界', '历史', '命运', '灾祸', '灾难', '影响',
  '变化', '时代', '纪元', '时期', '年代', '文明', '人类', '种族', '神明', '传说',
  '史稿', '日志', '记录', '档案', '文献', '资料', '故事', '真相', '正史', '历史演变',
  '过去', '未来', '现在', '世界线', '因果', '涟漪', '齿轮', '长河', '震荡',
  '国家', '地区', '聚落', '家族', '组织', '制度', '军队', '宗教', '仪式', '战争',
]);

export type CanonMemoryEntryStatus = 'resident' | 'triggered' | 'unmatched' | 'filtered';

export interface CanonMemoryEntry {
  runId: string;
  revision: number;
  title: string;
  /** 注入用正文：已选行动、演变和现世证物完整保留。 */
  digest: string;
  hardKeywords: string[];
  softKeywords: string[];
  status: CanonMemoryEntryStatus;
  /** 判定理由（诊断面板逐条展示）。 */
  reasons: string[];
  score: number;
  /** 实际命中的词（诊断用）。 */
  hits: string[];
}

export interface CanonMemorySnapshot {
  schema: 'eyon.canon.memory-snapshot.v2';
  branchId: string;
  headRevision: number;
  computedAt: number;
  /** 刷新原因：butterfly-committed / chat-changed / message-deleted / before-generation / manual。 */
  trigger: string;
  counts: {
    total: number;
    resident: number;
    triggered: number;
    unmatched: number;
    filtered: number;
  };
  /** 注入块全文（'' = 未注入/已清除）。 */
  injectedText: string;
  entries: CanonMemoryEntry[];
  /** G-08 源 B：相关的已提交传记连续性；与源 A 分预算、分诊断。 */
  continuity: {
    anchorCount: number;
    relationCount: number;
    omittedCount: number;
    warnings: string[];
    injectedText: string;
  };
  /** G-09：本轮源 A 中有多少条来自已删除档案的紧凑记忆残片。 */
  tombstoneCount: number;
}

const RESIDENT_LIMIT = 2;

function normalizeKeyword(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function isUsableKeyword(value: string): boolean {
  const word = normalizeKeyword(value);
  if (word.length < 2) return false;
  if (/^\d+$/u.test(word)) return false;
  if (CANON_MEMORY_STOPWORDS.has(word)) return false;
  return true;
}

/** 从 entity:generated:<名字> 形态的内部 id 中还原可读专名。 */
function keywordFromEntityId(entityId: string): string | null {
  const prefix = 'entity:generated:';
  if (entityId.startsWith(prefix)) {
    try {
      const decoded = decodeURIComponent(entityId.slice(prefix.length));
      return isUsableKeyword(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 专名形态判定（§6.5.2，internal.87 G-10①）。
 *
 * 真机病历（R12）：`cascadeScope.subjectNames` 的载体描述句（"第三麦庄巡夜管事及其
 * 口述报告"、"麦庄管理条例与"监察者"石雕"）与整条地点链（"奥古斯提姆帝国-东部金谷城
 * 外郊-第三麦庄草料库"）被当成硬词进入匹配池——正文永远不会逐字出现 → 死词，
 * 只污染稀有度统计。这里按"短、无标点、无连接结构"的专名形态收口。
 *
 * 取舍：含"与/和/及"的合法专名（如"命定之诗与黄昏之歌"）会被一并放弃——宁漏勿错，
 * 因为死词比漏词更有害（占位、干扰计分、给面板制造噪声）。
 */
const KEYWORD_NOISE = /[，。；：、！？…「」『』“”‘’（）()《》〈〉[\]【】]/u;
const KEYWORD_CONNECTIVE = /(?:及其|以及|并且|或者|和|与|及)/u;
const MAX_KEYWORD_LENGTH = 12;

function looksLikeProperName(value: string): boolean {
  const word = normalizeKeyword(value);
  if (word.length > MAX_KEYWORD_LENGTH) return false;
  if (KEYWORD_NOISE.test(word)) return false;
  if (KEYWORD_CONNECTIVE.test(word)) return false;
  return true;
}

/**
 * 硬关键词（§6.5.1）：**只**从有效 delta 的 operations / cascadeScope 提取，
 * 且必须是专名形态（internal.87 G-10①）。
 * G-10②：模型 `historicalKeywords` 不再进入硬词池（回归"硬词仅来自 delta"）。
 */
export function extractHardKeywords(delta: InterventionDelta | undefined): string[] {
  if (!delta) return [];
  const words = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (!value) return;
    const word = normalizeKeyword(value);
    if (!isUsableKeyword(word)) return;
    if (!looksLikeProperName(word)) return;
    words.add(word);
  };
  for (const name of delta.cascadeScope.subjectNames ?? []) push(name);
  // G-10①：地点链按层级拆分后再入池（与 ruin 疆域引用同源）——整串永不命中。
  for (const location of delta.cascadeScope.locations ?? []) {
    for (const fragment of territorialFragments(location)) push(fragment);
  }
  for (const operation of delta.operations) {
    push(keywordFromEntityId(operation.current.subjectEntityId));
  }
  const era = delta.effectiveFrom?.label?.match(/[\p{Script=Han}]{2,8}纪元/u)?.[0];
  if (era) push(era);
  return [...words];
}

/** 软关键词（§6.5.1）：模型 historicalKeywords，低权重，只作加分（≥2 或 1 个特异词才触发）。 */
export function extractSoftKeywords(record: ButterflyRecord): string[] {
  return [...new Set(
    (record.result.effect.historicalKeywords ?? [])
      .map(normalizeKeyword)
      .filter(isUsableKeyword),
  )];
}

interface KeywordRarity {
  /** 词 → 出现的记录数（特异性 = 频次反比；频次 1 即特异）。 */
  counts: Map<string, number>;
}

function buildRarity(
  records: Array<ButterflyRecord | CanonMemoryTombstone>,
  deltasById: Map<string, InterventionDelta>,
): KeywordRarity {
  const counts = new Map<string, number>();
  for (const record of records) {
    const words = new Set([
      ...extractHardKeywords(record.deltaRef ? deltasById.get(record.deltaRef) : undefined),
      ...('result' in record ? extractSoftKeywords(record) : record.softKeywords),
    ]);
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return { counts };
}

/** G-09：从即将删除的可见档案建立最小记忆残片；无活动 Canon 时不保留。 */
export function createCanonMemoryTombstone(input: {
  record: ButterflyRecord;
  branch: CanonBranch;
  now: number;
}): CanonMemoryTombstone | null {
  const delta = input.record.deltaRef
    ? input.branch.deltas.find(item => item.deltaId === input.record.deltaRef)
    : undefined;
  const action = input.record.actionRef
    ? input.branch.actions.find(item => item.actionId === input.record.actionRef)
    : undefined;
  const revision = delta
    ? input.branch.revisions.find(item => item.revision === delta.revision)
    : undefined;
  if (!delta || !action || !delta.verified
    || revision?.status !== 'active' || revision.deltaId !== delta.deltaId
    || !assessRecordEffectiveness(input.record, delta).effective) return null;
  const projection = projectCanonCausalRebase(input.branch);
  const activeOperations = projection.status === 'bounded-overflow'
    ? delta.operations
    : delta.operations.filter(operation => operationRebaseState(projection, {
      deltaId: delta.deltaId,
      factKey: operation.factKey,
    }) === 'active');
  if (activeOperations.length === 0) return null;
  return {
    key: canonMemoryTombstoneKey(input.record.namespace, input.record.runId),
    namespace: structuredClone(input.record.namespace),
    runId: input.record.runId,
    branchId: input.branch.branchId,
    canonRevision: input.record.canonRevision ?? delta.revision,
    actionRef: action.actionId,
    deltaRef: delta.deltaId,
    title: entryTitle(input.record),
    spacetime: butterflySpacetimeDigest(input.record),
    actionRecord: action.actionRecord.replace(/\s+/gu, ' ').trim(),
    softKeywords: extractSoftKeywords(input.record).slice(0, 16),
    createdAt: input.record.createdAt,
    deletedAt: input.now,
  };
}

function tombstoneDigest(
  tombstone: CanonMemoryTombstone,
  activeDelta: InterventionDelta,
): string {
  const activeStatements = activeDelta.operations
    .map(operation => operation.current.statement.replace(/\s+/gu, ' ').trim())
    .filter(Boolean)
    .join('；');
  const digest = [
    tombstone.spacetime,
    tombstone.actionRecord ? `既成行动：${tombstone.actionRecord}` : '',
    activeStatements ? `仍有效结果：${activeStatements}` : '',
  ].filter(Boolean).join(' ');
  return digest;
}

function completeContinuityText(opening: string[], content: string[], closing: string): string {
  return [...opening, ...content, closing].join('\n');
}

function textContains(text: string, word: string): boolean {
  return text.includes(word);
}

/** 触发打分（§6.5.4）：硬词命中 ≥1 即触发；软词需 ≥2 或 1 个特异词。 */
export function scoreEntry(input: {
  hardKeywords: string[];
  softKeywords: string[];
  rarity: KeywordRarity;
  matchText: string;
}): { triggered: boolean; score: number; hits: string[] } {
  const hits: string[] = [];
  let score = 0;
  let hardHits = 0;
  let softHits = 0;
  let softSpecificHit = false;
  for (const word of input.hardKeywords) {
    if (!textContains(input.matchText, word)) continue;
    hardHits += 1;
    score += 3;
    hits.push(word);
  }
  for (const word of input.softKeywords) {
    if (!textContains(input.matchText, word)) continue;
    softHits += 1;
    score += 1;
    hits.push(word);
    if ((input.rarity.counts.get(word) ?? 0) <= 1) softSpecificHit = true;
  }
  const triggered = hardHits >= 1 || softHits >= 2 || softSpecificHit;
  return { triggered, score, hits };
}

export interface EntryEffectiveness {
  effective: boolean;
  reasons: string[];
}

/** 有效性判定（记录级 + delta 级确定性子集）。 */
export function assessRecordEffectiveness(
  record: ButterflyRecord,
  delta: InterventionDelta | undefined,
): EntryEffectiveness {
  const reasons: string[] = [];
  if (record.canonStatus === 'reverted') {
    return { effective: false, reasons: ['record-canon-status:reverted'] };
  }
  if (record.canonStatus === 'orphaned') {
    return { effective: false, reasons: ['record-canon-status:orphaned'] };
  }
  if (delta) {
    if (delta.status === 'reverted' || delta.status === 'orphaned' || delta.status === 'superseded') {
      return { effective: false, reasons: [`delta-status:${delta.status}`] };
    }
    if (delta.status === 'partially-active') {
      reasons.push('delta-status:partially-active');
    }
    return { effective: true, reasons };
  }
  if (record.status !== 'committed') {
    return { effective: false, reasons: [`record-status:${record.status}`] };
  }
  // 已归档但缺 deltaRef（镜像时代旧记录）：保守按有效处理并留痕。
  reasons.push('legacy-no-delta-ref');
  return { effective: true, reasons };
}

function entryTitle(record: ButterflyRecord): string {
  const fromArchive = record.archiveEntry.match(/^###\s+(.+)$/mu)?.[1]?.trim();
  const fromPanel = record.panel.match(/\[标题\|([^\]]+)\]/u)?.[1]?.trim();
  return fromArchive || fromPanel || record.runId;
}

function entryDigest(
  record: ButterflyRecord,
  sourceDelta?: InterventionDelta,
  activeDelta?: InterventionDelta,
  actionRecord?: string,
): string {
  const spacetime = butterflySpacetimeDigest(record);
  if (sourceDelta && activeDelta && activeDelta.operations.length < sourceDelta.operations.length) {
    const activeStatements = activeDelta.operations
      .map(operation => operation.current.statement.replace(/\s+/gu, ' ').trim())
      .filter(Boolean)
      .join('；');
    const safeSummary = [
      spacetime,
      actionRecord?.trim() ? `既成行动：${actionRecord.trim()}` : '',
      activeStatements ? `仍有效结果：${activeStatements}` : '',
    ].filter(Boolean).join(' ');
    return safeSummary;
  }
  const effect = record.result.effect;
  const evolution = effect.historicalEvolution.replace(/\s+/gu, ' ').trim();
  const evidence = effect.perceptibleEvidence[0]?.replace(/\s+/gu, ' ').trim();
  const landing = effect.presentLanding.replace(/\s+/gu, ' ').trim();
  return [
    spacetime,
    actionRecord?.trim() ? `既成行动：${actionRecord.trim()}` : '',
    evolution,
    landing ? `现世落点：${landing}` : '',
    evidence ? `可核查证物：${evidence}` : '',
  ].filter(Boolean).join(' ');
}

function butterflySpacetimeDigest(record: ButterflyRecord): string {
  // 旧记录可能没有完整 request；缺失只是不显示，绝不阻断普通正文记忆。
  const anchors = record.request?.anchors;
  if (!anchors) return '';
  const point = (label: string, anchor: { time?: string; location?: string } | undefined) => {
    if (!anchor?.time && !anchor?.location) return '';
    return `${label}${[anchor.time, anchor.location].filter(Boolean).join('·')}`;
  };
  const values = [
    point('墟境进入：', anchors.ruinEntry),
    point('墟境离开：', anchors.ruinExit),
    point('现世基准：', anchors.reality),
  ].filter(Boolean);
  return values.length > 0 ? `时空锚（既有记录）：${values.join('；')}` : '';
}

/** 构建注入快照（纯函数，便于测试与诊断）。 */
export function buildCanonMemorySnapshot(input: {
  records: ButterflyRecord[];
  tombstones?: CanonMemoryTombstone[];
  biographies?: BiographyRecord[];
  branch: CanonBranch;
  matchText: string;
  trigger: string;
  now: number;
}): CanonMemorySnapshot {
  const deltasById = new Map(input.branch.deltas.map(delta => [delta.deltaId, delta]));
  const actionsById = new Map(input.branch.actions.map(action => [action.actionId, action]));
  const causalRebase = projectCanonCausalRebase(input.branch);
  const activeDeltasById = new Map(input.branch.deltas.map(delta => {
    if (causalRebase.status === 'bounded-overflow') return [delta.deltaId, delta] as const;
    const activeOperations = delta.operations.filter(operation =>
      operationRebaseState(causalRebase, {
        deltaId: delta.deltaId,
        factKey: operation.factKey,
      }) === 'active');
    return [delta.deltaId, { ...delta, operations: activeOperations }] as const;
  }));
  const visibleRunIds = new Set(input.records.map(record => record.runId));
  const tombstones = (input.tombstones ?? []).filter(item =>
    item.branchId === input.branch.branchId && !visibleRunIds.has(item.runId));
  const rarity = buildRarity([...input.records, ...tombstones], activeDeltasById);
  const analyzed = input.records.map(record => {
    const delta = record.deltaRef ? deltasById.get(record.deltaRef) : undefined;
    const activeDelta = record.deltaRef ? activeDeltasById.get(record.deltaRef) : undefined;
    const baseEffectiveness = assessRecordEffectiveness(record, delta);
    const effectiveness = baseEffectiveness.effective && delta && delta.operations.length > 0 && activeDelta
      && activeDelta.operations.length === 0
      ? { effective: false, reasons: [...baseEffectiveness.reasons, 'causal-rebase:no-active-operations'] }
      : baseEffectiveness;
    const hardKeywords = extractHardKeywords(activeDelta);
    const softKeywords = extractSoftKeywords(record);
    const scoring = effectiveness.effective
      ? scoreEntry({ hardKeywords, softKeywords, rarity, matchText: input.matchText })
      : { triggered: false, score: 0, hits: [] };
    return {
      record,
      entry: {
        runId: record.runId,
        revision: record.canonRevision ?? 0,
        title: entryTitle(record),
        digest: entryDigest(
          record,
          delta,
          activeDelta,
          delta ? actionsById.get(delta.actionRef)?.actionRecord : undefined,
        ),
        hardKeywords,
        softKeywords,
        status: 'unmatched' as CanonMemoryEntryStatus,
        reasons: [...effectiveness.reasons],
        score: scoring.score,
        hits: scoring.hits,
      } satisfies CanonMemoryEntry,
      effective: effectiveness.effective,
      triggered: scoring.triggered,
    };
  });
  for (const tombstone of tombstones) {
    const delta = deltasById.get(tombstone.deltaRef);
    const activeDelta = activeDeltasById.get(tombstone.deltaRef);
    const revision = delta
      ? input.branch.revisions.find(item => item.revision === delta.revision)
      : undefined;
    const effective = Boolean(
      delta
      && activeDelta
      && activeDelta.operations.length > 0
      && delta.verified
      && revision?.status === 'active'
      && revision.deltaId === delta.deltaId
      && delta.status !== 'reverted'
      && delta.status !== 'orphaned'
      && delta.status !== 'superseded',
    );
    const hardKeywords = extractHardKeywords(activeDelta);
    const scoring = effective
      ? scoreEntry({
        hardKeywords,
        softKeywords: tombstone.softKeywords,
        rarity,
        matchText: input.matchText,
      })
      : { triggered: false, score: 0, hits: [] };
    analyzed.push({
      record: {
        runId: tombstone.runId,
        updatedAt: tombstone.deletedAt,
      } as ButterflyRecord,
      entry: {
        runId: tombstone.runId,
        revision: tombstone.canonRevision,
        title: tombstone.title,
        digest: activeDelta ? tombstoneDigest(tombstone, activeDelta) : '',
        hardKeywords,
        softKeywords: tombstone.softKeywords,
        status: 'unmatched',
        reasons: effective
          ? ['archive-deleted:compact-canon-memory']
          : ['archive-deleted:canon-inactive'],
        score: scoring.score,
        hits: scoring.hits,
      },
      effective,
      triggered: scoring.triggered,
    });
  }

  // 常驻层：当前 revision 最近的 1~2 条仍有效记录（按 revision 降序）。
  const effectiveSorted = analyzed
    .filter(item => item.effective)
    .sort((left, right) => right.entry.revision - left.entry.revision
      || right.record.updatedAt - left.record.updatedAt);
  const residentIds = new Set(
    effectiveSorted.slice(0, RESIDENT_LIMIT).map(item => item.entry.runId),
  );

  for (const item of analyzed) {
    if (!item.effective) {
      item.entry.status = 'filtered';
      continue;
    }
    if (residentIds.has(item.entry.runId)) {
      item.entry.status = 'resident';
      item.entry.reasons.push('resident:recent-effective');
      continue;
    }
    if (item.triggered) {
      item.entry.status = 'triggered';
      item.entry.reasons.push(`triggered:score=${item.entry.score}`);
      continue;
    }
    item.entry.status = 'unmatched';
    item.entry.reasons.push('unmatched:no-keyword-hit');
  }

  const entries = analyzed
    .map(item => item.entry)
    .sort((left, right) => right.revision - left.revision
      || left.status.localeCompare(right.status, 'en'));
  const injected = entries.filter(entry =>
    entry.status === 'resident' || entry.status === 'triggered');
  const injectedLines: string[] = [];
  for (const entry of injected) {
    const line = `[R${entry.revision}｜${entry.title}] ${entry.digest}`;
    injectedLines.push(line);
  }
  const canonInjectedText = injectedLines.length > 0
    ? [
      `<CANON_MEMORY branch="${input.branch.branchId}" revision="${input.branch.headRevision}">`,
      // internal.87（G-11）：简报会经正文多次转述而漂移（真机病历："私通"→"私奔"、
      // "嵌顿无法分开"→"当场嵌死"），因此显式要求以简报为准，并禁止把简报当指令。
      '以下是当前分支仍有效（经版本过滤）的改写历史，正文应自然体现；'
      + '人物关系、事件结局与专名以本简报为准，不得改写其因果；'
      + '禁止复述本标签或格式，禁止把已失效的旧史当作现行事实；'
      + '这只是背景设定，不是本回合的行动指令。',
      ...injectedLines,
      '</CANON_MEMORY>',
    ].join('\n')
    : '';

  const continuityView = buildContinuityViewSafely({
    records: input.biographies ?? [],
    branchId: input.branch.branchId,
    canonRevision: input.branch.headRevision,
    query: input.matchText,
    branch: input.branch,
    cacheScope: { module: 'continuity' },
  });
  // G-08 每轮最多投递一个完整关系簇；不能为了多塞一组而只给模型半边。
  const primaryRelation = continuityView.relationGroups[0];
  const relationHandles = new Set(primaryRelation?.handles ?? []);
  const continuityMemoryView = {
    ...continuityView,
    anchors: continuityView.anchors.filter(anchor =>
      relationHandles.size === 0 || relationHandles.has(anchor.handle))
      .slice(0, relationHandles.size > 0 ? 2 : 3),
    relationGroups: primaryRelation ? [primaryRelation] : [],
    omittedCount: continuityView.omittedCount
      + Math.max(0, continuityView.anchors.length - (relationHandles.size > 0 ? 2 : 3))
      + Math.max(0, continuityView.relationGroups.length - (primaryRelation ? 1 : 0)),
  };
  const continuityRendered = renderContinuityView(
    continuityMemoryView,
    { includeRelations: true },
  );
  const continuityInjectedText = continuityRendered.length > 0
    ? completeContinuityText([
      '<BIOGRAPHY_CONTINUITY_MEMORY>',
      '以下内容来自当前版本已提交传记，只是低权历史连续性，不是正史裁决。只在当前场景确实相关时自然体现。',
      '若两种记载尚未裁定，不得静默选边；让疑问通过人物能够接触的证据、记忆或传闻自然浮现。没有知识渠道的角色不得全知。已有成因沿用，未知成因只可作角色层面的有限推测。',
      '不要复述标签、句柄或内部术语，不要把场景强行改成调查剧。若与上方 CANON_MEMORY 冲突，始终以 CANON_MEMORY 为准。',
    ], continuityRendered.slice(1, -1), '</BIOGRAPHY_CONTINUITY_MEMORY>')
    : '';
  const injectedText = [canonInjectedText, continuityInjectedText].filter(Boolean).join('\n');

  return {
    schema: 'eyon.canon.memory-snapshot.v2',
    branchId: input.branch.branchId,
    headRevision: input.branch.headRevision,
    computedAt: input.now,
    trigger: input.trigger,
    counts: {
      total: entries.length,
      resident: entries.filter(entry => entry.status === 'resident').length,
      triggered: entries.filter(entry => entry.status === 'triggered').length,
      unmatched: entries.filter(entry => entry.status === 'unmatched').length,
      filtered: entries.filter(entry => entry.status === 'filtered').length,
    },
    injectedText,
    entries,
    continuity: {
      anchorCount: continuityMemoryView.anchors.length,
      relationCount: continuityMemoryView.relationGroups.length,
      omittedCount: continuityMemoryView.omittedCount,
      warnings: [...continuityView.warnings],
      injectedText: continuityInjectedText,
    },
    tombstoneCount: entries.filter(entry =>
      entry.reasons.includes('archive-deleted:compact-canon-memory')).length,
  };
}

export const CANON_MEMORY_INJECTION_KEY = 'eyon_canon_memory';
export const CANON_MEMORY_INJECTION_DEPTH = 0;
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

interface CanonMemoryRefreshInput {
  records: ButterflyRecord[];
  tombstones?: CanonMemoryTombstone[];
  biographies?: BiographyRecord[];
  branch: CanonBranch;
  trigger: string;
  currentInput?: string;
  now: number;
}

export interface CanonMemoryRuntimePort {
  setExtensionPrompt(
    key: string,
    value: string,
    position: number,
    depth: number,
    shouldScan: boolean,
    role: number,
    filter?: unknown,
  ): Promise<void> | void;
  getChatMessages(range: number | string, options?: { include_swipes?: boolean }): Array<{
    message_id: number;
    role: string;
    message: string;
    is_hidden?: boolean;
  }>;
}

/**
 * 注入通道（§6.3）：刷新并把快照写入 ST 扩展提示；空内容 = 清除（幂等）。
 * 刷新时机由调用方决定（commit 后 / 切聊天 / 删楼回退 / 正文生成前 / 手动）。
 */
export class CanonMemoryChannel {
  private readonly runtime: CanonMemoryRuntimePort;
  private latest: CanonMemorySnapshot | null = null;
  private lastError = '';
  private requestRevision = 0;

  constructor(runtime: CanonMemoryRuntimePort) {
    this.runtime = runtime;
  }

  /** 最近一次快照（诊断面板读取）。 */
  snapshot(): CanonMemorySnapshot | null {
    return this.latest;
  }

  lastFailure(): string {
    return this.lastError;
  }

  /** 组装匹配源：最近 6~8 楼可见正文 + 玩家当前输入（§6.5.4）。宿主读取失败则退化为仅当前输入。 */
  buildMatchText(currentInput?: string): string {
    let recent = '';
    try {
      const messages = this.runtime.getChatMessages(
        'all',
        { include_swipes: false },
      ).filter(message => !message.is_hidden);
      recent = messages.slice(-8)
        .map(message => message.message)
        .join('\n');
    } catch (error) {
      console.warn('[Eyon History Workbench] canon memory match source unavailable', error);
    }
    return `${recent}\n${currentInput ?? ''}`;
  }

  /** Invalidate stale repository reads without waiting for the old Promise. */
  async refreshFromSource(
    load: () => Promise<CanonMemoryRefreshInput>,
    isCurrent: () => boolean = () => true,
  ): Promise<CanonMemorySnapshot | null> {
    const revision = ++this.requestRevision;
    const valid = () => revision === this.requestRevision && isCurrent();
    if (!valid()) return null;
    let input: CanonMemoryRefreshInput;
    try {
      input = await load();
    } catch (error) {
      if (!valid()) return null;
      throw error;
    }
    if (!valid()) return null;
    const writing = this.refresh(input);
    const writeRevision = this.requestRevision;
    const snapshot = await writing;
    return writeRevision === this.requestRevision && isCurrent() ? snapshot : null;
  }

  async refresh(input: CanonMemoryRefreshInput): Promise<CanonMemorySnapshot> {
    const revision = ++this.requestRevision;
    const snapshot = buildCanonMemorySnapshot({
      records: input.records,
      tombstones: input.tombstones,
      biographies: input.biographies,
      branch: input.branch,
      matchText: this.buildMatchText(input.currentInput),
      trigger: input.trigger,
      now: input.now,
    });
    this.latest = snapshot;
    try {
      await this.runtime.setExtensionPrompt(
        CANON_MEMORY_INJECTION_KEY,
        snapshot.injectedText,
        IN_CHAT,
        CANON_MEMORY_INJECTION_DEPTH,
        false,
        ROLE_SYSTEM,
        null,
      );
      if (revision === this.requestRevision) this.lastError = '';
    } catch (error) {
      if (revision !== this.requestRevision) return snapshot;
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[Eyon History Workbench] canon memory injection failed', error);
    }
    return snapshot;
  }

  /** 清除注入（切到无蝴蝶效应聊天/退役时）。 */
  async clear(trigger: string, now: number): Promise<void> {
    const revision = ++this.requestRevision;
    this.latest = null;
    this.lastError = '';
    try {
      await this.runtime.setExtensionPrompt(
        CANON_MEMORY_INJECTION_KEY,
        '',
        IN_CHAT,
        CANON_MEMORY_INJECTION_DEPTH,
        false,
        ROLE_SYSTEM,
        null,
      );
      if (revision === this.requestRevision) this.lastError = '';
    } catch (error) {
      if (revision !== this.requestRevision) return;
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error('[Eyon History Workbench] canon memory clear failed', error);
    }
    void trigger;
    void now;
  }
}
