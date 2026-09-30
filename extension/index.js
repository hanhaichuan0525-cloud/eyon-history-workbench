const VERSION = '0.14.4';
const RUNTIME_URL = new URL('../dist/index.js', import.meta.url).href;
const WORKBENCH_URL = new URL('../dist/workbench.js', import.meta.url).href;
const INSTANCE_KEY = '__eyonHistoryWorkbenchExtension';
const WAND_ENTRY_ID = 'eyon-history-workbench-wand-entry';
const LEGACY_SETTINGS_ID = 'eyon-history-workbench-extension-settings';
const ENTRY_STYLE_ID = 'eyon-history-workbench-entry-style';
const SETTINGS_CHANGED_EVENT = 'eyon-history-workbench:settings-changed';
const EXTENSION_SETTINGS_KEY = 'eyon-history-workbench';

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
  runtimeRetryTimer: null,
  runtimeAttempt: 0,
  entryStyle: null,
};

function hostWindow() {
  return window;
}

function hostGlobalCandidates() {
  const host = hostWindow();
  const candidates = [];
  const append = value => {
    if (value && typeof value === 'object' && !candidates.includes(value)) {
      candidates.push(value);
    }
  };
  append(host);
  try { append(host.parent); } catch { /* cross-origin parent */ }
  try { append(host.top); } catch { /* cross-origin top */ }
  return candidates;
}

function runtimeGlobal(name) {
  for (const candidate of hostGlobalCandidates()) {
    try {
      const value = candidate[name];
      if (value !== undefined && value !== null) return value;
    } catch { /* cross-origin parent/top */ }
  }
  return null;
}

function runtimeChatId(sillyTavern) {
  try {
    if (typeof sillyTavern?.getCurrentChatId === 'function') {
      return String(sillyTavern.getCurrentChatId() ?? '').trim();
    }
    const context = typeof sillyTavern?.getContext === 'function'
      ? sillyTavern.getContext()
      : null;
    const chatId = context?.chatId ?? context?.chat_id;
    return (typeof chatId === 'string' || typeof chatId === 'number')
      ? String(chatId).trim()
      : '';
  } catch {
    return '';
  }
}

function hostDocument() {
  return hostWindow().document || document;
}

function workbenchFacade() {
  return hostWindow().EyonHistoryWorkbench;
}

function hostSettingsContext() {
  const host = hostWindow();
  const sillyTavern = runtimeGlobal('SillyTavern');
  const context = typeof sillyTavern?.getContext === 'function'
    ? sillyTavern.getContext()
    : null;
  const extensionSettings = context?.extensionSettings
    || sillyTavern?.extensionSettings
    || null;
  const saveSettingsDebounced = context?.saveSettingsDebounced
    || sillyTavern?.saveSettingsDebounced
    || null;
  return { extensionSettings, saveSettingsDebounced };
}

function storedWorkbenchEnabled() {
  try {
    const { extensionSettings } = hostSettingsContext();
    const value = extensionSettings?.[EXTENSION_SETTINGS_KEY];
    // 扩展加载后默认启用；只有设置页明确保存 false 才关闭工作台功能。
    return value?.workbenchEnabled !== false;
  } catch {
    return true;
  }
}

function persistStoredWorkbenchEnabled(enabled) {
  const { extensionSettings, saveSettingsDebounced } = hostSettingsContext();
  if (!extensionSettings) {
    throw new Error('SillyTavern.extensionSettings 不可用');
  }
  const current = extensionSettings[EXTENSION_SETTINGS_KEY];
  extensionSettings[EXTENSION_SETTINGS_KEY] = {
    ...(current && typeof current === 'object' ? current : {}),
    workbenchEnabled: enabled,
  };
  void saveSettingsDebounced?.();
  hostWindow().dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
    detail: { workbenchEnabled: enabled },
  }));
  return extensionSettings[EXTENSION_SETTINGS_KEY];
}

