import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildButterflyApiPrompt, buildButterflyNarrativeInstruction } from '../src/prompts/butterfly.ts';
import { ButterflyResultSchema } from '../src/schemas/butterfly.ts';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';
import {
  BUTTERFLY_MANDATORY_INSTRUCTION,
  BUTTERFLY_WRITING_ROLE_INSTRUCTION,
  BUTTERFLY_CREATIVE_METHOD_INSTRUCTION,
  BUTTERFLY_PERCEPTION_INSTRUCTION,
  BUTTERFLY_READABILITY_INSTRUCTION,
  BUTTERFLY_REVISION_INSTRUCTION,
} from '../src/core/butterflyProseContract.ts';

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
  assert.equal(prompt.match(/历史起点的识别:/gu)?.length, 1, '详细方法只装配一次');
  assert.match(prompt, /自己的愿望、处境、知识与判断/u);
  assert.match(prompt, /改写深度.*「深刻转折」：含义: 关键条件改变，使后续可走道路真正换了方向/su);
  assert.match(prompt, /实际影响事件取舍与表达，但不预定结局，不作为逐项达标清单/u);
  assert.match(prompt, /不凭空给既有正史人物添加亲缘/u);
  assert.match(prompt, /环境或事件主导时写其实际变化，不硬加人物中转/u);
  assert.match(prompt, /可以在归返之后另行遇见/u);
  assert.match(readRule('12_墟境任务规则-脚本交接.txt'), /同一有效玩家返程楼重 roll 正文，复用已冻结请求与完整蝴蝶结果/u, '重抽流程留在开发契约，不重复投递创作模型');
  assert.doesNotMatch(prompt, /波及范围不得高于或低于骰点映射|阶段必须发生“变形”|【人生接力】|【用途转生】|【共同生活】/u);
});

test('六条短教学链路进入真实模型提示一次，旧长范例退役，不充当史料或结局', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  for (const label of ['会谈破裂 →', '战争提前结束 →', '新生命诞生 →',
    '障碍消失 →', '争端扩大 →', '关键人物缺席 →']) assert.equal(prompt.split(label).length - 1, 1);
  assert.doesNotMatch(prompt, /示例一：玩家与精灵|示例三：玩家留下工匠制作金鸟/u);
  assert.match(prompt, /示例只学习连接方式，不充当本轮事实、已知角色、默认路线或期望结局/u);
  assert.match(prompt, /不沿用题材、人物、载体或结局/u);
  assert.match(prompt, /自主选择道路 → 吸引追随者 → 信仰与公共生活改变/u);
  assert.match(prompt, /下一段回应这一新处境，不必再次回到玩家最初的行为、原物或原主角/u);
  assert.match(prompt, /巧合可以打开机会，后来选择与环境反馈使后果留下/u);
  assert.match(prompt, /不是抽取表、必选项、人物名单或规定剧情/u);
  assert.ok(prompt.indexOf('链路示例（仅作示例，切勿照抄）') < prompt.indexOf('<EYON_BUTTERFLY_REQUEST_JSON>'));
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
  assert.match(prompt, /先确定同一段故事，再整理字段与索引/u);
  assert.match(prompt, /causalStages记录正文已经成立的转折/u);
  assert.match(prompt, /不逐个纪元巡礼/u);
  assert.match(prompt, /观察对象: 历史本身，包括人物、事件、群体、地域、资源、环境、机会与关系/u);
  assert.match(prompt, /越高越主动探索起点难以预料/u);
  assert.match(prompt, /情绪.*实际处境.*叙述角度/u);
  assert.match(prompt, /成名、繁荣、制度形成与格局重塑是结果，须有使这些结果成立的事情/u);
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
  assert.match(prompt, /原物与原主角.*继续居中.*退出/u);
  assert.match(prompt, /新目标、时机变化、意外交汇与不同进程的碰撞/u);
  assert.match(prompt, /高离奇.*低离奇.*直接而有意味/u);
  assert.match(prompt, /关注对象.*不是.*参与者名单/u);
  assert.match(prompt, /人物.*自己的愿望、处境、知识与判断/u);
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
  assert.match(prompt, /跨越人物、地域与时代的全知视角/u);
  assert.match(prompt, /我跟随介入打开的新条件，让历史获得自己的动力/u);
  assert.match(prompt, /高离奇可以留下私人余波，低离奇也可以改变国家/u);
  assert.match(prompt, /身份、关系、权力、功能、存续与世界格局都可以改变，按同一机制展开/u);
  assert.match(prompt, /不对某类对象设置特殊创作禁区/u);
  assert.doesNotMatch(prompt, /只承担史料分析与结构化生成|只生成结构化结算内容|不得改写世界神系本身|不得让神真身降临|世界神系与自然条件仍成立|社会信仰变化不改神明本体|不是在改写神明本体/u);
  assert.match(prompt, /已发生的事实准确承接，尚未发生的道路大胆展开/u);
  assert.match(prompt, /directEffects只记录实际行动直接造成的变化/u);
  assert.equal(prompt.match(/<BUTTERFLY_CREATIVE_METHOD>/gu)?.length, 1);
});

