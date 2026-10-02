import type {
  CastDisposition,
  CastManifest,
  CastManifestEntry,
  EventFrame,
  EvidencePassage,
  KnowledgeEntity,
  WorldKnowledgeCatalog,
} from './contracts.ts';
import { entityTemporallyEligible, extractEraNames, extractTemporalScopes } from './temporal.ts';
import { isEntityName } from './sourceOwnership.ts';

const GENERAL_GROUP_LIMIT = 4;
const EXHAUSTIVE_GROUP_LIMIT = 24;
const DIRECT_REFERENCE_STOPWORDS = new Set([
  '历史', '资料', '归属', '关系', '人物', '角色', '组织', '势力', '时期', '当前',
  '世界', '全境', '神明', '神祇', '众神', '诸神', '大陆', '其他', '探索',
  '墟境', '墟境探索', '成员', '群体', '所有', '全体', '每位', '逐一',
]);
const STRUCTURAL_REFERENCE_PREFIX = /^(?:对于|针对|关于|作为|若|如果|当|每当|其中|其他|所有|全体|每位|逐一)/u;
const ERA_REFERENCE = /^[\p{Script=Han}]{2,8}(?:纪元|时代|时期)(?:\d{1,6}年)?$/u;
const NON_ACTOR_SUFFIX = /(?:教堂|圣殿|神殿|礼拜堂|教皇宫|议会厅|工坊|交易所|骑士团|卫队|军团|教会|教团|学院|体系|信仰|教义|仪式|神谕|法阵|法典|契约|符文|装备|矿脉|洞穴|大赛|比赛|庆典|节|祭)$/u;
const GENERIC_ACTOR_DESCRIPTION = /(?:未知|任意|普通|高阶|低阶|巅峰|等级|层级|lv\.?\d+).*(?:神明|神祇|女神|男神)$/iu;

export function buildEventFrame(query: string, catalog: WorldKnowledgeCatalog): EventFrame {
  const normalizedQuery = normalize(query);
  const directEntities = catalog.entities
    .filter(entity => entityNames(entity).some(name =>
      isAdmissibleDirectReference(name)
      && normalizedQuery.includes(normalize(name))))
    .sort((left, right) => queryOffset(query, left) - queryOffset(query, right)
      || right.canonicalName.length - left.canonicalName.length);
  const directEntityIds = removeContainedEntities(directEntities).map(entity => entity.entityId);
  for (const relative of relativeSubjects(query, catalog).values()) {
    if (relative && !directEntityIds.includes(relative)) directEntityIds.push(relative);
  }
  const directPeople = directEntities.filter(entity => entity.kinds.includes('person'));
  const collectiveTargets: EventFrame['collectiveTargets'] = [];
  const deity = query.match(/((?:所有|每位|逐一|全体)?(?:其他)?(?:众神|诸神|神明(?!纪元)|神祇))/u);
  if (deity) {
    collectiveTargets.push({
      phrase: deity[1],
      selector: 'deity',
      entityId: null,
      exhaustive: /所有|每位|逐一|全体/u.test(deity[1]),
    });
  }
  for (const entity of directEntities) {
    if (!entity.kinds.some(kind => ['organization', 'family', 'collective'].includes(kind))) continue;
    if (!new RegExp(`${escapeRegExp(entity.canonicalName)}(?:的)?(?:成员|众人|全体)`, 'u').test(query)) continue;
    collectiveTargets.push({
      phrase: `${entity.canonicalName}成员`,
      selector: entity.kinds.includes('family') ? 'family-members' : 'organization-members',
      entityId: entity.entityId,
      exhaustive: /所有|每位|逐一|全体/u.test(query),
    });
  }
  return {
    schema: 'eyon.retrieval.event-frame.v1',
    action: query.trim(),
    directEntityIds,
    temporalTerms: extractTemporalScopes(query),
    locationEntityIds: directEntities
      .filter(entity =>
        entity.kinds.includes('place')
        && !entity.kinds.includes('person')
        && !directPeople.some(person => entityNamesOverlap(entity, person)))
      .map(entity => entity.entityId),
    collectiveTargets,
  };
}

function entityNamesOverlap(left: KnowledgeEntity, right: KnowledgeEntity): boolean {
  return entityNames(left).some(leftName => entityNames(right).some(rightName => {
    const a = normalize(leftName);
    const b = normalize(rightName);
    return a === b || (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a)));
  }));
}

