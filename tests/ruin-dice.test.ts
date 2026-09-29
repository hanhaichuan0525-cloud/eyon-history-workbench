import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createRuinMaterialsFromRules,
  waveForCandidateCount,
} from '../src/runtime/ruinDiceCore.ts';

const rules = readFileSync(
  new URL('../rules/08_伊雍骰子判定表-脚本数据.txt', import.meta.url),
  'utf8',
);

test('墟境骰表为3/4/5个候选提供完整且不相邻重复的时期材料', () => {
  for (const count of [3, 4, 5] as const) {
    const materials = createRuinMaterialsFromRules(rules, count, () => 0);
    assert.equal(materials.length, count);
    assert.deepEqual(
      materials.map(item => item.candidateKey),
      Array.from({ length: count }, (_, index) => `candidate-${index + 1}`),
    );
    assert.equal(new Set(materials.slice(0, 3)
      .map(item => item.periodType)).size, 3);
    for (const material of materials) {
      assert.match(material.background, /｜/u);
      assert.match(material.conflict, /｜/u);
      assert.match(material.trigger, /｜/u);
    }
  }
});

test('候选数量只映射到既定历史波动等级', () => {
  assert.deepEqual(waveForCandidateCount(3), {
    candidateCount: 3,
    level: 'ripple',
  });
  assert.deepEqual(waveForCandidateCount(4), {
    candidateCount: 4,
    level: 'surge',
  });
  assert.deepEqual(waveForCandidateCount(5), {
    candidateCount: 5,
    level: 'howl',
  });
});
