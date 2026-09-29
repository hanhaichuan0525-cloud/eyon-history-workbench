const VERSION = '0.11.2';
const RUNTIME_URL = new URL('../dist/index.js', import.meta.url).href;
const WORKBENCH_URL = new URL('../dist/workbench.js', import.meta.url).href;
const INSTANCE_KEY = '__eyonHistoryWorkbenchExtension';
const WAND_ENTRY_ID = 'eyon-history-workbench-wand-entry';
const EXTENSION_SETTINGS_ID = 'eyon-history-workbench-extension-settings';
const ENTRY_STYLE_ID = 'eyon-history-workbench-entry-style';
const SETTINGS_CHANGED_EVENT = 'eyon-history-workbench:settings-changed';

const state = {
  stopped: false,
  ownsRuntime: false,
  ownsOverlay: false,
  overlay: null,
  style: null,
  onOpen: null,
  onSettingsChanged: null,
  onReady: null,
  onPageHide: null,
  uiObserver: null,
  uiObserverTimer: null,
  entryStyle: null,
};

function hostWindow() {
  return window;
}

function hostDocument() {
  return hostWindow().document || document;
}

function workbenchFacade() {
  return hostWindow().EyonHistoryWorkbench;
}

function workbenchEnabled() {
  try {
    return workbenchFacade()?.getSettings?.()?.workbenchEnabled !== false;
  } catch {
    return true;
  }
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

function ensureEntryStyle() {
  const doc = hostDocument();
  let style = doc.getElementById(ENTRY_STYLE_ID);
  if (style) {
    state.entryStyle = style;
    return style;
  }
  style = doc.createElement('style');
  style.id = ENTRY_STYLE_ID;
  style.textContent = `
    #${WAND_ENTRY_ID} { display: flex; align-items: center; gap: .45em; width: 100%; cursor: pointer; }
    #${WAND_ENTRY_ID}[hidden] { display: none !important; }
    #${WAND_ENTRY_ID}:hover,
    #${WAND_ENTRY_ID}:focus-visible { background: color-mix(in srgb, currentColor 12%, transparent); outline: none; }
    #${WAND_ENTRY_ID} { padding: .45em .65em; border-radius: .35em; box-sizing: border-box; }
    #${WAND_ENTRY_ID} .eyon-history-wand-icon { width: 1.25em; text-align: center; opacity: .9; }
    #${EXTENSION_SETTINGS_ID} { margin: .5rem 0; }
    #${EXTENSION_SETTINGS_ID} .eyon-history-settings-row { display: flex; align-items: center; gap: .55rem; }
    #${EXTENSION_SETTINGS_ID} .eyon-history-settings-row label { display: flex; align-items: center; gap: .45rem; cursor: pointer; }
    #${EXTENSION_SETTINGS_ID} small { display: block; margin-top: .35rem; opacity: .72; line-height: 1.35; }
  `;
  (doc.head || doc.documentElement).append(style);
  state.entryStyle = style;
  return style;
}

function menuHost(doc) {
  return doc.querySelector('#sp_wand_container')
    || doc.querySelector('#extensionsMenu')
    || doc.querySelector('.extensionsMenu')
    || null;
}

function createWandEntry(doc) {
  const wrap = doc.createElement('div');
  wrap.id = WAND_ENTRY_ID;
  wrap.className = 'list-group-item flex-container flexGap5 eyon-history-workbench-menu-entry';
  wrap.setAttribute('role', 'menuitem');
  wrap.setAttribute('tabindex', '0');
  wrap.title = '打开伊雍历史工作台';
  const icon = doc.createElement('i');
  icon.className = 'fa-solid fa-book-open eyon-history-wand-icon';
  icon.setAttribute('aria-hidden', 'true');
  const label = doc.createElement('span');
  label.textContent = '伊雍历史工作台';
  wrap.append(icon, label);
  const open = event => {
    event.preventDefault();
    event.stopPropagation();
    if (workbenchEnabled()) openWorkbench();
  };
  wrap.addEventListener('click', open);
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') open(event);
  });
  return wrap;
}

function refreshWandEntry() {
  const doc = hostDocument();
  const host = menuHost(doc);
  let entry = doc.getElementById(WAND_ENTRY_ID);
  if (!host) {
    // ST 顶栏尚未挂载时等待 MutationObserver；不要把按钮散落到正文 body。
    entry?.remove();
    return false;
  }
  ensureEntryStyle();
  if (!entry) entry = createWandEntry(doc);
  if (entry.parentNode !== host) host.append(entry);
  entry.hidden = !workbenchEnabled();
  return true;
}

