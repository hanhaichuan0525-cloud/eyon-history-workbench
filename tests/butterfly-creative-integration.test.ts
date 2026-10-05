import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';
import { ButterflyScopeSchema } from '../src/schemas/butterfly.ts';
import { buildButterflyApiPrompt } from '../src/prompts/butterfly.ts';
import { serializeButterflyPanel } from '../src/renderers/butterfly.ts';
import { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import { RuntimeShadowRetrievalObserver, type RuntimeShadowCaptureInput } from '../src/retrieval/runtimeShadow.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import type { ButterflyRequest } from '../src/schemas/butterfly.ts';

const namespace = { characterKey: '命定之诗', chatId: 'creative-integration' };
const longAction = '我把一台新织机留给了山村，村民确认收下。'.repeat(500);
const longProfile = '姓名: 蓓若\n种族: 人类\n身份: 织工\n经历: 蓓若在复兴纪元470年学习织布。\n'
  + '她和村民把织物用于节庆与日常。'.repeat(300) + '\n原文结尾不能丢失。';
const wb = (uid: number, title: string, content: string): RuntimeWorldbookSource => ({
  sourceId: `worldbook:test:${uid}`, title, content, strategyType: 'selective', keywords: [],
  worldbook: {
    schema: 'eyon.retrieval.worldbook-metadata.v1', logicalId: `worldbook:test:${uid}`,
    worldbookName: 'test', uid, bindingScopes: ['character-primary'], enabled: true,
    strategy: { type: 'selective', primaryKeys: [], secondary: { logic: 'and_any', keys: [] }, scanDepth: 'same_as_global' },
    position: null, probability: null, recursion: null, effect: null, extra: {},
  },
});
const book = [
  wb(1, '[角色]蓓若', longProfile),
  wb(2, '[变量][mvu_update]变量更新规则', 'variables_update_rules:\n世界:\n  时间:\n    check: 随织工蓓若的剧情推进更新\n主角: JSONPatch变量更新'),
  wb(3, '[角色][变量更新规则]织工阿织', '<阿织 角色详情>\n姓名: 阿织\n种族: 构装体\n背景故事: 阿织与蓓若共同织布。\n</阿织 角色详情>\nvariables_update_rules:\nJSONPatch'),
  wb(4, '[角色]EJS蓓若补充', '<%_ { const profile = { name: "蓓若", back_story: "乡间织工，喜爱织花布" }; } _%>\n蓓若与乡间节庆有关。'),
  wb(5, '[本体][额外设定]技能装备道具生成规则', '生成格式: 描述与标签\n世界设定: 蓓若使用的织工徽记可认证织物，在市集流通。'),
];

async function freeze(withReferences = true) {
  let captured!: RuntimeShadowCaptureInput;
  const observer = new RuntimeShadowRetrievalObserver();
  const assembler = new TavernButterflyContextAssembler({
    getCurrentCharacterName: () => namespace.characterKey, getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 3,
    getChatMessages: () => [
      { message_id: 1, role: 'assistant', message: '复兴纪元470年，山村的织机损坏了。' },
      { message_id: 2, role: 'user', message: longAction },
      { message_id: 3, role: 'user', message: '遣返' },
    ],
  } as never, {
    async getWorldbookCorpus() {
      return { sources: book, receipt: {
        schema: 'eyon.retrieval.worldbook-corpus.v1', complete: true,
        bindings: [{ worldbookName: 'test', scopes: ['character-primary'] }],
        entries: book.map(s => ({ logicalId: s.worldbook.logicalId, sourceId: s.sourceId,
          worldbookName: 'test', uid: s.worldbook.uid, title: s.title,
          bindingScopes: ['character-primary'], enabled: true, status: 'retrievable' })),
        counts: { total: book.length, enabled: book.length, retrievable: book.length,
          disabled: 0, empty: 0, 'user-excluded': 0, 'routed-generated': 0 },
      } };
    },
    async getCharacterSources() { return []; }, async getGenealogySources() { return []; },
    async getBiographySources() { return []; }, async getButterflySources() { return []; },
  } as never, {
    async getButterflyFreezeSnapshot() { return {
      runId: 'run-creative', reality: { time: '复兴纪元488年', location: '海港借阅台' },
      ruinEntry: { time: '复兴纪元470年', location: '山村' },
      ruinExit: { time: '复兴纪元470年', location: '山村' },
    }; },
  } as never, { async capture(input) { captured = input; return observer.capture(input); } });
  const frozen = await assembler.freeze({ namespace, requestId: 'creative-test', userMessageId: 3,
    rawCommand: '遣返', triggerType: 'button', roll: 1,
    ...(withReferences ? { creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES,
      focus: '蓓若与乡间的织物', domain: '风俗与日常', scope: '大陆', absurdity: 100,
      evolution: '曲折扩散', mood: '黑色幽默' } } : {}),
  });
  return { ...frozen, captured };
}

test('大陆进入既有结果枚举，原八种范围仍兼容，不强制匹配偏好范围', () => {
  for (const scope of ['个人', '双人', '小队', '聚落', '城市', '省份级地区', '国家', '跨国', '大陆'])
    assert.equal(ButterflyScopeSchema.safeParse(scope).success, true);
  assert.equal(ButterflyScopeSchema.safeParse('顺势生长').success, false);
});

