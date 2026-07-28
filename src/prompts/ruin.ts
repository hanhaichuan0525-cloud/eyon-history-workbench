import type { RuinContextBundle } from '../core/context.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';

export interface RuinRuleSet {
  sharedContext: string;
  retrievalContract: string;
  validationContract: string;
  generationContract: string;
}

export function buildRuinApiPrompt(input: {
  requestId: string;
  directive: string;
  generationInput: RuinGenerationInput;
  context: RuinContextBundle;
  rules: RuinRuleSet;
}): string {
  const request = {
    schema: 'eyon.ruin.request.v2',
    requestId: input.requestId,
    playerDirective: input.directive,
    ...input.generationInput,
    context: input.context,
  };

  return [
    '<shared_context>',
    input.rules.sharedContext.trim(),
    '</shared_context>',
    '<retrieval_contract>',
    input.rules.retrievalContract.trim(),
    '</retrieval_contract>',
    '<validation_contract>',
    input.rules.validationContract.trim(),
    '</validation_contract>',
    '<generation_contract>',
    input.rules.generationContract.trim(),
    '</generation_contract>',
    '<EYON_REQUEST_JSON>',
    JSON.stringify(request),
    '</EYON_REQUEST_JSON>',
  ].join('\n\n');
}
