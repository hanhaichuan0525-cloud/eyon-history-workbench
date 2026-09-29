import type {
  EvidenceAuthorityAssessment,
  EvidenceClaim,
  SourceSnapshot,
  WorldbookRetrievalMetadata,
  WorldKnowledgeCatalog,
} from './contracts.ts';
import { buildWorldKnowledgeCatalog } from './catalog.ts';

export interface IndexedRetrievalSource {
  snapshot: SourceSnapshot;
  normalizedTitle: string;
  searchTerms: string[];
  strongSearchTerms: string[];
}

export interface RetrievalIndex {
  sources: IndexedRetrievalSource[];
  entities: Map<string, Set<string>>;
  claims: EvidenceClaim[];
  catalog: WorldKnowledgeCatalog;
  buildDurationMs: number;
}

const RELATION_PATTERNS: Array<{
  pattern: RegExp;
  predicate: string;
}> = [
  { pattern: /^(.{2,30}?)(?:属于|隶属于|归属于|效忠于)(.{2,30})$/u, predicate: 'belongs_to' },
  { pattern: /^(.{2,24}?)的父亲是(.{2,24})$/u, predicate: 'father' },
  { pattern: /^(.{2,24}?)的母亲是(.{2,24})$/u, predicate: 'mother' },
  { pattern: /^(.{2,24}?)的配偶是(.{2,24})$/u, predicate: 'spouse' },
  { pattern: /^(.{2,24}?)的(?:儿子|女儿|子女)是(.{2,24})$/u, predicate: 'child' },
  { pattern: /^(.{2,24}?)的(?:兄弟|姐妹)是(.{2,24})$/u, predicate: 'sibling' },
];

const FIELD_RELATIONS: Readonly<Record<string, string>> = {
  所属: 'belongs_to',
  所属势力: 'belongs_to',
  所属组织: 'belongs_to',
  归属: 'belongs_to',
  父亲: 'father',
  母亲: 'mother',
  配偶: 'spouse',
  儿子: 'child',
  女儿: 'child',
  子女: 'child',
  兄弟: 'sibling',
  姐妹: 'sibling',
};

/** 只有明确字段才建立时间原点；自由叙事仍作为自然语言证据，不做全文猜测。 */
const FIELD_TEMPORAL_FACTS: Readonly<Record<string, string>> = {
  出生时间: 'birth_time',
  出生年份: 'birth_time',
  生年: 'birth_time',
  建立时间: 'established_time',
  成立时间: 'established_time',
  创立时间: 'established_time',
  开业时间: 'established_time',
  建造时间: 'created_time',
  建成年份: 'created_time',
  落成时间: 'created_time',
  制造时间: 'created_time',
  铸造时间: 'created_time',
};

export function buildRetrievalIndex(snapshots: SourceSnapshot[]): RetrievalIndex {
  const started = performance.now();
  const entities = new Map<string, Set<string>>();
  const rawClaims: EvidenceClaim[] = [];
  const sources = [...new Map(snapshots.map(snapshot => [
    snapshot.snapshotId,
    snapshot,
  ])).values()]
    .sort((left, right) => left.snapshotId.localeCompare(right.snapshotId))
    .map(snapshot => {
      const terms = sourceTerms(snapshot);
      for (const term of terms.entities) addEntity(entities, term, snapshot.snapshotId);
      const claims = extractClaims(snapshot);
      for (const claim of claims) {
        addEntity(entities, claim.subject, snapshot.snapshotId);
        addEntity(entities, claim.object, snapshot.snapshotId);
      }
      rawClaims.push(...claims);
      return {
        snapshot,
        normalizedTitle: normalizeRetrievalText(snapshot.title),
        searchTerms: [...new Set([...terms.search, ...claims.flatMap(claim => [
          normalizeRetrievalText(claim.subject),
          normalizeRetrievalText(claim.object),
        ])])].filter(isSpecificRetrievalTerm),
        strongSearchTerms: [...new Set([...terms.strong, ...claims.flatMap(claim => [
          normalizeRetrievalText(claim.subject),
          normalizeRetrievalText(claim.object),
        ])])].filter(isSpecificRetrievalTerm),
      };
    });
  const claims = markConflicts(rawClaims);
  return {
    sources,
    entities,
    claims,
    catalog: buildWorldKnowledgeCatalog(sources.map(source => source.snapshot), claims),
    buildDurationMs: performance.now() - started,
  };
}

