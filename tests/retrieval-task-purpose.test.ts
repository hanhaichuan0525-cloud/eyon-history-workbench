import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { assessSourcePurpose } from '../src/retrieval/sourcePurpose.ts';
import { mayUseBiographySource } from '../src/runtime/biographySourcePurpose.ts';

const records = [
  ['[变量][mvu_update]变量更新规则', 'variables_update_rules:\n背景故事: string\n  check: 随孤悬天壁事件更新\nJSONPatch'],
  ['[扩展]书号出版规则', '<书号出版规则>\n名称: ASBN，阿斯塔利亚标准书号\n用途: 登记正式出版物\n基本格式: ASBN-年份-地区-机构\n地区代码:\n  07: 卡拉什利亚斯\n机构代码:\n  CD: 晨曙书局\n生成规则: 正式出版物必须生成ASBN\n</书号出版规则>'],
  ['[扩展]文字创作物成品规则', '核心指令: 展示出版物成品时输出Raw Text\n强制输出格式:\n[WritingBook:PublishedBook]\nTitle:: ${标题}\n[/WritingBook]'],
  ['[角色]溪禾', '<溪禾 角色详情>\n姓名: 溪禾\n种族: 人类\n背景故事: 溪禾八岁时姐姐去世。\nvariables_update_rules:\nJSONPatch\n' + '真实经历。'.repeat(5000) + '\n最后的姐姐年龄锚必须保留。\n</溪禾 角色详情>'],
  ['[世界]生命规则', '世界设定: 构装生命可由制作者制造，也可依法复活；创造者不是血缘父母。'],
  ['[地点]虚海乱流', '虚海乱流的捕雾船使用通用羽币交易。'],
  ['[模板]噪音样例', '<% const sample = "古铜飞鸟在玻璃峡湾的船坞出场"; %>'],
  ['[模板]条件样例', '<% if (future) { %>暗潮巡游团在玻璃峡湾的船坞出场。<% } %>'],
  ['[角色]澜禾', '<%_ { const profile = { "name": "澜禾", "back_story": "澜禾十二岁时经历月牙湖海难" }; } _%>'],
  ['[事件]骸响龙姬', '远古时期，艾莉希雅和奥希莉雅曾参与骸响龙姬之战。'],
  ['[装备]技能装备道具生成规则', '装备生成格式: 名称与效果\n世界设定: 正规市场中，有徽记的装备属于认证物品；无徽记可能被查扣。'],
];
async function retrieve(taskType: 'ruin' | 'biography' | 'genealogy' | 'butterfly', query: string,
  options: { forced?: number[]; reverse?: boolean } = {}) {
  const snapshots = await Promise.all(records.map(([title, content], i) => createSourceSnapshot({
    logicalId: `worldbook:purpose:${i}`, sourceType: 'worldbook', title: title!, content: content!, metadata: {},
  })));
  const { bundle } = await new UnifiedShadowRetrievalEngine(options.reverse ? [...snapshots].reverse() : snapshots)
    .retrieve({ requestId: query, taskType, query, mode: 'active',
      forcedSourceLogicalIds: options.forced?.map(i => `worldbook:purpose:${i}`) });
  return { bundle, snapshots, ids: bundle.sourceSnapshots.map(s => s.logicalId) };
}

test('四模块共享用途门：纯变量协议和无关出版/格式模板不因地点命中进入史料', async () => {
  for (const task of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
    const { ids, bundle } = await retrieve(task, '创世纪元 卡拉什利亚斯 孤悬天壁的经历');
    for (const i of [0, 1, 2]) assert.ok(!ids.includes(`worldbook:purpose:${i}`), `${task}:${i}`);
    assert.equal(bundle.receipt.candidateSnapshotIds.length, records.length, '用途门不伪造已开启语料覆盖');
    assert.ok(bundle.receipt.rejected.some(r => /task-purpose/u.test(r.reason)));
    assert.equal(bundle.semanticEvidence, undefined);
  }
});

