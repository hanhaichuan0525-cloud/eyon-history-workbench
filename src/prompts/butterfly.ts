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
    'directEffects 中可持续的变化（监禁、失踪、伤势、任职、迁居、婚姻、诅咒、物品归属等）补充短小 continuousState:{dimension,value,start,end?,world?}。dimension 是开放维度（同对象后续同维度沿用已有名称），value 是状态短语，start 是正文明确的生效日期，end 仅在正文明确结束时填。不同阶段分别记载，不用最新状态抹去旧事件。时间不足可不填，不得猜；不用内部 ID，不增加正文篇幅。',
    '输出前在内部依次确认：无人干预的基线 -> 玩家首个有效分歧 -> 第一承接者 -> **世界如何误读这件事** -> 跨时代载体 -> 2至5个功能不同的传播阶段 -> 结果为何落在本次规模 -> 现世落点 -> 1至4项可验证证据。',
    butterflyActionRecordLengthInstruction(),
    '另填写 directEffects 作为脚本内部索引卡：只列玩家干涉直接改变的对象与其状态转变，不复述无关传播阶段。人物之外，凡被本次行动直接损毁、遗失、封存、修复、找回或替换的具名物品，也必须单列一项。每项使用真实名称 subject、自然语言时间 time、简短普通话状态提示 stateHint（如“死亡”“监禁”“越狱后自由”“所在地变化”“身份变化”“所有权变化”“物品状态（原件损毁/遗失/修复/替换）”“关系变化”“其他”）以及一整句 change。不要生成 factId、entityId 或任何内部编号；同一对象同一时间同一维度只留一项，已有正文明确记载不同日期的转变则分别保留。无法判断 stateHint 时写“其他”，不要因此删掉已明确的自然语言变化。',
    '必须写清结果为何停在本次规模（是传播链自然收束，不是突然掐断）；但**代价不是硬性要求**——可以有人受损，也可以所有人受益，只要世界确实是照着对玩家行为的误读行动的。',
    '逐项核对人物寿命、组织存续时间、地点关系与因果顺序；任一环节无法成立时在内部换用更可靠的载体。',
    '</BUTTERFLY_CAUSAL_PLAN>',
    '<BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>',
    butterflyEvolutionLengthInstruction(input.request.dice.scope),
    butterflyScopeNarrativeInstruction(input.request.dice.scope),
    '历史演变是本结果的主体，不是背景摘要。按“分歧瞬间 -> 第一承接者的具体动作与动机 -> 世界对这件事的误读 -> 载体跨时段变形 -> 一次反转、利益转移或荒诞后果 -> 现世证物”组织。',
    '**惊喜优先**：这段文字要让玩家读到自己那一小下掀起的风暴，而且风暴的形状是他没预料到的。起因可以微不足道、可笑、下流或纯属失误，世界却可以郑重其事地把它当成神迹、先例或天罚。不要为了让结果显得“合理”而把它写成一份安全、正确、无可指摘的公文——那是最常见的失败形态。允许荒诞、黑色幽默、滑稽与庄严的反差、传奇腔与史笔混用。',
    '每个 causalStage 必须承担不同功能：更换承接者、传播载体或作用机制，禁止把同一后果换词重复。缺少合适具名人物时使用“抄写员、祭司、矿工、行会”等匿名角色；不得为既有正史人物虚构新的亲缘关系（玩家自己造成、且符合时间线的后代不在此限）。',
    '至少写清一方为何主动保存、利用、抵制或误解变化，以及谁从中得利、谁因此吃亏——也可以所有人得利。允许封圣、成神化、教团取代旧神信仰等社会性结果；不得改写世界神系本身，也不得让神真身降临。',
    'presentLanding 必须是玩家能抵达或接触的具体场景；perceptibleEvidence 必须是可查看、询问、触摸、比对或遭遇的证物，而不是旁白宣布世界线变化。',
    '两个示踪样文（只学节奏与反差，禁止复用其中的内容、名称与事件）：\n【有趣｜学这个】玩家几年前在旧城下水道撒了泡尿，被守夜人当成甘霖之兆抄进了祷文。旱年里有人靠这段祷文聚起信众；几十年后下水道被扩建成地下圣所，一群以“祈雨”为宗旨的教团握住了全城的清渠权。现世玩家走回旧城，渠口刻着一行没人认得的祷文，而清渠人正挨家挨户收“雨捐”。\n【失败｜不要这样写】玩家干涉后，相关记录被保存下来，制度因此发生变化，数十年后该地区形成了新的管理规范，并对当地社会产生了深远影响。',
    '</BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>',
    '<EYON_BUTTERFLY_REQUEST_JSON>',
    JSON.stringify(input.request),
    '</EYON_BUTTERFLY_REQUEST_JSON>',
  ].join('\n\n');
  return input.activeEvidence?.citationRegistry
    ? maskTaskCitationIdentifiers(prompt, input.activeEvidence.citationRegistry)
    : prompt;
}
