import type { RuinContextBundle } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  isValidMvuLocation,
  MVU_LOCATION_MAX_LEVELS,
  MVU_LOCATION_MIN_LEVELS,
  normalizeMvuLocation,
} from '../core/ruinLocation.ts';
import {
  RUIN_PROSE_ACCEPTED_MAX,
  RUIN_PROSE_ACCEPTED_MIN,
  ruinProseExpansionGuidance,
} from '../core/ruinProseContract.ts';
import {
  formatRuinNodeTimeCard,
  formatRuinSpanLabel,
} from '../renderers/ruinTimeLabel.ts';
import {
  absoluteYear,
  eraIndex,
  findPersonTimelineEntry,
  parseWorldTime,
} from '../retrieval/temporal.ts';
import {
  resolveTaskCitationHandles,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import type { TaskCitationRegistry } from '../retrieval/contracts.ts';
import { blockedRuinActor } from '../runtime/ruinActorPolicy.ts';
import {
  RuinCandidatesErrorSchema,
  RuinCandidatesSchema,
  RuinCandidateSchema,
  RuinCandidateResponseSchema,
  RuinPlanResponseSchema,
  type RuinCandidate,
  type RuinCandidatePlan,
  type RuinCandidates,
  type RuinGenerationInput,
  type RuinMaterial,
  type RuinNode,
  type RuinPeriodType,
} from '../schemas/ruin.ts';

export class RuinValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'RUIN_INVALID') {
    super(message);
    this.name = 'RuinValidationError';
    this.code = code;
  }
}

export function parseAndNormalizeRuinOutlines(
  raw: string,
  expected: {
    requestId: string;
    directive: string;
    input: RuinGenerationInput;
    context: RuinContextBundle;
    automaticTimeRange?: boolean;
  },
): RuinCandidates {
  const parsed = parseRuinObject(raw, 'eyon.ruin.outlines.v1', expected.requestId);
  const root = isRecord(parsed) ? parsed : {};
  const rawCandidates = Array.isArray(root.candidates) ? root.candidates : [];
  if (!rawCandidates.length) {
    throw new RuinValidationError('Ruin outline response contains no candidates', 'OUTLINE_EMPTY');
  }

  const orderedRawCandidates = expected.input.materials.map((material, index) =>
    rawCandidates.find(item =>
      isRecord(item) && textValue(item.candidateKey) === material.candidateKey
    ) ?? rawCandidates[index]
  );
  assertDistinctRuinBranchSignatures(orderedRawCandidates);
  const citationRegistry = taskCitationRegistry(expected.context.evidenceBundle);

  const candidates = expected.input.materials.map((material, index) => {
    const source = orderedRawCandidates[index];
    return normalizeOutlineCandidate(
      source,
      expected.input,
      material,
      index,
      expected.automaticTimeRange ?? false,
      citationRegistry,
    );
  });
  const sharedCast = normalizeSharedCast(
    root.sharedCast,
    expected.input,
    candidates,
    expected.context,
  );
  for (const candidate of candidates) {
    applySharedCast(candidate, sharedCast, expected.input, expected.context);
  }
  validateManifestCast(candidates, expected.context, expected.input);
  for (const candidate of candidates) validateActorPolicy(candidate, expected.context);
  validateCanonInterpretations(candidates, expected.context);
  makeCandidateTitlesDistinct(candidates);
  // 节点 ID 唯一性（大纲端早拦，报错可操作化 + repair 结构指引闭环，internal.77 三轮覆盖）。
  for (const candidate of candidates) {
    validateNodes(candidate.nodes, candidate.title);
    reconcileCandidateSpan(candidate, expected.input);
  }
  // 未来时间硬门：穿越只能进入当前剧情时间或更早（玩家显式填到未来的范围同样受上限约束）。
  for (const candidate of candidates) {
    assertRuinNotInFuture(candidate, expected.input, expected.context);
    // 人物在场硬校验：候选时段与选中人物生卒/窗口不相容时，禁止其在场（缺席叙事或换时间带）。
    assertIncompatibleCharactersAbsent(candidate, expected.input, expected.context);
  }

  return RuinCandidatesSchema.parse({
    schema: 'eyon.ruin.candidates.v2',
    requestId: expected.requestId,
    era: expected.input.era,
    location: expected.input.location,
    wave: expected.input.wave,
    candidates,
    castNameWarnings: collectRuinCastNameWarnings(candidates),
  });
}

/**
 * 候选重名提示（internal.76 收尾 A3）：同一批候选里出现相同名字但身份不同的人
 * （如「导师尤利安」与「皇储尤利安·奥古斯塔」）→ 返回 warning 文案（不 repair）。
 * 同名且同身份（跨篇同一人复用）不算。
 */
export function collectRuinCastNameWarnings(candidates: RuinCandidate[]): string[] {
  const warnings: string[] = [];
  const byName = new Map<string, Array<{ candidateIndex: number; identity: string }>>();
  candidates.forEach((candidate, candidateIndex) => {
    for (const member of candidate.cast ?? []) {
      const name = normalizeText(member.name);
      if (!name) continue;
      const list = byName.get(name) ?? [];
      list.push({ candidateIndex, identity: normalizeText(member.identity) });
      byName.set(name, list);
    }
  });
  for (const [name, occurrences] of byName) {
    const distinctIdentities = new Set(
      occurrences.map(item => item.identity).filter(Boolean));
    if (occurrences.length >= 2 && distinctIdentities.size > 1) {
      warnings.push(
        `候选重名：同一批候选里「${name}」出现于候选 ${
          occurrences.map(item => item.candidateIndex + 1).join('、')}，但身份不同${
          [...distinctIdentities].map(identity => `「${identity}」`).join(' / ')}——若为不同人物请改名（warning，不自动修正）`,
      );
    }
  }
  return warnings;
}

export function parseAndNormalizeExpandedRuinCandidate(
  raw: string,
  expected: {
    requestId: string;
    input: RuinGenerationInput;
    material: RuinMaterial;
    context: RuinContextBundle;
    outline: RuinCandidate;
    citationRegistry?: TaskCitationRegistry;
  },
): RuinCandidate {
  const parsed = parseRuinObject(raw, 'eyon.ruin.expansion.v1', expected.requestId);
  const root = isRecord(parsed) ? parsed : {};
  const source = isRecord(root.candidate) ? root.candidate : root;
  const candidate = normalizeExpandedCandidate(source, expected.outline, expected.input);
  const result = RuinCandidateSchema.safeParse(candidate);
  if (!result.success) {
    throw new RuinValidationError(
      result.error.message + describeInvalidValues(result.error.issues, candidate),
      'SCHEMA_INVALID',
    );
  }
  validateRuinCandidate(result.data, expected);
  return result.data;
}

