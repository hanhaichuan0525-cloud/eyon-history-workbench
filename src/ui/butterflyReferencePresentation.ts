import { absurdityLabel, type ActiveButterflySelectKey, type ButterflyReferences, type BUTTERFLY_OPTIONS } from '../core/creativeReferences.ts';

type SelectKey = keyof typeof BUTTERFLY_OPTIONS;
type Copy = readonly [label: string, meaning: string];

// 只改变玩家看到的短语；枚举、存档和模型提示仍使用 core 中的原值。
export const BUTTERFLY_FIELD_LABELS: Record<SelectKey, string> = {
  scope: '波及范围', domain: '侧重领域（可选）', intensity: '改写深度',
  legend: '故事有多传奇', evolution: '如何发展下去',
  mood: '读起来什么感觉', manifestation: '如何发现变化',
};
export const BUTTERFLY_PRESET_LABELS: Record<string, string> = {
  '让历史自己生长': '顺其自然', '人间长歌': '人物成长',
  '奇想涟漪': '意外与幽默', '时代回声': '跨国回响',
};
const OPTIONS: { [K in Exclude<SelectKey, 'scope'>]: Record<ButterflyReferences[K], Copy> } = {
  domain: {
    '顺势生长': ['顺其自然', '重点随行动展开'],
    '人物命运': ['个人命运', '关注个体存续与处境'],
    '亲缘与后代': ['家人与后代', '关注家人或继承者'],
    '风俗与日常': ['风俗日常', '关注生活风俗'],
    '知识与技术': ['知识技术', '关注知识与技术道路'],
    '信仰与文化': ['信仰文化', '关注信仰与共同记忆'],
    '政治与战争': ['政治战争', '关注权力与战局'],
    '生态与地域': ['生态地域', '关注环境与生活条件'],
    '多域交织': ['多个方面', '关注多个方面的联动'],
  },
  intensity: {
    '顺势生长': ['顺其自然', '变化深浅随拐点而定'],
    '细微涟漪': ['细节变化', '偏向细小改变'],
    '局部改写': ['局部改变', '某段进程明显不同'],
    '深刻转折': ['深刻改变', '关键历史结果转向'],
    '时代回响': ['时代回响', '重要进程或格局不同'],
  },
  legend: {
    '平凡人生': ['平凡日常', '保留日常分量'],
    '值得流传': ['值得流传', '留下值得复述的经历'],
    '传奇人生': ['曲折传奇', '带出曲折人生'],
    '史诗回响': ['时代故事', '把人生接入漫长历史'],
  },
  evolution: {
    '顺势生长': ['顺其自然', '顺着人的需要发展'],
    '代际接力': ['代代相传', '由后人代代接力'],
    '缓慢积累': ['逐渐积累', '从小实践逐渐积累'],
    '曲折扩散': ['曲折传播', '受阻后重新传开'],
    '意外转用': ['意外新用途', '被后来的人用在新地方'],
    '多线汇合': ['多线交汇', '让几条变化相遇'],
  },
  mood: {
    '随历史生长': ['随故事变化', '随历史变化形成'],
    '温暖明亮': ['温暖明亮', '温暖、有希望'],
    '幽默诙谐': ['轻松诙谐', '轻巧、有趣'],
    '黑色幽默': ['辛酸幽默', '好笑又辛酸'],
    '悲喜交织': ['悲喜交织', '欣慰与遗憾并存'],
    '庄严震撼': ['庄重震撼', '庄重、有分量'],
    '冷峻沉思': ['克制深思', '克制、引人深思'],
  },
  manifestation: {
    '自然遇见': ['自然遇见', '日常见闻'],
    '人物与关系': ['人物关系', '遇见的人与关系'],
    '生活与习俗': ['生活习俗', '饮食、称呼与习惯'],
    '器物与技术': ['器物技术', '可使用的器物与技术'],
    '信仰与公共景观': ['信仰景观', '供奉、仪式或建筑'],
    '传闻与作品': ['传闻作品', '听闻、歌谣或书籍'],
    '多种线索': ['多种线索', '几个不同渠道'],
  },
};
const ABSURDITY: Record<string, Copy> = {
  '朴素': ['贴近日常', '保持朴实'],
  '微妙': ['微妙偏差', '少量偏差带来意外'],
  '离奇': ['离奇转向', '明显偏离直接预期'],
  '奇诞': ['大胆奇诞', '疏远的事件意外相连'],
  '极诞': ['离奇演变', '演变离奇但可追溯'],
};

export function butterflyOptionCopy(key: SelectKey, value: string): Copy {
  if (key === 'scope') return [value, '主要观察尺度，不是实际影响的天花板。'];
  const options = OPTIONS[key] as Record<string, Copy>;
  return Object.hasOwn(options, value) ? options[value] : [value, '由实际行动和历史条件决定。'];
}
export function butterflyAbsurdityCopy(value: number): Copy {
  return ABSURDITY[absurdityLabel(Number.isFinite(value) ? value : 35)];
}
export function butterflyStylePreview(refs: ButterflyReferences): string {
  const meaning = (key: Exclude<ActiveButterflySelectKey, 'scope'>) => butterflyOptionCopy(key, refs[key])[1];
  const scope = refs.scope === '顺势生长' ? '从真实拐点选择观察尺度，' : `主要观察「${refs.scope}」，`;
  const focus = refs.focus.trim() ? '靠近关注对象，' : '';
  return `${scope}${focus}${meaning('intensity')}，${meaning('domain')}。`
    + `路线${butterflyAbsurdityCopy(refs.absurdity)[1]}，读感${meaning('mood')}；实际成果保留，结局不预定。`;
}
