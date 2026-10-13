import type { RuinNode } from '../schemas/ruin.ts';
import { RUIN_STYLE_OPTIONS } from '../core/creativeReferences.ts';

export { formatRuinNodeExactTime } from '../renderers/ruinTimeLabel.ts';

export function fullRuinStageIntroduction(node: RuinNode): string {
  return node.summary.trim();
}

// 玩家只需知道选项的主要差别；模型仍使用 core 中的完整创作释义。
const RUIN_STYLE_SUMMARIES: { [G in keyof typeof RUIN_STYLE_OPTIONS]: Record<(typeof RUIN_STYLE_OPTIONS)[G][number], string> } = {
  telling: {
    '随内容自动': '根据这件事，选择最合适的讲述角度。',
    '事情始末': '讲清事情为什么开始、如何发展、留下什么。',
    '现场展开': '以动作和对话展开，让人仿佛身在现场。',
    '贴近内心': '跟随人物的感受、误解与选择理解事情。',
    '逐步揭示': '线索逐渐补全，前面的细节获得新意味。',
    '多方讲述': '从不同人的眼中，拼出同一件事的全貌。',
    '回忆讲述': '带着回望的语气，写出往事留下的余味。',
    '传闻拼合': '从见闻、转述与痕迹中，逐渐拼起事情。',
    '对话推进': '让问答、试探与回应推动事情发展。',
    '物件串联': '跟随一件物品，连接不同的场面与关系。',
    '以小见大': '从一件小事，看见它所处的时代。',
  },
  pace: {
    '随内容自动': '随事件安排快慢，把篇幅留给重要时刻。',
    '舒缓描写': '细看少数重要瞬间，让动作与感受慢慢展开。',
    '循序推进': '一步接一步推进，来由与回应清楚相连。',
    '紧凑展开': '少铺垫，行动与发现紧密相接。',
    '起伏鲜明': '期待、落差与转机更鲜明，小事也能有波澜。',
    '先缓后紧': '先熟悉处境，再逐渐加快走向关键时刻。',
    '张弛交替': '紧密行动与短暂喘息交替，各有作用。',
    '前后呼应': '先前的细节再次出现，留下不同的意味。',
  },
  mood: {
    '随内容自动': '让情绪随人物的处境与关系自然生长。',
    '轻松有趣': '从误会、笨拙与小小错位中写出趣味。',
    '温暖亲近': '以具体的照顾与回应，写出人与人的温度。',
    '甜蜜暧昧': '适合的成年关系中，心意藏在试探与默契里。',
    '紧张不安': '在等待与未知中，感受逐渐积累的压力。',
    '冷静克制': '少下情绪判断，用准确动作和留白传达分量。',
    '悲伤惋惜': '写出珍惜、错过与余韵，不必是悲剧。',
    '热烈昂扬': '用投入、协作与坚持，写出向前的力量。',
    '复杂交织': '同一件事里，喜悦、遗憾或戒备相互牵动。',
    '新奇惊艳': '通过具体发现，感受陌生事物的奇妙。',
    '神秘诡异': '熟悉之中出现异样，让未知逐渐可感。',
    '荒诞幽默': '各自认真的做法，碰出意想不到的错位。',
    '孤独清冷': '用距离、缺席与日常动作，留下清冷余味。',
  },
};

export function ruinStyleSummary(group: keyof typeof RUIN_STYLE_OPTIONS, value: string): string {
  const option = RUIN_STYLE_OPTIONS[group].find(option => option === value) ?? '随内容自动';
  return (RUIN_STYLE_SUMMARIES[group] as Record<string, string>)[option];
}
