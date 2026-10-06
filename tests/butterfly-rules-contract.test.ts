import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildButterflyApiPrompt } from '../src/prompts/butterfly.ts';
import { ButterflyResultSchema } from '../src/schemas/butterfly.ts';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';

const readRule = (name: string) => readFileSync(new URL(`../rules/${name}`, import.meta.url), 'utf8');
const rules = readRule('15_蝴蝶效应生成规则-API.txt');
const ruleSet = {
  sharedContext: readRule('01_命定系统-伊雍-脚本上下文.txt'),
  retrievalContract: readRule('03_资料检索与上下文装配契约.txt'),
  validationContract: readRule('05_生成结果校验与失败恢复契约.txt'),
  generationContract: rules,
};
const request = {
  schema: 'eyon.butterfly.request.v1', requestId: 'rules-contract', runId: 'run-rules-contract',
  characterKey: '伊雍', chatId: 'rules-contract',
  trigger: { type: 'button', userMessageId: 1, returnAssistantMessageId: 2, rawCommand: '遣返' },
  anchors: {
    reality: { time: '复兴纪元488年-3月-15日-14:05', location: '金谷城-仪式大厅' },
    ruinEntry: { time: '复兴纪元184年-11月-9日-23:15', location: '旧堡-侧翼走廊' },
    ruinExit: { time: '复兴纪元184年-11月-9日-23:20', location: '旧堡-密道入口' },
  },
  dice: { roll: 68, scope: '城市' },
  playerInterventions: [{ sourceId: 'chat:8', title: 'user floor 8', content: '玩家改变了旧档案的归属。' }],
  sourceIndex: [{ sourceId: 'chat:8', title: 'user floor 8', content: '玩家改变了旧档案的归属。' }],
  previousButterflyAnchors: [],
};

test('规则保留事实、赎出和既有字段，退休骰表/固定范文/规模绑文风', () => {
  assert.match(rules, /先寻找能同时体现偏好的可信路径/u);
  assert.match(rules, /可信是可能成立，不是最常见或最稳妥/u);
  assert.match(rules, /逻辑是成立的底线，不是挑最普通路线的理由/u);
  assert.match(rules, /个人也可能有传奇人生，跨国也可能呈现朴素生活/u);
  assert.match(rules, /不用骰子锁定规模/u);
  assert.match(rules, /人物寿命/u); assert.match(rules, /原后续人生不再自动成立/u);
  assert.match(rules, /当前有效 Canon/u); assert.match(rules, /不得凭空给既有史料人物添加亲缘/u);
  assert.match(rules, /不因超长拒收或裁剪全文/u);
  assert.match(rules, /清楚、自然的现代中文/u);
  assert.match(rules, /谁做了什么、为什么这样做、后来怎样/u);
  assert.match(rules, /不同日期的明确状态转变分别保留/u);
  assert.match(rules, /不要求一件纸质证物或立即验证的公告/u);
  assert.doesNotMatch(rules, /【人生接力】|【用途转生】|【共同生活】|世界书日志继续/u);
  const example = JSON.parse(rules.match(/\x60\x60\x60json\s*([\s\S]*?)\s*\x60\x60\x60/u)![1]);
  assert.deepEqual(Object.keys(example).sort(), Object.keys(ButterflyResultSchema.shape).sort(), '既有输出键不增删');
  assert.deepEqual(Object.keys(example.effect).sort(), Object.keys(ButterflyResultSchema.shape.effect.shape).sort());
  assert.deepEqual(Object.keys(example.qualityChecks).sort(), Object.keys(ButterflyResultSchema.shape.qualityChecks.shape).sort());
});

test('实际装配只含一份主创作方法，无检索重试开发契约混入', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, domain: '人物命运', intensity: '深刻转折' } } as never, rules: ruleSet });
  assert.doesNotMatch(prompt, /<retrieval_contract>|<validation_contract>|# 十、预算与裁剪|# 二、请求状态机/u);
  assert.equal(prompt.match(/<BUTTERFLY_CREATIVE_METHOD>/gu)?.length, 1);
  assert.equal(prompt.match(/两到三条不同的可能路径/gu)?.length, 1, '方法不在规则和动态提示重复投递');
  assert.match(prompt, /自己的愿望、处境与选择/u);
  assert.match(prompt, /改写力度「深刻转折」：寻找会长期改变/u);
  assert.match(prompt, /不把“软参考”理解为可以不采用/u);
  assert.match(prompt, /不得为既有正史人物虚构新的亲缘关系/u);
  assert.match(prompt, /缺少合适具名人物时使用/u);
  assert.match(prompt, /可以在归返之后另行遇见/u);
  assert.match(readRule('12_墟境任务规则-脚本交接.txt'), /同一有效玩家返程楼重 roll 正文，复用已冻结请求与完整蝴蝶结果/u, '重抽流程留在开发契约，不重复投递创作模型');
  assert.doesNotMatch(prompt, /波及范围不得高于或低于骰点映射|阶段必须发生“变形”|【人生接力】|【用途转生】|【共同生活】/u);
});

