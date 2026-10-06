import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';
import { TavernRuinContextAssembler } from '../src/runtime/ruinContext.ts';
import { TavernBiographyContextAssembler } from '../src/runtime/biographyContext.ts';
import { TavernGenealogyContextAssembler } from '../src/runtime/genealogyContext.ts';
import { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import { buildRuinOutlineBatchApiPrompt } from '../src/prompts/ruin.ts';
import { buildBiographyPlanPrompt } from '../src/prompts/biography.ts';
import { buildGenealogyApiPrompt } from '../src/prompts/genealogy.ts';
import { buildButterflyApiPrompt } from '../src/prompts/butterfly.ts';
import { createBiographyStagePlanFromRules } from '../src/runtime/biographyDiceCore.ts';
import { RuinGenerationInputSchema } from '../src/schemas/ruin.ts';
import { GenealogyGenerationInputSchema } from '../src/schemas/genealogy.ts';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';
import type { RuntimeShadowCaptureInput } from '../src/retrieval/runtimeShadow.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';

// 离线运行真实冻结/检索/提示装配；不伪装成真实模型文学生成，也不调用网络。
const rule = (name: string) => readFileSync(new URL('../rules/' + name, import.meta.url), 'utf8');
const world = { time: '复兴纪元488年3月1日19:40', location: '阿斯塔利亚大陆-奥古斯提姆帝国-艾瑟嘉德-档案库借阅台' };
const wb = (uid: number, title: string, content: string): RuntimeWorldbookSource => ({
  sourceId: `worldbook:rounds:${uid}`, title, content, keywords: [], strategyType: 'selective',
  worldbook: { schema: 'eyon.retrieval.worldbook-metadata.v1', logicalId: `worldbook:rounds:${uid}`,
    worldbookName: 'rounds', uid, bindingScopes: ['character-primary'], enabled: true,
    strategy: { type: 'selective', primaryKeys: [], secondary: { logic: 'and_any', keys: [] }, scanDepth: 'same_as_global' },
    position: null, probability: null, recursion: null, effect: null, extra: {} },
});
const noise = [
  wb(1, '[变量]变量输出规则', 'variables_update_format:\n<UpdateVariable><JSONPatch>${new_value}</JSONPatch></UpdateVariable>'),
  wb(2, '[称号]称号随机事件变量更新规则', '<%_ { _%>\n<当前称号随机事件变量>\n历史事件: <%- JSON.stringify(state.历史事件) %>\n</当前称号随机事件变量>\n历史事件:\n  check: 保存事件摘要\n<%_ } _%>'),
  wb(3, '[额外设定]任务与委托规则', '触发机制: 查看任务板生成\n输出格式:\n<task_info>详情:[天壁与所有人的任务背景]</task_info>'),
  wb(4, '[书号]ASBN规则', 'ASBN\n基本格式: ASBN-年份-地区\n地区代码:\n  01: 奥古斯提姆帝国\n机构代码:\n  CD: 晨曙书局'),
  wb(5, '[DLC][命定系统]星枢核心', '运行规则：启动星枢后按固定格式输出女皇、雨禾、二叶与孤悬天壁的状态面板。\n姓名: 星枢\n身份: 系统助理'),
  wb(6, '【DLC】【命定系统】【归途】交互协议', '启动归途后生成侧栏面板，展示雨禾、澜禾、骸响龙姬、孤悬天壁与所有任务的状态。'),
];
function env(id: string, books: RuntimeWorldbookSource[], name = '', messages = [{ message_id: 10, role: 'user', message: '探究往事' }]) {
  const namespace = { characterKey: '离线角色', chatId: id };
  const runtime = { getCurrentCharacterName: () => namespace.characterKey, getCurrentChatId: () => id,
    getLastMessageId: () => messages.at(-1)!.message_id, getMessageSwipeId: () => 0,
    getChatMessages: (range: unknown) => typeof range === 'number' ? messages.filter(m => m.message_id === range) : messages };
  const characters = name ? [{ sourceId: `mvu-character:${name}`, title: name, content: JSON.stringify({ name, 简介: books[0]!.content }) }] : [];
  const provider = { getCurrentWorld: async () => world, getWorldbookCorpus: async () => ({ sources: [...books, ...noise], receipt: {
    schema: 'eyon.retrieval.worldbook-corpus.v1', complete: true,
    bindings: [{ worldbookName: 'rounds', scopes: ['character-primary'] }], entries: [...books, ...noise].map(s => ({
      logicalId: s.sourceId, sourceId: s.sourceId, worldbookName: 'rounds', uid: s.worldbook.uid,
      title: s.title, bindingScopes: ['character-primary'], enabled: true, status: 'retrievable' })),
    counts: { total: books.length + noise.length, enabled: books.length + noise.length, retrievable: books.length + noise.length,
      disabled: 0, empty: 0, 'user-excluded': 0, 'routed-generated': 0 } } }),
    getCharacterSources: async () => characters, getGenealogySources: async () => [],
    getBiographySources: async () => [], getButterflySources: async () => [] };
  const observer = new RuntimeShadowRetrievalObserver();
  let observation!: Awaited<ReturnType<typeof observer.capture>>;
  const shadow = { capture: async (input: RuntimeShadowCaptureInput) => { observation = await observer.capture(input); return observation; } };
  return { namespace, runtime, provider, shadow, get bundle() {
    assert.ok('bundle' in observation, '真实检索失败不能伪装成空的成功回执');
    return observation.bundle;
  } };
}
function delivery(prompt: string, sources: Array<{ sourceId: string; content: string }>, bundle: ReturnType<typeof env>['bundle']) {
  assert.ok(prompt.includes('<SOURCE_APPLICABILITY>'), '不是只改开发文档，适用说明必须到最终模型请求');
  assert.ok(prompt.includes('适用于全部命定系统，而非仅伊雍'));
  assert.ok(prompt.includes('现实锚点用来确认当前世界与归返时地'));
  assert.ok(prompt.includes('人物的姓名、基础身份、事件年龄、生卒与有效Canon继续'));
  assert.ok(prompt.includes('不锁死受干预后的未来'), '保护既定过去不能恢复旧的未来绝对锁');
  for (const source of sources) {
    assert.ok(!noise.some(s => s.sourceId === source.sourceId), '无关协议不进入正式请求');
    assert.ok(prompt.includes(source.content) || prompt.includes(JSON.stringify(source.content).slice(1, -1)), '入选全文送达');
  }
  for (const passage of bundle.passages) {
    const source = bundle.sourceSnapshots.find(s => s.snapshotId === passage.snapshotId)!;
    assert.equal(source.content.slice(passage.startOffset, passage.endOffset).trim(), passage.content.trim(), '偏移可回溯，非改写或硬切');
  }
  assert.equal(bundle.semanticEvidence, undefined, '不引入额外语义模型或新校验门');
}

const ruinCases = [
  { label: '第1轮·墟境：长地点链+女皇称谓定位本人', era: '复兴纪元', location: '阿斯塔利亚大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德',
    direction: '女皇在卧室阅读勇者丝特拉时的趣闻', books: [wb(11, '[角色]维奥莱塔', '姓名: 维奥莱塔\n种族: 人类\n身份: 奥古斯提姆帝国女皇\n背景故事: 维奥莱塔喜爱阅读勇者丝特拉，居住在首都艾瑟嘉德。')], expected: ['维奥莱塔'] },
  { label: '第2轮·墟境：只点古事件，关联两位隐含人物', era: '英雄纪元', location: '阿斯塔利亚大陆-幽谷',
    direction: '骸响龙姬相关墟境', books: [wb(21, '[事件]骸响龙姬', '远古时期，艾莉希雅和奥希莉雅曾参与骸响龙姬之战。'),
      wb(22, '[角色]艾莉希雅', '姓名: 艾莉希雅\n种族: 精灵\n背景故事: 曾参与骸响龙姬之战。'),
      wb(23, '[角色]奥希莉雅', '姓名: 奥希莉雅\n种族: 精灵\n背景故事: 曾参与骸响龙姬之战。')], expected: ['艾莉希雅', '奥希莉雅'] },
  { label: '第3轮·墟境：未出生窗口+人物参考不强迫出场', era: '复兴纪元', location: '阿斯塔利亚大陆-青葭村',
    direction: '秦遥故乡复兴纪元400年的瘟疫', books: [wb(31, '[角色]秦遥', '姓名: 秦遥\n生卒: 复兴纪元460年-复兴纪元487年\n背景故事: 秦遥出生于青葭村；460年前尚未出生。')], expected: ['秦遥'] },
];
for (const [i, c] of ruinCases.entries()) test(c.label, async () => {
  const e = env('ruin-' + i, c.books);
  const input = RuinGenerationInputSchema.parse({ era: c.era, start: null, end: null, location: c.location,
    supplementaryDirection: c.direction, selectedCharacters: [], autoGenealogy: false, wave: { level: 'ripple', candidateCount: 3 },
    creativeReferences: { periods: ['stable', 'transition', 'turbulent'], telling: '多方讲述', pace: '起伏鲜明', mood: '悲伤惋惜' },
    materials: ['stable', 'transition', 'turbulent'].map((periodType, index) => ({ candidateKey: 'candidate-' + (index + 1), periodType, background: '本轮时期', conflict: '按方向展开', trigger: '可供介入' })) });
  const directive = [c.era, c.location, c.direction].join('\n');
  const context = await new TavernRuinContextAssembler(e.runtime as never, e.provider as never, async () => new Set(), e.shadow, () => world.time)
    .assemble({ requestId: 'ruin-' + i, namespace: e.namespace, triggerMessageId: 10, directive, eraAnchor: c.era, castRequirementQuery: c.direction, territorialReferences: [c.location], actorSelection: input });
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId: 'ruin-' + i, directive, generationInput: input, context, rules: { generationContract: rule('11_墟境历史期生成规则-API.txt') } });
  delivery(prompt, context.sourceIndex, e.bundle);
  for (const name of c.expected) assert.ok(e.bundle.castManifest?.entries.some(a => a.identity.canonicalName === name), name);
  for (const source of c.books) assert.ok(context.sourceIndex.some(s => s.content === source.content));
  assert.ok(prompt.includes(c.location));
  if (i === 0) assert.ok(e.bundle.castManifest?.entries.some(a => a.identity.canonicalName === '维奥莱塔' && a.disposition === 'required'));
  if (i === 1) assert.ok(e.bundle.castManifest?.entries.every(a => a.disposition !== 'required'));
  if (i === 2) assert.ok(e.bundle.personTimeline?.some(p => p.name === '秦遥' && p.lifespan?.born?.year === 460));
});

