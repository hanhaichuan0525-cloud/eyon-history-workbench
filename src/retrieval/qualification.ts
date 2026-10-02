import type {
  CastManifest,
  EventFrame,
  EvidenceClaim,
  EvidenceEventPhase,
  EvidenceGeographicFit,
  EvidenceNarrativeUse,
  EvidencePassage,
  EvidenceRevisionFit,
  EvidenceTemporalFit,
  QualifiedEvidencePassage,
  QualifiedEvidenceView,
  RetrievalTaskType,
  KnowledgeEntity,
  WorldKnowledgeCatalog,
} from './contracts.ts';
import { normalizeRetrievalText } from './index.ts';
import { extractEraNames } from './temporal.ts';

export function buildQualifiedEvidenceView(input: {
  taskType: RetrievalTaskType;
  frame: EventFrame;
  castManifest?: CastManifest;
  passages: EvidencePassage[];
  claims: EvidenceClaim[];
  catalog: WorldKnowledgeCatalog;
  requestedLocations?: string[];
}): QualifiedEvidenceView {
  const requestedEras = unique(input.frame.temporalTerms.flatMap(extractEraNames));
  const entitiesById = new Map(input.catalog.entities.map(entity => [entity.entityId, entity]));
  const entitiesBySnapshot = new Map<string, typeof input.catalog.entities>();
  for (const entity of input.catalog.entities) {
    for (const snapshotId of entity.sourceSnapshotIds) {
      const group = entitiesBySnapshot.get(snapshotId) ?? [];
      group.push(entity);
      entitiesBySnapshot.set(snapshotId, group);
    }
  }
  // 显式地点（例如墟境表单的“地点范围”）是唯一舞台目标。正文或补充方向里
  // 顺带识别出的地点只能参与检索，不能反向扩大玩家指定的地理范围。
  const explicitRequestedLocations = unique(input.requestedLocations ?? []);
  const inferredRequestedLocations = input.frame.locationEntityIds.flatMap(id =>
    entitiesById.get(id)?.canonicalName ?? []);
  const requestedLocations = explicitRequestedLocations.length > 0
    ? explicitRequestedLocations
    : unique(inferredRequestedLocations);
  const requestedLocationIds = new Set(
    explicitRequestedLocations.length > 0
      ? input.catalog.entities
        .filter(entity => explicitRequestedLocations.some(location =>
          entityMatchesLocation(entity.canonicalName, entity.aliases, location)))
        .map(entity => entity.entityId)
      : input.frame.locationEntityIds,
  );
  const directIds = new Set(input.frame.directEntityIds);
  // Map 单独建立，避免 passage 资格反向改变 CastManifest。
  const castByEntityId = new Map(
    (input.castManifest?.entries ?? []).map(entry => [entry.entityId, entry]),
  );

  return {
    schema: 'eyon.retrieval.qualified-evidence.v1',
    taskType: input.taskType,
    requestedScope: {
      eras: requestedEras,
      locations: requestedLocations,
    },
    passages: input.passages.map(passage => {
      const localEntityIds = passageLocalEntities(
        passage,
        entitiesBySnapshot.get(passage.snapshotId) ?? [],
      ).map(entity => entity.entityId);
      const evidenceEntities = localEntityIds.flatMap(id => entitiesById.get(id) ?? []);
      const evidenceLocations = evidenceEntities.filter(entity => entity.kinds.includes('place'));
      const hardEvidenceLocations = localEntityIds
        .flatMap(id => entitiesById.get(id) ?? [])
        .filter(entity => entity.kinds.includes('place'));
      const temporal = qualifyTemporal(
        requestedEras,
        passage.temporalScopes,
        input.catalog.temporalEligibility.eraOrder,
      );
      const geographic = qualifyGeography({
        passage,
        requestedLocations,
        requestedLocationIds,
        evidenceLocationIds: hardEvidenceLocations.map(entity => entity.entityId),
        evidenceLocationNames: unique([
          ...evidenceLocations.map(entity => entity.canonicalName),
        ]),
        catalog: input.catalog,
      });
      const claimConflict = input.claims.some(claim =>
        claim.sourcePassageIds.includes(passage.passageId)
        && claim.epistemicStatus === 'conflicted');
      const eventPhase = qualifyEventPhase(temporal.fit, geographic.fit);
      const revision = qualifyRevision(passage.sourceType, claimConflict);
      const entityRoles = evidenceEntities.reduce<QualifiedEvidencePassage['entityRoles']>((roles, entity) => {
        const cast = castByEntityId.get(entity.entityId);
        if (cast) {
          roles.push({
            entityId: entity.entityId,
            name: entity.canonicalName,
            role: cast.role,
            disposition: cast.disposition,
          });
          return roles;
        }
        if (directIds.has(entity.entityId)) {
          roles.push({
            entityId: entity.entityId,
            name: entity.canonicalName,
            role: 'direct',
          });
        }
        return roles;
      }, []);
      const allowedUses = allowedNarrativeUses(temporal.fit, geographic.fit, entityRoles);
      const forbiddenUses = [
        ...forbiddenNarrativeUses(temporal.fit, geographic.fit, revision.fit),
      ];
      return {
        passageId: passage.passageId,
        sourceId: passage.sourceId,
        sourceType: passage.sourceType,
        zone: passage.sourceType === 'worldbook' || passage.sourceType === 'mvu' || passage.sourceType === 'chat'
          ? 'locked'
          : 'guided',
        temporal,
        geographic,
        eventPhase,
        revision,
        entityRoles,
        allowedUses,
        forbiddenUses,
        reasons: [
          ...qualificationReasons(temporal.fit, geographic.fit, revision.fit),
          'entity-grounding:passage-local',
        ],
      } satisfies QualifiedEvidencePassage;
    }),
    creativePolicy: {
      locked: '只锁定来源明确陈述的身份、关系、时间、地点与已发生事实；不得把暗示扩大成新设定。',
      guided: '可作为方向、背景或因果候选；模型可在说明自洽的前提下采用、重释或放弃。',
      open: '证据未覆盖的局部人物、微观地点、动机、气氛与因果桥梁可自由创造，但不得反写 LOCKED 事实。',
    },
  };
}

