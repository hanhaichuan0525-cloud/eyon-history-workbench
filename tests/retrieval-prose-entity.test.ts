import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldbookSourceSnapshot, worldbookLogicalId } from '../src/retrieval/sourceSnapshot.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { extractRecordedAge } from '../src/retrieval/catalog.ts';
import { extractEraNames, extractTemporalScopes, parseWorldTime } from '../src/retrieval/temporal.ts';
import { templateIndependentText } from '../src/retrieval/sourceOwnership.ts';
import { buildGenealogyApiPrompt } from '../src/prompts/genealogy.ts';
import { buildRuinOutlineBatchApiPrompt } from '../src/prompts/ruin.ts';
import type { GenealogyContextBundle, RuinContextBundle } from '../src/core/context.ts';

async function source(uid: number, title: string, content: string, keys: string[] = []) {
  const logicalId = worldbookLogicalId('fixture', uid);
  return createWorldbookSourceSnapshot({ sourceId: logicalId, title, content, keywords: keys, strategyType: 'selective',
    worldbook: { schema: 'eyon.retrieval.worldbook-metadata.v1', logicalId, worldbookName: 'fixture', uid,
      bindingScopes: ['character-primary'], enabled: true,
      strategy: { type: 'selective', primaryKeys: keys, secondary: { logic: 'and_any', keys: [] }, scanDepth: 4 },
      position: { type: 'before_character_definition', role: 'system', depth: 0, order: 100 }, probability: 100,
      recursion: { preventIncoming: false, preventOutgoing: false, delayUntil: null },
      effect: { sticky: null, cooldown: null, delay: null }, extra: {} } });
}

test('栏目、数字和EJS字符串不是实体；原文与可定位的专名仍保留', async () => {
  const s = await source(1, '[角色]晴芽·灰林', '<% const profile = { "content": "\\n目前允许某人正常: 条件说明" }; %>\n'
    + '姓名: 晴芽·灰林\n个人物品: 书册\n过往: 曾经旅行\n10: 出版编号\nback_story: narrative\n'
    + '晴芽·灰林: 她是旅人。\n旅途与幸运的女神・岚珂: 一位守护者。');
  const index = buildRetrievalIndex([s]);
  for (const name of ['个人物品', '过往', '10', 'back_story', '灰林', '\\n目前允许某人正常']) {
    assert.ok(!index.catalog.entities.some(e => e.canonicalName === name), name);
    assert.ok(!index.entities.has(name), `强检索词不应包含${name}`);
  }
  assert.ok(index.catalog.entities.some(e => e.canonicalName === '晴芽·灰林'));
  assert.ok(index.catalog.entities.some(e => e.canonicalName === '岚珂' && e.kinds.includes('person')));
  assert.equal(index.sources[0]!.snapshot.content, s.content);
});

test('正文与触发键共证的中文简称、旧身份可读取完整人物和补充', async () => {
  const main = await source(2, '[角色][海澜晴芽]海澜晴芽', '<海澜晴芽 角色详情>\n姓名: 海澜晴芽\n'
    + '身份: 夜潮龙姬，前清泉龙姬\n背景: 晴芽曾守护旧港。\n' + '其他记录。'.repeat(1800) + '\n主档末尾');
  main.metadata.strategy.primaryKeys = ['晴芽', '海澜', '夜潮龙姬', '学生'];
  const supplement = await source(3, '[角色][海澜晴芽]旅行习惯', '<海澜晴芽 角色详情>\n晴芽总是记录航路。');
  const engine = new UnifiedShadowRetrievalEngine([main, supplement]);
  for (const name of ['海澜晴芽', '晴芽', '清泉龙姬']) {
    const { bundle } = await engine.retrieve({ requestId: name, taskType: 'ruin', mode: 'active', query: `英雄纪元\n${name}的过往` });
    for (const s of [main, supplement]) assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === s.content), name);
  }
  assert.ok(!buildRetrievalIndex([main]).catalog.entities.some(e => e.aliases.includes('学生')));
});

test('事件标签与英文档案不阻止识别人物，未标纪元不拒绝原文', async () => {
  const s = await source(4, '[DLC][事件][远征]【远征】艾泊_info', '<艾泊_info>\nname: 艾泊·莉薇亚·乌弗瑞克 (Epol Lyvia Ufric)\n'
    + 'title: 群山末裔\nbase_info:\n  race: 矮人\n  identity: 王族后裔\nback_story: 曾经率领远征。', ['艾泊', '远征']);
  const index = buildRetrievalIndex([s]);
  assert.ok(index.catalog.entities.some(e => e.canonicalName === '艾泊·莉薇亚·乌弗瑞克' && e.kinds.includes('person')));
  const { bundle } = await new UnifiedShadowRetrievalEngine([s]).retrieve({ requestId: 'event', taskType: 'ruin', mode: 'active', query: '复兴纪元\n艾泊的发家史' });
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === s.content));
});

