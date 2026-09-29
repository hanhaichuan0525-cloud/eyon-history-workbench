import type { RuntimeWorldbookSource } from '../retrieval/contracts.ts';
import type { RuinTaskScale } from '../schemas/ruinTask.ts';

export interface RuinTaskEconomyInput {
  sources: RuntimeWorldbookSource[];
  location: string;
  mode: '个人' | '团队';
  difficulty: 'D' | 'C' | 'B' | 'A' | 'S';
  scale: RuinTaskScale;
}

export interface RuinTaskEconomyResolution {
  amount: number;
  currencyName: string;
  reward: string;
  polity: string;
  guideSourceId: string;
}

interface CurrencyMapping {
  polity: string;
  aliases: string[];
  currencyName: string;
}

interface RewardRange {
  min: number;
  max: number;
}

const SCALE_POSITION: Record<RuinTaskScale, number> = {
  '即时互动': 0.25,
  '短程目标': 0.5,
  '阶段任务': 0.75,
};

const GENERIC_POLITY_WORDS = new Set([
  '帝国', '王国', '公国', '联盟', '联邦', '圣国', '法环', '王庭', '本地', '当地',
]);

/**
 * 从当前角色已绑定的世界书中解析币制与委托价格。
 *
 * 世界书是唯一数值真源；脚本只识别「势力→货币」与「难度→范围」的
 * 结构，不保存任何币名或价格表。无法唯一确定时明确拒绝，避免「当地通货」
 * 这类模糊占位进入已封缄任务。
 */
export function resolveRuinTaskEconomy(
  input: RuinTaskEconomyInput,
): RuinTaskEconomyResolution {
  const guide = selectEconomyGuide(input.sources);
  if (!guide) {
    throw new Error('当前角色卡世界书缺少可解析的经济价格指南，无法确定任务货币');
  }
  const mappings = parseCurrencyMappings(guide.content);
  if (mappings.length === 0) {
    throw new Error('经济价格指南未提供可解析的势力货币对照');
  }
  const mapping = resolveCurrencyMapping(input.location, mappings, input.sources);
  if (!mapping) {
    throw new Error(
      `无法从当前角色卡世界书为「${input.location || '未知地点'}」唯一确定实体货币；请在经济指南或地点条目中补明所属势力`,
    );
  }
  const range = parseRewardRange(guide.content, input.mode, input.difficulty);
  if (!range) {
    throw new Error(`经济价格指南未提供${input.mode}${input.difficulty}级的委托奖励范围`);
  }
  const amount = Math.floor(range.min + (range.max - range.min) * SCALE_POSITION[input.scale]);
  return {
    amount,
    currencyName: mapping.currencyName,
    reward: `${amount}Z ${mapping.currencyName}`,
    polity: mapping.polity,
    guideSourceId: guide.sourceId,
  };
}

function selectEconomyGuide(sources: RuntimeWorldbookSource[]): RuntimeWorldbookSource | null {
  const candidates = sources.filter(source =>
    /[各诸]势力货币对照/u.test(source.content)
    && /冒险委托奖励\s*[:：]/u.test(source.content)
  );
  return candidates.sort((left, right) =>
    worldbookPriority(right) - worldbookPriority(left)
    || left.sourceId.localeCompare(right.sourceId, 'zh-CN')
  )[0] ?? null;
}

function worldbookPriority(source: RuntimeWorldbookSource): number {
  const scopes = source.worldbook.bindingScopes;
  if (scopes.includes('character-primary')) return 4;
  if (scopes.includes('character-additional')) return 3;
  if (scopes.includes('chat')) return 2;
  return 1;
}