function qualifyTemporal(
  requestedEras: string[],
  rawEvidenceScopes: string[],
  eraOrder: string[],
): QualifiedEvidencePassage['temporal'] {
  const evidenceEras = unique(rawEvidenceScopes.flatMap(extractEraNames));
  if (requestedEras.length === 0 || evidenceEras.length === 0) {
    return { fit: 'unknown', requestedEras, evidenceEras };
  }
  if (requestedEras.some(era => evidenceEras.includes(era))) {
    return { fit: 'contemporary', requestedEras, evidenceEras };
  }
  const requestedIndexes = requestedEras.map(era => eraOrder.indexOf(era)).filter(index => index >= 0);
  const evidenceIndexes = evidenceEras.map(era => eraOrder.indexOf(era)).filter(index => index >= 0);
  if (requestedIndexes.length === 0 || evidenceIndexes.length === 0) {
    return { fit: 'external', requestedEras, evidenceEras };
  }
  const latestEvidence = Math.max(...evidenceIndexes);
  const earliestEvidence = Math.min(...evidenceIndexes);
  const earliestRequested = Math.min(...requestedIndexes);
  const latestRequested = Math.max(...requestedIndexes);
  const fit: EvidenceTemporalFit = latestEvidence < earliestRequested
    ? 'antecedent'
    : earliestEvidence > latestRequested ? 'aftermath' : 'external';
  return { fit, requestedEras, evidenceEras };
}

