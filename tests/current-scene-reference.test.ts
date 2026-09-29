import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCurrentSceneSnapshot,
  findExplicitCurrentSceneRelocation,
  renderCurrentSceneSemanticSnapshot,
  resolveCurrentSceneReference,
} from '../src/core/currentSceneReference.ts';

const directive = '伊雍，对这皇宫中的黄昏花室进行寻根溯源，要求写它的建筑史';
const currentLocation = '奥古斯提姆帝国-艾瑟嘉德-皇宫-黄昏花室';

test('当前场景锚在指示语或地点链末端具名对象被点名时生效', () => {
  assert.deepEqual(resolveCurrentSceneReference(directive, currentLocation), {
    directive,
    location: currentLocation,
  });
  assert.deepEqual(resolveCurrentSceneReference('对黄昏花室进行寻根溯源', currentLocation), {
    directive: '对黄昏花室进行寻根溯源',
    location: currentLocation,
  });
  assert.equal(resolveCurrentSceneReference('对艾瑟嘉德的所有井盖进行寻根溯源', currentLocation), null);
  assert.equal(resolveCurrentSceneReference('对花室进行寻根溯源', currentLocation), null);
  assert.equal(resolveCurrentSceneReference(directive, ''), null);
});

test('当前场景语义快照保留附近聊天原意，不把用途与归属压成脚本字段', () => {
  const snapshot = buildCurrentSceneSnapshot(
    '对黄昏花室进行寻根溯源，从它建造完毕到现在',
    currentLocation,
    [
      {
        sourceId: 'recent:38',
        title: '较早聊天',
        content: '维奥莱塔卸下铠甲，回到作为她私人寝宫的黄昏花室休息。',
      },
      {
        sourceId: 'recent:39',
        title: '附近聊天',
        content: '海因里希守在门外，未经女皇允许任何人不得进入。',
      },
      {
        sourceId: 'recent:40',
        title: '玩家指令',
        content: '对黄昏花室进行寻根溯源，从它建造完毕到现在',
      },
    ],
  );

  assert.ok(snapshot);
  assert.equal(snapshot.location, currentLocation);
  assert.deepEqual(snapshot.evidence.map(item => item.sourceId), ['recent:38', 'recent:39']);
  assert.equal('owner' in snapshot, false);
  assert.equal('purpose' in snapshot, false);
  const rendered = renderCurrentSceneSemanticSnapshot(snapshot).join('\n');
  assert.match(rendered, /私人寝宫/u);
  assert.match(rendered, /保持未知/u);
  assert.match(rendered, /不得把现时名称、用途、所有人或居住者无据投射到建立之初/u);
});

test('与当前场景无关的开放对象不吸收场景聊天', () => {
  assert.equal(buildCurrentSceneSnapshot(
    '对艾瑟嘉德的井盖业进行寻根溯源',
    currentLocation,
    [{ sourceId: 'recent:1', title: '聊天', content: '黄昏花室是女皇寝宫。' }],
  ), null);
});

test('显式搬迁校验只拦父级地点冲突，不拦内部创作或外地材料', () => {
  assert.equal(findExplicitCurrentSceneRelocation({
    directive,
    currentLocation,
    targetName: '黄昏花室',
    text: '黄昏花室坐落于瓦伦蒂亚城堡群。',
  }), '瓦伦蒂亚城堡群');
  assert.equal(findExplicitCurrentSceneRelocation({
    directive,
    currentLocation,
    targetName: '黄昏花室',
    text: '瓦伦蒂亚城堡群的高塔顶端黄昏花室在雨中完工。',
  }), '瓦伦蒂亚城堡群');
  assert.equal(findExplicitCurrentSceneRelocation({
    directive,
    currentLocation,
    targetName: '黄昏花室',
    text: '工匠从瓦伦蒂亚城运来月光岩，在黄昏花室内部增建回廊与花圃。',
  }), null);
  assert.equal(findExplicitCurrentSceneRelocation({
    directive,
    currentLocation,
    targetName: '黄昏花室',
    text: '皇宫中的黄昏花室增建了一条通向西侧露台的回廊。',
  }), null);
});

test('同一 MVU 地点层级的连写、分隔符差异与自然修饰不得被判成搬迁', () => {
  const nestedLocation = '大陆中东部-奥古斯提姆帝国-艾瑟嘉德-皇宫高塔-黄昏花室';
  for (const text of [
    '黄昏花室位于艾瑟嘉德皇宫高塔。',
    '艾瑟嘉德皇宫高塔的黄昏花室在暮色中完成修缮。',
    '帝都艾瑟嘉德的皇宫高塔中，黄昏花室更换了穹顶琉璃。',
  ]) {
    assert.equal(findExplicitCurrentSceneRelocation({
      directive,
      currentLocation: nestedLocation,
      targetName: '黄昏花室',
      text,
    }), null, text);
  }
  assert.equal(findExplicitCurrentSceneRelocation({
    directive,
    currentLocation: nestedLocation,
    targetName: '黄昏花室',
    text: '黄昏花室坐落于瓦伦蒂亚城堡群。',
  }), '瓦伦蒂亚城堡群');
});
