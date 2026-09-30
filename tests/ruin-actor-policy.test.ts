import assert from 'node:assert/strict';
import test from 'node:test';
import { scopeRuinGenealogy, applyRuinActorPolicy, blockedRuinActor, ruinNameUse } from '../src/runtime/ruinActorPolicy.ts';
import type { RuinGenerationInput } from '../src/schemas/ruin.ts';
import type { CastManifest } from '../src/retrieval/contracts.ts';

const node = (id: string, name: string, relationToFocus: string, summary: string, aliases: string[] = []) => ({
  id, name, aliases, relationToFocus, summary, profile: { lifeExperience: summary },
});
const ling = node('ling', '玲山·哈姆斯沃思', '本人', '现居帝国的翼民。', ['玲山']);
const father = node('father', '瓦伦·哈姆斯沃思', '父亲', '出生于梵尼亚，长期居住在梵尼亚的绝壁工坊。');
const mother = node('mother', '塞拉菲娜·晨羽', '母亲', '居住于梵尼亚。');
const sister = node('sister', '铃羽·哈姆斯沃思', '妹妹', '生活于梵尼亚。');
const local = node('local', '墨匠霍文', '远房表亲', '任职于奥古斯提姆帝国，校对军港账簿。');
const edge = (from: string, to: string, relationType: string, label: string) => ({ from, to, relationType, label });
const family = { sourceId: 'genealogy:ling', title: '玲山宗族谱系', content: JSON.stringify({
  schema: 'eyon.genealogy.current.v1', nodes: [ling, father, mother, sister, local],
  edges: [edge('father', 'ling', 'parent', '父女'), edge('mother', 'ling', 'parent', '母女'), edge('sister', 'ling', 'sibling', '妹妹')],
}) };
const other = { sourceId: 'genealogy:mimo', title: '珊奈宗族谱系', content: JSON.stringify({
  schema: 'eyon.genealogy.current.v1', nodes: [node('grand', '珊奈祖父', '祖父', '生活于雾晶城。')], edges: [],
}) };
function input(direction = '', selectedCharacters: RuinGenerationInput['selectedCharacters'] = [], autoGenealogy = false) {
  return { location: '奥古斯提姆帝国', supplementaryDirection: direction, selectedCharacters, autoGenealogy };
}
const selected = (name: string, source: 'mvu' | 'genealogy' = 'genealogy'): RuinGenerationInput['selectedCharacters'][number] => ({
  name, source, mvuId: name, identities: ['翼民'], race: '翼民', professions: ['工匠'], relations: [], lifespan: '', contextSummary: '',
});

test('关闭自动关联时不向帝国史稿提供两族祖辈演员池；开关不修改原谱系', () => {
  const original = family.content;
  const result = scopeRuinGenealogy([family, other], input());
  assert.deepEqual(result.sources, []);
  assert.ok(blockedRuinActor(result.policy, father.name));
  assert.ok(blockedRuinActor(result.policy, '珊奈祖父'));
  assert.equal(family.content, original);
});

test('自动关联开启只关联有本人在地活动依据的谱系人物，不按翼民种族或后嗣现居地推断', () => {
  const result = scopeRuinGenealogy([family, other], input('', [], true));
  assert.deepEqual(result.policy.genealogyActors, [local.name]);
  assert.ok(blockedRuinActor(result.policy, father.name));
  assert.ok(blockedRuinActor(result.policy, mother.name));
});

test('关闭自动关联不拦手选单个谱系人物，也不拦同一个人的 MVU 个体通路', () => {
  for (const source of ['genealogy', 'mvu'] as const) {
    const result = scopeRuinGenealogy([family], input('', [selected(father.name, source)]));
    assert.deepEqual(result.policy.genealogyActors, [father.name]);
    assert.ok(!blockedRuinActor(result.policy, father.name));
    assert.ok(blockedRuinActor(result.policy, mother.name));
    assert.equal(result.sources.length, 1);
  }
});

test('方向指定玲山父亲的发家史，父亲成为主体，玲山本人和其他亲属不连带出场', () => {
  const result = scopeRuinGenealogy([family, other], input('探讨玲山父亲的发家史'));
  assert.deepEqual(result.policy.requestedSubjects, [father.name]);
  assert.deepEqual(result.policy.genealogyActors, [father.name]);
  assert.deepEqual(result.policy.unresolvedRelatives, []);
  assert.ok(blockedRuinActor(result.policy, ling.name));
  assert.ok(blockedRuinActor(result.policy, mother.name));
  assert.ok(result.sources.some(source => source.title.includes(father.name)));
});

test('明确要求父母跨境探访，两位父母可出场，原籍字段保持不变', () => {
  const result = scopeRuinGenealogy([family], input('让玲山的父母到帝国探望她'));
  assert.deepEqual(result.policy.requestedSubjects, [father.name, mother.name]);
  assert.ok(JSON.parse(result.sources.find(source => source.title.includes(father.name))!.content).node.summary.includes('梵尼亚'));
  assert.ok(blockedRuinActor(result.policy, sister.name));
});

