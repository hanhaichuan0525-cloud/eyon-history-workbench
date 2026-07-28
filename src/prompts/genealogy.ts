import type { GenealogyContextBundle } from '../core/context.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';

export interface GenealogyRuleSet {
  sharedContext: string;
  retrievalContract: string;
  validationContract: string;
  generationContract: string;
}

export function buildGenealogyApiPrompt(input: {
  requestId: string;
  directive: string;
  generationInput: GenealogyGenerationInput;
  context: GenealogyContextBundle;
  rules: GenealogyRuleSet;
}): string {
  const request = {
    schema: 'eyon.genealogy.request.v2',
    requestId: input.requestId,
    playerDirective: input.directive,
    focusCharacter: input.generationInput.focusCharacter,
    depth: input.generationInput.depth,
    mvuCharacters: input.context.characterContext,
    worldbookContext: input.context.worldbookContext,
    recentContext: input.context.recentContext,
    biographyRefs: input.context.biographyRefs,
    sourceIndex: input.context.sourceIndex,
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
    '<EYON_GENEALOGY_REQUEST_JSON>',
    JSON.stringify(request),
    '</EYON_GENEALOGY_REQUEST_JSON>',
  ].join('\n\n');
}