function parseRuinObject(raw: string, schema: string, requestId: string): unknown {
  try {
    return parseSingleJsonObject(raw, {
      schema,
      discriminators: { requestId },
    });
  } catch (error) {
    throw new RuinValidationError(
      error instanceof Error ? error.message : 'Ruin response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }
}

function normalizeOutlineCandidate(
  value: unknown,
  input: RuinGenerationInput,
  material: RuinMaterial,
  index: number,
  automaticTimeRange: boolean,
  citationRegistry: TaskCitationRegistry,
): RuinCandidate {
  const source = isRecord(value) ? value : {};
  const title = textValue(source.title) || `Historical candidate ${index + 1}`;
  const premise = textValue(source.premise) || textValue(source.summary) || title;
  const summary = textValue(source.summary) || premise;
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes = normalizeOutlineNodes(
    rawNodes,
    input,
    title,
    summary,
    index,
    automaticTimeRange,
  );
  assertTimelineNotDegenerate(
    nodes,
    input,
    rawNodes.some(nodeHasModelLabel),
    modelLabelsFromRaw(rawNodes),
  );
  const span = normalizedSpan(source.span, nodes, input);
  const cast = normalizeActualSelectedCast(
    normalizeCast(source.cast, input, nodes, summary),
    input,
  );
  const historicalResult = textValue(source.historicalResult)
    || textValue(readRecord(source.fusion).historicalResult)
    || summary;
  const anomaly = nodes.find(node => node.kind === 'anomaly') ?? nodes[0];
  const citationWarnings: string[] = [];

  return RuinCandidateSchema.parse({
    id: `ruin-${material.candidateKey}`,
    candidateKey: material.candidateKey,
    title,
    periodType: material.periodType,
    span,
    premise,
    summary,
    historyProse: summary,
    fusion: {
      normalOrder: premise,
      latentFault: summary,
      pressuredActors: cast.map(member => member.name).slice(0, 4),
      bridge: {
        type: 'other',
        name: anomaly.title,
        explanation: anomaly.summary,
      },
      triggerImpact: anomaly.cause,
      forcedDecision: anomaly.intervention,
      irreversibleTurn: anomaly.visibleTrace,
      historicalResult,
    },
    shift: normalizeCandidateShift(source.shift, material.periodType, historicalResult),
    nodes,
    cast,
    selectedCharacterUsage: localSelectedCharacterUsage(input, cast, nodes),
    historicalTexture: {
      dailyLife: [summary],
      institutions: [premise],
      materialCulture: [anomaly.visibleTrace],
      socialDivisions: [historicalResult],
    },
    sourceRefs: [],
    biographyUsage: [],
    canonInterpretation: normalizeCanonInterpretation(
      source.canonInterpretation,
      material.candidateKey,
      summary,
      citationRegistry,
      citationWarnings,
    ),
    inferenceNotes: [
      'Compact outline; detailed history is generated only when entering.',
      ...citationWarnings,
    ],
    qualityChecks: validQualityChecks(),
  });
}

function normalizeOutlineNodes(
  values: unknown[],
  input: RuinGenerationInput,
  title: string,
  summary: string,
  candidateIndex: number,
  automaticTimeRange: boolean,
): RuinNode[] {
  const prepared = values.length >= 4 ? values.slice(0, 6) : [
    ...values,
    ...Array.from({ length: 4 - values.length }, () => ({})),
  ];
  const fallbackStart = input.start ?? input.end ?? null;
  const fallbackEnd = input.end ?? input.start ?? fallbackStart;
  const nodes = prepared.map((value, index) => {
    const source = isRecord(value) ? value : {};
    const fallbackDate = interpolateDate(fallbackStart, fallbackEnd, index, prepared.length);
    const time = normalizeNodeTime(
      source.time,
      fallbackDate,
      input,
      index,
      automaticTimeRange,
    );
    const kind = outlineNodeKind(source.kind, index, prepared.length);
    const nodeTitle = textValue(source.title) || `${title} ${index + 1}`;
    const nodeSummary = textValue(source.summary) || summary;
    return {
      id: textValue(source.id) || `candidate-${candidateIndex + 1}-node-${index + 1}`,
      kind,
      time,
      location: textValue(source.location) || input.location,
      title: nodeTitle,
      summary: nodeSummary,
      cause: textValue(source.cause) || nodeSummary,
      causalMechanism: textValue(source.causalMechanism) || nodeSummary,
      participants: stringArray(source.participants),
      interests: [],
      materialConditions: stringArray(source.materialConditions),
      opposition: textValue(source.opposition),
      visibleTrace: textValue(source.visibleTrace) || nodeSummary,
      intervention: textValue(source.intervention) || defaultStageIntervention(kind),
      possibleBranches: normalizeBranches(source.possibleBranches, nodeSummary),
      enterable: true,
      inference: true,
      sourceRefs: [],
    } satisfies RuinNode;
  });
  nodes.sort((left, right) => compareTuple(timeTuple(left), timeTuple(right)));
  return nodes;
}

function normalizeExpandedCandidate(
  source: Record<string, unknown>,
  outline: RuinCandidate,
  input: RuinGenerationInput,
): unknown {
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes = outline.nodes.map((node, index) => {
    const matching = rawNodes.find(item => isRecord(item) && textValue(item.id) === node.id)
      ?? rawNodes[index];
    const detail = isRecord(matching) ? matching : {};
    return {
      ...node,
      title: textValue(detail.title) || node.title,
      summary: textValue(detail.summary) || node.summary,
      cause: textValue(detail.cause) || node.cause,
      causalMechanism: textValue(detail.causalMechanism) || node.causalMechanism,
      participants: mergeUniqueStrings(node.participants, stringArray(detail.participants)),
      interests: normalizeInterests(detail.interests),
      materialConditions: stringArray(detail.materialConditions, node.materialConditions),
      opposition: textValue(detail.opposition) || node.opposition,
      visibleTrace: textValue(detail.visibleTrace) || node.visibleTrace,
      intervention: textValue(detail.intervention) || node.intervention
        || defaultStageIntervention(node.kind),
      possibleBranches: normalizeBranches(detail.possibleBranches, node.summary),
      enterable: true,
      inference: booleanValue(detail.inference, true),
      sourceRefs: [],
    };
  });
  const cast = reconcileExpandedCast(source.cast, outline.cast);
  ensureCastParticipation(nodes, cast.map(member => member.name));
  const fusionSource = readRecord(source.fusion);
  const shiftSource = readRecord(source.shift);
  const textureSource = readRecord(source.historicalTexture);
  const anomaly = nodes.find(node => node.kind === 'anomaly') ?? nodes[0];
  const historyProse = textValue(source.historyProse) || outline.historyProse;
  const historicalResult = textValue(fusionSource.historicalResult)
    || outline.fusion.historicalResult;
  return {
    ...outline,
    title: textValue(source.title) || outline.title,
    premise: textValue(source.premise) || outline.premise,
    summary: textValue(source.summary) || outline.summary,
    historyProse,
    fusion: {
      normalOrder: textValue(fusionSource.normalOrder) || outline.fusion.normalOrder,
      latentFault: textValue(fusionSource.latentFault) || outline.fusion.latentFault,
      pressuredActors: stringArray(fusionSource.pressuredActors, cast.map(member => member.name)),
      bridge: {
        type: bridgeType(readRecord(fusionSource.bridge).type),
        name: textValue(readRecord(fusionSource.bridge).name) || anomaly.title,
        explanation: textValue(readRecord(fusionSource.bridge).explanation) || anomaly.summary,
      },
      triggerImpact: textValue(fusionSource.triggerImpact) || anomaly.cause,
      forcedDecision: textValue(fusionSource.forcedDecision) || anomaly.intervention,
      irreversibleTurn: textValue(fusionSource.irreversibleTurn) || anomaly.visibleTrace,
      historicalResult,
    },
    shift: {
      from: outline.shift.from,
      to: outline.shift.to,
      explanation: textValue(shiftSource.explanation) || historicalResult,
    },
    nodes,
    cast,
    selectedCharacterUsage: localSelectedCharacterUsage(input, cast, nodes),
    historicalTexture: {
      dailyLife: stringArray(textureSource.dailyLife, outline.historicalTexture.dailyLife),
      institutions: stringArray(textureSource.institutions, outline.historicalTexture.institutions),
      materialCulture: stringArray(textureSource.materialCulture, outline.historicalTexture.materialCulture),
      socialDivisions: stringArray(textureSource.socialDivisions, outline.historicalTexture.socialDivisions),
    },
    sourceRefs: [],
    biographyUsage: [],
    canonInterpretation: outline.canonInterpretation,
    inferenceNotes: stringArray(source.inferenceNotes, outline.inferenceNotes),
    qualityChecks: validQualityChecks(),
  };
}

function normalizeCanonInterpretation(
  value: unknown,
  candidateKey: string,
  fallback: string,
  citationRegistry: TaskCitationRegistry,
  citationWarnings: string[],
): NonNullable<RuinCandidate['canonInterpretation']> {
  const source = readRecord(value);
  const mode = source.mode === 'alternative-interpretation'
    ? 'alternative-interpretation' as const
    : 'independent-event' as const;
  const evidenceFactIds = resolveCitationRefs(
    citationRegistry,
    'fact',
    stringArray(source.evidenceFactRefs),
    citationWarnings,
  );
  const evidencePassageIds = resolveCitationRefs(
    citationRegistry,
    'passage',
    stringArray(source.evidencePassageRefs),
    citationWarnings,
  );
  const eventUsages = (Array.isArray(source.eventUsages) ? source.eventUsages : [])
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const usage = ['occurs', 'aftermath', 'recollection', 'evidence', 'background']
        .includes(textValue(item.usage))
        ? textValue(item.usage) as 'occurs' | 'aftermath' | 'recollection' | 'evidence' | 'background'
        : 'background';
      const eventRef = textValue(item.eventRef);
      if (!eventRef) return [];
      const eventKind = eventRef.startsWith('E') ? 'event' : 'fact';
      const eventId = eventRef === 'SELF'
        ? `invented:${candidateKey}:central-event`
        : resolveCitationRefs(
          citationRegistry,
          eventKind,
          [eventRef],
          citationWarnings,
        )[0];
      if (!eventId) return [];
      return [{
        eventId,
        usage,
        explanation: textValue(item.explanation) || fallback,
      }];
    });
  const assumptions = (Array.isArray(source.assumptions) ? source.assumptions : [])
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const claim = textValue(item.claim);
      if (!claim) return [];
      const confidence = ['high', 'medium', 'low'].includes(textValue(item.confidence))
        ? textValue(item.confidence) as 'high' | 'medium' | 'low'
        : 'low';
      return [{
        claim,
        evidenceFactIds: resolveCitationRefs(
          citationRegistry,
          'fact',
          stringArray(item.evidenceFactRefs),
          citationWarnings,
        ),
        evidencePassageIds: resolveCitationRefs(
          citationRegistry,
          'passage',
          stringArray(item.evidencePassageRefs),
          citationWarnings,
        ),
        confidence,
        alternatives: stringArray(item.alternatives),
      }];
    });
  return {
    mode,
    hypothesis: textValue(source.hypothesis) || fallback,
    evidenceFactIds,
    evidencePassageIds,
    eventUsages: eventUsages.length ? eventUsages : [{
      eventId: `invented:${candidateKey}:central-event`,
      usage: 'occurs',
      explanation: fallback,
    }],
    assumptions,
  };
}

function resolveCitationRefs(
  registry: TaskCitationRegistry,
  kind: 'passage' | 'fact' | 'event',
  refs: string[],
  warnings: string[],
): string[] {
  const resolved = resolveTaskCitationHandles(registry, kind, refs);
  for (const handle of resolved.unknownHandles) {
    warnings.push(`citation-ref-dropped:${kind}:${handle}`);
  }
  return resolved.targetIds;
}

function validateCanonInterpretations(
  candidates: RuinCandidate[],
  context: RuinContextBundle,
  registryOverride?: TaskCitationRegistry,
): void {
  const registry = registryOverride ?? taskCitationRegistry(context.evidenceBundle);
  const knownFactIds = new Set(
    registry.facts.map(fact => fact.factId),
  );
  const knownPassageIds = new Set([
    ...registry.passages.map(passage => passage.passageId),
    ...(context.evidenceBundle.passages ?? []).map(passage => passage.passageId),
  ]);
  const knownEventIds = new Set(registry.events.map(event => event.eventId));
  const occurrences = new Map<string, RuinCandidate[]>();
  for (const candidate of candidates) {
    const interpretation = candidate.canonInterpretation;
    if (!interpretation) continue;
    const cited = [
      ...interpretation.evidenceFactIds,
      ...interpretation.assumptions.flatMap(item => item.evidenceFactIds),
      ...interpretation.eventUsages.map(item => item.eventId).filter(id => id.startsWith('fact:')),
    ];
    const unknown = cited.find(factId => !knownFactIds.has(factId));
    if (unknown) {
      throw new RuinValidationError(
        `Ruin canon interpretation cites unknown factId: ${unknown}`,
        'CANON_FACT_NOT_FOUND',
      );
    }
    const unknownPassageId = [
      ...(interpretation.evidencePassageIds ?? []),
      ...interpretation.assumptions.flatMap(item => item.evidencePassageIds ?? []),
    ].find(passageId => !knownPassageIds.has(passageId));
    if (unknownPassageId) {
      throw new RuinValidationError(
        `Ruin canon interpretation resolved an unknown passageId: ${unknownPassageId}`,
        'CANON_PASSAGE_NOT_FOUND',
      );
    }
    const invalidEventId = interpretation.eventUsages
      .map(item => item.eventId)
      .find(eventId => !eventId.startsWith('fact:')
        && !eventId.startsWith('invented:')
        && !knownEventIds.has(eventId));
    if (invalidEventId) {
      throw new RuinValidationError(
        `Ruin canon interpretation eventId has invalid namespace: ${invalidEventId}`,
        'CANON_EVENT_ID_INVALID',
      );
    }
    const localOccurrences = interpretation.eventUsages
      .filter(item => item.usage === 'occurs')
      .map(item => item.eventId);
    if (new Set(localOccurrences).size !== localOccurrences.length) {
      throw new RuinValidationError(
        `Ruin candidate repeats the same occurs event: ${candidate.candidateKey}`,
        'CANON_EVENT_REUSED',
      );
    }
    for (const eventId of localOccurrences.filter(id =>
      id.startsWith('fact:') || knownEventIds.has(id))) {
      occurrences.set(eventId, [...(occurrences.get(eventId) ?? []), candidate]);
    }
  }
  for (const [eventId, owners] of occurrences) {
    if (owners.length < 2) continue;
    if (owners.some(candidate => candidate.canonInterpretation?.mode !== 'alternative-interpretation')) {
      throw new RuinValidationError(
        `Canonical event occurs in multiple independent ruin candidates: ${eventId}`,
        'CANON_EVENT_REUSED',
      );
    }
    for (let left = 0; left < owners.length; left += 1) {
      for (let right = left + 1; right < owners.length; right += 1) {
        const a = owners[left]!.canonInterpretation!;
        const b = owners[right]!.canonInterpretation!;
        const alternativesDeclared = a.assumptions.some(item => item.alternatives.length > 0)
          && b.assumptions.some(item => item.alternatives.length > 0);
        if (!alternativesDeclared || branchTextSimilarity(a.hypothesis, b.hypothesis) >= 0.62) {
          throw new RuinValidationError(
            `Alternative interpretations for ${eventId} are not substantively distinct`,
            'CANON_HYPOTHESIS_DUPLICATE',
          );
        }
      }
    }
  }
}

