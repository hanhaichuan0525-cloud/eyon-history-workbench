import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSourcePurpose, hasIndependentFacts, isPureUpdateProtocol } from '../src/retrieval/sourcePurpose.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { mayUseBiographySource } from '../src/runtime/biographySourcePurpose.ts';

const output = { title: '[变量][mvu_update]变量输出规则', content:
  'variables_update_format:\nrule: You MUST output update commands\n<UpdateVariable><JSONPatch>${new_value}</JSONPatch></UpdateVariable>' };
const events = { title: '[称号扩展]称号随机事件变量更新规则', content:
  '<%_ { _%>\n<当前称号随机事件变量>\n历史事件: <%- JSON.stringify(state.历史事件) %>\n</当前称号随机事件变量>\n称号随机事件变量更新规则:\n  历史事件:\n    check: 当前事件结束后写入摘要\n<%_ } _%>' };
const tasks = { title: '[额外设定]任务与委托规则', content:
  '<任务与委托规则>\n触发机制: 仅查看任务板时生成\n输出格式:\n<task_info>\n详情: [背景与动因]\n奖励: [奖励列表]\n</task_info>\n</任务与委托规则>' };
const gear = { title: '[额外设定]技能装备道具生成规则', content:
  '# 装备生成格式\n品质: 唯一/普通/史诗\n标签: [徽记: XXX]\n定义: 已登记材料可加徽记\n作用: 有徽记可在正规市场流通\n无徽记: 可能被查扣' };
const decision = (record: { title: string; content: string }, query = '天壁留下笔记之后的历史', explicitlySelected = false) =>
  assessSourcePurpose({ ...record, sourceType: 'worldbook' }, { taskType: 'butterfly', query, explicitlySelected });

test('变量输出与EJS动态历史字段不会靠闭合标签伪装成历史事实', () => {
  for (const record of [output, events]) {
    assert.equal(hasIndependentFacts(record.content), false, record.title);
    assert.equal(isPureUpdateProtocol(record), true, record.title);
    assert.equal(decision(record).use, 'not-used');
    assert.equal(mayUseBiographySource({ ...record, sourceType: 'worldbook' }, '天壁'), false);
    assert.equal(decision(record, '研究' + record.title).use, 'mechanism');
  }
});

test('高置信任务输出模板隔离；明确研究模板或生成委托时仍可读机制', () => {
  assert.equal(decision(tasks).use, 'not-used');
  assert.equal(decision(tasks, '了解任务与委托规则').use, 'mechanism');
  assert.equal(decision(tasks, '生成公会委托并计算任务奖励').use, 'mechanism');
  assert.equal(decision(tasks, '天壁', true).use, 'mechanism');
  assert.equal(decision(tasks, '我留下笔记\n任务: {}\n奖励: {}').use, 'not-used', '状态字段不等于请求生成任务');
});

test('装备格式含流通机制保留，不误认成历史事件也不整条删掉', () => {
  assert.equal(decision(gear).use, 'mechanism');
  for (const content of [
    events.content + '\n世界设定: 冬灯村的称号源于救火互助。',
    'variables_update_format:\n历史事件: |\n  雨禾在复兴纪元478年救下村民。\n</记录>',
    'JSONPatch\n历史事件:\n  - 雨禾在旧港第一次见到养母。',
    '<% const profile = { name: "雨禾", back_story: "八岁时姐姐去世" }; %>',
    'JSONPatch\n雨禾曾在旧港求学，后来成为织工。',
    'JSONPatch\n背景故事: <经历>雨禾在旧港照料花圃。</经历>',
    'JSONPatch\n<% if (alternate) { %>\n背景故事: 雨禾在另一个分支救下村民。\n<% } %>',
  ]) {
    assert.equal(hasIndependentFacts(content), true);
    assert.notEqual(decision({ ...output, content }).use, 'not-used');
  }
  for (const content of ['历史事件:\n</记录>', '历史事件:\n```\n</记录>',
    '背景故事:\n下个字段: string\nJSONPatch', '历史事件: []']) assert.equal(hasIndependentFacts(content), false, content);
});

test('四模块相同门限，排除只影响用途，不改候选语料回执和混合原文', async () => {
  const mixed = { title: '变量输出规则补充人物', content: output.content + '\n世界设定: 天壁村的居民用羽币交易。\n' + '真实习俗。'.repeat(2200) + '\n末尾史实必须保留。' };
  const records = [output, events, tasks, gear, mixed];
  const snapshots = await Promise.all(records.map((r, i) => createSourceSnapshot({
    logicalId: `worldbook:applicability:${i}`, sourceType: 'worldbook', ...r, metadata: {},
  })));
  for (const taskType of ['ruin', 'butterfly', 'biography', 'genealogy'] as const) {
    const { bundle } = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({
      requestId: taskType, taskType, query: '天壁 羽币 装备 徽记 冬灯村 历史事件', mode: 'active',
      forcedSourceLogicalIds: ['worldbook:applicability:3', 'worldbook:applicability:4'],
    });
    for (const i of [0, 1, 2]) assert.ok(!bundle.sourceSnapshots.some(s => s.logicalId.endsWith(':' + i)));
    assert.equal(bundle.receipt.candidateSnapshotIds.length, snapshots.length);
    assert.equal(bundle.sourceSnapshots.find(s => s.logicalId.endsWith(':4'))?.content, mixed.content);
    assert.ok(bundle.sourceSnapshots.some(s => s.logicalId.endsWith(':3')));
  }
});
