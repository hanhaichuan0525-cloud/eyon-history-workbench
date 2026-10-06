import type {
  CanonFact,
  CanonEventRelation,
  CanonFactConfidence,
  CanonFactEpistemicStatus,
  CharacterCanonFacts,
  CastManifest,
  EventFrame,
  KnowledgeEntity,
  KnowledgeSpan,
  OrderedLifeAnchor,
  PersonCanonView,
  RetrievalTaskType,
  SourceSnapshot,
  TaskAnchorAttachment,
} from './contracts.ts';
import { stableSha256 } from './sourceSnapshot.ts';
import { characterDocumentOwner, characterReferenceIdentity, templateIndependentText } from './sourceOwnership.ts';
import { ContinuousStateSchema } from './continuousState.ts';

const IDENTITY_FIELDS: Readonly<Record<string, string>> = {
  身份: 'identity',
  职务: 'occupation',
  职业: 'occupation',
  性别: 'sex',
  种族: 'species',
  年龄: 'age',
  阵营: 'alignment',
};

const RELATION_FIELDS: Readonly<Record<string, string>> = {
  父亲: 'father',
  母亲: 'mother',
  父母: 'parent',
  姐姐: 'older_sister',
  妹妹: 'younger_sister',
  兄长: 'older_brother',
  弟弟: 'younger_brother',
  兄弟: 'brother',
  姐妹: 'sister',
  兄弟姐妹: 'sibling',
  配偶: 'spouse',
  儿子: 'son',
  女儿: 'daughter',
  子女: 'child',
  孩子: 'child',
  养父: 'adoptive_parent',
  养母: 'adoptive_parent',
  养子: 'adoptive_child',
  养女: 'adoptive_child',
  祖父: 'grandparent',
  祖母: 'grandparent',
  外祖父: 'grandparent',
  外祖母: 'grandparent',
  孙子: 'grandchild',
  孙女: 'grandchild',
  外孙: 'grandchild',
  外孙女: 'grandchild',
  叔伯姑舅姨: 'uncle_aunt',
  侄甥: 'nephew_niece',
  堂表亲: 'cousin',
  导师: 'mentor',
  学生: 'student',
};

const GENERIC_RELATION_FIELD = /^(?:亲属|亲属关系|亲缘关系|家庭关系|家族关系)$/u;
const RELATION_LABEL_PREDICATES: Readonly<Record<string, string>> = {
  父亲: 'father', 父亲关系: 'father',
  母亲: 'mother', 母亲关系: 'mother',
  父母: 'parent',
  姐姐: 'older_sister', 妹妹: 'younger_sister',
  兄长: 'older_brother', 哥哥: 'older_brother',
  弟弟: 'younger_brother', 兄弟: 'brother', 姐妹: 'sister',
  配偶: 'spouse', 丈夫: 'spouse', 妻子: 'spouse',
  儿子: 'son', 女儿: 'daughter', 子女: 'child', 孩子: 'child',
  养父: 'adoptive_parent', 养母: 'adoptive_parent',
  养子: 'adoptive_child', 养女: 'adoptive_child',
  祖父: 'grandparent', 祖母: 'grandparent',
  外祖父: 'grandparent', 外祖母: 'grandparent',
  叔叔: 'uncle_aunt', 伯父: 'uncle_aunt', 姑姑: 'uncle_aunt',
  舅舅: 'uncle_aunt', 阿姨: 'uncle_aunt', 姨母: 'uncle_aunt',
  堂亲: 'cousin', 表亲: 'cousin', 堂表亲: 'cousin',
};

const CURRENT_STATE_FIELDS: Readonly<Record<string, string>> = {
  配饰: 'current_equipment',
  装备: 'current_equipment',
  当前装备: 'current_equipment',
  携带: 'current_equipment',
  所属: 'current_affiliation',
  所属组织: 'current_affiliation',
  所属势力: 'current_affiliation',
  归属: 'current_affiliation',
  所在地: 'current_location',
  活动地点: 'current_location',
  活跃于: 'current_location',
};

interface EventRule {
  pattern: RegExp;
  build(match: RegExpMatchArray): {
    predicate: string;
    object: string;
    statement: string;
    anchor?: string;
    spatialScope?: string;
    epistemicStatus?: CanonFactEpistemicStatus;
    confidence?: CanonFactConfidence;
  };
}