function normalizeCast(
  value: unknown,
  input: RuinGenerationInput,
  nodes: Array<Pick<RuinNode, 'id' | 'participants'>>,
  fallbackRole: string,
) {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const name = textValue(item.name);
    if (!name) return [];
    return [{
      name,
      kind: castKind(item.kind),
      identity: textValue(item.identity) || textValue(item.role) || `Historical participant ${index + 1}`,
      role: textValue(item.role) || fallbackRole,
      desire: textValue(item.desire) || 'Preserve or improve their position.',
      constraint: textValue(item.constraint) || 'Bound by contemporary institutions and resources.',
      sourceRefs: [],
      inference: booleanValue(item.inference, true),
    }];
  });
  if (normalized.length) return normalized;
  const fallbackName = nodes.flatMap(node => node.participants).find(Boolean) || input.location;
  if (nodes[0] && !nodes[0].participants.includes(fallbackName)) {
    nodes[0].participants.push(fallbackName);
  }
  return [{
    name: fallbackName,
    kind: 'community' as const,
    identity: 'Local historical participant',
    role: fallbackRole,
    desire: 'Preserve or improve their position.',
    constraint: 'Bound by contemporary institutions and resources.',
    sourceRefs: [],
    inference: true,
  }];
}

function selectedCharacterIdentityLabels(
  character: RuinGenerationInput['selectedCharacters'][number] | undefined,
): string[] {
  if (!character) return [];
  const declared = character.identities.length
    ? character.identities
    : character.professions.length
      ? character.professions
      : [character.contextSummary];
  const seen = new Set<string>();
  return declared.flatMap(value => {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function selectedCharacterCanonicalIdentity(
  character: RuinGenerationInput['selectedCharacters'][number] | undefined,
): string {
  return selectedCharacterIdentityLabels(character).join('、');
}

function selectedCharacterIdentityMatches(
  actual: string,
  character: RuinGenerationInput['selectedCharacters'][number],
): boolean {
  const labels = selectedCharacterIdentityLabels(character);
  if (!labels.length) return true;
  const normalizedActual = normalizeText(actual);
  return normalizedActual === labels.join('、')
    || labels.some(label => normalizedActual === label);
}

/**
 * 重点参考人物不会被补进演员表；但模型若确实让其出场，仍以只读人物卡
 * 规范身份，避免“选择语义变软”连带放松身份连续性。
 */
function normalizeActualSelectedCast(
  cast: RuinCandidate['cast'],
  input: RuinGenerationInput,
): RuinCandidate['cast'] {
  return cast.map(member => {
    const selected = input.selectedCharacters.find(character =>
      normalizeText(character.name) === normalizeText(member.name));
    if (!selected) return member;
    return {
      ...member,
      kind: 'person' as const,
      identity: selectedCharacterCanonicalIdentity(selected) || member.identity,
      inference: false,
    };
  });
}

function normalizeSharedCast(
  value: unknown,
  input: RuinGenerationInput,
  candidates: RuinCandidate[],
  context: RuinContextBundle,
): RuinCandidate['cast'] {
  const hardAbsentNames = hardAbsentPersonNames(context, input, candidates);
  const declared = (Array.isArray(value)
    ? normalizeCast(value, input, [], 'Shared historical participant')
    : []
  ).filter(member => !hardAbsentNames.has(normalizeText(member.name)));
  const commonNames = candidates[0]?.cast
    .filter(member => candidates.every(candidate =>
      candidate.cast.some(item => normalizeText(item.name) === normalizeText(member.name))
    )) ?? [];
  const fallback = commonNames
    .filter(member => !hardAbsentNames.has(normalizeText(member.name)));
  const manifest = manifestAnchorsForCandidates(context, input, candidates);
  const combined = [...manifest, ...declared, ...fallback];
  const normalMaximum = 2;
  const maximumShared = Math.max(normalMaximum, manifest.length);
  const unique: RuinCandidate['cast'] = [];
  const names = new Set<string>();
  for (const member of combined) {
    const key = normalizeText(member.name);
    if (!key || names.has(key)) continue;
    names.add(key);
    unique.push(member);
    if (unique.length >= maximumShared) break;
  }
  return unique;
}

function manifestAnchors(context: RuinContextBundle): RuinCandidate['cast'] {
  return (context.evidenceBundle.castManifest?.entries ?? [])
    .filter(entry => ['required', 'group-required'].includes(entry.disposition))
    .map(entry => ({
      name: entry.identity.canonicalName,
      kind: manifestCastKind(entry.identity.kinds),
      identity: manifestIdentity(entry.identity),
      role: entry.role === 'actor'
        ? 'Direct actor required by the historical event.'
        : 'Group participant required by the historical event.',
      desire: 'Act according to the established identity and relationships.',
      constraint: entry.identity.temporalScopes.join('、')
        || 'Bound by the supplied historical evidence.',
      sourceRefs: [],
      inference: false,
    }));
}

function manifestAnchorsForCandidates(
  context: RuinContextBundle,
  input: RuinGenerationInput,
  candidates: RuinCandidate[],
): RuinCandidate['cast'] {
  const hardAbsentNames = hardAbsentPersonNames(context, input, candidates);
  return manifestAnchors(context).filter(anchor =>
    anchor.kind !== 'person' || !hardAbsentNames.has(normalizeText(anchor.name)));
}

function hardAbsentPersonNames(
  context: RuinContextBundle,
  input: RuinGenerationInput,
  candidates: RuinCandidate[],
): Set<string> {
  const people = new Map<string, RuinGenerationInput['selectedCharacters'][number]>();
  for (const character of input.selectedCharacters) {
    people.set(normalizeText(character.name), character);
  }
  for (const anchor of manifestAnchors(context)) {
    const name = normalizeText(anchor.name);
    if (anchor.kind === 'person' && !people.has(name)) {
      people.set(name, { name: anchor.name, lifespan: '' } as RuinGenerationInput['selectedCharacters'][number]);
    }
  }
  return new Set([...people.entries()].flatMap(([name, character]) =>
    candidates.some(candidate =>
      !selectedCharacterFitsCandidates(character, input, [candidate], context))
      ? [name]
      : []));
}

function manifestIdentity(
  identity: NonNullable<RuinContextBundle['evidenceBundle']['castManifest']>['entries'][number]['identity'],
): string {
  const base = identity.identities[0]
    || identity.kinds.join('、')
    || 'Source-backed historical participant';
  const affiliations = identity.affiliations ?? [];
  return affiliations.length > 0
    ? `${base}；所属：${affiliations.join('、')}`
    : base;
}

function manifestCastKind(
  kinds: NonNullable<RuinContextBundle['evidenceBundle']['castManifest']>['entries'][number]['identity']['kinds'],
): RuinCandidate['cast'][number]['kind'] {
  if (kinds.includes('family')) return 'family';
  if (kinds.includes('organization') || kinds.includes('institution')) return 'organization';
  if (kinds.includes('faction')) return 'faction';
  if (kinds.includes('collective')) return 'community';
  return 'person';
}

function validateManifestCast(
  candidates: RuinCandidate[],
  context: RuinContextBundle,
  input: RuinGenerationInput,
): void {
  const known = context.evidenceBundle.castManifest?.entries ?? [];
  for (const candidate of candidates) {
    // 出生前/死亡后的硬缺席优先于本轮墟境的 required 演员要求；
    // Canon 身份并未改变，只是不把不可能在场的人塞进该候选。
    const required = manifestAnchorsForCandidates(context, input, [candidate]);
    const castNames = new Set(candidate.cast.map(member => normalizeText(member.name)));
    const participants = new Set(candidate.nodes.flatMap(node => node.participants).map(normalizeText));
    for (const anchor of required) {
      const name = normalizeText(anchor.name);
      if (!castNames.has(name) || !participants.has(name)) {
        throw new RuinValidationError(
          `Required CastManifest actor is missing from cast or nodes: ${anchor.name}`,
          'CAST_MANIFEST_REQUIRED_MISSING',
        );
      }
      const actual = candidate.cast.find(member => normalizeText(member.name) === name);
      if (!actual || normalizeText(actual.identity) !== normalizeText(anchor.identity)) {
        throw new RuinValidationError(
          `Required CastManifest identity changed: ${anchor.name}`,
          'CAST_MANIFEST_IDENTITY_CHANGED',
        );
      }
    }
    for (const member of candidate.cast) {
      const entry = known.find(item => [
        item.identity.canonicalName,
        ...item.identity.aliases,
      ].some(name => normalizeText(name) === normalizeText(member.name)));
      if (!entry) continue; // 未在目录中命中的局部原创人物/组织是合法的。
      const temporalExcluded = entry.disposition === 'excluded'
        && entry.reasons.includes('temporal-scope-incompatible');
      const statedEras = entry.identity.temporalScopes
        .flatMap(scope => scope.match(/[\p{Script=Han}]{2,8}纪元/gu) ?? []);
      const eraChanged = statedEras.length > 0
        && Boolean(input.era.trim())
        && !statedEras.includes(input.era.trim())
        && !entry.reasons.includes('direct-query-entity-temporal-conflict-degraded');
      if (temporalExcluded || eraChanged) {
        throw new RuinValidationError(
          `Known entity is unavailable in the requested era: ${member.name}`,
          'KNOWN_ENTITY_TEMPORAL_SCOPE_CHANGED',
        );
      }
      const expectedKind = manifestCastKind(entry.identity.kinds);
      if (member.kind !== expectedKind) {
        throw new RuinValidationError(
          `Known entity kind changed: ${member.name}`,
          'KNOWN_ENTITY_KIND_CHANGED',
        );
      }
      const canonicalIdentity = entry.identity.identities[0];
      if (canonicalIdentity
        && !normalizeText(member.identity).includes(normalizeText(canonicalIdentity))) {
        throw new RuinValidationError(
          `Known entity identity changed: ${member.name}`,
          'KNOWN_ENTITY_IDENTITY_CHANGED',
        );
      }
      const affiliations = entry.identity.affiliations ?? [];
      if (affiliations.length > 0 && !affiliations.some(affiliation =>
        normalizeText(member.identity).includes(normalizeText(affiliation)))) {
        throw new RuinValidationError(
          `Known entity affiliation is missing or changed: ${member.name}`,
          'KNOWN_ENTITY_AFFILIATION_CHANGED',
        );
      }
    }
  }
}

const ERA_SEQUENCE = [
  '创世纪元',
  '神明纪元',
  '混乱纪元',
  '英雄纪元',
  '复兴纪元',
] as const;

function selectedCharacterFitsCandidates(
  character: RuinGenerationInput['selectedCharacters'][number],
  input: RuinGenerationInput,
  candidates: RuinCandidate[],
  context?: RuinContextBundle,
): boolean {
  const dates = extractLifespanDates(character.lifespan);
  // 日历格式生卒提取不到（如「27岁」年龄格式）时，用引擎 personTimeline 的机器可读
  // 窗口兜底换算（出生年 = 基准年 − 年龄，由 shadowEngine 按 baselineWorldTime 算好）。
  if (dates.length === 0 && context) {
    // 双源适配：同名多条时优先取有生卒窗口的条目。
    const entry = findPersonTimelineEntry(context.evidenceBundle.personTimeline, character.name);
    const lifespan = entry?.lifespan;
    // 界外来客（arrivalBased）：穿越时间世界书未记载，「抵达年」只是「抵达时 0 岁」的
    // 推断假说（internal.54 契约语义）——正文明示更晚/更早抵达且年龄自洽是被允许的，
    // 因此不参与不兼容硬判定（保持宽松，宁可放行不可误判）。
    if (lifespan?.arrivalBased) return true;
    const born = lifespan?.born;
    const died = lifespan?.died;
    if (born?.era && born.year !== null && born.year !== undefined) {
      dates.push({ era: born.era, year: born.year });
    }
    if (died?.era && died.year !== null && died.year !== undefined) {
      dates.push({ era: died.era, year: died.year });
    }
  }
  if (!dates.length) return true;
  // 顺序加固（#2）：生卒字符串倒写（「479年 - 400年」）时按绝对年排序纠正，
  // 避免出生/死亡互换导致全盘误判。
  if (dates.length >= 2) {
    const absolute = dates.map(date => absoluteYear(date.era, date.year));
    if (absolute.every((value): value is number => value !== null)
      && absolute[0]! > absolute[1]!) {
      dates.sort((left, right) =>
        (absoluteYear(left.era, left.year) ?? 0) - (absoluteYear(right.era, right.year) ?? 0));
    }
  }
  const years = candidates.flatMap(candidate => [
    candidate.span.start.year,
    candidate.span.end.year,
  ]).filter((year): year is number => year !== null);
  if (years.length === 0) return true; // 相对纪年：无年份可比，寿命约束按宽松处理
  const earliest = Math.min(...years);
  const latest = Math.max(...years);
  const eventEra = ERA_SEQUENCE.indexOf(input.era as typeof ERA_SEQUENCE[number]);
  const birth = dates[0];
  // 死亡年：只有明确存在第二个日期才算——dates 只有一个元素时 at(-1) 就是出生年
  // 本身，绝不能当死亡年（否则「出生即死」，出生后所有时段都被误判不兼容）。
  // 「至今」与「在世/存活」同义（#4）：标记为在世则死亡年置空。
  const death = dates.length >= 2
    ? (/在世|存活|alive|至今/iu.test(character.lifespan) ? null : dates.at(-1) ?? null)
    : null;
  const birthEra = ERA_SEQUENCE.indexOf(birth.era as typeof ERA_SEQUENCE[number]);
  if (birthEra >= 0 && eventEra >= 0) {
    if (birthEra > eventEra) return false;
    if (birthEra === eventEra && birth.year > latest) return false;
  } else if (sameEraName(birth.era, input.era) && birth.year > latest) {
    return false;
  }
  if (death) {
    const deathEra = ERA_SEQUENCE.indexOf(death.era as typeof ERA_SEQUENCE[number]);
    if (deathEra >= 0 && eventEra >= 0) {
      if (deathEra < eventEra) return false;
      if (deathEra === eventEra && death.year < earliest) return false;
    } else if (sameEraName(death.era, input.era) && death.year < earliest) {
      return false;
    }
  }
  return true;
}

/**
 * 人物在场硬校验（墟境版）：候选时段与人物生卒/窗口不相容时，禁止其在场。
 * 校验名单 = 候选 cast/节点参与者中**实际出现**的人物——包括 UI 选中的参与人物、
 * 指令/补充方向点名但未选中的人物（模型自发写她进场也必须过窗口）；
 * 未出场的人物（缺席叙事）一律放行，不做兼容判定。
 * 界外来客（arrivalBased）保持宽松（推断抵达年只是假说，不判错）。
 * 命中走既有 repair（大纲整体修复/扩写定向修复），错误信息给三条路：
 * ① 后移时间带到其出生年之后；② 更换参与人物；③ 该候选走缺席叙事。
 */
function assertIncompatibleCharactersAbsent(
  candidate: RuinCandidates['candidates'][number],
  input: RuinGenerationInput,
  context: RuinContextBundle,
): void {
  const names = new Set<string>();
  for (const member of candidate.cast) {
    const name = normalizeText(member.name);
    if (name) names.add(name);
  }
  for (const node of candidate.nodes) {
    for (const participant of node.participants) {
      const name = normalizeText(participant);
      if (name) names.add(name);
    }
  }
  for (const name of names) {
    const entry = findPersonTimelineEntry(context.evidenceBundle.personTimeline, name);
    const lifespan = entry?.lifespan;
    if (!lifespan?.born && !lifespan?.ageAtRecord) continue; // 无窗口不判
    if (lifespan?.arrivalBased) continue; // 界外来客：推断抵达年只是假说，不判错
    // 用 entry 的窗口做兼容判定（lifespan 字符串为空 → 走 personTimeline 兜底路径）。
    const characterLike = {
      name,
      lifespan: '',
    } as RuinGenerationInput['selectedCharacters'][number];
    if (selectedCharacterFitsCandidates(characterLike, input, [candidate], context)) continue;
    const born = lifespan?.born;
    const died = lifespan?.died;
    const windowText = [
      born?.era && born.year !== null && born.year !== undefined
        ? `出生/抵达${born.era}${born.year}年`
        : '',
      died?.era && died.year !== null && died.year !== undefined
        ? `已故于${died.era}${died.year}年`
        : '',
    ].filter(Boolean).join('，');
    throw new RuinValidationError(
      `${name} 在候选时段（${candidate.span.label}）无法在场（${windowText || '生卒窗口与候选时段不相容'}）：`
      + '禁止让该人物作为在场角色出场。三选一：'
      + '① 把候选时间带整体后移到其出生年之后；② 更换参与人物；'
      + '③ 该候选走缺席叙事——她不进场，史稿写其到来之前/其影响之后的世界，'
      + '可在正文以「日后将……」「传说中……」点明其命运伏笔。',
      'CHARACTER_ABSENT_WINDOW',
    );
  }
}

/**
 * 从 lifespan 字符串提取日历日期（生卒语境）。
 * 语境过滤（#3）：日期前 8 字内出现「活跃于/活动于/在位/任职/统治于/担任」等
 * 非生卒语义时排除——「活跃于400年-410年」是活动范围，不是生卒，
 * 混入会被误判「410 年后已故」。
 */
function extractLifespanDates(value: string): Array<{ era: string; year: number }> {
  const pattern = /(创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(前)?\s*(\d+)年/gu;
  const NON_LIFESPAN_CONTEXT = /(?:活跃于|活动于|活跃期|在位|任职于|统治于|担任)/u;
  const matches = value.matchAll(pattern);
  const dates: Array<{ era: string; year: number }> = [];
  for (const match of matches) {
    const prefix = value.slice(Math.max(0, (match.index ?? 0) - 8), match.index ?? 0);
    if (NON_LIFESPAN_CONTEXT.test(prefix)) continue;
    dates.push({
      era: match[1],
      year: match[2] ? -Number(match[3]) : Number(match[3]),
    });
  }
  return dates.filter(item => Number.isFinite(item.year));
}

function applySharedCast(
  candidate: RuinCandidate,
  sharedCast: RuinCandidate['cast'],
  input: RuinGenerationInput,
  context?: RuinContextBundle,
): void {
  const sharedNames = new Set(sharedCast.map(member => normalizeText(member.name)));
  const hardAbsentNames = context
    ? hardAbsentPersonNames(context, input, [candidate])
    : new Set<string>();
  const requiredManifestNames = context
    ? new Set(manifestAnchors(context).map(anchor => normalizeText(anchor.name)))
    : new Set<string>();
  const hardAbsentRequiredNames = new Set(
    [...hardAbsentNames].filter(name => requiredManifestNames.has(name)),
  );
  const local = candidate.cast
    .filter(member => {
      const name = normalizeText(member.name);
      return !sharedNames.has(name) && !hardAbsentNames.has(name);
    })
    .slice(0, Math.max(0, 5 - sharedCast.length));
  candidate.cast = [
    ...sharedCast.map(anchor => {
      const detail = candidate.cast.find(member =>
        normalizeText(member.name) === normalizeText(anchor.name)
      );
      return {
        ...anchor,
        desire: detail?.desire || anchor.desire,
        constraint: detail?.constraint || anchor.constraint,
        inference: anchor.inference && (detail?.inference ?? true),
      };
    }),
    ...local,
  ];
  for (const node of candidate.nodes) {
    node.participants = node.participants.filter(participant =>
      !hardAbsentRequiredNames.has(normalizeText(participant)));
  }
  ensureCastParticipation(candidate.nodes, sharedCast.map(member => member.name));
  candidate.fusion.pressuredActors = candidate.cast.map(member => member.name).slice(0, 5);
  candidate.selectedCharacterUsage = localSelectedCharacterUsage(
    input,
    candidate.cast,
    candidate.nodes,
  );
}

function reconcileExpandedCast(
  value: unknown,
  outlineCast: RuinCandidate['cast'],
): RuinCandidate['cast'] {
  const details = Array.isArray(value) ? value.filter(isRecord) : [];
  return outlineCast.map(anchor => {
    const detail = details.find(item =>
      normalizeText(textValue(item.name)) === normalizeText(anchor.name)
    );
    return {
      ...anchor,
      desire: detail ? textValue(detail.desire) || anchor.desire : anchor.desire,
      constraint: detail
        ? textValue(detail.constraint) || anchor.constraint
        : anchor.constraint,
      inference: detail ? booleanValue(detail.inference, anchor.inference) : anchor.inference,
    };
  });
}

function ensureCastParticipation(
  nodes: Array<Pick<RuinNode, 'kind' | 'participants'>>,
  names: string[],
): void {
  if (!nodes.length || !names.length) return;
  const anchorNodes = nodes.filter(node => node.kind === 'process' || node.kind === 'anomaly');
  const targets = anchorNodes.length ? anchorNodes : nodes;
  names.forEach((name, index) => {
    const alreadyUsed = nodes.some(node =>
      node.participants.some(participant => normalizeText(participant) === normalizeText(name))
    );
    if (alreadyUsed) return;
    const target = targets[index % targets.length];
    target.participants = mergeUniqueStrings(target.participants, [name]);
  });
}

function mergeUniqueStrings(left: string[], right: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of [...left, ...right]) {
    const text = value.trim();
    const key = normalizeText(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function localSelectedCharacterUsage(
  input: RuinGenerationInput,
  cast: Array<{ name: string }>,
  nodes: Array<{ id: string; participants: string[] }>,
) {
  const castNames = new Set(cast.map(item => normalizeText(item.name)));
  return input.selectedCharacters.map(character => {
    const name = normalizeText(character.name);
    const linkedNodes = nodes.filter(node =>
      node.participants.some(participant => normalizeText(participant) === name)
    ).map(node => node.id);
    const actor = castNames.has(name) && linkedNodes.length > 0;
    return {
      name: character.name,
      mode: actor ? 'actor' as const : 'notApplicable' as const,
      role: actor ? 'Historical participant' : 'Reference only',
      reason: actor ? 'Named in the generated causal chain.' : 'No forced historical appearance.',
      nodeIds: actor ? linkedNodes : [],
    };
  });
}

/**
 * 大纲候选的 shift 归一化：缺失或无效不再伪造为主导时期，
 * from === to 视为退化(起点终点同时期无转变可言),抛错走大纲 repair。
 */
function normalizeCandidateShift(
  value: unknown,
  periodType: RuinPeriodType,
  fallbackExplanation: string,
): { from: RuinPeriodType; to: RuinPeriodType; explanation: string } {
  const source = readRecord(value);
  const from = periodValue(source.from);
  const to = periodValue(source.to);
  if (!from || !to) {
    throw new RuinValidationError(
      `Ruin candidate shift is missing or invalid: from=${JSON.stringify(source.from)}, to=${JSON.stringify(source.to)}. `
      + `请填写 stable/transition/turbulent；主导时期 ${periodType} 可作为任一端点，但两个端点必须不同。`,
      'SHIFT_INVALID',
    );
  }
  const shift = {
    from,
    to,
    explanation: textValue(source.explanation) || fallbackExplanation,
  };
  if (shift.from === shift.to) {
    throw new RuinValidationError(
      `Ruin candidate shift is degenerate: from and to are both ${shift.from}. `
      + 'shift.from 必须是该候选起点时期的稳定期/过渡期/动荡期，shift.to 是终点时期的时期状态，'
      + '二者必须不同（如 稳定期→动荡期、过渡期→稳定期）；任一端点可以与主导时期 periodType 同值，不得为了过校验虚构转向。',
      'SHIFT_SAME_PERIOD',
    );
  }
  return shift;
}

function periodValue(value: unknown): RuinPeriodType | undefined {
  const map: Record<string, RuinPeriodType> = {
    stable: 'stable',
    transition: 'transition',
    turbulent: 'turbulent',
    稳定期: 'stable',
    过渡期: 'transition',
    动荡期: 'turbulent',
    稳定: 'stable',
    过渡: 'transition',
    动荡: 'turbulent',
  };
  return map[textValue(value).normalize('NFKC').toLowerCase().replace(/\s+period$/u, '')];
}

function normalizedSpan(
  value: unknown,
  nodes: RuinNode[],
  input: RuinGenerationInput,
) {
  const source = readRecord(value);
  const first = nodes[0].time;
  const last = nodes[nodes.length - 1].time;
  const start = normalizeDate(source.start, first);
  const end = normalizeDate(source.end, last);
  const boundedStart = compareTuple(lowerDateTuple(start), lowerDateTuple(first)) > 0
    ? nodeDate(nodes[0])
    : start;
  const boundedEnd = compareTuple(upperDateTuple(end), upperDateTuple(last)) < 0
    ? nodeDate(nodes[nodes.length - 1])
    : end;
  return {
    start: boundedStart,
    end: boundedEnd,
    label: formatRuinSpanLabel(input.era, boundedStart, boundedEnd),
  };
}

function normalizeNodeTime(
  value: unknown,
  fallback: { year: number | null; month: number | null; day: number | null } | null,
  input: RuinGenerationInput,
  index: number,
  automaticTimeRange = false,
) {
  const source = readRecord(value);
  const date = normalizeDate(source, fallback);
  const hour = nullableInteger(source.hour) ?? (automaticTimeRange ? [8, 11, 15, 19][index % 4] : null);
  const minute = nullableInteger(source.minute) ?? (automaticTimeRange ? [0, 20, 40, 0][index % 4] : null);
  return {
    ...date,
    hour,
    minute,
    label: formatRuinNodeTimeCard(input.era, {
      year: date.year,
      month: date.month,
      day: date.day,
      hour,
      minute,
    }),
  };
}

function interpolateDate(
  start: { year: number | null; month: number | null; day: number | null } | null,
  end: { year: number | null; month: number | null; day: number | null } | null,
  index: number,
  count: number,
): { year: number | null; month: number | null; day: number | null } | null {
  if (!start || !end || start.year === null || end.year === null) {
    return index === count - 1 ? end : start;
  }
  const startDate = utcDate(start.year, start.month ?? 1, start.day ?? 1);
  const endDate = utcDate(end.year, end.month ?? 12, end.day ?? 28);
  const ratio = count <= 1 ? 0 : index / (count - 1);
  const current = new Date(startDate.getTime() + ((endDate.getTime() - startDate.getTime()) * ratio));
  return {
    year: current.getUTCFullYear(),
    month: current.getUTCMonth() + 1,
    day: current.getUTCDate(),
  };
}

function utcDate(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
}

function normalizeDate(
  value: unknown,
  fallback: { year: number | null; month: number | null; day: number | null } | null,
) {
  const source = readRecord(value);
  const rawYear = source.year === null || source.year === undefined || source.year === ''
    ? fallback?.year ?? null
    : integerValue(source.year, fallback?.year ?? null);
  // 只归一化格式/缺省值；不得把模型明确的史实日期偷偷钳进请求窗口。
  // 越界交给既有范围校验与修复，避免生日事件被脚本搬到错误年份。
  return {
    // 纪元从 1 年开始：0/负数不是合法年份，模型爱用 0 当「未详」占位 → 归一化为 null。
    year: rawYear === null || rawYear <= 0 ? null : rawYear,
    month: calendarPart(source.month, fallback?.month ?? null, 12),
    day: calendarPart(source.day, fallback?.day ?? null, 31),
  };
}

function makeCandidateTitlesDistinct(candidates: RuinCandidate[]): void {
  const seen = new Map<string, number>();
  for (const candidate of candidates) {
    const key = normalizeText(candidate.title);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count > 0) candidate.title = `${candidate.title} (${count + 1})`;
  }
}

interface RuinBranchSignature {
  actor: string;
  action: string;
  object: string;
  mechanism: string;
  outcome: string;
}

function normalizeBranchSignatureText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Script=Han}]{2,8}纪元/gu, '')
    .replace(/\d+(?:年|月|日|时|分)?/gu, '')
    .replace(/(?:某年|当年|次年|随后|最终|期间|时期|阶段)/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function branchTextSimilarity(left: string, right: string): number {
  const a = normalizeBranchSignatureText(left);
  const b = normalizeBranchSignatureText(right);
  if (!a || !b) return 0;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return 1;
  const grams = (value: string): Set<string> => {
    const result = new Set<string>();
    for (let index = 0; index < value.length - 1; index += 1) {
      result.add(value.slice(index, index + 2));
    }
    return result;
  };
  const aGrams = grams(a);
  const bGrams = grams(b);
  let shared = 0;
  for (const gram of aGrams) if (bGrams.has(gram)) shared += 1;
  return (2 * shared) / Math.max(1, aGrams.size + bGrams.size);
}

function readRuinBranchSignature(value: unknown, index: number): RuinBranchSignature {
  if (!isRecord(value)) {
    throw new RuinValidationError(
      `Candidate ${index + 1} is not an object`,
      'OUTLINE_BRANCH_SIGNATURE_MISSING',
    );
  }
  // 兼容旧响应：首版模型若遗漏签名，用现有提纲字段确定性派生；新提示词仍要求显式输出。
  const explicitSignature = isRecord(value.branchSignature);
  const signature = explicitSignature ? value.branchSignature as Record<string, unknown> : {
    actor: Array.isArray(value.cast)
      ? value.cast.map(item => isRecord(item) ? textValue(item.name) : '').filter(Boolean).join('、')
      : '',
    action: textValue(value.premise),
    object: textValue(value.summary),
    mechanism: Array.isArray(value.nodes)
      ? value.nodes.map(item => isRecord(item) ? textValue(item.summary) : '').filter(Boolean).join('；')
      : '',
    outcome: textValue(value.historicalResult),
  };
  const result: RuinBranchSignature = {
    actor: textValue(signature.actor) || `legacy-actor-${index + 1}`,
    action: textValue(signature.action) || `legacy-action-${index + 1}`,
    object: textValue(signature.object) || `legacy-object-${index + 1}`,
    mechanism: textValue(signature.mechanism) || `legacy-mechanism-${index + 1}`,
    outcome: textValue(signature.outcome) || `legacy-outcome-${index + 1}`,
  };
  if (explicitSignature && Object.values(signature).some(item => !textValue(item))) {
    throw new RuinValidationError(
      `Candidate ${index + 1} branchSignature is incomplete`,
      'OUTLINE_BRANCH_SIGNATURE_INVALID',
    );
  }
  return result;
}

function assertDistinctRuinBranchSignatures(candidates: unknown[]): void {
  // 旧版/缓存提纲没有该输出字段；兼容读取但不冒充已经过新护栏。
  // 新版 prompt 要求每个候选显式输出，只有整批齐全时才执行跨候选机器判重。
  if (candidates.some(candidate => !isRecord(candidate) || !isRecord(candidate.branchSignature))) return;
  const signatures = candidates.map(readRuinBranchSignature);
  const keys: Array<keyof RuinBranchSignature> = [
    'actor', 'action', 'object', 'mechanism', 'outcome',
  ];
  for (let left = 0; left < signatures.length; left += 1) {
    for (let right = left + 1; right < signatures.length; right += 1) {
      const fieldMatches = keys.filter(key =>
        branchTextSimilarity(signatures[left]![key], signatures[right]![key]) >= 0.62
      ).length;
      const combinedSimilarity = branchTextSimilarity(
        keys.map(key => signatures[left]![key]).join('|'),
        keys.map(key => signatures[right]![key]).join('|'),
      );
      if (fieldMatches >= 4 || combinedSimilarity >= 0.74) {
        throw new RuinValidationError(
          `Candidates ${left + 1} and ${right + 1} describe the same event; changing dates or details is not a distinct branch`,
          'OUTLINE_BRANCH_DUPLICATE',
        );
      }
    }
  }
}

function validQualityChecks() {
  return {
    threeMaterialsIntegrated: true,
    causalChainComplete: true,
    anomalyEnterable: true,
    timelineConsistent: true,
    distinctFromOtherCandidates: true,
    supplementaryDirectionFulfilled: true,
    selectedCharactersReconciled: true,
    clicheDependence: false,
  };
}

function normalizeBranches(value: unknown, fallback: string) {
  const branches = Array.isArray(value) ? value.flatMap(item => {
    if (!isRecord(item)) return [];
    const condition = textValue(item.condition);
    const consequence = textValue(item.consequence);
    return condition && consequence ? [{ condition, consequence }] : [];
  }) : [];
  if (branches.length >= 2) return branches.slice(0, 4);
  return [
    { condition: 'Intervene directly', consequence: `Alter ${fallback}` },
    { condition: 'Observe without intervention', consequence: `Preserve ${fallback}` },
  ];
}

function defaultStageIntervention(kind: RuinNode['kind']): string {
  return {
    origin: '可调查、阻止或改变起因形成时的关键选择与条件。',
    process: '可介入事态扩散、资源流动与人物关系的累积过程。',
    anomaly: '可在因果汇聚的高潮时刻作出直接选择。',
    result: '可追查、救援、保存证据或改变既成事件的后续影响。',
  }[kind];
}

function normalizeInterests(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!isRecord(item)) return [];
    const actor = textValue(item.actor);
    const wants = textValue(item.wants);
    if (!actor || !wants) return [];
    return [{
      actor,
      wants,
      fears: textValue(item.fears) || 'Loss of status, resources, or safety.',
    }];
  });
}

