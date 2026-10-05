import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_SNAPSHOT_SCHEMA, type SourceSnapshot } from '../src/retrieval/contracts.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { buildWorldKnowledgeCatalog } from '../src/retrieval/catalog.ts';
import { resolveAutomaticRuinRange } from '../src/runtime/ruinAutomaticRange.ts';
import type { RuinContextBundle } from '../src/core/context.ts';
import type { RuinGenerationInput } from '../src/schemas/ruin.ts';

const source = (id: string, title: string, content: string): SourceSnapshot => ({
  schema: SOURCE_SNAPSHOT_SCHEMA, logicalId: id, snapshotId: id, versionHash: id,
  sourceType: 'worldbook', title, content, metadata: {},
});
const empire = source('empire', '[势力]奥古斯提姆帝国', '势力-奥古斯提姆帝国:\n  概览:\n    首都: 艾瑟嘉德\n    统治者: 维奥莱塔·马克西姆·奥古斯塔女皇(第六层级 Lv24)\n    主要城市: 艾瑟嘉德(首都)，金谷城');
const queen = source('queen', '[DLC][角色][维奥莱塔]维奥莱塔(奥古斯提姆女皇)', '姓名: 维奥莱塔·马克西姆·奥古斯塔\n身份: 奥古斯提姆帝国女皇\n所在地: 大陆-奥古斯提姆帝国-艾瑟嘉德\n她偶尔阅读《勇者丝特拉》。');
const query = '复兴纪元\n大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德\n女皇在卧室内阅读《勇者丝特拉》时的趣闻';
async function retrieve(sources: SourceSnapshot[], text = query) {
  return (await new UnifiedShadowRetrievalEngine(sources).retrieve({ requestId: 'role', taskType: 'ruin', query: text, castRequirementQuery: text, mode: 'active' })).bundle;
}

test('称谓+层级地点召回无纪元人物全文，并绑定既定女皇而非原创替身', async () => {
  const bundle = await retrieve([empire, queen]);
  assert.ok(bundle.sourceSnapshots.some(item => item.logicalId === 'queen'));
  assert.equal(bundle.passages.find(item => item.snapshotId === 'queen')?.content, queen.content);
  assert.ok(bundle.castManifest?.entries.some(item => item.identity.canonicalName.includes('维奥莱塔') && item.disposition === 'required'));
  assert.ok(bundle.personCanonViews?.some(item => item.canonicalName.includes('维奥莱塔')));
});

test('散文身份、机构职责和标题之外的书名也能打开来源', async () => {
  const person = source('prose', '[角色]玛丽', '玛丽是奥古斯提姆帝国的女皇，居住在艾瑟嘉德。\n她喜欢阅读《勇者丝特拉》。');
  const bundle = await retrieve([person, source('geo', '[地点]艾瑟嘉德', '地点: 大陆-奥古斯提姆帝国-艾瑟嘉德')]);
  assert.ok(bundle.castManifest?.entries.some(item => item.identity.canonicalName === '玛丽' && item.disposition === 'required'));
  const book = source('book', '[书籍]勇者特典', '复兴纪元的通俗作品《勇者丝特拉》讲述了断剑英雄。');
  assert.ok((await retrieve([book])).sourceSnapshots.some(item => item.logicalId === 'book'));
});

test('同称谓异国不串人；两个有依据的同国称谓候选只读召回，不武断锁人', async () => {
  const foreign = source('foreign', '[角色]露西(别国女皇)', '身份: 梵尼亚女皇\n所在地: 梵尼亚');
  const bundle = await retrieve([empire, queen, foreign]);
  assert.ok(!bundle.castManifest?.entries.some(item => item.identity.canonicalName === '露西' && item.disposition === 'required'));
  const rival = source('rival', '[角色]安娜(奥古斯提姆女皇)', '身份: 奥古斯提姆帝国女皇\n所在地: 艾瑟嘉德');
  const ambiguous = await retrieve([queen, rival]);
  assert.ok(ambiguous.receipt.warnings.some(item => item.includes('尚不能唯一确定')));
  assert.ok(!ambiguous.castManifest?.entries.some(item => item.identity.kinds.includes('person') && item.disposition === 'required'));
});