test('转折机制跨选择、交汇、功能与反馈，大小变化均可且范例无事实权威', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: 100 },
  } as never, rules: ruleSet });
  for (const label of ['自主选择:', '两种进程交汇:', '功能或意义转移:',
    '成功引来新回应:', '缺席换来新承担者:', '不同道路发生收束:']) {
    assert.equal(prompt.split(label).length - 1, 1, '每个参照只装配一次');
  }
  assert.match(prompt, /示例只学习连接方式，不充当本轮事实、已知角色、默认路线或期望结局/u);
  assert.match(prompt, /只学习前事形成条件、转折改变走向、后事获得动力/u);
  assert.match(prompt, /高离奇可以留下私人余波，低离奇也可以改变国家/u);
  assert.match(prompt, /影响可以进入另一领域，原来的目标、用途或解释被新的处境改变/u);
  assert.doesNotMatch(prompt, /神明与权力|成神、神格转移或神明更替/u);
});

test('大胆展开但承接已发生事实，原创未来不要求已有史料逐事证明', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request, creativeReferences: {
    ...DEFAULT_BUTTERFLY_REFERENCES, scope: '大陆', domain: '人物命运',
    intensity: '时代回响', absurdity: 100, evolution: '代际接力',
  } } as never, rules: ruleSet });
  assert.match(prompt, /不是预测最可能的未来/u);
  assert.match(prompt, /合理意味着能够成立，不意味着最常见、最稳妥或只能如此/u);
  assert.match(prompt, /尚未发生的道路大胆展开/u);
  assert.match(prompt, /来源句柄用于确认起点与世界条件/u);
  assert.match(prompt, /不要求未来已经逐事写在世界书中/u);
  assert.match(prompt, /原物.*损毁.*遗忘.*影响.*继续/u);
  assert.match(prompt, /不把愿望写成成果，不补造玩家行动/u);
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
  const perception = prompt.match(/<BUTTERFLY_PERCEPTION>([\s\S]*?)<\/BUTTERFLY_PERCEPTION>/u)![1];
  assert.equal(perception.split('仅作示例，切勿照抄').length - 1, 2, '素材库与场景示范各说明一次，不逐条加重');
  assert.ok(prompt.indexOf('<BUTTERFLY_PERCEPTION>') < prompt.indexOf('<EYON_BUTTERFLY_REQUEST_JSON>'));
  assert.match(prompt, /不是为整条因果链准备证明材料/u);
  assert.match(prompt, /职业影响遇见方式，不决定变化领域/u);
  for (const sensory of ['旧伤', '军旗', '颜色', '声音', '气味', '触感']) assert.ok(prompt.includes(sensory));
  assert.match(prompt, /玩家可以先见差异而暂不知来由/u);
  assert.match(prompt, /差异来自已经写成的历史，不为模仿例子临时补造无关变化/u);
  assert.match(prompt, /链路示例（仅作示例，切勿照抄）/u);
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.equal(payload.sourceIndex[0].content, action);
  assert.equal(prompt.split(action).length - 1, 1);
  assert.doesNotMatch(prompt, /必须在归返地点.*证据|每条证据.*完整.*因果链/u);
});


