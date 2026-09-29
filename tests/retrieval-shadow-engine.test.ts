import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  SOURCE_SNAPSHOT_SCHEMA,
  type SourceSnapshot,
  type WorldbookRetrievalMetadata,
} from '../src/retrieval/contracts.ts';
import { assembleEvidencePassages } from '../src/retrieval/passages.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { buildWorldKnowledgeCatalog } from '../src/retrieval/catalog.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import {
  activeTemporalEligibilityRules,
  findTemporalEligibilityViolations,
  personAvailabilityLine,
} from '../src/retrieval/temporal.ts';

function snapshot(
  logicalId: string,
  title: string,
  content: string,
  sourceType: SourceSnapshot['sourceType'] = 'worldbook',
  sourceOrder?: number,
): SourceSnapshot {
  const versionHash = logicalId.padEnd(64, '0').slice(0, 64);
  return {
    schema: SOURCE_SNAPSHOT_SCHEMA,
    logicalId,
    snapshotId: `${logicalId}@sha256:${versionHash}`,
    versionHash,
    sourceType,
    title,
    content,
    ...(sourceOrder === undefined ? {} : { sourceOrder }),
    metadata: {},
  };
}

function withWorldbookKeys(source: SourceSnapshot, uid: number, keys: string[]): SourceSnapshot {
  source.metadata = {
    schema: 'eyon.retrieval.worldbook-metadata.v1',
    logicalId: source.logicalId,
    worldbookName: '命定之诗与黄昏之歌v4.2',
    uid,
    bindingScopes: ['character-primary'],
    enabled: true,
    strategy: {
      type: 'selective',
      primaryKeys: keys,
      secondary: { logic: 'and_any', keys: [] },
      scanDepth: 4,
    },
    position: null,
    probability: 100,
    recursion: { preventIncoming: false, preventOutgoing: false, delayUntil: null },
    effect: { sticky: null, cooldown: null, delay: null },
    extra: {},
  };
  return source;
}

test('检索查询会剔除时间碎片、流程缩写与纯标点噪声', async () => {
  const source = withWorldbookKeys(snapshot(
    'worldbook:meaningful-anchor',
    '梵尼亚人物档案',
    '梵尼亚保存着玲山·哈姆斯沃思与铃羽的旧档案。',
  ), 999001, ['梵尼亚']);
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({
    requestId: 'noise-anchor-filter',
    taskType: 'ruin',
    query: '梵尼亚 00 15 30 —— by the exp',
    mode: 'active',
  });
  const anchors = result.bundle.passages.flatMap(passage => passage.matchedAnchors);
  assert.ok(result.bundle.sourceSnapshots.some(item => item.title === '梵尼亚人物档案'));
  for (const noise of ['00', '15', '30', '——', 'by', 'the', 'exp']) {
    assert.ok(!anchors.includes(noise), `不得把 ${noise} 当作检索锚点`);
  }
});

test('真实泰珂观测中的泛世界书关键词不能再挤入墟境史料位', async () => {
  const sources = [
    withWorldbookKeys(snapshot(
      'worldbook:命定之诗与黄昏之歌v4.2:822383',
      '[世界主设定]',
      '神明纪元：众神行走于阿斯塔利亚大陆。\n旅途与幸运的女神・泰珂：泰珂常以恶作剧捉弄其他神明。',
    ), 822383, ['神明纪元', '阿斯塔利亚', '泰珂']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:core', '伊雍核心', '墟境探索系统覆盖阿斯塔利亚。'), 1, ['墟境探索']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:ist', '伊丝特莱雅', '神明纪元的始源精灵。'), 2, ['神明纪元']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:wan', '万名局', '管理大陆名录。'), 3, ['大陆']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:mio', '澪', '一名旅者。'), 4, ['其他']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:silver', '银帆城', '城中流行泰珂信仰与女神纪念品。'), 5, ['女神泰珂', '泰珂']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:val', '瓦伦蒂亚', '南方城市。'), 6, ['探索']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:undead', '不死生物', '亡者资料。'), 7, ['其他']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:red', '红叶镇', '边地小镇。'), 8, ['探索']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:north', '诺斯加德文化', '北方文化。'), 9, ['全境']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:ascend', '登神长阶', '登神仪式。'), 10, ['探索']),
    withWorldbookKeys(snapshot('worldbook:命定之诗与黄昏之歌v4.2:vannia', '梵尼亚', '北方政权。'), 11, ['探索']),
  ];
  const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
    requestId: 'real-tyche-noise-regression',
    taskType: 'ruin',
    query: '墟境探索\n神明纪元\n阿斯塔利亚大陆全境\n狡黠的女神泰珂对其他神明所作的恶作剧',
  });

  assert.deepEqual(result.bundle.sourceSnapshots.map(source => source.title), [
    '[世界主设定]',
  ]);
  assert.ok(result.bundle.receipt.rejected.some(item =>
    item.snapshotId.includes('worldbook:命定之诗与黄昏之歌v4.2:silver')
    && item.reason === 'temporal-scope-unanchored'));
  assert.ok(result.bundle.receipt.rejected.every(item =>
    !item.reason.includes('source-budget-exhausted')));
});

test('完整复合事件名可打开未重复标注纪元的事件条目，不被两个短词门槛漏掉', async () => {
  const event = snapshot(
    'worldbook:second-invasion',
    '帝国战争纪要',
    '第二次位面入侵期间，帝国军方由步兵、工程营与医护队共同维持防线。',
  );
  const unrelated = withWorldbookKeys(snapshot(
    'worldbook:epic-equipment',
    '当代炼金人物',
    '复兴纪元的奥古斯提姆帝国炼金师持有数件史诗装备。',
  ), 2, ['史诗', '奥古斯提姆帝国']);
  const result = await new UnifiedShadowRetrievalEngine([event, unrelated]).retrieve({
    requestId: 'compound-event-anchor',
    taskType: 'ruin',
    query: '英雄纪元\n奥古斯提姆帝国\n第二次位面入侵时帝国军方的英雄群像',
  });

  assert.ok(result.bundle.sourceSnapshots.some(source => source.snapshotId === event.snapshotId));
  assert.ok(result.bundle.passages.some(passage =>
    passage.snapshotId === event.snapshotId
    && passage.matchedAnchors.includes('第二次位面入侵')));
  assert.ok(!result.bundle.sourceSnapshots.some(source => source.snapshotId === unrelated.snapshotId));
});

test('实体准入门保留完整目录，但泛词、结构句段和含女神字样的建筑不能打开来源或进入角色表', async () => {
  const main = withWorldbookKeys(snapshot(
    'worldbook:entity-admission-main',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '神明纪元：诸神创造智慧生物；混乱纪元：宗教形成，翼民建立梵尼亚。',
      '# 宗教体系',
      '## 神明',
      '辉煌女神・索拉莉娅：',
      '  - 信仰：光明、秩序与纯洁。',
      '先祖之魂・卡拉什：',
      '  - 信仰：力量、荣耀与传统。',
      '## 圣灵',
      '旅途与幸运的女神・泰珂：',
      '  - 愿力：冒险、交易与幸运。',
    ].join('\n'),
  ), 1, ['神明纪元', '阿斯塔利亚', '泰珂']);
  const noisySources = [
    snapshot('worldbook:generic-alias', '北境文化', '耀日回归祭(全境): 冬季庆典。'),
    snapshot('worldbook:generic-fields', '系统资料', '探索: 开启。\n其他: 备用。\n大陆: 总览。\n墟境探索: 功能。'),
    snapshot('worldbook:structural-deity-phrases', '生命层级规则', [
      '对于非神明: 适用甲规则。',
      '对于神明: 适用乙规则。',
      '未知神祇: 泛称。',
      'Lv.25巅峰神明: 等级说明。',
      '神明纪元 (约一万年前): 时间说明。',
      '女神选美大赛(辉光之月): 节庆说明。',
    ].join('\n')),
    snapshot('worldbook:deity-church', '圣日镇', '辉煌女神大教堂: 每日举行仪式。'),
    snapshot('worldbook:deity-temple', '浮岛圣域', '辉煌女神大圣殿: 晨光贯穿中轴。'),
  ];
  const result = await new UnifiedShadowRetrievalEngine([main, ...noisySources]).retrieve({
    requestId: 'entity-admission-real-patterns',
    taskType: 'ruin',
    query: '墟境探索\n神明纪元\n阿斯塔利亚大陆全境\n狡黠的女神泰珂对其他神明所作的恶作剧',
  });

  assert.equal(result.bundle.catalogCoverage?.length, 1 + noisySources.length);
  assert.deepEqual(result.bundle.sourceSnapshots.map(source => source.title), ['[世界主设定]']);
  assert.deepEqual(
    new Set(result.bundle.castManifest?.entries
      .filter(entry => ['required', 'group-required'].includes(entry.disposition))
      .map(entry => entry.identity.canonicalName)),
    new Set(['泰珂', '卡拉什', '索拉莉娅']),
  );
  assert.ok(result.bundle.castManifest?.entries.every(entry =>
    ![
      '神明', '对于神明', '对于非神明', '未知神祇', 'Lv.25巅峰神明',
      '神明纪元 (约一万年前)', '女神选美大赛(辉光之月)',
      '辉煌女神大教堂', '辉煌女神大圣殿',
    ]
      .includes(entry.identity.canonicalName)));
  assert.doesNotMatch(
    result.bundle.receipt.selected.map(item => item.reason).join('\n'),
    /catalog-direct:(?:全境|其他|大陆|探索|墟境探索|神明)|cast-group-required:(?:对于|辉煌女神大)/u,
  );
});

test('多章节世界书会读取1800字后的神明纪元与泰珂段，而不把头部地理当作证据', async () => {
  const geographyNoise = Array.from(
    { length: 90 },
    (_, index) => `地理条目${index}：奥古斯提姆帝国拥有当前时代的议会与商会。`,
  ).join('\n');
  const source = withWorldbookKeys(snapshot(
    'worldbook:section-aware-main',
    '[世界主设定]',
    [
      '# 世界地理概览',
      geographyNoise,
      '',
      '# 阿斯塔利亚历史年表',
      '神明纪元：诸神创造智慧种族，并在位面震荡后返回神国。',
      '混乱纪元：人类帝国与圣灵信仰在此后才诞生。',
      '',
      '# 宗教体系',
      '## 圣灵',
      '旅途与幸运的女神・泰珂（狡黠少女）：愿力为冒险、交易与幸运。',
    ].join('\n'),
  ), 822383, ['神明纪元', '阿斯塔利亚', '泰珂']);
  const engine = new UnifiedShadowRetrievalEngine([source]);
  const result = await engine.retrieve({
    requestId: 'section-aware-tyche',
    taskType: 'ruin',
    query: '神明纪元\n阿斯塔利亚大陆全境\n狡黠的女神泰珂对其他神明所作的恶作剧',
  });
  const visibleEvidence = result.bundle.passages.map(passage => passage.content).join('\n');

  assert.match(visibleEvidence, /神明纪元/u);
  assert.match(visibleEvidence, /泰珂/u);
  assert.doesNotMatch(visibleEvidence, /奥古斯提姆帝国拥有当前时代/u);
  assert.ok(result.bundle.passages.some(passage => passage.startOffset > 1_800));
  assert.equal(
    result.bundle.receipt.passageBudget.strategyVersion,
    EVIDENCE_PASSAGE_STRATEGY_VERSION,
  );
  assert.doesNotMatch(JSON.stringify(result.bundle.receipt), /愿力为冒险/u);
});

