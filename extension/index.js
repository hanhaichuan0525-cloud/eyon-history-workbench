const VERSION = '0.11.0';
const RUNTIME_URL = new URL('../dist/index.js', import.meta.url).href;
const WORKBENCH_URL = new URL('../dist/workbench.js', import.meta.url).href;
const INSTANCE_KEY = '__eyonHistoryWorkbenchExtension';

const state = {
  stopped: false,
  ownsRuntime: false,
  ownsOverlay: false,
  overlay: null,
  style: null,
  onOpen: null,
  onReady: null,
  onPageHide: null,
};

function hostWindow() {
  return window;
}

function emitStatus(detail) {
  hostWindow().dispatchEvent(new CustomEvent('eyon-history-workbench:status', {
    detail: {
      taskType: 'system',
      phase: 'error',
      ...detail,
    },
  }));
}

function hasRuntimeSurface() {
  const host = hostWindow();
  return Boolean(
    host.SillyTavern
    && host.TavernHelper
    && host.Mvu,
  );
}

async function waitForRuntimeSurface(timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (!state.stopped && !hasRuntimeSurface()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('需要先启用 Tavern Helper 与 MVU 扩展，伊雍历史工作台扩展才能启动');
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

function createOverlay() {
  const host = hostWindow();
  const existing = host.document.querySelector('[data-eyon-history-overlay]');
  if (existing) {
    state.overlay = existing;
    state.ownsOverlay = false;
    return existing;
  }

  const style = host.document.createElement('style');
  style.dataset.eyonHistoryWorkbenchExtension = VERSION;
  style.textContent = `
    [data-eyon-history-overlay] {
      position: fixed;
      inset: 0;
      z-index: 2147483000;
      width: 100%;
      height: 100%;
      overflow: hidden;
      color-scheme: dark;
      background: #1a1720;
    }
    [data-eyon-history-overlay][data-theme="light"] {
      color-scheme: light;
      background: #ded8dd;
    }
    [data-eyon-history-overlay][hidden] { display: none !important; }
    [data-eyon-workbench-shell] { display: block; width: 100%; height: 100%; min-height: 0; }
  `;
  host.document.head.append(style);

  const overlay = host.document.createElement('section');
  overlay.dataset.eyonHistoryOverlay = '';
  overlay.dataset.theme = 'light';
  overlay.setAttribute('aria-label', '伊雍历史工作台');
  overlay.hidden = true;
  const container = host.document.createElement('main');
  container.dataset.eyonWorkbenchShell = '';
  overlay.append(container);
  host.document.body.append(overlay);
  container.addEventListener('eyon-history-workbench:close', () => {
    overlay.hidden = true;
  });

  state.style = style;
  state.overlay = overlay;
  state.ownsOverlay = true;
  return overlay;
}

async function mountWorkbench() {
  if (state.stopped) return;
  const overlay = createOverlay();
  if (state.overlay !== overlay) return;
  if (!hostWindow().EyonHistoryWorkbenchShell) {
    await import(`${WORKBENCH_URL}?v=${encodeURIComponent(VERSION)}`);
  }
  if (state.stopped) return;
  hostWindow().dispatchEvent(new CustomEvent('eyon-history-workbench:ready', {
    detail: hostWindow().EyonHistoryWorkbench,
  }));
}

async function start() {
  if (state.stopped) return;
  await waitForRuntimeSurface();

  const host = hostWindow();
  const existingFacade = host.EyonHistoryWorkbench;
  if (existingFacade && typeof existingFacade.dispose === 'function') {
    // 角色卡内脚本已经提供运行时：只接入工作台入口，不重复启动后台监听器。
    await mountWorkbench();
    return;
  }

  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  state.onReady = event => {
    if (event.detail?.version || host.EyonHistoryWorkbench) readyResolve();
  };
  host.addEventListener('eyon-history-workbench:ready', state.onReady, { once: true });

  try {
    await import(`${RUNTIME_URL}?v=${encodeURIComponent(VERSION)}`);
    state.ownsRuntime = true;
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('工作台运行时未在预期时间内就绪')), 30_000)),
    ]);
    await mountWorkbench();
  } catch (error) {
    readyReject?.(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Eyon History Workbench] extension start failed', error);
    emitStatus({ status: 'failed', detail: `伊雍历史工作台扩展未启动：${message}`, technicalDetail: message });
  } finally {
    if (state.onReady) host.removeEventListener('eyon-history-workbench:ready', state.onReady);
    state.onReady = null;
  }
}

function openWorkbench() {
  if (state.overlay) state.overlay.hidden = false;
  hostWindow().EyonHistoryWorkbenchShell?.open?.();
}

function stop() {
  if (state.stopped) return;
  state.stopped = true;
  const host = hostWindow();
  if (state.onOpen) host.removeEventListener('eyon-history-workbench:open', state.onOpen);
  if (state.onPageHide) host.removeEventListener('pagehide', state.onPageHide);
  host.EyonHistoryWorkbenchShell?.dispose?.();
  if (state.ownsRuntime) host.EyonHistoryWorkbench?.dispose?.();
  if (state.ownsOverlay) state.overlay?.remove();
  state.style?.remove();
  if (host[INSTANCE_KEY]?.stop === stop) delete host[INSTANCE_KEY];
}

function resetForActivation() {
  state.stopped = false;
  state.ownsRuntime = false;
  state.ownsOverlay = false;
  state.overlay = null;
  state.style = null;
  state.onOpen = null;
  state.onReady = null;
  state.onPageHide = null;
}

export function onActivate() {
  if (hostWindow()[INSTANCE_KEY]) return;
  resetForActivation();
  hostWindow()[INSTANCE_KEY] = { stop, version: VERSION };
  state.onOpen = openWorkbench;
  hostWindow().addEventListener('eyon-history-workbench:open', state.onOpen);
  state.onPageHide = stop;
  hostWindow().addEventListener('pagehide', state.onPageHide, { once: true });
  void start();
}

export function onEnable() {
  onActivate();
}

export function onDisable() {
  stop();
}

export function onDelete() {
  stop();
}

export function onUpdate() {
  // 酒馆更新扩展后会刷新页面；保留钩子以便未来迁移时使用。
}
