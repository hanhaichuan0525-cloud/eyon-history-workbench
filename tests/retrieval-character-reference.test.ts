import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldbookSourceSnapshot, worldbookLogicalId } from '../src/retrieval/sourceSnapshot.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { buildRuinOutlineBatchApiPrompt } from '../src/prompts/ruin.ts';
import type { RuinContextBundle } from '../src/core/context.ts';
import type { RuinGenerationInput } from '../src/schemas/ruin.ts';

async function source(uid: number, title: string, content: string, keys: string[] = []) {
  const logicalId = worldbookLogicalId('fixture', uid);
  return createWorldbookSourceSnapshot({ sourceId: logicalId, title, content, keywords: keys, strategyType: 'selective',
    worldbook: { schema: 'eyon.retrieval.worldbook-metadata.v1', logicalId, worldbookName: 'fixture',
      uid, bindingScopes: ['character-primary'], enabled: true,
      strategy: { type: 'selective', primaryKeys: keys, secondary: { logic: 'and_any', keys: [] }, scanDepth: 4 },
      position: { type: 'before_character_definition', role: 'system', depth: 0, order: 100 }, probability: 100,
      recursion: { preventIncoming: false, preventOutgoing: false, delayUntil: null },
      effect: { sticky: null, cooldown: null, delay: null }, extra: {} } });
}

async function fixtures() {
  return [
    await source(1, '[DLC][角色][龙与花][龙与花-作者乙]雾澜·灰潮女王',
      '雾澜·风庭:\n  姓名: 雾澜·风庭\n  身份: 灰潮女王，前清泉龙姬\n'
      + '  背景: 第二次位面入侵时守护旧港，封印前剥离善意分身。\n主档末尾保留',
      ['本体', '灰潮女王', '雾澜', '风庭']),
    await source(2, '[DLC][角色][龙与花][龙与花-作者乙]青漪·风庭(作者乙-新增角色：青漪和雾澜)',
      '青漪·风庭:\n  姓名: 青漪·风庭\n  身份: 游历者\n  起源: 本体是守护旧港的古龙【灰潮女王】。'
      + '她是封印前剥离善意与纯净灵魂而凝聚的分身。\n'
      + '  现状: 复兴纪元仍在寻找解封的方法。\n' + '完整背景。'.repeat(2000) + '\n分身末尾保留',
      ['冒险者', '龙姬', '青漪', '风庭']),
    await source(3, '[角色]暮林·风庭', '姓名: 暮林·风庭\n身份: 制图师\n背景: 从未涉足旧港。', ['风庭']),
    await source(4, '[DLC][角色][作者乙]辰光(作者乙-推荐青漪)', '姓名: 辰光\n背景: 独自在南方旅行。', ['作者乙']),
  ];
}

for (const direction of ['灰潮女王相关墟境', '探索“灰潮女王”相关墟境', '探查雾澜的历史', '雾澜·风庭的过往', '雾澜·灰潮女王的过往']) {
  test(`称号/简称引用且带纪元地点：${direction}`, async () => {
    const sources = await fixtures();
    const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({ requestId: 'reference',
      taskType: 'ruin', mode: 'active', query: `英雄纪元\n旧港\n${direction}` });
    const attachments = result.bundle.taskAnchorAttachments ?? [];
    assert.ok(attachments.some(a => a.snapshotId === sources[0]!.snapshotId));
    assert.ok(attachments.some(a => a.snapshotId === sources[1]!.snapshotId), '跨纪元身世资料仍可只读跟读');
    for (const entry of sources.slice(0, 2)) assert.ok(attachments.some(a => a.content === entry.content));
    assert.ok(!attachments.some(a => sources.slice(2).some(s => s.snapshotId === a.snapshotId)));
    const cast = result.bundle.castManifest!.entries;
    assert.equal(cast.find(e => e.identity.aliases.includes('灰潮女王'))?.disposition, 'required');
    assert.ok(!cast.some(e => e.identity.canonicalName.startsWith('青漪') && e.disposition === 'required'));
  });
}

test('姓名、称号、全标题绑定本人，不把姓氏、作者或通用触发词变成别名', async () => {
  const catalog = buildRetrievalIndex(await fixtures()).catalog;
  const queen = catalog.entities.find(e => e.canonicalName === '雾澜·风庭')!;
  assert.ok(queen);
  assert.ok(queen.aliases.includes('灰潮女王'));
  assert.ok(queen.aliases.includes('雾澜'));
  assert.ok(!queen.aliases.some(a => ['本体', '风庭', '作者乙', '龙姬'].includes(a)));
  assert.ok(!catalog.entities.some(e => e.canonicalName === '风庭'));
  assert.equal(catalog.entities.filter(e => e.kinds.includes('person') && e.canonicalName.includes('风庭')).length, 3);
});

