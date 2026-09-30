import type { GenealogyContextBundle } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  GenealogyErrorSchema,
  GenealogyResultSchema,
  type GenealogyGenerationInput,
  type GenealogyResult,
} from '../schemas/genealogy.ts';
import { parseWorldTime } from '../retrieval/temporal.ts';
import { biologicalEdge, biologicalFamilyIds, genealogyFamilyView, hasOriginFamily, hasOrdinaryGenerationChronology, isDualTrack } from '../core/genealogyIdentity.ts';
import { setLifeDate, unknownDate } from '../core/genealogyLocalView.ts';
import { historyReferencesForPerson } from '../runtime/genealogyContinuity.ts';
import {
  extendTaskCitationRegistry,
  resolveTaskCitationValues,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import {
  buildGenealogyEvidenceRoster,
  findRosterRelation,
  resolveGenealogyFocusChronology,
  resolveRosterPerson,
  type GenealogyEvidenceRoster,
} from '../core/genealogyEvidence.ts';

export class GenealogyValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'GENEALOGY_INVALID') {
    super(message);
    this.name = 'GenealogyValidationError';
    this.code = code;
  }
}

export function parseAndValidateGenealogy(
  raw: string,
  expected: {
    requestId: string;
    input: GenealogyGenerationInput;
    context: GenealogyContextBundle;
    directive?: string;
    onWarning?(warning: string): void;
  },
): GenealogyResult {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.genealogy.v2',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new GenealogyValidationError(
      error instanceof Error ? error.message : 'Genealogy response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }
  parsed = normalizeGenealogyModelPlaceholders(parsed);
  if (isGenealogyContextEcho(parsed)) {
    throw new GenealogyValidationError(
      '宗族生成模型回显了只读资料包，而不是 eyon.genealogy.v2 结果',
      'CONTEXT_ECHO',
    );
  }
  ensureRawProfiles(parsed);

  const apiError = GenealogyErrorSchema.safeParse(parsed);
  if (apiError.success) {
    if (apiError.data.requestId && apiError.data.requestId !== expected.requestId) {
      throw new GenealogyValidationError('Genealogy error requestId mismatch', 'REQUEST_MISMATCH');
    }
    throw new GenealogyValidationError(apiError.data.error.message, apiError.data.error.code);
  }

  const result = GenealogyResultSchema.safeParse(parsed);
  if (!result.success) {
    throw new GenealogyValidationError(result.error.message, 'SCHEMA_INVALID');
  }
  const genealogy = result.data;
  const requestedKind = expected.input.lineageKind;
  const focusIdentityNode = genealogy.nodes.find(node => node.isFocus);
  if (focusIdentityNode && requestedKind && requestedKind !== 'auto') {
    if (focusIdentityNode.identity && focusIdentityNode.identity.lineageKind !== requestedKind) {
      throw new GenealogyValidationError('谱系身份类型与选定类型不符', 'IDENTITY_POLICY_MISMATCH');
    }
    focusIdentityNode.identity ??= { lineageKind: requestedKind, note: '特殊身份时间轨待考，未用本界年龄硬推生年。' };
  }
  const knownSourceIds = expected.context.sourceIndex.map(source => source.sourceId);
  const citationRegistry = extendTaskCitationRegistry(
    taskCitationRegistry(expected.context.evidenceBundle),
    knownSourceIds,
  );
  for (const node of genealogy.nodes) {
    normalizeOptionalDates(node, expected.onWarning);
    node.sourceRefs = resolveGenealogySourceRefs(
      citationRegistry,
      node.sourceRefs,
      knownSourceIds,
      expected.onWarning,
    );
  }
  for (const edge of genealogy.edges) {
    edge.sourceRefs = resolveGenealogySourceRefs(
      citationRegistry,
      edge.sourceRefs,
      knownSourceIds,
      expected.onWarning,
    );
  }
  if (genealogy.requestId !== expected.requestId) {
    throw new GenealogyValidationError('Genealogy requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (
    genealogy.focusCharacterId !== expected.input.focusCharacter.mvuId
    || normalize(genealogy.focusCharacterName) !== normalize(expected.input.focusCharacter.name)
  ) {
    throw new GenealogyValidationError('Genealogy focus differs from the request', 'FOCUS_MISMATCH');
  }
  if (
    genealogy.depth.ancestors !== expected.input.depth.ancestors
    || genealogy.depth.descendants !== expected.input.depth.descendants
    || genealogy.depth.maxPerGeneration !== expected.input.depth.maxPerGeneration
  ) {
    throw new GenealogyValidationError('Genealogy depth differs from the request', 'DEPTH_MISMATCH');
  }

  const focusNodes = genealogy.nodes.filter(node => node.isFocus);
  if (
    focusNodes.length !== 1
    || focusNodes[0].mvuId !== expected.input.focusCharacter.mvuId
    || !focusNodes[0].isMvuCharacter
    || focusNodes[0].generation !== 0
  ) {
    throw new GenealogyValidationError('Genealogy must have exactly one valid MVU focus', 'FOCUS_INVALID');
  }

  const evidenceRoster = buildGenealogyEvidenceRoster(expected.input, expected.context);
  const focusChronology = resolveGenealogyFocusChronology(
    expected.input,
    expected.context,
  );
  const warn = (code: string, id: string) => expected.onWarning?.(`${code}:${id}`);
  const removed = new Set<string>();
  const generatedNodeIds = new Set<string>();
  const remappedNodeIds = new Map<string, string>();
  const personNodeIds = new Map<string, string>();
  const acceptedNodeIds = new Set<string>();
  const preparedNodes: GenealogyResult['nodes'] = [];
  for (const node of genealogy.nodes) {
    const person = resolveRosterPerson(evidenceRoster, node.name);
    if (node.isFocus && !person) {
      throw new GenealogyValidationError('Focus is absent from the evidence roster', 'FOCUS_INVALID');
    }
    if (
      !node.isFocus
      && (node.generation < -expected.input.depth.ancestors
        || node.generation > expected.input.depth.descendants)
    ) {
      removed.add(node.id);
      warn('node-outside-requested-depth-omitted', node.id);
      continue;
    }
    node.canInjectToRuin = true;
    let personKey: string;
    if (person) {
      node.name = person.canonicalName;
      node.aliases = uniqueStrings([...node.aliases, ...person.aliases])
        .filter(alias => normalize(alias) !== normalize(node.name));
      node.provenance = 'explicit';
      if (!node.sourceRefs.some(ref => person.sourceRefs.includes(ref))) {
        node.sourceRefs = [...person.sourceRefs];
        warn('person-citations-restored', node.id);
      }
      const views = expected.context.evidenceBundle.canonResolvedView?.personViews ?? expected.context.evidenceBundle.personCanonViews ?? [];
      const matches = views.filter(view => [view.canonicalName, ...view.aliases].some(name => normalize(name) === normalize(node.name)));
      const view = matches.length === 1 ? matches[0] : undefined;
      for (const kind of ['birth', 'death'] as const) {
        if (isDualTrack(node)) {
          // Legacy birth/death belong to the body; arrival/soul/activation stay separate.
          const bodyDate = node.identity?.body?.[kind];
          if (bodyDate) node[kind] = structuredClone(bodyDate);
          else {
            const explicit = (view?.facts ?? []).filter(fact => fact.predicate === `${kind}_time`
              && ['explicit', 'structural', 'user-asserted'].includes(fact.epistemicStatus));
            const points = explicit.map(fact => parseWorldTime(fact.object)).filter(point => point.era && point.year !== null);
            const unique = new Map(points.map(point => [`${point.era}:${point.year}`, point]));
            if (unique.size === 1 && node.identity?.lineageKind !== 'creation') {
              const point = [...unique.values()][0];
              setLifeDate(node, kind, { era: point.era!, year: point.year! });
              node.identity!.body = { ...node.identity!.body, [kind]: structuredClone(node[kind]) };
            } else if (kind === 'birth' && node.isFocus) node.birth = unknownDate();
          }
          continue;
        }
        const predicate = kind === 'birth' ? 'birth_time' : 'death_time';
        const authoritative = (view?.facts ?? []).filter(fact => fact.predicate === predicate && ['explicit', 'structural', 'user-asserted'].includes(fact.epistemicStatus));
        const points = authoritative.map(fact => parseWorldTime(fact.object)).filter(value => value.era && value.year !== null);
        const distinct = new Map(points.map(value => [`${value.era}:${value.year}`, value]));
        const timelines = expected.context.evidenceBundle.personTimeline?.filter(candidate => normalize(candidate.name) === normalize(view?.canonicalName ?? node.name)) ?? [];
        const lifespan = view?.lifespan ?? (timelines.length === 1 ? timelines[0].lifespan : undefined);
        const fallback = kind === 'birth' ? (!lifespan?.ageBased && !lifespan?.arrivalBased ? lifespan?.born : undefined) : lifespan?.died;
        const point = distinct.size === 1 ? [...distinct.values()][0] : distinct.size === 0 ? fallback : undefined;
        const focusDerivedBirth = node.isFocus
          && kind === 'birth'
          && distinct.size === 0
          && focusChronology.birth;
        if (focusDerivedBirth) {
          const approximate = ['worldbook-age', 'mvu-age'].includes(focusChronology.mode);
          const expectedLabel = approximate
            ? `约${focusDerivedBirth.era}${focusDerivedBirth.year}年（${focusChronology.mode === 'worldbook-age' ? '按世界书年龄推算' : '按MVU年龄推算'}）`
            : `${focusDerivedBirth.era}${focusDerivedBirth.year}年`;
          const changed = node.birth.era !== focusDerivedBirth.era
            || node.birth.year !== focusDerivedBirth.year
            || node.birth.precision !== (approximate ? 'approximate' : 'exact')
            || node.birth.label !== expectedLabel;
          node.birth = {
            status: 'known',
            era: focusDerivedBirth.era as GenealogyResult['nodes'][number]['birth']['era'],
            year: focusDerivedBirth.year,
            month: null,
            day: null,
            precision: approximate ? 'approximate' : 'exact',
            label: expectedLabel,
          };
          if (changed) warn('focus-birth-derived-from-source', node.id);
          continue;
        }
        if (
          node.isFocus
          && kind === 'birth'
          && distinct.size === 0
          && focusChronology.mode === 'model-inferred'
        ) {
          if (node.birth.status !== 'known' || !node.birth.era || node.birth.year === null) {
            throw new GenealogyValidationError(
              'Focus birth must contain an approximate inferred year when no source age is available',
              'FOCUS_BIRTH_REQUIRED',
            );
          }
          if (
            focusChronology.basedOn
            && node.birth.era === focusChronology.basedOn.era
            && node.birth.year > focusChronology.basedOn.year
          ) {
            throw new GenealogyValidationError(
              'Focus inferred birth is later than the current world year',
              'FOCUS_BIRTH_INVALID',
            );
          }
          node.birth.precision = 'approximate';
          node.birth.month = null;
          node.birth.day = null;
          node.birth.label = `约${node.birth.era}${node.birth.year}年（谱系推断）`;
          warn('focus-birth-model-inferred', node.id);
          continue;
        }
        if (distinct.size > 1 || (!point && (kind === 'birth' || node.death.year !== null))) {
          if (node[kind].year !== null) {
            node.summary = '生卒依据不足，具体年代待考。';
            if (!node.isFocus) {
              node.profile.lifeExperience = '经历以当前有效史料为准；未沿用缺少生卒依据的短传。';
            }
            warn('life-date-uncertain', node.id);
          }
          node[kind] = kind === 'birth' ? unknownDate() : unknownDeathDate();
        } else if (point?.era && point.year !== null && (node[kind].era !== point.era || node[kind].year !== point.year || (parseWorldTime(node[kind].label).year !== null && parseWorldTime(node[kind].label).year !== point.year) || (kind === 'death' && node.death.status !== 'deceased'))) {
          setLifeDate(node, kind, { era: point.era, year: point.year });
          node.summary = '生卒已按当前权威资料校准。';
          if (!node.isFocus) {
            node.profile.lifeExperience = '经历以当前有效史料为准；本次未沿用与生卒冲突的短传。';
          }
          warn('life-date-corrected', node.id);
        }
      }
      node.historyRefs = historyReferencesForPerson(expected.context.historyReferenceCandidates ?? [], node.name, view?.entityId)
        .map(({ biographyId, stageId }) => ({ biographyId, stageId }));
      personKey = `locked:${normalize(person.canonicalName)}`;
    } else {
      node.provenance = 'generated';
      node.sourceRefs = [];
      node.historyRefs = [];
      node.isMvuCharacter = false;
      node.mvuId = '';
      const oldId = node.id;
      node.id = generatedNodeId(node.name, node.generation);
      remappedNodeIds.set(oldId, node.id);
      generatedNodeIds.add(node.id);
      normalizeGeneratedLifeDates(node, warn);
      personKey = `generated:${node.generation}:${normalize(node.name)}`;
    }
    const existingPersonNodeId = personNodeIds.get(personKey);
    if (existingPersonNodeId) {
      remappedNodeIds.set(node.id, existingPersonNodeId);
      removed.add(node.id);
      warn('duplicate-person-node-omitted', node.id);
      continue;
    }
    if (acceptedNodeIds.has(node.id)) {
      if (node.isFocus) throw new GenealogyValidationError('Focus node ID is duplicated', 'FOCUS_INVALID');
      removed.add(node.id);
      warn('duplicate-node-id-omitted', node.id);
      continue;
    }
    acceptedNodeIds.add(node.id);
    personNodeIds.set(personKey, node.id);
    preparedNodes.push(node);
  }

  // A dual family's independent rows do not consume each other's person limit.
  const edgeProjection = genealogy.edges.map(edge => ({ ...edge,
    from: remappedNodeIds.get(edge.from) ?? edge.from, to: remappedNodeIds.get(edge.to) ?? edge.to }));
  const uncapped = { ...genealogy, nodes: preparedNodes, edges: edgeProjection };
  const views = hasOriginFamily(uncapped)
    ? [genealogyFamilyView(uncapped, 'body'), genealogyFamilyView(uncapped, 'soul')] : [uncapped];
  const permittedNodes = new Set<string>();
  const memberships = views.map(view => new Set(view.nodes.map(node => node.id)));
  const counts = views.map(() => new Map<number, number>());
  const orderedNodes = [...preparedNodes].sort((left, right) => Number(right.isFocus) - Number(left.isFocus)
    || Number(generatedNodeIds.has(left.id)) - Number(generatedNodeIds.has(right.id)));
  for (const node of orderedNodes) {
    const memberOf = memberships.flatMap((ids, index) => ids.has(node.id) ? [index] : []);
    if (!memberOf.length || memberOf.some(index => (counts[index].get(node.generation) ?? 0) >= expected.input.depth.maxPerGeneration)) continue;
    permittedNodes.add(node.id);
    for (const index of memberOf) counts[index].set(node.generation, (counts[index].get(node.generation) ?? 0) + 1);
  }
  for (const node of preparedNodes) if (!permittedNodes.has(node.id)) {
    removed.add(node.id); warn(`generation-${node.generation}-overflow-omitted`, node.id);
  }
  genealogy.nodes = preparedNodes.filter(node => permittedNodes.has(node.id));
  const nodeById = new Map(genealogy.nodes.map(node => [node.id, node]));
  const edgeIds = new Set<string>();
  const edgeSignatures = new Set<string>();
  const preparedEdges: GenealogyResult['edges'] = [];
  for (const candidate of genealogy.edges) {
    const edge = structuredClone(candidate);
    edge.from = remappedNodeIds.get(edge.from) ?? edge.from;
    edge.to = remappedNodeIds.get(edge.to) ?? edge.to;
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to || edge.from === edge.to) {
      warn('invalid-edge-omitted', edge.id);
      continue;
    }
    if (edge.period?.from?.era && edge.period.from.era === edge.period.to?.era
      && edge.period.from.year !== null && edge.period.to.year !== null
      && edge.period.from.year > edge.period.to.year) {
      delete edge.period; warn('relationship-period-uncertain', edge.id);
    }
    // The existing roster has no soul-family scope: never borrow a body relation lock.
    const relation = edge.track === 'soul' ? null : findRosterRelation(evidenceRoster, from.name, to.name, edge.relationType);
    // A machine cannot acquire invented biological parents. Supported source relations survive.
    const child = edge.relationType === 'parent' ? to : edge.relationType === 'child' ? from : null;
    if (!relation && biologicalEdge(edge) && child?.identity?.lineageKind === 'creation') {
      warn('creation-biological-edge-omitted', edge.id); continue;
    }
    if (relation) {
      if (!edge.sourceRefs.some(ref => relation.sourceRefs.includes(ref))) {
        edge.sourceRefs = [...relation.sourceRefs];
        warn('relation-citations-restored', edge.id);
      }
    } else {
      if (hasLockedRelationForPair(evidenceRoster, from.name, to.name)
        && !['creator', 'creation', 'owner', 'owned', 'predecessor', 'successor', 'sameSource'].includes(edge.relationType)
        && edge.track !== 'soul') {
        warn('relation-conflicts-with-fact-lock-omitted', edge.id);
        continue;
      }
      edge.sourceRefs = [];
      edge.id = generatedEdgeId(edge.from, edge.relationType, edge.to, edge.track);
      if (biologicalEdge(edge) && hasImpossibleAncestorChronology(from, to, edge.relationType)) {
        const generatedEndpoint = generatedNodeIds.has(from.id)
          ? from
          : generatedNodeIds.has(to.id)
            ? to
            : undefined;
        if (!generatedEndpoint) {
          warn('generated-relation-chronology-conflict-omitted', edge.id);
          continue;
        }
        generatedEndpoint.birth = unknownDate();
        generatedEndpoint.summary = '具体出生年代待考；亲缘位置按本次低权补全保留。';
        generatedEndpoint.profile.lifeExperience = '经历为本次谱系的低权补全；不沿用与跨代关系冲突的具体出生年份。';
        warn('generated-life-date-chronology-normalized', generatedEndpoint.id);
      }
    }
    const signature = `${edge.from}\u0000${edge.relationType}\u0000${edge.to}\u0000${edge.track ?? 'body'}`;
    if (edgeSignatures.has(signature) || edgeIds.has(edge.id)) {
      warn('duplicate-edge-omitted', edge.id);
      continue;
    }
    edgeSignatures.add(signature);
    edgeIds.add(edge.id);
    preparedEdges.push(edge);
  }
  genealogy.edges = preparedEdges;
  const connected = new Set([focusNodes[0].id]);
  for (let size = -1; size !== connected.size;) {
    size = connected.size;
    for (const edge of genealogy.edges) if (connected.has(edge.from) || connected.has(edge.to)) { connected.add(edge.from); connected.add(edge.to); }
  }
  genealogy.nodes = genealogy.nodes.filter(node => { if (connected.has(node.id)) return true; warn('disconnected-node-omitted', node.id); removed.add(node.id); return false; });
  normalizeGeneratedGenerationChronology(genealogy, generatedNodeIds, warn);
  if (removed.size) genealogy.referenceSummary.brief = `${genealogy.referenceSummary.brief} 局部无效或超限单位已略去，其余谱系保留。`.slice(0, 150);

  const nodeIds = new Set<string>();
  for (const node of genealogy.nodes) {
    if (nodeIds.has(node.id)) {
      throw new GenealogyValidationError('Genealogy node IDs must be unique', 'NODE_ID_DUPLICATE');
    }
    nodeIds.add(node.id);
    if (
      node.generation < -expected.input.depth.ancestors
      || node.generation > expected.input.depth.descendants
    ) {
      throw new GenealogyValidationError('Genealogy node exceeds requested depth', 'NODE_DEPTH_INVALID');
    }
    if (!node.isMvuCharacter && node.mvuId) {
      throw new GenealogyValidationError('Non-MVU genealogy node contains an MVU ID', 'MVU_ID_INVALID');
    }
    if (node.provenance === 'explicit' && !node.isFocus && node.sourceRefs.length === 0) {
      throw new GenealogyValidationError('Explicit genealogy node lacks sources', 'SOURCE_REQUIRED');
    }
    const rosterPerson = resolveRosterPerson(evidenceRoster, node.name);
    if (rosterPerson &&
      !node.isFocus
      && !node.sourceRefs.some(sourceRef => rosterPerson.sourceRefs.includes(sourceRef))
    ) {
      throw new GenealogyValidationError(
        `Genealogy person lacks existence evidence: ${node.name}`,
        'PERSON_EVIDENCE_REQUIRED',
      );
    }
    if (!rosterPerson && (node.provenance !== 'generated' || node.sourceRefs.length > 0)) {
      throw new GenealogyValidationError(
        `Generated genealogy person has invalid provenance or citations: ${node.name}`,
        'GENERATED_PERSON_INVALID',
      );
    }
    validateLifeDates(node);
  }
  for (const track of ['body', 'soul'] as const) {
    const counts = new Map<number, number>();
    for (const node of genealogyFamilyView(genealogy, track).nodes) {
      const count = (counts.get(node.generation) ?? 0) + 1;
      counts.set(node.generation, count);
      if (count > expected.input.depth.maxPerGeneration) throw new GenealogyValidationError(
        `Genealogy generation ${node.generation} exceeds the requested person limit`, 'GENERATION_SIZE_INVALID');
    }
  }

  const verifiedEdgeIds = new Set<string>();
  for (const edge of genealogy.edges) {
    if (verifiedEdgeIds.has(edge.id)) {
      throw new GenealogyValidationError('Genealogy edge IDs must be unique', 'EDGE_ID_DUPLICATE');
    }
    verifiedEdgeIds.add(edge.id);
    if (edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new GenealogyValidationError('Genealogy edge references invalid nodes', 'EDGE_INVALID');
    }
    const fromNode = genealogy.nodes.find(node => node.id === edge.from)!;
    const toNode = genealogy.nodes.find(node => node.id === edge.to)!;
    const rosterRelation = edge.track === 'soul' ? null : findRosterRelation(
      evidenceRoster,
      fromNode.name,
      toNode.name,
      edge.relationType,
    );
    if (rosterRelation && !edge.sourceRefs.some(sourceRef => rosterRelation.sourceRefs.includes(sourceRef))) {
      throw new GenealogyValidationError(
        `Genealogy relation lacks source evidence: ${edge.id}`,
        'RELATION_EVIDENCE_REQUIRED',
      );
    }
    if (!rosterRelation && edge.sourceRefs.length > 0) {
      throw new GenealogyValidationError(
        `Generated genealogy relation contains citations: ${edge.id}`,
        'GENERATED_RELATION_INVALID',
      );
    }
  }
  ensureConnected(focusNodes[0].id, nodeIds, genealogy.edges);
  validateGenealogyChronology(genealogy);

  const knownSources = new Set(knownSourceIds);
  for (const ref of [
    ...genealogy.nodes.flatMap(node => node.sourceRefs),
    ...genealogy.edges.flatMap(edge => edge.sourceRefs),
  ]) {
    if (!knownSources.has(ref)) {
      throw new GenealogyValidationError(`Unknown source reference: ${ref}`, 'SOURCE_NOT_FOUND');
    }
  }

  const checks = genealogy.qualityChecks;
  if (
    !checks.focusIsMvuCharacter
    || !checks.generatedNodesHaveProvenance
    || !checks.allNodesHaveLifeDates
    || !checks.allNodesHaveBasicProfiles
    || !checks.noConflictNarrative
  ) {
    throw new GenealogyValidationError('Genealogy quality checks report a defect', 'QUALITY_CHECK_FAILED');
  }
  return genealogy;
}