test('模型JSON仅投递在用参考，持久化请求与完整行动不被裁剪或修改', () => {
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, focus: '战争提前结束后的某个家庭',
    scope: '个人', intensity: '时代回响', absurdity: 95,
    legend: '史诗回响', evolution: '代际接力', manifestation: '传闻与作品' } as const;
  const frozen = { ...request, creativeReferences: refs };
  const before = JSON.stringify(frozen);
  const prompt = buildButterflyApiPrompt({ request: frozen as never, rules: ruleSet });
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.deepEqual(Object.keys(payload.creativeReferences), ['scope', 'focus', 'intensity', 'absurdity', 'mood', 'domain']);
  assert.equal(JSON.stringify(frozen), before);
  assert.match(prompt, /个人.*不把战争重新写回去/u);
  assert.match(prompt, /不因背景提及大战就自动升级为大陆/u);
  assert.match(prompt, /历史演变通常300至600字/u);
  assert.match(prompt, /原物与原主角.*可以继续居中.*退出/u);
  assert.match(prompt, /不同道路可以抵达相似结果，但参与者、代价、时机或生活细节已经不同/u);
  assert.match(prompt, /城市、聚落与国家可以新生、消失、迁移、合并或替代/u);
  assert.match(prompt, /标题.*可选.*缺失.*兜底/u);
});

test('关键关口与生活中的现世后果优先，软篇幅增至600字且不扩大返程模型职责', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  const protocol = prompt.slice(prompt.indexOf('<BUTTERFLY_MANDATORY_PROTOCOL>'), prompt.indexOf('<shared_context>'));
  assert.match(protocol, /历史正文: 展开一个真正改变后续道路的具体关口/u);
  assert.match(protocol, /现世证据: 呈现这个结果正在怎样被生活，而不只是怎样被记载/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /此前的局面、实际发生的行动或碰撞、由此产生的回应，以及留给后事的新条件/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /其他有效转折紧凑承接/u);
  assert.match(prompt, /通常300至600字，复杂故事可以更长/u);
  assert.doesNotMatch(prompt, /300至500字/u);
  assert.match(rules, /不因超长拒收或裁剪全文/u);
  const narrative = buildButterflyNarrativeInstruction(undefined, request as never);
  assert.doesNotMatch(narrative, /BUTTERFLY_REVISION|成稿审阅与修正|300至600/u);
});

test('审阅在完整请求和已选参考之后仅装配一次，替换旧核对且不改冻结资料', () => {
  for (const frozen of [request, { ...request, creativeReferences: DEFAULT_BUTTERFLY_REFERENCES }]) {
    const before = JSON.stringify(frozen);
    const prompt = buildButterflyApiPrompt({ request: frozen as never, rules: ruleSet });
    assert.equal(prompt.split(BUTTERFLY_REVISION_INSTRUCTION).length - 1, 1);
    assert.equal(prompt.match(/<BUTTERFLY_REVISION>/gu)?.length, 1);
    assert.ok(prompt.indexOf('<BUTTERFLY_REVISION>') > prompt.indexOf('</EYON_BUTTERFLY_REQUEST_JSON>'));
    if ('creativeReferences' in frozen) {
      assert.ok(prompt.indexOf('<BUTTERFLY_REVISION>') > prompt.indexOf('</BUTTERFLY_CURRENT_WRITING_BRIEF>'));
    }
    assert.ok(prompt.endsWith('</BUTTERFLY_REVISION>'));
    assert.doesNotMatch(prompt, /交付前核对:|最后只核对/u);
    assert.equal(JSON.stringify(frozen), before);
  }
});

test('审阅要求实际修正并协调字段，保留想象空间、安静证据与无分歧例外', () => {
  const review = BUTTERFLY_REVISION_INSTRUCTION;
  for (const item of ['事实起点:', '转折成立:', '历史自主生长:', '现世感知:', '本轮参考:', '全文一致:']) {
    assert.equal(review.split(item).length - 1, 1);
  }
  assert.match(review, /恢复准确起点，再通过后续事件建立影响/u);
  assert.match(review, /保留如实无新增影响的例外/u);
  assert.match(review, /静态或安静的差异同样成立/u);
  assert.match(review, /文字、图像和其他媒介都可正常使用/u);
  assert.match(review, /少见不等于错误/u);
  assert.match(review, /以修正后的正文同步其他字段/u);
  assert.match(review, /不输出草稿、审阅过程、评分或修改说明，沿用既有JSON字段/u);
  assert.match(review, /不增加模型调用、自动评分或重试流程/u);
  assert.match(review, /不以所有检查均通过的声明代替实际修正/u);
});

test('标题可选且容错，旧结果缺标题与坏类型不产生新失败门', () => {
  const schema = ButterflyResultSchema.shape.effect.shape.title;
  assert.equal(schema.parse(undefined), undefined);
  assert.equal(schema.parse(7), undefined);
  assert.equal(schema.parse(''), '');
  assert.equal(schema.parse('新城一夜'), '新城一夜');
});