function workbenchEnabled() {
  if (!storedWorkbenchEnabled()) return false;
  try {
    const facade = workbenchFacade();
    if (facade?.getSettings) {
      return facade.getSettings()?.workbenchEnabled !== false;
    }
    return storedWorkbenchEnabled();
  } catch {
    return storedWorkbenchEnabled();
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
  return missingRuntimeSurface().length === 0;
}

function currentChatContextReady() {
  const host = hostWindow();
  const sillyTavern = runtimeGlobal('SillyTavern');
  const chatId = runtimeChatId(sillyTavern);

  let characterName = '';
  const candidates = [];
  const append = value => {
    if (value && typeof value === 'object' && !candidates.includes(value)) candidates.push(value);
  };
  try { append(host.TavernHelper); } catch { /* optional host bridge */ }
  try { append(host.parent?.TavernHelper); } catch { /* cross-origin parent */ }
  try { append(host.top?.TavernHelper); } catch { /* cross-origin top */ }
  for (const candidate of candidates) {
    if (typeof candidate.getCurrentCharacterName !== 'function') continue;
    try {
      characterName = String(candidate.getCurrentCharacterName() ?? '').trim();
    } catch {
      characterName = '';
    }
    if (characterName) break;
  }
  if (!characterName && typeof host.getCurrentCharacterName === 'function') {
    try {
      characterName = String(host.getCurrentCharacterName() ?? '').trim();
    } catch {
      characterName = '';
    }
  }
  // Tavern 首页也可能已经暴露全部宿主依赖，但没有角色聊天。此时只保留
  // 悬浮球/魔术棒入口，等进入角色卡后再装载运行时，避免误报“载入未完成”。
  // chatId is the authoritative signal that a character chat is active. Some
  // hosts expose the character name only through context (or not at all),
  // while still providing a fully usable MVU/data surface.
  return Boolean(chatId);
}

function missingRuntimeSurface() {
  const missing = [];
  const sillyTavern = runtimeGlobal('SillyTavern');
  const tavernHelper = runtimeGlobal('TavernHelper');
  if (!sillyTavern) missing.push('SillyTavern');
  if (!tavernHelper) missing.push('TavernHelper');
  // MVU is not required to be a property of the native extension window.
  // The runtime obtains the shared API through TavernHelper.waitGlobalInitialized.
  return missing;
}

function scheduleRuntimeRetry() {
  if (state.stopped || state.runtimeRetryTimer) return;
  state.runtimeRetryTimer = setTimeout(() => {
    state.runtimeRetryTimer = null;
    if (!state.stopped && !workbenchFacade()) void start();
  }, 3000);
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
      width: 100vw;
      width: 100dvw;
      height: 100vh;
      height: 100dvh;
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
    openWorkbench();
  };
  wrap.addEventListener('click', open);
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') open(event);
  });
  return wrap;
}

function refreshWandEntry() {
  // β1：魔术棒入口退役。工作台只由角色卡悬浮球打开（悬浮球的 :open 事件在下方绑到
  // openWorkbench），因此这里不再创建入口，只负责清掉升级前可能残留的那一条。
  // createWandEntry / ensureEntryStyle 保留为历史实现，不再有调用点。
  hostDocument().getElementById(WAND_ENTRY_ID)?.remove();
  return false;
}

function ensureEntryControls() {
  // v0.11.3 created a separate host settings row. Remove it on upgrade so
  // there is exactly one authoritative launcher in the workbench settings.
  hostDocument().getElementById(LEGACY_SETTINGS_ID)?.remove();
  refreshWandEntry();
}

function observeHostUi() {
  // β1：入口退役后不再需要在宿主顶栏重绘时重挂按钮，避免整页 MutationObserver 空转。
  state.uiObserver?.disconnect();
  state.uiObserver = null;
  if (state.uiObserverTimer) clearTimeout(state.uiObserverTimer);
  state.uiObserverTimer = null;
}