export function buildCastManifest(
  frame: EventFrame,
  catalog: WorldKnowledgeCatalog,
  options: {
    focusEntityNames?: string[];
    requiredDirectEntityIds?: string[];
    actionQuery?: string;
  } = {},
): CastManifest {
  const byId = new Map(catalog.entities.map(entity => [entity.entityId, entity]));
  const focusNames = new Set((options.focusEntityNames ?? []).map(normalize).filter(Boolean));
  const requiredDirectIds = options.requiredDirectEntityIds === undefined
    ? null
    : new Set(options.requiredDirectEntityIds);
  const entries = new Map<string, CastManifestEntry>();
  const relatives = relativeSubjects(options.actionQuery ?? frame.action, catalog);
  for (const entityId of frame.directEntityIds) {
    const entity = byId.get(entityId);
    if (!entity || !isDirectCastEntity(entity)) continue;
    // 表单地点是舞台，不因名称也属于势力/组织而被误塞进演员表。
    if (frame.locationEntityIds.includes(entityId) && !entity.kinds.includes('person')) continue;
    const explicitlyRequired = requiredDirectIds?.has(entityId) ?? false;
    const focusReference = !explicitlyRequired && (
      entityNames(entity).some(name => focusNames.has(normalize(name)))
      || (requiredDirectIds !== null && !requiredDirectIds.has(entityId))
    );
    const documentReference = relatives.has(entityId);
    // 补充方向直接点名的实体仍是 required；工作台勾选的人物只是重点参考，
    // 保持 recommended，让资料被召回但不把人物强塞进实际演员表。
    entries.set(entityId, castEntry(
      entity,
      focusReference || documentReference ? 'recommended' : 'required',
      documentReference ? 'context' : focusReference ? 'participant' : 'actor',
      documentReference ? 'relative-document-reference' : temporalCompatible(entity, frame.temporalTerms, catalog)
        ? focusReference ? 'selected-focus-reference' : 'direct-query-entity'
        : focusReference
          ? 'selected-focus-reference-temporal-conflict'
          : 'direct-query-entity-temporal-conflict-degraded',
      affiliationsFor(entity, catalog, byId),
    ));
  }
  const groupCoverage: CastManifest['groupCoverage'] = [];
  for (const target of frame.collectiveTargets) {
    const allCandidates = groupCandidates(target, catalog, byId)
      .filter(entity => !frame.directEntityIds.includes(entity.entityId));
    const candidates = allCandidates.filter(entity => temporalCompatible(entity, frame.temporalTerms, catalog));
    const incompatible = allCandidates.filter(entity => !temporalCompatible(entity, frame.temporalTerms, catalog));
    const limit = target.exhaustive ? EXHAUSTIVE_GROUP_LIMIT : GENERAL_GROUP_LIMIT;
    const selected = candidates.slice(0, limit);
    for (const entity of selected) {
      if (!entries.has(entity.entityId)) {
        entries.set(entity.entityId, castEntry(
          entity,
          'group-required',
          'target',
          `collective:${target.phrase}`,
          affiliationsFor(entity, catalog, byId),
        ));
      }
    }
    for (const entity of candidates.slice(limit)) {
      if (!entries.has(entity.entityId)) {
        entries.set(entity.entityId, castEntry(
          entity, 'optional', 'context', 'collective-budget-omitted',
          affiliationsFor(entity, catalog, byId),
        ));
      }
    }
    for (const entity of incompatible) {
      if (!entries.has(entity.entityId)) {
        entries.set(entity.entityId, castEntry(
          entity, 'excluded', 'context', 'temporal-scope-incompatible',
          affiliationsFor(entity, catalog, byId),
        ));
      }
    }
    groupCoverage.push({
      phrase: target.phrase,
      exhaustive: target.exhaustive,
      candidateEntityIds: candidates.map(entity => entity.entityId),
      selectedEntityIds: selected.map(entity => entity.entityId),
      omittedEntityIds: candidates.slice(limit).map(entity => entity.entityId),
      complete: !target.exhaustive || candidates.length <= limit,
    });
  }

  const selectedIds = new Set([...frame.directEntityIds.filter(id => !relatives.has(id)), ...[...entries.values()]
    .filter(entry => entry.disposition !== 'optional' && entry.disposition !== 'excluded')
    .filter(entry => !entry.reasons.includes('relative-document-reference'))
    .map(entry => entry.entityId)]);
  for (const relation of catalog.relations) {
    const neighborId = selectedIds.has(relation.subjectEntityId)
      ? relation.objectEntityId
      : selectedIds.has(relation.objectEntityId) ? relation.subjectEntityId : '';
    const entity = byId.get(neighborId);
    // 关系扩展保持“人物优先”，避免从一个国家/地点把整套机构树拖进演员表。
    if (!entity || !isPersonCastEntity(entity) || entries.has(entity.entityId)) continue;
    // 身世关联的跨时代档案是只读参照，不是当时必定在场的人物。
    if (relation.predicate === 'character_reference') {
      entries.set(entity.entityId, castEntry(entity, 'recommended', 'context',
        'character-reference-read-only', affiliationsFor(entity, catalog, byId)));
      continue;
    }
    if (!temporalCompatible(entity, frame.temporalTerms, catalog)) {
      entries.set(entity.entityId, castEntry(
        entity, 'excluded', 'context', 'temporal-scope-incompatible',
        affiliationsFor(entity, catalog, byId),
      ));
      continue;
    }
    entries.set(entity.entityId, castEntry(
      entity, 'recommended', 'participant', `relation:${relation.predicate}`,
      affiliationsFor(entity, catalog, byId),
    ));
  }
  return {
    schema: 'eyon.retrieval.cast-manifest.v1',
    entries: [...entries.values()].sort(compareCastEntries),
    groupCoverage,
  };
}

