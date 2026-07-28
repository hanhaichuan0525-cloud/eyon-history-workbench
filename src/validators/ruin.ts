import type { RuinContextBundle } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  RuinCandidatesErrorSchema,
  RuinCandidatesSchema,
  type RuinCandidates,
  type RuinGenerationInput,
  type RuinNode,
} from '../schemas/ruin.ts';

export class RuinValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'RUIN_INVALID') {
    super(message);
    this.name = 'RuinValidationError';
    this.code = code;
  }
}

function normalizeText(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

function chineseCharacterCount(source: string): number {
  return source.match(/\p{Script=Han}/gu)?.length ?? 0;
}

function timeTuple(node: RuinNode): number[] {
  const { year, month, day, hour, minute } = node.time;
  return [year, month ?? 0, day ?? 0, hour ?? 0, minute ?? 0];
}

function lowerDateTuple(date: {
  year: number;
  month: number | null;
  day: number | null;
}): number[] {
  return [date.year, date.month ?? 1, date.day ?? 1];
}

function upperDateTuple(date: {
  year: number;
  month: number | null;
  day: number | null;
}): number[] {
  return [date.year, date.month ?? 12, date.day ?? 31];
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
    parsed = parseSingleJsonObject(raw);
  } catch (error) {
    throw new RuinValidationError(
      error instanceof Error ? error.message : 'Ruin response is not valid JSON',
      'JSON_PARSE_FAILED',
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

    const material = expectedMaterials.get(candidate.candidateKey);
    if (!material || material.periodType !== candidate.periodType) {
      throw new RuinValidationError('Ruin candidate material mapping mismatch', 'MATERIAL_MISMATCH');
    }

    const proseLength = chineseCharacterCount(candidate.historyProse);
    if (proseLength < 400 || proseLength > 700) {
      throw new RuinValidationError(
        `Ruin history prose length is outside the tolerated range: ${proseLength}`,
        'PROSE_LENGTH_INVALID',
      );
    }

    validateCandidateTimeline(candidate, expected.input);
    validateSelectedCharacters(candidate, expected.input.selectedCharacters.map(item => item.name));

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
  }

  if (candidateKeys.size !== expectedMaterials.size) {
    throw new RuinValidationError('Not every material set produced one candidate', 'MATERIAL_COUNT_MISMATCH');
  }

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
  for (const sourceRef of allSourceRefs(ruins)) {
    if (!knownSources.has(sourceRef)) {
      throw new RuinValidationError(`Unknown source reference: ${sourceRef}`, 'SOURCE_NOT_FOUND');
    }
  }

  return ruins;
}

function validateCandidateTimeline(
  candidate: RuinCandidates['candidates'][number],
  input: RuinGenerationInput,
): void {
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
    const nodeDate = timeTuple(node).slice(0, 3);
    if (
      compareTuple(nodeDate, spanStart) < 0
      || compareTuple(nodeDate, spanEnd) > 0
    ) {
      throw new RuinValidationError('Ruin node falls outside its candidate span', 'NODE_OUT_OF_SPAN');
    }
  }
  validateNodes(candidate.nodes);
}

function validateNodes(nodes: RuinNode[]): void {
  const ids = new Set<string>();
  let previous: number[] | null = null;
  let enterableAnomalies = 0;

  for (const node of nodes) {
    if (ids.has(node.id)) {
      throw new RuinValidationError('Ruin node IDs must be unique', 'NODE_ID_DUPLICATE');
    }
    ids.add(node.id);

    const current = timeTuple(node);
    if (previous && compareTuple(previous, current) > 0) {
      throw new RuinValidationError('Ruin node times must be monotonic', 'NODE_TIME_REVERSED');
    }
    previous = current;

    if (node.kind === 'anomaly' && node.enterable) {
      enterableAnomalies += 1;
      if (!node.intervention.trim() || node.possibleBranches.length < 2) {
        throw new RuinValidationError('Enterable anomaly lacks intervention branches', 'ANOMALY_INCOMPLETE');
      }
    } else if (node.enterable) {
      throw new RuinValidationError('Only anomaly nodes may be enterable', 'NODE_ENTERABLE_INVALID');
    } else if (node.kind !== 'anomaly' && (node.intervention.trim() || node.possibleBranches.length)) {
      throw new RuinValidationError('Non-anomaly node contains intervention data', 'NODE_BRANCH_INVALID');
    }
  }

  if (enterableAnomalies === 0) {
    throw new RuinValidationError('Ruin candidate has no enterable anomaly', 'ANOMALY_MISSING');
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
