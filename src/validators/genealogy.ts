import type { GenealogyContextBundle } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  GenealogyErrorSchema,
  GenealogyResultSchema,
  type GenealogyGenerationInput,
  type GenealogyResult,
} from '../schemas/genealogy.ts';

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
  },
): GenealogyResult {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw);
  } catch (error) {
    throw new GenealogyValidationError(
      error instanceof Error ? error.message : 'Genealogy response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }

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
    if (node.canInjectToRuin !== node.isMvuCharacter) {
      throw new GenealogyValidationError(
        'Only MVU genealogy nodes may be injected into ruin generation',
        'INJECTION_PERMISSION_INVALID',
      );
    }
    if (!node.isMvuCharacter && node.mvuId) {
      throw new GenealogyValidationError('Non-MVU genealogy node contains an MVU ID', 'MVU_ID_INVALID');
    }
    if (node.provenance === 'explicit' && node.sourceRefs.length === 0) {
      throw new GenealogyValidationError('Explicit genealogy node lacks sources', 'SOURCE_REQUIRED');
    }
    validateLifeDates(node);
  }

  const edgeIds = new Set<string>();
  for (const edge of genealogy.edges) {
    if (edgeIds.has(edge.id)) {
      throw new GenealogyValidationError('Genealogy edge IDs must be unique', 'EDGE_ID_DUPLICATE');
    }
    edgeIds.add(edge.id);
    if (edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new GenealogyValidationError('Genealogy edge references invalid nodes', 'EDGE_INVALID');
    }
  }
  ensureConnected(focusNodes[0].id, nodeIds, genealogy.edges);

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
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
    || !checks.onlyMvuNodesCanInjectToRuin
    || !checks.noConflictNarrative
  ) {
    throw new GenealogyValidationError('Genealogy quality checks report a defect', 'QUALITY_CHECK_FAILED');
  }
  return genealogy;
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