export function attachCastPassages(
  manifest: CastManifest,
  passages: EvidencePassage[],
): CastManifest {
  return {
    ...manifest,
    entries: manifest.entries.map(entry => ({
      ...entry,
      identity: {
        ...entry.identity,
        passageIds: passages.filter(passage =>
          entry.identity.sourceSnapshotIds.includes(passage.snapshotId)
          && (passage.content.includes(entry.identity.canonicalName)
            || passage.title.includes(entry.identity.canonicalName)
            || passage.matchedAnchors.includes(entry.identity.canonicalName)))
          .map(passage => passage.passageId),
      },
    })),
  };
}

export function castSourceSnapshotIds(manifest: CastManifest): Set<string> {
  return new Set(manifest.entries.flatMap(entry =>
    ['required', 'group-required', 'recommended'].includes(entry.disposition)
      ? entry.identity.sourceSnapshotIds : []));
}

export function castRequiredAnchors(manifest: CastManifest): string[] {
  return manifest.entries.flatMap(entry =>
    ['required', 'group-required'].includes(entry.disposition)
      ? [entry.identity.canonicalName] : []);
}

/**
 * R-04：recommended 不再自动升级为硬覆盖锚。它只作为 desired（P1/P2）锚，
 * 预算不足时进 receipt.omittedAnchors 警告，不得触发 uncovered 硬失败。
 */
export function castDesiredAnchors(manifest: CastManifest): string[] {
  return manifest.entries.flatMap(entry =>
    entry.disposition === 'recommended'
      ? [entry.identity.canonicalName] : []);
}

function groupCandidates(
  target: EventFrame['collectiveTargets'][number],
  catalog: WorldKnowledgeCatalog,
  byId: Map<string, KnowledgeEntity>,
): KnowledgeEntity[] {
  if (target.selector === 'deity') {
    return catalog.entities.filter(entity => entity.tags.includes('deity') && isPersonCastEntity(entity))
      .sort(compareEntities);
  }
  if (!target.entityId) return [];
  const ids = new Set<string>();
  for (const relation of catalog.relations) {
    if (relation.objectEntityId === target.entityId && ['member_of', 'belongs_to'].includes(relation.predicate)) {
      ids.add(relation.subjectEntityId);
    }
    if (relation.subjectEntityId === target.entityId && relation.predicate === 'has_member') {
      ids.add(relation.objectEntityId);
    }
  }
  return [...ids].flatMap(id => byId.get(id) ?? []).filter(isPersonCastEntity).sort(compareEntities);
}

function castEntry(
  entity: KnowledgeEntity,
  disposition: CastDisposition,
  role: CastManifestEntry['role'],
  reason: string,
  affiliations: string[] = [],
): CastManifestEntry {
  return {
    entityId: entity.entityId,
    disposition,
    role,
    reasons: [reason],
    identity: {
      canonicalName: entity.canonicalName,
      aliases: [...entity.aliases],
      kinds: [...entity.kinds],
      identities: [...entity.identities],
      affiliations,
      temporalScopes: [...entity.temporalScopes],
      locationScopes: [...entity.locationScopes],
      sourceSnapshotIds: [...entity.sourceSnapshotIds],
      passageIds: [],
    },
  };
}

function removeContainedEntities(entities: KnowledgeEntity[]): KnowledgeEntity[] {
  return entities.filter((entity, index) => !entities.some((candidate, candidateIndex) =>
    index !== candidateIndex
    && candidate.normalizedName.length > entity.normalizedName.length
    && candidate.normalizedName.includes(entity.normalizedName)
    && candidate.sourceSnapshotIds.some(id => entity.sourceSnapshotIds.includes(id))));
}

