import {
  WORKBENCH_APPEARANCE_EVENT,
  WORKBENCH_CANCEL_TASK_EVENT,
  WORKBENCH_OPEN_EVENT,
  WORKBENCH_STATUS_EVENT,
  type WorkbenchAppearanceDetail,
  type WorkbenchStatusDetail,
} from '../runtime/facade.ts';
import eyonCompanionAtlas from '../../prototype/assets/eyon-companion-prototype-v5.png';
import {
  clampCompanionPosition,
  companionPresentation,
  type CompanionMotion,
} from './companionPresentation.ts';

const HOST_ID = 'eyon-history-workbench-host-toast';
const POSITION_KEY = 'eyon-history-workbench-companion-position-v1';
const COMPANION_SIZE = 56;

interface CompanionEntry {
  key: string;
  taskKey: string;
  detail: WorkbenchStatusDetail;
  updatedAt: number;
  countdown: number | null;
  errorTimer: ReturnType<typeof setInterval> | null;
  hideTimer: ReturnType<typeof setTimeout> | null;
  elapsedTimer: ReturnType<typeof setInterval> | null;
}

/**
 * 宿主页唯一的伊雍入口：小人负责拖动与打开工作台，气泡只在有任务时出现。
 * 多任务仍被保留；气泡展示最近更新的一项，它收起后自动回到上一项。
 */