const biographyCases = [
  { label: '第1轮·传记：作者题注+长档案尾部年龄事实', name: '溪禾', title: '[DLC][角色][溪禾]溪禾(二叶、银莳萝-花匠)',
    text: '<溪禾 角色详情>\n姓名: 溪禾\n年龄: 实龄十八岁\n背景故事: 溪禾八岁时姐姐去世，十二岁时在复兴纪元482年遇到海难。\n' + '她坚持照料花圃。'.repeat(1600) + '\n最后事实：姐姐去世时是八岁，不是十岁。\n</溪禾 角色详情>' },
  { label: '第2轮·传记：曾用名同一身份+静态EJS档案', name: '温叶', title: '[角色]千萤',
    text: '<% const profile = { "name": "千萤", "former_name": "温叶", "back_story": "复兴纪元467年拜师后改名千萤" }; %>\n姓名: 千萤\n原名: 温叶\n背景故事: 温叶在复兴纪元467年拜师，后来改名千萤。' },
  { label: '第3轮·传记：复生事实+未求值未来死亡分支', name: '陆祈', title: '[角色]陆祈',
    text: '<陆祈 角色详情>\n姓名: 陆祈\n背景故事: 陆祈在480年阵亡，于484年复生，现在照料灯塔。\n<% if (futureDeath) { %>生卒: 复兴纪元460年-复兴纪元490年\n<% } %>\n</陆祈 角色详情>' },
];
for (const [i, c] of biographyCases.entries()) test(c.label, async () => {
  const e = env('bio-' + i, [wb(40 + i, c.title, c.text)]);
  const directive = '寻根溯源' + c.name + '的经历';
  const context = await new TavernBiographyContextAssembler(e.runtime as never, e.provider as never, e.shadow, () => world.time)
    .assemble({ requestId: 'bio-' + i, namespace: e.namespace, triggerMessageId: 10, directive });
  const prompt = buildBiographyPlanPrompt({ requestId: 'bio-' + i, directive, context,
    stagePlan: createBiographyStagePlanFromRules(rule('08_伊雍骰子判定表-脚本数据.txt'), () => 0.2 + i * 0.3),
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: rule('13_寻根溯源生成规则-API.txt') } });
  delivery(prompt, context.sourceIndex, e.bundle);
  assert.ok(context.sourceIndex.some(s => s.content === c.text));
  if (i === 0) assert.ok(!e.bundle.castManifest?.entries.some(a => ['二叶', '银莳萝'].includes(a.identity.canonicalName)));
  if (i === 1) assert.ok(e.bundle.castManifest?.entries.some(a => a.identity.canonicalName === '千萤'));
  if (i === 2) assert.ok(!e.bundle.personTimeline?.some(p => p.name === '陆祈' && p.lifespan?.died?.year === 490));
});