test('结构化协议无句号，强制核心只装配一次且不要求输出推理或新增工作流', () => {
  for (const text of [BUTTERFLY_MANDATORY_INSTRUCTION, BUTTERFLY_WRITING_ROLE_INSTRUCTION,
    BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, BUTTERFLY_PERCEPTION_INSTRUCTION,
    BUTTERFLY_READABILITY_INSTRUCTION, BUTTERFLY_REVISION_INSTRUCTION, rules]) {
    assert.doesNotMatch(text, /。/u, '只检查新提示词，不处理事实原文');
  }
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  assert.equal(prompt.split(BUTTERFLY_MANDATORY_INSTRUCTION).length - 1, 1);
  assert.equal(prompt.match(/<BUTTERFLY_MANDATORY_PROTOCOL>/gu)?.length, 1);
  assert.ok(prompt.indexOf('<BUTTERFLY_MANDATORY_PROTOCOL>') < prompt.indexOf('<shared_context>'));
  const chain = ['完整行动与已确认事实', '确认实际历史分歧', '结合已选参考展开承前启后的转折',
    '确定新历史延续至现世的状态', '选择自然可接触的感知窗口', '整理为既有输出格式'];
  for (let i = 1; i < chain.length; i++) {
    assert.ok(BUTTERFLY_MANDATORY_INSTRUCTION.indexOf(chain[i - 1]) <
      BUTTERFLY_MANDATORY_INSTRUCTION.indexOf(chain[i]));
  }
  assert.match(BUTTERFLY_MANDATORY_INSTRUCTION, /第二个转折回应第一个留下的新局面，第三个回应此前继续形成的后果，不分别从玩家最初动作重新推导/u);
  assert.match(BUTTERFLY_MANDATORY_INSTRUCTION, /不规定三个段落、三个纪元或三个新人物，也不要求三场重大事件/u);
  assert.match(BUTTERFLY_MANDATORY_INSTRUCTION, /不输出思考过程、步骤说明或候选方案/u);
  assert.match(BUTTERFLY_MANDATORY_INSTRUCTION, /不增加必填字段、模型调用、自动评分或重试流程/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /缺席.*缺席改变了哪些条件，这些条件后来引出了什么，而不只是罗列/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /下一段回应这一新处境/u);
  assert.match(BUTTERFLY_PERCEPTION_INSTRUCTION, /持续状态、正在发生的事件或某种缺席/u);
});

test('去句号仅作用于提示词，不更改来源、最后遣返行动、锚点、偏好或冻结请求', () => {
  const original = '版本1.25。她将原图收好，并明确选择带回二叶。完整尾句。';
  const frozen = { ...request,
    trigger: { ...request.trigger, rawCommand: '我将二叶抱紧。\n\n遣返。' },
    anchors: { ...request.anchors, reality: { time: '488年1.5日。', location: '院门。东侧' } },
    sourceIndex: [{ sourceId: 'chat:8', title: '原文。', content: original }],
    playerInterventions: [{ sourceId: 'chat:8', title: '原文。', content: original }],
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, focus: '二叶。后续' },
  };
  const before = JSON.stringify(frozen);
  const prompt = buildButterflyApiPrompt({ request: frozen as never, rules: ruleSet });
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.equal(payload.sourceIndex[0].content, original);
  assert.equal(payload.sourceIndex[0].title, '原文。');
  assert.equal(payload.trigger.rawCommand, frozen.trigger.rawCommand);
  assert.deepEqual(payload.anchors, frozen.anchors);
  assert.equal(payload.creativeReferences.focus, frozen.creativeReferences.focus);
  assert.equal(prompt.split(original).length - 1, 1);
  assert.equal(JSON.stringify(frozen), before);
});

test('三个有效转折要求落实在真实提示中，不以起点或额外工作流充数', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  for (const block of [BUTTERFLY_WRITING_ROLE_INSTRUCTION, BUTTERFLY_MANDATORY_INSTRUCTION,
    BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, BUTTERFLY_PERCEPTION_INSTRUCTION]) {
    assert.equal(prompt.split(block).length - 1, 1, '每份获批指导完整且仅装配一次');
  }
  assert.equal(prompt.split('至少展开三个承前启后的有效转折').length - 1, 1);
  assert.match(prompt, /通常三个即可，复杂故事可以适当增加/u);
  assert.match(prompt, /不以年代更替、名称改变或影响越来越大充数/u);
  assert.match(prompt, /本身是分歧起点，不自动计入后续三个转折/u);
  assert.match(prompt, /每个转折承接此前形成的条件，通过具体发生的事情改变局面，并对后事产生实际作用/u);
  assert.match(prompt, /第二个转折回应第一个留下的新局面，第三个回应此前继续形成的后果/u);
  assert.match(prompt, /至少一个关键转折写出具体发生过程/u);
  assert.match(prompt, /转折可以发生在同一事件内部/u);
  assert.match(prompt, /不规定三个段落、三个纪元或三个新人物，也不要求三场重大事件/u);
  assert.doesNotMatch(prompt, /至少展开两个承前启后的有效转折|通常两至三个/u);
  assert.match(prompt, /真实介入未形成历史分歧时，如实呈现没有新增影响，不为凑转折虚构玩家干涉/u);
  assert.doesNotMatch(prompt, /不规定事件数量、人物数量、跨越纪元数量或传播路径/u);
  assert.match(prompt, /不增加必填字段、模型调用、自动评分或重试流程/u);
});

