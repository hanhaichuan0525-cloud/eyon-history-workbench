/**
 * 「玩家的话说得不全／这件事该去工作台做」这类**可引导**错误。
 *
 * β1.1 真机病历：聊天里只输入「墟境探索」，工作台草稿为空 → `getInput` 抛普通 Error
 * → `registerLifecycle.failClosed` 调 `stopGeneration()` 把**整楼生成掐掉**，
 * 玩家只看到自己那条消息。因此这里给引导类问题一个独立类型：
 * 生命周期只对**非引导类**错误停生成；引导类错误照常产出正文，
 * 由角色卡（命定系统）把玩家引到工作台。
 *
 * 判定同时看 `instanceof` 与 `name`，这样跨 bundle/跨窗口副本也能识别。
 */
export class WorkbenchGuidanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkbenchGuidanceError';
  }
}

export function isWorkbenchGuidanceError(value: unknown): boolean {
  if (value instanceof WorkbenchGuidanceError) return true;
  if (typeof value !== 'object' || value === null) return false;
  return (value as { name?: unknown }).name === 'WorkbenchGuidanceError';
}