export function installHostStatusToast(eventTarget: EventTarget): () => void {
  const document = resolveHostDocument();
  if (!document) return () => undefined;
  document.getElementById(HOST_ID)?.remove();

  const hostWindow = document.defaultView;
  const host = document.createElement('aside');
  host.id = HOST_ID;
  host.dataset.eyonHistoryLauncher = '';
  host.dataset.theme = 'light';
  host.dataset.accent = 'jade';
  host.dataset.text = 'neutral';
  host.dataset.side = 'left';
  host.dataset.vertical = 'up';
  host.dataset.state = 'idle';
  hardenHost(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = companionCss;
  const avatar = document.createElement('button');
  avatar.type = 'button';
  avatar.className = 'eyon-avatar';
  avatar.title = '打开伊雍历史工作台（按住伊雍可拖动）';
  avatar.setAttribute('aria-label', '打开伊雍历史工作台；按住可移动');
  avatar.innerHTML = `
    <span class="eyon-frame is-outgoing" data-frame="outgoing" data-motion="idle" data-phase="loop" aria-hidden="true">
      <img class="eyon-sheet" alt="" draggable="false">
    </span>
    <span class="eyon-frame is-current" data-frame="current" data-motion="idle" data-phase="intro" aria-hidden="true">
      <img class="eyon-sheet" alt="" draggable="false">
    </span>`;
  avatar.querySelectorAll<HTMLImageElement>('img').forEach(image => {
    image.src = eyonCompanionAtlas;
  });

  const bubble = document.createElement('section');
  bubble.className = 'eyon-bubble';
  bubble.hidden = true;
  bubble.setAttribute('role', 'status');
  bubble.setAttribute('aria-live', 'polite');
  bubble.innerHTML = `
    <div class="bubble-head">
      <span class="bubble-orb" aria-hidden="true"></span>
      <strong class="bubble-title"></strong>
    </div>
    <p class="bubble-detail"></p>
    <div class="bubble-footer">
      <em class="bubble-retry" hidden></em>
      <span class="bubble-timer" hidden></span>
      <button class="bubble-stop" type="button" hidden>停止</button>
    </div>
    <div class="bubble-progress" aria-hidden="true"></div>`;
  shadow.append(style, avatar, bubble);
  document.body.append(host);

  const currentFrame = avatar.querySelector<HTMLElement>('[data-frame="current"]')!;
  const outgoingFrame = avatar.querySelector<HTMLElement>('[data-frame="outgoing"]')!;
  const currentSheet = currentFrame.querySelector<HTMLElement>('.eyon-sheet')!;
  const outgoingSheet = outgoingFrame.querySelector<HTMLElement>('.eyon-sheet')!;
  const title = bubble.querySelector<HTMLElement>('.bubble-title')!;
  const description = bubble.querySelector<HTMLElement>('.bubble-detail')!;
  const retry = bubble.querySelector<HTMLElement>('.bubble-retry')!;
  const timer = bubble.querySelector<HTMLElement>('.bubble-timer')!;
  const stop = bubble.querySelector<HTMLButtonElement>('.bubble-stop')!;

  const entries = new Map<string, CompanionEntry>();
  let nextResultId = 0;
  let activeKey = '';
  let activeMotion: CompanionMotion | null = null;
  let transitionTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const onIntroEnd = (event: AnimationEvent): void => {
    if (event.animationName !== 'eyon-intro' || currentFrame.dataset.phase !== 'intro') return;
    currentFrame.dataset.phase = 'loop';
    restartAnimation(currentSheet);
  };
  currentSheet.addEventListener('animationend', onIntroEnd as EventListener);

  const onStatus = (event: Event): void => {
    const detail = (event as CustomEvent<WorkbenchStatusDetail>).detail;
    if (!detail || disposed) return;
    if (
      detail.taskType === 'ruin'
      && (detail.status === 'entering_ruin' || detail.detail.includes('踏入'))
    ) {
      removeTaskEntries('butterfly');
    }
    const taskKey = detail.taskType ?? 'system';
    const terminal = detail.phase === 'error'
      || detail.phase === 'success'
      || detail.phase === 'cancelled';
    let key: string = taskKey;
    if (terminal) {
      removeEntry(taskKey, false);
      key = `${taskKey}:result:${nextResultId++}`;
    }
    const entry = entries.get(key) ?? createEntry(key, taskKey, detail);
    clearEntryTimers(entry);
    entry.detail = detail;
    entry.updatedAt = Date.now();
    entry.countdown = detail.phase === 'error' ? 5 : null;
    entries.set(key, entry);
    installEntryTimers(entry);
    trimResultEntries();
    renderActive();
  };

  const onAppearance = (event: Event): void => {
    const detail = (event as CustomEvent<WorkbenchAppearanceDetail>).detail;
    if (!detail) return;
    host.dataset.theme = detail.mode;
    host.dataset.accent = detail.accent;
    host.dataset.text = detail.text;
  };

  const onResize = (): void => clampCurrentPosition(host, hostWindow);
  eventTarget.addEventListener(WORKBENCH_STATUS_EVENT, onStatus);
  hostWindow?.addEventListener(WORKBENCH_APPEARANCE_EVENT, onAppearance);
  hostWindow?.addEventListener('resize', onResize);

  installCompanionDrag(host, avatar, hostWindow, () => {
    if (entries.size === 0) {
      const detail: WorkbenchStatusDetail = {
        status: 'workbench_open',
        detail: '卷宗、谱系与时间暗流，都请从这里看。',
        taskType: 'system',
        phase: 'info',
      };
      const entry = createEntry('system:workbench-open', 'system', detail);
      entry.updatedAt = Date.now();
      entry.hideTimer = setTimeout(() => removeEntry(entry.key), 1800);
      entries.set(entry.key, entry);
      renderActive();
    }
    hostWindow?.dispatchEvent(new hostWindow.CustomEvent(WORKBENCH_OPEN_EVENT));
  });

  stop.addEventListener('click', event => {
    event.stopPropagation();
    const entry = entries.get(activeKey);
    if (!entry) return;
    eventTarget.dispatchEvent(new CustomEvent(WORKBENCH_CANCEL_TASK_EVENT, {
      detail: { taskType: entry.taskKey },
    }));
  });

  // 首次装载只播放一次空闲开场，然后停在微动循环。
  setMotion('idle');
  restorePosition(host, hostWindow);

  function createEntry(
    key: string,
    taskKey: string,
    detail: WorkbenchStatusDetail,
  ): CompanionEntry {
    return {
      key,
      taskKey,
      detail,
      updatedAt: Date.now(),
      countdown: null,
      errorTimer: null,
      hideTimer: null,
      elapsedTimer: null,
    };
  }

  function installEntryTimers(entry: CompanionEntry): void {
    if (entry.detail.phase === 'error') {
      entry.errorTimer = setInterval(() => {
        entry.countdown = Math.max(0, (entry.countdown ?? 1) - 1);
        if (entry.countdown <= 0) removeEntry(entry.key);
        else renderActive();
      }, 1000);
      return;
    }
    if (entry.detail.phase === 'success' || entry.detail.phase === 'cancelled') {
      entry.hideTimer = setTimeout(() => removeEntry(entry.key), 2600);
      return;
    }
    if (typeof entry.detail.progress?.startedAt === 'number') {
      entry.elapsedTimer = setInterval(renderActive, 1000);
    }
  }

  function renderActive(): void {
    if (disposed) return;
    const entry = [...entries.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    activeKey = entry?.key ?? '';
    if (!entry) {
      bubble.hidden = true;
      host.dataset.state = 'idle';
      setMotion('idle');
      return;
    }
    const presentation = companionPresentation(entry.detail);
    host.dataset.state = presentation.state;
    title.textContent = presentation.title;
    description.textContent = entry.detail.detail;
    retry.hidden = entry.detail.phase !== 'retrying';
    retry.textContent = entry.detail.retry
      ? `第 ${entry.detail.retry.attempt} / ${entry.detail.retry.max} 次尝试`
      : '';
    stop.hidden = !entry.detail.cancellable
      || (entry.detail.phase !== 'running' && entry.detail.phase !== 'retrying');
    const meta = timerText(entry);
    timer.hidden = !meta;
    timer.textContent = meta;
    bubble.hidden = false;
    setMotion(presentation.motion);
    updateBubbleDirection(host, hostWindow);
  }

  function timerText(entry: CompanionEntry): string {
    if (entry.countdown !== null) return `${entry.countdown}s`;
    const startedAt = entry.detail.progress?.startedAt;
    if (typeof startedAt !== 'number') return '';
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(seconds / 60);
    return `已等待 ${minutes}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function setMotion(motion: CompanionMotion): void {
    // 同一任务内的文案/进度更新不重播开场，只继续 3↔4 微动循环。
    if (motion === activeMotion) return;
    if (transitionTimer) clearTimeout(transitionTimer);
    const frozen = getComputedStyle(currentSheet).transform;
    outgoingFrame.dataset.motion = currentFrame.dataset.motion ?? activeMotion ?? 'idle';
    outgoingFrame.dataset.phase = currentFrame.dataset.phase ?? 'loop';
    outgoingSheet.style.animation = 'none';
    outgoingSheet.style.transform = frozen;
    outgoingFrame.style.opacity = '1';

    currentFrame.dataset.motion = motion;
    currentFrame.dataset.phase = 'intro';
    activeMotion = motion;
    restartAnimation(currentSheet);
    host.classList.remove('is-transitioning');
    void host.offsetWidth;
    host.classList.add('is-transitioning');
    transitionTimer = setTimeout(() => {
      host.classList.remove('is-transitioning');
      outgoingFrame.style.opacity = '';
      outgoingSheet.style.animation = '';
      outgoingSheet.style.transform = '';
    }, 220);
  }

  function removeEntry(key: string, rerender = true): void {
    const entry = entries.get(key);
    if (!entry) return;
    clearEntryTimers(entry);
    entries.delete(key);
    if (rerender) renderActive();
  }

  function removeTaskEntries(taskKey: string): void {
    for (const key of [...entries.keys()]) {
      if (key === taskKey || key.startsWith(`${taskKey}:result:`)) removeEntry(key);
    }
  }

  function trimResultEntries(): void {
    const results = [...entries.values()]
      .filter(entry => entry.key.includes(':result:'))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const entry of results.slice(0, Math.max(0, results.length - 6))) {
      removeEntry(entry.key);
    }
  }

  function clearEntryTimers(entry: CompanionEntry): void {
    if (entry.errorTimer) clearInterval(entry.errorTimer);
    if (entry.hideTimer) clearTimeout(entry.hideTimer);
    if (entry.elapsedTimer) clearInterval(entry.elapsedTimer);
    entry.errorTimer = null;
    entry.hideTimer = null;
    entry.elapsedTimer = null;
  }

  return () => {
    disposed = true;
    eventTarget.removeEventListener(WORKBENCH_STATUS_EVENT, onStatus);
    hostWindow?.removeEventListener(WORKBENCH_APPEARANCE_EVENT, onAppearance);
    hostWindow?.removeEventListener('resize', onResize);
    currentSheet.removeEventListener('animationend', onIntroEnd as EventListener);
    if (transitionTimer) clearTimeout(transitionTimer);
    for (const entry of entries.values()) clearEntryTimers(entry);
    entries.clear();
    host.remove();
  };
}

function restartAnimation(element: HTMLElement): void {
  element.style.animation = 'none';
  void element.offsetWidth;
  element.style.animation = '';
}

function installCompanionDrag(
  host: HTMLElement,
  avatar: HTMLButtonElement,
  hostWindow: Window | null,
  onClick: () => void,
): void {
  let drag: {
    pointerId: number;
    startX: number;
    startY: number;
    left: number;
    top: number;
    moved: boolean;
  } | null = null;
  let suppressClick = false;

  avatar.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    const rect = host.getBoundingClientRect();
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false,
    };
    avatar.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  avatar.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId || !hostWindow) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.hypot(dx, dy) >= 4) drag.moved = true;
    const next = clampCompanionPosition(
      drag.left + dx,
      drag.top + dy,
      hostWindow.innerWidth,
      hostWindow.innerHeight,
      COMPANION_SIZE,
    );
    applyAbsolutePosition(host, next.left, next.top);
    updateBubbleDirection(host, hostWindow);
  });

  const finish = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
    try {
      avatar.releasePointerCapture(event.pointerId);
    } catch {
      // 宿主中指针已丢失时无需再释放。
    }
    const rect = host.getBoundingClientRect();
    savePosition(hostWindow, rect.left, rect.top);
  };
  avatar.addEventListener('pointerup', finish);
  avatar.addEventListener('pointercancel', finish);
  avatar.addEventListener('click', () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onClick();
  });
}

function restorePosition(host: HTMLElement, hostWindow: Window | null): void {
  if (!hostWindow) return;
  try {
    const raw = hostWindow.localStorage.getItem(POSITION_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { left?: unknown; top?: unknown };
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return;
    const next = clampCompanionPosition(
      parsed.left,
      parsed.top,
      hostWindow.innerWidth,
      hostWindow.innerHeight,
      COMPANION_SIZE,
    );
    applyAbsolutePosition(host, next.left, next.top);
    updateBubbleDirection(host, hostWindow);
  } catch {
    // localStorage 不可用时保持默认右下角。
  }
}

function savePosition(hostWindow: Window | null, left: number, top: number): void {
  try {
    hostWindow?.localStorage.setItem(POSITION_KEY, JSON.stringify({ left, top }));
  } catch {
    // 跨域宿主或隐私模式拒绝存储时不影响当前拖动。
  }
}

function clampCurrentPosition(host: HTMLElement, hostWindow: Window | null): void {
  if (!hostWindow || !host.style.left) return;
  const rect = host.getBoundingClientRect();
  const next = clampCompanionPosition(
    rect.left,
    rect.top,
    hostWindow.innerWidth,
    hostWindow.innerHeight,
    COMPANION_SIZE,
  );
  applyAbsolutePosition(host, next.left, next.top);
  updateBubbleDirection(host, hostWindow);
  savePosition(hostWindow, next.left, next.top);
}

function applyAbsolutePosition(host: HTMLElement, left: number, top: number): void {
  host.style.setProperty('left', `${left}px`, 'important');
  host.style.setProperty('top', `${top}px`, 'important');
  host.style.setProperty('right', 'auto', 'important');
  host.style.setProperty('bottom', 'auto', 'important');
}

function updateBubbleDirection(host: HTMLElement, hostWindow: Window | null): void {
  if (!hostWindow) return;
  const rect = host.getBoundingClientRect();
  host.dataset.side = rect.left < hostWindow.innerWidth / 2 ? 'right' : 'left';
  host.dataset.vertical = rect.top < 150 ? 'down' : 'up';
}

function hardenHost(host: HTMLElement): void {
  const styles: Record<string, string> = {
    position: 'fixed',
    right: '18px',
    bottom: '18px',
    width: `${COMPANION_SIZE}px`,
    height: `${COMPANION_SIZE}px`,
    margin: '0',
    padding: '0',
    border: '0',
    background: 'transparent',
    'z-index': '2147483646',
    'pointer-events': 'auto',
    'writing-mode': 'horizontal-tb',
    direction: 'ltr',
  };
  for (const [property, value] of Object.entries(styles)) {
    host.style.setProperty(property, value, 'important');
  }
}

function resolveHostDocument(): Document | null {
  if (typeof window === 'undefined') return null;
  let current: Window = window;
  while (current.parent && current.parent !== current) {
    try {
      void current.parent.document.body;
      current = current.parent;
    } catch {
      break;
    }
  }
  return current.document?.body ? current.document : document;
}

const companionCss = `
  :host(#${HOST_ID}) {
    all: initial;
    --eyon-accent: #b694dc; --eyon-accent-soft: rgba(182, 148, 220, .16);
    --eyon-text: #2f2938; --eyon-muted: #746c7d;
    --eyon-bg: rgba(255, 255, 252, .82); --eyon-line: rgba(112, 91, 132, .22);
    --eyon-shadow: 0 12px 34px rgba(49, 38, 57, .22);
    color-scheme: light; font-family: "Noto Sans SC", "Microsoft YaHei", sans-serif;
  }
  :host([data-theme="dark"]) {
    --eyon-text: #eee9f5; --eyon-muted: #aaa1b7;
    --eyon-bg: rgba(22, 19, 29, .78); --eyon-line: rgba(224, 213, 238, .18);
    --eyon-shadow: 0 12px 34px rgba(0, 0, 0, .34); color-scheme: dark;
  }
  :host([data-accent="jade"]) { --eyon-accent: #65bcb2; --eyon-accent-soft: rgba(101,188,178,.15); }
  :host([data-accent="gold"]) { --eyon-accent: #c6a45c; --eyon-accent-soft: rgba(198,164,92,.15); }
  :host([data-accent="blue"]) { --eyon-accent: #79abd0; --eyon-accent-soft: rgba(121,171,208,.15); }
  :host([data-accent="crimson"]) { --eyon-accent: #ca7680; --eyon-accent-soft: rgba(202,118,128,.15); }
  *, *::before, *::after { box-sizing: border-box; writing-mode: horizontal-tb; }
  .eyon-avatar {
    all: initial; position: relative; display: block; width: 56px; height: 56px;
    overflow: visible; border: 0; background: transparent; cursor: grab;
    touch-action: none; user-select: none; -webkit-user-select: none;
    filter: drop-shadow(0 5px 8px rgba(0,0,0,.42));
  }
  .eyon-avatar:active { cursor: grabbing; }
  .eyon-avatar:focus-visible { outline: 2px solid var(--eyon-accent); outline-offset: 3px; border-radius: 12px; }
  .eyon-frame { position: absolute; left: -4px; top: -8px; width: 64px; height: 64px; overflow: hidden; opacity: 0; pointer-events: none; }
  .eyon-frame.is-current { z-index: 2; opacity: 1; }
  .eyon-frame.is-outgoing { z-index: 1; }
  :host(.is-transitioning) .eyon-frame.is-current { animation: eyon-layer-in 190ms ease-out both; }
  :host(.is-transitioning) .eyon-frame.is-outgoing { animation: eyon-layer-out 190ms ease-in both; }
  @keyframes eyon-layer-in { from { opacity:0; transform:translateY(3px) scale(.9); } to { opacity:1; transform:none; } }
  @keyframes eyon-layer-out { from { opacity:1; transform:none; } to { opacity:0; transform:translateY(-2px) scale(1.05); } }
  .eyon-sheet {
    position: absolute; left: 0; top: 0; width: 256px; height: 640px; max-width: none;
    --step: 64px; --row-y: 0px; --intro-duration: 950ms; --loop-duration: 1500ms;
    transform: translate3d(0,var(--row-y),0); image-rendering: pixelated; pointer-events:none;
  }
  .eyon-frame[data-phase="intro"] .eyon-sheet { animation: eyon-intro var(--intro-duration) steps(1,end) 1 forwards; }
  .eyon-frame[data-phase="loop"] .eyon-sheet { animation: eyon-settled-loop var(--loop-duration) steps(1,end) infinite; }
  .eyon-frame[data-motion="biography"] .eyon-sheet { --row-y:calc(var(--step) * -1); --intro-duration:1100ms; --loop-duration:1800ms; }
  .eyon-frame[data-motion="success"] .eyon-sheet { --row-y:calc(var(--step) * -2); --intro-duration:900ms; --loop-duration:1500ms; }
  .eyon-frame[data-motion="error"] .eyon-sheet { --row-y:calc(var(--step) * -3); --intro-duration:1150ms; --loop-duration:1300ms; }
  .eyon-frame[data-motion="genealogy"] .eyon-sheet { --row-y:calc(var(--step) * -4); --intro-duration:1100ms; --loop-duration:1650ms; }
  .eyon-frame[data-motion="ruin-map"] .eyon-sheet { --row-y:calc(var(--step) * -5); --intro-duration:1100ms; --loop-duration:1700ms; }
  .eyon-frame[data-motion="ruin-portal"] .eyon-sheet { --row-y:calc(var(--step) * -6); --intro-duration:950ms; --loop-duration:760ms; }
  .eyon-frame[data-motion="butterfly"] .eyon-sheet { --row-y:calc(var(--step) * -7); --intro-duration:900ms; --loop-duration:1400ms; }
  .eyon-frame[data-motion="system"] .eyon-sheet { --row-y:calc(var(--step) * -8); --intro-duration:1050ms; --loop-duration:1450ms; }
  .eyon-frame[data-motion="workbench"] .eyon-sheet { --row-y:calc(var(--step) * -9); --intro-duration:1100ms; --loop-duration:1750ms; }
  @keyframes eyon-intro {
    0%,34.999% { transform:translate3d(0,var(--row-y),0); }
    35%,67.999% { transform:translate3d(calc(var(--step) * -1),var(--row-y),0); }
    68%,100% { transform:translate3d(calc(var(--step) * -2),var(--row-y),0); }
  }
  @keyframes eyon-settled-loop {
    0%,63.999% { transform:translate3d(calc(var(--step) * -2),var(--row-y),0); }
    64%,82.999% { transform:translate3d(calc(var(--step) * -3),var(--row-y),0); }
    83%,100% { transform:translate3d(calc(var(--step) * -2),var(--row-y),0); }
  }
  .eyon-bubble {
    position:absolute; right:48px; bottom:44px; width:min(292px,calc(100vw - 84px));
    padding:11px 13px 12px; border:1px solid var(--eyon-line); border-radius:14px;
    color:var(--eyon-text); background:var(--eyon-bg); box-shadow:var(--eyon-shadow);
    backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px); pointer-events:auto;
    transform-origin:92% 100%; animation:eyon-bubble-in 150ms ease-out both;
  }
  .eyon-bubble[hidden] { display:none; }
  .eyon-bubble::after {
    content:""; position:absolute; right:10px; bottom:-5px; width:9px; height:9px;
    border-right:1px solid var(--eyon-line); border-bottom:1px solid var(--eyon-line);
    background:var(--eyon-bg); transform:rotate(45deg);
  }
  :host([data-side="right"]) .eyon-bubble { right:auto; left:48px; transform-origin:8% 100%; }
  :host([data-side="right"]) .eyon-bubble::after { right:auto; left:10px; transform:rotate(225deg); }
  :host([data-vertical="down"]) .eyon-bubble { top:44px; bottom:auto; transform-origin:92% 0; }
  :host([data-side="right"][data-vertical="down"]) .eyon-bubble { transform-origin:8% 0; }
  :host([data-vertical="down"]) .eyon-bubble::after { top:-5px; bottom:auto; transform:rotate(225deg); }
  :host([data-side="right"][data-vertical="down"]) .eyon-bubble::after { transform:rotate(45deg); }
  @keyframes eyon-bubble-in { from { opacity:0; transform:translateY(5px) scale(.97); } }
  .bubble-head { display:flex; align-items:center; gap:8px; min-width:0; }
  .bubble-orb { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:var(--eyon-accent); box-shadow:0 0 0 4px var(--eyon-accent-soft); }
  :host([data-state="success"]) .bubble-orb { background:#78bda5; }
  :host([data-state="error"]) .bubble-orb { background:#d77e8e; }
  .bubble-title { min-width:0; overflow:hidden; color:var(--eyon-text); font:650 13px/1.4 "Noto Sans SC","Microsoft YaHei",sans-serif; text-overflow:ellipsis; white-space:nowrap; }
  .bubble-detail { margin:5px 0 0 15px; color:var(--eyon-muted); font:400 11px/1.55 "Noto Sans SC","Microsoft YaHei",sans-serif; overflow-wrap:anywhere; }
  .bubble-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; min-height:0; margin:7px 0 0 15px; }
  .bubble-retry,.bubble-timer { color:var(--eyon-muted); font:600 10px/1.2 "Noto Sans SC","Microsoft YaHei",sans-serif; font-style:normal; }
  .bubble-retry { margin-right:auto; color:var(--eyon-accent); }
  .bubble-stop { all:initial; box-sizing:border-box; min-width:40px; padding:4px 7px; border:1px solid var(--eyon-line); border-radius:999px; color:var(--eyon-text); background:transparent; cursor:pointer; font:600 11px/1 "Noto Sans SC","Microsoft YaHei",sans-serif; text-align:center; }
  .bubble-stop:hover,.bubble-stop:focus-visible { border-color:var(--eyon-accent); color:var(--eyon-accent); outline:none; }
  .bubble-retry[hidden],.bubble-timer[hidden],.bubble-stop[hidden] { display:none; }
  .bubble-progress { height:2px; margin:8px 0 0 15px; overflow:hidden; border-radius:999px; background:rgba(127,117,137,.12); }
  .bubble-progress::after { content:""; display:block; width:42%; height:100%; border-radius:inherit; background:linear-gradient(90deg,transparent,var(--eyon-accent),transparent); animation:eyon-progress 1500ms ease-in-out infinite; }
  :host(:not([data-state="working"])) .bubble-progress { display:none; }
  @keyframes eyon-progress { from { transform:translateX(-115%); } to { transform:translateX(280%); } }
  @media (prefers-reduced-motion:reduce) {
    *,*::before,*::after { animation-duration:.001ms!important; animation-iteration-count:1!important; transition-duration:.001ms!important; }
    .eyon-sheet { animation:none!important; transform:translate3d(calc(var(--step) * -2),var(--row-y),0)!important; }
  }
  @supports not (backdrop-filter:blur(1px)) { .eyon-bubble { background:var(--eyon-bg); } }
`;