function resolveGenealogySourceRefs(
  registry: ReturnType<typeof taskCitationRegistry>,
  refs: string[],
  knownSourceIds: string[],
  onWarning?: (warning: string) => void,
): string[] {
  const resolved = resolveTaskCitationValues(registry, 'source', refs, knownSourceIds);
  if (resolved.unknownRefs.length) {
    onWarning?.(`unknown-source-citations-dropped:${resolved.unknownRefs.length}`);
  }
  return resolved.targetIds;
}

/** Optional metadata cannot turn a readable tree into a whole-response failure. */
function normalizeOptionalDates(node: GenealogyResult['nodes'][number], warn?: (warning: string) => void): void {
  if (!node.identity) return;
  for (const track of [node.identity.body, node.identity.soul]) {
    if (!track) continue;
    for (const kind of ['birth', 'death'] as const) {
      const date = track[kind];
      if (!date) continue;
      try {
        validateLifeDates({ ...node, birth: kind === 'birth' ? date : unknownDate(),
          death: kind === 'death' ? date : unknownDeathDate() });
      } catch { delete track[kind]; warn?.(`optional-identity-date-omitted:${node.id}:${kind}`); }
    }
  }
}

function normalizeGeneratedLifeDates(
  node: GenealogyResult['nodes'][number],
  warn: (code: string, id: string) => void,
): void {
  try {
    validateLifeDates(node);
  } catch {
    node.birth = unknownDate();
    node.death = unknownDeathDate();
    warn('generated-life-date-normalized', node.id);
  }
}

