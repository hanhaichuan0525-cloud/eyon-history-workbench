/**
 * 墟境史稿长度契约（单一真源）。
 * 写作目标不是字符裁剪器。校验器仅拦截明显骨架级短稿，完整长文原样保存。
 */
export const RUIN_PROSE_TARGET_CHARS = 500;
export const RUIN_PROSE_NORMAL_MIN = 320;
export const RUIN_PROSE_NORMAL_MAX = 650;
export const RUIN_PROSE_ACCEPTED_MIN = 300;

/** 面向模型的长度契约文案（prompt 引用）。 */
export function ruinProseLengthInstruction(): string {
  return `historyProse should target about ${RUIN_PROSE_TARGET_CHARS} Chinese characters, normally ${RUIN_PROSE_NORMAL_MIN}-${RUIN_PROSE_NORMAL_MAX}; a lean concrete passage of at least ${RUIN_PROSE_ACCEPTED_MIN} is accepted. Length is a writing target, not an upper-limit check or truncation instruction: retain a complete account even if longer. Prefer concrete actions, period texture and motives over explanation; add new specifics instead of restating the outline summary.`;
}

/** 面向修复提示的扩写指引（validator 报错引用）。 */
export function ruinProseExpansionGuidance(current: number): string {
  return `当前史稿 ${current} 字，低于下限 ${RUIN_PROSE_ACCEPTED_MIN} 字。请把整篇史稿扩写到至少 ${RUIN_PROSE_ACCEPTED_MIN} 字（去除空白后的中文字符数，含标点），不要只补几个字：补充本时期的具体事件过程、在场人物的实际动作与选择、因果推进的细节与余波收束，让史料事实与合理推演都落在正文里。`;
}
