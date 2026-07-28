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
    `[波及范围|${effect.roll}|${effect.scope.trim()}]`,
    `[现世落点|${effect.presentLanding.trim()}]`,
    `[可感知证据|${effect.perceptibleEvidence.map(value => value.trim()).join('；')}]`,
    `[墟境行动记录|${effect.ruinActionRecord.trim()}]`,
    `[历史演变|${effect.historicalEvolution.trim()}]`,
    `[历史关键词|${effect.historicalKeywords.map(value => value.trim()).join('、')}]`,
    '</butterfly_panel>',
  ].join('\n');
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

export function butterflyArchiveKeywords(input: {
  anchors: ButterflyArchiveAnchors;
  historicalKeywords: string[];
}): string[] {
  const values = new Set<string>();
  for (const time of [input.anchors.ruinEntry.time, input.anchors.ruinExit.time]) {
    const match = time.match(/(\d{1,6})年(?:\D+?(\d{1,2})月)?/u);
    if (!match) continue;
    values.add(`${match[1]}年`);
    if (match[2]) values.add(`${match[1]}年${match[2]}月`);
  }
  for (const location of [
    input.anchors.ruinEntry.location,
    input.anchors.ruinExit.location,
  ]) {
    location.split(/[-—]/u).map(value => value.trim()).filter(value =>
      value.length >= 2 && value.length <= 24
    ).forEach(value => values.add(value));
  }
  input.historicalKeywords.forEach(value => values.add(value.trim()));
  return [...values].filter(Boolean).slice(0, 20);
}
