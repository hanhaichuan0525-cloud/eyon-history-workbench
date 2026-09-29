export interface ButterflyEffect {
  roll: number;
  scope: string;
  presentLanding: string;
  perceptibleEvidence: string[];
  ruinActionRecord: string;
  historicalEvolution: string;
  historicalKeywords: string[];
}

export interface ButterflyArchiveAnchors {
  reality: { time: string; location: string };
  ruinEntry: { time: string; location: string };
  ruinExit: { time: string; location: string };
}

export function serializeButterflyPanel(effect: ButterflyEffect): string {
  return [
    '<butterfly_panel>',
    `[波及范围|${effect.roll}|${panelUserName(effect.scope)}]`,
    `[现世落点|${panelUserName(effect.presentLanding)}]`,
    `[可感知证据|${effect.perceptibleEvidence.map(panelUserName).join('；')}]`,
    `[墟境行动记录|${panelUserName(effect.ruinActionRecord)}]`,
    `[历史演变|${panelUserName(effect.historicalEvolution)}]`,
    `[历史关键词|${effect.historicalKeywords.map(panelUserName).join('、')}]`,
    '</butterfly_panel>',
  ].join('\n');
}

/** 只改可见面板文本；归档与 Canon 仍保留模型原始自然语言。 */
function panelUserName(value: string): string {
  return value.trim().replace(/玩家/gu, '<user>');
}

export function serializeButterflyArchive(input: {
  title: string;
  anchors: ButterflyArchiveAnchors;
  effect: ButterflyEffect;
}): string {
  const { anchors, effect } = input;
  return [
    `### ${input.title}`,
    '',
    '| 现实锚点 | 内容 |',
    '|:---|:---|',
    `| 进入墟境时间 | ${anchors.reality.time} |`,
    `| 进入墟境地点 | ${anchors.reality.location} |`,
    '',
    '| 墟境跨度 | 内容 |',
    '|:---|:---|',
    `| 进入时墟境时间 | ${anchors.ruinEntry.time} |`,
    `| 进入时墟境地点 | ${anchors.ruinEntry.location} |`,
    `| 离开时墟境时间 | ${anchors.ruinExit.time} |`,
    `| 离开时墟境地点 | ${anchors.ruinExit.location} |`,
    '',
    '| 蝴蝶效应面板 | 内容 |',
    '|:---|:---|',
    `| 波及范围 | ${effect.roll} / ${effect.scope} |`,
    `| 现世落点 | ${effect.presentLanding} |`,
    `| 可感知证据 | ${effect.perceptibleEvidence.join('；')} |`,
    `| 墟境行动记录 | ${effect.ruinActionRecord} |`,
    `| 历史演变 | ${effect.historicalEvolution} |`,
    `| 历史关键词 | ${effect.historicalKeywords.join('、')} |`,
  ].join('\n');
}