test('三个玩家教学示例进入真实模型提示一次，拆解趣味而不充当史料或固定结局', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  for (const label of ['示例一：', '示例二：', '示例三：']) assert.equal(prompt.split(label).length - 1, 1);
  assert.match(prompt, /不是本轮事实、史料、角色名单、默认剧情或期望结局/u);
  assert.match(prompt, /不要照抄/u);
  assert.match(prompt, /自主人生、跨领域承接/u);
  assert.match(prompt, /接手、转用、纪念和采用/u);
  assert.match(prompt, /偶然只是促成相遇，人们的选择使它延续/u);
  assert.match(prompt, /不是评分表、传播步数配额或新增输出字段/u);
  assert.ok(prompt.indexOf('三个教学示例') < prompt.indexOf('<EYON_BUTTERFLY_REQUEST_JSON>'));
  assert.equal(prompt.match(/<BUTTERFLY_CREATIVE_METHOD>/gu)?.length, 1, '主方法仍只装配一次');
});

test('已发生行动与关注愿望分开，收好纸条不因未来影响偏好变成遗留', () => {
  const action = '他将写满记录的牛皮纸轻轻折拢收好，炭条收入皮套。';
  const focus = '我的纸条对大陆的深刻影响';
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    trigger: { ...request.trigger, rawCommand: '遣返' },
    playerInterventions: [{ sourceId: 'chat:40', title: 'assistant floor 40', content: action }],
    sourceIndex: [{ sourceId: 'chat:40', title: 'assistant floor 40', content: action }],
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, focus, scope: '大陆',
      domain: '人物命运', absurdity: 100, mood: '幽默诙谐', manifestation: '人物与关系' },
  } as never, rules: ruleSet });
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.equal(payload.sourceIndex[0].content, action);
  assert.equal(payload.trigger.rawCommand, '遣返');
  assert.equal(payload.creativeReferences.focus, focus);
  assert.equal(prompt.split(action).length - 1, 1, '事实原文不重复投递或改写');
  assert.match(prompt, /创作偏好不是已发生的行动/u);
  assert.match(prompt, /收好.*不等于.*遗留/u);
  assert.match(prompt, /传播条件.*不.*补造.*玩家/u);
  assert.match(rules, /直接变化.*已确认.*行动/u);
});

test('作者职责先于共用背景，历史先创作再整理索引，不把全纪元巡礼当模板', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, domain: '人物命运', absurdity: 100,
    mood: '幽默诙谐', manifestation: '人物与关系' } } as never, rules: ruleSet });
  assert.ok(prompt.indexOf('<BUTTERFLY_WRITING_ROLE>') < prompt.indexOf('<shared_context>'));
  assert.equal(prompt.match(/<BUTTERFLY_WRITING_ROLE>/gu)?.length, 1);
  assert.ok(prompt.indexOf('<BUTTERFLY_CREATIVE_METHOD>') < prompt.indexOf('<BUTTERFLY_CAUSAL_PLAN>'));
  assert.match(prompt, /JSON是交付容器，不是叙事题材/u);
  assert.match(prompt, /先写历史，再整理索引/u);
  assert.match(prompt, /无需逐个纪元巡礼/u);
  assert.match(prompt, /人的生活.*用途.*意义/u);
  assert.match(prompt, /高荒诞.*用途.*意义/u);
  assert.match(prompt, /幽默.*处境.*反差/u);
  assert.match(prompt, /泛称.*具体/u);
  assert.doesNotMatch(prompt, /必须更换.*人物|每阶段必须跨.*领域|荒诞不合格.*重试/u);
});

test('旧冻结请求沿用兼容回显，不重新启动规模和证物硬模板', () => {
  const prompt = buildButterflyApiPrompt({ request: request as never, rules: ruleSet });
  assert.match(prompt, /仅用于兼容回显/u);
  assert.match(prompt, /建议 450-900 个中文字符/u);
  assert.match(prompt, /不要求立即发生在归返地/u);
  assert.match(prompt, /误读可有可无/u); assert.match(prompt, /代价不是硬性要求/u);
  assert.match(prompt, /继续调查、利用、保护、交易、对抗或误解/u);
  assert.doesNotMatch(prompt, /结尾必须落到现世一个具体地点与一件玩家能亲手核查的证物/u);
});

test('围绕主角与转手碰撞都可成立，一到两条线索是软目标，旧四条原文仍接受', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, focus: '三名工匠', scope: '国家', absurdity: 95,
    evolution: '多线汇合', domain: '多域交织' } } as never, rules: ruleSet });
  assert.match(prompt, /直接收益.*第一站/u);
  assert.match(prompt, /原事件主角.*退出/u);
  assert.match(prompt, /合理延续.*意外相遇/u);
  assert.match(prompt, /关注对象.*不是.*参与者名单/u);
  assert.match(prompt, /不同的人物.*自己的需要/u);
  assert.match(prompt, /1至2项/u);
  assert.doesNotMatch(prompt, /1至4项/u);
  assert.match(rules, /1至2项/u);
  assert.match(prompt, /遣返楼.*完整行动/u);
  for (const count of [1, 2, 4]) {
    const evidence = Array.from({ length: count }, (_, i) => `线索${i + 1}完整原文`);
    assert.deepEqual(ButterflyResultSchema.shape.effect.shape.perceptibleEvidence.parse(evidence), evidence);
  }
});