test('事件名可跟读该事件人物档案，不强迫所有人物在场', async () => {
  const event = await source(5, '[DLC][事件][双星远征]双星远征-本体', '双星远征:\n故事发生在一座孤岛。', ['双星远征']);
  const person = await source(6, '[DLC][事件][双星远征]Serra_info', '<Serra_info>\n塞菈:\n  基本信息:\n    种族: 未知\n    年龄: 外貌20岁 (实际未知)\n    称号: 花园主人', ['当前事件为双星远征']);
  const { bundle } = await new UnifiedShadowRetrievalEngine([event, person]).retrieve({ requestId: 'group', taskType: 'ruin', mode: 'active', query: '英雄纪元\n双星远征相关墟境' });
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.snapshotId === person.snapshotId));
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '塞菈' && e.disposition === 'required'));
});

test('具体亲属是事件主体，人物档案主人只作参考，不共用其出生年', async () => {
  const s = await source(7, '[角色]薇拉·阿什谷', '姓名: 薇拉·阿什谷\n生日: 复兴纪元470年1月1日\n'
    + '家庭:\n  父亲 · 加尔文·阿什谷: 退役军官，继承农场。\n  母亲 · 艾莲·阿什谷: 管理庄务。');
  const index = buildRetrievalIndex([s]);
  assert.ok(index.catalog.entities.some(e => e.canonicalName === '加尔文·阿什谷' && e.kinds.includes('person') && !e.lifespan?.born));
  const { bundle } = await new UnifiedShadowRetrievalEngine([s]).retrieve({ requestId: 'relative', taskType: 'ruin', mode: 'active', query: '复兴纪元\n薇拉父亲的发家史' });
  assert.ok(bundle.castManifest?.entries.some(e => e.identity.canonicalName === '加尔文·阿什谷' && e.disposition === 'required'));
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '薇拉·阿什谷' && e.disposition === 'required'));
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '艾莲·阿什谷'));
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === s.content));
  const selected = await new UnifiedShadowRetrievalEngine([s]).retrieve({ requestId: 'selected-parent', taskType: 'ruin',
    query: '复兴纪元\n薇拉·阿什谷\n薇拉父亲的发家史', focusEntityNames: ['薇拉·阿什谷'],
    castRequirementQuery: '薇拉父亲的发家史' });
  assert.ok(selected.bundle.castManifest?.entries.some(e => e.identity.canonicalName === '加尔文·阿什谷' && e.disposition === 'required'));
  assert.ok(!selected.bundle.castManifest?.entries.some(e => e.identity.canonicalName === '薇拉·阿什谷' && e.disposition === 'required'));
});

test('外表年龄不是实龄，明确字段中的纯数字和中文年龄可识别', () => {
  assert.equal(extractRecordedAge('外表8岁'), undefined);
  assert.equal(extractRecordedAge('14'), 14);
  assert.equal(extractRecordedAge('二十四岁'), 24);
  assert.equal(extractRecordedAge('外表8岁，实际124岁'), 124);
  assert.equal(extractRecordedAge('外貌八岁，实际二十四岁'), 24);
  for (const text of ['二十至三十岁', '二十或三十岁', '数十岁', '外表十四岁']) assert.equal(extractRecordedAge(text), undefined, text);
});

test('模板遮罩不改变证据偏移，也不执行宏或把条件支线当作硬事实', async () => {
  const text = '<% const note = "幽影客: 已死亡"; %>\r\n<% if (future) { %>\r\n旧名: 幽影客\r\n<% } %>\r\n'
    + '姓名: 晴芽·灰林\r\n{{setvar::name::幻影}}\r\n父亲 · 海珀·灰林: 船长。';
  const literal = templateIndependentText(text);
  assert.equal(literal.length, text.length);
  assert.ok(!literal.includes('幽影客') && !literal.includes('幻影'));
  const s = await source(8, '[角色]晴芽·灰林', text);
  const parent = buildRetrievalIndex([s]).catalog.entities.find(e => e.canonicalName === '海珀·灰林');
  assert.ok(parent && parent.spans.some(span => span.startOffset === text.indexOf('父亲')));
  assert.ok(!buildRetrievalIndex([s]).catalog.entities.some(e => e.aliases.includes('幽影客')));
});

test('普通身份/共同触发词不是人名，父亲未具名时不会强迫女儿代替父亲出场', async () => {
  const s = await source(9, '[角色]晴芽·灰林(作者乙-推荐雾铃)', '姓名: 晴芽·灰林\n身份: 学生，旅行者\n背景: 父亲曾经旅行。', ['学生', '灰林']);
  const engine = new UnifiedShadowRetrievalEngine([s]);
  const { bundle } = await engine.retrieve({ requestId: 'unknown-relative', taskType: 'ruin', query: '复兴纪元\n晴芽父亲的发家史' });
  assert.ok(!bundle.castManifest?.entries.some(e => e.disposition === 'required'));
  const entity = buildRetrievalIndex([s]).catalog.entities.find(e => e.canonicalName === '晴芽·灰林')!;
  for (const name of ['学生', '旅行者', '灰林', '作者乙', '雾铃']) assert.ok(!entity.aliases.includes(name));
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === s.content));
});

