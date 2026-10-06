import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';

async function engine() {
  const records = [
    ['艾琳一号', '姓名: 艾琳一号\n种族: 构装体\n身份: 档案员\n背景故事: 艾琳一号由军港制造，启动不是出生。'],
    ['艾琳·思衡托', '姓名: 艾琳·思衡托\n种族: 人类\n身份: 学者\n背景故事: 艾琳·思衡托研究星象。'],
  ];
  return new UnifiedShadowRetrievalEngine(await Promise.all(records.map(([name, content], i) =>
    createSourceSnapshot({ logicalId: `worldbook:identity:${i}`, sourceType: 'worldbook',
      title: `[角色]${name}`, content: content!, metadata: {} }))));
}

test('完整人名内的他人短名不能升级成第二位必需演员', async () => {
  for (const taskType of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
    const { bundle } = await (await engine()).retrieve({ requestId: taskType, taskType,
      query: '艾琳一号的经历', mode: 'active' });
    assert.ok(bundle.castManifest?.entries.some(e => e.identity.canonicalName === '艾琳一号'));
    assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '艾琳·思衡托'
      && e.disposition === 'required'), taskType);
    assert.ok(!bundle.taskAnchorAttachments?.some(a => a.canonicalName === '艾琳·思衡托'
      && a.purpose === 'direct-character-entry'));
  }
});

test('亲属/创造者方向不把完整名字内的他人短名升级为主体', async () => {
  const { bundle } = await (await engine()).retrieve({ requestId: 'creator', taskType: 'genealogy',
    query: '艾琳一号的创造者与前代型号', mode: 'active' });
  assert.ok(bundle.taskAnchorAttachments?.some(a => a.title.includes('艾琳一号')));
  assert.ok(!bundle.castManifest?.entries.some(e => e.identity.canonicalName === '艾琳·思衡托'
    && e.disposition === 'required'));
});

test('两位独立点名或独立使用已验证短名时仍能共同召回，顺序不影响身份', async () => {
  for (const query of ['艾琳一号与艾琳·思衡托', '艾琳·思衡托与艾琳一号', '艾琳一号与艾琳的合作']) {
    const { bundle } = await (await engine()).retrieve({ requestId: query, taskType: 'ruin', query });
    for (const name of ['艾琳一号', '艾琳·思衡托']) assert.ok(bundle.castManifest?.entries
      .some(e => e.identity.canonicalName === name && e.disposition === 'required'), query);
  }
});
