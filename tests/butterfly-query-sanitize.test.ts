import assert from 'node:assert/strict';
import test from 'node:test';
import { narrativeOnly } from '../src/runtime/butterflyContext.ts';

test('演员查询清洗变量更新、状态栏、摘要与选项，只留叙事正文', () => {
  const raw = [
    '她把门推开，看见走廊尽头站着守门人。',
    '<UpdateVariable>{"新闻":{"势力要闻":"伯伦斯法环雾晶港的高塔"}}</UpdateVariable>',
    '<StatusPlaceHolderImpl/>',
    '<summary>摘要里也提到伯伦斯法环</summary>',
    '<action_options>["离开","询问"]</action_options>',
    '<!-- 伯伦斯法环 -->',
    '她问：“谁在那里？”',
  ].join('\n');
  const cleaned = narrativeOnly(raw);
  assert.match(cleaned, /她把门推开/u);
  assert.match(cleaned, /她问/u);
  for (const value of ['伯伦斯法环', 'UpdateVariable', 'StatusPlaceHolder', 'action_options', 'summary', '<!--']) {
    assert.ok(!cleaned.includes(value), `不应残留 ${value}`);
  }
});