test('纪元剥离叙事前缀，精确年与自定义纪元保留；模糊时期仍 unknown', async () => {
  assert.deepEqual(extractEraNames('数百年的混乱纪元之后，到复兴纪元前230年'), ['混乱纪元', '复兴纪元']);
  assert.deepEqual(extractTemporalScopes('数百年的混乱纪元之后，在霜轮纪元31年'), ['混乱纪元', '霜轮纪元31年']);
  assert.deepEqual(extractTemporalScopes('复兴纪元前230年'), ['复兴纪元前230年']);
  assert.deepEqual(extractEraNames('新复兴纪元'), ['新复兴纪元']);
  for (const time of ['远古时期', '第二次位面入侵期间', '战争末期']) assert.deepEqual(parseWorldTime(time), { era: null, year: null });
  const s = await source(10, '[事件][孤岛远征]孤岛远征', '孤岛远征发生在远古时期，战争末期才离开。');
  const { bundle } = await new UnifiedShadowRetrievalEngine([s]).retrieve({ requestId: 'vague-time', taskType: 'ruin', query: '英雄纪元\n孤岛远征相关墟境' });
  assert.ok(bundle.sourceSnapshots.some(item => item.snapshotId === s.snapshotId));
  assert.ok(bundle.qualifiedEvidence?.passages.some(p => p.temporal.fit === 'unknown'));
});

test('中文姓氏出现在其他人的姓名中，不因此成为本人的简称', async () => {
  const s = await source(11, '[角色]海澜晴芽', '姓名: 海澜晴芽\n背景: 晴芽曾旅行，她的朋友是海澜秋枝。', ['晴芽', '海澜']);
  const entity = buildRetrievalIndex([s]).catalog.entities.find(e => e.canonicalName === '海澜晴芽')!;
  assert.ok(entity.aliases.includes('晴芽'));
  assert.ok(!entity.aliases.includes('海澜'));
});

test('无机器事实的长档案仍按别名投递谱系；墟境亲属档案完整且去重', async () => {
  const s = await source(12, '[角色][海澜晴芽]海澜晴芽', '<海澜晴芽 角色详情>\n姓名: 海澜晴芽\n背景: 晴芽曾旅行。\n'
    + '<% if (future) { %>年龄: 未知<% } %>\n' + '往事。'.repeat(5000)
    + '\n家庭:\n父亲 · 海珀·灰林: 船长。\n档案尾部。', ['晴芽']);
  const engine = new UnifiedShadowRetrievalEngine([s]);
  const shared = { schema: 'eyon.context.v1' as const, requestId: 'prose-prompt',
    scope: { characterKey: 'fixture', chatId: 'fixture', triggerMessageId: 1 },
    currentWorld: { time: '复兴纪元488年', location: '旧港' },
    worldbookContext: [], recentContext: [], characterContext: [], sourceIndex: [], biographyRefs: [], warnings: [], sourceHash: 'fixture' };
  const genealogy = await engine.retrieve({ requestId: shared.requestId, taskType: 'genealogy', query: '晴芽的谱系' });
  assert.equal(genealogy.bundle.personCanonViews?.length ?? 0, 0);
  const context: GenealogyContextBundle = { ...shared, taskType: 'genealogy', evidenceBundle: genealogy.bundle };
  const prompt = buildGenealogyApiPrompt({ requestId: shared.requestId, directive: '晴芽的谱系', context,
    generationInput: { focusCharacter: { mvuId: '晴芽', name: '晴芽', aliases: [] }, depth: { ancestors: 2, descendants: 0, maxPerGeneration: 4 } },
    rules: { generationContract: '' } });
  assert.ok(prompt.includes(s.content));
  const ruin = await engine.retrieve({ requestId: shared.requestId, taskType: 'ruin', query: '复兴纪元\n晴芽父亲的发家史' });
  const ruinContext: RuinContextBundle = { ...shared, taskType: 'ruin', evidenceBundle: ruin.bundle, genealogyRefs: [], butterflyRefs: [] };
  const ruinPrompt = buildRuinOutlineBatchApiPrompt({ requestId: shared.requestId, directive: '晴芽父亲的发家史', context: ruinContext,
    generationInput: { era: '复兴纪元', location: '旧港', start: null, end: null, supplementaryDirection: '晴芽父亲的发家史',
      selectedCharacters: [], autoGenealogy: false, wave: { level: 'stable', candidateCount: 3 },
      materials: Array.from({ length: 3 }, (_, i) => ({ candidateKey: `candidate-${i + 1}`, periodType: 'transition', background: '旧港', conflict: '', trigger: '' })) },
    rules: { generationContract: '' } });
  const full = ruinPrompt.split('<CHARACTER_CARDS_FULL>')[1]?.split('</CHARACTER_CARDS_FULL>')[0] ?? '';
  assert.equal(full.split(s.content).length - 1, 1);
});
