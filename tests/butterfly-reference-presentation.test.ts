import assert from 'node:assert/strict';
import test from 'node:test';
import { BUTTERFLY_OPTIONS, DEFAULT_BUTTERFLY_REFERENCES, renderButterflyReferences } from '../src/core/creativeReferences.ts';
import { BUTTERFLY_FIELD_LABELS, butterflyOptionCopy, butterflyAbsurdityCopy, butterflyStylePreview } from '../src/ui/butterflyReferencePresentation.ts';

test('全部原选项都有短展示与含义，波及范围原文不变，不改枚举和模型提示', () => {
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES };
  const before = JSON.stringify(refs), prompt = renderButterflyReferences(refs);
  for (const key of Object.keys(BUTTERFLY_OPTIONS) as (keyof typeof BUTTERFLY_OPTIONS)[]) {
    assert.ok(BUTTERFLY_FIELD_LABELS[key].length <= 8);
    for (const value of BUTTERFLY_OPTIONS[key]) {
      const [label, meaning] = butterflyOptionCopy(key, value);
      assert.ok(label.length > 0 && label.length <= 8, `${key}: ${label}`);
      assert.ok(meaning.trim());
      if (key === 'scope') assert.equal(label, value);
      const preview = butterflyStylePreview({ ...refs, [key]: value });
      assert.equal(preview.match(/。/gu)?.length, 2);
      assert.ok(preview.length <= 120, `${key}: ${preview.length}`);
      assert.doesNotMatch(preview, /undefined|一定会|必定|封圣|成为女皇/u);
    }
  }
  const longest = { ...refs, focus: '已填写对象', absurdity: 95 };
  for (const key of Object.keys(BUTTERFLY_OPTIONS) as (keyof typeof BUTTERFLY_OPTIONS)[]) {
    Object.assign(longest, { [key]: [...BUTTERFLY_OPTIONS[key]].sort((a, b) =>
      (key === 'scope' ? b.length - a.length : butterflyOptionCopy(key, b)[1].length - butterflyOptionCopy(key, a)[1].length))[0] });
  }
  assert.ok(butterflyStylePreview(longest).length <= 120, '最长组合也保持两句短提示，不靠截字');
  assert.equal(JSON.stringify(refs), before);
  assert.equal(renderButterflyReferences(refs), prompt);
});

test('组合是可能的风格提示，范围/深度/发展/传奇/读感/发现途径各有影响', () => {
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, scope: '大陆', domain: '信仰与文化', intensity: '时代回响',
    absurdity: 95, legend: '史诗回响', evolution: '意外转用', mood: '黑色幽默', manifestation: '信仰与公共景观' } as const;
  const text = butterflyStylePreview(refs);
  for (const value of ['大陆', '信仰', '长期走向', '离奇但可追溯', '新地方', '漫长历史', '好笑又辛酸', '供奉、仪式或建筑']) assert.ok(text.includes(value), value);
  assert.notEqual(text, butterflyStylePreview(DEFAULT_BUTTERFLY_REFERENCES));
  assert.ok(butterflyStylePreview({ ...refs, focus: '二叶'.repeat(2000) }).includes('围绕重点对象'));
  assert.ok(butterflyStylePreview({ ...refs, focus: '二叶'.repeat(2000) }).length <= 120);
});

test('离奇度五档边界跟随既有荒诞值，未知展示值有安全回退', () => {
  for (const [n, expected] of [[0, '贴近日常'], [20, '贴近日常'], [21, '偶有意外'], [40, '偶有意外'],
    [41, '奇异变化'], [60, '奇异变化'], [61, '大胆奇想'], [80, '大胆奇想'], [81, '离奇演变'], [100, '离奇演变']] as const) {
    assert.equal(butterflyAbsurdityCopy(n)[0], expected);
  }
  assert.equal(butterflyAbsurdityCopy(Number.NaN)[0], '偶有意外');
  assert.deepEqual(butterflyOptionCopy('domain', 'toString'), ['toString', '由实际行动和历史条件决定。']);
});
