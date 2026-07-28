export interface ButterflyEffect {
  roll: number;
  scope: string;
  presentLanding: string;
  perceptibleEvidence: string[];
  ruinActionRecord: string;
  historicalEvolution: string;
  historicalKeywords: string[];
}

export function serializeButterflyPanel(effect: ButterflyEffect): string {
  return [
    '<butterfly_panel>',
    `[波及范围|${effect.roll}|${effect.scope.trim()}]`,
    `[现世落点|${effect.presentLanding.trim()}]`,
    `[可感知证据|${effect.perceptibleEvidence.map(value => value.trim()).join('；')}]`,
    `[墟境行动记录|${effect.ruinActionRecord.trim()}]`,
    `[历史演变|${effect.historicalEvolution.trim()}]`,
    `[历史关键词|${effect.historicalKeywords.map(value => value.trim()).join('、')}]`,
    '</butterfly_panel>',
  ].join('\n');
}