test('关注与领域进入真实检索，关注人物只推荐，长行动/长人物/EJS/混合设定保留', async () => {
  const frozen = await freeze();
  assert.match(frozen.captured.query, /蓓若与乡间的织物/u);
  assert.match(frozen.captured.query, /风俗与日常/u);
  assert.doesNotMatch(frozen.captured.castRequirementQuery ?? '', /蓓若/u);
  assert.ok(frozen.activeEvidence?.castManifest?.some(e => e.canonicalName === '蓓若' && e.disposition === 'recommended'));
  assert.ok(frozen.request.sourceIndex.some(s => s.content.includes(longProfile)));
  assert.ok(frozen.request.playerInterventions.some(s => s.content === longAction));
  assert.ok(frozen.captured.candidates.some(s => s.sourceId === 'worldbook:test:4' && s.content === book[3].content));
  assert.ok(frozen.captured.candidates.some(s => s.sourceId === 'worldbook:test:5' && s.content === book[4].content));
});

test('仅变量协议被消费端隔离，完整语料回执/混合人物条目/原始provider不被改写', async () => {
  const frozen = await freeze();
  assert.ok(!frozen.captured.candidates.some(s => s.sourceId === 'worldbook:test:2'));
  assert.ok(!frozen.request.sourceIndex.some(s => s.sourceId === 'worldbook:test:2'));
  assert.ok(frozen.captured.candidates.some(s => s.sourceId === 'worldbook:test:3'));
  assert.equal(frozen.captured.worldbookCorpusReceipt?.counts.total, 5);
  assert.equal(book[1].content.includes('JSONPatch'), true);
});

test('新方案位于完整资料之后，投递骰子仅含回显编号；旧冻结保留骰子范围', async () => {
  const modern = await freeze();
  const rules = { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' };
  const prompt = buildButterflyApiPrompt({ request: modern.request, rules });
  assert.ok(prompt.indexOf('<BUTTERFLY_CREATIVE_REFERENCES>') > prompt.indexOf('</EYON_BUTTERFLY_REQUEST_JSON>'));
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.deepEqual(payload.dice, { roll: 1 });
  assert.deepEqual(modern.request.dice, { roll: 1, scope: '个人' }, '仅投递视图降噪，不修改冻结协议');
  assert.equal(prompt.split(longAction).length - 1, 1);
  assert.match(prompt, /模板.*不.*既有角色|生成.*模板/u);
  assert.match(prompt, /本轮创作/u);
  const legacy = await freeze(false);
  const legacyPrompt = buildButterflyApiPrompt({ request: legacy.request, rules });
  assert.ok(legacyPrompt.includes('"scope":"个人"'));
  assert.doesNotMatch(legacy.captured.query, /蓓若与乡间的织物/u);
});

const readRegex = () => JSON.parse(readFileSync(new URL('../regex/regex-伊雍-蝴蝶效应面板美化（as）.json', import.meta.url), 'utf8'));
const panel = (modern: boolean) => serializeButterflyPanel({ roll: 42, scope: '大陆',
  presentLanding: '旅途中的村落。', perceptibleEvidence: ['节庆织花'], ruinActionRecord: '留下织机。',
  historicalEvolution: '开头一段。\n\n' + '演化中的人生。'.repeat(1000) + '\n结尾完整。',
  historicalKeywords: ['织机', '蓓若', '节庆', '传承'] }, { creativeReferences: modern });
function render(text: string) { const r = readRegex(); const slash = r.findRegex.lastIndexOf('/');
  return text.replace(new RegExp(r.findRegex.slice(1, slash), r.findRegex.slice(slash + 1)), r.replaceString); }

test('只改原面板：新旧序列均显示真实范围，不把骰点/顺势演化标为范围或影响层级', () => {
  const r = readRegex(); assert.equal(r.id, 'eyon-butterfly-single-regex-v1');
  assert.deepEqual(r.placement, [2]); assert.equal(r.markdownOnly, true); assert.equal(r.promptOnly, false);
  assert.equal(r.maxDepth, 8); assert.equal(r.runOnEdit, true);
  for (const modern of [false, true]) {
    const html = render(panel(modern));
    assert.match(html, /<span>波及范围<\/span><strong>大陆<\/strong>/u);
    assert.doesNotMatch(html, /影响层级|<strong>42<\/strong>|<strong>顺势演化<\/strong>/u);
    assert.match(html, /结尾完整。/u); assert.match(html, /开头一段。\n\n/u);
  }
});

test('多面板独立替换，残缺面板不跨越下一面板吞正文，普通文本不变', () => {
  const two = render('之前\n' + panel(false) + '\n中间\n' + panel(true) + '\n之后');
  assert.equal(two.match(/data-eyon-butterfly="1"/gu)?.length, 2);
  assert.match(two, /中间/u); assert.ok(two.endsWith('之后'));
  const broken = '<butterfly_panel>\n[波及范围|1|个人]\n[现世落点|未闭合';
  const mixed = render(broken + '\n' + panel(true));
  assert.ok(mixed.startsWith(broken), '不从残缺面板借用下一面板字段');
  assert.equal(mixed.match(/data-eyon-butterfly="1"/gu)?.length, 1);
  assert.equal(render('不含面板的普通正文'), '不含面板的普通正文');
});
