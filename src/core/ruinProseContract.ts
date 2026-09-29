/**
 * 墟境史稿长度契约（单一真源）。
 * 提示词、校验器都必须从这里读取，禁止再手写魔法数字，
 * 避免「提示词说 400-650、校验器判 380-700」的两层漂移。
 *
 * 模型是概率输出，字数有自然方差；阈值给足容差，
 * 只在真正「敷衍（骨架级）」或「超长（逼近截断）」时拦截。
 */
export const RUIN_PROSE_TARGET_CHARS = 500;
export const RUIN_PROSE_NORMAL_MIN = 320;
export const RUIN_PROSE_NORMAL_MAX = 650;
export const RUIN_PROSE_ACCEPTED_MIN = 300;
export const RUIN_PROSE_ACCEPTED_MAX = 700;

/** 面向模型的长度契约文案（prompt 引用）。 */
export function ruinProseLengthInstruction(): string {
  return `historyProse should target about ${RUIN_PROSE_TARGET_CHARS} Chinese characters, normally ${RUIN_PROSE_NORMAL_MIN}-${RUIN_PROSE_NORMAL_MAX} (accepted ${RUIN_PROSE_ACCEPTED_MIN}-${RUIN_PROSE_ACCEPTED_MAX}, so a lean but concrete passage is fine). Prefer concrete actions, period texture and motives over explanation; add new specifics instead of restating the outline summary.`;
}

/** 面向修复提示的扩写指引（validator 报错引用）。 */
export function ruinProseExpansionGuidance(current: number): string {
  return `当前史稿 ${current} 字，低于下限 ${RUIN_PROSE_ACCEPTED_MIN} 字。请把整篇史稿扩写到至少 ${RUIN_PROSE_ACCEPTED_MIN} 字（去除空白后的中文字符数，含标点），不要只补几个字：补充本时期的具体事件过程、在场人物的实际动作与选择、因果推进的细节与余波收束，让史料事实与合理推演都落在正文里。`;
}