test('参考本人或父亲性格只读资料；另一个分句明确写本人经历仍可成为主体', () => {
  assert.equal(ruinNameUse('参考玲山的性格写当地商人', ling), 'reference');
  assert.equal(ruinNameUse('参考玲山的性格；再探讨玲山的成长经历', ling), 'subject');
  const result = scopeRuinGenealogy([family], input('参考玲山父亲的性格写当地工匠'));
  assert.deepEqual(result.policy.requestedSubjects, []);
  assert.ok(blockedRuinActor(result.policy, father.name));
  assert.ok(result.sources.some(source => source.title.includes(father.name)));
});

test('直接点名一人只开放该人，关闭自动关联不把他挡掉', () => {
  const result = scopeRuinGenealogy([family], input('写瓦伦·哈姆斯沃思在帝国修订账簿的经历'));
  assert.deepEqual(result.policy.requestedSubjects, [father.name]);
  assert.ok(!blockedRuinActor(result.policy, father.name));
  assert.ok(blockedRuinActor(result.policy, mother.name));
});

test('亲属无法唯一定位时给出明确消歧需求，不能任挑一位父亲', () => {
  const data = JSON.parse(family.content);
  data.nodes.push(node('other-father', '另一位父亲', '父亲', '居住于梵尼亚。'));
  data.edges.push(edge('other-father', 'ling', 'parent', '父女'));
  const ambiguous = { ...family, content: JSON.stringify(data) };
  assert.deepEqual(scopeRuinGenealogy([ambiguous], input('写玲山父亲的发家史')).policy.unresolvedRelatives, ['玲山·哈姆斯沃思的父亲']);
  assert.deepEqual(scopeRuinGenealogy([ambiguous], input('写玲山父亲的发家史', [selected(father.name)])).policy.unresolvedRelatives, []);
});

test('演员名册同步区分指定父亲、参考本人、无关祖辈，不触碰组织演员', () => {
  const result = scopeRuinGenealogy([family], input('探讨玲山父亲的发家史'));
  const manifest: CastManifest = { schema: 'eyon.retrieval.cast-manifest.v1', groupCoverage: [], entries: [ling, father, mother].map(person => ({
    entityId: person.id, disposition: 'required', role: 'actor', reasons: ['direct-query-entity'],
    identity: { canonicalName: person.name, aliases: person.aliases, kinds: ['person'], identities: ['翼民'], affiliations: [], temporalScopes: [], locationScopes: [], sourceSnapshotIds: [], passageIds: [] },
  })) };
  const projected = applyRuinActorPolicy(manifest, result.policy, '探讨玲山父亲的发家史')!;
  assert.equal(projected.entries.find(entry => entry.entityId === 'father')?.disposition, 'required');
  assert.equal(projected.entries.find(entry => entry.entityId === 'ling')?.disposition, 'excluded');
  assert.equal(projected.entries.find(entry => entry.entityId === 'mother')?.disposition, 'excluded');
  assert.equal(manifest.entries[0]?.disposition, 'required');
});

test('只存父母边的族谱仍可两跳定位祖父；祖辈展开有界且不包括后嗣', () => {
  const data = JSON.parse(family.content);
  data.nodes.push(node('grandfather', '瓦伦的父亲', '祖父', '长期居住在梵尼亚。'));
  data.edges.push(edge('grandfather', 'father', 'parent', '父子'));
  const extended = { ...family, content: JSON.stringify(data) };
  const grandfather = scopeRuinGenealogy([extended], input('探讨玲山祖父的工坊史'));
  assert.deepEqual(grandfather.policy.requestedSubjects, ['瓦伦的父亲']);
  assert.ok(blockedRuinActor(grandfather.policy, father.name));
  const ancestors = scopeRuinGenealogy([extended], input('探讨玲山祖辈的工坊史'));
  assert.deepEqual(new Set(ancestors.policy.requestedSubjects), new Set([father.name, mother.name, '瓦伦的父亲']));
  assert.ok(blockedRuinActor(ancestors.policy, sister.name));
});

test('未选家族的同名不同姓本地人物不因共享名字前半部被错误排除', () => {
  const result = scopeRuinGenealogy([family], input());
  const manifest: CastManifest = { schema: 'eyon.retrieval.cast-manifest.v1', groupCoverage: [], entries: [{
    entityId: 'other-valen', disposition: 'recommended', role: 'participant', reasons: ['relation:active_in'],
    identity: { canonicalName: '瓦伦·诺尔', aliases: [], kinds: ['person'], identities: ['帝国商人'], temporalScopes: [], locationScopes: [], sourceSnapshotIds: [], passageIds: [] },
  }] };
  assert.equal(applyRuinActorPolicy(manifest, result.policy, '')?.entries[0]?.disposition, 'recommended');
  assert.ok(!blockedRuinActor(result.policy, '瓦伦·诺尔'));
});
