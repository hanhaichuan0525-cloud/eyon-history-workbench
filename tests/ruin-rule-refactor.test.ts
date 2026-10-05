import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildButterflyApiPrompt } from '../src/prompts/butterfly.ts';
import { DEFAULT_BUTTERFLY_REFERENCES } from '../src/core/creativeReferences.ts';
import { buildRuinTaskPrompt } from '../src/prompts/ruinTask.ts';
import { buildCompactRuinExpansionRecoveryPrompt } from '../src/prompts/ruin.ts';

const rule = (name: string) => readFileSync(new URL(`../rules/${name}`, import.meta.url), 'utf8');
const sources = [{ sourceId: 'chat:8', title: '完整行动', content: '完整开头' + '正文证据不可裁剪。'.repeat(1800) + '完整结尾' }];
function prompt() {
  return buildButterflyApiPrompt({
    request: {
      schema: 'eyon.butterfly.request.v1', requestId: 'refactor', runId: 'run-refactor',
      characterKey: '伊雍', chatId: 'chat-refactor', dice: { roll: 68, scope: '国家' },
      creativeReferences: { ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: 100, mood: '幽默诙谐' },
      sourceIndex: sources, playerInterventions: sources, previousButterflyAnchors: [],
    } as never,
    rules: { sharedContext: rule('01_命定系统-伊雍-脚本上下文.txt'),
      retrievalContract: 'DEVELOPER_RETRIEVAL_SENTINEL', validationContract: 'DEVELOPER_VALIDATION_SENTINEL',
      generationContract: rule('15_蝴蝶效应生成规则-API.txt') },
  });
}
test('创作模型不接收检索/重试/持久化开发契约，完整来源仍投递一次', () => {
  const text = prompt();
  assert.doesNotMatch(text, /DEVELOPER_RETRIEVAL_SENTINEL|DEVELOPER_VALIDATION_SENTINEL|<retrieval_contract>|<validation_contract>/u);
  const request = JSON.parse(text.match(/<EYON_BUTTERFLY_REQUEST_JSON>\s*([\s\S]*?)\s*<\/EYON_BUTTERFLY_REQUEST_JSON>/u)![1]);
  assert.equal(request.sourceIndex[0].content, sources[0].content);
  assert.match(request.playerInterventions[0].content, /完整原文见 sourceIndex/u);
  assert.equal(request.creativeReferences.absurdity, 100);
  assert.match(text, /历史赎出/u); assert.match(text, /三套冻结锚点/u);
});
test('墟境旧冲突槽保留协议，不再要求两股利益摩擦或排除所有当代角色', () => {
  const rules = rule('11_墟境历史期生成规则-API.txt');
  const source = readFileSync(new URL('../src/prompts/ruin.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /中段让至少两股利益|必须把制度、资源和时代压力/u);
  assert.doesNotMatch(source, /must never adopt a contemporary person under their real name|dice only changes pressure|Dice\/material supplies pressure/u);
  assert.match(rules, /稳定期/u); assert.match(rules, /四个/u); assert.match(rules, /from\/to 可以相同/u);
  assert.match(source, /latentFault, pressuredActors, bridge, triggerImpact, forcedDecision, irreversibleTurn/u);
});
test('蝴蝶规则只规定创作和既有输出，不把生成失败说成已经遣返', () => {
  const text = rule('15_蝴蝶效应生成规则-API.txt');
  assert.doesNotMatch(text, /流程B不得阻塞流程A|世界书镜像|世界书日志继续|骰点.*决定.*规模/u);
  assert.match(text, /尚未执行的计划/u);
  assert.match(text, /qualityChecks/u); assert.match(text, /directEffects/u);
  assert.match(text, /不因超长拒收或裁剪全文/u);
  assert.match(prompt(), /先寻找能同时体现偏好的可信路径/u);
});

test('传输恢复仍保留完整资料和创作参考，不重新要求固定压力模板', () => {
  const references = sources[0].content + '\n<RUIN_CREATIVE_REFERENCES>甜蜜暧昧、多方讲述、舒缓描写</RUIN_CREATIVE_REFERENCES>';
  const original = ['<RUIN_SELECTED_CANDIDATE_EXPANSION>',
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>', 'Copy these fixed fields exactly: {"schema":"eyon.ruin.expansion.v1","requestId":"refactor","candidateKey":"candidate-1"}',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
    '<SELECTED_OUTLINE_READ_ONLY>{"id":"candidate-1"}</SELECTED_OUTLINE_READ_ONLY>',
    '<REFERENCE_DATA_READ_ONLY>' + references + '</REFERENCE_DATA_READ_ONLY>'].join('\n');
  const recovery = buildCompactRuinExpansionRecoveryPrompt(original)!;
  assert.ok(recovery); assert.ok(recovery.includes(references));
  assert.match(recovery, /without cutting a complete passage/u);
  assert.doesNotMatch(recovery, /420-520|Use concrete actions, institutions, resources, pressures/u);
});

test('任务有正向可玩方法，原有解释/规模/奖励协议不变', () => {
  const text = buildRuinTaskPrompt({ direction: '陪花灵玩积木', runId: 'run-refactor', ruinTime: '神明纪元早期',
    ruinLocation: '幽谷溪畔', entryHistory: null, recentNarrative: [], interpretation: '原意锁定', scale: '即时互动' });
  assert.match(text, /一次回应、试验、发现或合作/u);
  assert.match(text, /【原意锁定】/u); assert.match(text, /【即时互动】/u);
  assert.match(text, /通用价值结算/u); assert.match(text, /不得输出货币、G或EXP/u);
  assert.match(text, /eyon.ruin-task.v1/u); assert.match(text, /不增加.*字段|itemReward/u);
});

test('开发文档采用预准备返程和本地档案，不宣称继续维护镜像', () => {
  const handoff = rule('12_墟境任务规则-脚本交接.txt');
  assert.match(handoff, /准备成功后创建唯一正常玩家楼/u);
  assert.match(handoff, /正文“遣返吧”等只表达意愿/u);
  assert.doesNotMatch(handoff, /流程B不得阻塞流程A/u);
  assert.match(rule('07_蝴蝶效应与墟境状态面板读取契约.txt'), /visibleButterflyArchives/u);
  assert.doesNotMatch(rule('07_蝴蝶效应与墟境状态面板读取契约.txt'), /resolveArchiveWorldbookName|面板正文入口读取世界书镜像/u);
  assert.match(rule('04_本地资料库与命名空间契约.txt'), /镜像写入已退役/u);
});