export function normalizeRetrievalText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function sourceTerms(snapshot: SourceSnapshot): {
  entities: string[];
  search: string[];
  strong: string[];
} {
  const headingTerms = extractHeadingTerms(snapshot.content);
  const entities = [
    snapshot.title,
    cleanTitleEntity(snapshot.title),
    ...extractAliases(snapshot.content),
    ...headingTerms.entities,
  ];
  const search = [
    ...entities,
    ...headingTerms.search,
    ...extractTemporalTerms(snapshot.content),
  ];
  const strong = [...entities];
  if (isWorldbookMetadata(snapshot.metadata)) {
    const indexedKeys = [
      ...snapshot.metadata.strategy.primaryKeys,
      ...snapshot.metadata.strategy.secondary.keys,
    ];
    search.push(...indexedKeys);
    strong.push(...indexedKeys.filter(key => !isTemporalRetrievalTerm(key)));
  }
  const structured = parseRecord(snapshot.content);
  if (structured) collectStructuredTerms(structured, entities, search, strong);
  return {
    entities: entities.map(normalizeRetrievalText).filter(term => term.length >= 2),
    search: search.map(normalizeRetrievalText).filter(term => term.length >= 2),
    strong: strong.map(normalizeRetrievalText).filter(term => term.length >= 2),
  };
}

const GENERIC_RETRIEVAL_TERMS = new Set([
  '世界', '当前', '历史', '资料', '设定', '内容', '规则', '系统',
  '人物', '组织', '势力', '地点', '时期', '时代', '纪元', '神明',
  '大陆', '全境', '其他', '探索', '墟境', '墟境探索', '关系', '归属',
]);

function isSpecificRetrievalTerm(term: string): boolean {
  return term.length >= 2 && !GENERIC_RETRIEVAL_TERMS.has(term);
}

function isTemporalRetrievalTerm(term: string): boolean {
  return /纪元(?:\d{1,6}年)?|^\d{1,6}年$/u.test(normalizeRetrievalText(term));
}

function extractClaims(snapshot: SourceSnapshot): EvidenceClaim[] {
  const claims: EvidenceClaim[] = [];
  const structured = parseRecord(snapshot.content);
  if (!structured) {
    const sentences = snapshot.content.split(/[。；;\n，,]/u).map(value => value.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (/(?:不属于|不隶属于|不归属于|并非.{0,8}(?:所属|归属))/u.test(sentence)) continue;
      const field = sentence.match(/^(?:[-*]\s*)?([^:：]{2,10})[:：](.{2,30})$/u);
      const fieldPredicate = field ? FIELD_RELATIONS[field[1].trim()] : undefined;
      const temporalPredicate = field ? FIELD_TEMPORAL_FACTS[field[1].trim()] : undefined;
      if (field && temporalPredicate && extractTemporalTerms(field[2]).length > 0) {
        claims.push(makeClaim(
          snapshot,
          claims.length,
          cleanTitleEntity(snapshot.title),
          temporalPredicate,
          field[2],
          sentence,
        ));
        continue;
      }
      if (field && fieldPredicate) {
        claims.push(makeClaim(snapshot, claims.length, snapshot.title, fieldPredicate, field[2], sentence));
        continue;
      }
      for (const relation of RELATION_PATTERNS) {
        const match = sentence.match(relation.pattern);
        if (!match) continue;
        if (!isRelationEntity(match[1]) || !isRelationEntity(match[2])) continue;
        claims.push(makeClaim(snapshot, claims.length, match[1], relation.predicate, match[2], sentence));
        break;
      }
    }
  }
  claims.push(...extractGenealogyClaims(snapshot, claims.length));
  return claims;
}

function makeClaim(
  snapshot: SourceSnapshot,
  ordinal: number,
  subject: string,
  predicate: string,
  object: string,
  evidenceText: string,
): EvidenceClaim {
  return {
    claimId: `claim:${snapshot.snapshotId}:${ordinal}`,
    subject: subject.trim(),
    predicate,
    object: object.trim(),
    temporalScope: extractTemporalTerms(evidenceText)[0] ?? null,
    epistemicStatus: 'explicit',
    authority: authorityFor(snapshot.sourceType),
    sourceSnapshotIds: [snapshot.snapshotId],
    sourcePassageIds: [],
    conflictGroupId: null,
  };
}

