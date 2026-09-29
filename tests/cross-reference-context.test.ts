import assert from 'node:assert/strict';
import test from 'node:test';

import { TavernBiographyContextAssembler } from '../src/runtime/biographyContext.ts';
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

test('传记上下文收紧：聊天上限 6 条×2000 字，旧传记注入摘要而非全文', async () => {
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
    assert.ok(chat.content.length <= 2000, `聊天内容 ${chat.content.length} 应≤2000`);
  }
  const bio = context.biographyRefs[0];
  assert.ok(bio, '应选中已提交传记');
  assert.ok(
    bio.content.startsWith('{"schema":"eyon.biography.digest.v2'),
    `应注入结构化摘要而非全文：${bio.content.slice(0, 80)}`,
  );
  assert.ok(bio.content.length < 4200, `摘要长度 ${bio.content.length} 应<4200`);
  assert.ok(bio.content.includes('…'), '长篇摘要应同时保留段首与段尾');
  assert.ok(bio.content.includes('维奥莱塔'));
});