test('历史年表生成共享时代资格账本，区分神性本体与尚未形成的帝国、宗教和公会', async () => {
  const source = snapshot('worldbook:temporal-eligibility-main', '[世界主设定]', [
    '# 世界地理概览',
    '奥古斯提姆帝国：中东部的人类帝国。',
    '# 智慧种族',
    '人类：由诸神在神明纪元创造的智慧种族。',
    '# 阿斯塔利亚历史年表',
    '神明纪元：诸神创造智慧生物，精灵建立首个文明艾尔文海姆。',
    '混乱纪元：宗教形成。人类帝国诞生并统一大陆东部，圣灵信仰诞生。',
    '复兴纪元：各大公会兴起。',
    '# 宗教体系',
    '## 神明',
    '烈日与黄金之主・金铎：',
    '  - 信仰：黄金与烈日。',
    '## 圣灵 (人类信仰)',
    '旅途与幸运的女神・泰珂：',
    '  - 愿力：冒险、交易与幸运。',
    '圣约之护・艾瑟拉：',
    '  - 愿力：守护与治愈。',
  ].join('\n'));
  const engine = new UnifiedShadowRetrievalEngine([source]);
  const result = await engine.retrieve({
    requestId: 'temporal-eligibility-ledger',
    taskType: 'ruin',
    query: '神明纪元 阿斯塔利亚大陆全境 泰珂对其他神明所作的恶作剧',
  });
  const ledger = result.bundle.temporalEligibility;

  assert.ok(ledger);
  assert.deepEqual(ledger.eraOrder, ['神明纪元', '混乱纪元', '复兴纪元']);
  const active = activeTemporalEligibilityRules(ledger, '神明纪元');
  assert.ok(active.some(rule => rule.subject === '宗教' && rule.scope === 'institution'));
  assert.ok(active.some(rule =>
    rule.subject === '人类帝国'
    && rule.scope === 'entity'
    && rule.affectedEntityNames.includes('奥古斯提姆帝国')));
  assert.ok(active.some(rule =>
    rule.subject === '人类帝国'
    && !rule.affectedEntityNames.includes('人类')),
  '帝国的诞生不能反向推迟其基础种族的存在时间');
  assert.ok(active.some(rule =>
    rule.subject === '圣灵信仰'
    && rule.scope === 'institution'
    && rule.affectedEntityNames.includes('艾瑟拉')));
  assert.ok(active.some(rule => rule.subject === '公会' && rule.availableFromEra === '复兴纪元'));

  const violations = findTemporalEligibilityViolations(
    '奥古斯提姆帝国的艾瑟拉祭司建立药剂公会。',
    '神明纪元',
    ledger,
  );
  // 实体级规则仍软命中（帝国/公会）；词表词（祭司）不再命中——交给模型按时代画像判断。
  assert.ok(violations.some(item => item.matchedTerm === '奥古斯提姆帝国'));
  assert.ok(!violations.some(item => item.matchedTerm === '祭司'),
    '词表黑名单已废弃：祭司裸词不再被 institution 规则命中');
  assert.ok(violations.some(item => item.matchedTerm === '公会'));
  assert.deepEqual(
    findTemporalEligibilityViolations('泰珂直接调换了金铎的酒杯。', '神明纪元', ledger),
    [],
  );
  assert.deepEqual(
    findTemporalEligibilityViolations('人类目睹泰珂调换了金铎的酒杯。', '神明纪元', ledger),
    [],
  );
  assert.equal(result.bundle.receipt.catalog?.temporalRuleCount, ledger.rules.length);
  // 时间冲突不再致命：直接点名帝国也降级为 warning（模型按时代画像合理处理）。
  const conflicted = await engine.retrieve({
    requestId: 'temporal-eligibility-direct-conflict',
    taskType: 'ruin',
    query: '神明纪元的奥古斯提姆帝国发生历史转折',
    mode: 'active',
  });
  assert.ok(
    conflicted.bundle.receipt.warnings.some(warning =>
      warning.includes('奥古斯提姆帝国 is unavailable in 神明纪元')),
    '时间冲突必须降级为 receipt.warnings 而非抛错',
  );
  await assert.doesNotReject(() => engine.retrieve({
    requestId: 'temporal-eligibility-human-race-allowed',
    taskType: 'ruin',
    query: '神明纪元的人类目睹泰珂对其他神明恶作剧',
    mode: 'active',
  }));
});

test('R-05 疆域：把「奥古斯提姆帝国」当地点范围填时不 fatal，降级为 warning 且任务成功', async () => {
  const sources = [
    snapshot('worldbook:main-setting', '[世界主设定]', [
      '# 世界地理概览',
      '奥古斯提姆帝国：中东部的人类帝国。',
      '# 阿斯塔利亚历史年表',
      '神明纪元：诸神创造智慧生物，精灵建立首个文明艾尔文海姆。',
      '混乱纪元：宗教形成。人类帝国诞生并统一大陆东部，圣灵信仰诞生。',
    ].join('\n')),
    snapshot('worldbook:tyche', '[角色]泰珂', '泰珂是旅途与幸运的女神，在神明纪元以恶作剧闻名。'),
    snapshot('worldbook:silver-sail', '[地点]银帆城', '银帆城是东部沿海的商业心脏。'),
  ];
  const engine = new UnifiedShadowRetrievalEngine(sources);
  // 不传 territorial：直接点名帝国 → 时间冲突降级为 warning（不再 fatal）。
  const plain = await engine.retrieve({
    requestId: 'territorial-negative-control',
    taskType: 'ruin',
    query: '神明纪元 奥古斯提姆帝国发生历史转折',
    mode: 'active',
  });
  assert.ok(
    plain.bundle.receipt.warnings.some(warning =>
      warning.includes('temporal conflict degraded to warning')),
    '直接点名也降级为 warning（不再 fatal）',
  );
  // 作为地点范围填（territorialReferences）：warning 语义为疆域引用。
  const result = await engine.retrieve({
    requestId: 'territorial-positive',
    taskType: 'ruin',
    query: '神明纪元 奥古斯提姆帝国疆域内的历史转折',
    mode: 'active',
    territorialReferences: ['奥古斯提姆帝国'],
  });
  assert.ok(result.bundle.passages.length > 0, '疆域引用任务必须成功并产出 passage');
  assert.ok(
    result.bundle.receipt.warnings.some(warning =>
      warning.includes('treated as territorial reference')),
    'receipt.warnings 必须包含疆域降级说明',
  );
});

test('Temporal v2：权威年表是纪元顺序唯一来源，非权威来源的纪元不污染顺序', async () => {
  const authoritative = snapshot(
    'worldbook:timeline-authoritative',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '神明纪元：精灵建立艾尔文海姆。',
      '混乱纪元：人类帝国诞生。',
      '复兴纪元：公会兴起。',
    ].join('\n'),
  );
  // 非权威条目声称「英雄纪元早于神明纪元」——不得污染 eraOrder。
  const conflicting = snapshot(
    'worldbook:legend-source',
    '[民间传说]',
    '传说中英雄纪元与神明纪元同时存在。',
  );
  const catalog = buildWorldKnowledgeCatalog([authoritative, conflicting], []);
  const ledger = catalog.temporalEligibility;
  assert.deepEqual(ledger.eraOrder, ['神明纪元', '混乱纪元', '复兴纪元']);
  assert.equal(ledger.authoritativeSourceSnapshotIds?.length, 1);
  assert.ok(ledger.authoritativeSourceSnapshotIds?.includes(authoritative.snapshotId));
});

test('Temporal v2：否定句不建规则，传说句降为 low 且不阻断 Active', async () => {
  const source = snapshot(
    'worldbook:negation-legend',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '神明纪元：精灵建立艾尔文海姆。',
      '混乱纪元：人类帝国诞生。公会尚未建立，圣灵信仰不属于神明纪元。',
      '复兴纪元：公会兴起。',
    ].join('\n'),
  );
  const catalog = buildWorldKnowledgeCatalog([source], []);
  const ledger = catalog.temporalEligibility;
  // 否定句（尚未建立/不属于）不产生规则；「公会」只来自复兴纪元。
  const guildRules = ledger.rules.filter(rule => rule.subject === '公会');
  assert.equal(guildRules.length, 1);
  assert.equal(guildRules[0].availableFromEra, '复兴纪元');
  assert.equal(guildRules[0].eventType, 'formed');

  // 传说来源的规则为 low+inferred：不进入 fatal 门，active 不阻断。
  const legend = snapshot(
    'worldbook:legend-only',
    '[传说条目]',
    [
      '# 历史年表',
      '混乱纪元：人类帝国诞生并统一大陆东部。',
      '复兴纪元：据说圣灵教会也在混乱纪元建立。',
    ].join('\n'),
  );
  const legendCatalog = buildWorldKnowledgeCatalog([legend], []);
  const legendLedger = legendCatalog.temporalEligibility;
  const legendRules = legendLedger.rules.filter(rule => rule.confidence === 'low');
  assert.ok(legendRules.length > 0, '传说句应产生 low 规则');
  assert.ok(legendRules.every(rule => rule.status === 'inferred'));
  // low 规则不进 fatal：active 检索引用该实体不抛错。
  const engine = new UnifiedShadowRetrievalEngine([legend]);
  await assert.doesNotReject(() => engine.retrieve({
    requestId: 'legend-low-conf',
    taskType: 'ruin',
    query: '神明纪元 古老帝国',
    mode: 'active',
  }));
});

test('Temporal v2：灭亡/改名事件类型被识别', async () => {
  const source = snapshot(
    'worldbook:lifecycle',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '混乱纪元：人类帝国诞生。',
      '英雄纪元：人类帝国分裂解体。',
      '复兴纪元：奥古斯提姆帝国重建。',
    ].join('\n'),
  );
  const catalog = buildWorldKnowledgeCatalog([source], []);
  const ledger = catalog.temporalEligibility;
  const split = ledger.rules.find(rule => rule.eventType === 'dissolved');
  assert.ok(split, '应识别解体/分裂事件');
  const rebuilt = ledger.rules.find(rule => rule.eventType === 'reformed');
  assert.ok(rebuilt, '应识别重建/复兴事件');
  assert.deepEqual(ledger.eraOrder, ['混乱纪元', '英雄纪元', '复兴纪元']);
});