test('世界书栏目和趣闻不是实体，ASCII地点链按实际层级建立关系', () => {
  const catalog = buildWorldKnowledgeCatalog([empire, queen, source('noise', '[组织]捕奴队', '趣闻: 普通轶事')], []);
  assert.ok(!catalog.entities.some(item => ['主要城市', '概览', '趣闻', '统治者'].includes(item.canonicalName)));
  assert.ok(catalog.entities.some(item => item.canonicalName === '艾瑟嘉德' && item.kinds.includes('place')));
  assert.ok(!catalog.entities.some(item => item.canonicalName === '大陆-奥古斯提姆帝国-艾瑟嘉德'));
});

test('提到女皇不等于本人是女皇，不把功能说明或模板代码当身份', async () => {
  const bystander = source('bystander', '[角色]路人', '路人昨日遇见女皇，在艾瑟嘉德听过她的故事。');
  const template = source('template', '[角色]代码人', '<% const text = "代码人是奥古斯提姆帝国的女皇"; %>');
  const bundle = await retrieve([empire, queen, bystander, template]);
  assert.ok(!bundle.castManifest?.entries.some(item => ['路人', '代码人'].includes(item.identity.canonicalName) && item.disposition === 'required'));
});

test('书名同称谓不强制演员；亲属方向只读关联，不把君主强塞进父辈史', async () => {
  const bookOnly = await retrieve([empire, queen], '复兴纪元 奥古斯提姆帝国 小说《女皇》的流传历史');
  assert.ok(!bookOnly.castManifest?.entries.some(item => item.reasons.includes('role-grounded-subject')));
  const relative = await retrieve([empire, queen], '复兴纪元 奥古斯提姆帝国 女皇父亲青年时的发家史');
  assert.ok(relative.sourceSnapshots.some(item => item.logicalId === 'queen'));
  assert.ok(!relative.castManifest?.entries.some(item => item.identity.canonicalName.includes('维奥莱塔') && item.disposition === 'required'));
  assert.ok(relative.receipt.warnings.some(item => item.includes('仅作资料参照')));
});

test('机构称谓也按本次地域具名证据定位，不依赖世界书标题', async () => {
  const shop = source('shop', '[地点]二叶杂货铺', '地点: 亚尔夫海姆-二叶杂货铺\n店长: 二叶（店长）');
  const person = source('owner', '[角色]二叶', '姓名: 二叶\n她是亚尔夫海姆二叶杂货铺的店长。');
  const bundle = await retrieve([shop, person], '神明纪元 亚尔夫海姆 二叶杂货铺 店长幼年时玩积木的往事');
  assert.ok(bundle.castManifest?.entries.some(item => item.identity.canonicalName === '二叶' && item.reasons.includes('role-grounded-subject')));
});

test('称谓确定人物后沿用生年包络，不随机落到既定女皇出生前', async () => {
  const bundle = await retrieve([empire, queen]);
  bundle.personTimeline = [{ name: '维奥莱塔·马克西姆·奥古斯塔', state: 'alive', narrative: '', lifespan: { born: { era: '复兴纪元', year: 470 } } }];
  const context: RuinContextBundle = { schema: 'eyon.context.v1', taskType: 'ruin', requestId: 'role', scope: { characterKey: 'fixture', chatId: 'fixture', triggerMessageId: 1 }, currentWorld: { time: '复兴纪元488年3月1日', location: '艾瑟嘉德' }, evidenceBundle: bundle, worldbookContext: [], recentContext: [], characterContext: [], genealogyRefs: [], biographyRefs: [], butterflyRefs: [], sourceIndex: [], warnings: [], sourceHash: 'fixture', actorPolicy: { autoGenealogy: false, requestedSubjects: [], referenceNames: [], genealogyActors: [], blockedGenealogy: [], unresolvedRelatives: [] } };
  const input: RuinGenerationInput = { era: '复兴纪元', start: null, end: null, location: '奥古斯提姆帝国-艾瑟嘉德', supplementaryDirection: '女皇阅读时的趣闻', selectedCharacters: [], wave: { level: 'stable', candidateCount: 3 }, materials: [] };
  const range = resolveAutomaticRuinRange(input, context);
  assert.equal(range.input.start?.year, 470); assert.equal(range.input.end?.year, 488);
});