const EVENT_RULES: EventRule[] = [
  {
    pattern: /我离开(?:了)?(.{2,18}?)(?:的)?时候/gu,
    build: match => ({
      predicate: 'departed_from',
      object: match[1]!.trim(),
      statement: `离开${match[1]!.trim()}`,
      anchor: match[1]!.trim(),
      spatialScope: match[1]!.trim(),
    }),
  },
  {
    pattern: /官方说(.{2,18}?)被(.{0,18}?)(?:选中|选作|带走|召去)(?:去)?([^，。；做当成为]{2,20})(?:做|当|成为)?([^，。；]{0,16})/gu,
    build: match => {
      const person = match[1]!.replace(/^是/u, '').replace(/是$/u, '').trim();
      const authority = (match[2] || '某种力量').trim();
      const destination = match[3]!.trim();
      const duty = match[4]?.trim();
      return {
        predicate: 'person_selected_for_duty',
        object: [person, authority, destination, duty].filter(Boolean).join('｜'),
        statement: `${person}被${authority}选中去${destination}${duty ? `担任${duty}` : ''}`,
        anchor: destination,
        spatialScope: destination,
        epistemicStatus: 'reported',
        confidence: 'medium',
      };
    },
  },
  {
    pattern: /后来我(?:到|在|来到|去了)([^，。；]{2,18})/gu,
    build: match => ({
      predicate: 'arrived_at',
      object: match[1]!.trim(),
      statement: `抵达${match[1]!.trim()}`,
      anchor: match[1]!.trim(),
      spatialScope: match[1]!.trim(),
    }),
  },
  {
    pattern: /([^，。；\n"“”]{2,24}?)(?:小姐|女士)?(?:当年|那时|曾经)递给我的([^，。；\n"“”]{2,60})/gu,
    build: match => ({
      predicate: 'received_from',
      object: `${match[1]!.trim()}｜${match[2]!.trim()}`,
      statement: `${match[1]!.trim()}赠予${match[2]!.trim()}`,
      anchor: match[1]!.trim(),
    }),
  },
];

export function buildCharacterCanonFacts(
  entity: KnowledgeEntity,
  snapshotsById: Map<string, SourceSnapshot>,
): CharacterCanonFacts {
  const facts: CanonFact[] = [];
  for (const snapshotId of entity.sourceSnapshotIds) {
    const snapshot = snapshotsById.get(snapshotId);
    if (!snapshot || !isCharacterEntry(snapshot, entity)) continue;
    if (/<%[\s\S]*?\b(?:if|else|switch)\b[\s\S]*?%>/u.test(snapshot.content)) continue;
    extractFieldFacts(entity, snapshot, facts);
    extractEventFacts(entity, snapshot, facts);
  }
  const unique = dedupeFacts(facts);
  const eventRelations = buildEventRelations(unique, snapshotsById);
  return {
    schema: 'eyon.retrieval.character-canon-facts.v1',
    entityId: entity.entityId,
    canonicalName: entity.canonicalName,
    identityFactIds: idsFor(unique, fact => Object.values(IDENTITY_FIELDS).includes(fact.predicate)),
    relationFactIds: idsFor(unique, fact => Object.values(RELATION_FIELDS).includes(fact.predicate)),
    lifeEventFactIds: idsFor(unique, fact => [
      'departed_from', 'person_selected_for_duty', 'arrived_at', 'received_from',
    ].includes(fact.predicate)),
    currentStateFactIds: idsFor(unique, fact =>
      Boolean(fact.continuousState) || Object.values(CURRENT_STATE_FIELDS).includes(fact.predicate)
      || ['identity', 'occupation'].includes(fact.predicate)),
    eventRelations,
    facts: unique,
  };
}

export function lifeAnchorsFromCharacterFacts(
  characterFacts: CharacterCanonFacts,
): OrderedLifeAnchor[] {
  const eventIds = new Set(characterFacts.lifeEventFactIds);
  return characterFacts.facts.flatMap(fact => {
    if (!eventIds.has(fact.factId)) return [];
    const anchor = fact.predicate === 'person_selected_for_duty'
      ? fact.object.split('｜')[2]
      : fact.predicate === 'received_from'
        ? fact.object.split('｜')[0]
        : fact.object;
    return [{
      factId: fact.factId,
      event: fact.statement,
      relation: 'before-current' as const,
      ...(anchor ? { anchor } : {}),
      chronology: fact.temporalScope ? 'dated' as const : 'unresolved' as const,
      epistemicStatus: fact.epistemicStatus,
      confidence: fact.confidence,
      sourceLabel: characterFacts.canonicalName,
      sourceSpan: fact.sourceSpans[0],
    }];
  });
}

