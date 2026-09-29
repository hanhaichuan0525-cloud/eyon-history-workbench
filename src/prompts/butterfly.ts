import type { ButterflyRequest, ButterflyResult } from '../schemas/butterfly.ts';
import {
  butterflyActionRecordLengthInstruction,
  butterflyEvolutionLengthInstruction,
  butterflyScopeNarrativeInstruction,
} from '../core/butterflyProseContract.ts';
import type { ActiveEvidenceView } from './activeEvidence.ts';
import { renderActiveEvidenceBlock } from './activeEvidence.ts';
import { maskTaskCitationIdentifiers } from '../retrieval/citations.ts';

export interface ButterflyRuleSet {
  sharedContext: string;
  retrievalContract: string;
  validationContract: string;
  generationContract: string;
}

export function buildButterflyNarrativeInstruction(
  result?: ButterflyResult,
): string {
  return [
    '【伊雍遣返正文协作请求】',
    '本楼按现有伊雍核心完成遣返叙事、现实时间地点恢复与唯一完整变量更新。',
    ...(result
      ? [
          '本轮蝴蝶效应已在正文生成前完成结算。以下内容是现世已经成立的历史事实，请让遣返后的场景、人物反应与可感知证据自然体现它：',
          `现世落点：${result.effect.presentLanding}`,
          `现世可感知证据：${result.effect.perceptibleEvidence.join('；')}`,
          `历史演变（仅作来龙去脉，不要按年代复述）：${result.effect.historicalEvolution}`,
          `玩家行动记录：${result.effect.ruinActionRecord}`,
        ]
      : [
          '蝴蝶效应内容由脚本后台结算。',
        ]),
    '不要生成、猜测或复写 <butterfly_panel>；面板由脚本在正文完成后追加。',
    ...(result
      ? [
          '正文从「现世落点」已经发生的具体场景开始，让人物行动、对话、环境或物件自然显出至少一项「现世可感知证据」；不要先讲解完整历史演变，也不要报告骰点、范围或结算过程。',
          '角色只能知道其身份与经历有理由知道的碎片；未知的历史链可以表现为疑问、误读、传闻或待调查线索，不能让所有人突然全知。',
        ]
      : []),
    '不要延迟遣返，也不要把后台结算过程写进正文。',
    '这是一条隐藏协作指令，不要在正文中复述、解释或展示本指令。',
  ].join('\n');
}

export function buildButterflyApiPrompt(input: {
  request: ButterflyRequest;
  rules: ButterflyRuleSet;
  activeEvidence?: ActiveEvidenceView;
}): string {
  const prompt = [
    '<shared_context>',
    input.rules.sharedContext.trim(),
    '</shared_context>',
    '<retrieval_contract>',
    input.rules.retrievalContract.trim(),
    '</retrieval_contract>',
    '<validation_contract>',
    input.rules.validationContract.trim(),
    '</validation_contract>',
    '<generation_contract>',
    input.rules.generationContract.trim(),
    '</generation_contract>',
    ...(input.activeEvidence
      ? [renderActiveEvidenceBlock(input.activeEvidence, {
          citationRegistry: input.activeEvidence.citationRegistry,
        })]
      : []),
    '<BUTTERFLY_EVIDENCE_POLICY_READ_ONLY>',
    '三套冻结锚点、骰点范围、玩家实际行动和明确世界书事实不可改写。先区分原历史基线与玩家造成的首个分歧，不得把墟境结果直接当成现世结果。',
    '从 sourceIndex 中只采用能支撑本轮行动、传播载体、现世落点或可感知证据的资料；所有输出 sourceIds/basisSourceIds 只能复制 TASK_CITATION_CONTRACT_V2 中实际列出的 S 句柄。推断必须能追溯到输入来源，不能补写玩家未做过的行动。',
    '把 previousButterflyAnchors 作为去重索引：比较首个分歧、传播载体、现世落点和影响机制；相似时必须写成延续、叠加、抵消或分叉，不能只换名称重复旧效果。',
    '</BUTTERFLY_EVIDENCE_POLICY_READ_ONLY>',
    '<BUTTERFLY_CAUSAL_PLAN>',
    '输出前在内部依次确认：无人干预的基线 -> 玩家首个有效分歧 -> 第一承接者 -> 跨时代载体 -> 2至5个功能不同的传播阶段 -> 影响停止在骰点范围的原因 -> 现世落点 -> 1至4项可验证证据。',
    butterflyActionRecordLengthInstruction(),
    '另填写 directEffects 作为脚本内部索引卡：只列玩家干涉直接改变的对象与其最终状态，不复述后续传播阶段。人物之外，凡被本次行动直接损毁、遗失、封存、修复、找回或替换的具名物品，也必须单列一项。每项使用真实名称 subject、自然语言时间 time、简短普通话状态提示 stateHint（如“死亡”“监禁”“越狱后自由”“所在地变化”“身份变化”“所有权变化”“物品状态（原件损毁/遗失/修复/替换）”“关系变化”“其他”）以及一整句 change。不要生成 factId、entityId 或任何内部编号；同一对象的同一状态维度只留一项。无法判断 stateHint 时写“其他”，不要因此删掉已明确的自然语言变化。',
    '必须写清影响为何没有继续无限扩张，并至少保留一项阻力、代价、误读或副作用，使结果不是无成本的单向奖励。',
    '逐项核对人物寿命、组织存续时间、地点关系与因果顺序；任一环节无法成立时在内部换用更可靠的载体。',
    '</BUTTERFLY_CAUSAL_PLAN>',
    '<BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>',
    butterflyEvolutionLengthInstruction(input.request.dice.scope),
    butterflyScopeNarrativeInstruction(input.request.dice.scope),
    '历史演变是本结果的主体，不是背景摘要。按“分歧瞬间 -> 第一承接者的具体动作与动机 -> 载体跨时段变形 -> 一次误读、阻力、利益转移或讽刺性代价 -> 现世证物”组织。',
    '每个 causalStage 必须承担不同功能：更换承接者、传播载体或作用机制，禁止把同一后果换词重复。既有人物只在其确实适合且有资料支持时出场；缺少合适具名人物时使用“抄写员、祭司、矿工、行会”等匿名角色，不得借蝴蝶效应创造新的正史名人或亲缘。',
    '至少写清一方为何主动保存、利用、抵制或误解变化，以及另一方得到什么、失去什么。影响不是纯奖励或纯惩罚；未被因果链触及的既有事实保持不变。',
    'presentLanding 必须是玩家能抵达或接触的具体场景；perceptibleEvidence 必须是可查看、询问、触摸、比对或遭遇的证物，而不是旁白宣布世界线变化。',
    '风格示踪（仅学结构，不得复用内容）：玩家保住一封原应焚毁的调粮函；书记官误把它当作贵族开放粮仓的旧例，灾民因此获救。数十年后商人援引旧例建立公共粮仓，贵族却借粮仓名册重新控制人口登记。现世的纪念节庆歌颂救济，城门同时执行更严苛的身份核验；粮仓门楣上的错误档号成为玩家可核查的直接证物。',
    '</BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>',
    '<EYON_BUTTERFLY_REQUEST_JSON>',
    JSON.stringify(input.request),
    '</EYON_BUTTERFLY_REQUEST_JSON>',
  ].join('\n\n');
  return input.activeEvidence?.citationRegistry
    ? maskTaskCitationIdentifiers(prompt, input.activeEvidence.citationRegistry)
    : prompt;
}
