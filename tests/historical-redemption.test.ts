import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRedemptionTimes, isHistoricalRedemptionHint } from '../src/core/historicalRedemption.ts';

test('赎出时间只判断已知先后，跨纪元不折算年龄，日期模糊或非法保持未决', () => {
  for (const [left, right, expected] of [
    ['复兴纪元488年', '神明纪元1年', 1],
    ['神明纪元1年', '混乱纪元1年', -1],
    ['自定义历15年', '自定义历12年', 1],
    ['异界历15年', '复兴纪元488年', null],
    ['远古时期', '神明纪元1年', null],
    ['复兴纪元405年', '复兴纪元405年1月1日09:05', null],
    ['复兴纪元405年1月1日09:04', '复兴纪元405年1月1日09:05', -1],
    ['复兴纪元405年1月1日09:05', '复兴纪元405年1月1日09:05', 0],
    ['复兴纪元405年2月1日', '复兴纪元405年1月1日09:05', 1],
    ['复兴纪元405年15月1日', '复兴纪元405年1月1日09:05', null],
  ] as const) assert.equal(compareRedemptionTimes(left, right), expected, `${left} vs ${right}`);
});

test('自然语言索引是可选提示，不把未发生、计划或复制品当成原本人离去', () => {
  for (const hint of ['历史赎出', '成功历史赎出', '已从原历史抽离']) assert.ok(isHistoricalRedemptionHint(hint));
  for (const hint of ['取消历史赎出', '历史赎出失败', '尚未历史赎出', '没有历史赎出',
    '历史赎出未发生', '并非历史赎出', '仅签约', '复制品历史赎出', '计划历史赎出', '所在地变化', '']) assert.ok(!isHistoricalRedemptionHint(hint), hint);
});