function extractGenealogyClaims(snapshot: SourceSnapshot, offset: number): EvidenceClaim[] {
  const record = parseRecord(snapshot.content);
  if (!record || !Array.isArray(record.nodes) || !Array.isArray(record.edges)) return [];
  const names = new Map<string, string>();
  for (const node of record.nodes) {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.name !== 'string') continue;
    names.set(node.id, node.name);
  }
  return record.edges.flatMap((edge, index) => {
    if (!isRecord(edge) || typeof edge.from !== 'string' || typeof edge.to !== 'string') return [];
    const subject = names.get(edge.from);
    const object = names.get(edge.to);
    if (!subject || !object) return [];
    const rawRelation = typeof edge.relationType === 'string'
      ? edge.relationType
      : typeof edge.relation === 'string'
      ? edge.relation
      : typeof edge.label === 'string'
      ? edge.label
      : 'relationship';
    const relation = normalizeGenealogyPredicate(rawRelation);
    return [makeClaim(snapshot, offset + index, subject, relation, object, '')];
  });
}

function markConflicts(claims: EvidenceClaim[]): EvidenceClaim[] {
  const groups = new Map<string, EvidenceClaim[]>();
  for (const claim of claims) {
    const key = [claim.subject, claim.predicate, claim.temporalScope ?? ''].map(normalizeRetrievalText).join('|');
    const group = groups.get(key) ?? [];
    group.push(claim);
    groups.set(key, group);
  }
  const conflicted = new Set<string>();
  for (const [key, group] of groups) {
    const objects = new Set(group.map(claim => normalizeRetrievalText(claim.object)));
    if (objects.size > 1) for (const claim of group) conflicted.add(`${key}|${claim.claimId}`);
  }
  return claims.map(claim => {
    const key = [claim.subject, claim.predicate, claim.temporalScope ?? ''].map(normalizeRetrievalText).join('|');
    return conflicted.has(`${key}|${claim.claimId}`)
      ? { ...claim, epistemicStatus: 'conflicted', conflictGroupId: `conflict:${key}` }
      : claim;
  });
}

function authorityFor(sourceType: SourceSnapshot['sourceType']): EvidenceAuthorityAssessment[] {
  if (sourceType === 'worldbook') return [{ dimension: 'setting', tier: 'primary' }, { dimension: 'relationship', tier: 'primary' }];
  if (sourceType === 'mvu') return [{ dimension: 'current-state', tier: 'primary' }, { dimension: 'identity', tier: 'supporting' }];
  if (sourceType === 'genealogy') return [{ dimension: 'relationship', tier: 'primary' }];
  if (sourceType === 'butterfly') return [{ dimension: 'causality', tier: 'primary' }];
  return [{ dimension: 'identity', tier: 'supporting' }, { dimension: 'chronology', tier: 'supporting' }];
}

function addEntity(index: Map<string, Set<string>>, value: string, snapshotId: string): void {
  const normalized = normalizeRetrievalText(value);
  if (normalized.length < 2) return;
  const ids = index.get(normalized) ?? new Set<string>();
  ids.add(snapshotId);
  index.set(normalized, ids);
}

function extractAliases(content: string): string[] {
  return [...content.matchAll(/(?:别名|又称|旧称)[:：]([^。；;\n]+)/gu)]
    .flatMap(match => match[1].split(/[、，,\/]/u))
    .map(value => value.trim())
    .filter(Boolean);
}

const HEADING_FIELD_STOPWORDS = new Set([
  '基本信息',
  '基本资料',
  '姓名',
  '名称',
  '性别',
  '种族',
  '年龄',
  '身份',
  '外貌',
  '性格',
  '背景',
  '简介',
  '能力',
  '关系',
  '所属',
  '时间',
  '地点',
  '内容',
  '备注',
]);

/**
 * 世界书大量使用“领域・实体（别称）：”而非 JSON。这里只把标题整体加入
 * 搜索词，并把中点后的专名、括号内别称加入实体表，避免把普通字段误当人物。
 */
