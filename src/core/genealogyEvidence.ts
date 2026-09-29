import type { GenealogyContextBundle } from './context.ts';
import type { GenealogyGenerationInput, GenealogyResult } from '../schemas/genealogy.ts';
import type { CanonFact, PersonCanonView } from '../retrieval/contracts.ts';
import { extractRecordedAge } from '../retrieval/catalog.ts';
import { parseWorldTime } from '../retrieval/temporal.ts';
import type { GenealogyLocalEvidence } from './genealogyLocalView.ts';

type RelationType = GenealogyResult['edges'][number]['relationType'];

export interface GenealogyEvidencePerson {
  canonicalName: string;
  aliases: string[];
  sourceRefs: string[];
  factIds: string[];
  isFocus: boolean;
}

export interface GenealogyEvidenceRelation {
  fromName: string;
  toName: string;
  relationType: RelationType;
  sourceRefs: string[];
  factIds: string[];
}

export interface GenealogyEvidenceRoster {
  /**
   * The roster locks facts that are already authoritative. It is deliberately
   * not an admission allow-list: a sparse source may still be completed with
   * clearly generated, low-authority relatives.
   */
  policy:
    | 'authoritative-kinship-locks-with-generated-fill'
    | 'existing-people-and-explicit-kinship-only';
  persons: GenealogyEvidencePerson[];
  relations: GenealogyEvidenceRelation[];
}

export interface GenealogyFocusChronologyPolicy {
  mode:
    | 'canon-explicit'
    | 'worldbook-explicit'
    | 'worldbook-age'
    | 'mvu-explicit'
    | 'mvu-age'
    | 'model-inferred';
  worldbookEntryFound: boolean;
  birth: { era: string; year: number } | null;
  ageAtBaseline: number | null;
  basedOn: { era: string; year: number } | null;
  sourceRefs: string[];
  instruction: string;
}

const RELATION_DIRECTIONS: Readonly<Record<string, {
  from: 'subject' | 'object';
  relationType: RelationType;
  inverseType?: RelationType;
}>> = {
  father: { from: 'object', relationType: 'parent', inverseType: 'child' },
  mother: { from: 'object', relationType: 'parent', inverseType: 'child' },
  parent: { from: 'object', relationType: 'parent', inverseType: 'child' },
  son: { from: 'subject', relationType: 'parent', inverseType: 'child' },
  daughter: { from: 'subject', relationType: 'parent', inverseType: 'child' },
  child: { from: 'subject', relationType: 'parent', inverseType: 'child' },
  older_sister: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  younger_sister: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  older_brother: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  younger_brother: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  brother: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  sister: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  sibling: { from: 'subject', relationType: 'sibling', inverseType: 'sibling' },
  spouse: { from: 'subject', relationType: 'spouse', inverseType: 'spouse' },
  adoptive_parent: { from: 'object', relationType: 'adoptiveParent', inverseType: 'adoptiveChild' },
  adoptive_child: { from: 'subject', relationType: 'adoptiveParent', inverseType: 'adoptiveChild' },
  grandparent: { from: 'object', relationType: 'grandparent', inverseType: 'grandchild' },
  grandchild: { from: 'subject', relationType: 'grandparent', inverseType: 'grandchild' },
  uncle_aunt: { from: 'object', relationType: 'uncleAunt', inverseType: 'nephewNiece' },
  nephew_niece: { from: 'subject', relationType: 'uncleAunt', inverseType: 'nephewNiece' },
  cousin: { from: 'subject', relationType: 'cousin', inverseType: 'cousin' },
};

