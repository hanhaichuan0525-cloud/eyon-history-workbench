import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEntityLinkingIndex,
  linkCarrier,
  type EntityLinkCandidate,
} from '../src/retrieval/entityLinking.ts';

const yuna: EntityLinkCandidate = {
  entityId: 'entity:worldbook:test:yuna',
  names: ['尤娜', '尤娜·夜莺'],
};
const bart: EntityLinkCandidate = {
  entityId: 'entity:worldbook:test:bart',
  names: ['巴托洛缪', '巴托洛缪·燧石'],
};

test('完全相等与别名命中返回稳定 id', () => {
  assert.equal(linkCarrier('尤娜', [yuna, bart]), 'entity:worldbook:test:yuna');
  assert.equal(linkCarrier('尤娜·夜莺', [yuna, bart]), 'entity:worldbook:test:yuna');
  assert.equal(linkCarrier('巴托洛缪·燧石', [yuna, bart]), 'entity:worldbook:test:bart');
});

test('短名被长名包含（点名词）命中', () => {
  assert.equal(
    linkCarrier('尤娜', [{ entityId: 'x', names: ['大工匠尤娜·夜莺'] }]),
    'x',
  );
});

test('复合描述仅含一个候选名时采用；含多个候选名时不猜返回 null', () => {
  assert.equal(
    linkCarrier('首席工匠巴托洛缪与受损的高塔穹顶', [bart]),
    'entity:worldbook:test:bart',
  );
  assert.equal(
    linkCarrier('首席工匠巴托洛缪与学徒尤娜的恩怨', [bart, yuna]),
    null,
    '复合描述同时命中多名实体 → 不猜（宁漏勿错）',
  );
});

test('重名多候选不猜返回 null；无关载体返回 null', () => {
  assert.equal(
    linkCarrier('尤娜', [yuna, { entityId: 'other', names: ['尤娜·王尔德'] }]),
    null,
  );
  assert.equal(linkCarrier('黄昏花室', [yuna, bart]), null);
  assert.equal(linkCarrier('雾晶港的蒸汽机', [yuna, bart]), null);
});

test('空/过短输入返回 null（防御）', () => {
  assert.equal(linkCarrier('', [yuna]), null);
  assert.equal(linkCarrier('   ', [yuna]), null);
  assert.equal(linkCarrier('的', [yuna]), null);
  assert.equal(linkCarrier('尤娜', []), null);
  assert.equal(linkCarrier('尤娜', undefined as unknown as EntityLinkCandidate[]), null);
});

test('索引构建：归一化去重、同 id 合并、剔除短名、有界', () => {
  const index = buildEntityLinkingIndex([
    { entityId: 'a', names: [' 玲山 ', '玲山·哈姆斯沃思', '玲山', '的'] },
    { entityId: 'a', names: ['玲山', '玲山·哈姆斯沃思'] },
    { entityId: 'b', names: ['伊莲娜·A·梦露'] },
  ]);
  const a = index.find(item => item.entityId === 'a');
  assert.deepEqual([...a!.names].sort(), ['玲山', '玲山·哈姆斯沃思']);
  assert.equal(index.length, 2);

  const bounded = buildEntityLinkingIndex(
    Array.from({ length: 250 }, (_, i) => ({
      entityId: `e${i}`,
      names: [`实体${i}`],
    })),
    200,
  );
  assert.ok(bounded.length <= 200, '索引应有界');
  assert.equal(bounded[0]!.names[0], '实体0');
});
