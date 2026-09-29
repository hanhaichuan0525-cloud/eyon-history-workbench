import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import {
  createWorldbookSourceSnapshot,
  stableJson,
  stableSha256,
  worldbookLogicalId,
} from '../src/retrieval/sourceSnapshot.ts';

function worldbookSource(content = '圣翼议会属于梵尼亚'): RuntimeWorldbookSource {
  const logicalId = worldbookLogicalId('命定之诗 主世界书', 17);
  return {
    sourceId: 'worldbook:命定之诗 主世界书:17',
    title: '圣翼议会',
    content,
    strategyType: 'selective',
    keywords: ['圣翼议会', '梵尼亚'],
    worldbook: {
      schema: 'eyon.retrieval.worldbook-metadata.v1',
      logicalId,
      worldbookName: '命定之诗 主世界书',
      uid: 17,
      bindingScopes: ['character-primary', 'global'],
      enabled: true,
      strategy: {
        type: 'vectorized',
        primaryKeys: ['圣翼议会', '梵尼亚'],
        secondary: { logic: 'and_any', keys: ['教会', '组织'] },
        scanDepth: 4,
      },
      position: { type: 'at_depth', role: 'system', depth: 3, order: 20 },
      probability: 85,
      recursion: {
        preventIncoming: false,
        preventOutgoing: true,
        delayUntil: 1,
      },
      effect: { sticky: 2, cooldown: 1, delay: null },
      extra: { z: 2, nested: { b: true, a: '先排序' } },
    },
  };
}

test('稳定 JSON 与 SHA-256 不受对象属性顺序影响', async () => {
  const left = { z: 2, nested: { b: true, a: '先排序' }, list: [2, 1] };
  const right = { list: [2, 1], nested: { a: '先排序', b: true }, z: 2 };
  assert.equal(stableJson(left), stableJson(right));
  assert.equal(await stableSha256(left), await stableSha256(right));
});

test('世界书 snapshot 保持逻辑身份，并以内容和元数据生成版本身份', async () => {
  const original = await createWorldbookSourceSnapshot(worldbookSource());
  const same = worldbookSource();
  same.worldbook.extra = { nested: { a: '先排序', b: true }, z: 2 };
  const reordered = await createWorldbookSourceSnapshot(same);
  const changed = await createWorldbookSourceSnapshot(
    worldbookSource('圣翼议会错误地属于翡翠之心'),
  );

  assert.equal(
    original.logicalId,
    'worldbook:%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97%20%E4%B8%BB%E4%B8%96%E7%95%8C%E4%B9%A6:17',
  );
  assert.equal(original.versionHash.length, 64);
  assert.equal(original.snapshotId, `${original.logicalId}@sha256:${original.versionHash}`);
  assert.equal(original.versionHash, reordered.versionHash);
  assert.equal(original.snapshotId, reordered.snapshotId);
  assert.equal(original.logicalId, changed.logicalId);
  assert.notEqual(original.versionHash, changed.versionHash);
});

test('改变有效检索元数据会改变 snapshot 版本', async () => {
  const original = worldbookSource();
  const changed = worldbookSource();
  changed.worldbook.strategy.secondary.logic = 'and_all';
  assert.notEqual(
    (await createWorldbookSourceSnapshot(original)).versionHash,
    (await createWorldbookSourceSnapshot(changed)).versionHash,
  );
});