function removeEntryControls() {
  const doc = hostDocument();
  doc.getElementById(WAND_ENTRY_ID)?.remove();
  doc.getElementById(LEGACY_SETTINGS_ID)?.remove();
  doc.getElementById(ENTRY_STYLE_ID)?.remove();
  if (state.uiObserverTimer) clearTimeout(state.uiObserverTimer);
  state.uiObserverTimer = null;
  state.uiObserver?.disconnect();
  state.uiObserver = null;
  state.entryStyle = null;
}

async function start() {
  if (state.stopped) return;
  if (state.runtimeRetryTimer) {
    clearTimeout(state.runtimeRetryTimer);
    state.runtimeRetryTimer = null;
  }
  const host = hostWindow();
  // 先挂载壳体与入口，再等待 Tavern Helper/MVU。宿主扩展的加载顺序并不
  // 保证这些全局对象先于本扩展出现；若把入口也放在等待之后，用户只能看到
  // 角色卡自己的悬浮球，却没有任何可打开的工作台。
  await mountWorkbench();
  ensureEntryControls();
  observeHostUi();

  if (!currentChatContextReady()) {
    scheduleRuntimeRetry();
    return;
  }

  const existingFacade = host.EyonHistoryWorkbench;
  if (existingFacade && typeof existingFacade.dispose === 'function') {
    // 角色卡内脚本已经提供运行时：只接入工作台入口，不重复启动后台监听器。
    ensureEntryControls();
    observeHostUi();
    return;
  }

  try {
    await waitForRuntimeSurface();
    let readyResolve;
    const ready = new Promise(resolve => {
      readyResolve = resolve;
    });
    state.onReady = event => {
      if (event.detail?.version || host.EyonHistoryWorkbench) readyResolve();
    };
    host.addEventListener('eyon-history-workbench:ready', state.onReady, { once: true });
    state.runtimeAttempt += 1;
    await import(`${RUNTIME_URL}?v=${encodeURIComponent(VERSION)}&attempt=${state.runtimeAttempt}`);
    state.ownsRuntime = true;
    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('工作台运行时未在预期时间内就绪')), 30_000)),
    ]);
    ensureEntryControls();
    observeHostUi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = missingRuntimeSurface();
    const detail = missing.length > 0
      ? `等待运行时依赖：${missing.join('、')}。请启用 Tavern Helper；依赖就绪后会自动接管。`
      : /Mvu\.getMvuData/u.test(message)
        ? '正在等待 Tavern Helper 返回 MVU 接口；请确认 MVU 变量框架脚本已启用，依赖就绪后会自动接管。'
        : `工作台运行时正在重试：${message}`;
    console.warn('[Eyon History Workbench] runtime is not ready; retrying', {
      missing,
      error,
    });
    emitStatus({
      status: 'waiting_dependencies',
      phase: 'info',
      detail,
      technicalDetail: message,
    });
    scheduleRuntimeRetry();
  } finally {
    if (state.onReady) host.removeEventListener('eyon-history-workbench:ready', state.onReady);
    state.onReady = null;
  }
}

async function prepareUi() {
  await mountWorkbench();
  ensureEntryControls();
  observeHostUi();
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
  if (state.onSettingsChanged) host.removeEventListener(SETTINGS_CHANGED_EVENT, state.onSettingsChanged);
  if (state.onPageHide) host.removeEventListener('pagehide', state.onPageHide);
  if (state.runtimeRetryTimer) clearTimeout(state.runtimeRetryTimer);
  state.runtimeRetryTimer = null;
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
  state.runtimeRetryTimer = null;
  state.runtimeAttempt = 0;
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
  // 扩展加载后自动启动运行时；魔术棒只负责打开已经挂载的工作台。
  void prepareUi().catch(error => {
    console.error('[Eyon History Workbench] UI preparation failed', error);
  });
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
