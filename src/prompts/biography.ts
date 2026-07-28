import type { BiographyContextBundle } from '../core/context.ts';
import type { Biography } from '../schemas/biography.ts';

export interface BiographyRuleSet {
  sharedContext: string;
  retrievalContract: string;
  validationContract: string;
  generationContract: string;
}

export function buildBiographyApiPrompt(input: {
  requestId: string;
  directive: string;
  context: BiographyContextBundle;
  rules: BiographyRuleSet;
}): string {
  const request = {
    schema: 'eyon.biography.request.v1',
    requestId: input.requestId,
    playerDirective: input.directive,
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
    '<request_data>',
    JSON.stringify(request),
    '</request_data>',
  ].join('\n\n');
}

export function buildBiographyShellInstruction(
  biography: Biography,
  slot: string,
): string {
  return [
    '【伊雍寻根溯源协作请求】',
    `玩家已经要求对“${biography.target.name}”进行寻根溯源。`,
    `玩家原始指令：${biography.playerDirective.raw}`,
    `主要方向：${biography.playerDirective.primaryDirection}`,
    `时间跨度：${biography.span.label}`,
    '',
    '传记史稿已经由圣卷后台完成。',
    '请只依据当前世界书中的伊雍核心、人设、语气、mood与固定格式，生成伊雍对此次传记的简短开场。',
    '伊雍正文必须使用世界书规定的 `<eyon name="伊雍" mood="...">「对白」</eyon>` 与 `<eyon_court/>` 格式。',
    '禁止自行生成、复述、概括、改写或评论传记正文。',
    '伊雍开场结束后，必须单独原样输出以下占位槽，并立即结束：',
    slot,
  ].join('\n');
}
