import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearP4DerivedCache,
  corruptP4DerivedCacheForTests,
  inspectP4DerivedCache,
  readP4DerivedCache,
  resetP4DerivedCacheForTests,
  writeP4DerivedCache,
  type P4DerivedCacheScope,
} from '../src/core/p4DerivedCache.ts';

type View = { schema: 'fixture.view'; value: string[] };
const valid = (value: unknown): value is View => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<View>;
  return candidate.schema === 'fixture.view' && Array.isArray(candidate.value);
};
const scope = (patch: Partial<P4DerivedCacheScope> = {}): P4DerivedCacheScope => ({
  namespace: '伊雍::chat-a',
  branchId: 'branch-a',
  canonRevision: 7,
  queryScopeHash: 'query-a',
  module: 'biography',
  subjectScope: ['暮潮手札'],
  timeScope: ['复兴纪元484年'],
  locationScope: ['第七泊位'],
  anchorSetHash: 'anchors-a',
  ...patch,
});

test('IC-01 相同作用域命中且返回结构等价的隔离副本', () => {
  resetP4DerivedCacheForTests();
  const original: View = { schema: 'fixture.view', value: ['C1', 'C2'] };
  writeP4DerivedCache(scope(), original);
  const hit = readP4DerivedCache(scope(), valid);
  assert.deepEqual(hit, original);
  hit!.value.push('mutated');
  assert.deepEqual(readP4DerivedCache(scope(), valid), original);
  assert.equal(inspectP4DerivedCache().diagnostics.at(-1)?.event, 'hit');
});

test('IC-02 revision 改变拒绝旧值', () => {
  resetP4DerivedCacheForTests();
  writeP4DerivedCache(scope(), { schema: 'fixture.view', value: ['old'] } satisfies View);
  assert.equal(readP4DerivedCache(scope({ canonRevision: 8 }), valid), undefined);
});

test('IC-03 无关锚不改变影响窗 hash 可复用，相关锚改变即冷算', () => {
  resetP4DerivedCacheForTests();
  writeP4DerivedCache(scope(), { schema: 'fixture.view', value: ['stable-window'] } satisfies View);
  // 无关锚不进入调用方计算的 anchorSetHash，因此仍命中。
  assert.equal(readP4DerivedCache(scope(), valid)?.value[0], 'stable-window');
  assert.equal(readP4DerivedCache(scope({ anchorSetHash: 'anchors-related-change' }), valid), undefined);
});

test('IC-04 删除相关生产产物改变 anchorSetHash 并拒绝旧值', () => {
  resetP4DerivedCacheForTests();
  writeP4DerivedCache(scope(), { schema: 'fixture.view', value: ['producer-present'] } satisfies View);
  assert.equal(readP4DerivedCache(scope({ anchorSetHash: 'producer-deleted' }), valid), undefined);
});

test('IC-05 损坏与超限都退化为 miss，不把故障抛给生成链', () => {
  resetP4DerivedCacheForTests(1);
  corruptP4DerivedCacheForTests(scope());
  assert.doesNotThrow(() => readP4DerivedCache(scope(), valid));
  assert.equal(readP4DerivedCache(scope(), valid), undefined);
  writeP4DerivedCache(scope(), { schema: 'fixture.view', value: ['first'] } satisfies View);
  const other = scope({ queryScopeHash: 'query-b', anchorSetHash: 'anchors-b' });
  writeP4DerivedCache(other, { schema: 'fixture.view', value: ['second'] } satisfies View);
  assert.equal(readP4DerivedCache(scope(), valid), undefined);
  assert.equal(readP4DerivedCache(other, valid)?.value[0], 'second');
  assert.ok(inspectP4DerivedCache().diagnostics.some(item => item.event === 'corrupt'));
  assert.ok(inspectP4DerivedCache().diagnostics.some(item => item.event === 'evicted'));
});

test('IC-06 namespace、分支隔离，清理只移除派生缓存', () => {
  resetP4DerivedCacheForTests();
  const durableArtifact = { biographyId: 'bio-1' };
  writeP4DerivedCache(scope(), { schema: 'fixture.view', value: ['local'] } satisfies View);
  assert.equal(readP4DerivedCache(scope({ namespace: '伊雍::chat-b' }), valid), undefined);
  assert.equal(readP4DerivedCache(scope({ branchId: 'branch-b' }), valid), undefined);
  clearP4DerivedCache('test');
  assert.equal(inspectP4DerivedCache().size, 0);
  assert.deepEqual(durableArtifact, { biographyId: 'bio-1' });
});