function outlineNodeKind(value: unknown, index: number, total: number): RuinNode['kind'] {
  if (index === 0) return 'origin';
  if (index === total - 1) return 'result';
  if (index === total - 2) return 'anomaly';
  return value === 'process' ? 'process' : 'process';
}

function castKind(value: unknown): 'person' | 'family' | 'organization' | 'faction' | 'community' {
  const normalized = textValue(value).toLowerCase();
  if (['person', 'family', 'organization', 'faction', 'community'].includes(normalized)) {
    return normalized as 'person' | 'family' | 'organization' | 'faction' | 'community';
  }
  return 'person';
}

function bridgeType(value: unknown): 'person' | 'resource' | 'institution' | 'location' | 'relationship' | 'technology' | 'custom' | 'other' {
  const normalized = textValue(value).toLowerCase();
  if (['person', 'resource', 'institution', 'location', 'relationship', 'technology', 'custom', 'other'].includes(normalized)) {
    return normalized as ReturnType<typeof bridgeType>;
  }
  return 'other';
}

function readRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown, fallback: string[] = []): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const result = value.map(textValue).filter(Boolean);
  return result.length ? result : [...fallback];
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return fallback;
}

function integerValue(value: unknown, fallback: number | null): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : null;
}

function calendarPart(value: unknown, fallback: number | null, maximum: number): number | null {
  const numeric = nullableInteger(value);
  if (numeric === null) return fallback;
  return Math.min(maximum, Math.max(1, numeric));
}

