import { parseSingleJsonObject } from '../core/json.ts';
import {
  ButterflyErrorSchema,
  ButterflyResultSchema,
  type ButterflyRequest,
  type ButterflyResult,
} from '../schemas/butterfly.ts';
import type { ActiveEvidenceView } from '../prompts/activeEvidence.ts';
import {
  butterflyEvolutionLengthContract,
  BUTTERFLY_ACTION_RECORD_LENGTH_CONTRACT,
} from '../core/butterflyProseContract.ts';
import {
  canonicalTaskSourceId,
  resolveTaskCitationValues,
} from '../retrieval/citations.ts';

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
  activeEvidence?: ActiveEvidenceView,
): ButterflyResult {
  let parsed: unknown;
  try {
    parsed = parseSingleJsonObject(raw, {
      schema: 'eyon.butterfly.v1',
      discriminators: { requestId: request.requestId },
    });
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
  const directEffectCount = result.directEffects?.length ?? 0;
  result.directEffects = (result.directEffects ?? [])
    .map(effect => ({
      subject: effect.subject.trim(),
      time: effect.time.trim(),
      stateHint: effect.stateHint.trim(),
      change: effect.change.trim(),
    }))
    // 直接对象与变化句是唯一必要字段；时间和状态提示缺失时仍可安全降级。
    .filter(effect => effect.subject.length > 0 && effect.change.length > 0);
  if (result.directEffects.length !== directEffectCount
    || (Object.prototype.hasOwnProperty.call(parsed as object, 'directEffects')
      && !Array.isArray((parsed as { directEffects?: unknown }).directEffects))) {
    console.info(
      '[Eyon History Workbench] ignored malformed butterfly directEffects; causal result remains valid',
    );
  }
  const knownSourceIds = unique(
    request.sourceIndex.map(source => canonicalTaskSourceId(source.sourceId)),
  );
  const ignoredSourceRefs = new Set<string>();
  const resolveSourceRefs = (refs: string[]): string[] => {
    const resolved = resolveButterflySourceRefs(
      activeEvidence?.citationRegistry,
      refs,
      knownSourceIds,
    );
    for (const ref of resolved.unknownRefs) ignoredSourceRefs.add(ref);
    return resolved.targetIds;
  };
  const runChatSourceIds = request.playerInterventions
    .map(source => canonicalTaskSourceId(source.sourceId))
    .filter(sourceId => sourceId.startsWith('chat:') && knownSourceIds.includes(sourceId));
  // 玩家行动是冻结请求本身的一部分，不再要求模型重复抄对 chat 句柄才承认它。
  // 这样保留了行动溯源硬保证，同时避免纯引用元数据瑕疵截断整次遣返。
  result.sourceIds = unique([...resolveSourceRefs(result.sourceIds), ...runChatSourceIds]);
  for (const stage of result.causalStages) {
    stage.sourceIds = resolveSourceRefs(stage.sourceIds);
  }
  for (const inference of result.inferences) {
    inference.basisSourceIds = resolveSourceRefs(inference.basisSourceIds);
  }
  if (ignoredSourceRefs.size > 0) {
    console.info(
      '[Eyon History Workbench] ignored unknown butterfly source references:',
      [...ignoredSourceRefs],
    );
  }
  if (result.requestId !== request.requestId || result.runId !== request.runId) {
    throw new ButterflyValidationError('Butterfly request or run identity mismatch', 'REQUEST_MISMATCH');
  }
  if (
    result.effect.roll !== request.dice.roll
    || result.effect.scope !== request.dice.scope
  ) {
    throw new ButterflyValidationError('Butterfly dice scope was changed', 'DICE_MISMATCH');
  }
  const actionRecordLength = textLength(result.effect.ruinActionRecord);
  const {
    targetMin: actionTargetMin,
    targetMax: actionTargetMax,
    acceptedMin: actionAcceptedMin,
    acceptedMax: actionAcceptedMax,
  } = BUTTERFLY_ACTION_RECORD_LENGTH_CONTRACT;
  if (actionRecordLength < actionAcceptedMin
    || actionRecordLength > actionAcceptedMax) {
    throw new ButterflyValidationError(
      `Ruin action record length ${actionRecordLength} is outside the accepted ${actionAcceptedMin}-${actionAcceptedMax} range (target ${actionTargetMin}-${actionTargetMax})`,
      'ACTION_LENGTH_INVALID',
    );
  }
  const evolutionLength = textLength(result.effect.historicalEvolution);
  const evolutionContract = butterflyEvolutionLengthContract(request.dice.scope);
  if (
    evolutionLength < evolutionContract.acceptedMin
    || evolutionLength > evolutionContract.acceptedMax
  ) {
    throw new ButterflyValidationError(
      `Historical evolution length ${evolutionLength} is outside the accepted ${evolutionContract.acceptedMin}-${evolutionContract.acceptedMax} range for ${request.dice.scope}`,
      'EVOLUTION_LENGTH_INVALID',
    );
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
  if (containsForbiddenMarkup(JSON.stringify(result))) {
    throw new ButterflyValidationError('Butterfly result contains forbidden rendering or variable syntax', 'FORBIDDEN_OUTPUT');
  }
  if (Object.values(result.qualityChecks).some(value => value !== true)) {
    throw new ButterflyValidationError('Butterfly quality checks report a defect', 'QUALITY_CHECK_FAILED');
  }
  return result;
}

function resolveButterflySourceRefs(
  registry: ActiveEvidenceView['citationRegistry'] | undefined,
  refs: string[],
  knownSourceIds: string[],
): { targetIds: string[]; unknownRefs: string[] } {
  const known = new Set(knownSourceIds.map(canonicalTaskSourceId));
  if (registry) {
    const resolved = resolveTaskCitationValues(registry, 'source', refs, knownSourceIds);
    const targetIds = unique(
      resolved.targetIds.map(canonicalTaskSourceId).filter(sourceId => known.has(sourceId)),
    );
    const rejectedTargets = resolved.targetIds
      .map(canonicalTaskSourceId)
      .filter(sourceId => !known.has(sourceId));
    return {
      targetIds,
      unknownRefs: unique([...resolved.unknownRefs, ...rejectedTargets]),
    };
  }
  const uniqueRefs = unique(refs);
  return {
    targetIds: unique(
      uniqueRefs.map(canonicalTaskSourceId).filter(ref => known.has(ref)),
    ),
    unknownRefs: uniqueRefs.filter(ref => !known.has(canonicalTaskSourceId(ref))),
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