test('单一小说家身份以通用机制放开有据未来，不以原身份、寿命或用途锁死结局', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, scope: '大陆', absurdity: 100,
    legend: '史诗回响', domain: '信仰与文化' } } as never, rules: ruleSet });
  assert.equal(prompt.split('你是一位反事实历史小说家').length - 1, 1, '详细身份只装配一次');
  assert.match(prompt, /跨越人物、地域与时代的全知叙事视角/u);
  assert.match(prompt, /我正在书写一段因真实介入而走岔的历史/u);
  assert.match(prompt, /低离奇程度.*中等离奇程度.*高离奇程度/u);
  assert.match(prompt, /所有对象使用同一通用演化机制/u);
  assert.match(prompt, /身份、关系、权力、功能、存续与世界格局都可以真实改变/u);
  assert.match(prompt, /不对某种对象单列特权或禁区/u);
  assert.doesNotMatch(prompt, /只承担史料分析与结构化生成|只生成结构化结算内容|不得改写世界神系本身|不得让神真身降临|世界神系与自然条件仍成立|社会信仰变化不改神明本体|不是在改写神明本体/u);
  assert.match(prompt, /已发生事实.*不可倒写/u);
  assert.match(prompt, /JSON是交付容器，不是叙事题材/u);
  assert.equal(prompt.match(/<BUTTERFLY_CREATIVE_METHOD>/gu)?.length, 1);
});

test('宏大参照跨战争、国家、生态与文明，微小极诞同样成立且范例无事实权威', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: 100 },
  } as never, rules: ruleSet });
  for (const label of ['尺度参照一·战争与国家', '尺度参照二·生态与迁徙',
    '尺度参照三·文明与生活', '尺度参照四·技艺与社会', '尺度参照五·微小极诞']) {
    assert.equal(prompt.split(label).length - 1, 1, '每个参照只装配一次');
  }
  assert.match(prompt, /不是本轮事实.*剧情模板.*必选领域/u);
  assert.match(prompt, /参考.*转折机制.*不照抄/u);
  assert.match(prompt, /低档不等于无变化，高档不等于必然宏大/u);
  assert.match(prompt, /原物.*技术.*未来.*不必.*技术/u);
  assert.doesNotMatch(prompt, /神明与权力|成神、神格转移或神明更替/u);
});

test('大胆构思优先于关键连接核对，原创未来不要求已有史料逐事证明', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, scope: '大陆', domain: '人物命运',
    intensity: '时代回响', absurdity: 100, evolution: '代际接力',
  } } as never, rules: ruleSet });
  assert.match(prompt, /不是在预测最可能发生的历史/u);
  assert.match(prompt, /合理不等于最常见，低概率不等于不成立/u);
  assert.match(prompt, /先大胆构思，再核对关键连接/u);
  assert.match(prompt, /来源用于确认起点与世界条件/u);
  assert.match(prompt, /不要求每个原创未来事件都已存在于世界书/u);
  assert.match(prompt, /原物.*损毁.*遗忘.*影响.*继续/u);
  assert.match(prompt, /已发生事实.*不可倒写/u);
  assert.doesNotMatch(prompt, /每个未来事件必须.*来源|离奇不合格.*重试|必须.*推翻.*国家/u);
});

test('感知窗口独立装配一次，办公室不绑定证据媒介，原文仍完整投递', () => {
  const action = '我将笔记放在石龛。' + '完整行动与世界条件。'.repeat(2000) + '最后决定遣返。';
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, manifestation: '人物与关系' },
    sourceIndex: [{ sourceId: 'chat:8', title: '完整行动', content: action }],
    playerInterventions: [{ sourceId: 'chat:8', title: '完整行动', content: action }],
  } as never, rules: ruleSet });
  assert.equal(prompt.match(/<BUTTERFLY_PERCEPTION>/gu)?.length, 1);
  assert.ok(prompt.indexOf('<BUTTERFLY_PERCEPTION>') < prompt.indexOf('<EYON_BUTTERFLY_REQUEST_JSON>'));
  assert.match(prompt, /不是证明整条因果链的司法证物/u);
  assert.match(prompt, /职业影响遇见方式，不决定变化领域/u);
  for (const sensory of ['疤痕', '军旗', '云', '声音', '气味']) assert.ok(prompt.includes(sensory));
  assert.match(prompt, /无需当场理解完整来历/u);
  assert.match(prompt, /云.*生态.*天气.*空中活动/u);
  assert.match(prompt, /只是表达示例，不是本轮事实或必选证物/u);
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.equal(payload.sourceIndex[0].content, action);
  assert.equal(prompt.split(action).length - 1, 1);
  assert.doesNotMatch(prompt, /必须在归返地点.*证据|每条证据.*完整.*因果链/u);
});
