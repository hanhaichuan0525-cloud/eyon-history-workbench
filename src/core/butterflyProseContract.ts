import type { ButterflyScope } from '../schemas/butterfly.ts';

export interface ButterflyEvolutionLengthContract {
  targetMin: number;
  targetMax: number;
  acceptedMin: number;
  acceptedMax: number;
  stageTarget: string;
}

const PERSONAL: ButterflyEvolutionLengthContract = {
  targetMin: 220,
  targetMax: 360,
  acceptedMin: 160,
  acceptedMax: 440,
  stageTarget: '2至3个',
};

const COMMUNITY: ButterflyEvolutionLengthContract = {
  targetMin: 320,
  targetMax: 520,
  acceptedMin: 160,
  acceptedMax: 620,
  stageTarget: '3至4个',
};

const LARGE_SCALE: ButterflyEvolutionLengthContract = {
  targetMin: 450,
  targetMax: 700,
  acceptedMin: 220,
  acceptedMax: 780,
  stageTarget: '4至5个',
};

export function butterflyEvolutionLengthContract(
  scope: ButterflyScope,
): ButterflyEvolutionLengthContract {
  if (['个人', '双人'].includes(scope)) return PERSONAL;
  if (['小队', '聚落', '城市'].includes(scope)) return COMMUNITY;
  return LARGE_SCALE;
}

export function butterflyEvolutionLengthInstruction(scope: ButterflyScope): string {
  const contract = butterflyEvolutionLengthContract(scope);
  return `本次范围为“${scope}”：historicalEvolution 目标 ${contract.targetMin}-${contract.targetMax} 个中文字符，通常安排 ${contract.stageTarget} 功能不同的阶段；校验仅在低于 ${contract.acceptedMin} 或高于 ${contract.acceptedMax} 时拦截自然波动。`;
}

const SCOPE_NARRATIVE_BOUNDARIES: Record<ButterflyScope, string> = {
  个人: '只永久改写一名核心人物的生活状态、身份、身体、财产、记忆、名誉或关键选择；他人可以目击、议论或受轻微牵连，但不得再出现第二条同等分量的人生改写，也不得升级成集体制度。',
  双人: '永久改写恰好两名核心人物之间的关系、契约、债务、亲缘、敌意、依赖或共同秘密；第三方只能充当见证者、阻力或执行者，不能夺走两人关系作为结果核心。',
  小队: '永久改写一个边界清楚的有限团体，例如调查队、卫队小组、家族支系、教团小组或工作单位；重点落在成员分工、内部规则、共享秘密或集体名誉，不得扩成整个聚落的共同秩序。',
  聚落: '永久改写一个有共同生活空间的小型共同体，例如村庄、街区、庄园、城堡附属区或据点；变化应落在一处公共资源、地方习俗、建筑、权威或共同记忆上，聚落之外只保留零散回声。',
  城市: '永久改写一座城市的制度、主要组织网络、贸易、治安、宗教、建筑或人口运行方式；可以在不同街区表现不均，但不得自动成为周边地区的普遍规则。',
  省份级地区: '永久改写多个聚落之间共享的行政、交通、生态、产业或族群系统；必须说明它们为何被同一机制串联，同时不能把该机制写成全国默认制度。',
  国家: '永久改写国家机器或全国尺度的法律、继承、军制、货币、宗教、经济或族群格局；国外可以回应、获利或警惕，但结果核心仍应收束在该国。',
  跨国: '永久改写两个以上政治实体之间的贸易、战争、信仰、迁徙、外交或跨国组织网络；必须让至少两方通过同一载体持续相互作用，但不得空泛扩大为整个世界都被改变。',
};

/**
 * 蝴蝶效应的范围不是“有多少人听说”，而是“哪个最小社会容器的正常状态
 * 被永久改写”。这段提示只约束叙事结果，不增加结构化字段或第二次模型调用。
 */
export function butterflyScopeNarrativeInstruction(scope: ButterflyScope): string {
  return [
    `“${scope}”表示被永久改写的最小社会容器，不是听闻消息、围观或短期受波及的人数。${SCOPE_NARRATIVE_BOUNDARIES[scope]}`,
    '低骰点不是低价值：个人与双人范围要写出贴身、具体且会继续影响选择的后果；高骰点也不能只靠宏大旁白，必须从一个可见的地方、人物或物件切入系统变化。',
    '让因果链发生一次出人意料但回看后合理的性质变化；明确谁从变化中获益、谁替它付出代价，并在现世留下一个能被玩家继续调查、利用、保护、交易、对抗或误解的遗留物。',
    '以上要求必须融入自然史稿，不得写成范围说明、得失清单、游戏结算报告或固定模板。',
  ].join(' ');
}

// internal.81 v16（蝴蝶长度门契约化）：
// 真机病历 ACTION_LENGTH_INVALID——validator 曾对 ruinActionRecord 手写 80-180 硬门，
// 但规则文本只写「建议长度」，prompt 从未告知模型拦截线：模型如实精简（行动少时
// 自然不足 80 字）即被整轮拒收，同一轮反复完整重生成累计 4 分钟级卡死（与请求
// 体量无关，v15 瘦身因此无效）。此处把该字段纳入契约单一真源：
// target 80-180 与规则文本「建议」一致；acceptedMin 20（防呆，空转/敷衍由
// schema min(1) 与 PLAYER_ACTION_UNSOURCED 实质兜底）、acceptedMax 400（防面板
// 失控）；窗口内自然波动一律放行，prompt 明示拦截线，模型不再盲飞。
export interface ButterflyActionRecordLengthContract {
  targetMin: number;
  targetMax: number;
  acceptedMin: number;
  acceptedMax: number;
}

export const BUTTERFLY_ACTION_RECORD_LENGTH_CONTRACT: ButterflyActionRecordLengthContract = {
  targetMin: 80,
  targetMax: 180,
  acceptedMin: 20,
  acceptedMax: 400,
};

export function butterflyActionRecordLengthInstruction(): string {
  const { targetMin, targetMax, acceptedMin, acceptedMax } =
    BUTTERFLY_ACTION_RECORD_LENGTH_CONTRACT;
  return `ruinActionRecord 只总结玩家实际完成的关键干涉，不得补写玩家未做过的行动；目标 ${targetMin}-${targetMax} 个中文字符，校验仅在低于 ${acceptedMin} 或高于 ${acceptedMax} 时拦截自然波动。`;
}