export async function buildTaskPersonArtifacts(input: {
  taskType: RetrievalTaskType;
  query: string;
  entities: KnowledgeEntity[];
  snapshots: SourceSnapshot[];
  eventFrame?: EventFrame;
  castManifest?: CastManifest;
}): Promise<{ personCanonViews: PersonCanonView[]; taskAnchorAttachments: TaskAnchorAttachment[] }> {
  const directIds = new Set(input.eventFrame?.directEntityIds ?? []);
  const castIds = new Set((input.castManifest?.entries ?? [])
    .filter(entry => entry.disposition !== 'excluded')
    .map(entry => entry.entityId));
  const normalizedQuery = normalizeRetrievalText(input.query);
  const people = input.entities.filter(entity => {
    if (!entity.kinds.includes('person')) return false;
    return directIds.has(entity.entityId)
      || castIds.has(entity.entityId)
      || (!input.eventFrame && [entity.canonicalName, ...entity.aliases]
        .some(name => normalizedQuery.includes(normalizeRetrievalText(name))));
  }).slice(0, 16);
  const personCanonViews = people.filter(entity => entity.characterFacts?.facts.length).map(entity => buildPersonCanonView(
    entity,
    input.taskType,
    normalizedQuery,
    directIds.has(entity.entityId),
  ));
  const snapshotsById = new Map(input.snapshots.map(snapshot => [snapshot.snapshotId, snapshot]));
  const taskAnchorAttachments: TaskAnchorAttachment[] = [];
  for (const entity of people) {
    // 使用同轮 EventFrame 的全名保护，不能在附件层重新裸匹配短名。
    const direct = directIds.has(entity.entityId)
      || (!input.eventFrame && [entity.canonicalName, ...entity.aliases]
        .some(name => normalizedQuery.includes(normalizeRetrievalText(name))));
    // 原文交付不依赖机器提取到几个字段；定位成功的散文人设也必须交给模型。
    // 阅读归属可以跨条目，但不把角色经营的组织身份并进该角色，也不添加演员。
    const names = [entity.canonicalName, ...entity.aliases].map(normalizeRetrievalText);
    const ownedIds = input.snapshots.filter(snapshot => {
      const owner = characterDocumentOwner(snapshot);
      return owner && names.includes(normalizeRetrievalText(owner));
    }).map(snapshot => snapshot.snapshotId);
    for (const snapshotId of uniqueStrings([...entity.sourceSnapshotIds, ...ownedIds])) {
      const snapshot = snapshotsById.get(snapshotId);
      if (!snapshot || !['worldbook', 'mvu'].includes(snapshot.sourceType)) continue;
      if (!isCharacterEntry(snapshot, entity)
        && !(entity.sourceSnapshotIds.includes(snapshotId)
          && templateIndependentText(snapshot.content).includes(entity.canonicalName))) continue;
      const contentHash = await stableSha256(snapshot.content);
      taskAnchorAttachments.push({
        schema: 'eyon.retrieval.task-anchor-attachment.v1',
        attachmentId: `attachment:${encodeURIComponent(entity.entityId)}:${contentHash}`,
        entityId: entity.entityId,
        canonicalName: entity.canonicalName,
        sourceId: snapshot.logicalId,
        snapshotId: snapshot.snapshotId,
        sourceType: snapshot.sourceType,
        title: snapshot.title,
        content: snapshot.content,
        contentHash,
        charCount: snapshot.content.length,
        purpose: direct ? 'direct-character-entry' : 'cast-character-entry',
      });
    }
  }
  return {
    personCanonViews,
    taskAnchorAttachments: dedupeAttachments(taskAnchorAttachments),
  };
}

