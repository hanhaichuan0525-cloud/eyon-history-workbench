import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  WORKBENCH_APPEARANCE_EVENT, WORKBENCH_CANCEL_TASK_EVENT,
  WORKBENCH_CONTEXT_EVENT, WORKBENCH_STATUS_EVENT,
  type WorkbenchStatusDetail,
} from '../src/runtime/facade.ts';
import { isTaskBusy } from '../src/runtime/taskStatus.ts';
import { companionPresentation, companionStatusDescription } from '../src/ui/companionPresentation.ts';

const source = readFileSync(new URL('../src/ui/hostStatusToast.ts', import.meta.url), 'utf8');

/** 执行真实安装函数；DOM/时钟是受控替身，不把它当成浏览器布局验收。 */
function companionHarness() {
  const tree = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const install = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'installHostStatusToast')!;
  class Node extends EventTarget {
    dataset: Record<string, string> = {};
    style = { setProperty() {}, animation: '', transform: '', opacity: '' };
    classList = { add() {}, remove() {} };
    nodes = new Map<string, Node>();
    hidden = false; innerHTML = ''; textContent = ''; focused = false; removed = false;
    append(..._items: unknown[]) {}
    setAttribute(_name: string, _value: string) {}
    querySelector(selector: string): Node {
      if (!this.nodes.has(selector)) this.nodes.set(selector, new Node());
      return this.nodes.get(selector)!;
    }
    querySelectorAll(): Node[] { return []; }
    attachShadow() { return new Node(); }
    remove() { this.removed = true; }
    focus() { this.focused = true; }
  }
  const elements: Record<string, Node> = {};
  const document = {
    defaultView: new EventTarget(), body: new Node(), getElementById: () => null,
    createElement(tag: string) { return elements[tag] = new Node(); },
  };
  const events = new EventTarget();
  let now = 1000, timerId = 0, tap = () => {};
  const timers = new Map<number, () => void>();
  const exports: any = {};
  const schedule = (fn: () => void) => { timers.set(++timerId, fn); return timerId; };
  runInNewContext(ts.transpileModule(`${install.getText(tree)}\nexport { installHostStatusToast };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, resolveHostDocument: () => document, HOST_ID: 'test-host', companionCss: '',
    hardenHost() {}, eyonCompanionAtlas: '', isTaskBusy, companionPresentation, companionStatusDescription,
    WORKBENCH_APPEARANCE_EVENT, WORKBENCH_CANCEL_TASK_EVENT, WORKBENCH_CONTEXT_EVENT, WORKBENCH_STATUS_EVENT,
    installCompanionDrag(_host: unknown, _avatar: unknown, _window: unknown, callback: () => void) { tap = callback; },
    openWorkbenchAcrossFrames: () => true, clearLegacyPosition() {}, keepCompanionVisible() {},
    updateBubbleDirection() {}, restartAnimation() {}, getComputedStyle: () => ({ transform: 'none' }),
    Date: { now: () => now }, CustomEvent,
    setInterval: schedule, setTimeout: schedule,
    clearInterval: (id: number) => timers.delete(id), clearTimeout: (id: number) => timers.delete(id),
  });
  const dispose = exports.installHostStatusToast(events);
  const bubble = elements.section;
  const status = (detail: WorkbenchStatusDetail) => events.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, { detail }));
  return { bubble, avatar: elements.button, host: elements.aside, events, timers, dispose, status,
    tap: () => tap(), tick() { now += 1000; for (const fn of [...timers.values()]) fn(); } };
}

const busy: WorkbenchStatusDetail = {
  taskType: 'ruin', phase: 'running', status: 'generating_candidate',
  detail: '正在撰写墟境史稿', startedAt: 1000, cancellable: true,
  progress: { current: 1, total: 3, item: 2 },
  request: { label: '正在撰写墟境史稿', startedAt: 1100 },
};

test('真实气泡：关闭不停止任务；心跳、重试、计时与完成均不强行重开', () => {
  const h = companionHarness(); let cancelled = 0;
  h.events.addEventListener(WORKBENCH_CANCEL_TASK_EVENT, () => cancelled++);
  h.status(busy); assert.equal(h.bubble.hidden, false);
  assert.equal(h.bubble.querySelector('.bubble-detail').textContent, '正在撰写墟境史稿（第 2 份）\n\n史稿已完成 1/3');
  assert.match(h.bubble.querySelector('.bubble-timer').textContent, /\n\n模型本次等待/u);
  h.bubble.querySelector('.bubble-close').dispatchEvent(new Event('click'));
  assert.equal(h.bubble.hidden, true); assert.equal(h.avatar.focused, true);
  assert.equal(cancelled, 0); assert.equal(h.host.dataset.state, 'working');
  h.tick(); assert.equal(h.bubble.hidden, true);
  h.status({ ...busy, status: 'generating', retry: { attempt: 2, max: 3 } });
  assert.equal(h.bubble.hidden, true);
  h.status({ ...busy, status: 'ready', phase: 'success', startedAt: undefined });
  assert.equal(h.bubble.hidden, true); assert.equal(cancelled, 0);
  h.dispose(); assert.equal(h.timers.size, 0);
});

test('真实气泡：新任务和主动点击恢复提示，停止按钮仍派发取消', () => {
  const h = companionHarness(); const cancelled: string[] = [];
  h.events.addEventListener(WORKBENCH_CANCEL_TASK_EVENT, event => cancelled.push((event as CustomEvent).detail.taskType));
  h.status(busy);
  h.bubble.querySelector('.bubble-close').dispatchEvent(new Event('click'));
  h.tap(); assert.equal(h.bubble.hidden, false, '点击悬浮球可查看未停止的进度');
  h.bubble.querySelector('.bubble-stop').dispatchEvent(new Event('click'));
  assert.deepEqual(cancelled, ['ruin']);
  h.bubble.querySelector('.bubble-close').dispatchEvent(new Event('click'));
  h.status({ ...busy, phase: 'success', status: 'ready', detail: '旧任务已完成', startedAt: undefined });
  h.status({ ...busy, startedAt: 9000, status: 'assembling_context', detail: '正在读取新任务资料' });
  assert.equal(h.bubble.hidden, false, '新任务提示恢复');
  assert.match(h.bubble.querySelector('.bubble-detail').textContent, /^正在读取新任务资料/u, '同毫秒通知仍展示新任务，不回到旧结果');
  h.events.dispatchEvent(new Event(WORKBENCH_CONTEXT_EVENT));
  assert.equal(h.bubble.hidden, true); assert.equal(h.host.dataset.state, 'idle');
  h.dispose();
});

test('关闭按钮有标签与触屏尺寸；文本支持空行，不再拼接点号', () => {
  assert.match(source, /aria-label="关闭气泡，不停止任务"/u);
  assert.match(source, /@media \(pointer:coarse\).*\.bubble-close.*width:44px; height:44px/u);
  assert.match(source, /\.bubble-detail.*white-space:pre-line/u);
  assert.doesNotMatch(source, /\$\{total\} · 模型本次等待/u);
  const entry = readFileSync(new URL('../src/entry.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(entry, /正在进行第 \$\{attempt \+ 1\}\/\$\{max \+ 1\} 次尝试/u);
  const genealogy = readFileSync(new URL('../src/ui/genealogyWorkbench.ts', import.meta.url), 'utf8');
  assert.match(genealogy, /<details class="identity-supplement" data-identity-supplement open>/u);
  assert.match(genealogy, /data-clear-genealogy.*清空此人物谱系/u);
});