test('同一出版资料的用途随任务改变；实际出版和明确引用可完整读取', async () => {
  for (const task of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
    for (const query of ['卡拉什利亚斯 晨曙书局 出版史', 'ASBN 书号 登记的历史']) {
      const { bundle, ids } = await retrieve(task, query);
      assert.ok(ids.includes('worldbook:purpose:1'), query);
      assert.equal(bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:purpose:1')?.content, records[1]![1]);
    }
  }
  const { ids } = await retrieve('ruin', '卡拉什利亚斯', { forced: [1] });
  assert.ok(ids.includes('worldbook:purpose:1'));
});

test('正文格式不是出版史，但玩家明确研究该格式时仍可读取机制原文', async () => {
  const { ids } = await retrieve('biography', '文字创作物成品规则的输出格式');
  assert.ok(ids.includes('worldbook:purpose:2'));
  assert.ok(!(await retrieve('biography', '晨曙书局出版史')).ids.includes('worldbook:purpose:2'));
});

test('混合资料从宽：长人物档案、末尾年龄锚与协议逐字保留', async () => {
  for (const task of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
    const { bundle } = await retrieve(task, '复兴纪元 溪禾八岁时姐姐的经历');
    const source = bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:purpose:3');
    assert.equal(source?.content, records[3]![1]);
    assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === records[3]![1]));
    assert.ok(bundle.passages.some(p => p.content === records[3]![1]));
    assert.ok(bundle.castManifest?.entries.some(e => e.identity.canonicalName === '溪禾'));
  }
});

test('生命、装备、通用货币、模糊时期和事件藏人不会被格式/时代筛选误伤', async () => {
  for (const [task, query, id] of [
    ['genealogy', '构装生命的制作者与复活', 4], ['ruin', '虚海乱流捕雾船的通用羽币', 5],
    ['ruin', '英雄纪元 骸响龙姬 艾莉希雅和奥希莉雅', 9], ['butterfly', '正规市场 装备 徽记的影响', 10],
  ] as const) assert.ok((await retrieve(task, query)).ids.includes(`worldbook:purpose:${id}`), query);
});

test('EJS代码样例和未确认条件不能独立召回；静态人物档案仍原样保留', async () => {
  for (const query of ['古铜飞鸟在玻璃峡湾的船坞', '暗潮巡游团在玻璃峡湾的船坞']) {
    const { ids } = await retrieve('ruin', query);
    assert.ok(!ids.includes('worldbook:purpose:6'), query);
    assert.ok(!ids.includes('worldbook:purpose:7'), query);
  }
  const { bundle } = await retrieve('ruin', '澜禾的月牙湖海难');
  assert.equal(bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:purpose:8')?.content, records[8]![1]);
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.content === records[8]![1]));
});

test('顺序变化与新风格措辞不改变已确认人物来源', async () => {
  const one = await retrieve('ruin', '溪禾的经历');
  const two = await retrieve('ruin', '溪禾的经历，逐步揭示，舒缓描写', { reverse: true });
  assert.ok(one.ids.includes('worldbook:purpose:3') && two.ids.includes('worldbook:purpose:3'));
});

test('筛选辅助读取失败局部从宽，不抛错、不生成摘要或强制格式', () => {
  const source = { sourceType: 'worldbook' as const, title: '未知写法',
    get content(): string { throw new Error('local purpose unavailable'); } };
  assert.deepEqual(assessSourcePurpose(source, { taskType: 'ruin', query: '未知写法' }),
    { use: 'uncertain', reason: 'local-purpose-check-unavailable' });
});

test('传记预筛同样保护带协议的真实档案，纯协议不会因英文写法漏过', () => {
  assert.equal(mayUseBiographySource({ sourceType: 'worldbook', title: '[变量更新规则]溪禾补充',
    content: records[3]![1]! }, '溪禾的经历'), true);
  assert.equal(mayUseBiographySource({ sourceType: 'worldbook', title: records[0]![0]!,
    content: records[0]![1]! }, '孤悬天壁'), false);
  for (const content of ['<variables_update_rules>\n笔记:\n type: string\n check: 随人物事件更新\n</variables_update_rules>',
    'variables_update_rules:\nJSONPatch\n背景故事: (溪禾八岁时姐姐去世，后来独自远行。)',
    'JSONPatch\n溪禾曾在旧港求学，后来成为村里的织工。']) {
    const source = { sourceType: 'worldbook' as const, title: '变量更新规则', content };
    const decision = assessSourcePurpose(source, { taskType: 'biography', query: '溪禾' });
    assert.equal(decision.use, content.startsWith('<') ? 'not-used' : 'uncertain');
  }
});