function unknownDeathDate(): GenealogyResult['nodes'][number]['death'] {
  return {
    status: 'unknown',
    era: '',
    year: null,
    month: null,
    day: null,
    precision: 'unknown',
    label: '卒年不详',
  };
}

function hasLockedRelationForPair(
  roster: GenealogyEvidenceRoster,
  leftName: string,
  rightName: string,
): boolean {
  const left = resolveRosterPerson(roster, leftName)?.canonicalName ?? leftName;
  const right = resolveRosterPerson(roster, rightName)?.canonicalName ?? rightName;
  return roster.relations.some(relation =>
    (normalize(relation.fromName) === normalize(left)
      && normalize(relation.toName) === normalize(right))
    || (normalize(relation.fromName) === normalize(right)
      && normalize(relation.toName) === normalize(left))
  );
}

function generatedNodeId(name: string, generation: number): string {
  return `generated-node:${generation}:${compactStableId(normalize(name))}`;
}

function generatedEdgeId(
  from: string,
  relationType: GenealogyResult['edges'][number]['relationType'],
  to: string,
  track?: GenealogyResult['edges'][number]['track'],
): string {
  return `generated-edge:${compactStableId(`${from}|${relationType}|${to}${track ? `|${track}` : ''}`)}`;
}

function compactStableId(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value.normalize('NFKC')) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function normalizeGenealogyModelPlaceholders(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return value;
  return {
    ...value,
    nodes: value.nodes.map(node => {
      if (!isRecord(node)) return node;
      return {
        ...node,
        birth: normalizeBirthDatePlaceholders(node.birth),
        death: normalizeDeathDatePlaceholders(node.death),
        professions: Array.isArray(node.professions) && node.professions.length === 0
          ? ['职业不详']
          : node.professions,
      };
    }),
  };
}

