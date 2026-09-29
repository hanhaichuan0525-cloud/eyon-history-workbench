import type { BiographyContextBundle, ContextSource } from '../core/context.ts';
import { loadRuntimeWorldbookCorpus, type RuntimeContextSourceProvider } from './contracts.ts';

const ENTRY_CONTENT_LIMIT = 12000;
const PASSAGE_EVIDENCE_LIMIT = 8;

export type BiographyEvidenceResolver = (
  names: string[],
  sourceRefs: string[],
  context: BiographyContextBundle,
  timeHints?: string[],
) => Promise<ContextSource[]>;

/**
 * 为每次传记任务建立一个惰性的身份目录缓存。
 *
 * 首轮 Retrieval 仍决定本任务的历史事实集；这里不会按年代扩展史料，只会在模型
 * 实际准备借用一个具名实体时，从“已开启且未排除”的世界书/MVU 人物目录中做
 * 精确名称补召回。这样既不把整本世界书塞进提示词，也不会让漏选的人物条目失效。
 */
export function createBiographyEvidenceResolver(
  provider: RuntimeContextSourceProvider,
): BiographyEvidenceResolver {
  const catalogByContext = new WeakMap<BiographyContextBundle, Promise<ContextSource[]>>();

  return async (names, sourceRefs, context) => {
    let catalogPromise = catalogByContext.get(context);
    if (!catalogPromise) {
      catalogPromise = loadIdentityCatalog(provider);
      catalogByContext.set(context, catalogPromise);
    }
    const catalog = await catalogPromise;
    return selectBiographyEvidence(names, sourceRefs, context.sourceIndex, catalog);
  };
}

export function selectBiographyEvidence(
  names: readonly string[],
  sourceRefs: readonly string[],
  frozenSources: readonly ContextSource[],
  identityCatalog: readonly ContextSource[],
): ContextSource[] {
  const all = mergeSources(frozenSources, identityCatalog);
  const byId = new Map(all.map(source => [source.sourceId, source]));
  const picked: ContextSource[] = [];
  const seen = new Set<string>();
  const pick = (source: ContextSource | undefined): void => {
    if (!source || seen.has(source.sourceId) || picked.length >= PASSAGE_EVIDENCE_LIMIT) return;
    seen.add(source.sourceId);
    picked.push(source);
  };

  // 规划阶段冻结的直接引用始终优先，保持历史事实集不漂移。
  for (const sourceRef of sourceRefs) pick(byId.get(sourceRef));

  // 具名实体只做标题/关键词/显式别名匹配，不用正文碎词做宽泛命中。
  for (const rawName of names) {
    if (picked.length >= PASSAGE_EVIDENCE_LIMIT) break;
    const name = rawName.trim();
    if (!name) continue;
    const matches = all
      .map(source => ({ source, rank: evidenceNameRank(name, source) }))
      .filter((item): item is { source: ContextSource; rank: number } => item.rank !== null)
      .sort((left, right) => left.rank - right.rank
        || right.source.authority - left.source.authority
        || left.source.sourceId.localeCompare(right.source.sourceId, 'zh-CN'));
    for (const match of matches) pick(match.source);
  }

  return picked;
}

async function loadIdentityCatalog(
  provider: RuntimeContextSourceProvider,
): Promise<ContextSource[]> {
  const [worldbookCorpus, characters] = await Promise.all([
    loadRuntimeWorldbookCorpus(provider),
    provider.getCharacterSources(),
  ]);
  return mergeSources(
    worldbookCorpus.sources.map(source => ({
      sourceId: source.sourceId,
      sourceType: 'worldbook' as const,
      title: source.title.trim() || source.sourceId,
      content: source.content.trim().slice(0, ENTRY_CONTENT_LIMIT),
      authority: 100,
      strategyType: source.strategyType,
      keywords: source.keywords,
    })),
    characters.map(source => ({
      sourceId: source.sourceId,
      sourceType: 'mvu' as const,
      title: source.title.trim() || source.sourceId,
      content: source.content.trim().slice(0, ENTRY_CONTENT_LIMIT),
      authority: 95,
    })),
  );
}

function evidenceNameRank(name: string, source: ContextSource): number | null {
  const needle = normalizeEvidenceText(name);
  if (!needle) return null;
  const title = normalizeEvidenceText(source.title);
  if (needle === title) return 0;
  if (extractExplicitTitleNames(source.title).map(normalizeEvidenceText).includes(needle)) return 1;
  if (needle.length >= 4 && title.length >= 4 && (title.includes(needle) || needle.includes(title))) {
    return 2;
  }
  const explicitNames = [
    ...(source.keywords ?? []),
    ...extractExplicitAliases(source.content),
  ].map(normalizeEvidenceText).filter(Boolean);
  if (explicitNames.includes(needle)) return 3;
  return null;
}

function extractExplicitTitleNames(title: string): string[] {
  const genericLabels = new Set([
    'dlc', '角色', '人物', '地点', '组织', '势力', '历史', '事件', '世界书', '设定', '主设定',
  ]);
  const bracketed = [...title.matchAll(/[\[【]([^\]】]{1,40})[\]】]/gu)]
    .map(match => (match[1] ?? '').trim())
    .filter(value => value.length >= 2 && !genericLabels.has(value.toLocaleLowerCase('zh-CN')));
  const tail = stripLeadingBracketLabels(title)
    .split(/[（(|｜:：]/u, 1)[0]
    ?.trim();
  return [...new Set([
    ...bracketed,
    ...(tail && tail.length >= 2 && tail.length <= 40 ? [tail] : []),
  ])];
}

function stripLeadingBracketLabels(value: string): string {
  let result = value.trimStart();
  while (/^[\[【][^\]】]+[\]】]/u.test(result)) {
    result = result.replace(/^[\[【][^\]】]+[\]】]/u, '').trimStart();
  }
  return result;
}

function extractExplicitAliases(content: string): string[] {
  const aliases: string[] = [];
  for (const match of content.matchAll(/(?:^|[\n,{])\s*["']?(?:别名|又称|旧称|aliases?)["']?\s*[:：]\s*([^\n}\]]{1,120})/giu)) {
    const value = match[1] ?? '';
    aliases.push(...value
      .replace(/["'\[\]]/gu, '')
      .split(/[、,，/|；;]/gu)
      .map(item => item.trim())
      .filter(item => item.length >= 2 && item.length <= 40));
  }
  return aliases;
}

function mergeSources(
  ...groups: ReadonlyArray<readonly ContextSource[]>
): ContextSource[] {
  const merged = new Map<string, ContextSource>();
  for (const source of groups.flat()) {
    if (!source.sourceId.trim() || !source.content.trim()) continue;
    const current = merged.get(source.sourceId);
    if (!current || source.content.length > current.content.length) {
      merged.set(source.sourceId, source);
    }
  }
  return [...merged.values()];
}

function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/[\s·・._—–-]+/gu, '').toLocaleLowerCase('zh-CN');
}