function normalizeText(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

function readPath(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

function formatIssuePath(path: PropertyKey[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') return `${result}[${segment}]`;
    const key = String(segment);
    return result ? `${result}.${key}` : key;
  }, '');
}

function describeInvalidValues(
  issues: ReadonlyArray<{ path: PropertyKey[] }>,
  parsed: unknown,
): string {
  const details = issues.slice(0, 6).map(issue => {
    const path = formatIssuePath(issue.path);
    const received = readPath(parsed, issue.path);
    return `${path || '<root>'} received=${JSON.stringify(received)}`;
  });
  return details.length ? `; ${details.join('; ')}` : '';
}

function chineseCharacterCount(source: string): number {
  return source.match(/\p{Script=Han}/gu)?.length ?? 0;
}

function timeTuple(node: RuinNode): number[] {
  const { year, month, day, hour, minute } = node.time;
  return [year ?? 0, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0];
}

function describeNodeTime(node: RuinNode, index: number): string {
  const [year, month, day, hour, minute] = timeTuple(node);
  const numeric = [
    String(year),
    String(month).padStart(2, '0'),
    String(day).padStart(2, '0'),
    String(hour).padStart(2, '0'),
    String(minute).padStart(2, '0'),
  ].join('-');
  return `nodes[${index}](${node.kind}, ${numeric}, label=${JSON.stringify(node.time.label)})`;
}

function lowerDateTuple(date: {
  year: number | null;
  month: number | null;
  day: number | null;
}): number[] {
  return [date.year ?? 0, date.month ?? 1, date.day ?? 1];
}

function upperDateTuple(date: {
  year: number | null;
  month: number | null;
  day: number | null;
}): number[] {
  return [date.year ?? 0, date.month ?? 12, date.day ?? 31];
}

type RuinDateValue = {
  year: number | null;
  month: number | null;
  day: number | null;
};

function nodeDate(node: RuinNode): RuinDateValue {
  return {
    year: node.time.year,
    month: node.time.month,
    day: node.time.day,
  };
}

function compareTuple(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function allSourceRefs(result: RuinCandidates): string[] {
  return result.candidates.flatMap(candidate => [
    ...candidate.sourceRefs,
    ...candidate.cast.flatMap(member => member.sourceRefs),
    ...candidate.nodes.flatMap(node => node.sourceRefs),
  ]);
}

export function parseAndValidateRuinCandidateResponse(
  raw: string,
  expected: {
    requestId: string;
    input: RuinGenerationInput;
    material: RuinMaterial;
    context: RuinContextBundle;
    citationRegistry?: TaskCitationRegistry;
  },
): RuinCandidate {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.ruin.candidate.v1',
      discriminators: {
        requestId: expected.requestId,
        candidateKey: expected.material.candidateKey,
      },
    });
  } catch (error) {
    throw new RuinValidationError(
      error instanceof Error ? error.message : 'Ruin candidate response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }

  if (isRuinContextEcho(parsed)) {
    throw new RuinValidationError(
      'Ruin candidate model echoed the read-only context instead of a candidate result',
      'CONTEXT_ECHO',
    );
  }

  const result = RuinCandidateResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuinValidationError(
      result.error.message + describeInvalidValues(result.error.issues, parsed),
      'SCHEMA_INVALID',
    );
  }
  const response = result.data;
  if (response.requestId !== expected.requestId) {
    throw new RuinValidationError('Ruin candidate requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (response.era !== expected.input.era) {
    throw new RuinValidationError('Ruin candidate era differs from the request', 'ERA_MISMATCH');
  }
  if (normalizeText(response.location) !== normalizeText(expected.input.location)) {
    throw new RuinValidationError('Ruin candidate location differs from the request', 'LOCATION_MISMATCH');
  }
  if (
    response.candidateKey !== expected.material.candidateKey
    || response.candidate.candidateKey !== expected.material.candidateKey
    || response.candidate.periodType !== expected.material.periodType
  ) {
    throw new RuinValidationError('Ruin candidate material mapping mismatch', 'MATERIAL_MISMATCH');
  }
  validateRuinCandidate(response.candidate, {
    input: expected.input,
    material: expected.material,
    context: expected.context,
  });
  return response.candidate;
}

export function parseAndValidateRuinPlanResponse(
  raw: string,
  expected: {
    requestId: string;
    input: RuinGenerationInput;
  },
): RuinCandidatePlan[] {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.ruin.plan.v1',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new RuinValidationError(
      error instanceof Error ? error.message : 'Ruin plan response is not valid JSON',
      'PLAN_JSON_INVALID',
    );
  }

  const result = RuinPlanResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuinValidationError(
      result.error.message + describeInvalidValues(result.error.issues, parsed),
      'PLAN_SCHEMA_INVALID',
    );
  }
  if (result.data.requestId !== expected.requestId) {
    throw new RuinValidationError('Ruin plan requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (result.data.plans.length !== expected.input.materials.length) {
    throw new RuinValidationError('Ruin plan count mismatch', 'PLAN_COUNT_MISMATCH');
  }

  const titles = new Set<string>();
  const knownIdentities = new Map<string, string>();
  for (const [index, plan] of result.data.plans.entries()) {
    const material = expected.input.materials[index];
    if (
      !material
      || plan.candidateKey !== material.candidateKey
      || plan.periodType !== material.periodType
    ) {
      throw new RuinValidationError('Ruin plan material mapping mismatch', 'PLAN_MAPPING_MISMATCH');
    }
    const title = normalizeText(plan.titleDirection);
    if (titles.has(title)) {
      throw new RuinValidationError('Ruin plan title directions must be distinct', 'PLAN_DUPLICATE');
    }
    titles.add(title);
    for (const member of plan.castDirection) {
      const name = normalizeText(member.name);
      const identity = normalizeText(member.identity);
      const knownIdentity = knownIdentities.get(name);
      if (knownIdentity && knownIdentity !== identity) {
        throw new RuinValidationError(
          `The plan name “${member.name}” belongs to conflicting identities`,
          'PLAN_IDENTITY_CONFLICT',
        );
      }
      knownIdentities.set(name, identity);
    }
  }
  return result.data.plans;
}