test('关联人物的完整主档进入墟境 prompt，不要求在输入中点名分身', async () => {
  const sources = await fixtures();
  const query = '英雄纪元\n旧港\n灰潮女王相关墟境';
  const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({ requestId: 'reference-prompt',
    taskType: 'ruin', mode: 'active', query });
  const context: RuinContextBundle = { schema: 'eyon.context.v1', taskType: 'ruin', requestId: 'reference-prompt',
    scope: { characterKey: 'fixture', chatId: 'fixture', triggerMessageId: 1 },
    currentWorld: { time: '复兴纪元488年', location: '旧港' }, evidenceBundle: result.bundle,
    worldbookContext: [], recentContext: [], characterContext: [], sourceIndex: [],
    genealogyRefs: [], biographyRefs: [], butterflyRefs: [], warnings: [], sourceHash: 'fixture' };
  const generationInput: RuinGenerationInput = { era: '英雄纪元', location: '旧港', start: null, end: null,
    supplementaryDirection: '灰潮女王相关墟境', selectedCharacters: [], autoGenealogy: false,
    wave: { level: 'stable', candidateCount: 3 }, materials: Array.from({ length: 3 }, (_, i) => ({
      candidateKey: `candidate-${i + 1}`, periodType: 'transition', background: '旧港历史', conflict: '', trigger: '' })) };
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId: context.requestId, directive: query,
    generationInput, context, rules: { generationContract: '' } });
  const full = prompt.split('<CHARACTER_CARDS_FULL>')[1]?.split('</CHARACTER_CARDS_FULL>')[0] ?? '';
  for (const entry of sources.slice(0, 2)) assert.ok(full.includes(entry.content), '必须完整保留资料，不裁切长分身条目');
  assert.equal(full.split('分身末尾保留').length - 1, 1);
  assert.ok(!full.includes(sources[2]!.content));
  assert.match(full, /不.*要求.*出场|不.*强制.*出场/u);
});

test('关联跟读双向有效；只有作者括号、共用姓氏不会建立关联', async () => {
  const sources = await fixtures();
  for (const direction of ['青漪相关墟境', '暮林相关墟境', '辰光相关墟境']) {
    const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({ requestId: direction,
      taskType: 'ruin', mode: 'active', query: `英雄纪元 旧港 ${direction}` });
    const ids = (result.bundle.taskAnchorAttachments ?? []).map(a => a.snapshotId);
    assert.equal(ids.includes(sources[0]!.snapshotId), direction.startsWith('青漪'));
    assert.equal(ids.includes(sources[1]!.snapshotId), direction.startsWith('青漪'));
  }
});

test('未进入开启语料的人物不因关联而凭空读取，模板和否定关系也不建立硬关联', async () => {
  const [queen, incarnation] = await fixtures();
  const result = await new UnifiedShadowRetrievalEngine([queen!]).retrieve({ requestId: 'enabled-only',
    taskType: 'ruin', mode: 'active', query: '英雄纪元 旧港 灰潮女王相关墟境' });
  assert.ok(!result.bundle.taskAnchorAttachments?.some(a => a.snapshotId === incarnation!.snapshotId));
  for (const text of ['她并非【灰潮女王】的分身。', '<% if (stage) { %>她是【灰潮女王】的分身。<% } %>']) {
    const other = await source(5, '[角色]夕枝', `姓名: 夕枝\n背景: ${text}`);
    const catalog = buildRetrievalIndex([queen!, other]).catalog;
    assert.ok(!catalog.relations.some(r => r.predicate === 'character_reference'));
  }
});

test('没有角色标签但姓名与称号有共证也能定位；触发键自身不创建身份', async () => {
  const queen = await source(10, '[DLC][作者乙]灰潮女王', '姓名: 雾澜·风庭\n称号: 灰潮女王\n背景: 守护旧港。', ['冒险者', '作者乙']);
  const catalog = buildRetrievalIndex([queen]).catalog;
  const person = catalog.entities.find(e => e.canonicalName === '雾澜·风庭')!;
  assert.ok(person.kinds.includes('person'));
  assert.ok(person.aliases.includes('灰潮女王'));
  assert.ok(!person.aliases.includes('作者乙'));
  const result = await new UnifiedShadowRetrievalEngine([queen]).retrieve({ requestId: 'untagged',
    taskType: 'ruin', mode: 'active', query: '英雄纪元 旧港 灰潮女王相关墟境' });
  assert.equal(result.bundle.taskAnchorAttachments?.[0]?.content, queen.content);
});

test('同段落另一个逗号分句的人物不能被误当作关系对象；关联只走一跳', async () => {
  const sources = await fixtures();
  const visitor = await source(6, '[角色]夕枝', '姓名: 夕枝\n背景: 她的本体是【灰潮女王】，她曾在途中见过暮林。');
  const student = await source(7, '[角色]雪羽', '姓名: 雪羽\n导师: 夕枝');
  const result = await new UnifiedShadowRetrievalEngine([...sources, visitor, student]).retrieve({ requestId: 'bounded',
    taskType: 'ruin', mode: 'active', query: '英雄纪元 旧港 灰潮女王相关墟境' });
  const ids = result.bundle.taskAnchorAttachments!.map(a => a.snapshotId);
  assert.ok(ids.includes(visitor.snapshotId));
  assert.ok(!ids.includes(sources[2]!.snapshotId));
  assert.ok(!ids.includes(student.snapshotId));
});

test('别名重复自身不制造歧义，同一称号属于多人则不强行合并或传播关系', async () => {
  const [queen] = await fixtures();
  const self = await source(8, '[角色]夕枝', '姓名: 夕枝\n别名: 夕枝\n本体: 灰潮女王');
  const catalog = buildRetrievalIndex([queen!, self]).catalog;
  assert.ok(catalog.relations.some(r => r.predicate === 'character_reference'));
  const rival = await source(9, '[角色]暮星', '姓名: 暮星\n别名: 灰潮女王');
  const ambiguous = buildRetrievalIndex([queen!, self, rival]).catalog;
  assert.ok(!ambiguous.relations.some(r => r.predicate === 'character_reference'));
  assert.ok(ambiguous.entities.some(e => e.canonicalName === '雾澜·风庭'));
  assert.ok(ambiguous.entities.some(e => e.canonicalName === '暮星'));
});