test('新历史是正文主轴，旧人生缺席和静态延续不代替后续事件，指导不重复装配', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, scope: '城市',
      focus: '二叶生活的城市', mood: '温暖明亮', absurdity: 50 },
  } as never, rules: ruleSet });
  assert.equal(prompt.split('写作重心:').length - 1, 1);
  assert.equal(prompt.split('历史怎样活起来:').length - 1, 1);
  assert.match(prompt, /事实优先级不变，正文主要篇幅必须用于介入之后的新事件与连续转折/u);
  assert.match(prompt, /不逐项复述人物原本的一生，不把删去旧经历当作新故事/u);
  assert.match(prompt, /先保留关键转折与必要连接.*最后考虑背景说明、旧史对照/u);
  for (const heading of ['受触动:', '逐渐发展:', '代代延续:', '制度形成:', '格局重塑:']) {
    assert.equal(prompt.split(heading).length - 1, 1);
  }
  assert.match(prompt, /已在墟境期间发生的后果照实保留/u);
  assert.match(prompt, /温暖可以经历困难后获得，悲伤也可以发生在成功之后/u);
  assert.match(prompt, /缺席可以通过生活怎样围绕空缺重新安排来感知/u);
  assert.match(prompt, /通常300至600字.*不为凑次数堆砌事件/u);
  assert.match(prompt, /后事回应前事留下的新局面，不把几段分别从玩家动作推导的后果拼在一起/u);
  assert.doesNotMatch(prompt, /转折不足.*(?:拒收|重试)|必须(?:三次升级|三场灾难|输出思考过程)/u);
});

test('转折按承前转向启后进入链路，支持扩大平息转向收束，不强制逐次升级', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  const method = prompt.match(/<BUTTERFLY_CREATIVE_METHOD>([\s\S]*?)<\/BUTTERFLY_CREATIVE_METHOD>/u)![1];
  for (const heading of ['承前:', '转向:', '启后:', '扩大:', '平息:', '收束:']) {
    assert.ok(method.includes(heading));
  }
  const chain = ['前事改变了条件', '人物、群体、事件或环境作出回应',
    '局面在具体关口发生转向', '新处境推动下一件事', '后来的历史继续沿新条件发展'];
  for (let i = 1; i < chain.length; i++) assert.ok(method.indexOf(chain[i - 1]) < method.indexOf(chain[i]));
  assert.match(method, /转折是蝴蝶扇动翅膀之后因果传递的血肉/u);
  assert.match(method, /转折不等于反转，平静的决定、一次成功、一次拒绝或一次错过/u);
  assert.match(method, /不强制每次放大、制造灾难、加入误读或出人意料的反转/u);
});

test('国家或大陆后果补关键桥梁但不倒造正史地位，现世线索来自写成的历史', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, scope: '国家', focus: '二叶缺席' },
  } as never, rules: ruleSet });
  assert.match(prompt, /局部变化走向国家或大陆变化时，写出影响扩大的关键桥梁/u);
  assert.match(prompt, /不把局部帮助直接改称原历史的国家命脉/u);
  assert.match(prompt, /不把正文写成逐项资源、利益与传播证明/u);
  assert.match(prompt, /当前有效历史定义已经改变的部分.*不恢复失效或回滚记录/u);
  assert.match(prompt, /资料中的生成模板、代码与变量协议不自动成为历史事件/u);
  assert.match(prompt, /本人直接带回与其缺席造成的间接历史变化分开理解/u);
  assert.match(prompt, /直接带回成果可以辅助，但不能代替全部历史余波/u);
  assert.match(prompt, /文字与图像和其他媒介一样正常使用/u);
  assert.match(prompt, /人物存亡、事件时序与结果一致/u);
});