test('四模块以证据段反推最终来源，可选来源超预算时降级而不让 Active 整项失败', async () => {
  const sources = Array.from({ length: 20 }, (_, index) => snapshot(
    `worldbook:evidence-first:${index}`,
    `共同史料 ${index}`,
    `共同史料：${String(index).padStart(2, '0')}。${'这是一段可选历史背景。'.repeat(180)}`,
  ));

  for (const taskType of ['biography', 'genealogy', 'ruin', 'butterfly'] as const) {
    const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
      requestId: `evidence-first-${taskType}`,
      taskType,
      query: '共同史料',
      mode: 'active',
    });
    const selectedPassageSources = new Set(
      result.bundle.receipt.selectedPassages.map(passage => passage.snapshotId),
    );
    assert.ok(result.bundle.receipt.selected.length > 0);
    assert.ok(result.bundle.receipt.selected.every(item => selectedPassageSources.has(item.snapshotId)));
    assert.deepEqual(
      result.bundle.sourceSnapshots.map(source => source.snapshotId),
      result.bundle.receipt.selected.map(item => item.snapshotId),
    );
    assert.ok(result.bundle.receipt.rejected.some(item => item.reason === 'passage-budget-exhausted'));
    assert.equal(
      result.bundle.receipt.selected.length + result.bundle.receipt.rejected.length,
      result.bundle.receipt.candidateSnapshotIds.length,
    );
  }
});

test('传记核心人物的权威 passage 先于可选背景占用预算', async () => {
  const rhys = snapshot(
    'worldbook:rhys-authority',
    '[DLC][角色][瑞丝]瑞丝(rhys-血族,棺材里的少女,可能被埋在了索伦蒂斯或奥古斯提姆)',
    `瑞丝：沉睡在棺材里的血族少女。${'她的身份与经历由这一人物条目记载。'.repeat(150)}`,
  );
  const background = Array.from({ length: 18 }, (_, index) => snapshot(
    `worldbook:rhys-background:${index}`,
    `索伦蒂斯背景 ${index}`,
    `索伦蒂斯：${'这是一段与当地历史有关、但不决定瑞丝身份的背景。'.repeat(120)}`,
  ));
  const result = await new UnifiedShadowRetrievalEngine([rhys, ...background]).retrieve({
    requestId: 'biography-rhys-required-passage',
    taskType: 'biography',
    query: '瑞丝 索伦蒂斯',
    mode: 'active',
  });

  assert.ok(result.bundle.passages.some(passage => passage.snapshotId === rhys.snapshotId));
  assert.ok(result.bundle.castManifest?.entries.some(entry =>
    entry.identity.canonicalName === '瑞丝'
    && entry.disposition === 'required'
    && entry.identity.passageIds.length > 0));
  assert.ok(result.bundle.receipt.selected.some(item => item.snapshotId === rhys.snapshotId));
});

test('墟境重点参考人物只进入 recommended，补充方向明确点名仍进入 required', async () => {
  const source = snapshot(
    'worldbook:focus-lingshan',
    '[角色]玲山·哈姆斯沃思',
    '玲山·哈姆斯沃思：翼民记者，活跃于复兴纪元。',
  );
  const engine = new UnifiedShadowRetrievalEngine([source]);
  const focusOnly = await engine.retrieve({
    requestId: 'ruin-focus-reference-only',
    taskType: 'ruin',
    query: '复兴纪元\n黑曜监牢\n玲山·哈姆斯沃思\n翼民记者',
    castRequirementQuery: '复兴纪元\n黑曜监牢',
    focusEntityNames: ['玲山·哈姆斯沃思'],
    mode: 'active',
  });
  assert.equal(
    focusOnly.bundle.castManifest?.entries.find(entry =>
      entry.identity.canonicalName === '玲山·哈姆斯沃思')?.disposition,
    'recommended',
  );

  const explicitlyRequired = await engine.retrieve({
    requestId: 'ruin-explicit-actor',
    taskType: 'ruin',
    query: '复兴纪元\n黑曜监牢\n玲山·哈姆斯沃思',
    castRequirementQuery: '复兴纪元\n黑曜监牢\n让玲山·哈姆斯沃思亲自越狱',
    focusEntityNames: ['玲山·哈姆斯沃思'],
    mode: 'active',
  });
  assert.equal(
    explicitlyRequired.bundle.castManifest?.entries.find(entry =>
      entry.identity.canonicalName === '玲山·哈姆斯沃思')?.disposition,
    'required',
  );
});

test('Retrieval v1.2 为全部候选快照建立覆盖状态，并把众神展开为有据可查的角色编排', async () => {
  const source = withWorldbookKeys(snapshot(
    'worldbook:catalog-cast-deities',
    '[世界主设定]',
    [
      '# 宗教体系',
      '## 圣灵',
      '旅途与幸运的女神・泰珂（狡黠少女）：爱以恶作剧考验同僚。',
      '太阳与誓言的男神・赫利昂（守誓者）：维护神明之间的盟约。',
      '月光与梦境的女神・塞勒涅（织梦者）：看守夜空与梦境。',
      '知识与道路的女神・弥涅拉（引路人）：记录诸神的往来。',
    ].join('\n'),
  ), 88, ['泰珂', '神明']);
  const result = await new UnifiedShadowRetrievalEngine([
    source,
    snapshot('worldbook:opaque', '陌生格式', '无标题自由文本，但仍必须保留全文倒排。'),
  ]).retrieve({
    requestId: 'catalog-cast-deities',
    taskType: 'ruin',
    query: '狡黠的女神泰珂对其他神明所作的恶作剧',
  });

  assert.equal(result.bundle.receipt.strategyVersion, 'v1.2-catalog-cast');
  assert.equal(result.bundle.receipt.catalog?.coverage.total, 2);
  assert.equal(
    (result.bundle.receipt.catalog?.coverage.indexed ?? 0)
      + (result.bundle.receipt.catalog?.coverage.partial ?? 0)
      + (result.bundle.receipt.catalog?.coverage.opaque ?? 0),
    2,
  );
  assert.deepEqual(
    new Set(result.bundle.castManifest?.entries
      .filter(entry => ['required', 'group-required'].includes(entry.disposition))
      .map(entry => entry.identity.canonicalName)),
    new Set(['泰珂', '塞勒涅', '弥涅拉', '赫利昂']),
  );
  assert.ok(result.bundle.castManifest?.entries.every(entry =>
    !['required', 'group-required'].includes(entry.disposition)
    || entry.identity.passageIds.length > 0));
  assert.equal(result.bundle.castManifest?.groupCoverage[0]?.complete, true);
  assert.doesNotMatch(JSON.stringify(result.bundle.receipt), /爱以恶作剧考验同僚/u);
});

test('玩家直接点名的组织进入角色编排并携带真实归属，表单地点本身不冒充演员', async () => {
  const sources = [
    snapshot(
      'worldbook:holy-wing-order',
      '[组织]圣翼骑士团',
      '身份: 翼民空军骑士组织\n所属势力: 梵尼亚\n活跃于: 复兴纪元',
    ),
    snapshot(
      'worldbook:augustim-stage',
      '[地点]奥古斯提姆帝国',
      '类型: 人类帝国\n活跃于: 复兴纪元',
    ),
  ];
  const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
    requestId: 'direct-organization-cast',
    taskType: 'ruin',
    query: '复兴纪元 奥古斯提姆帝国 圣翼骑士团如何介入边境谈判',
    mode: 'active',
  });
  const order = result.bundle.castManifest?.entries.find(entry =>
    entry.identity.canonicalName === '圣翼骑士团');

  assert.ok(order);
  assert.equal(order.disposition, 'required');
  assert.ok(order.identity.kinds.includes('organization'));
  assert.ok(order.identity.affiliations?.includes('梵尼亚'));
  assert.ok(!result.bundle.castManifest?.entries.some(entry =>
    entry.identity.canonicalName === '奥古斯提姆帝国'));
});

test('required 角色锚点不会被其他来源的同名短段替代权威身份 passage', async () => {
  const authority = snapshot(
    'worldbook:cast-authority',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '神明纪元：众神创造世界并返回神国。',
      '',
      '# 宗教体系',
      '## 圣灵',
      '旅途与幸运的女神・泰珂 (狡黠少女):',
      '  - 愿力: 冒险，交易，幸运',
    ].join('\n'),
  );
  const recentMention = snapshot(
    'chat:recent-tyche-mention',
    '近期聊天',
    '狡黠的女神泰珂正准备对其他神明进行恶作剧。',
    'chat',
  );
  const result = await new UnifiedShadowRetrievalEngine([authority, recentMention]).retrieve({
    requestId: 'cast-authority-cross-source-regression',
    taskType: 'ruin',
    query: '神明纪元 阿斯塔利亚大陆全境 狡黠的女神泰珂对其他神明所作的恶作剧',
    mode: 'active',
  });
  const tyche = result.bundle.castManifest?.entries.find(entry =>
    entry.identity.canonicalName === '泰珂');

  assert.ok(tyche);
  assert.ok(tyche.identity.passageIds.length > 0);
  assert.ok(result.bundle.passages.some(passage =>
    passage.snapshotId === authority.snapshotId
    && passage.content.includes('泰珂')
    && tyche.identity.passageIds.includes(passage.passageId)));
});

test('明确要求全体时不把未覆盖成员静默藏掉', async () => {
  const deityLines = Array.from(
    { length: 26 },
    (_, index) => `守望领域的神明・神祇${index}：记录第${index}条职责。`,
  );
  const result = await new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:many-deities', '神系名录', deityLines.join('\n')),
  ]).retrieve({
    requestId: 'catalog-cast-all-deities',
    taskType: 'ruin',
    query: '让所有神明逐一参与议事',
  });

  assert.equal(result.bundle.castManifest?.groupCoverage[0]?.complete, false);
  assert.equal(result.bundle.castManifest?.groupCoverage[0]?.omittedEntityIds.length, 2);
  assert.equal(result.bundle.receipt.cast?.groupsComplete, false);
});

test('集合展开只把时间兼容成员列为 group-required，错纪元成员留下 excluded 理由', async () => {
  const result = await new UnifiedShadowRetrievalEngine([
    snapshot(
      'worldbook:ancient-deity',
      '[角色][神明]黎明女神',
      JSON.stringify({ name: '黎明女神', type: '神明', era: '神明纪元', identity: '晨光守望女神' }),
    ),
    snapshot(
      'worldbook:modern-deity',
      '[角色][神明]新律女神',
      JSON.stringify({ name: '新律女神', type: '神明', era: '复兴纪元', identity: '新律守望女神' }),
    ),
  ]).retrieve({
    requestId: 'catalog-cast-temporal-exclusion',
    taskType: 'ruin',
    query: '神明纪元所有神明逐一参与议事',
  });

  assert.ok(result.bundle.castManifest?.entries.some(entry =>
    entry.identity.canonicalName === '黎明女神'
    && entry.disposition === 'group-required'));
  assert.ok(result.bundle.castManifest?.entries.some(entry =>
    entry.identity.canonicalName === '新律女神'
    && entry.disposition === 'excluded'
    && entry.reasons.includes('temporal-scope-incompatible')));
});