export function buildGenealogyEvidenceRoster(
  input: GenealogyGenerationInput,
  context: GenealogyContextBundle,
): GenealogyEvidenceRoster {
  const people = new Map<string, GenealogyEvidencePerson>();
  const aliases = new Map<string, string>();
  const relations: GenealogyEvidenceRelation[] = [];
  const focusSourceRefs = context.sourceIndex
    .filter(source => source.sourceId === `mvu-character:${input.focusCharacter.mvuId}`)
    .map(source => source.sourceId);

  addPerson(people, aliases, {
    canonicalName: input.focusCharacter.name,
    aliases: input.focusCharacter.aliases,
    sourceRefs: focusSourceRefs,
    factIds: [],
    isFocus: true,
  });

  const views = context.evidenceBundle.canonResolvedView?.personViews ?? context.evidenceBundle.personCanonViews ?? [];
  for (const view of views) {
    addPerson(people, aliases, personFromView(
      view,
      input.focusCharacter.name,
      context,
    ));
  }
  for (const view of views) {
    for (const fact of view.facts) {
      const direction = RELATION_DIRECTIONS[fact.predicate];
      if (!direction || !isEligibleFact(fact)) continue;
      const sourceRefs = taskSourceRefs(fact, context);
      if (sourceRefs.length === 0) continue;
      for (const objectName of splitRelationNames(fact.object)) {
        addPerson(people, aliases, {
          canonicalName: objectName,
          aliases: [],
          sourceRefs,
          factIds: [fact.factId],
          isFocus: normalize(objectName) === normalize(input.focusCharacter.name),
        });
        const subject = canonicalFor(aliases, view.canonicalName);
        const object = canonicalFor(aliases, objectName);
        const fromName = direction.from === 'subject' ? subject : object;
        const toName = direction.from === 'subject' ? object : subject;
        addRelation(relations, {
          fromName,
          toName,
          relationType: direction.relationType,
          sourceRefs,
          factIds: [fact.factId],
        });
        if (direction.inverseType) {
          addRelation(relations, {
            fromName: toName,
            toName: fromName,
            relationType: direction.inverseType,
            sourceRefs,
            factIds: [fact.factId],
          });
        }
      }
    }
  }

  const focusName = canonicalFor(aliases, input.focusCharacter.name);
  const connected = connectedPeople(focusName, relations);
  return {
    policy: 'authoritative-kinship-locks-with-generated-fill',
    persons: [...people.values()].filter(person => connected.has(person.canonicalName)),
    relations: relations.filter(relation =>
      connected.has(relation.fromName) && connected.has(relation.toName)
    ),
  };
}

/**
 * 中心 MVU 人物的出生原点只在谱系任务内派生，不写回 Canon：
 * 当前 revision 的明确出生事实优先；其次读取匹配人物的世界书整条目；
 * 再退到 MVU 整条目；两者都没有可计算时间时才让模型给出低权约年。
 */
export function resolveGenealogyFocusChronology(
  input: GenealogyGenerationInput,
  context: GenealogyContextBundle,
): GenealogyFocusChronologyPolicy {
  const focusNames = new Set(
    [input.focusCharacter.name, ...input.focusCharacter.aliases].map(normalize),
  );
  const views = context.evidenceBundle.canonResolvedView?.personViews
    ?? context.evidenceBundle.personCanonViews
    ?? [];
  const view = views.find(candidate =>
    [candidate.canonicalName, ...candidate.aliases]
      .some(name => focusNames.has(normalize(name)))
  );
  const activeBirth = [...(view?.facts ?? [])]
    .filter(fact => fact.predicate === 'birth_time'
      && ['explicit', 'structural', 'user-asserted'].includes(fact.epistemicStatus))
    .sort((left, right) => right.revisionIntroduced - left.revisionIntroduced)
    .map(fact => ({ fact, point: parseWorldTime(fact.object) }))
    .find(item => item.point.era && item.point.year !== null);
  if (activeBirth?.point.era && activeBirth.point.year !== null) {
    return {
      mode: 'canon-explicit',
      worldbookEntryFound: focusAttachments(context, focusNames, 'worldbook').length > 0,
      birth: { era: activeBirth.point.era, year: activeBirth.point.year },
      ageAtBaseline: null,
      basedOn: null,
      sourceRefs: taskSourceRefs(activeBirth.fact, context),
      instruction: '采用当前 Canon 已生效的明确出生原点，不得改写。',
    };
  }

  const worldbook = focusAttachments(context, focusNames, 'worldbook');
  const worldbookPolicy = chronologyFromAttachments(
    worldbook,
    context,
    'worldbook-explicit',
    'worldbook-age',
  );
  if (worldbookPolicy) return { ...worldbookPolicy, worldbookEntryFound: true };

  const mvu = focusAttachments(context, focusNames, 'mvu');
  const mvuPolicy = chronologyFromAttachments(
    mvu,
    context,
    'mvu-explicit',
    'mvu-age',
  );
  if (mvuPolicy) {
    return { ...mvuPolicy, worldbookEntryFound: worldbook.length > 0 };
  }

  return {
    mode: 'model-inferred',
    worldbookEntryFound: worldbook.length > 0,
    birth: null,
    ageAtBaseline: null,
    basedOn: parseBaseline(view, context),
    sourceRefs: worldbook.map(item => item.sourceId),
    instruction: worldbook.length
      ? '世界书人物条目没有可直接换算的年龄或生年；结合该条目、MVU资料与亲属代际推断一个约略出生年。'
      : '没有匹配的世界书人物条目；结合MVU资料、现世年份与亲属代际推断一个约略出生年。',
  };
}

function focusAttachments(
  context: GenealogyContextBundle,
  focusNames: Set<string>,
  sourceType: 'worldbook' | 'mvu',
) {
  return (context.evidenceBundle.taskAnchorAttachments ?? []).filter(attachment =>
    attachment.sourceType === sourceType
    && focusNames.has(normalize(attachment.canonicalName))
  );
}

