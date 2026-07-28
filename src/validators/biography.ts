import type { BiographyContextBundle } from '../core/context.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import { BiographyErrorSchema, BiographySchema, type Biography } from '../schemas/biography.ts';
import { validateRootTrace } from '../renderers/rootTrace.ts';

export class BiographyValidationError extends Error {
  readonly code: string;

  constructor(
    message: string,
    code = 'BIOGRAPHY_INVALID',
  ) {
    super(message);
    this.name = 'BiographyValidationError';
    this.code = code;
  }
}

function countToken(source: string, token: string): number {
  return source.split(token).length - 1;
}

function normalizeText(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

function collectSourceRefs(biography: Biography): string[] {
  return [
    ...biography.target.sourceRefs,
    ...biography.origin.sourceRefs,
    ...biography.status.sourceRefs,
    ...biography.stages.flatMap(stage => stage.sourceRefs),
  ];
}

function validateRootTraceConsistency(biography: Biography): void {
  const rootTrace = validateRootTrace(biography.rootTrace);
  const detailsCount = countToken(rootTrace, '<details');

  if (detailsCount !== biography.stages.length) {
    throw new BiographyValidationError('RootTrace stage count does not match structured stages');
  }
  if (countToken(rootTrace, '[RootTrace]') !== 1 || countToken(rootTrace, '[/RootTrace]') !== 1) {
    throw new BiographyValidationError('RootTrace markers must be unique');
  }

  const traceText = normalizeText(rootTrace);
  const requiredContent = [
    biography.target.name,
    biography.span.label,
    biography.origin.title,
    biography.origin.content,
    biography.status.title,
    biography.status.content,
    biography.summary,
    ...biography.stages.flatMap(stage => [stage.title, stage.content]),
  ];

  for (const content of requiredContent) {
    if (!traceText.includes(normalizeText(content))) {
      throw new BiographyValidationError('RootTrace does not match structured biography content');
    }
  }
}

export function parseAndValidateBiography(
  raw: string,
  expected: {
    requestId: string;
    directive: string;
    context: BiographyContextBundle;
  },
): Biography {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw);
  } catch (error) {
    throw new BiographyValidationError(
      error instanceof Error ? error.message : 'Biography response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }

  const apiError = BiographyErrorSchema.safeParse(parsed);
  if (apiError.success) {
    if (apiError.data.requestId !== expected.requestId) {
      throw new BiographyValidationError('Biography error response requestId mismatch', 'REQUEST_MISMATCH');
    }
    throw new BiographyValidationError(apiError.data.error.message, apiError.data.error.code);
  }

  const result = BiographySchema.safeParse(parsed);
  if (!result.success) {
    throw new BiographyValidationError(result.error.message, 'SCHEMA_INVALID');
  }

  const biography = result.data;
  if (biography.requestId !== expected.requestId) {
    throw new BiographyValidationError('Biography requestId mismatch', 'REQUEST_MISMATCH');
  }
  if (normalizeText(biography.playerDirective.raw) !== normalizeText(expected.directive)) {
    throw new BiographyValidationError('Biography player directive mismatch', 'DIRECTIVE_MISMATCH');
  }

  const knownSources = new Set(expected.context.sourceIndex.map(source => source.sourceId));
  for (const sourceRef of collectSourceRefs(biography)) {
    if (!knownSources.has(sourceRef)) {
      throw new BiographyValidationError(`Unknown source reference: ${sourceRef}`, 'SOURCE_NOT_FOUND');
    }
  }

  const targetCandidates = [biography.target.name, ...biography.target.aliases]
    .map(normalizeText)
    .filter(Boolean);
  const directive = normalizeText(expected.directive);
  const interpretedTarget = normalizeText(biography.playerDirective.interpretedTarget);
  if (!targetCandidates.some(target => directive.includes(target) || interpretedTarget.includes(target))) {
    throw new BiographyValidationError('Biography target does not match player directive', 'TARGET_MISMATCH');
  }

  const stageIds = new Set(biography.stages.map(stage => stage.id));
  if (stageIds.size !== biography.stages.length) {
    throw new BiographyValidationError('Biography stage IDs must be unique', 'STAGE_ID_DUPLICATE');
  }

  validateRootTraceConsistency(biography);
  return biography;
}