function buildPersonCanonView(
  entity: KnowledgeEntity,
  taskType: RetrievalTaskType,
  normalizedQuery: string,
  direct: boolean,
): PersonCanonView {
  const characterFacts = entity.characterFacts!;
  const queryMatched = characterFacts.facts.filter(fact =>
    normalizedQuery.includes(normalizeRetrievalText(fact.object))
    || normalizedQuery.includes(normalizeRetrievalText(fact.statement)));
  const baselineIds = taskType === 'genealogy'
    ? [...characterFacts.identityFactIds, ...characterFacts.relationFactIds]
    : taskType === 'biography'
      ? [
        ...characterFacts.identityFactIds,
        ...characterFacts.relationFactIds,
        ...characterFacts.lifeEventFactIds,
        ...characterFacts.currentStateFactIds,
      ]
      : [
        ...characterFacts.identityFactIds,
        ...characterFacts.lifeEventFactIds,
        ...characterFacts.currentStateFactIds,
      ];
  const requiredFactIds = direct
    ? uniqueStrings([...baselineIds, ...queryMatched.map(fact => fact.factId)])
    : uniqueStrings([...characterFacts.identityFactIds, ...queryMatched.map(fact => fact.factId)]);
  const relevantFactIds = uniqueStrings([
    ...requiredFactIds,
    ...characterFacts.relationFactIds,
    ...characterFacts.lifeEventFactIds,
    ...characterFacts.currentStateFactIds,
  ]);
  const factsById = new Map(characterFacts.facts.map(fact => [fact.factId, fact]));
  const facts = uniqueStrings([...requiredFactIds, ...relevantFactIds])
    .map(factId => factsById.get(factId))
    .filter((fact): fact is CanonFact => Boolean(fact))
    .slice(0, 64);
  const retainedIds = new Set(facts.map(fact => fact.factId));
  return {
    schema: 'eyon.retrieval.person-canon-view.v1',
    entityId: entity.entityId,
    canonicalName: entity.canonicalName,
    aliases: [...entity.aliases],
    requiredFactIds: requiredFactIds.filter(id => facts.some(fact => fact.factId === id)),
    relevantFactIds: facts.map(fact => fact.factId),
    eventRelations: characterFacts.eventRelations.filter(relation =>
      retainedIds.has(relation.fromFactId) && retainedIds.has(relation.toFactId)),
    facts,
    sourceSnapshotIds: uniqueStrings(facts.flatMap(fact => fact.sourceSnapshotIds)),
  };
}

function extractFieldFacts(entity: KnowledgeEntity, snapshot: SourceSnapshot, output: CanonFact[]): void {
  const fieldPattern = /^[ \t]*(?:[-*][ \t]*)?([^:：<>\[\]{}\r\n]{2,20})[:：][ \t]*(.+?)[ \t]*$/gmu;
  for (const match of snapshot.content.matchAll(fieldPattern)) {
    const label = match[1]!.trim();
    const value = match[2]!.trim();
    // Explicit authored metadata only. Ordinary prose remains open evidence for the model.
    if (label === '持续状态') {
      try {
        const state = ContinuousStateSchema.safeParse(JSON.parse(value));
        if (state.success) {
          const fact = makeFact(entity, snapshot, `continuous:${state.data.dimension}`, state.data.value,
            `${state.data.start}：${state.data.value}`, {
              snapshotId: snapshot.snapshotId, startOffset: match.index!, endOffset: match.index! + match[0].length,
            });
          fact.factId += `:${compactStableId(value)}`;
          fact.temporalScope = state.data.start;
          fact.continuousState = state.data;
          output.push(fact);
        }
      } catch { /* Bad optional metadata cannot hide the underlying source passage. */ }
      continue;
    }
    if (GENERIC_RELATION_FIELD.test(label) && value) {
      output.push(...extractGenericRelationFacts(entity, snapshot, value, match.index!));
      continue;
    }
    const predicate = IDENTITY_FIELDS[label] ?? RELATION_FIELDS[label] ?? CURRENT_STATE_FIELDS[label];
    if (!predicate || !value) continue;
    const startOffset = match.index!;
    output.push(makeFact(entity, snapshot, predicate, value, `${label}：${value}`, {
      snapshotId: snapshot.snapshotId,
      startOffset,
      endOffset: startOffset + match[0].length,
    }));
  }
}

function extractGenericRelationFacts(
  entity: KnowledgeEntity,
  snapshot: SourceSnapshot,
  value: string,
  fieldStartOffset: number,
): CanonFact[] {
  const output: CanonFact[] = [];
  for (const rawPart of value.split(/[、，,；;\n]/u)) {
    const part = rawPart.trim();
    if (!part) continue;
    const suffix = part.match(/^(.{1,48}?)[（(]([^）)]{1,12})[）)]$/u);
    const prefix = part.match(/^([^:：]{1,12})[:：]\s*(.{1,48})$/u);
    const relationLabel = (suffix?.[2] ?? prefix?.[1] ?? '').trim();
    const personName = (suffix?.[1] ?? prefix?.[2] ?? '').trim();
    const predicate = RELATION_LABEL_PREDICATES[relationLabel];
    if (!predicate || !personName) continue;
    const relativeOffset = value.indexOf(rawPart);
    output.push(makeFact(
      entity,
      snapshot,
      predicate,
      personName,
      `${relationLabel}：${personName}`,
      {
        snapshotId: snapshot.snapshotId,
        startOffset: fieldStartOffset + Math.max(relativeOffset, 0),
        endOffset: fieldStartOffset + Math.max(relativeOffset, 0) + rawPart.length,
      },
    ));
  }
  return output;
}

