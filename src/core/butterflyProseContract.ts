import type { ButterflyScope } from '../schemas/butterfly.ts';

export interface ButterflyEvolutionLengthContract {
  targetMin: number;
  targetMax: number;
  acceptedMin: number;
  stageTarget: string;
}

const PERSONAL: ButterflyEvolutionLengthContract = {
  targetMin: 320,
  targetMax: 650,
  acceptedMin: 160,
  stageTarget: '2至3个',
};

const COMMUNITY: ButterflyEvolutionLengthContract = {
  targetMin: 450,
  targetMax: 900,
  acceptedMin: 160,
  stageTarget: '3至4个',
};

const LARGE_SCALE: ButterflyEvolutionLengthContract = {
  targetMin: 650,
  targetMax: 1200,
  acceptedMin: 220,
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
  return `本次范围为“${scope}”：historicalEvolution 建议 ${contract.targetMin}-${contract.targetMax} 个中文字符，通常安排 ${contract.stageTarget} 功能不同的阶段。字数只是写作参考，讲清因果需要时可以更长；不因超长拒收或裁剪全文，仅保留 ${contract.acceptedMin} 字的最低完整性检查，不凑字。`;
}

export const BUTTERFLY_READABILITY_INSTRUCTION = '文字先让人看明白，再追求史诗感或文学性。用清楚、自然的现代中文，写明谁做了什么、为什么这样做、后来怎样；跨时代时交代承接者，代词指向明确。专名照用世界书，但新概念第一次出现用具体动作或普通话说明，不堆生造术语、名词链、四字辞藻或公文黑话。尽量一句讲一件事，按因果转折自然分段；荒诞可以发生在事情上，不要发生在句子的可读性上。';

/** 正向创作方法只影响同一次生成的写法，不增加调用、输出字段或校验门。 */
export const BUTTERFLY_CREATIVE_METHOD_INSTRUCTION = [
  '先把九项偏好合成一个观察历史的角度，在内部探索两到三条不同的可能路径，选出最有生命力、最贴合本轮行动与偏好的那一条。只输出选定故事，不展示候选、分析或思考过程。',
  '让承接者拥有自己的愿望、处境与选择：他为什么在此时需要这件事，愿意为谁坚持，遇到什么机会或阻力，后来如何改变用途。人的主动选择让历史生长，制度和记录是可用载体之一。',
  '把时间当成变化的空间：同一份遗产在不同的人手里可以成为手艺、感情、信念、游戏、事业或新的共同生活。不同地区可以接受、改造或拒绝同一变化，范围来自这些具体联系，深度来自它对人生的作用。',
  '小行动也能留下长回声，朴素人生也能令人惊喜。顺着世界已有的需求、技术、信仰和人物寿命找到可信桥梁，再让结果超出直接预期；保留既定行动与正史边界，结局交给这些条件共同长成。',
  '历史先长成，再选择玩家能够接触的感知窗口。一次相遇、一件会使用的器物、一种熟悉却改变了的习惯，都能让玩家理解远方发生的变化；观察窗口、实际波及范围和冻结归返锚点各司其职。',
  '变化可沿人生的志愿与际遇、感情与后代、技术与创造、信仰与竞争、生态与迁徙、游戏与习俗等不同方向生长。根据本次行动寻找最有潜力的联系，容纳壮阔、轻巧、甜蜜、残酷或极诞的结果；不用固定范文决定每轮的人物、载体与终点。',
].join('\n');

/** 仅供旧冻结请求回显，不再把旧档位变成永久改写或叙事规模硬要求。 */
export function butterflyScopeNarrativeInstruction(scope: ButterflyScope): string {
  return [
    `旧冻结范围“${scope}”仅用于兼容回显，不重新抽取，不把它当作受益人数配额、传播天花板或永久改写要求。已生成的同楼结果复用全文，新的历史创作沿实际行动与承接条件生长。`,
    '起因与结果可以不成比例，但不是越不成比例越好。小范围也可以深刻改变人生，大范围需要具体载体和传播条件，不用宏大旁白代替因果。',
    '误读是可选的叙事路径；正确传承、主动创新、后代成长与普通人的自主选择同样可以产生惊喜。',
    '允许荒诞、黑色幽默、滑稽与庄严的反差、传奇腔与史笔混用；允许结果超出玩家预料、利弊并存、利弊不均，甚至纯属意外。',
    '代价不是硬性要求：可以有人受损，也可以所有人受益；结果来自可信的选择、行动与传播条件。',
    '选择一个现世可接触的具体感知窗口，可以是一场相遇、生活习惯或可使用的物件；不要求立即发生在归返地。留出能继续调查、利用、保护、交易、对抗或误解的空间。',
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