function refreshExtensionSettingsPanel() {
  const doc = hostDocument();
  const host = doc.querySelector('#extensions_settings2')
    || doc.querySelector('#extensions_settings');
  if (!host) return false;
  ensureEntryStyle();
  let panel = doc.getElementById(EXTENSION_SETTINGS_ID);
  if (!panel) {
    panel = doc.createElement('div');
    panel.id = EXTENSION_SETTINGS_ID;
    panel.className = 'extension_settings';
    const row = doc.createElement('div');
    row.className = 'eyon-history-settings-row';
    const label = doc.createElement('label');
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.dataset.eyonHistoryEnabled = 'true';
    input.addEventListener('change', () => {
      const facade = workbenchFacade();
      try {
        facade?.updateSettings?.({ workbenchEnabled: input.checked });
      } catch (error) {
        console.error('[Eyon History Workbench] failed to update launcher setting', error);
      }
      refreshWandEntry();
    });
    const title = doc.createElement('span');
    title.textContent = '启用伊雍历史工作台';
    label.append(input, title);
    row.append(label);
    const hint = doc.createElement('small');
    hint.textContent = '控制魔术棒菜单入口；关闭不会停止后台生成链路。';
    panel.append(row, hint);
    host.append(panel);
  }
  const input = panel.querySelector('input[data-eyon-history-enabled]');
  if (input) input.checked = workbenchEnabled();
  if (panel.parentNode !== host) host.append(panel);
  return true;
}

function ensureEntryControls() {
  refreshWandEntry();
  refreshExtensionSettingsPanel();
}

function observeHostUi() {
  if (state.uiObserver || typeof MutationObserver === 'undefined') return;
  const doc = hostDocument();
  const target = doc.body || doc.documentElement;
  if (!target) return;
  state.uiObserver = new MutationObserver(() => {
    if (state.uiObserverTimer) return;
    state.uiObserverTimer = setTimeout(() => {
      state.uiObserverTimer = null;
      if (!state.stopped) ensureEntryControls();
    }, 120);
  });
  state.uiObserver.observe(target, { childList: true, subtree: true });
}

function removeEntryControls() {
  const doc = hostDocument();
  doc.getElementById(WAND_ENTRY_ID)?.remove();
  doc.getElementById(EXTENSION_SETTINGS_ID)?.remove();
  doc.getElementById(ENTRY_STYLE_ID)?.remove();
  if (state.uiObserverTimer) clearTimeout(state.uiObserverTimer);
  state.uiObserverTimer = null;
  state.uiObserver?.disconnect();
  state.uiObserver = null;
  state.entryStyle = null;
}

async function start() {
  if (state.stopped) return;
  const host = hostWindow();
  // 先挂载壳体与入口，再等待 Tavern Helper/MVU。宿主扩展的加载顺序并不
  // 保证这些全局对象先于本扩展出现；若把入口也放在等待之后，用户只能看到
  // 角色卡自己的悬浮球，却没有任何可打开的工作台。
  await mountWorkbench();
  ensureEntryControls();
  observeHostUi();

  const existingFacade = host.EyonHistoryWorkbench;
  if (existingFacade && typeof existingFacade.dispose === 'function') {
    // 角色卡内脚本已经提供运行时：只接入工作台入口，不重复启动后台监听器。
    ensureEntryControls();
    observeHostUi();
    return;
  }

  await waitForRuntimeSurface();

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
    ensureEntryControls();
    observeHostUi();
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
  if (!workbenchEnabled()) return;
  if (state.overlay) state.overlay.hidden = false;
  hostWindow().EyonHistoryWorkbenchShell?.open?.();
}

function stop() {
  if (state.stopped) return;
  state.stopped = true;
  const host = hostWindow();
  if (state.onOpen) host.removeEventListener('eyon-history-workbench:open', state.onOpen);
  if (state.onSettingsChanged) host.removeEventListener(SETTINGS_CHANGED_EVENT, state.onSettingsChanged);
  if (state.onPageHide) host.removeEventListener('pagehide', state.onPageHide);
  removeEntryControls();
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
  state.onSettingsChanged = null;
  state.onReady = null;
  state.onPageHide = null;
  state.uiObserver = null;
  state.uiObserverTimer = null;
  state.entryStyle = null;
}

export function onActivate() {
  if (hostWindow()[INSTANCE_KEY]) return;
  resetForActivation();
  hostWindow()[INSTANCE_KEY] = { stop, version: VERSION };
  state.onOpen = openWorkbench;
  hostWindow().addEventListener('eyon-history-workbench:open', state.onOpen);
  state.onSettingsChanged = () => ensureEntryControls();
  hostWindow().addEventListener(SETTINGS_CHANGED_EVENT, state.onSettingsChanged);
  state.onPageHide = stop;
  hostWindow().addEventListener('pagehide', state.onPageHide, { once: true });
  void start().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[Eyon History Workbench] extension start failed', error);
    emitStatus({
      status: 'failed',
      detail: `伊雍历史工作台扩展未启动：${message}`,
      technicalDetail: message,
    });
  });
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

// v1.17+ 会通过 manifest.hooks.activate 调用；较旧的酒馆版本只会加载
// ES module 而不会派发 hook。保留幂等自动启动，避免“扩展已加载但入口为空”。
if (!hostWindow()[INSTANCE_KEY]) {
  try {
    onActivate();
  } catch (error) {
    console.error('[Eyon History Workbench] automatic activation failed', error);
  }
}
