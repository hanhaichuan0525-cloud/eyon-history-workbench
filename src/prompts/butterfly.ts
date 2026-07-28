import type { ButterflyRequest } from '../schemas/butterfly.ts';

export interface ButterflyRuleSet {
  sharedContext: string;
  retrievalContract: string;
  validationContract: string;
  generationContract: string;
}
export function buildButterflyApiPrompt(input: {
  request: ButterflyRequest;
  rules: ButterflyRuleSet;
}): string {
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
    '<EYON_BUTTERFLY_REQUEST_JSON>',
    JSON.stringify(input.request),
    '</EYON_BUTTERFLY_REQUEST_JSON>',
  ].join('\n\n');
}