function parseCurrencyMappings(content: string): CurrencyMapping[] {
  const marker = content.search(/[各诸]势力货币对照[^\n]*\n/u);
  const section = marker >= 0 ? content.slice(marker).split(/\n\s*\n/u, 1)[0]! : content;
  const mappings: CurrencyMapping[] = [];
  for (const match of section.matchAll(/^\s*-\s*([^:\uff1a\n]+)\s*[:：]\s*([^\n]+?)\s*$/gmu)) {
    const aliases = match[1]!.split(/[\/／、|｜]/u).map(value => value.trim()).filter(Boolean);
    const currencyName = match[2]!.trim().replace(/[`「」“”]/gu, '');
    if (aliases.length === 0 || !isConcreteCurrency(currencyName)) continue;
    mappings.push({ polity: aliases[0]!, aliases, currencyName });
  }
  return mappings;
}

function isConcreteCurrency(value: string): boolean {
  return value.length >= 2
    && value.length <= 24
    && !/(当地|各势力|通货|流通|未知|待定|见情况)/u.test(value);
}

function resolveCurrencyMapping(
  location: string,
  mappings: CurrencyMapping[],
  sources: RuntimeWorldbookSource[],
): CurrencyMapping | null {
  const normalizedLocation = normalizeSearchText(location);
  const locationTokens = location
    .split(/[\/／>＞→|｜\-—·,，]/u)
    .map(normalizeSearchText)
    .filter(token => token.length >= 2);
  const scored = mappings.map(mapping => ({
    mapping,
    score: Math.max(
      ...mapping.aliases.map(alias => directLocationScore(normalizedLocation, alias)),
      corpusLocationScore(locationTokens, mapping.aliases, sources),
    ),
  })).filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.mapping.polity.length - left.mapping.polity.length);
  if (scored.length === 0) return null;
  if (scored[1] && scored[1].score === scored[0]!.score) return null;
  return scored[0]!.mapping;
}

function directLocationScore(location: string, aliasValue: string): number {
  const alias = normalizeSearchText(aliasValue);
  if (!alias) return 0;
  if (location.includes(alias)) return 10_000 + alias.length;
  for (let length = alias.length - 1; length >= 3; length -= 1) {
    const tail = alias.slice(-length);
    if (!GENERIC_POLITY_WORDS.has(tail) && location.includes(tail)) return 5_000 + length;
  }
  return 0;
}

function corpusLocationScore(
  locationTokens: string[],
  aliases: string[],
  sources: RuntimeWorldbookSource[],
): number {
  let best = 0;
  for (const source of sources) {
    const content = normalizeSearchText(source.content);
    const placeLength = Math.max(0, ...locationTokens.filter(token => content.includes(token)).map(token => token.length));
    if (placeLength === 0) continue;
    const aliasLength = Math.max(0, ...aliases.map(normalizeSearchText).filter(alias => content.includes(alias)).map(alias => alias.length));
    if (aliasLength === 0) continue;
    best = Math.max(best, 1_000 + placeLength * 10 + aliasLength + worldbookPriority(source));
  }
  return best;
}

function parseRewardRange(
  content: string,
  mode: '个人' | '团队',
  difficulty: 'D' | 'C' | 'B' | 'A' | 'S',
): RewardRange | null {
  const line = content.match(/冒险委托奖励\s*[:：]\s*([^\n]+)/u)?.[1];
  if (!line) return null;
  const label = mode === '个人' ? '(?:单人|个人)' : '(?:团队|小队|多人)';
  const segment = line.match(new RegExp(`${label}([\\s\\S]*?)(?=(?:;|；)\\s*(?:单人|个人|团队|小队|多人)|$)`, 'u'))?.[1];
  if (!segment) return null;
  const rawRange = segment.match(new RegExp(`(?:^|\\|)\\s*${difficulty}级?\\s*[:：]\\s*([^|;；]+)`, 'iu'))?.[1];
  if (!rawRange) return null;
  const values = rawRange.split(/[-–—~～至]/u).map(parseWorldNumber).filter((value): value is number => value !== null);
  if (values.length < 2) return null;
  return { min: Math.min(values[0]!, values[1]!), max: Math.max(values[0]!, values[1]!) };
}

function parseWorldNumber(raw: string): number | null {
  const normalized = raw.replace(/[,，\s]/gu, '').trim();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([万亿])?/u);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const multiplier = match[2] === '亿' ? 100_000_000 : match[2] === '万' ? 10_000 : 1;
  return Math.floor(base * multiplier);
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