const genealogyCases = [
  { label: '第1轮·宗族：构装体主人/前代型号不是父母', name: '艾琳一号',
    text: '姓名: 艾琳一号\n种族: 构装体\n背景故事: 创造者罗安；主人海因里希；上一代型号艾琳零号。启动于复兴纪元485年。主人不是父亲，上一代型号不是母亲。' },
  { label: '第2轮·宗族：穿越者原世界年代不硬套纪元', name: '夏砚',
    text: '姓名: 夏砚\n身份: 穿越者\n背景故事: 灵魂来自异界，原世界父母许安和林萤，原世界日历待考；复兴纪元480年抵达，不是出生。当地养父顾青不是血缘父亲。' },
  { label: '第3轮·宗族：夺舍身体与灵魂家系分开', name: '琉灯',
    text: '姓名: 琉灯\n身份: 灵魂夺舍者\n背景故事: 灵魂原名洛篱，其姐姐洛檀；宿主琉灯的身体父母为简川与苏禾，身体家系与灵魂家系不可混写。保留配偶、兄弟姐妹与旁支，不只一对父母。' },
];
for (const [i, c] of genealogyCases.entries()) test(c.label, async () => {
  const e = env('genealogy-' + i, [wb(50 + i, '[角色]' + c.name, c.text)], c.name);
  const directive = c.name + '的身份与家庭谱系';
  const context = await new TavernGenealogyContextAssembler(e.runtime as never, e.provider as never, e.shadow, () => world.time)
    .assemble({ requestId: 'genealogy-' + i, namespace: e.namespace, triggerMessageId: 10, directive });
  const input = GenealogyGenerationInputSchema.parse({ lineageKind: 'auto', focusCharacter: { mvuId: c.name, name: c.name, aliases: [] }, depth: { ancestors: 3, descendants: i, maxPerGeneration: 7 } });
  const prompt = buildGenealogyApiPrompt({ requestId: 'genealogy-' + i, directive, context, generationInput: input, rules: { generationContract: rule('09_宗族谱系生成规则-API.txt') } });
  delivery(prompt, context.sourceIndex, e.bundle);
  assert.ok(context.currentMvuCharacters?.some(s => s.title === c.name));
  assert.ok(prompt.includes(c.text) && prompt.includes('"maxPerGeneration":7'));
  assert.ok(prompt.includes('自动') || prompt.includes('auto'));
});