function extractHeadingTerms(content: string): { entities: string[]; search: string[] } {
  const entities: string[] = [];
  const search: string[] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:#{1,6}\s*)?([^:：<>\[\]{}]{2,60})[:：]\s*(?:.*)?$/u);
    if (!match) continue;
    const label = match[1].trim().replace(/^[-*]\s*/u, '');
    if (!label || HEADING_FIELD_STOPWORDS.has(label)) continue;
    search.push(label);
    const middleNames = label.split(/[・·]/u).slice(1);
    // 括号别名校验（与 catalog 同款结构字段净化）：括号内「类别/品质」标注
    // 不是别名——含斜杠（「物品/史诗」）或去空格后 ≤2 字无分隔的单字段
    // （「(史诗)」「(稀有)」）都跳过，防止「史诗」变成实体/搜索词，
    // 导致 rankDirect 实体资格误判强词、matchedEntities 误收、query 包含匹配污染。
    const aliases = [...label.matchAll(/[（(]([^）)]+)[）)]/gu)].flatMap(alias => {
      const inner = alias[1].trim();
      if (inner.includes('/') || inner.includes('／')) return [];
      if (inner.replace(/\s+/gu, '').length <= 2 && !/[，,、]/u.test(inner)) return [];
      return inner.split(/[、，,/]/u);
    });
    for (const raw of [...middleNames, ...aliases]) {
      const name = raw.replace(/[（(].*$/u, '').trim();
      if (name.length < 2 || name.length > 20 || HEADING_FIELD_STOPWORDS.has(name)) continue;
      entities.push(name);
      search.push(name);
    }
  }
  return { entities, search };
}

function isRelationEntity(value: string): boolean {
  const term = value.trim();
  if (term.length < 2 || term.length > 30) return false;
  if (/[：:；;，,。!?！？]/u.test(term)) return false;
  return !/(?:在.{0,6}眼里|甚至|相比|比.{0,8}(?:更|还|也)|认为|觉得|看来|因为|所以|如果|虽然|但是|并且)/u.test(term);
}

function cleanTitleEntity(title: string): string {
  return title
    .replace(/^[【\[].{1,12}?[】\]]/u, '')
    .replace(/^(?:人物|组织|势力|地点|家族)[:：]/u, '')
    .trim();
}

function extractTemporalTerms(content: string): string[] {
  return content.match(/[\p{Script=Han}]{2,8}纪元(?:\d{1,4}年)?|\d{1,4}年/gu) ?? [];
}

function collectStructuredTerms(
  value: unknown,
  entities: string[],
  search: string[],
  strong: string[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredTerms(item, entities, search, strong);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      if (/^(?:name|title|focusCharacterName)$/u.test(key)) {
        entities.push(item);
        strong.push(item);
      }
      if (/^(?:era|label|relationToFocus)$/u.test(key)) search.push(item);
    } else if (key === 'aliases' && Array.isArray(item)) {
      const aliases = item.filter((alias): alias is string => typeof alias === 'string');
      entities.push(...aliases);
      strong.push(...aliases);
    } else {
      collectStructuredTerms(item, entities, search, strong);
    }
  }
}

function normalizeGenealogyPredicate(value: string): string {
  const normalized = normalizeRetrievalText(value);
  if (/^(?:parent|adoptiveparent|guardian|grandparent|ancestor)$/u.test(normalized)) return 'parent';
  if (/^(?:child|adoptivechild|ward|grandchild|descendant)$/u.test(normalized)) return 'child';
  if (/^(?:sibling|halfsibling|uncleaunt|nephewniece|cousin)$/u.test(normalized)) return 'sibling';
  if (normalized === 'spouse') return 'spouse';
  if (/父|母|祖|监护/u.test(normalized)) return 'parent';
  if (/配偶|婚/u.test(normalized)) return 'spouse';
  if (/子|女|后代/u.test(normalized)) return 'child';
  if (/兄|弟|姐|妹|叔|姑|舅|姨|侄|甥|堂|表/u.test(normalized)) return 'sibling';
  return 'relationship';
}

function parseRecord(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isWorldbookMetadata(value: unknown): value is WorldbookRetrievalMetadata {
  return isRecord(value) && value.schema === 'eyon.retrieval.worldbook-metadata.v1';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
