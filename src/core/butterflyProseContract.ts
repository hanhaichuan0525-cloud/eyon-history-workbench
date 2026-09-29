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

/**
 * 骰点只决定「结果落地时的规模」——不决定起因的大小，也不决定因果比例。
 * 一次撒尿可以长出一个聚落；一次厉喝可以变成圣灵显圣。低骰点只是结果贴身，
 * 不是"这件事不重要"。这里刻意不再写上限禁令：过去"不得扩成整个聚落"这类
 * 措辞被模型读成"别想有趣的事"，是趣味性塌陷的主因之一。
 */
const SCOPE_NARRATIVE_BOUNDARIES: Record<ButterflyScope, string> = {
  个人: '结果规模为一个人：一名核心人物的身份、身体、财产、记忆、名誉或关键选择被永久改写。',
  双人: '结果规模为两个人的关系：亲缘、契约、债务、依赖、敌意或共同秘密被永久改写。',
  小队: '结果规模为一个边界清楚的有限团体（调查队、卫队小组、家族支系、教团小组、工作单位）：成员分工、内部规则、共享秘密或集体名誉被永久改写。',
  聚落: '结果规模为一个有共同生活空间的小型共同体（村庄、街区、庄园、城堡附属区、地下据点）：一处公共资源、地方习俗、建筑、权威或共同记忆被永久改写。',
  城市: '结果规模为一座城市：制度、组织网络、贸易、治安、宗教、建筑或人口运行方式被永久改写，可以在不同街区表现不均。',
  省份级地区: '结果规模为多个聚落共享的行政、交通、生态、产业或族群系统：说明它们为什么被同一机制串起来。',
  国家: '结果规模为一个国家机器或全国尺度：法律、继承、军制、货币、宗教、经济或族群格局被永久改写，境外可以回应、获利或警惕。',
  跨国: '结果规模为两个以上政治实体之间的贸易、战争、信仰、迁徙、外交或跨国组织网络：至少两方通过同一载体持续相互作用。',
};

/**
 * 这段提示只约束叙事结果，不增加结构化字段或第二次模型调用。
 * internal.89（趣味性回归）：范围=落地规模，起因与因果比例不受限；误读是一级
 * 叙事手段；代价改为可选。四条硬限（锚点/不虚构玩家行动/不与显式正史冲突/单一
 * 合法 JSON）在 §零 与 §六，不在这里重复堆叠。
 */
export function butterflyScopeNarrativeInstruction(scope: ButterflyScope): string {
  return [
    `“${scope}”只限定**结果落地时的规模**，不限制起因的大小，也不限制因果比例。${SCOPE_NARRATIVE_BOUNDARIES[scope]}`,
    '**越不成比例越有趣**：起因可以微不足道、可笑、下流、偶然，甚至纯属手滑；世界却完全可能郑重其事地把它读成神谕、先例、诅咒或灾兆。低骰点不是低价值——个人尺度的后果要贴身到改变下一次选择；高骰点也不能只靠宏大旁白，必须从一个可见的地方、人物或物件切入系统变化。',
    '必须写出一次**误读**：某个人、某个机构或后来的一整代人，把玩家的行为理解成了另一件事，并照着那个错误理解行动。误读是第一级叙事手段，不是瑕疵。',
    '允许荒诞、黑色幽默、滑稽与庄严的反差、传奇腔与史笔混用；允许结果超出玩家预料、利弊并存、利弊不均，甚至纯属意外。',
    '代价不是硬性要求：可以有人受损，也可以所有人受益——只要世界确实是照着误读行动的。',
    '结尾必须落到现世一个具体地点与一件玩家能亲手核查的证物，它应当能被继续调查、利用、保护、交易、对抗或误解。',
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