function extractEventFacts(entity: KnowledgeEntity, snapshot: SourceSnapshot, output: CanonFact[]): void {
  for (const rule of EVENT_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of snapshot.content.matchAll(rule.pattern)) {
      const built = rule.build(match);
      const startOffset = match.index!;
      output.push(makeFact(entity, snapshot, built.predicate, built.object, built.statement, {
        snapshotId: snapshot.snapshotId,
        startOffset,
        endOffset: startOffset + match[0].length,
      }, {
        spatialScope: built.spatialScope,
        epistemicStatus: built.epistemicStatus,
        confidence: built.confidence,
      }));
    }
  }
}

function makeFact(
  entity: KnowledgeEntity,
  snapshot: SourceSnapshot,
  predicate: string,
  object: string,
  statement: string,
  span: KnowledgeSpan,
  options: {
    spatialScope?: string;
    epistemicStatus?: CanonFactEpistemicStatus;
    confidence?: CanonFactConfidence;
  } = {},
): CanonFact {
  const stableKey = [entity.entityId, predicate, normalizeRetrievalText(object), snapshot.logicalId].join('|');
  return {
    factId: `fact:${compactStableId(stableKey)}`,
    subjectEntityId: entity.entityId,
    predicate,
    object,
    statement,
    temporalScope: sentenceAround(snapshot.content, span)
      .match(/[\p{Script=Han}]{2,8}纪元(?:前)?\s*\d{1,6}\s*年/u)?.[0] ?? null,
    spatialScope: options.spatialScope ?? null,
    epistemicStatus: options.epistemicStatus ?? 'explicit',
    confidence: options.confidence ?? 'high',
    sourceRefs: [snapshot.logicalId],
    sourceSnapshotIds: [snapshot.snapshotId],
    sourceSpans: [span],
    revisionIntroduced: 0,
    revisionRetired: null,
  };
}

function isCharacterEntry(snapshot: SourceSnapshot, entity: KnowledgeEntity): boolean {
  const candidates = [entity.canonicalName, ...entity.aliases].map(normalizeRetrievalText);
  const reference = characterReferenceIdentity(snapshot);
  if (reference) return candidates.includes(normalizeRetrievalText(reference.name));
  const title = normalizeRetrievalText(snapshot.title);
  if (snapshot.sourceType === 'mvu' && candidates.some(name => title.includes(name))) return true;
  if (candidates.some(name => title.includes(name))) return true;
  return candidates.some(name => {
    const raw = [entity.canonicalName, ...entity.aliases]
      .find(candidate => normalizeRetrievalText(candidate) === name);
    return raw ? new RegExp(`^\\s*${escapeRegExp(raw)}\\s*[:：]`, 'mu').test(snapshot.content) : false;
  });
}

function dedupeFacts(facts: CanonFact[]): CanonFact[] {
  const byId = new Map<string, CanonFact>();
  for (const fact of facts) {
    const existing = byId.get(fact.factId);
    if (!existing) {
      byId.set(fact.factId, fact);
      continue;
    }
    existing.sourceSnapshotIds = uniqueStrings([...existing.sourceSnapshotIds, ...fact.sourceSnapshotIds]);
    for (const span of fact.sourceSpans) {
      if (!existing.sourceSpans.some(item => sameSpan(item, span))) existing.sourceSpans.push(span);
    }
  }
  return [...byId.values()].sort(compareFactsBySource);
}