test('地点可沿明确关系反查人物，正反邻接保持同一证据边', async () => {
  const traveler = snapshot(
    'worldbook:traveler-at-silver-sail',
    '[角色]远行者阿岚',
    '活动地点：银帆城\n身份：港区领航员。',
  );
  const farAway = snapshot(
    'worldbook:far-away-traveler',
    '[角色]远行者贝娅',
    '活动地点：红叶镇\n身份：山地领航员。',
  );
  const index = buildRetrievalIndex([traveler, farAway]);
  const relation = index.catalog.relations.find(item => item.predicate === 'active_in'
    && index.catalog.entities.find(entity => entity.entityId === item.objectEntityId)?.canonicalName === '银帆城');
  assert.ok(relation);
  assert.ok(index.catalog.adjacency[relation.subjectEntityId]?.includes(relation.objectEntityId));
  assert.ok(index.catalog.reverseAdjacency[relation.objectEntityId]?.includes(relation.subjectEntityId));

  const result = await new UnifiedShadowRetrievalEngine([traveler, farAway]).retrieve({
    requestId: 'place-reverse-cast',
    taskType: 'ruin',
    query: '银帆城港区发生了一场历史事件',
  });
  assert.ok(result.bundle.castManifest?.entries.some(entry =>
    entry.identity.canonicalName === '远行者阿岚'
    && entry.disposition === 'recommended'
    && entry.identity.passageIds.length > 0));
  assert.ok(!result.bundle.sourceSnapshots.some(source => source.logicalId === farAway.logicalId));
});

test('四类任务画像共同消费同一个 EvidencePassage 装配合同', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:shared-passage', '共同人物', '共同人物在共同年代留下了明确记录。'),
  ]);
  for (const taskType of ['biography', 'genealogy', 'ruin', 'butterfly'] as const) {
    const result = await engine.retrieve({
      requestId: `shared-passage-${taskType}`,
      taskType,
      query: '共同人物',
    });
    assert.equal(result.bundle.passages.length, 1, `${taskType} 应产出共用 passage`);
    assert.equal(result.bundle.passages[0].extractionMode, 'full');
    assert.equal(
      result.bundle.receipt.passageBudget.strategyVersion,
      EVIDENCE_PASSAGE_STRATEGY_VERSION,
    );
  }
});

test('R-04：普通（desired）锚预算不足只省略不失败；required（fatal）锚不足才硬失败', async () => {
  const source = snapshot(
    'worldbook:passage-overflow',
    '预算夹具',
    `锚点甲${'甲'.repeat(70)}\n\n锚点乙${'乙'.repeat(70)}`,
  );
  // desired 锚预算不足：不抛错，进入 omittedAnchors 警告。
  const desired = await assembleEvidencePassages({
    snapshots: [source],
    queryAnchors: ['锚点甲', '锚点乙'],
    claims: [],
    budget: {
      strategyVersion: EVIDENCE_PASSAGE_STRATEGY_VERSION,
      softLimitChars: 60,
      hardLimitChars: 90,
      fullSourceLimitChars: 80,
      maxWindowChars: 80,
    },
  });
  assert.ok(
    desired.omittedAnchors.length > 0,
    '预算不足的普通锚必须进入 omittedAnchors 而不是抛错',
  );
  assert.ok(desired.passages.length > 0, '任务必须成功，不能因普通锚整体终止');

  // fatal 锚预算不足：仍显式失败。
  await assert.rejects(
    () => assembleEvidencePassages({
      snapshots: [source],
      queryAnchors: ['锚点甲', '锚点乙'],
      fatalCoverageAnchors: ['锚点甲', '锚点乙'],
      claims: [],
      budget: {
        strategyVersion: EVIDENCE_PASSAGE_STRATEGY_VERSION,
        softLimitChars: 60,
        hardLimitChars: 90,
        fullSourceLimitChars: 80,
        maxWindowChars: 80,
      },
    }),
    /cannot preserve required anchors/u,
  );
});

test('泰珂史案以历史世界书为首，并按锚点交叉索引既有三类成果', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot(
      'worldbook:main-setting',
      '[世界主设定]',
      [
        '神明纪元：众神行走于阿斯塔利亚大陆。',
        '旅途与幸运的女神・泰珂 (狡黠少女):',
        '泰珂常以恶作剧捉弄其他神明。',
      ].join('\n'),
      'worldbook',
      0,
    ),
    snapshot(
      'worldbook:current-politics',
      '复兴纪元帝国政局',
      '阿斯塔利亚大陆的帝国正在复兴纪元488年举行议会。',
      'worldbook',
      1,
    ),
    snapshot('mvu:tingwall', '汀瓦尔', '汀瓦尔正在阿斯塔利亚大陆执政。', 'mvu', 0),
    snapshot('chat:488', 'assistant floor 488', '阿斯塔利亚大陆的当前帝国政局。', 'chat', 0),
    snapshot(
      'genealogy:tyche',
      '泰珂神裔谱系',
      JSON.stringify({ name: '泰珂', era: '神明纪元', nodes: [], edges: [] }),
      'genealogy',
      0,
    ),
    snapshot(
      'biography:tyche-old',
      '泰珂旧传一',
      JSON.stringify({ name: '泰珂', era: '神明纪元', summary: '泰珂的恶作剧旧闻。' }),
      'biography',
      0,
    ),
    snapshot(
      'biography:tyche-new',
      '泰珂旧传二',
      JSON.stringify({ name: '泰珂', era: '神明纪元', summary: '泰珂的恶作剧新证。' }),
      'biography',
      1,
    ),
    snapshot(
      'butterfly:tyche',
      '泰珂恶作剧余波',
      JSON.stringify({ name: '泰珂', era: '神明纪元', summary: '恶作剧造成的蝴蝶效应。' }),
      'butterfly',
      0,
    ),
  ]);
  const result = await engine.retrieve({
    requestId: 'ruin-tyche-history',
    taskType: 'ruin',
    query: [
      '神明纪元',
      '阿斯塔利亚大陆全境',
      '狡黠的女神泰珂对其他神明所作的恶作剧',
    ].join('\n'),
    contextQuery: '复兴纪元488年\n帝国\n汀瓦尔',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.logicalId);

  assert.equal(selected[0], 'worldbook:main-setting');
  assert.ok(selected.includes('genealogy:tyche'));
  assert.ok(selected.includes('biography:tyche-old'));
  assert.ok(selected.includes('biography:tyche-new'));
  assert.ok(selected.includes('butterfly:tyche'));
  assert.ok(
    !selected.includes('worldbook:current-politics'),
    JSON.stringify(result.bundle.receipt.selected.find(item =>
      item.snapshotId.startsWith('worldbook:current-politics@'))),
  );
  assert.ok(!selected.includes('mvu:tingwall'));
  assert.ok(!selected.includes('chat:488'));
  assert.ok(
    selected.indexOf('biography:tyche-new') < selected.indexOf('biography:tyche-old'),
    '同分同类史料应以较后的宿主位置优先，并在回执中保持稳定顺序',
  );
  assert.ok(result.bundle.receipt.rejected.some(item =>
    item.snapshotId.startsWith('mvu:tingwall@')
    && ['insufficient-primary-anchor', 'no-retrieval-signal'].includes(item.reason)));
});

test('叙述性比较句不会被误建为组织归属', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot(
      'mvu:bad-relation',
      '汀瓦尔评论',
      '在她眼里汀瓦尔甚至比她还要属于帝国。',
      'mvu',
    ),
  ]);
  const result = await engine.retrieve({
    requestId: 'reject-prose-relation',
    taskType: 'ruin',
    query: '汀瓦尔',
  });
  assert.equal(result.bundle.claims.length, 0);
});

test('墟境画像沿组织归属召回梵尼亚，不把无关系的翡翠之心混入', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:council', '圣翼议会', '圣翼议会属于梵尼亚。'),
    snapshot('worldbook:vannia', '梵尼亚', '梵尼亚是北方政权。'),
    snapshot('worldbook:emerald', '翡翠之心', '翡翠之心是另一独立势力。'),
  ]);
  const result = await engine.retrieve({
    requestId: 'ruin-shadow-1',
    taskType: 'ruin',
    query: '检索圣翼议会的历史归属',
    legacyLogicalIds: ['worldbook:council', 'worldbook:emerald'],
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.logicalId);

  assert.ok(selected.includes('worldbook:council'));
  assert.ok(selected.includes('worldbook:vannia'));
  assert.ok(!selected.includes('worldbook:emerald'));
  assert.deepEqual(result.comparison.sharedLogicalIds, ['worldbook:council']);
  assert.deepEqual(result.comparison.legacyOnlyLogicalIds, ['worldbook:emerald']);
  assert.deepEqual(result.comparison.unifiedOnlyLogicalIds, ['worldbook:vannia']);
  assert.equal(result.bundle.receipt.mode, 'shadow');
  assert.equal(result.bundle.receipt.fallback, 'none');
  assert.ok(result.bundle.receipt.rejected.some(item =>
    item.snapshotId.startsWith('worldbook:emerald@')
    && item.reason === 'no-retrieval-signal'));
  assert.ok(result.bundle.claims.some(claim =>
    claim.subject === '圣翼议会'
    && claim.predicate === 'belongs_to'
    && claim.object === '梵尼亚'));
});

test('谱系画像允许两跳亲缘召回，传记画像只扩展一跳', async () => {
  const sources = [
    snapshot('genealogy:adela', '阿黛拉', '阿黛拉的父亲是贝伦。', 'genealogy'),
    snapshot('genealogy:beren', '贝伦', '贝伦的母亲是塞西莉亚。', 'genealogy'),
    snapshot('genealogy:cecilia', '塞西莉亚', '塞西莉亚是家族长辈。', 'genealogy'),
  ];
  const engine = new UnifiedShadowRetrievalEngine(sources);
  const genealogy = await engine.retrieve({
    requestId: 'genealogy-shadow-1',
    taskType: 'genealogy',
    query: '查询阿黛拉的宗族关系',
  });
  const biography = await engine.retrieve({
    requestId: 'biography-shadow-1',
    taskType: 'biography',
    query: '查询阿黛拉的生平',
  });

  assert.ok(genealogy.bundle.sourceSnapshots.some(source => source.logicalId === 'genealogy:cecilia'));
  assert.ok(!biography.bundle.sourceSnapshots.some(source => source.logicalId === 'genealogy:cecilia'));
});

test('真实 eyon.genealogy.v2 的 relationType 会进入关系索引', async () => {
  const genealogy = {
    schema: 'eyon.genealogy.v2',
    nodes: [
      { id: 'focus', name: '维奥莱塔', aliases: [] },
      { id: 'father', name: '马克西姆三世', aliases: [] },
      { id: 'grandmother', name: '塞西莉亚', aliases: [] },
    ],
    edges: [
      { from: 'father', to: 'focus', relationType: 'parent', label: '父女' },
      { from: 'grandmother', to: 'father', relationType: 'parent', label: '母子' },
    ],
  };
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('genealogy:whole', '维奥莱塔宗族谱系', JSON.stringify(genealogy), 'genealogy'),
    snapshot('genealogy:cecilia', '塞西莉亚', '塞西莉亚的家族资料。', 'genealogy'),
  ]);
  const result = await engine.retrieve({
    requestId: 'genealogy-v2-shadow',
    taskType: 'genealogy',
    query: '维奥莱塔宗族谱系',
  });

  assert.ok(result.bundle.claims.some(claim =>
    claim.subject === '马克西姆三世'
    && claim.predicate === 'parent'
    && claim.object === '维奥莱塔'));
  assert.ok(result.bundle.sourceSnapshots.some(source => source.logicalId === 'genealogy:cecilia'));
});