function normalizeBirthDatePlaceholders(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const hasDate = typeof value.year === 'number';
  const rawStatus = typeof value.status === 'string'
    ? value.status.normalize('NFKC').trim().toLowerCase()
    : value.status;
  const status = ['known', '明确', '已知'].includes(String(rawStatus))
    ? 'known'
    : ['unknown', '未知', '不详'].includes(String(rawStatus))
    ? 'unknown'
    : hasDate
    ? 'known'
    : 'unknown';
  return normalizeLifeDatePlaceholders({ ...value, status });
}

function normalizeDeathDatePlaceholders(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const status = normalizeDeathStatus(value.status, value.label, value.year);
  if (status === 'alive') {
    return {
      ...value,
      status,
      era: '',
      year: null,
      month: null,
      day: null,
      precision: 'unknown',
      label: typeof value.label === 'string' && value.label.trim()
        ? value.label.trim()
        : '在世',
    };
  }
  return normalizeLifeDatePlaceholders({ ...value, status });
}

function normalizeDeathStatus(value: unknown, label: unknown, year: unknown): unknown {
  const normalized = typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : value;
  if (
    ['alive', 'living', 'in_life', '在世', '存活', '健在', '生存'].includes(String(normalized))
    || (typeof label === 'string' && /(?:在世|存活|健在)/u.test(label))
  ) return 'alive';
  if (['deceased', 'dead', '已故', '死亡', '去世'].includes(String(normalized))) {
    return 'deceased';
  }
  if (['unknown', '未知', '不详'].includes(String(normalized))) return 'unknown';
  if (['known', '明确', '已知'].includes(String(normalized))) {
    return typeof year === 'number' ? 'deceased' : 'unknown';
  }
  return typeof year === 'number' ? 'deceased' : 'unknown';
}