function qualifyGeography(input: {
  passage: EvidencePassage;
  requestedLocations: string[];
  requestedLocationIds: Set<string>;
  evidenceLocationIds: string[];
  evidenceLocationNames: string[];
  catalog: WorldKnowledgeCatalog;
}): QualifiedEvidencePassage['geographic'] {
  if (input.requestedLocations.length === 0) {
    return {
      fit: 'unknown',
      requestedLocations: [],
      evidenceLocations: unique(input.evidenceLocationNames),
    };
  }
  // 地理舞台资格只看标题、章节路径和结构化地点关系。正文中的外交、威胁、
  // 贸易或历史比较提及只能证明“相关”，不能证明“发生在这里”。
  const structuralHeaders = [input.passage.title, ...input.passage.sectionPath];
  const explicitlyInside = input.requestedLocations.some(location =>
    structuralHeaders.some(header => headerScopesLocation(header, location)));
  if (explicitlyInside) {
    return {
      fit: 'stage',
      requestedLocations: input.requestedLocations,
      evidenceLocations: unique(input.evidenceLocationNames),
    };
  }
  const exactStructuredLocation = input.evidenceLocationIds.some(id =>
    input.requestedLocationIds.has(id));
  if (exactStructuredLocation) {
    return {
      fit: 'stage',
      requestedLocations: input.requestedLocations,
      evidenceLocations: unique(input.evidenceLocationNames),
    };
  }
  const spatiallyRelated = input.evidenceLocationIds.some(id =>
    isInsideRequestedScope(id, input.requestedLocationIds, input.catalog));
  if (spatiallyRelated) {
    return {
      fit: 'inside-scope',
      requestedLocations: input.requestedLocations,
      evidenceLocations: unique(input.evidenceLocationNames),
    };
  }
  return {
    fit: input.evidenceLocationIds.length > 0 ? 'external' : 'unknown',
    requestedLocations: input.requestedLocations,
    evidenceLocations: unique(input.evidenceLocationNames),
  };
}

function isInsideRequestedScope(
  startId: string,
  targets: Set<string>,
  catalog: WorldKnowledgeCatalog,
): boolean {
  if (targets.size === 0) return false;
  const visited = new Set([startId]);
  let frontier = [startId];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const relation of catalog.relations) {
        // 只沿“子地点 → 父范围”上溯。禁止先上溯共同大陆再下钻到兄弟国家，
        // 否则“同属阿斯塔利亚”会被误判成“位于奥古斯提姆帝国内”。
        const parent = relation.predicate === 'contains'
          && relation.objectEntityId === current
          ? relation.subjectEntityId
          : ['located_in', 'part_of'].includes(relation.predicate)
            && relation.subjectEntityId === current
          ? relation.objectEntityId
          : null;
        if (!parent || visited.has(parent)) continue;
        if (targets.has(parent)) return true;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return false;
}

function qualifyEventPhase(
  temporal: EvidenceTemporalFit,
  geographic: EvidenceGeographicFit,
): EvidenceEventPhase {
  if (temporal === 'antecedent') return 'precondition';
  if (temporal === 'aftermath') return 'aftermath';
  if (temporal === 'contemporary' && ['stage', 'inside-scope'].includes(geographic)) {
    return 'contemporary';
  }
  if (geographic === 'external') return 'reference';
  return 'unknown';
}

function qualifyRevision(
  sourceType: EvidencePassage['sourceType'],
  conflicted: boolean,
): QualifiedEvidencePassage['revision'] {
  if (conflicted) return { fit: 'conflicted', reason: 'selected-claim-conflict' };
  if (sourceType === 'worldbook') return { fit: 'baseline', reason: 'worldbook-baseline' };
  if (sourceType === 'mvu' || sourceType === 'chat') {
    return { fit: 'current', reason: `${sourceType}-current-state` };
  }
  return {
    fit: 'unresolved',
    reason: 'generated-artifact-requires-current-canon-revision',
  };
}

