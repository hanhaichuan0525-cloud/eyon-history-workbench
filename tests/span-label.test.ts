import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSpanLabel, type SpanPointLike } from '../src/renderers/spanLabel.ts';

function point(partial: Partial<SpanPointLike>): SpanPointLike {
  return {
    year: null,
    month: null,
    day: null,
    hour: null,
    age: null,
    era: undefined,
    ...partial,
  };
}

test('跨纪元：起止纪元名不同时双纪元名+年', () => {
  const start = point({ era: '复兴纪元', year: 300 });
  const end = point({ era: '新纪元', year: 1 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '复兴纪元300年 - 新纪元1年');
});

test('同纪元跨年：保留共同纪元与两端年份', () => {
  const start = point({ era: '复兴纪元', year: 445 });
  const end = point({ era: '复兴纪元', year: 451 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '复兴纪元445年 - 451年');
});

test('纪元未知跨年：同样只写年', () => {
  const start = point({ year: 445 });
  const end = point({ year: 451 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '445年 - 451年');
});

test('同年跨月：保留共同纪元与年份', () => {
  const start = point({ era: '复兴纪元', year: 488, month: 3 });
  const end = point({ era: '复兴纪元', year: 488, month: 11 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '复兴纪元488年3月 - 11月');
});

test('同月跨日：保留共同纪元、年份与月份', () => {
  const start = point({ era: '复兴纪元', year: 488, month: 3, day: 1 });
  const end = point({ era: '复兴纪元', year: 488, month: 3, day: 15 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '复兴纪元488年3月1日 - 15日');
});

test('同日跨时：保留共同纪元、年份、月份与日期', () => {
  const start = point({ era: '复兴纪元', year: 488, month: 3, day: 15, hour: 6 });
  const end = point({ era: '复兴纪元', year: 488, month: 3, day: 15, hour: 22 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '复兴纪元488年3月15日6时 - 22时');
});

test('完全同点：按可用精度渲染单点', () => {
  const p = point({ year: 488, month: 3, day: 15, hour: 6 });
  assert.equal(renderSpanLabel(p, { ...p }, 'calendar'), '488年3月15日6时');
});

test('完全同点：已有纪元时纪元不可被显示层省略', () => {
  const p = point({ era: '复兴纪元', year: 488, month: 3 });
  assert.equal(renderSpanLabel(p, { ...p }, 'calendar'), '复兴纪元488年3月');
});

test('只有年份的单点', () => {
  const p = point({ year: 488 });
  assert.equal(renderSpanLabel(p, { ...p }, 'calendar'), '488年');
});

test('age 模式：岁数跨度', () => {
  const start = point({ age: 24 });
  const end = point({ age: 28 });
  assert.equal(renderSpanLabel(start, end, 'age'), '24岁至28岁');
});

test('两侧仅有年龄锚点时即使 mode 为 calendar 也走岁数', () => {
  const start = point({ age: 24 });
  const end = point({ age: 28 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '24岁至28岁');
});

test('鲁棒：终点无锚时按起点渲染单点（开放终点）', () => {
  const start = point({ year: 488, month: 3 });
  const end = point({});
  assert.equal(renderSpanLabel(start, end, 'calendar'), '488年3月');
});

test('鲁棒：字段缺失自动降级（只有年+月，跨年降为年精度）', () => {
  const start = point({ year: 488, month: 12 });
  const end = point({ year: 489, month: 1 });
  assert.equal(renderSpanLabel(start, end, 'calendar'), '488年 - 489年');
});
