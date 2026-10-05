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

test('旧冻结请求沿用兼容回显，不重新启动规模和证物硬模板', () => {
  const prompt = buildButterflyApiPrompt({ request: request as never, rules: ruleSet });
  assert.match(prompt, /仅用于兼容回显/u);
  assert.match(prompt, /建议 450-900 个中文字符/u);
  assert.match(prompt, /不要求立即发生在归返地/u);
  assert.match(prompt, /误读可有可无/u); assert.match(prompt, /代价不是硬性要求/u);
  assert.match(prompt, /继续调查、利用、保护、交易、对抗或误解/u);
  assert.doesNotMatch(prompt, /结尾必须落到现世一个具体地点与一件玩家能亲手核查的证物/u);
});
