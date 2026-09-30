import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { installScrollPan, panGestureDecision } from '../src/ui/scrollPan.ts';

class FakeNode {
  parent: FakeNode | null = null;
  contains(target: FakeNode): boolean { return target === this || Boolean(target.parent && this.contains(target.parent)); }
}
class FakeElement extends FakeNode {
  scrollLeft = 50; scrollTop = 60;
  scrollWidth = 800; clientWidth = 200; scrollHeight = 700; clientHeight = 200;
  attributes = new Set<string>(); captures = new Set<number>();
  kind: string;
  constructor(kind = 'canvas') { super(); this.kind = kind; }
  closest(selector: string): FakeElement | null {
    if (selector.startsWith('input')) return this.kind === 'input' ? this : null;
    return this.kind === 'canvas' ? this : this.parent instanceof FakeElement ? this.parent.closest(selector) : null;
  }
  matches() { return this.kind === 'canvas'; }
  setAttribute(key: string) { this.attributes.add(key); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  hasPointerCapture(id: number) { return this.captures.has(id); }
  setPointerCapture(id: number) { this.captures.add(id); }
  releasePointerCapture(id: number) { this.captures.delete(id); }
  scrollBy({ left = 0, top = 0 }: ScrollToOptions) { this.scrollLeft += left; this.scrollTop += top; }
}
class FakeRoot extends FakeNode {
  listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  fire(type: string, target: FakeNode, patch: Record<string, unknown> = {}) {
    const event = {
      target, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0,
      clientX: 100, clientY: 100, cancelable: true, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...patch,
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event as unknown as Event);
    return event;
  }
}
const originals = new Map(['Node', 'Element', 'HTMLElement'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of [['Node', FakeNode], ['Element', FakeElement], ['HTMLElement', FakeElement]]) {
  Object.defineProperty(globalThis, key as string, { configurable: true, value });
}
after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function fixture(axis: 'x' | 'both' = 'x') {
  const root = new FakeRoot(); const canvas = new FakeElement(); const card = new FakeElement('button');
  canvas.parent = root; card.parent = canvas;
  const dispose = installScrollPan(root as unknown as ShadowRoot, '[data-canvas]', axis);
  return { root, canvas, card, dispose };
}

test('拖动阈值区分轻点、横向拖动与纵向让路', () => {
  assert.equal(panGestureDecision(3, 2, 'x'), 'pending');
  assert.equal(panGestureDecision(0, 20, 'x'), 'yield');
  assert.equal(panGestureDecision(20, 4, 'x'), 'pan');
  assert.equal(panGestureDecision(0, 20, 'both'), 'pan');
});
test('手机触摸交给原生滚动，不拦截轻点或惯性手势', () => {
  const { root, canvas, card, dispose } = fixture();
  root.fire('pointerdown', card, { pointerType: 'touch' });
  assert.equal(root.fire('pointermove', card, { clientX: 10 }).prevented, false);
  assert.equal(canvas.scrollLeft, 50);
  assert.equal(root.fire('click', card).prevented, false);
  dispose();
});
test('轻点节点不被拦截，微小手抖不变成拖动', () => {
  const { root, canvas, card, dispose } = fixture();
  root.fire('pointerdown', card); root.fire('pointermove', card, { clientX: 98 }); root.fire('pointerup', card);
  assert.equal(root.fire('click', card).prevented, false); assert.equal(canvas.scrollLeft, 50);
  dispose();
});
test('拖动卡片滚动画布，但不误选人物/历史阶段，下一次轻点正常', () => {
  const { root, canvas, card, dispose } = fixture();
  root.fire('pointerdown', card); root.fire('pointermove', card, { clientX: 20 });
  assert.equal(canvas.scrollLeft, 130); assert.equal(canvas.captures.size, 1);
  assert.ok(canvas.attributes.has('data-panning')); root.fire('pointerup', canvas);
  assert.equal(canvas.captures.size, 0); assert.equal(canvas.attributes.size, 0);
  const click = root.fire('click', card); assert.equal(click.prevented, true); assert.equal(click.stopped, true);
  root.fire('pointerdown', card); root.fire('pointerup', card); assert.equal(root.fire('click', card).prevented, false);
  dispose();
});
test('宗族画布支持上下左右拖动，节点时间轴不抢纵向滚动', () => {
  const board = fixture('both'); board.root.fire('pointerdown', board.card);
  board.root.fire('pointermove', board.card, { clientX: 60, clientY: 40 });
  assert.equal(board.canvas.scrollLeft, 90); assert.equal(board.canvas.scrollTop, 120); board.dispose();
  const timeline = fixture(); timeline.root.fire('pointerdown', timeline.card);
  assert.equal(timeline.root.fire('pointermove', timeline.card, { clientY: 50 }).prevented, false);
  assert.equal(timeline.canvas.scrollTop, 60); timeline.dispose();
});
test('忽略右键、其他指针及输入框，不破坏右键菜单或表单', () => {
  const { root, canvas, card, dispose } = fixture();
  root.fire('pointerdown', card, { button: 2 }); root.fire('pointermove', card, { clientX: 0 });
  const input = new FakeElement('input'); input.parent = canvas;
  root.fire('pointerdown', input); root.fire('pointermove', input, { clientX: 0 });
  root.fire('pointerdown', card); root.fire('pointermove', card, { clientX: 0, pointerId: 2 });
  assert.equal(canvas.scrollLeft, 50); dispose();
});
test('方向键仅在画布获得焦点时平移，不劫持节点按钮键盘操作', () => {
  const { root, canvas, card, dispose } = fixture('both');
  assert.equal(root.fire('keydown', card, { key: 'ArrowRight' }).prevented, false);
  root.fire('keydown', canvas, { key: 'ArrowRight' }); root.fire('keydown', canvas, { key: 'ArrowDown' });
  assert.equal(canvas.scrollLeft, 150); assert.equal(canvas.scrollTop, 160); dispose();
});
test('取消、重绘和卸载释放捕获及监听器，旧 DOM 不残留拖动状态', () => {
  const { root, canvas, card, dispose } = fixture();
  root.fire('pointerdown', card); root.fire('pointermove', card, { clientX: 0 }); root.fire('pointercancel', canvas);
  assert.equal(canvas.captures.size, 0); assert.equal(root.fire('click', card).prevented, false);
  root.fire('pointerdown', card); canvas.parent = null; root.fire('pointermove', card, { clientX: 0 });
  assert.equal(canvas.attributes.size, 0); dispose();
  assert.equal([...root.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
});
test('窄屏底部导航使用工作台自身网格，触控区足够且不依赖宿主 fixed bottom', async () => {
  const css = await readFile(new URL('../src/ui/workbenchShell.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('@media (max-width: 1000px)'));
  assert.match(mobile, /grid-template-areas: "workspace" "navigation"/u);
  assert.match(mobile, /grid-area: navigation;\s*position: relative;/u);
  assert.doesNotMatch(mobile, /position: fixed/u);
  assert.match(mobile, /repeat\(5, minmax\(0, 1fr\)\)/u);
  assert.match(mobile, /safe-area-inset-bottom/u);
});
test('四阶段独立圆角卡片和原生双向滑动接入正式源码，模块卸载有清理', async () => {
  const ruin = await readFile(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/ui/ruinWorkbench.css', import.meta.url), 'utf8');
  const genealogy = await readFile(new URL('../src/ui/genealogyWorkbench.ts', import.meta.url), 'utf8');
  const genealogyCss = await readFile(new URL('../src/ui/genealogyWorkbench.css', import.meta.url), 'utf8');
  assert.match(css, /\.timeline-event \{[^}]*border-radius: 14px;/u);
  assert.match(css, /\.chronology-track \{[^}]*gap: 10px;[^}]*background: none;/u);
  for (const source of [ruin, genealogy]) {
    assert.match(source, /installScrollPan\(root/u); assert.match(source, /dispose\(\) \{[\s\S]*?stopScrollPan\(\)/u);
  }
  for (const style of [css, genealogyCss]) assert.match(style, /touch-action: pan-x pan-y pinch-zoom/u);
  assert.match(ruin, /data-timeline-scroll="1"/u);
  assert.match(ruin, /aria-pressed="\$\{selected\?\.id === node\.id\}"/u);
});
test('窄屏黑夜传记内页使用深色纸面，修复不覆盖桌面既有配色', async () => {
  const css = await readFile(new URL('../src/ui/biographyWorkbench.css', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 1000px\) \{\s*\.workbench\[data-theme="dark"\] \{\s*--paper: var\(--archive-surface-soft, #2d2734\);\s*--paper-text: #ece7ee;/u);
  assert.match(css, /\.workbench\[data-theme="dark"\] \.codex-spread \{[\s\S]*?var\(--paper\);/u);
});
test('移动端收紧模块与书页标题层级，正文阅读字号不缩小', async () => {
  const shell = await readFile(new URL('../src/ui/workbenchShell.css', import.meta.url), 'utf8');
  const biography = await readFile(new URL('../src/ui/biographyWorkbench.css', import.meta.url), 'utf8');
  assert.match(shell, /\.module-intro h1 \{ font-size: 24px; line-height: 1\.3; \}/u);
  assert.match(biography, /\.opening h2, \.present h2 \{ font-size: 19px;/u);
  assert.match(biography, /\.cover-content h2 \{\s*font-size: 21px;/u);
  assert.match(biography, /\.chapter-body \{[\s\S]*?font-size: 14px;/u);
});
