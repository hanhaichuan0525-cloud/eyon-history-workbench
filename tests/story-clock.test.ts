import assert from 'node:assert/strict';
import test from 'node:test';

import { parseStoryClock } from '../src/runtime/storyClock.ts';

test('起止双戳完整解析', () => {
  const clock = parseStoryClock([
    '<eyon name="伊雍">「让我替你翻开这段旧史。」</eyon>',
    '<!-- EYON-TIME-START 复兴纪元488年3月15日14时 -->',
    '<eyon_court/>',
    '<!-- EYON-TIME-END 复兴纪元488年3月16日9时 -->',
  ].join('\n'));
  assert.deepEqual(clock, {
    start: '复兴纪元488年3月15日14时',
    end: '复兴纪元488年3月16日9时',
  });
});

test('只有起始戳也能解析（缺失侧为空串）', () => {
  const clock = parseStoryClock('<!-- EYON-TIME-START 488年1月1日0时 -->正文');
  assert.deepEqual(clock, { start: '488年1月1日0时', end: '' });
});

test('完全无戳返回 null', () => {
  assert.equal(parseStoryClock('伊雍的普通开场，没有时间戳'), null);
});

test('宽松容错：注释带空格/换行也能解析', () => {
  const clock = parseStoryClock([
    '<!-- EYON-TIME-START',
    '  复兴纪元488年3月15日14时',
    '-->',
  ].join('\n'));
  assert.equal(clock?.start, '复兴纪元488年3月15日14时');
});