function normalizeLifeDatePlaceholders(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.status === 'alive') {
    return {
      ...value,
      era: '',
      year: null,
      month: null,
      day: null,
      precision: 'unknown',
      label: typeof value.label === 'string' && value.label.trim()
        ? value.label
        : '在世',
    };
  }
  return {
    ...value,
    month: value.month === 0 ? null : value.month,
    day: value.day === 0 ? null : value.day,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensureRawProfiles(value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.nodes)) return;
  const invalid = value.nodes.some(node => {
    if (!isRecord(node) || !isRecord(node.profile)) return true;
    return typeof node.profile.personality !== 'string'
      || !node.profile.personality.trim()
      || typeof node.profile.lifeExperience !== 'string'
      || !node.profile.lifeExperience.trim();
  });
  if (invalid) {
    throw new GenealogyValidationError(
      '每个谱系人物都必须提供非空的性格侧写和经历短传',
      'PROFILE_REQUIRED',
    );
  }
}

function isGenealogyContextEcho(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const contextKeys = [
    'taskType',
    'scope',
    'currentWorld',
    'worldbookContext',
    'recentContext',
    'characterContext',
    'genealogyContext',
    'biographyRefs',
    'butterflyRefs',
    'sourceIndex',
    'warnings',
  ];
  return contextKeys.filter(key => key in value).length >= 3;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function validateLifeDates(node: GenealogyResult['nodes'][number]): void {
  if (node.birth.status === 'alive' || node.birth.status === 'deceased') {
    throw new GenealogyValidationError('Birth status is invalid', 'LIFE_DATE_INVALID');
  }
  if (node.death.status === 'known') {
    throw new GenealogyValidationError('Death status is invalid', 'LIFE_DATE_INVALID');
  }
  if (node.birth.precision === 'unknown' && (node.birth.era || node.birth.year !== null)) {
    throw new GenealogyValidationError('Unknown birth contains a concrete date', 'LIFE_DATE_INVALID');
  }
  if (
    node.death.status === 'alive'
    && (node.death.year !== null || node.death.precision !== 'unknown')
  ) {
    throw new GenealogyValidationError('Living person contains a death date', 'LIFE_DATE_INVALID');
  }
  if (
    node.birth.era
    && node.death.era === node.birth.era
    && node.birth.year !== null
    && node.death.year !== null
    && node.birth.year > node.death.year
  ) {
    throw new GenealogyValidationError('Genealogy life dates are reversed', 'LIFE_DATE_REVERSED');
  }
}

function validateGenealogyChronology(genealogy: GenealogyResult): void {
  const nodes = new Map(genealogy.nodes.map(node => [node.id, node]));
  for (const edge of genealogy.edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    if (!biologicalEdge(edge)) continue;
    const direction = ancestorDirection(edge.relationType);
    if (direction === 0) continue;
    const ancestor = direction > 0 ? from : to;
    const descendant = direction > 0 ? to : from;
    validateAncestorDate(ancestor, descendant, edge.relationType);
  }

  const focus = genealogy.nodes.find(node => node.isFocus);
  if (!focus) return;
  const biologicalFamily = biologicalFamilyIds(genealogy, focus.id);
  for (const node of genealogy.nodes) {
    if (node.id === focus.id || node.generation === 0) continue;
    if (!biologicalFamily.has(node.id)) continue;
    if (!hasOrdinaryGenerationChronology(node) || !hasOrdinaryGenerationChronology(focus)) continue;
    const ancestor = node.generation < 0 ? node : focus;
    const descendant = node.generation < 0 ? focus : node;
    validateAncestorDate(ancestor, descendant, 'generation');
  }
}

function ancestorDirection(relationType: GenealogyResult['edges'][number]['relationType']): number {
  if (['parent', 'grandparent', 'ancestor'].includes(relationType)) return 1;
  if (['child', 'grandchild', 'descendant'].includes(relationType)) return -1;
  return 0;
}

function validateAncestorDate(
  ancestor: GenealogyResult['nodes'][number],
  descendant: GenealogyResult['nodes'][number],
  relationType: string,
): void {
  if (
    !sameBodyWorld(ancestor, descendant)
    ||
    !ancestor.birth.era
    || ancestor.birth.era !== descendant.birth.era
    || ancestor.birth.year === null
    || descendant.birth.year === null
  ) return;
  const minimumGap = ['parent', 'child'].includes(relationType) ? 12 : 1;
  if (descendant.birth.year - ancestor.birth.year < minimumGap) {
    throw new GenealogyValidationError(
      `${ancestor.name} 与 ${descendant.name} 的跨代出生年份不成立`,
      'CHRONOLOGY_INVALID',
    );
  }
}

function hasImpossibleAncestorChronology(
  from: GenealogyResult['nodes'][number],
  to: GenealogyResult['nodes'][number],
  relationType: GenealogyResult['edges'][number]['relationType'],
): boolean {
  const direction = ancestorDirection(relationType);
  if (direction === 0) return false;
  const ancestor = direction > 0 ? from : to;
  const descendant = direction > 0 ? to : from;
  if (
    !sameBodyWorld(ancestor, descendant)
    ||
    !ancestor.birth.era
    || ancestor.birth.era !== descendant.birth.era
    || ancestor.birth.year === null
    || descendant.birth.year === null
  ) return false;
  const minimumGap = ['parent', 'child'].includes(relationType) ? 12 : 1;
  return descendant.birth.year - ancestor.birth.year < minimumGap;
}

function normalizeGeneratedGenerationChronology(
  genealogy: GenealogyResult,
  generatedNodeIds: Set<string>,
  warn: (code: string, id: string) => void,
): void {
  const focus = genealogy.nodes.find(node => node.isFocus);
  if (!focus) return;
  const biologicalFamily = biologicalFamilyIds(genealogy, focus.id);
  for (const node of genealogy.nodes) {
    if (!generatedNodeIds.has(node.id) || node.generation === 0) continue;
    if (!biologicalFamily.has(node.id)) continue;
    if (!hasOrdinaryGenerationChronology(node) || !hasOrdinaryGenerationChronology(focus)) continue;
    const ancestor = node.generation < 0 ? node : focus;
    const descendant = node.generation < 0 ? focus : node;
    if (
      !sameBodyWorld(ancestor, descendant)
      ||
      !ancestor.birth.era
      || ancestor.birth.era !== descendant.birth.era
      || ancestor.birth.year === null
      || descendant.birth.year === null
      || descendant.birth.year - ancestor.birth.year >= 1
    ) continue;
    node.birth = unknownDate();
    node.summary = '具体出生年代待考；代际位置按本次低权补全保留。';
    node.profile.lifeExperience = '经历为本次谱系的低权补全；不沿用与代际位置冲突的具体出生年份。';
    warn('generated-life-date-generation-normalized', node.id);
  }
}

function sameBodyWorld(left: GenealogyResult['nodes'][number], right: GenealogyResult['nodes'][number]): boolean {
  const a = left.identity?.body?.world?.trim(), b = right.identity?.body?.world?.trim();
  return !a || !b || a === b;
}

function ensureConnected(
  focusId: string,
  nodeIds: Set<string>,
  edges: GenealogyResult['edges'],
): void {
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const edge of edges) {
    adjacency.get(edge.from)?.push(edge.to);
    adjacency.get(edge.to)?.push(edge.from);
  }
  const visited = new Set([focusId]);
  const queue = [focusId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  if (visited.size !== nodeIds.size) {
    throw new GenealogyValidationError('Genealogy contains isolated nodes', 'NODE_ISOLATED');
  }
}
