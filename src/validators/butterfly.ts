import { parseSingleJsonObject } from '../core/json.ts';
import {
  ButterflyErrorSchema,
  ButterflyResultSchema,
  type ButterflyRequest,
  type ButterflyResult,
} from '../schemas/butterfly.ts';

export class ButterflyValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = 'BUTTERFLY_INVALID') {
    super(message);
    this.name = 'ButterflyValidationError';
    this.code = code;
  }
}
export function parseAndValidateButterfly(
  raw: string,
  request: ButterflyRequest,
): ButterflyResult {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw);
  } catch (error) {
    throw new ButterflyValidationError(
      error instanceof Error ? error.message : 'Butterfly response is not valid JSON',
      'JSON_PARSE_FAILED',
    );
  }
  const apiError = ButterflyErrorSchema.safeParse(parsed);
  if (apiError.success) {
    if (apiError.data.requestId && apiError.data.requestId !== request.requestId) {
      throw new ButterflyValidationError('Butterfly error requestId mismatch', 'REQUEST_MISMATCH');
    }
    throw new ButterflyValidationError(apiError.data.error.message, apiError.data.error.code);
  }
  const parsedResult = ButterflyResultSchema.safeParse(parsed);
  if (!parsedResult.success) {
    throw new ButterflyValidationError(parsedResult.error.message, 'SCHEMA_INVALID');
  }
  const result = parsedResult.data;
  if (result.requestId !== request.requestId || result.runId !== request.runId) {
    throw new ButterflyValidationError('Butterfly request or run identity mismatch', 'REQUEST_MISMATCH');
  }
  if (
    result.effect.roll !== request.dice.roll
    || result.effect.scope !== request.dice.scope
  ) {
    throw new ButterflyValidationError('Butterfly dice scope was changed', 'DICE_MISMATCH');
  }
  if (textLength(result.effect.ruinActionRecord) < 80
    || textLength(result.effect.ruinActionRecord) > 180) {
    throw new ButterflyValidationError('Ruin action record length is invalid', 'ACTION_LENGTH_INVALID');
  }
  if (textLength(result.effect.historicalEvolution) < 160
    || textLength(result.effect.historicalEvolution) > 360) {
    throw new ButterflyValidationError('Historical evolution length is invalid', 'EVOLUTION_LENGTH_INVALID');
  }
  const keywords = result.effect.historicalKeywords.map(normalize);
  if (new Set(keywords).size !== keywords.length) {
    throw new ButterflyValidationError('Historical keywords must be unique', 'KEYWORDS_DUPLICATE');
  }
  result.causalStages.forEach((stage, index) => {
    if (stage.order !== index + 1) {
      throw new ButterflyValidationError('Causal stage order must be continuous', 'STAGE_ORDER_INVALID');
    }
  });
  const knownSources = new Set(request.sourceIndex.map(source => source.sourceId));
  const references = [
    ...result.sourceIds,
    ...result.causalStages.flatMap(stage => stage.sourceIds),
    ...result.inferences.flatMap(inference => inference.basisSourceIds),
  ];
  for (const sourceId of references) {
    if (!knownSources.has(sourceId)) {
      throw new ButterflyValidationError(`Unknown source reference: ${sourceId}`, 'SOURCE_NOT_FOUND');
    }
  }
  if (!result.sourceIds.some(sourceId => sourceId.startsWith('chat:'))) {
    throw new ButterflyValidationError('Butterfly result does not cite this run chat evidence', 'PLAYER_ACTION_UNSOURCED');
  }
  if (containsForbiddenMarkup(JSON.stringify(result))) {
    throw new ButterflyValidationError('Butterfly result contains forbidden rendering or variable syntax', 'FORBIDDEN_OUTPUT');
  }
  if (Object.values(result.qualityChecks).some(value => value !== true)) {
    throw new ButterflyValidationError('Butterfly quality checks report a defect', 'QUALITY_CHECK_FAILED');
  }
  return result;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function textLength(value: string): number {
  return [...value.replace(/\s+/gu, '')].length;
}

function containsForbiddenMarkup(value: string): boolean {
  return /<butterfly_panel>|<UpdateVariable>|JSONPatch|"op"\s*:\s*"(?:replace|insert|remove)"|\/墟境系统|\/世界\//iu.test(value);
}
