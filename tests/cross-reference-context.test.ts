import assert from 'node:assert/strict';
import test from 'node:test';

import { TavernBiographyContextAssembler } from '../src/runtime/biographyContext.ts';
import { createBiographyEvidenceResolver } from '../src/runtime/biographyEvidence.ts';
import type {
  RuntimeChatMessage,
  RuntimeContextSourceProvider,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import { TavernGenealogyContextAssembler } from '../src/runtime/genealogyContext.ts';
import { TavernRuinContextAssembler } from '../src/runtime/ruinContext.ts';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';

class ContextRuntime implements TavernRuntime {
  getCurrentCharacterName() { return '命定之诗'; }
  getCurrentChatId() { return '交叉参考测试'; }
  getLastMessageId() { return 10; }
  getMessageSwipeId() { return 0; }
  getChatMessages(): RuntimeChatMessage[] {
    return [{
      message_id: 10,
      role: 'user',
      message: '检索既有史料。',
      swipe_id: 0,
    }];
  }
  async setChatMessages() {}
  setExtensionPrompt() {}
  async generate() { return ''; }
  async generateRaw() { return ''; }
}

const source = (sourceId: string, title: string) => ({
  sourceId,
  title,
  content: `${title}的结构化资料`,
});

const worldbookSource = (): RuntimeWorldbookSource => ({
  ...source('worldbook:core:1', '核心世界书'),
  strategyType: 'selective',
  keywords: [],
  worldbook: {
    schema: 'eyon.retrieval.worldbook-metadata.v1',
    logicalId: 'worldbook:core:1',
    worldbookName: 'core',
    uid: 1,
    bindingScopes: ['character-primary'],
    enabled: true,
    strategy: {
      type: 'selective',
      primaryKeys: [],
      secondary: { logic: 'and_any', keys: [] },
      scanDepth: 'same_as_global',
    },
    position: null,
    probability: null,
    recursion: null,
    effect: null,
    extra: {},
  },
});

const sources: RuntimeContextSourceProvider = {
  async getCurrentWorld() {
    return { time: '复兴纪元488年', location: '金谷城' };
  },
  async getWorldbookCorpus() {
    const book = [worldbookSource()];
    return {
      sources: book,
      receipt: {
        schema: 'eyon.retrieval.worldbook-corpus.v1',
        complete: true,
        bindings: [{ worldbookName: 'core', scopes: ['character-primary'] }],
        entries: book.map(source => ({
          logicalId: source.worldbook.logicalId,
          sourceId: source.sourceId,
          worldbookName: source.worldbook.worldbookName,
          uid: source.worldbook.uid,
          title: source.title,
          bindingScopes: ['character-primary'],
          enabled: true,
          status: 'retrievable',
        })),
        counts: {
          total: book.length,
          enabled: book.length,
          retrievable: book.length,
          disabled: 0,
          empty: 0,
          'user-excluded': 0,
          'routed-generated': 0,
        },
      },
    };
  },
  async getWorldbookSources() {
    return [worldbookSource()];
  },
  async getCharacterSources() {
    return [source('mvu-character:维奥莱塔', '维奥莱塔')];
  },
  async getGenealogySources() {
    return [source('genealogy:violetta', '维奥莱塔宗族谱系')];
  },
  async getBiographySources() {
    return [source('biography:violetta', '维奥莱塔传记')];
  },
  async getButterflySources() {
    return [];
  },
};

const scope = {
  requestId: 'cross-reference-request',
  namespace: { characterKey: '命定之诗', chatId: '交叉参考测试' },
  triggerMessageId: 10,
  directive: '生成维奥莱塔的历史资料',
};

function biographyPurposeProvider(): RuntimeContextSourceProvider {
  const entries = [
    { title: '[DLC][命定系统]伊雍核心(作者)',
      content: '工作台操作说明：伊雍在雾晶港提供寻根溯源。\n命定契约：成功签约且决定带回才可赎出现世。',
      keywords: ['寻根溯源', '伊雍核心', '命定契约'] },
    { title: '[器物]黄铜天平', content: '雾晶港工匠的黄铜天平，用于称量盐与谷物。', keywords: ['黄铜天平'] },
  ].map((item, uid): RuntimeWorldbookSource => ({
    ...worldbookSource(), ...item, sourceId: `worldbook:purpose:${uid}`,
    worldbook: { ...worldbookSource().worldbook, logicalId: `worldbook:purpose:${uid}`, uid,
      strategy: { ...worldbookSource().worldbook.strategy, primaryKeys: item.keywords } },
  }));
  return {
    ...sources,
    async getCurrentWorld() { return { time: '复兴纪元488年', location: '雾晶港' }; },
    async getWorldbookCorpus() {
      const corpus = await sources.getWorldbookCorpus!();
      return { sources: entries, receipt: { ...corpus.receipt,
        counts: { ...corpus.receipt.counts, total: 2, enabled: 2, retrievable: 2 },
        entries: entries.map(item => ({ ...corpus.receipt.entries[0]!,
          sourceId: item.sourceId, logicalId: item.worldbook.logicalId, uid: item.worldbook.uid, title: item.title })),
      } };
    },
  };
}

test('传记正式Active检索不把共享地点命中的运行核心投成史料', async () => {
  const provider = biographyPurposeProvider();
  const context = await new TavernBiographyContextAssembler(new ContextRuntime(),
    provider, new RuntimeShadowRetrievalObserver()).assemble({
    ...scope, directive: '雾晶港 黄铜天平 的历史',
  });
  assert.ok(context.worldbookContext.some(item => item.title.includes('黄铜天平')));
  assert.ok(!context.sourceIndex.some(item => item.title.includes('伊雍核心')));
  assert.ok(!context.evidenceBundle.sourceSnapshots.some(item => item.title.includes('伊雍核心')));
  assert.ok(!context.evidenceBundle.taskAnchorAttachments?.some(item => item.content.includes('工作台操作说明')));
  assert.equal(context.evidenceBundle.receipt.worldbookCorpus?.counts.enabled, 2);
  assert.deepEqual(await createBiographyEvidenceResolver(provider)(['伊雍核心'], ['worldbook:purpose:0'], context), []);
});

test('传记明确研究伊雍核心仍可读取，其他模块的契约检索不变', async () => {
  const provider = biographyPurposeProvider(), observer = new RuntimeShadowRetrievalObserver();
  const context = await new TavernBiographyContextAssembler(new ContextRuntime(), provider, observer)
    .assemble({ ...scope, directive: '对伊雍核心进行寻根溯源' });
  assert.ok(context.sourceIndex.some(item => item.title.includes('伊雍核心')));
  const supplement = await createBiographyEvidenceResolver(provider)(['伊雍核心'], [], context);
  assert.ok(supplement.some(item => item.content.includes('成功签约且决定带回')));
  const ruin = await new TavernRuinContextAssembler(new ContextRuntime(), provider, async () => new Set(), observer)
    .assemble({ ...scope, directive: '命定契约' });
  assert.ok(ruin.sourceIndex.some(item => item.title.includes('伊雍核心')));
});

test('传记生成读取已提交谱系，谱系生成读取已提交传记', async () => {
  const runtime = new ContextRuntime();
  const observer = new RuntimeShadowRetrievalObserver();
  const biography = await new TavernBiographyContextAssembler(
    runtime,
    sources,
    observer,
  ).assemble(scope);
  const genealogy = await new TavernGenealogyContextAssembler(
    runtime,
    sources,
    observer,
  ).assemble(scope);

  assert.deepEqual(
    biography.genealogyContext.map(item => item.sourceId),
    ['genealogy:violetta'],
  );
  assert.deepEqual(
    genealogy.biographyRefs.map(item => item.sourceId),
    ['biography:violetta'],
  );
});

test('墟境生成同时读取谱系与传记，但保持为不同来源类型', async () => {
  const context = await new TavernRuinContextAssembler(
    new ContextRuntime(),
    sources,
    async () => new Set(['violetta']),
    new RuntimeShadowRetrievalObserver(),
  ).assemble(scope);
  assert.deepEqual(
    context.genealogyRefs.map(item => [item.sourceId, item.sourceType]),
    [['genealogy:violetta', 'genealogy']],
  );
  assert.deepEqual(
    context.biographyRefs.map(item => [item.sourceId, item.sourceType]),
    [['biography:violetta', 'biography']],
  );
  const selectedBiography = context.biographyRefs[0]?.content ?? '';
  const digestIndex = selectedBiography.indexOf('【引用传记连续性摘要】');
  const fullIndex = selectedBiography.indexOf('【引用传记原文】');
  assert.ok(digestIndex >= 0, '显式引用传记应先注入连续性摘要');
  assert.ok(fullIndex > digestIndex, '传记原文应位于连续性摘要之后');
});

const familySource = () => {
  const person = (id: string, name: string, aliases: string[], relationToFocus: string, year: number) => ({
    id, name, aliases, relationToFocus,
    birth: { status: 'known', era: '复兴纪元', year, label: `复兴纪元${year}年` },
    death: { status: 'alive', era: '', year: null, label: '在世' },
    identities: ['翼民工匠'], professions: ['抄工'], summary: '长期生活于梵尼亚。',
  });
  return { sourceId: 'genealogy:ling', title: '玲山宗族谱系（当前局部）', content: JSON.stringify({
    schema: 'eyon.genealogy.current.v1',
    nodes: [person('ling', '玲山·哈姆斯沃思', ['玲山'], '本人', 461), person('father', '瓦伦·哈姆斯沃思', ['瓦伦'], '父亲', 435)],
    edges: [{ from: 'father', to: 'ling', relationType: 'parent', label: '父女' }],
  }) };
};

test('正式墟境上下文控制谱系演员来源，指定父亲被解析召回且名册与资格一致', async () => {
  const provider: RuntimeContextSourceProvider = { ...sources,
    async getGenealogySources() { return [familySource()]; },
    async getCharacterSources() { return [{ sourceId: 'mvu-character:ling', title: '玲山·哈姆斯沃思', content: JSON.stringify({ 姓名: '玲山·哈姆斯沃思', 身份: '报社社长', 年龄: '27岁' }) }]; },
    async getBiographySources() { return []; },
  };
  const observer = new RuntimeShadowRetrievalObserver();
  const assembler = new TavernRuinContextAssembler(new ContextRuntime(), provider, undefined, observer);
  const request = {
    ...scope, directive: '复兴纪元 奥古斯提姆帝国 探讨玲山父亲的发家史',
    castRequirementQuery: '探讨玲山父亲的发家史', territorialReferences: ['奥古斯提姆帝国'],
    actorSelection: { autoGenealogy: false, location: '奥古斯提姆帝国', supplementaryDirection: '探讨玲山父亲的发家史', selectedCharacters: [] },
  };
  const context = await assembler.assemble(request);
  assert.deepEqual(context.actorPolicy?.requestedSubjects, ['瓦伦·哈姆斯沃思']);
  assert.ok(context.genealogyRefs.some(source => source.title.includes('瓦伦')));
  assert.ok(!context.genealogyRefs.some(source => source.sourceId === 'genealogy:ling'));
  const manifest = context.evidenceBundle.castManifest!;
  const father = manifest.entries.find(entry => entry.identity.canonicalName === '瓦伦·哈姆斯沃思');
  assert.equal(father?.disposition, 'required');
  assert.ok(manifest.entries.filter(entry => entry.identity.canonicalName === '玲山·哈姆斯沃思').every(entry => entry.disposition !== 'required'));
  assert.equal(context.evidenceBundle.personTimeline?.find(person => person.name === '瓦伦·哈姆斯沃思')?.lifespan?.born?.year, 435);
  const ordinary = await assembler.assemble({ ...request, requestId: 'without-genealogy', directive: '复兴纪元 奥古斯提姆帝国工坊史', castRequirementQuery: '奥古斯提姆帝国工坊史', actorSelection: { ...request.actorSelection, supplementaryDirection: '' } });
  assert.deepEqual(ordinary.genealogyRefs, []);
  assert.deepEqual(ordinary.actorPolicy?.genealogyActors, []);
});

test('传记按楼层数量取聊天，已取正文与旧传记各段完整保留', async () => {
  const longChats: RuntimeChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    message_id: index + 1,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    message: `长消息${index + 1}：${'甲'.repeat(4000)}`,
    swipe_id: 0,
  }));
  class LongRuntime implements TavernRuntime {
    getCurrentCharacterName() { return '命定之诗'; }
    getCurrentChatId() { return '交叉参考测试'; }
    getLastMessageId() { return 12; }
    getMessageSwipeId() { return 0; }
    // 与真实宿主一致：按 range 过滤楼层（源码按 RECENT_MESSAGE_LIMIT=6 请求 '7-12'）
    getChatMessages(range: number | string): RuntimeChatMessage[] {
      if (typeof range === 'number') {
        return longChats.filter(message => message.message_id === range);
      }
      const [start, end] = String(range).split('-').map(Number);
      return longChats.filter(message =>
        message.message_id >= start && message.message_id <= end);
    }
    async setChatMessages() {}
    setExtensionPrompt() {}
    async generate() { return ''; }
    async generateRaw() { return ''; }
  }
  const fullBiography = JSON.stringify({
    schema: 'eyon.biography.v1',
    target: { name: '维奥莱塔', aliases: ['铁血女皇'] },
    span: { label: '24岁至28岁' },
    summary: '关于欲望与责任的传记。',
    origin: { title: '起源(二十四岁)', content: '起'.repeat(2000) },
    stages: Array.from({ length: 5 }, (_, index) => ({
      title: `第${index + 1}时期`,
      span: `${24 + index}岁`,
      content: '段'.repeat(2000),
    })),
    status: { title: '现状(二十八岁)', content: '现'.repeat(2000) },
  });
  const bioSources: RuntimeContextSourceProvider = {
    ...sources,
    async getBiographySources() {
      return [{
        sourceId: 'biography:violetta',
        title: '维奥莱塔传记',
        content: fullBiography,
      }];
    },
  };

  const context = await new TavernBiographyContextAssembler(
    new LongRuntime(),
    bioSources,
    new RuntimeShadowRetrievalObserver(),
  ).assemble({ ...scope, triggerMessageId: 12 });

  assert.ok(context.recentContext.length <= 6, `聊天条数 ${context.recentContext.length} 应≤6`);
  for (const chat of context.recentContext) {
    assert.equal(chat.content, longChats.find(item => `chat:${item.message_id}` === chat.sourceId)?.message);
  }
  const bio = context.biographyRefs[0];
  assert.ok(bio, '应选中已提交传记');
  assert.ok(
    bio.content.startsWith('{"schema":"eyon.biography.digest.v2'),
    `应注入结构化摘要而非全文：${bio.content.slice(0, 80)}`,
  );
  const full = JSON.parse(fullBiography), projected = JSON.parse(bio.content);
  assert.equal(projected.origin.content, full.origin.content);
  assert.deepEqual(projected.stages.map((stage: { content: string }) => stage.content), full.stages.map((stage: { content: string }) => stage.content));
  assert.equal(projected.status.content, full.status.content);
  assert.ok(bio.content.includes('维奥莱塔'));
});