const butterflyCases = [
  { label: '第1轮·蝴蝶：现实档案员不指定未来终点，终楼遗留笔记', era: '创世纪元',
    name: '金铎', text: '姓名: 金铎\n身份: 神明\n背景故事: 创世纪元铸造天碑；赤羽沙鹏撞击基座。',
    action: '海因里希记录金铎铸碑，未赠给任何人。', draft: '我把完整笔记留在天壁石台上\n\n遣返',
    focus: '留下的笔记给不同人物带来的新选择', scope: '大陆', absurdity: 100 },
  { label: '第2轮·蝴蝶：跨时代人物+超过24楼+契约赎出完整行动', era: '神明纪元',
    name: '二叶', text: '姓名: 二叶\n种族: 花灵\n背景故事: 诞生于神明纪元；混乱纪元经历生命蚀刻之咒。',
    action: '二叶目前实龄半岁。我已与她签订契约。', draft: '我决定带着已签约的幼年二叶离开原历史，带到现世\n\n遣返',
    focus: '离开原历史的本人和后来空缺', scope: '城市', absurdity: 50 },
  { label: '第3轮·蝴蝶：放生而无遗物，样式词不作为演员', era: '英雄纪元',
    name: '澄衡', text: '姓名: 澄衡\n背景故事: 澄衡保护星鹿，在森林照料伤兽。',
    action: '海因里希和澄衡给星鹿松开猎索。<style>.潮汐守卫{color:red}</style><UpdateVariable><JSONPatch>[{"op":"replace","path":"/关系列表/澄衡/状态","value":"在世；星鹿已自由"}]</JSONPatch></UpdateVariable>',
    draft: '我确认星鹿回到森林，没有留下任何物品，也不带走它\n\n遣返', focus: '放生与城里居民的意外联系', scope: '城市', absurdity: 70 },
];
for (const [i, c] of butterflyCases.entries()) test(c.label, async () => {
  const messages = Array.from({ length: 30 }, (_, j) => ({ message_id: j + 11, role: j % 2 ? 'user' : 'assistant', message: j === 0 ? c.action : '本轮旅途中的完整行动第' + j + '楼' }));
  const books = [wb(60 + i, '[角色]' + c.name, c.text), wb(66, '[角色]潮汐守卫', '姓名: 潮汐守卫\n背景故事: 守在远海，未参与森林。')];
  const e = env('butterfly-' + i, books, '现实档案员', messages);
  const location = c.era + '的天壁或森林';
  const assembler = new TavernButterflyContextAssembler(e.runtime as never, e.provider as never, {
    getButterflyFreezeSnapshot: async () => ({ runId: 'round-' + i, reality: world,
      ruinEntry: { time: c.era + '129年6月3日06:00', location }, ruinExit: { time: c.era + '129年6月3日06:30', location } }),
    getRuinRoundStartMessageId: () => 11,
  } as never, e.shadow);
  const frozen = await assembler.freeze({ requestId: 'butterfly-' + i, namespace: e.namespace, userMessageId: 41,
    rawCommand: c.draft, triggerType: 'button', roll: 1,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, focus: c.focus, scope: c.scope, absurdity: c.absurdity } as never });
  const prompt = buildButterflyApiPrompt({ request: frozen.request, activeEvidence: frozen.activeEvidence,
    rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: rule('15_蝴蝶效应生成规则-API.txt') } });
  delivery(prompt, frozen.request.sourceIndex, e.bundle);
  assert.ok(frozen.request.sourceIndex.some(s => s.content === c.text));
  assert.ok(frozen.request.sourceIndex.some(s => s.content === c.action));
  assert.ok(frozen.request.playerInterventions.some(s => s.content === c.draft));
  assert.ok(frozen.request.sourceIndex.some(s => s.content.includes('第29楼')));
  assert.equal(frozen.request.anchors.reality.time, world.time);
  assert.equal(frozen.request.creativeReferences?.absurdity, c.absurdity);
  assert.ok(prompt.includes('不从借阅台上的物品或条目倒推历史'));
  assert.ok(!e.bundle.castManifest?.entries.some(a => ['现实档案员', '潮汐守卫'].includes(a.identity.canonicalName)));
});
