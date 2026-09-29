/**
 * 地点层级拆分（ruin 疆域引用与蝴蝶记忆关键词共用）。
 *
 * 真机病历（internal.87，G-10①）：蝴蝶记忆通道把 `cascadeScope.locations` 里的
 * 整条地点链（如「奥古斯提姆帝国-东部金谷城外郊-第三麦庄草料库」）当成一个关键词，
 * 正文里永远不可能逐字命中 → 死词。这里复用 ruin 早已存在的同款拆分，
 * 让每个层级各自成为可命中的专名候选。
 */
const GENERIC_TERMS = new Set([
  '大陆', '全境', '地区', '区域', '世界', '位面', '王国', '帝国', '公国',
  '联邦', '联盟', '城市', '要塞', '圣地', '一带', '附近',
]);

/**
 * 把「地点范围」拆成候选疆域引用串（按层级分隔符拆分并去除通用词）。
 * 引擎按实体名归一化匹配；命中 catalog 实体且目标纪元不可用时降级为 warning，
 * 不再把「地点范围=奥古斯提姆帝国」误判为「要求帝国出场」。
 */
export function territorialFragments(location: string): string[] {
  if (!location?.trim()) return [];
  return location
    .split(/[-—·•・/\\>→\s]+/u)
    .map(value => value.trim())
    .filter(value => value.length >= 2)
    .filter(value => !GENERIC_TERMS.has(value));
}