function chronologyFromAttachments(
  attachments: ReturnType<typeof focusAttachments>,
  context: GenealogyContextBundle,
  explicitMode: 'worldbook-explicit' | 'mvu-explicit',
  ageMode: 'worldbook-age' | 'mvu-age',
): GenealogyFocusChronologyPolicy | null {
  if (!attachments.length) return null;
  const explicit = uniquePoints(attachments.flatMap(attachment => {
    const point = explicitBirth(attachment.content);
    return point ? [point] : [];
  }));
  if (explicit.length === 1) {
    return {
      mode: explicitMode,
      worldbookEntryFound: explicitMode === 'worldbook-explicit',
      birth: explicit[0],
      ageAtBaseline: null,
      basedOn: null,
      sourceRefs: unique(attachments.map(item => item.sourceId)),
      instruction: `${explicitMode.startsWith('worldbook') ? '世界书' : 'MVU'}人物条目明确记载出生年，必须采用。`,
    };
  }
  const ages = uniqueNumbers(attachments.flatMap(attachment => {
    const age = recordedAge(attachment.content);
    return age === null ? [] : [age];
  }));
  const baseline = baselineFromContext(context);
  if (explicit.length === 0 && ages.length === 1 && baseline && ages[0] <= baseline.year) {
    return {
      mode: ageMode,
      worldbookEntryFound: ageMode === 'worldbook-age',
      birth: { era: baseline.era, year: baseline.year - ages[0] },
      ageAtBaseline: ages[0],
      basedOn: baseline,
      sourceRefs: unique(attachments.map(item => item.sourceId)),
      instruction: `按${ageMode.startsWith('worldbook') ? '世界书' : 'MVU'}人物条目的实际年龄和锁定现世年份反推出生年；这是谱系内的约年，不冒充原文精确日期。`,
    };
  }
  return null;
}

