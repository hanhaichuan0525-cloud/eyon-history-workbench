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

async function freeze(withReferences = true, options: { draft?: string; beforeCreate?: boolean; entryOnly?: boolean; books?: RuntimeWorldbookSource[] } = {}) {
  let captured!: RuntimeShadowCaptureInput;
  const books = options.books ?? book;
  const userMessageId = options.entryOnly ? 2 : 3;
  const rawCommand = options.draft ?? '遣返';
  const messages = [
    { message_id: 1, role: 'assistant', message: '复兴纪元470年，山村的织机损坏了。' },
    ...(options.entryOnly ? [] : [{ message_id: 2, role: 'user', message: longAction }]),
    ...(options.beforeCreate ? [] : [{ message_id: userMessageId, role: 'user', message: rawCommand }]),
  ];
  const observer = new RuntimeShadowRetrievalObserver();
  const assembler = new TavernButterflyContextAssembler({
    getCurrentCharacterName: () => namespace.characterKey, getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => messages.at(-1)!.message_id,
    getChatMessages: () => messages,
  } as never, {
    async getWorldbookCorpus() {
      return { sources: books, receipt: {
        schema: 'eyon.retrieval.worldbook-corpus.v1', complete: true,
        bindings: [{ worldbookName: 'test', scopes: ['character-primary'] }],
        entries: books.map(s => ({ logicalId: s.worldbook.logicalId, sourceId: s.sourceId,
          worldbookName: 'test', uid: s.worldbook.uid, title: s.title,
          bindingScopes: ['character-primary'], enabled: true, status: 'retrievable' })),
        counts: { total: books.length, enabled: books.length, retrievable: books.length,
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
  const frozen = await assembler.freeze({ namespace, requestId: 'creative-test', userMessageId,
    rawCommand, triggerType: 'button', roll: 1,
    ...(withReferences ? { creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES,
      focus: '蓓若与乡间的织物', domain: '风俗与日常', scope: '大陆', absurdity: 100,
      evolution: '曲折扩散', mood: '黑色幽默' } } : {}),
  });
  return { ...frozen, captured };
}

test('遣返草稿在建楼前进入完整行动、真实检索与模型请求，首次干涉也成立', async () => {
  const draft = '我把记着三个工匠制作金鸟的笔记本放在原地\n\n遣返';
  for (const entryOnly of [false, true]) {
    const frozen = await freeze(true, { draft, beforeCreate: true, entryOnly });
    const sourceId = `chat:${entryOnly ? 2 : 3}`;
    assert.equal(frozen.request.playerInterventions.find(s => s.sourceId === sourceId)?.content, draft);
    assert.equal(frozen.request.sourceIndex.find(s => s.sourceId === sourceId)?.content, draft);
    assert.equal(frozen.captured.candidates.find(s => s.sourceId === sourceId)?.content, draft);
    assert.ok(frozen.captured.castRequirementQuery?.includes(draft));
    const prompt = buildButterflyApiPrompt({ request: frozen.request, rules: {
      sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '',
    } });
    const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
    assert.equal(payload.sourceIndex.find((s: { sourceId: string }) => s.sourceId === sourceId)?.content, draft);
    assert.equal(payload.trigger.rawCommand, draft);
    assert.equal(frozen.request.sourceIndex.filter(s => s.sourceId === sourceId).length, 1);
  }
});

test('空行动仍不造结算；建楼后再次冻结不重复追加遣返原文', async () => {
  await assert.rejects(freeze(true, { beforeCreate: true, entryOnly: true }), /没有可追溯的玩家干涉/u);
  const draft = '我把笔记本放在原地\n\n遣返';
  const frozen = await freeze(true, { draft });
  assert.equal(frozen.request.playerInterventions.filter(s => s.sourceId === 'chat:3').length, 1);
  assert.equal(frozen.request.sourceIndex.find(s => s.sourceId === 'chat:3')?.content, draft);
});

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

test('背景故事的类型声明和check规则不是人物生平，纯协议在检索前隔离', async () => {
  const protocols = [
    wb(6, '[本体][变量][mvu_update]变量更新规则',
      'variables_update_rules:\n角色:\n  type: |-\n    { [角色名: string]: { 背景故事: string; // 角色经历\n      性格: string; } }\n  背景故事:\n    check:\n      - 仅重大事件发生时更新蓓若的经历\nJSONPatch'),
    wb(7, '[DLC][称号扩展][变量更新规则-称号]',
      'variables_update_rules:\n背景故事:\n  check:\n    - 仅在角色经历发生重大变化时更新\n<UpdateVariable>'),
    wb(12, '[变量更新规则]JSON Schema', 'JSONPatch\n{"背景故事": {"type": "string"}, "性格": {"type": "string"}}'),
    wb(13, '[变量更新规则]Zod Schema', 'variables_update_rules:\n背景故事: z.string().optional()\nJSONPatch'),
  ];
  const originals = protocols.map(source => source.content);
  const frozen = await freeze(true, { books: [...book, ...protocols] });
  for (const source of protocols) {
    assert.ok(!frozen.captured.candidates.some(s => s.sourceId === source.sourceId));
    assert.ok(!frozen.request.sourceIndex.some(s => s.sourceId === source.sourceId));
    assert.ok(!frozen.activeEvidence?.passages.some(s => s.sourceId === source.sourceId));
  }
  assert.equal(frozen.captured.worldbookCorpusReceipt?.counts.total, 9);
  assert.deepEqual(protocols.map(source => source.content), originals);
});

test('带协议的自然叙事、块文本与EJS真实档案仍完整进入检索候选', async () => {
  const mixed = [
    wb(8, '[变量更新规则]蓓若补充', 'variables_update_rules:\nJSONPatch\n姓名: 蓓若\n背景故事: 蓓若曾为失明的母亲织出触摸辨认的花纹。\n' + longProfile),
    wb(9, '[变量更新规则]蓓若往事', 'variables_update_rules:\n背景故事: |\n  蓓若年少时失去家园，后来与阿织共同修好了织机。\nJSONPatch\n全文结尾保留。'),
    wb(10, '[变量更新规则]EJS人物档案', 'JSONPatch\n<%_ { const profile = { name: "阿织", back_story: "蓓若的构装体伙伴" }; } _%>\n原文结尾保留。'),
    wb(11, '[变量更新规则]混合世界设定', 'variables_update_rules:\n世界设定: 蓓若所在的村落用织花标记家族的婚姻关系。\nJSONPatch'),
  ];
  const frozen = await freeze(true, { books: [...book, ...mixed] });
  for (const source of mixed) assert.equal(
    frozen.captured.candidates.find(s => s.sourceId === source.sourceId)?.content,
    source.content,
  );
});

test('第二轮用途门进入真实蝴蝶冻结及提示装配，不把出版模板当史料，也不改行动', async () => {
  const templates = [
    wb(15, '[扩展]书号出版规则', '名称: ASBN\n基本格式: ASBN-年份-地区\n地区代码:\n  01: 山村\n机构代码:\n  CD: 晨曙书局\n生成规则: 正式出版物必须生成ASBN'),
    wb(16, '[扩展]文字创作物成品规则', '核心指令: 乡间织物相关出版物成品展示用Raw Text\n强制输出格式:\n[WritingBook:PublishedBook]\nTitle:: ${标题}\n[/WritingBook]'),
  ];
  const draft = '我把织机放在山村，村民收下了\n\n遣返';
  const frozen = await freeze(true, { draft, books: [...book, ...templates] });
  for (const source of templates) {
    assert.ok(frozen.captured.candidates.some(s => s.sourceId === source.sourceId), '一轮候选仍有原始资料');
    assert.ok(!frozen.request.relevantWorldbook.some(s => s.sourceId === source.sourceId));
    assert.ok(!frozen.request.sourceIndex.some(s => s.sourceId === source.sourceId));
    assert.ok(!frozen.activeEvidence?.passages.some(s => s.sourceId === source.sourceId));
  }
  assert.ok(frozen.request.playerInterventions.some(s => s.content === draft));
  const prompt = buildButterflyApiPrompt({ request: frozen.request, activeEvidence: frozen.activeEvidence,
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' } });
  assert.doesNotMatch(prompt, /ASBN-年份-地区|\[WritingBook:PublishedBook\]/u);
  assert.equal(frozen.request.relevantWorldbook.find(s => s.sourceId === book[0]!.sourceId)?.content, longProfile);
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]!);
  assert.equal(payload.sourceIndex.find((s: { title: string }) => s.title === book[0]!.title)?.content, longProfile);
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