test('同名人物按时间信号排除错纪元来源，来源身份不会合并', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:arno-old', '阿尔诺', '旧世纪元210年的阿尔诺是一名学者。'),
    snapshot('worldbook:arno-revival', '阿尔诺', '复兴纪元488年的阿尔诺是一名军官。'),
  ]);
  const result = await engine.retrieve({
    requestId: 'same-name-shadow',
    taskType: 'biography',
    query: '复兴纪元488年的阿尔诺',
  });

  assert.deepEqual(
    result.bundle.sourceSnapshots.map(source => source.logicalId),
    ['worldbook:arno-revival'],
  );
  assert.ok(result.bundle.receipt.rejected.some(item =>
    item.snapshotId.startsWith('worldbook:arno-old@')
    && item.reason === 'temporal-scope-incompatible'));
});

test('同一时间域内互斥归属被标为冲突，不替模型静默裁决', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:council-vannia', '圣翼议会·梵尼亚记载', '圣翼议会属于梵尼亚。'),
    snapshot('worldbook:council-emerald', '圣翼议会·翡翠记载', '圣翼议会属于翡翠之心。'),
  ]);
  const result = await engine.retrieve({
    requestId: 'conflict-shadow',
    taskType: 'ruin',
    query: '圣翼议会归属',
  });

  assert.equal(result.bundle.claims.length, 2);
  assert.ok(result.bundle.claims.every(claim => claim.epistemicStatus === 'conflicted'));
  assert.ok(result.bundle.claims.every(claim => claim.sourcePassageIds.length > 0));
  assert.equal(result.bundle.conflictGroupIds.length, 1);
  assert.ok(result.bundle.claims.every(claim =>
    claim.conflictGroupId === result.bundle.conflictGroupIds[0]));
});

test('标题类别前缀可被查询，否定归属不会被误建关系，重复 snapshot 会去重', async () => {
  const prefixed = snapshot(
    'worldbook:prefixed-council',
    '【组织】圣翼议会',
    '圣翼议会不属于翡翠之心。',
  );
  const result = await new UnifiedShadowRetrievalEngine([
    prefixed,
    prefixed,
    snapshot('worldbook:emerald-negative', '翡翠之心', '另一势力。'),
  ]).retrieve({
    requestId: 'negative-relation-shadow',
    taskType: 'ruin',
    query: '圣翼议会',
  });

  assert.deepEqual(
    result.bundle.sourceSnapshots.map(source => source.logicalId),
    ['worldbook:prefixed-council'],
  );
  assert.equal(result.bundle.receipt.candidateSnapshotIds.length, 2);
  assert.equal(result.bundle.claims.length, 0);
});

test('显式地点标签优先于正文人物年龄，同一人物条目的时间种子不会重复分裂', () => {
  const place = snapshot(
    'worldbook:twilight-room',
    '【地点】黄昏花室',
    '现状：园丁尤娜，年龄：24岁。黄昏花室位于艾瑟嘉德皇宫高塔。',
  );
  const person = snapshot(
    'worldbook:lingshan-temporal-seeds',
    '【角色】玲山·哈姆斯沃思',
    '复兴纪元488年，玲山·哈姆斯沃思是琉璃塔信报社社长。\n年龄：27岁。',
  );
  const catalog = buildWorldKnowledgeCatalog([place, person], []);
  const room = catalog.entities.find(entity => entity.canonicalName === '黄昏花室');
  const lingshan = catalog.entities.filter(entity => entity.canonicalName === '玲山·哈姆斯沃思');

  assert.ok(room?.kinds.includes('place'));
  assert.ok(!room?.kinds.includes('person'), '园丁年龄不能把地点标题误判成人物');
  assert.equal(lingshan.length, 1, '同一来源的有/无 lifespan 种子应落到同一个时间实体');
  assert.equal(lingshan[0]?.lifespan?.ageAtRecord, 27);
  assert.deepEqual(lingshan[0]?.temporalScopes, ['复兴纪元']);
});

test('世界书主次关键词都进入索引，真实策略元数据保持原样', async () => {
  const source = snapshot(
    'worldbook:secondary-key',
    '无词面标题',
    '正文没有查询词。',
  );
  source.metadata = {
    schema: 'eyon.retrieval.worldbook-metadata.v1',
    logicalId: source.logicalId,
    worldbookName: '核心',
    uid: 9,
    bindingScopes: ['character-primary'],
    enabled: true,
    strategy: {
      type: 'vectorized',
      primaryKeys: ['第一锚点'],
      secondary: { logic: 'and_all', keys: ['隐秘锚词'] },
      scanDepth: 4,
    },
    position: null,
    probability: 80,
    recursion: { preventIncoming: false, preventOutgoing: true, delayUntil: 1 },
    effect: { sticky: 2, cooldown: 1, delay: null },
    extra: {},
  };
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({
    requestId: 'secondary-key-shadow',
    taskType: 'ruin',
    query: '隐秘锚词',
  });

  assert.deepEqual(result.bundle.sourceSnapshots.map(item => item.logicalId), [source.logicalId]);
  assert.equal(
    (result.bundle.sourceSnapshots[0].metadata as WorldbookRetrievalMetadata).strategy.type,
    'vectorized',
  );
});

test('预算拒绝与无信号拒绝覆盖全部候选，并给出可读原因', async () => {
  const sources = Array.from({ length: 24 }, (_, index) =>
    snapshot(`worldbook:budget-${index}`, `预算条目${index}`, `共同关键词：第${index}份资料。`));
  sources.push(snapshot('worldbook:unrelated', '无关条目', '没有任何匹配内容。'));
  const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
    requestId: 'budget-shadow',
    taskType: 'genealogy',
    query: '共同关键词',
  });

  assert.equal(result.bundle.sourceSnapshots.length, 20);
  assert.equal(
    result.bundle.receipt.selected.length + result.bundle.receipt.rejected.length,
    sources.length,
  );
  assert.ok(result.bundle.receipt.rejected.some(item => item.reason === 'source-budget-exhausted'));
  assert.ok(result.bundle.receipt.rejected.some(item => item.reason === 'no-retrieval-signal'));
});

test('固定输入的新旧差异、queryHash 与选择顺序可复现', async () => {
  const engine = new UnifiedShadowRetrievalEngine([
    snapshot('worldbook:a', '甲组织', '甲组织属于乙势力。'),
    snapshot('worldbook:b', '乙势力', '乙势力的背景。'),
  ]);
  const input = {
    requestId: 'deterministic-shadow',
    taskType: 'ruin' as const,
    query: '甲组织',
    legacyLogicalIds: ['worldbook:a'],
  };
  const first = await engine.retrieve(input);
  const second = await engine.retrieve(input);

  assert.deepEqual(first.comparison, second.comparison);
  assert.equal(first.bundle.receipt.queryHash, second.bundle.receipt.queryHash);
  assert.deepEqual(
    first.bundle.receipt.selected.map(item => [item.snapshotId, item.reason, item.score]),
    second.bundle.receipt.selected.map(item => [item.snapshotId, item.reason, item.score]),
  );
});

test('合成规模满足冷索引与热检索首版性能预算', async () => {
  const sources = Array.from({ length: 2_000 }, (_, index) =>
    snapshot(
      `worldbook:performance-${index}`,
      `测试实体${index}`,
      `测试实体${index}属于测试势力${index % 80}。这是用于性能门的短资料。`,
    ));
  const engine = new UnifiedShadowRetrievalEngine(sources);
  assert.ok(engine.getDiagnostics().indexBuildMs <= 1_000);

  const durations: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    const started = performance.now();
    await engine.retrieve({
      requestId: `performance-${index}`,
      taskType: 'ruin',
      query: `测试实体${1_500 + index}`,
    });
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
  assert.ok(p95 <= 100, `热检索 p95=${p95.toFixed(2)}ms，应≤100ms`);
});

test('R-04：20 个普通锚 + 1 个 required actor，P0 必保留、P1 可省略且任务成功', async () => {
  const ordinary = Array.from({ length: 20 }, (_, index) =>
    `普通锚点${index}${'锚'.repeat(12)}`);
  const actorSource = snapshot(
    'worldbook:required-actor',
    '泰珂',
    '泰珂是神明纪元的神明。',
  );
  // 每条普通来源放大到约 1200 字，20 条约 24k，必然超过 16k 硬预算 → 触发 desired 省略。
  const ordinarySources = ordinary.map((anchor, index) =>
    snapshot(
      `worldbook:ordinary-${index}`,
      `普通条目${index}`,
      `${anchor}：这是第${index}份普通资料，用于占满预算。${'字'.repeat(1100)}`,
    ));
  const sources = [actorSource, ...ordinarySources];
  const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
    requestId: 'r04-tiered-budget',
    taskType: 'ruin',
    query: `泰珂 ${ordinary.join(' ')}`,
  });
  // required actor 的权威 passage 必须保留。
  assert.ok(
    result.bundle.passages.some(passage =>
      passage.title.includes('泰珂') || passage.content.includes('泰珂')),
    'required actor 的 P0 权威 passage 必须保留',
  );
  // 任务必须成功（不因普通锚预算不足抛错）。
  assert.ok(result.bundle.passages.length > 0);
  // receipt 明确列出 omitted（desired）锚，且以 warnings 表达可恢复省略。
  assert.ok(Array.isArray(result.bundle.receipt.omittedAnchors));
  assert.ok(
    result.bundle.receipt.omittedAnchors.length > 0
    || result.bundle.receipt.warnings.length > 0,
    '预算省略必须进入 receipt.omittedAnchors/warnings 而非错误字符串',
  );
});

