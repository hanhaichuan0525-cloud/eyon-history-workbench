/** 仅用于脚本自带规则；不接收世界书、聊天、人物附件或玩家输入。 */
export function deduplicateEmbeddedRules<T extends Record<string, string>>(rules: T): T {
  return Object.fromEntries(Object.entries(rules).map(([key, text]) => {
    // 每份规则可能被独立消费，不能跨文件去重，否则扩写阶段会丢约束。
    const seen = new Set<string>();
    return [key, text.split(/(\r?\n\s*\r?\n)/u).map(part => {
      if (part.length < 100 || /^\s*$/u.test(part)) return part;
      if (seen.has(part)) return '';
      seen.add(part);
      return part;
    }).join('')];
  })) as T;
}