test('有效转折区别于数量增长与结尾总结，四个组织要点不成为段落模板', () => {
  const prompt = buildButterflyApiPrompt({ request: { ...request,
    creativeReferences: DEFAULT_BUTTERFLY_REFERENCES } as never, rules: ruleSet });
  const method = prompt.match(/<BUTTERFLY_CREATIVE_METHOD>([\s\S]*?)<\/BUTTERFLY_CREATIVE_METHOD>/u)![1];
  for (const heading of ['承接条件:', '具体事件:', '实际转向:', '留给后事的条件:', '表达分寸:']) {
    assert.equal(method.split(heading).length - 1, 1);
  }
  assert.match(method, /庇护所变大是发展概括.*被庇护者的选择/u);
  assert.match(method, /数量增加不自动构成转折/u);
  assert.match(method, /成名、繁荣、被记载或延续至今只是结尾结果，不能单独算作最后一个转折/u);
  assert.match(method, /不要求每次写成四段/u);
  assert.match(method, /causalStages只索引正文已经展开的有效关口/u);
});

test('后事接续最近条件并打开不同问题，不绑原物且不以最常见路线代替合理', () => {
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /优先承接最近形成的结果/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /不是同一件事越来越大，而是前一件事不断打开下一件不同的事/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /局部可以理解，整条难以预料/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /他们不必知道玩家与最初起因/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /只要关键条件能够成立，就可以选择更有意味.*而不必选择最直接的道路/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /不要求每步都震撼/u);
  assert.match(BUTTERFLY_CREATIVE_METHOD_INSTRUCTION, /不强制每次放大、制造灾难、加入误读或出人意料的反转/u);
});

test('十种转折机制解释如何转向及边界，示例不用作抽取表或剧情配额', () => {
  const method = BUTTERFLY_CREATIVE_METHOD_INSTRUCTION;
  const labels = ['理解偏差:', '自主选择:', '解决旧问题产生新条件:', '两种进程交汇:',
    '功能或意义转移:', '成功引来新回应:', '缺席换来新承担者:', '时机错位:',
    '截住扩散或改变道路:', '不同道路发生收束:'];
  assert.equal(method.split('转折机制（仅作示例，切勿照抄）:').length - 1, 1);
  for (const label of labels) assert.equal(method.split(label).length - 1, 1, label);
  assert.equal(method.match(/^ {6}机制:/gmu)?.length, 10);
  assert.equal(method.match(/^ {6}短例:/gmu)?.length, 10);
  assert.match(method, /不是抽取表、必选项、人物名单或规定剧情/u);
  assert.match(method, /不要求逐类使用.*不按固定顺序套用/u);
  assert.match(method, /不必把每项好事都安排成代价/u);
  assert.match(method, /不总把缺席写成同功能替补/u);
});

test('失礼教学链进入真实模型提示一次，只示范接续而不混入事实或结果', () => {
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, scope: '城市', focus: '幼灵的未来',
    absurdity: 45, mood: '温暖明亮' } as const;
  const frozen = { ...request, creativeReferences: refs };
  const before = JSON.stringify(frozen);
  const prompt = buildButterflyApiPrompt({ request: frozen as never, rules: ruleSet });
  assert.equal(prompt.split('链路教学（仅作示例，切勿照抄）:').length - 1, 1);
  const method = prompt.match(/<BUTTERFLY_CREATIVE_METHOD>([\s\S]*?)<\/BUTTERFLY_CREATIVE_METHOD>/u)![1];
  const chain = ['山顶失礼', '谈判破裂，原定商品入关计划取消', '依赖这批订单的人失去生计',
    '求生行动与既有社会矛盾交汇', '动乱改变某个家庭的处境'];
  for (let i = 1; i < chain.length; i++) assert.ok(method.indexOf(chain[i - 1]) < method.indexOf(chain[i]));
  assert.match(method, /后段可以完全不再提尿，因果联系仍然存在/u);
  assert.match(method, /只学习接续与转向，不规定必须谈判破裂、失业、暴动或家破人亡/u);
  const payload = JSON.parse(prompt.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.deepEqual(payload.sourceIndex, request.sourceIndex);
  assert.equal(payload.creativeReferences.focus, refs.focus);
  assert.equal(JSON.stringify(frozen), before);
  assert.doesNotMatch(JSON.stringify(payload), /山顶失礼|谈判破裂/u);
});