function isDirectCastEntity(entity: KnowledgeEntity): boolean {
  const actorKinds = new Set([
    'person', 'organization', 'faction', 'family', 'collective', 'institution',
  ]);
  return entity.kinds.some(kind => actorKinds.has(kind))
    && isAdmissibleDirectReference(entity.canonicalName)
    && (!entity.kinds.includes('person') || isPersonCastEntity(entity));
}

function isPersonCastEntity(entity: KnowledgeEntity): boolean {
  const coreName = referenceCore(entity.canonicalName);
  return entity.kinds.includes('person')
    && isAdmissibleDirectReference(coreName)
    && !NON_ACTOR_SUFFIX.test(coreName)
    && !GENERIC_ACTOR_DESCRIPTION.test(coreName);
}

function affiliationsFor(
  entity: KnowledgeEntity,
  catalog: WorldKnowledgeCatalog,
  byId: Map<string, KnowledgeEntity>,
): string[] {
  const affiliations = new Set<string>();
  for (const relation of catalog.relations) {
    const parentId = relation.subjectEntityId === entity.entityId
      && ['member_of', 'belongs_to', 'part_of'].includes(relation.predicate)
      ? relation.objectEntityId
      : relation.objectEntityId === entity.entityId && relation.predicate === 'has_member'
        ? relation.subjectEntityId
        : null;
    const parent = parentId ? byId.get(parentId) : undefined;
    if (parent) affiliations.add(parent.canonicalName);
  }
  return [...affiliations].sort((left, right) => left.localeCompare(right));
}

function isAdmissibleDirectReference(value: string): boolean {
  const name = referenceCore(value);
  return isEntityName(name)
    && name.length <= 40
    && !DIRECT_REFERENCE_STOPWORDS.has(name)
    && !STRUCTURAL_REFERENCE_PREFIX.test(name)
    && !ERA_REFERENCE.test(name);
}

/** 有明确亲属边才解析“某人的父亲”；无名/多义亲属仍留给原文，不造人物。 */
function relativeSubjects(query: string, catalog: WorldKnowledgeCatalog): Map<string, string | null> {
  const result = new Map<string, string | null>();
  const roles: Record<string, string> = { 父亲: 'father', 母亲: 'mother', 配偶: 'spouse',
    创造者: 'creator', 制造者: 'creator', 主人: 'owner' };
  for (const owner of catalog.entities) {
    if (!owner.kinds.includes('person')) continue;
    for (const [role, predicate] of Object.entries(roles)) {
      const phrase = new RegExp(`(?:${entityNames(owner).filter(isAdmissibleDirectReference).map(escapeRegExp).join('|')})(?:的)?${role}`, 'gu');
      const remainder = query.replace(phrase, '');
      if (remainder === query || entityNames(owner).some(name => remainder.includes(name))) continue;
      const relatives = [...new Set(catalog.relations.filter(relation => relation.subjectEntityId === owner.entityId
        && relation.predicate === predicate).map(relation => relation.objectEntityId))];
      result.set(owner.entityId, relatives.length === 1 ? relatives[0]! : null);
    }
  }
  return result;
}

function referenceCore(value: string): string {
  return normalize(value).replace(/[（(][^）)]*[）)]$/u, '');
}

function temporalCompatible(
  entity: KnowledgeEntity,
  requested: string[],
  catalog: WorldKnowledgeCatalog,
): boolean {
  const requestedEras = requested.flatMap(extractEraNames);
  const entityEras = entity.temporalScopes.flatMap(extractEraNames);
  const explicitCompatible = !requestedEras.length || !entityEras.length
    || requestedEras.some(era => entityEras.includes(era));
  return explicitCompatible && requestedEras.every(era =>
    entityTemporallyEligible(entity, era, catalog.temporalEligibility));
}

function entityNames(entity: KnowledgeEntity): string[] {
  return [entity.canonicalName, ...entity.aliases];
}

function queryOffset(query: string, entity: KnowledgeEntity): number {
  const positions = entityNames(entity).map(name => query.indexOf(name)).filter(value => value >= 0);
  return positions.length ? Math.min(...positions) : Number.MAX_SAFE_INTEGER;
}

function compareEntities(left: KnowledgeEntity, right: KnowledgeEntity): number {
  return left.canonicalName.localeCompare(right.canonicalName) || left.entityId.localeCompare(right.entityId);
}

function compareCastEntries(left: CastManifestEntry, right: CastManifestEntry): number {
  const order: Record<CastDisposition, number> = {
    required: 0, 'group-required': 1, recommended: 2, optional: 3, excluded: 4,
  };
  return order[left.disposition] - order[right.disposition]
    || left.identity.canonicalName.localeCompare(right.identity.canonicalName);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
