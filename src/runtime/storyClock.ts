/**
 * 剧情时钟：从正文楼层解析剧情时间戳。
 *
 * 正文协作指令要求伊雍楼正文首尾各输出一个 HTML 注释时间戳
 * （酒馆不渲染，玩家不可见；注释留在楼层文本里供本模块读回）：
 *   <!-- EYON-TIME-START 复兴纪元488年3月15日14时 -->
 *   <!-- EYON-TIME-END 复兴纪元488年3月16日9时 -->
 *
 * 宽松解析：起/止任一存在即返回（缺失侧为空串）；两者皆无返回 null。
 * 遵循「宁可不标，绝不标错」：解析不出不猜、不补默认值。
 */

export interface StoryClock {
  start: string;
  end: string;
}

const START_RE = /<!--\s*EYON-TIME-START\s+([\s\S]*?)-->/u;
const END_RE = /<!--\s*EYON-TIME-END\s+([\s\S]*?)-->/u;

export function parseStoryClock(content: string): StoryClock | null {
  const start = content.match(START_RE)?.[1]?.trim() ?? '';
  const end = content.match(END_RE)?.[1]?.trim() ?? '';
  if (!start && !end) return null;
  return { start, end };
}
