/** 每份异步读取都绑定视图版本和聊天版本。后到的旧结果没有写入权。 */
export class ViewRefreshGuard {
  private version = 0;
  private disposed = false;
  private readonly contextRevision: () => number;
  constructor(contextRevision: () => number) { this.contextRevision = contextRevision; }
  begin(): () => boolean {
    const version = ++this.version;
    const context = this.contextRevision();
    return () => !this.disposed && version === this.version && context === this.contextRevision();
  }
  invalidate(): void { this.version += 1; }
  dispose(): void { this.disposed = true; this.invalidate(); }
}

/** 重建受信模板时保留玩家的编辑/阅读状态，不回写业务资料。 */
export function preserveDomState(root: ShadowRoot): () => void {
  const elements = Array.from(root.querySelectorAll<HTMLElement>('*'));
  const key = (element: HTMLElement, index: number): string => JSON.stringify([
    element.tagName, element.id, element.getAttribute('name'),
    Array.from(element.attributes).filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value]),
    element.tagName === 'DETAILS' ? element.querySelector('summary')?.textContent : '',
    // 无稳定标识的同型元素以模板位置区分。
    element.id || Array.from(element.attributes).some(a => a.name.startsWith('data-')) ? 0 : index,
  ]);
  const saved = new Map(elements.map((element, index) => [key(element, index), {
    top: element.scrollTop, left: element.scrollLeft,
    open: element.tagName === 'DETAILS' ? (element as HTMLDetailsElement).open : undefined,
  }]));
  const active = root.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const activeKey = active ? key(active, elements.indexOf(active)) : '';
  const selection = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
  return () => {
    Array.from(root.querySelectorAll<HTMLElement>('*')).forEach((element, index) => {
      const id = key(element, index);
      const previous = saved.get(id);
      if (previous) {
        if (previous.open !== undefined) (element as HTMLDetailsElement).open = previous.open;
        element.scrollTop = previous.top;
        element.scrollLeft = previous.left;
      }
      if (id !== activeKey) return;
      element.focus({ preventScroll: true });
      if (selection && selection[0] !== null && selection[1] !== null) {
        try { (element as HTMLInputElement).setSelectionRange(selection[0], selection[1]); } catch { /* number/select 无文本光标 */ }
      }
    });
  };
}