function allowedNarrativeUses(
  temporal: EvidenceTemporalFit,
  geographic: EvidenceGeographicFit,
  entityRoles: QualifiedEvidencePassage['entityRoles'],
): EvidenceNarrativeUse[] {
  const uses = new Set<EvidenceNarrativeUse>(['background', 'reference']);
  const hasRequiredActor = entityRoles.some(role =>
    role.disposition === 'required' || role.disposition === 'group-required');
  // 年代未知的当代人物、组织、官职或家族不能仅因“被检索到”就成为历史演员；
  // 玩家明确要求的角色仍由 CastManifest 保持在场资格。
  if (entityRoles.length > 0 && (temporal !== 'unknown' || hasRequiredActor)) {
    uses.add('actor');
  }
  if (temporal === 'antecedent') uses.add('cause');
  if (temporal === 'aftermath') uses.add('aftermath');
  if (temporal !== 'aftermath' && ['stage', 'inside-scope'].includes(geographic)) uses.add('stage');
  return [...uses];
}

function forbiddenNarrativeUses(
  temporal: EvidenceTemporalFit,
  geographic: EvidenceGeographicFit,
  revision: EvidenceRevisionFit,
): string[] {
  const forbidden: string[] = [];
  if (geographic === 'external') {
    forbidden.push('不得仅凭相关性把该来源地点写成本轮事件发生地');
  }
  if (temporal === 'antecedent') {
    forbidden.push('不得把前史直接写成本轮同时发生的现状');
  } else if (temporal === 'aftermath') {
    forbidden.push('不得让后果或遗迹早于其形成原因出现');
  } else if (temporal === 'unknown') {
    forbidden.push('不得仅凭年代未知的条目假定其中具名人物、政权、官职或组织在目标纪元已经存在');
  }
  if (revision === 'unresolved') {
    forbidden.push('不得用未仲裁的旧产物覆盖当前有效历史');
  } else if (revision === 'conflicted') {
    forbidden.push('不得静默选定冲突事实的一方为唯一真相');
  }
  return forbidden;
}

function qualificationReasons(
  temporal: EvidenceTemporalFit,
  geographic: EvidenceGeographicFit,
  revision: EvidenceRevisionFit,
): string[] {
  return [`temporal:${temporal}`, `geographic:${geographic}`, `revision:${revision}`];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function entityMatchesLocation(
  canonicalName: string,
  aliases: string[],
  requestedLocation: string,
): boolean {
  const requested = normalize(requestedLocation);
  if (!requested) return false;
  return [canonicalName, ...aliases]
    .map(normalize)
    .some(name => name === requested || name.includes(requested) || requested.includes(name));
}

function headerScopesLocation(header: string, requestedLocation: string): boolean {
  const requested = normalize(requestedLocation);
  const value = normalize(header)
    .replace(/^[\[【「『]+/u, '')
    .replace(/[\]】」』]+$/u, '');
  if (!requested || !value) return false;
  if (value === requested) return true;
  return ['-', '—', '·', '/', ':', '：', '（', '(']
    .some(separator => value.startsWith(`${requested}${separator}`));
}

function passageLocalEntities(
  passage: EvidencePassage,
  entities: KnowledgeEntity[],
): KnowledgeEntity[] {
  const localText = normalizeRetrievalText([
    passage.title,
    ...passage.sectionPath,
    passage.content,
  ].join('\n'));
  return entities.filter(entity => {
    if (!entity.sourceSnapshotIds.includes(passage.snapshotId)) return false;
    const literal = [entity.canonicalName, ...entity.aliases]
      .map(normalizeRetrievalText)
      .filter(value => value.length >= 2)
      .some(value => localText.includes(value));
    if (literal) return true;
    return entity.spans.some(span => span.snapshotId === passage.snapshotId
      && span.startOffset < passage.endOffset
      && span.endOffset > passage.startOffset);
  });
}