export function parseAndValidateRuinCandidates(
  raw: string,
  expected: {
    requestId: string;
    directive: string;
    input: RuinGenerationInput;
    context: RuinContextBundle;
  },
): RuinCandidates {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.ruin.candidates.v2',
      discriminators: { requestId: expected.requestId },
    });
  } catch (error) {
    throw new RuinValidationError(
      error instanceof Error ? error.message : 'Ruin response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }
  if (isRuinContextEcho(parsed)) {
    throw new RuinValidationError(
      '墟境生成模型回显了只读史料包，而不是 eyon.ruin.candidates.v2 结果',
      'CONTEXT_ECHO',
    );
  }

  const apiError = RuinCandidatesErrorSchema.safeParse(parsed);
  if (apiError.success) {
    if (apiError.data.requestId && apiError.data.requestId !== expected.requestId) {
      throw new RuinValidationError('Ruin error response requestId mismatch', 'REQUEST_MISMATCH');
    }
    throw new RuinValidationError(apiError.data.error.message, apiError.data.error.code);
  }

  const result = RuinCandidatesSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuinValidationError(result.error.message, 'SCHEMA_INVALID');
  }

  const ruins = result.data;
  if (ruins.requestId !== expected.requestId) {
    throw new RuinValidationError('Ruin requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (ruins.era !== expected.input.era) {
    throw new RuinValidationError('Ruin era differs from the request', 'ERA_MISMATCH');
  }
  if (normalizeText(ruins.location) !== normalizeText(expected.input.location)) {
    throw new RuinValidationError('Ruin location differs from the request', 'LOCATION_MISMATCH');
  }
  if (
    ruins.wave.level !== expected.input.wave.level
    || ruins.wave.candidateCount !== expected.input.wave.candidateCount
    || ruins.candidates.length !== expected.input.wave.candidateCount
  ) {
    throw new RuinValidationError('Ruin wave or candidate count mismatch', 'COUNT_MISMATCH');
  }

  const expectedMaterials = new Map(
    expected.input.materials.map(material => [material.candidateKey, material]),
  );
  const candidateIds = new Set<string>();
  const candidateKeys = new Set<string>();
  const candidateTitles = new Set<string>();
  const castIdentities = new Map<string, string>();
  for (const candidate of ruins.candidates) {
    if (candidateIds.has(candidate.id)) {
      throw new RuinValidationError('Ruin candidate IDs must be unique', 'CANDIDATE_ID_DUPLICATE');
    }
    candidateIds.add(candidate.id);
    if (candidateKeys.has(candidate.candidateKey)) {
      throw new RuinValidationError('Ruin candidate keys must be unique', 'CANDIDATE_KEY_DUPLICATE');
    }
    candidateKeys.add(candidate.candidateKey);
    const normalizedTitle = normalizeText(candidate.title);
    if (candidateTitles.has(normalizedTitle)) {
      throw new RuinValidationError('Ruin candidate titles must be distinct', 'CANDIDATE_DUPLICATE');
    }
    candidateTitles.add(normalizedTitle);

    for (const member of candidate.cast) {
      const name = normalizeText(member.name);
      const identity = normalizeText(member.identity);
      const knownIdentity = castIdentities.get(name);
      if (knownIdentity && knownIdentity !== identity) {
        throw new RuinValidationError(
          `The name “${member.name}” was assigned to different historical identities across candidates`,
          'CANDIDATE_IDENTITY_CONFLICT',
        );
      }
      castIdentities.set(name, identity);
    }

    const material = expectedMaterials.get(candidate.candidateKey);
    if (!material) {
      throw new RuinValidationError('Ruin candidate material mapping mismatch', 'MATERIAL_MISMATCH');
    }
    validateRuinCandidate(candidate, {
      input: expected.input,
      material,
      context: expected.context,
    });
  }

  if (candidateKeys.size !== expectedMaterials.size) {
    throw new RuinValidationError('Not every material set produced one candidate', 'MATERIAL_COUNT_MISMATCH');
  }

  // 兼容旧的整批候选入口时也必须执行与 outline-first 链路相同的跨候选 Canon 约束，
  // 避免同一既定事件在三个候选里只换年份或细节后重复发生。
  validateCanonInterpretations(ruins.candidates, expected.context);

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
  for (const sourceRef of allSourceRefs(ruins)) {
    if (!knownSources.has(sourceRef)) {
      throw new RuinValidationError(`Unknown source reference: ${sourceRef}`, 'SOURCE_NOT_FOUND');
    }
  }

  return ruins;
}

function validateRuinCandidate(
  candidate: RuinCandidate,
  expected: {
    input: RuinGenerationInput;
    material: RuinMaterial;
    context: RuinContextBundle;
    citationRegistry?: TaskCitationRegistry;
  },
): void {
  validateActorPolicy(candidate, expected.context);
  if (
    candidate.candidateKey !== expected.material.candidateKey
    || candidate.periodType !== expected.material.periodType
  ) {
    throw new RuinValidationError('Ruin candidate material mapping mismatch', 'MATERIAL_MISMATCH');
  }

  validateCanonInterpretations(
    [candidate],
    expected.context,
    expected.citationRegistry,
  );

  validateMaterialLabelsAreHidden(candidate, expected.material);

  const proseLength = chineseCharacterCount(candidate.historyProse);
  // Keep a tolerant envelope around the 500-character target. Structural
  // completeness matters more than retrying over a small length difference.
  if (proseLength < RUIN_PROSE_ACCEPTED_MIN || proseLength > RUIN_PROSE_ACCEPTED_MAX) {
    throw new RuinValidationError(
      proseLength < RUIN_PROSE_ACCEPTED_MIN
        ? ruinProseExpansionGuidance(proseLength)
        : `Ruin history prose is too long: ${proseLength} chars, max ${RUIN_PROSE_ACCEPTED_MAX}. `
          + '压缩重复描写与次要细节，保留因果主线与在场人物动作。',
      'PROSE_LENGTH_INVALID',
    );
  }

  validateCandidateTimeline(candidate, expected.input, expected.context);
  validateHistoryOpeningTime(candidate, expected.input);
  // 人物在场硬校验（扩写端安全网）：大纲端已拦，这里兜底（含 repair 后的再次校验）。
  assertIncompatibleCharactersAbsent(candidate, expected.input, expected.context);
  // 时间词汇不再致命拦截：时代错位交由模型基于 ERA_PROFILE 自行判断与合理化，
  // validator 只保证结构与证据完整性。
  validateSelectedCharacters(
    candidate,
    expected.input.selectedCharacters.map(item => item.name),
  );
  validateCanonicalCharacterFidelity(candidate, expected.input.selectedCharacters);

  const checks = candidate.qualityChecks;
  if (
    !checks.threeMaterialsIntegrated
    || !checks.causalChainComplete
    || !checks.anomalyEnterable
    || !checks.timelineConsistent
    || !checks.distinctFromOtherCandidates
    || !checks.selectedCharactersReconciled
    || checks.clicheDependence
    || (expected.input.supplementaryDirection.trim() && !checks.supplementaryDirectionFulfilled)
  ) {
    throw new RuinValidationError('Ruin quality checks report an unresolved defect', 'QUALITY_CHECK_FAILED');
  }

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
  const sourceRefs = [
    ...candidate.sourceRefs,
    ...candidate.cast.flatMap(member => member.sourceRefs),
    ...candidate.nodes.flatMap(node => node.sourceRefs),
  ];
  for (const sourceRef of sourceRefs) {
    if (!knownSources.has(sourceRef)) {
      throw new RuinValidationError(`Unknown source reference: ${sourceRef}`, 'SOURCE_NOT_FOUND');
    }
  }
}

function validateActorPolicy(candidate: RuinCandidate, context: RuinContextBundle): void {
  const blocked = [...candidate.cast.map(member => member.name), ...candidate.nodes.flatMap(node => node.participants)]
    .find(name => blockedRuinActor(context.actorPolicy, name));
  if (blocked) throw new RuinValidationError(
    `谱系人物「${blocked}」未获本次出场许可：仅可引用亲缘或资料，不得作为现场演员。保留当前方向，改用本地人物；要让其出场请手选或明确指定。`,
    'GENEALOGY_ACTOR_NOT_REQUESTED',
  );
}

function temporalClaimText(candidate: RuinCandidate): string {
  return [
    candidate.title,
    candidate.premise,
    candidate.summary,
    candidate.historyProse,
    JSON.stringify(candidate.fusion),
    JSON.stringify(candidate.shift),
    JSON.stringify(candidate.historicalTexture),
    ...candidate.cast.map(({ sourceRefs: _sourceRefs, ...member }) => JSON.stringify(member)),
    ...candidate.nodes.map(({ sourceRefs: _sourceRefs, ...node }) => JSON.stringify(node)),
    ...candidate.inferenceNotes,
  ].join('\n');
}

function validateMaterialLabelsAreHidden(
  candidate: RuinCandidate,
  material: RuinMaterial,
): void {
  const visibleText = normalizeText(JSON.stringify(candidate));
  const forbidden = [
    '背景底色',
    '核心冲突',
    '转折导火索',
    ...[material.background, material.conflict, material.trigger]
      .map(materialLabel)
      .filter(Boolean),
  ];
  const leaked = forbidden.find(label =>
    visibleText.includes(normalizeText(label))
  );
  if (leaked) {
    throw new RuinValidationError(
      `Ruin candidate exposed a backstage dice label: ${leaked}`,
      'MATERIAL_LABEL_LEAK',
    );
  }
}

function materialLabel(value: string): string {
  const parts = value.split('｜').map(part => part.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[1] : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRuinContextEcho(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const contextKeys = [
    'taskType',
    'scope',
    'currentWorld',
    'generationInput',
    'worldbookContext',
    'recentContext',
    'characterContext',
    'genealogyRefs',
    'biographyRefs',
    'butterflyRefs',
    'sourceIndex',
    'warnings',
  ];
  return contextKeys.filter(key => key in value).length >= 3;
}

function validateCandidateTimeline(
  candidate: RuinCandidates['candidates'][number],
  input: RuinGenerationInput,
  context: RuinContextBundle,
): void {
  reconcileCandidateSpan(candidate, input);
  // 未来时间硬门（扩写端安全网）：大纲端已拦，这里兜底（含 repair 后的再次校验）。
  assertRuinNotInFuture(candidate, input, context);
  // 扩写阶段不再重复判定时间线退化:节点时间继承自大纲,退化与否大纲端已判;
  // 且扩写端 label 已被脚本确定性渲染,无法再区分「模型写的相对纪年标签」。
  const spanStart = lowerDateTuple(candidate.span.start);
  const spanEnd = upperDateTuple(candidate.span.end);
  if (compareTuple(spanStart, spanEnd) > 0) {
    throw new RuinValidationError('Ruin candidate span is reversed', 'SPAN_REVERSED');
  }
  if (input.start && compareTuple(spanStart, lowerDateTuple(input.start)) < 0) {
    throw new RuinValidationError('Ruin candidate starts before the requested range', 'SPAN_OUT_OF_RANGE');
  }
  if (input.end && compareTuple(spanEnd, upperDateTuple(input.end)) > 0) {
    throw new RuinValidationError('Ruin candidate ends after the requested range', 'SPAN_OUT_OF_RANGE');
  }
  for (const node of candidate.nodes) {
    // 与跨度边界同口径：null 月/日按 1/1 与 12/31 参与比较，
    // 避免相对纪年（月/日缺省）的节点被误判为落在跨度外。
    const nodeStart = lowerDateTuple(nodeDate(node));
    const nodeEnd = upperDateTuple(nodeDate(node));
    if (
      compareTuple(nodeStart, spanStart) < 0
      || compareTuple(nodeEnd, spanEnd) > 0
    ) {
      throw new RuinValidationError('Ruin node falls outside its candidate span', 'NODE_OUT_OF_SPAN');
    }
  }
  validateNodes(candidate.nodes, candidate.title);
}

/**
 * 防退化时间线：玩家未给起止时间时，禁止把整条时间线压成同一天
 * （最常见是「纪元元年1月1日」或全节点 year=0 的未详占位）。
 * 判定 = 所有节点日期全同，且（模型未亲手写标签 或 标签也无区分度）：
 * 只有「模型主动写了有区分度的相对纪年标签（第X代人/早期·中期·晚期）」才算相对纪年；
 * 自动生成的编号标签不算数。
 * 大纲与扩写两端都查：大纲端触发 outline repair（可整体重写）；扩写端是安全网。
 */
/**
 * 该节点是否由模型亲手写了 label（顶层或 time.label 任一）：
 * 用于区分「模型主动写的相对纪年标签」与「脚本自动生成的编号标签」。
 */
function nodeHasModelLabel(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Boolean(textValue(value.label))) return true;
  const time = value.time;
  return isRecord(time) && Boolean(textValue(time.label));
}

/**
 * 收集模型原始输出的 label(顶层 label 优先,其次 time.label):
 * 用于在脚本确定性重渲染后仍能判定「模型写的相对纪年标签是否有区分度」。
 */
function modelLabelsFromRaw(rawNodes: unknown[]): string[] {
  return rawNodes.map(value => {
    if (!isRecord(value)) return '';
    const top = textValue(value.label);
    if (top) return top;
    const time = value.time;
    return isRecord(time) ? textValue(time.label) : '';
  });
}

function assertTimelineNotDegenerate(
  nodes: RuinNode[],
  input: RuinGenerationInput,
  labelsFromModel: boolean,
  modelLabels: string[] = [],
): void {
  if (input.start || input.end) return; // 玩家给了范围：以玩家边界为准
  if (nodes.length === 0) return;
  const firstTuple = timeTuple(nodes[0]);
  const sameDates = nodes.every(node => compareTuple(timeTuple(node), firstTuple) === 0);
  if (!sameDates) return;
  // 模型写的相对纪年标签有区分度才放行;脚本渲染的编号标签不算数
  if (labelsFromModel && new Set(modelLabels.map(label => label.trim()).filter(Boolean)).size > 1) {
    return;
  }
  throw new RuinValidationError(
    'Ruin candidate timeline is degenerate: all nodes share the same date '
    + '(often 纪元元年1月1日 or an unspecified year-0 placeholder). '
    + '请给各节点补上互不相同、按时间先后排列的日期：优先用史料可考的年份（≥1）；'
    + '史料无可用年份时，用相对纪年（第X代人/早期·中期·晚期）并让 year 缺省/为 null（禁止写 0）、'
    + 'month/day 保持 null，同时给每个节点写一个能区分前后的 label；'
    + '禁止把整条时间线压成同一天。',
    'TIMELINE_DEGENERATE',
  );
}

function reconcileCandidateSpan(
  candidate: RuinCandidates['candidates'][number],
  input: RuinGenerationInput,
): void {
  if (!candidate.nodes.length) return;

  const requestedStart = input.start ? lowerDateTuple(input.start) : null;
  const requestedEnd = input.end ? upperDateTuple(input.end) : null;
  let corrected = false;
  for (const [index, node] of candidate.nodes.entries()) {
    const date = nodeDate(node);
    if (
      (requestedStart && compareTuple(lowerDateTuple(date), requestedStart) < 0)
      || (requestedEnd && compareTuple(upperDateTuple(date), requestedEnd) > 0)
    ) {
      throw new RuinValidationError(
        `Ruin node exceeds the player requested range: ${describeNodeTime(node, index)}`,
        'NODE_OUT_OF_REQUEST_RANGE',
      );
    }
  }

  if (input.start && requestedStart && compareTuple(lowerDateTuple(candidate.span.start), requestedStart) < 0) {
    candidate.span.start = { ...input.start };
    corrected = true;
  }
  if (input.end && requestedEnd && compareTuple(upperDateTuple(candidate.span.end), requestedEnd) > 0) {
    candidate.span.end = { ...input.end };
    corrected = true;
  }

  const firstNodeDate = nodeDate(candidate.nodes[0]);
  const lastNodeDate = nodeDate(candidate.nodes[candidate.nodes.length - 1]);
  if (compareTuple(lowerDateTuple(firstNodeDate), lowerDateTuple(candidate.span.start)) < 0) {
    candidate.span.start = firstNodeDate;
    corrected = true;
  }
  if (compareTuple(upperDateTuple(lastNodeDate), upperDateTuple(candidate.span.end)) > 0) {
    candidate.span.end = lastNodeDate;
    corrected = true;
  }

  if (corrected) {
    candidate.span.label = formatRuinSpanLabel(
      input.era,
      candidate.span.start,
      candidate.span.end,
    );
  }
}

/**
 * 当前剧情时间上限（穿越只能进入过去/现在）：从 currentWorld.time 解析，
 * 解析失败或纪元未知时返回 null（不拦截，避免误伤）。
 */
function resolveNowCap(context: RuinContextBundle): { era: string; year: number } | null {
  const parsed = parseWorldTime(context.currentWorld.time);
  if (parsed.era === null || parsed.year === null) return null;
  return { era: parsed.era, year: parsed.year };
}

/**
 * 未来时间硬门：任何节点或跨度不得晚于当前剧情时间（currentWorld.time）。
 * 玩家显式把时间范围填到未来同样受此上限约束——时间穿越只能回到过去。
 * 超限走既有 repair 路径（大纲整体修复/扩写定向修复），脚本不篡改历史日期。
 */
function assertRuinNotInFuture(
  candidate: RuinCandidates['candidates'][number],
  input: RuinGenerationInput,
  context: RuinContextBundle,
): void {
  const cap = resolveNowCap(context);
  if (!cap) return;
  const capAbs = absoluteYear(cap.era, cap.year);
  const sameCustomEra = sameEraName(cap.era, input.era);
  if (capAbs === null && !sameCustomEra) return;
  const nowLabel = `${cap.era}${cap.year}年`;
  for (const [index, node] of candidate.nodes.entries()) {
    if (node.time.year === null) continue; // 相对纪年：无日历可比，不误伤
    const nodeAbs = absoluteYear(input.era, node.time.year);
    if ((nodeAbs !== null && capAbs !== null && nodeAbs > capAbs)
      || (sameCustomEra && node.time.year > cap.year)) {
      throw new RuinValidationError(
        `Ruin node is in the future: ${describeNodeTime(node, index)}. `
        + `穿越只能进入当前剧情时间（${nowLabel}）或更早；该节点晚于剧情现在，`
        + `请把该候选的全部节点与跨度整体前移到 ${nowLabel} 之前，或改选更早的历史时期；禁止进入未来。`,
        'NODE_IN_FUTURE',
      );
    }
  }
  if (candidate.span.end.year !== null) {
    const spanEndAbs = absoluteYear(input.era, candidate.span.end.year);
    if ((spanEndAbs !== null && capAbs !== null && spanEndAbs > capAbs)
      || (sameCustomEra && candidate.span.end.year > cap.year)) {
      throw new RuinValidationError(
        `Ruin candidate span ends in the future: ${candidate.span.end.year}. `
        + `穿越只能进入当前剧情时间（${nowLabel}）或更早；请把 span.end 前移到 ${nowLabel} 之前。`,
        'SPAN_IN_FUTURE',
      );
    }
  }
}

function sameEraName(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    === right.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

/**
 * 只校验史稿开场的第一个时间声明。后续节点可以跨月份、跨季节，
 * 但必须先从 origin 真实时点开场，再由模型写出过渡。
 */
function validateHistoryOpeningTime(
  candidate: RuinCandidate,
  input: RuinGenerationInput,
): void {
  const origin = candidate.nodes.find(node => node.kind === 'origin');
  const originMonth = origin?.time.month;
  if (originMonth === null || originMonth === undefined) return;
  const opening = candidate.historyProse.trim().split(/[。！？\n]/u)[0]?.slice(0, 180) ?? '';
  if (!opening) return;

  const explicitMonth = firstWrittenMonth(opening);
  if (explicitMonth !== null && explicitMonth !== originMonth) {
    throw new RuinValidationError(
      `historyProse 开头写成了 ${explicitMonth} 月，但缘起节点在 ${originMonth} 月。`
      + '请从缘起节点的真实时间开场，再用明确的时间过渡推进到后续节点。',
      'PROSE_ORIGIN_MONTH_MISMATCH',
    );
  }

  // 自定义历法未必与四季月份对应；不在无证据时套用地球季节。
  if (eraIndex(input.era) === null) return;
  const expectedSeason = seasonForMonth(originMonth);
  const writtenSeason = firstWrittenSeason(opening);
  if (writtenSeason && writtenSeason !== expectedSeason) {
    throw new RuinValidationError(
      `historyProse 开头的季节是“${writtenSeason}”，但缘起节点为 ${originMonth} 月（${expectedSeason}）。`
      + '请修正开场季节，并在跨月份或跨季节时写出自然的时间过渡。',
      'PROSE_ORIGIN_SEASON_MISMATCH',
    );
  }
}

function firstWrittenMonth(text: string): number | null {
  const arabic = text.match(/(?:^|[^\d])(1[0-2]|[1-9])月/u);
  if (arabic?.[1]) return Number(arabic[1]);
  const chinese = text.match(/([一二三四五六七八九十冬腊]{1,3})月/u)?.[1];
  if (!chinese) return null;
  const aliases: Record<string, number> = { 冬: 11, 腊: 12 };
  if (aliases[chinese]) return aliases[chinese];
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (chinese === '十') return 10;
  if (chinese.startsWith('十')) return 10 + (digits[chinese.slice(1)] ?? 0);
  return digits[chinese] ?? null;
}

type CalendarSeason = '春季' | '夏季' | '秋季' | '冬季';

function seasonForMonth(month: number): CalendarSeason {
  if (month >= 3 && month <= 5) return '春季';
  if (month >= 6 && month <= 8) return '夏季';
  if (month >= 9 && month <= 11) return '秋季';
  return '冬季';
}

function firstWrittenSeason(text: string): CalendarSeason | null {
  const candidates: Array<{ season: CalendarSeason; index: number }> = [
    { season: '春季', index: text.search(/初春|仲春|暮春|春季|春日|春末/u) },
    { season: '夏季', index: text.search(/初夏|仲夏|盛夏|夏季|夏日|夏末/u) },
    { season: '秋季', index: text.search(/初秋|仲秋|深秋|晚秋|秋季|秋日|秋末/u) },
    { season: '冬季', index: text.search(/初冬|仲冬|深冬|严冬|隆冬|寒冬|冬季|冬日|冬末/u) },
  ];
  const matches = candidates.filter(item => item.index >= 0);
  matches.sort((left, right) => left.index - right.index);
  return matches[0]?.season ?? null;
}

function validateNodes(nodes: RuinNode[], candidateTitle?: string): void {
  const ids = new Set<string>();
  let previousNode: RuinNode | null = null;
  let previousIndex = -1;
  let enterableAnomalies = 0;

  for (const [index, node] of nodes.entries()) {
    if (ids.has(node.id)) {
      // 报错可操作化（internal.77 三轮覆盖）：指明候选与重复 ID，repair 不再盲目重生成。
      throw new RuinValidationError(
        `Ruin node IDs must be unique${
          candidateTitle ? ` (候选《${candidateTitle}》)` : ''
        }：节点 ID '${node.id}' 在第 ${index + 1} 处重复；请改用唯一 id（通常 n1–n4，与 origin/process/anomaly/result 一一对应）。`,
        'NODE_ID_DUPLICATE',
      );
    }
    ids.add(node.id);

    const current = timeTuple(node);
    if (previousNode && compareTuple(timeTuple(previousNode), current) > 0) {
      throw new RuinValidationError(
        `Ruin node times must be monotonic: ${describeNodeTime(node, index)} precedes ${describeNodeTime(previousNode, previousIndex)}`,
        'NODE_TIME_REVERSED',
      );
    }
    previousNode = node;
    previousIndex = index;

    if (!isValidMvuLocation(node.location)) {
      throw new RuinValidationError(
        `Ruin node location must be a ${MVU_LOCATION_MIN_LEVELS}–${MVU_LOCATION_MAX_LEVELS} level MVU path: ${JSON.stringify(node.location)}. `
        + '请根据史料补足从大陆/大区到现场的父级路径，使用半角连字符从大到小连接；玩家表单中的简称可以保留为检索范围，但节点地点必须完整。',
        'NODE_LOCATION_INVALID',
      );
    }
    node.location = normalizeMvuLocation(node.location);

    if (node.enterable) {
      if (!node.intervention.trim() || node.possibleBranches.length < 1) {
        throw new RuinValidationError(
          'Enterable ruin stage lacks intervention guidance',
          'NODE_ENTRY_INCOMPLETE',
        );
      }
      if (node.kind === 'anomaly') enterableAnomalies += 1;
    }
  }

  if (enterableAnomalies === 0) {
    throw new RuinValidationError('Ruin candidate has no enterable climax', 'ANOMALY_MISSING');
  }
  if (nodes.some(node => !node.enterable)) {
    throw new RuinValidationError('All four ruin stages must be enterable', 'NODE_ENTRY_MISSING');
  }
}

function validateSelectedCharacters(
  candidate: RuinCandidates['candidates'][number],
  selectedNames: string[],
): void {
  const expected = new Set(selectedNames.map(normalizeText));
  const actual = candidate.selectedCharacterUsage.map(item => normalizeText(item.name));
  if (new Set(actual).size !== actual.length || actual.length !== expected.size) {
    throw new RuinValidationError(
      'Selected character usage must contain each requested character exactly once',
      'SELECTED_CHARACTER_MISMATCH',
    );
  }
  for (const name of actual) {
    if (!expected.has(name)) {
      throw new RuinValidationError(`Unexpected selected character usage: ${name}`, 'SELECTED_CHARACTER_MISMATCH');
    }
  }

  const castNames = new Set(candidate.cast.map(member => normalizeText(member.name)));
  const participants = new Map(
    candidate.nodes.map(node => [
      node.id,
      new Set(node.participants.map(normalizeText)),
    ]),
  );
  for (const usage of candidate.selectedCharacterUsage) {
    if (usage.mode !== 'actor') continue;
    const name = normalizeText(usage.name);
    if (
      !castNames.has(name)
      || usage.nodeIds.length === 0
      || !usage.nodeIds.some(nodeId => participants.get(nodeId)?.has(name))
    ) {
      throw new RuinValidationError(
        `Selected actor is not present in cast and linked nodes: ${usage.name}`,
        'SELECTED_ACTOR_MISSING',
      );
    }
  }
}

function validateCanonicalCharacterFidelity(
  candidate: RuinCandidates['candidates'][number],
  selectedCharacters: RuinGenerationInput['selectedCharacters'],
): void {
  for (const character of selectedCharacters) {
    const key = normalizeText(character.name);
    const matchingCast = candidate.cast.filter(member => normalizeText(member.name) === key);
    if (matchingCast.length > 1) {
      throw new RuinValidationError(
        `Canonical character was duplicated in the cast: ${character.name}`,
        'CANONICAL_CHARACTER_DUPLICATED',
      );
    }
    const usage = candidate.selectedCharacterUsage.find(item =>
      normalizeText(item.name) === key
    );
    if (usage?.mode !== 'actor') continue;
    const member = matchingCast[0];
    if (!member || member.kind !== 'person') {
      throw new RuinValidationError(
        `Canonical character is not represented as a person: ${character.name}`,
        'CANONICAL_CHARACTER_KIND_INVALID',
      );
    }
    if (!selectedCharacterIdentityMatches(member.identity, character)) {
      throw new RuinValidationError(
        `Canonical character identity changed: ${character.name}`,
        'CANONICAL_CHARACTER_IDENTITY_CHANGED',
      );
    }
  }
}