function buildEventRelations(
  facts: CanonFact[],
  snapshotsById: Map<string, SourceSnapshot>,
): CanonEventRelation[] {
  const eventPredicates = new Set([
    'departed_from', 'person_selected_for_duty', 'arrived_at', 'received_from',
  ]);
  const events = facts.filter(fact => eventPredicates.has(fact.predicate));
  const relations: CanonEventRelation[] = [];
  for (const arrival of events.filter(fact => fact.predicate === 'arrived_at')) {
    const arrivalSpan = arrival.sourceSpans[0];
    const snapshot = arrivalSpan ? snapshotsById.get(arrivalSpan.snapshotId) : undefined;
    if (!arrivalSpan || !snapshot) continue;
    const raw = snapshot.content.slice(arrivalSpan.startOffset, arrivalSpan.endOffset);
    if (!/^后来/u.test(raw.trim())) continue;
    const prior = events
      .filter(fact => fact.factId !== arrival.factId)
      .filter(fact => fact.sourceSpans.some(span =>
        span.snapshotId === arrivalSpan.snapshotId && span.endOffset <= arrivalSpan.startOffset))
      .sort(compareFactsBySource);
    const nearest = prior.at(-1);
    if (nearest) {
      relations.push(makeEventRelation(
        nearest.factId,
        arrival.factId,
        'before',
        'explicit',
        'high',
        '原文使用“后来”把抵达事件置于前述最近事件之后',
      ));
    }
    for (const departure of prior.filter(fact => fact.predicate === 'departed_from')) {
      relations.push(makeEventRelation(
        departure.factId,
        arrival.factId,
        'before',
        'structural',
        'high',
        '同一人物先离开原地，随后抵达另一地点',
      ));
    }
  }
  const dated = events.flatMap(fact => {
    const parsed = parseTemporalScope(fact.temporalScope);
    return parsed ? [{ fact, ...parsed }] : [];
  });
  for (let left = 0; left < dated.length; left += 1) {
    for (let right = left + 1; right < dated.length; right += 1) {
      const a = dated[left]!;
      const b = dated[right]!;
      if (a.era !== b.era || a.year === b.year) continue;
      const earlier = a.year < b.year ? a.fact : b.fact;
      const later = a.year < b.year ? b.fact : a.fact;
      relations.push(makeEventRelation(
        earlier.factId,
        later.factId,
        'before',
        'explicit',
        'high',
        '事件原文给出了同一纪元内可比较的明确年份',
      ));
    }
  }
  return [...new Map(relations.map(relation => [relation.relationId, relation])).values()]
    .sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function makeEventRelation(
  fromFactId: string,
  toFactId: string,
  relation: CanonEventRelation['relation'],
  epistemicStatus: CanonEventRelation['epistemicStatus'],
  confidence: CanonFactConfidence,
  rationale: string,
): CanonEventRelation {
  const stableKey = [fromFactId, relation, toFactId].join('|');
  return {
    relationId: `event-relation:${compactStableId(stableKey)}`,
    fromFactId,
    toFactId,
    relation,
    epistemicStatus,
    confidence,
    rationale,
    sourceFactIds: [fromFactId, toFactId],
  };
}

function parseTemporalScope(value: string | null): { era: string; year: number } | null {
  const match = value?.match(/^([\p{Script=Han}]{2,8}纪元)\s*(前)?\s*(\d{1,6})\s*年$/u);
  if (!match) return null;
  const year = Number(match[3]);
  return { era: match[1]!, year: match[2] ? -year : year };
}

function sentenceAround(content: string, span: KnowledgeSpan): string {
  const before = content.slice(0, span.startOffset);
  const after = content.slice(span.endOffset);
  const previousBoundary = Math.max(
    before.lastIndexOf('。'), before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf('\n'),
  );
  const nextOffsets = ['。', '！', '？', '\n']
    .map(mark => after.indexOf(mark))
    .filter(offset => offset >= 0);
  const nextBoundary = nextOffsets.length ? Math.min(...nextOffsets) : after.length;
  return content.slice(previousBoundary + 1, span.endOffset + nextBoundary + 1);
}

function compareFactsBySource(left: CanonFact, right: CanonFact): number {
  const leftSpan = left.sourceSpans[0];
  const rightSpan = right.sourceSpans[0];
  return (leftSpan?.snapshotId ?? '').localeCompare(rightSpan?.snapshotId ?? '')
    || (leftSpan?.startOffset ?? 0) - (rightSpan?.startOffset ?? 0)
    || left.factId.localeCompare(right.factId);
}

function dedupeAttachments(items: TaskAnchorAttachment[]): TaskAnchorAttachment[] {
  return [...new Map(items.map(item => [item.attachmentId, item])).values()]
    .sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
}

function idsFor(facts: CanonFact[], predicate: (fact: CanonFact) => boolean): string[] {
  return facts.filter(predicate).map(fact => fact.factId);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function sameSpan(left: KnowledgeSpan, right: KnowledgeSpan): boolean {
  return left.snapshotId === right.snapshotId
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

function compactStableId(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ code, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, '0')}${right.toString(16).padStart(8, '0')}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeRetrievalText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}