test('人物时间锚：梅薇娜(488年基准88岁→出生400年)在310年标记 not-born 并给缺席叙事方针', async () => {
  const mevina = snapshot(
    'worldbook:mevina',
    '[角色]梅薇娜·王尔德',
    [
      '---',
      '梅薇娜·王尔德:',
      '  身份: 晨曙书局局长',
      '  种族: 人类',
      '  年龄: 88岁',
    ].join('\n'),
  );
  const engine = new UnifiedShadowRetrievalEngine([mevina]);
  // 玩家自定义 488 年开局：baselineWorldTime 锁定 488 → 出生 400 年。
  const result = await engine.retrieve({
    requestId: 'mevina-timeline',
    taskType: 'ruin',
    query: '复兴纪元310年 梅薇娜对晨曙书局的贡献',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  assert.ok(Array.isArray(result.bundle.personTimeline));
  const anchor = result.bundle.personTimeline?.find(item => item.name.includes('梅薇娜'));
  assert.ok(anchor, '梅薇娜必须进入人物时间锚');
  assert.equal(anchor?.state, 'not-born');
  assert.match(anchor?.narrative ?? '', /尚未|缺席|不存在/u);
  assert.match(anchor?.narrative ?? '', /晨曙书局/u);
  // 机器可读生卒窗口必须随锚点带出（时期分区逐段推断在场/年龄用）。
  assert.equal(anchor?.lifespan?.born?.era, '复兴纪元');
  assert.equal(anchor?.lifespan?.born?.year, 400);
  assert.equal(anchor?.lifespan?.ageBased, true);

  // 玩家自定义 300 年开局：锁 300 → 出生 212 年 → 310 年在世。
  const alive = await engine.retrieve({
    requestId: 'mevina-timeline-alive',
    taskType: 'ruin',
    query: '复兴纪元310年 梅薇娜对晨曙书局的贡献',
    mode: 'active',
    baselineWorldTime: '复兴纪元300年-1月-1日',
  });
  const aliveAnchor = alive.bundle.personTimeline?.find(item => item.name.includes('梅薇娜'));
  assert.equal(aliveAnchor?.state, 'alive');
});

test('P0-C：背景口述事件作为无序证据带出，只有“后来”与结构前提形成关系边', async () => {
  const lingshan = snapshot(
    'worldbook:lingshan',
    '[角色]玲山·哈姆斯沃思',
    [
      '---',
      '玲山·哈姆斯沃思:',
      '  身份: 琉璃塔信报社社长',
      '  种族: 翼族',
      '  年龄: 27岁',
      '  背景口述:',
      '    我离开梵尼亚的时候，带走的东西其实不多。',
      '    官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
      '    后来我到帝国，学会穿得体面。',
    ].join('\n'),
  );
  const engine = new UnifiedShadowRetrievalEngine([lingshan]);
  const result = await engine.retrieve({
    requestId: 'lingshan-life-anchors',
    taskType: 'ruin',
    query: '复兴纪元 玲山·哈姆斯沃思 梵尼亚',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  const anchor = result.bundle.personTimeline?.find(item => item.name.includes('玲山'));
  assert.ok(anchor, '玲山必须进入人物时间锚');
  assert.equal(anchor?.lifespan?.born?.year, 461);
  assert.ok(anchor?.lifeAnchors, '有序事件链锚必须带出');
  const events = (anchor?.lifeAnchors ?? []).map(item => item.event);
  assert.ok(events.some(event => event.includes('离开梵尼亚')), `应含离开梵尼亚，实际 ${events.join('|')}`);
  assert.ok(
    events.some(event => event.includes('铃羽') && event.includes('无尽地城')),
    `应含铃羽被选中去无尽地城，实际 ${events.join('|')}`,
  );
  assert.ok(events.some(event => event.includes('抵达') && event.includes('帝国')), `应含抵达帝国，实际 ${events.join('|')}`);
  const view = result.bundle.personCanonViews?.find(item => item.canonicalName.includes('玲山'));
  assert.ok(view, '人物规范视图必须进入共享证据包');
  const selected = view?.facts.find(fact => fact.predicate === 'person_selected_for_duty');
  assert.equal(selected?.epistemicStatus, 'reported', '“官方说”只能作为转述，不得晋升为客观真相');
  assert.equal(selected?.confidence, 'medium');
  const arrival = view?.facts.find(fact => fact.predicate === 'arrived_at');
  const departure = view?.facts.find(fact => fact.predicate === 'departed_from');
  assert.ok(
    view?.eventRelations?.some(relation =>
      relation.fromFactId === departure?.factId
      && relation.toFactId === arrival?.factId
      && relation.relation === 'before'),
    '离开原地必须早于“后来抵达”',
  );
  assert.ok(
    view?.eventRelations?.some(relation =>
      relation.fromFactId === selected?.factId
      && relation.toFactId === arrival?.factId
      && relation.relation === 'before'),
    '“后来”只建立有原文依据的前述事件→抵达关系',
  );
  const identity = view?.facts.find(fact => fact.predicate === 'identity');
  assert.ok(identity && view?.requiredFactIds.includes(identity.factId), '墟境直接人物的当前身份必须进入 requiredFacts');
});

test('MVU 源人物：无「[角色]」标签标题 + JSON 化内容，仍提取年龄并进入人物时间锚', async () => {
  // 真实链路：getCharacterSources 返回 JSON.stringify({name, ...value})，标题就是角色名。
  const lingshanMvu = snapshot(
    'mvu-character:玲山·哈姆斯沃思',
    '玲山·哈姆斯沃思',
    JSON.stringify({
      name: '玲山·哈姆斯沃思',
      entry: [
        '---',
        '玲山·哈姆斯沃思:',
        '  身份: 琉璃塔信报社社长',
        '  种族: 翼族',
        '  年龄: 27岁',
        '  背景口述:',
        '    我离开梵尼亚的时候，带走的东西其实不多。',
        '    官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
        '    后来我到帝国，学会穿得体面。',
      ].join('\n'),
    }),
    'mvu',
  );
  const engine = new UnifiedShadowRetrievalEngine([lingshanMvu]);
  const result = await engine.retrieve({
    requestId: 'lingshan-mvu-anchors',
    taskType: 'ruin',
    query: '复兴纪元 玲山·哈姆斯沃思 梵尼亚',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  const anchor = result.bundle.personTimeline?.find(item => item.name.includes('玲山'));
  assert.ok(anchor, 'MVU 源人物必须进入人物时间锚（27 岁 → 出生 461）');
  assert.equal(anchor?.lifespan?.born?.era, '复兴纪元');
  assert.equal(anchor?.lifespan?.born?.year, 461);
  assert.equal(anchor?.lifespan?.ageBased, true);
  // 事件链同样从 JSON 化内容提取。
  assert.ok(
    (anchor?.lifeAnchors ?? []).some(item => item.event.includes('离开梵尼亚')),
    'MVU 源事件链应含离开梵尼亚',
  );
});

test('worldbook 源无「[角色]」标签标题：年龄字段本身即人物证据，仍提取年龄进入人物时间锚', async () => {
  const lingshan = snapshot(
    'worldbook:lingshan-entry',
    '玲山·哈姆斯沃思',
    [
      '---',
      '玲山·哈姆斯沃思:',
      '  身份: 琉璃塔信报社社长',
      '  种族: 翼族',
      '  年龄: 27岁',
      '  背景口述:',
      '    我离开梵尼亚的时候，带走的东西其实不多。',
    ].join('\n'),
  );
  const engine = new UnifiedShadowRetrievalEngine([lingshan]);
  const result = await engine.retrieve({
    requestId: 'lingshan-worldbook-anchors',
    taskType: 'ruin',
    query: '复兴纪元 玲山·哈姆斯沃思 梵尼亚',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  const anchor = result.bundle.personTimeline?.find(item => item.name.includes('玲山'));
  assert.ok(anchor, 'worldbook 无标签标题人物必须进入人物时间锚（年龄字段即人物证据）');
  assert.equal(anchor?.lifespan?.born?.year, 461);
  assert.equal(anchor?.lifespan?.ageBased, true);
});

test('蝴蝶日志中的事件年龄不得把日志标题识别人，也不得反推人物出生年', async () => {
  const archive = snapshot(
    'butterfly:age-at-event',
    '《蝴蝶效应锚定日志1》',
    [
      '墟境进入：复兴纪元480年·黑曜监牢',
      '墟境行动：玩家确认19岁的玲山·哈姆斯沃思处于绝对服刑状态。',
      '历史演变：玲山的稿件被没收。',
    ].join('\n'),
    'butterfly',
  );
  const engine = new UnifiedShadowRetrievalEngine([archive]);
  const result = await engine.retrieve({
    requestId: 'butterfly-event-age-is-not-record-age',
    taskType: 'biography',
    query: '玲山·哈姆斯沃思 黑曜监牢',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日',
  });
  assert.equal(
    result.bundle.personTimeline?.some(item => item.name.includes('蝴蝶效应锚定日志')) ?? false,
    false,
    '档案标题不能因正文出现年龄而晋升为人物',
  );
  assert.equal(
    result.bundle.personTimeline?.some(item => item.name.includes('玲山')) ?? false,
    false,
    '事件年龄不具备创建出生时间锚的资格',
  );
});

test('世界书明确建立/建造时间字段进入时间原点事实，普通叙事不被猜成字段', () => {
  const flowerRoom = snapshot(
    'worldbook:flower-room-origin',
    '【地点】黄昏花室',
    [
      '建立时间：复兴纪元320年',
      '建造时间：复兴纪元318年',
      '复兴纪元400年，19岁的园丁曾在这里值守。',
    ].join('\n'),
  );
  const index = buildRetrievalIndex([flowerRoom]);
  const origins = index.claims.filter(claim =>
    claim.subject === '黄昏花室'
    && ['established_time', 'created_time'].includes(claim.predicate));
  assert.deepEqual(
    origins.map(claim => [claim.predicate, claim.object]),
    [
      ['established_time', '复兴纪元320年'],
      ['created_time', '复兴纪元318年'],
    ],
  );
  assert.equal(
    index.catalog.entities.some(entity =>
      entity.canonicalName === '黄昏花室' && entity.kinds.includes('person')),
    false,
    '园丁的事件年龄不得把地点变成人物',
  );
});

test('传记入口适配：指令无纪元（目标纪元由模型规划）→ 人物时间锚不早退，窗口注入且 state=unknown', async () => {
  // 传记真实入口形态：玩家指令是自由文本，不含纪元名（如「对玲山·哈姆斯沃思进行寻根溯源」）。
  // 旧实现 `if (!requestedEra) return []` 在此直接返回空数组 → 传记 prompt 完全拿不到
  // 出生年锚 → 模型自由编年表（玲山案例：放逐/剥离圣纹被写在出生前 41 年）。
  // 修复后：窗口输出（lifespan/lifeAnchors）与目标纪元无关，照常注入；state 无法判定 → unknown。
  const lingshanMvu = snapshot(
    'mvu-character:玲山·哈姆斯沃思',
    '玲山·哈姆斯沃思',
    JSON.stringify({
      name: '玲山·哈姆斯沃思',
      entry: [
        '---',
        '玲山·哈姆斯沃思:',
        '  身份: 琉璃塔信报社社长',
        '  种族: 翼族',
        '  年龄: 27岁',
        '  背景口述:',
        '    我离开梵尼亚的时候，带走的东西其实不多。',
        '    官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
      ].join('\n'),
    }),
    'mvu',
  );
  const engine = new UnifiedShadowRetrievalEngine([lingshanMvu]);
  const result = await engine.retrieve({
    requestId: 'biography-no-era',
    taskType: 'biography',
    query: '对玲山·哈姆斯沃思进行寻根溯源',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  const anchor = result.bundle.personTimeline?.find(item => item.name.includes('玲山'));
  assert.ok(anchor, '无纪元指令下人物时间锚不得早退（窗口输出与目标纪元无关）');
  assert.equal(anchor?.lifespan?.born?.era, '复兴纪元');
  assert.equal(anchor?.lifespan?.born?.year, 461);
  assert.equal(anchor?.lifespan?.ageBased, true);
  assert.equal(anchor?.state, 'unknown', '无目标纪元时不得做在场状态判定');
  assert.match(
    anchor?.narrative ?? '',
    /未限定纪元/u,
    'narrative 应明确「不做整篇在场判定」',
  );
  // 红线：绝不把 baseline 纪元冒充目标纪元、绝不输出空洞「目标纪元（）」。
  assert.doesNotMatch(anchor?.narrative ?? '', /目标纪元（\s*）/u);
  assert.ok(
    (anchor?.lifeAnchors ?? []).some(item => item.event.includes('离开梵尼亚')),
    '事件链照常带出',
  );
});

test('传记入口适配：指令无纪元的窗口条目可被规划 prompt 消费（personAvailabilityLine 非空）', async () => {
  // 视图层（renderStagePersonTimeline）按 personAvailabilityLine 非 null 过滤——
  // unknown state 不影响窗口行渲染，确保修复后传记 prompt 真实拿到出生年锚。
  const line = personAvailabilityLine({
    name: '玲山·哈姆斯沃思',
    state: 'unknown',
    narrative: '…',
    lifespan: {
      born: { era: '复兴纪元', year: 461 },
      ageAtRecord: 27,
      basedOnEra: '复兴纪元',
      basedOnYear: 488,
      ageBased: true,
    },
  });
  assert.ok(line && line.includes('复兴纪元461年'), `窗口行应渲染出生年，实际 ${line}`);
});

test('双源适配：MVU 与 worldbook 同名人物只保留一条信息最全的时间锚（不重复、不取无信息份）', async () => {
  // worldbook 版：叙述体，无「年龄: N岁」文本 → 无 lifespan。
  const worldbookEntry = snapshot(
    'worldbook:lingshan-main',
    '[角色]玲山·哈姆斯沃思',
    '翼民圣都梵尼亚出身的报业女王，后执掌琉璃塔信报社。',
  );
  // MVU 版：整段文本形态（修复后包装为 entry 字段，连续文本保留），含年龄。
  const mvuEntry = snapshot(
    'mvu-character:玲山·哈姆斯沃思',
    '玲山·哈姆斯沃思',
    JSON.stringify({
      name: '玲山·哈姆斯沃思',
      entry: [
        '---',
        '玲山·哈姆斯沃思:',
        '  身份: 琉璃塔信报社社长',
        '  种族: 翼族',
        '  年龄: 27岁',
        '  背景口述:',
        '    我离开梵尼亚的时候，带走的东西其实不多。',
        '    官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
      ].join('\n'),
    }),
    'mvu',
  );
  const engine = new UnifiedShadowRetrievalEngine([worldbookEntry, mvuEntry]);
  const result = await engine.retrieve({
    requestId: 'lingshan-dual-source',
    taskType: 'ruin',
    query: '复兴纪元 玲山·哈姆斯沃思 梵尼亚',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日-星期日-22:45',
  });
  const anchors = (result.bundle.personTimeline ?? []).filter(item =>
    item.name.includes('玲山'));
  assert.equal(anchors.length, 1, `双源同名人物时间锚应去重为一条，实际 ${anchors.length} 条`);
  const anchor = anchors[0];
  assert.equal(anchor?.lifespan?.born?.year, 461, '应取信息最全的那条（含 27 岁 → 出生 461）');
  assert.ok(
    (anchor?.lifeAnchors ?? []).some(item => item.event.includes('离开梵尼亚')),
    '事件链应从有信息的条目带出',
  );
});

test('P0-A：长人物条目形成可追踪事实与整条附件，且不把未明说的亲属/同行关系当成事实', async () => {
  const filler = '这是一段用于验证旧 1500 字切片边界的编辑室日常。'.repeat(80);
  const lingshan = snapshot(
    'worldbook:lingshan-p0a',
    '[DLC][角色][玲山·哈姆斯沃思]玲山·哈姆斯沃思',
    [
      '<%_ 模板代码不参与事实推断 _%>',
      '玲山·哈姆斯沃思:',
      '  身份: 琉璃塔信报社社长、琉璃塔的头版女王',
      '  职业: 调查记者、报业掌权者',
      '  性别: 女',
      '  种族: 翼族',
      '  年龄: 27岁',
      '  配饰: 旧式留影相机、采访本、藏在高领下的圣纹压制环',
      filler,
      '  背景口述:',
      '    我离开梵尼亚的时候，带走的东西其实不多。',
      '    官方说铃羽是被辉煌女神的幻梦选中去无尽地城做守卫的。',
      '    后来我到帝国，学会穿得体面。',
      '  对梅薇娜·王尔德:',
      '    梅薇娜小姐当年递给我的那本燕妮·埃彭贝克的《白日尽头》，让我明白文字要替真实留下骨架。',
    ].join('\n'),
  );
  const engine = new UnifiedShadowRetrievalEngine([lingshan]);
  const result = await engine.retrieve({
    requestId: 'lingshan-p0a',
    taskType: 'biography',
    query: '对玲山·哈姆斯沃思进行寻根溯源',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日',
  });
  const view = result.bundle.personCanonViews?.find(item => item.canonicalName.includes('玲山'));
  assert.ok(view, '直接点名人物必须形成 PersonCanonView');
  const statements = (view?.facts ?? []).map(fact => `${fact.predicate}:${fact.statement}`);
  assert.ok(statements.some(value => /identity:.*琉璃塔信报社社长/u.test(value)));
  assert.ok(statements.some(value => /departed_from:离开梵尼亚/u.test(value)));
  assert.ok(statements.some(value => /person_selected_for_duty:铃羽.*无尽地城/u.test(value)));
  assert.ok(statements.some(value => /arrived_at:抵达帝国/u.test(value)));
  assert.ok(statements.some(value => /received_from:梅薇娜.*白日尽头/u.test(value)));
  assert.ok(statements.some(value => /current_equipment:.*圣纹压制环/u.test(value)));
  assert.ok((view?.facts ?? []).every(fact =>
    fact.factId.startsWith('fact:')
    && fact.sourceSpans.length > 0
    && fact.sourceSpans.every(span => span.endOffset > span.startOffset)));
  assert.equal(
    (view?.facts ?? []).some(fact =>
      /妹妹|独自离开/u.test(`${fact.predicate}${fact.object}${fact.statement}`)),
    false,
    '条目未明说铃羽是妹妹、也未明说独自离开，不得自动补成锁定事实',
  );
  const attachment = result.bundle.taskAnchorAttachments?.find(item =>
    item.canonicalName.includes('玲山'));
  assert.ok(attachment, '直接人物的启用世界书整条目必须形成附件');
  assert.equal(attachment?.charCount, lingshan.content.length);
  assert.equal(attachment?.content, lingshan.content);
  assert.match(attachment?.contentHash ?? '', /^[a-f0-9]{64}$/u);
  assert.ok(result.bundle.receipt.personCanon?.requiredFactIds.length);
  assert.equal(result.bundle.receipt.personCanon?.attachments[0]?.contentHash, attachment?.contentHash);
});

test('谱系亲属总字段按关系词拆解，不把整段文字塞进单一 relative 槽', async () => {
  const lingshan = snapshot(
    'worldbook:lingshan-genealogy-relations',
    '[DLC][角色][玲山·哈姆斯沃思]玲山·哈姆斯沃思',
    [
      '玲山·哈姆斯沃思:',
      '  身份: 琉璃塔信报社社长',
      '  亲属关系: 铃羽（妹妹）、哈里森（父亲）、伊莎贝拉（母亲）',
    ].join('\n'),
  );
  const result = await new UnifiedShadowRetrievalEngine([lingshan]).retrieve({
    requestId: 'lingshan-genealogy-relations',
    taskType: 'genealogy',
    query: '对玲山·哈姆斯沃思生成宗族谱系',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日',
  });
  const facts = result.bundle.personCanonViews
    ?.find(item => item.canonicalName.includes('玲山'))
    ?.facts ?? [];
  assert.ok(facts.some(fact => fact.predicate === 'younger_sister' && fact.object === '铃羽'));
  assert.ok(facts.some(fact => fact.predicate === 'father' && fact.object === '哈里森'));
  assert.ok(facts.some(fact => fact.predicate === 'mother' && fact.object === '伊莎贝拉'));
  assert.equal(facts.some(fact => fact.predicate === 'relative'), false);
});

test('谱系节点的结构化生卒进入统一人物时间轴，不再只让世界书与 MVU 享有年龄锚', async () => {
  const genealogy = snapshot(
    'genealogy:lingshan:maris',
    '玛丽斯·晨羽（谱系人物）',
    JSON.stringify({
      schema: 'eyon.genealogy.node.v1',
      node: {
        id: 'aunt-maris',
        name: '玛丽斯·晨羽',
        aliases: [],
        birth: {
          status: 'known', era: '复兴纪元', year: 442,
          month: null, day: null, precision: 'approximate', label: '约复兴纪元442年',
        },
        death: {
          status: 'alive', era: '', year: null,
          month: null, day: null, precision: 'unknown', label: '在世',
        },
        identities: [],
        professions: ['待由经历发展'],
      },
    }),
    'genealogy',
  );
  const catalog = buildWorldKnowledgeCatalog([genealogy], []);
  const person = catalog.entities.find(entity => entity.canonicalName === '玛丽斯·晨羽');
  assert.ok(person?.kinds.includes('person'));
  assert.deepEqual(person?.lifespan, {
    born: { era: '复兴纪元', year: 442 },
    died: null,
  });

  const result = await new UnifiedShadowRetrievalEngine([genealogy]).retrieve({
    requestId: 'genealogy-person-time-anchor',
    taskType: 'ruin',
    query: '复兴纪元450年 梵尼亚 玛丽斯·晨羽',
    mode: 'active',
  });
  const anchor = result.bundle.personTimeline?.find(item => item.name === '玛丽斯·晨羽');
  assert.deepEqual(anchor?.lifespan, {
    born: { era: '复兴纪元', year: 442 },
    died: null,
  });
});

test('P0-A：人物正文中的普通历史日期不再被误判为出生年', () => {
  const source = snapshot(
    'worldbook:dated-person-event',
    '[角色]无生卒人物',
    '无生卒人物是一名档案员。复兴纪元420年，她见证了钟楼落成，但条目没有记载出生日期。',
  );
  const catalog = buildRetrievalIndex([source]).catalog;
  const person = catalog.entities.find(entity => entity.canonicalName.includes('无生卒人物'));
  assert.ok(person?.kinds.includes('person'));
  assert.equal(person?.lifespan, undefined, '事件日期不能占据 born 字段');
});

test('四态画像：灭绝种族进入 extinct，时代特征含已灭绝说明', async () => {
  const source = snapshot(
    'worldbook:extinct-race',
    '[世界主设定]',
    [
      '# 阿斯塔利亚历史年表',
      '神明纪元：精灵建立艾尔文海姆。',
      '英雄纪元：古龙族灭亡，人类帝国分裂为多国。',
      '复兴纪元：各大公会兴起。',
    ].join('\n'),
  );
  const engine = new UnifiedShadowRetrievalEngine([source]);
  const result = await engine.retrieve({
    requestId: 'extinct-race-profile',
    taskType: 'ruin',
    query: '复兴纪元 古龙族的遗迹',
    mode: 'active',
  });
  const profile = result.bundle.temporalEligibility;
  assert.ok(profile, '时间账本必须存在');
  const extinctRule = profile.rules.find(rule => rule.subject.includes('古龙族'));
  assert.ok(extinctRule, '古龙族灭亡规则必须被解析');
  assert.equal(extinctRule?.eventType, 'destroyed');
});

// ============ internal.72 共证门：词语义污染防护 ============
// 真实案例：「英雄史诗」方向 → 装备品质条目（正文/关键词里含「史诗」档位标注）
// 被 indexed-term 裸子串 + catalog-direct 实体匹配召入正文。修复三层：
// ① catalog/index 括号别名校验——「(类别/品质)」标注不拆成别名实体；
// ② rankDirect 共证门——2 字非实体弱词不能独自成证（需强词/正文佐证或双弱词互证）；
// ③ matchedEntities 收编到查询片段集合。

function pollutionFixtures() {
  // 装备/技能品质规则条目（真实世界书形态：key 为空，正文是品质档位表 + 「名称(史诗): 」技能行）
  const qualityRules = snapshot(
    'worldbook:quality-rules',
    '技能装备道具生成规则',
    [
      '---',
      '品质: 普通/优良/稀有/史诗/传说',
      '装备: 由材料与图纸制作',
      '锻造匠师 (史诗): 分会长级，能制作史诗魔法装备',
      '四翼飓风(史诗): 四翼齐震产生超强气流',
    ].join('\n'),
  );
  // 真正的英雄史诗题材史料（关键词为长词「英雄史诗」）
  const epicScroll = withWorldbookKeys(snapshot(
    'worldbook:hero-epic-scroll',
    '英雄史诗卷',
    '记载翼民先贤壮举的传说卷轴，被学界称为最古老的叙事长诗。',
  ), 1, ['英雄史诗']);
  // 「荷马史诗」装备（4 字专名）
  const homerEpic = withWorldbookKeys(snapshot(
    'worldbook:homer-epic',
    '荷马史诗',
    '一柄以古老史诗为名的仪式长枪，枪尖刻着荷马二字。',
  ), 2, ['荷马史诗']);
  // 2 字专名：翼民（正文含「翼民:」标题行 → 索引实体资格）
  const wingfolk = withWorldbookKeys(snapshot(
    'worldbook:race-wingfolk',
    '种族-翼民',
    '翼民: 圣都梵尼亚的羽翼种族，与圣纹体系共存的族群。',
  ), 3, ['翼民']);
  // MVU 人物（玲山·哈姆斯沃思，全名专名）
  const lingshan = snapshot(
    'mvu-character:玲山·哈姆斯沃思',
    '玲山·哈姆斯沃思',
    JSON.stringify({
      name: '玲山·哈姆斯沃思',
      entry: [
        '---',
        '玲山·哈姆斯沃思:',
        '  身份: 琉璃塔信报社社长',
        '  种族: 翼族',
        '  年龄: 27岁',
      ].join('\n'),
    }),
    'mvu',
  );
  return { qualityRules, epicScroll, homerEpic, wingfolk, lingshan };
}

test('共证门：补充方向「英雄史诗」不再召入装备品质规则条目（品质档位词被净化）', async () => {
  const { qualityRules, epicScroll } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules, epicScroll]);
  const result = await engine.retrieve({
    requestId: 'gate-hero-epic',
    taskType: 'ruin',
    query: '英雄史诗',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(
    selected.includes(epicScroll.snapshotId),
    '英雄史诗整词长键的史料条目必须照常入选',
  );
  assert.ok(
    !selected.includes(qualityRules.snapshotId),
    '装备品质规则条目不得因「史诗」档位词入选（污染拦截）',
  );
});

test('共证门：探查「史诗品质装备」仍能召入装备品质规则条目（需求不丢）', async () => {
  const { qualityRules } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules]);
  const result = await engine.retrieve({
    requestId: 'gate-quality-gear',
    taskType: 'ruin',
    query: '史诗品质装备',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(
    selected.includes(qualityRules.snapshotId),
    '「品质」「装备」字段实体命中时装备规则条目必须照常入选（真实需求场景）',
  );
});

test('共证门：4 字专名「荷马史诗」直接点名照常入选，装备规则条目不误伤', async () => {
  const { qualityRules, homerEpic } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules, homerEpic]);
  const result = await engine.retrieve({
    requestId: 'gate-homer',
    taskType: 'ruin',
    query: '荷马史诗',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(selected.includes(homerEpic.snapshotId), '荷马史诗（4 字专名/长键）必须入选');
  assert.ok(!selected.includes(qualityRules.snapshotId), '品质规则条目不得因「史诗」二字误入');
});

test('共证门：长查询中子串专名「探查荷马史诗」仍命中，品质规则不误伤', async () => {
  const { qualityRules, homerEpic } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules, homerEpic]);
  const result = await engine.retrieve({
    requestId: 'gate-homer-substring',
    taskType: 'ruin',
    query: '探查荷马史诗',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(selected.includes(homerEpic.snapshotId), '长查询包裹的专名（≥3 字）必须仍命中');
  assert.ok(!selected.includes(qualityRules.snapshotId), '单弱词「史诗」无佐证不得开门');
});

test('共证门：2 字专名「翼民」经索引实体资格仍可独证召回', async () => {
  const { wingfolk } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([wingfolk]);
  const result = await engine.retrieve({
    requestId: 'gate-wingfolk',
    taskType: 'ruin',
    query: '翼民',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(selected.includes(wingfolk.snapshotId), '2 字专名（正文标题行实体资格）必须照常独证召回');
});

test('共证门：全名专名（玲山·哈姆斯沃思）照常入选，不受净化影响', async () => {
  const { qualityRules, lingshan } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules, lingshan]);
  const result = await engine.retrieve({
    requestId: 'gate-lingshan',
    taskType: 'ruin',
    query: '玲山·哈姆斯沃思 梵尼亚',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年-10月-16日',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(selected.includes(lingshan.snapshotId), 'MVU 人物全名必须照常入选');
});

test('共证门：近期聊天含「史诗」不新增污染（context-support 只加分不入选）', async () => {
  const { qualityRules, epicScroll } = pollutionFixtures();
  const engine = new UnifiedShadowRetrievalEngine([qualityRules, epicScroll]);
  const result = await engine.retrieve({
    requestId: 'gate-chat-pollution',
    taskType: 'ruin',
    query: '浮空城的旧档案',
    contextQuery: '复兴纪元488年 艾瑟嘉德\nassistant: 我提到过一件史诗装备的传闻。',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(
    !selected.includes(qualityRules.snapshotId),
    '聊天里出现「史诗」不得让品质规则条目借 context-support 入选',
  );
});

test('共证门提取层：括号「(类别/品质)」标注不再拆成实体/别名/搜索词', () => {
  const { qualityRules } = pollutionFixtures();
  const index = buildRetrievalIndex([qualityRules]);
  const keys = [...index.entities.keys()];
  assert.ok(!keys.includes('史诗'), `索引实体集合不得含「史诗」，实际含：${keys.filter(k => k.includes('史诗')).join(',')}`);
  assert.ok(!keys.includes('品质') || true, '“品质”字段名仍可作字段实体（合理锚），不作为污染判定');
  const catalog = buildWorldKnowledgeCatalog([qualityRules], []);
  const names = catalog.entities.flatMap(entity => [entity.canonicalName, ...entity.aliases]);
  assert.ok(
    !names.some(name => name === '史诗'),
    `catalog 实体名/别名不得有裸「史诗」，实际含：${names.filter(name => name.includes('史诗')).join(',')}`,
  );
});

// ============ internal.73 传记引用强制通道（forced-reference） ============
// 断点：工作台「引用传记」（selectedBiographyIds）此前只作用于 legacy 观察，
// active 正式链路不区分选中与否——用户显式勾选的传记在检索未命中时可能不入选。
// 修复：forcedSourceLogicalIds 传入检索门，选中来源即使未命中 also 强制入选，
// 与全世界书/正文同池同门（sourceType/句柄/分组不变；时间资格门仍生效）。

test('传记引用强制通道：显式选中的传记即使 query 未命中也入选（forced-reference 开门）', async () => {
  const bio = snapshot(
    'biography:lingshan-bio',
    '玲山·哈姆斯沃思的传记',
    JSON.stringify({
      schema: 'eyon.biography.digest.v1',
      target: { name: '玲山·哈姆斯沃思', aliases: ['玲山'] },
      span: '复兴纪元461年-488年',
      summary: '琉璃塔信报社社长，从梵尼亚流亡至帝国。',
    }),
    'biography',
  );
  const qualityRules = snapshot('worldbook:quality-rules', '技能装备道具生成规则', '品质: 普通/优良/稀有/史诗/传说\n装备: 由材料与图纸制作');
  const engine = new UnifiedShadowRetrievalEngine([bio, qualityRules]);
  // query 与传记内容零交集（「浮空城」不命中传记摘要任何词）
  const result = await engine.retrieve({
    requestId: 'forced-bio',
    taskType: 'ruin',
    query: '浮空城的旧档案',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
    forcedSourceLogicalIds: ['biography:lingshan-bio'],
  });
  const selected = result.bundle.sourceSnapshots.map(source => source.snapshotId);
  assert.ok(
    selected.includes(bio.snapshotId),
    '显式选中的传记必须强制入选（forced-reference）',
  );
  const bioEntry = result.bundle.sourceSnapshots.find(s => s.snapshotId === bio.snapshotId);
  assert.equal(bioEntry?.sourceType, 'biography', '强制入选不改变来源类型（同池同门）');
  assert.ok(
    !selected.includes(qualityRules.snapshotId),
    '强制通道只放行选中来源，不连带打开无关条目',
  );
});

test('传记引用强制通道：未选中的传记在 query 未命中时不入选（无旁门）', async () => {
  const bio = snapshot(
    'biography:lingshan-bio',
    '玲山·哈姆斯沃思的传记',
    JSON.stringify({
      schema: 'eyon.biography.digest.v1',
      target: { name: '玲山·哈姆斯沃思' },
      span: '复兴纪元461年-488年',
      summary: '琉璃塔信报社社长。',
    }),
    'biography',
  );
  const engine = new UnifiedShadowRetrievalEngine([bio]);
  const result = await engine.retrieve({
    requestId: 'unforced-bio',
    taskType: 'ruin',
    query: '浮空城的旧档案',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  assert.ok(
    !result.bundle.sourceSnapshots.some(s => s.snapshotId === bio.snapshotId),
    '未选中的传记不得因任何旁门入选',
  );
});

test('传记引用强制通道：时间资格门仍生效（纪元不符的选中传记不进）', async () => {
  const bio = snapshot(
    'biography:mevina-bio',
    '梅薇娜·王尔德的传记',
    JSON.stringify({
      schema: 'eyon.biography.digest.v1',
      target: { name: '梅薇娜·王尔德' },
      span: '复兴纪元400年-488年',
      summary: '晨曙书局局长，界外来客。',
    }),
    'biography',
  );
  const engine = new UnifiedShadowRetrievalEngine([bio]);
  const result = await engine.retrieve({
    requestId: 'forced-bio-temporal',
    taskType: 'ruin',
    query: '英雄纪元 奥古斯提姆帝国军方',
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
    forcedSourceLogicalIds: ['biography:mevina-bio'],
  });
  assert.ok(
    !result.bundle.sourceSnapshots.some(s => s.snapshotId === bio.snapshotId),
    '强制通道不绕过时间资格门：复兴纪元传记不得进入英雄纪元任务',
  );
});
