import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const beautyRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve('regex');

const cases = [
  {
    file: 'regex-伊雍-传记美化（as）.json',
    sample: [
      '[RootTrace]',
      'Title:: 《测试传记》',
      'Subtitle:: 副标题',
      'Span:: 复兴纪元100—200年',
      'OriginTitle:: 起源(复兴纪元100年)',
      'Origin:: 起源正文',
      'Periods:: <details class="eybi-stage"><summary class="eybi-stage-title">稳定期(100—120年)</summary><div class="eybi-stage-body"><div class="eybi-v eybi-pre eybi-entries">时期正文</div></div></details>',
      'StatusTitle:: 现状(复兴纪元200年)',
      'Status:: 现状正文',
      'Summary:: 总结',
      '[/RootTrace]',
    ].join('\n'),
  },
  {
    file: 'regex-伊雍-墟境输出面板美化（as）.json',
    sample: [
      '[RuinTrace]',
      'Title:: 旧影的回音',
      'Type:: 过渡期',
      'Span:: 复兴纪元145年5月—180年冬',
      'History:: 一段经过校验的历史史稿。',
      'Shift:: 稳定期 → 过渡期',
      'NodeTime:: 复兴纪元145年5月20日 23:15',
      '[/RuinTrace]',
    ].join('\n'),
  },
  {
    file: 'regex-伊雍-蝴蝶效应面板美化（as）.json',
    sample: [
      '<butterfly_panel>',
      '[波及范围|42|聚落]',
      '[现世落点|南侧荒原出现锈水镇。]',
      '[可感知证据|麦田消失；税册改写]',
      '[墟境行动记录|玩家截留水文残卷。]',
      '[历史演变|残卷失踪改变了后续水网规划。]',
      '[历史关键词|水文残卷、锈水镇]',
      '</butterfly_panel>',
    ].join('\n'),
  },
  {
    file: 'regex-伊雍-对话框美化（as）.json',
    sample: [
      '<eyon name="伊雍" mood="curious">',
      '「主人，我已经把这段历史整理好了。」',
      '</eyon>',
      '<eyon_court/>',
    ].join('\n'),
  },
];

function parseRegexLiteral(source) {
  if (!source.startsWith('/')) {
    return new RegExp(source);
  }

  const separator = source.lastIndexOf('/');
  if (separator <= 0) {
    throw new Error('Invalid regex literal');
  }

  return new RegExp(source.slice(1, separator), source.slice(separator + 1));
}

for (const entry of cases) {
  const filePath = path.join(beautyRoot, entry.file);
  const source = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '');
  const config = JSON.parse(source);
  const regex = parseRegexLiteral(config.findRegex);

  if (!regex.test(entry.sample)) {
    throw new Error(`${entry.file} does not match the repository contract sample`);
  }
  console.log(`MATCH ${entry.file}`);
}
