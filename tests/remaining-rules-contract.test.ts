import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { createBiographyStagePlanFromRules } from '../src/runtime/biographyDiceCore.ts';

const rulesDir = new URL('../rules/', import.meta.url);
function rule(prefix: string): string {
  const names = readdirSync(rulesDir).filter(name => name.startsWith(prefix + '_'));
  assert.equal(names.length, 1);
  return readFileSync(new URL(names[0], rulesDir), 'utf8');
}

test('开发校验契约区分新生成四节点和旧存档兼容，退役字段不再必填', () => {
  const text = rule('05');
  assert.match(text, /生成固定四个/u);
  assert.match(text, /存储schema保留4至8节点以兼容旧存档/u);
  assert.match(text, /transitionFromPrevious\/threadSummary已退役/u);
  assert.doesNotMatch(text, /相邻时期拥有完整过渡字段/u);
  assert.match(text, /false不触发文学评分拒收/u);
  assert.match(rule('06'), /二者可以相同/u);
  assert.doesNotMatch(rule('06'), /二者必须不同/u);
});

test('检索开发契约区分MVU楼层和聊天存储，不再额外截取原文', () => {
  const text = rule('03');
  assert.match(text, /Mvu\.getMvuData\(\{type:"message",message_id:-1\}\)/u);
  assert.match(text, /聊天级工作台存储另用/u);
  assert.match(text, /selectedPassages/u);
  assert.doesNotMatch(text, /最多3个重点阶段|每个新时期最多2个/u);
  assert.match(text, /不再次硬切字符/u);
});

test('谱系规则保留家庭与特殊源流，未知日期和原创来源不提升为正史', () => {
  const text = rule('09');
  for (const kind of ['构装体', '穿越', '夺舍', '原身份家族', '父系、母系']) assert.ok(text.includes(kind));
  assert.match(text, /普通人物也允许“生年不详”/u);
  assert.doesNotMatch(text, /不得留下“生年不详”|关系事实来源/u);
  assert.match(text, /原创人物、亲缘与约年保留低权性质/u);
  const ui = rule('10');
  assert.match(ui, /身份补充输入默认展开/u);
  assert.match(ui, /清空此人物谱系/u);
  assert.match(ui, /"source": "genealogy"/u);
  assert.doesNotMatch(ui, /帮助三骰素材/u);
});

test('传记交接说明使用自有临时注入，重roll复用已有作品而不是重新规划', () => {
  const text = rule('14');
  assert.match(text, /setExtensionPrompt/u);
  assert.match(text, /清除自己的注入键/u);
  assert.match(text, /复用已准备或已提交的传记及原requestId/u);
  assert.doesNotMatch(text, /重roll生成新.*requestId/u);
  assert.match(text, /权威数据来自已校验JSON/u);
});

test('骰表保留现行传记解析数据，墟境和蝴蝶仅旧数据兼容', () => {
  const text = rule('08');
  assert.match(text, /本轮不退役传记骰表/u);
  assert.match(text, /table_5至table_6仅保留旧数据/u);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let index = 0; index < 20; index++) {
    const plan = createBiographyStagePlanFromRules(text, random);
    assert.ok(plan.count >= 5 && plan.count <= 8);
    assert.equal(plan.stages.length, plan.count);
    assert.ok(plan.stages.every(stage => !!stage.diceMaterial));
  }
});