function explicitBirth(content: string): { era: string; year: number } | null {
  const field = content.match(
    /(?:^|[\n\r,{，]|\\n)\s*["']?(?:出生(?:时间|日期|年份)?|生年|生卒(?:年)?)["']?\s*[:：]\s*["']?([^"'\n\r,，}]{1,100})/u,
  )?.[1];
  const parsed = parseWorldTime(field);
  return parsed.era && parsed.year !== null
    ? { era: parsed.era, year: parsed.year }
    : null;
}

function recordedAge(content: string): number | null {
  const field = content.match(
    /(?:^|[\n\r,{，]|\\n)\s*["']?(?:实际年龄|年龄)["']?\s*[:：]\s*["']?([^"'\n\r,，}]{1,40})/u,
  )?.[1];
  if (!field) return null;
  return extractRecordedAge(field) ?? null;
}

function baselineFromContext(
  context: GenealogyContextBundle,
): { era: string; year: number } | null {
  const current = parseWorldTime(context.currentWorld.time);
  if (current.era && current.year !== null) {
    return { era: current.era, year: current.year };
  }
  const views = context.evidenceBundle.canonResolvedView?.personViews
    ?? context.evidenceBundle.personCanonViews
    ?? [];
  for (const view of views) {
    if (view.lifespan?.basedOnEra && view.lifespan.basedOnYear !== undefined) {
      return { era: view.lifespan.basedOnEra, year: view.lifespan.basedOnYear };
    }
  }
  return null;
}

function parseBaseline(
  view: PersonCanonView | undefined,
  context: GenealogyContextBundle,
): { era: string; year: number } | null {
  if (view?.lifespan?.basedOnEra && view.lifespan.basedOnYear !== undefined) {
    return { era: view.lifespan.basedOnEra, year: view.lifespan.basedOnYear };
  }
  return baselineFromContext(context);
}

function uniquePoints(values: Array<{ era: string; year: number }>) {
  return [...new Map(values.map(value => [`${value.era}:${value.year}`, value])).values()];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

export function resolveRosterPerson(
  roster: GenealogyEvidenceRoster,
  name: string,
): GenealogyEvidencePerson | null {
  const normalized = normalize(name);
  const matches = roster.persons.filter(person =>
    [person.canonicalName, ...person.aliases].some(candidate => normalize(candidate) === normalized)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function captureGenealogyLocalEvidence(result: GenealogyResult, context: GenealogyContextBundle): GenealogyLocalEvidence {
  const views = context.evidenceBundle.canonResolvedView?.personViews ?? context.evidenceBundle.personCanonViews ?? [];
  const nodes = result.nodes.flatMap(node => {
    const matches = views.filter(view => [view.canonicalName, ...view.aliases].some(name => normalize(name) === normalize(node.name)));
    return matches.length === 1 ? [{ nodeId: node.id, entityId: matches[0].entityId }] : [];
  });
  const ids = new Set(nodes.map(node => node.entityId));
  const facts = views.filter(view => ids.has(view.entityId)).flatMap(view => view.facts)
    .filter(fact => ['birth_time', 'death_time', ...Object.keys(RELATION_DIRECTIONS)].includes(fact.predicate))
    .map(({ factId, subjectEntityId, predicate, object, temporalScope, epistemicStatus }) => ({ factId, subjectEntityId, predicate, object, temporalScope, epistemicStatus }));
  return { nodes, facts: [...new Map(facts.map(fact => [fact.factId, fact])).values()] };
}

export function findRosterRelation(
  roster: GenealogyEvidenceRoster,
  fromName: string,
  toName: string,
  relationType: RelationType,
): GenealogyEvidenceRelation | null {
  const from = resolveRosterPerson(roster, fromName)?.canonicalName ?? fromName;
  const to = resolveRosterPerson(roster, toName)?.canonicalName ?? toName;
  return roster.relations.find(relation =>
    relation.fromName === from
    && relation.toName === to
    && relation.relationType === relationType
  ) ?? null;
}

function personFromView(
  view: PersonCanonView,
  focusName: string,
  context: GenealogyContextBundle,
): GenealogyEvidencePerson {
  return {
    canonicalName: view.canonicalName,
    aliases: view.aliases,
    sourceRefs: unique(view.facts.flatMap(fact => taskSourceRefs(fact, context))),
    factIds: unique(view.facts.map(fact => fact.factId)),
    isFocus: normalize(view.canonicalName) === normalize(focusName),
  };
}

function taskSourceRefs(
  fact: CanonFact,
  context: GenealogyContextBundle,
): string[] {
  const selectedSourceIds = new Set(context.sourceIndex.map(source => source.sourceId));
  const snapshotIds = new Set(fact.sourceSnapshotIds);
  return unique([
    ...fact.sourceRefs.filter(sourceRef => selectedSourceIds.has(sourceRef)),
    ...context.evidenceBundle.passages
      .filter(passage => snapshotIds.has(passage.snapshotId))
      .map(passage => passage.sourceId)
      .filter(sourceId => selectedSourceIds.has(sourceId)),
  ]);
}

function isEligibleFact(fact: CanonFact): boolean {
  return fact.sourceRefs.length > 0
    && ['explicit', 'structural', 'user-asserted'].includes(fact.epistemicStatus);
}

function splitRelationNames(value: string): string[] {
  return unique(value
    .split(/[、，,；;\n]/u)
    .map(part => part.trim().replace(/[（(][^）)]{1,24}[）)]$/u, '').trim())
    .filter(part => part.length >= 1 && part.length <= 48));
}

function addPerson(
  people: Map<string, GenealogyEvidencePerson>,
  aliases: Map<string, string>,
  incoming: GenealogyEvidencePerson,
): void {
  const canonicalName = incoming.canonicalName.trim();
  if (!canonicalName) return;
  const existingCanonical = aliases.get(normalize(canonicalName));
  const key = existingCanonical ?? canonicalName;
  const current = people.get(key);
  const merged = current
    ? {
      ...current,
      aliases: unique([...current.aliases, ...incoming.aliases]),
      sourceRefs: unique([...current.sourceRefs, ...incoming.sourceRefs]),
      factIds: unique([...current.factIds, ...incoming.factIds]),
      isFocus: current.isFocus || incoming.isFocus,
    }
    : { ...incoming, canonicalName, aliases: unique(incoming.aliases) };
  people.set(key, merged);
  aliases.set(normalize(merged.canonicalName), merged.canonicalName);
  for (const alias of merged.aliases) aliases.set(normalize(alias), merged.canonicalName);
}

function canonicalFor(aliases: Map<string, string>, name: string): string {
  return aliases.get(normalize(name)) ?? name.trim();
}

function addRelation(
  relations: GenealogyEvidenceRelation[],
  incoming: GenealogyEvidenceRelation,
): void {
  const current = relations.find(relation =>
    relation.fromName === incoming.fromName
    && relation.toName === incoming.toName
    && relation.relationType === incoming.relationType
  );
  if (!current) {
    relations.push(incoming);
    return;
  }
  current.sourceRefs = unique([...current.sourceRefs, ...incoming.sourceRefs]);
  current.factIds = unique([...current.factIds, ...incoming.factIds]);
}

function connectedPeople(
  focusName: string,
  relations: GenealogyEvidenceRelation[],
): Set<string> {
  const connected = new Set([focusName]);
  const queue = [focusName];
  while (queue.length) {
    const current = queue.shift()!;
    for (const relation of relations) {
      const next = relation.fromName === current
        ? relation.toName
        : relation.toName === current
          ? relation.fromName
          : null;
      if (!next || connected.has(next)) continue;
      connected.add(next);
      queue.push(next);
    }
  }
  return connected;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
