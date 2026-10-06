import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { buildRuinOutlineBatchApiPrompt } from '../src/prompts/ruin.ts';
import { RuinGenerationInputSchema } from '../src/schemas/ruin.ts';

async function retrieve(records: string[][], query: string, taskType = 'ruin' as const) {
  const snapshots = await Promise.all(records.map(([title, content], i) => createSourceSnapshot({
    logicalId: `worldbook:followup:${i}`, sourceType: 'worldbook', title: title!, content: content!,
    metadata: { schema: 'eyon.retrieval.worldbook-metadata.v1',
      strategy: { primaryKeys: i === 0 ? ['骸响龙姬'] : [], secondary: { keys: [] } } },
  })));
  const { bundle } = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({
    requestId: query, taskType, query, mode: 'active',
  });
  for (const p of bundle.passages) {
    const raw = snapshots.find(s => s.snapshotId === p.snapshotId)!;
    assert.equal(p.content, raw.content.slice(p.startOffset, p.endOffset).trim());
  }
  return { bundle, selected: bundle.sourceSnapshots.map(s => s.logicalId) };
}

test('仅点事件主题、未点人名、未写精确纪元时仍召回两位真实关联人物', async () => {
  const records = [
    ['[历史事件]骸响龙姬的远古约定', '远古时期，骸响龙姬指艾莉希雅与奥希莉雅二人共同守护雪岭的历史。艾莉希雅将龙骸交给奥希莉雅保管。'],
    ['[角色]艾莉希雅', '姓名: 艾莉希雅\n背景故事: 远古时期与奥希莉雅共同守护雪岭。'],
    ['[角色]奥希莉雅', '姓名: 奥希莉雅\n背景故事: 远古时期保管龙骸。'],
    ['[角色]雪岭店员', '姓名: 雪岭店员\n背景故事: 在雪岭杂货铺做生意。'],
  ];
  const { bundle, selected } = await retrieve(records, '神明纪元 探索骸响龙姬相关墟境');
  for (const i of [0, 1, 2]) assert.ok(selected.includes(`worldbook:followup:${i}`), String(i));
  for (const name of ['艾莉希雅', '奥希莉雅']) {
    assert.ok(bundle.taskAnchorAttachments?.some(a => a.canonicalName === name));
    assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === name && e.disposition === 'required'));
  }
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '雪岭店员'));
});

test('模糊年代的主题匹配可保留，明确异纪元的事件仍不可冒充当期事实', async () => {
  const { bundle, selected } = await retrieve([
    ['[历史事件]雾钟祭', '远古时期，雾钟祭曾在海湾举行。'],
    ['[历史事件]铁桥战役', '复兴纪元480年，铁桥战役摧毁新式铁路。'],
    ['[地点]海湾', '海湾有许多居民。'],
  ], '神明纪元 雾钟祭与铁桥战役');
  assert.ok(selected.includes('worldbook:followup:0'));
  assert.ok(!selected.includes('worldbook:followup:1'));
  assert.ok(bundle.receipt.rejected.some(r => r.reason === 'temporal-scope-incompatible'));
});

test('混合世界规则的格式标题不再成为演员，认证徽记世界事实与全文仍在', async () => {
  const content = '# 道具生成格式\n名称: XXX\n标签: [徽记: XXX]\n## 徽记标签\n世界设定: 有徽记为认证物品，可在正规市场流通。';
  const { bundle } = await retrieve([['[装备]技能装备道具生成规则', content]],
    '有徽记为认证物品 可在正规市场流通\n<div class="panel">道具生成格式</div><style>.panel{color:red}</style>');
  assert.equal(bundle.sourceSnapshots[0]?.content, content);
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '道具生成格式'));
});

test('样式和模板输出不是实体共证，真实变量值不被整个删除', async () => {
  const { bundle, selected } = await retrieve([
    ['[角色]潮汐守卫', '姓名: 潮汐守卫\n背景故事: 曾保护港口居民。'],
    ['[角色]纸灯', '姓名: 纸灯\n背景故事: 纸灯是船工。'],
  ], '纸灯救人。<style>.潮汐守卫{color:red}</style><% const x = "潮汐守卫"; %>\n<UpdateVariable><JSONPatch>[{"op":"replace","path":"/关系列表/纸灯/状态","value":"已立契约，仍在世"}]</JSONPatch></UpdateVariable>');
  assert.ok(selected.includes('worldbook:followup:1'));
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '潮汐守卫'));
  assert.ok(bundle.query.includes('已立契约，仍在世'), '原始请求不改写');
});

test('上游称谓已确定主体后，完整附件按同一实体送达而非再要求全名输入', async () => {
  const content = '姓名: 桥苏\n身份: 青葭村长\n背景故事: 桥苏常在清晨照料花圃。\n' + '村里的往事。'.repeat(1000) + '\n尾部锁定事实：村长从未离开故乡。';
  const { bundle } = await retrieve([['[角色]桥苏', content]], '桥苏的花圃');
  assert.ok(bundle.castManifest?.entries.some(e => e.identity.canonicalName === '桥苏' && e.disposition === 'required'));
  // 模拟已经由 role resolver 定位的称谓；出口不得自行再筛一次名字。
  const generationInput = RuinGenerationInputSchema.parse({ era: '复兴纪元', start: null, end: null,
    location: '青葭村', supplementaryDirection: '村长清晨的花圃趣事', selectedCharacters: [],
    autoGenealogy: false, wave: { level: 'ripple', candidateCount: 3 },
    materials: ['stable', 'transition', 'turbulent'].map((periodType, i) => ({
      candidateKey: `candidate-${i + 1}`, periodType, background: '日常生活', conflict: '误会', trigger: '交谈',
    })) });
  const context = { schema: 'eyon.context.v1' as const, taskType: 'ruin' as const, requestId: 'role-exit',
    scope: { characterKey: '测试', chatId: '测试', triggerMessageId: 10 },
    currentWorld: { time: '复兴纪元488年', location: '青葭村' }, worldbookContext: [], recentContext: [],
    characterContext: [], genealogyRefs: [], biographyRefs: [], butterflyRefs: [], sourceIndex: [],
    evidenceBundle: bundle, warnings: [], sourceHash: 'offline' };
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId: 'role-exit', directive: '村长的花圃',
    generationInput, context, rules: { generationContract: '离线附件出口回归' } });
  assert.ok(prompt.includes(content));
  assert.ok(prompt.includes('参考不等于要求出场'));
});
