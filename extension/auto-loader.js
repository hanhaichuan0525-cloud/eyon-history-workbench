(() => {
  'use strict';

  // This script is intentionally small: runtime and UI bytes are fetched from the
  // public release manifest and are executed only after SHA-256 verification.
  const MANIFEST_URL = "https://raw.githubusercontent.com/hanhaichuan0525-cloud/eyon-history-workbench/main/manifest.json";
  const LOADER_VERSION = "0.2.0";
  const CACHE_NAME = 'eyon-history-workbench-verified-v1';
  const INSTANCE_KEY = '__eyonHistoryWorkbenchAutoLoader';
  const LEGACY_INSTANCE_KEY = '__eyonHistoryWorkbenchInternalLoader';
  const LEGACY_EXTENSION_KEY = '__eyonHistoryWorkbenchExtension';
  const WAND_ENTRY_ID = 'eyon-history-workbench-wand-entry';
  const WAND_STYLE_ID = 'eyon-history-workbench-wand-style';

  const scriptWindow = window;
  const hostWindow = window.parent && window.parent !== window ? window.parent : window;
  const hostDocument = hostWindow.document || document;
  const state = {
    disposed: false,
    loading: null,
    openRequested: false,
    facade: null,
    version: null,
    manifestSource: null,
    runtimeUrl: null,
    workbenchUrl: null,
    moduleScript: null,
    overlay: null,
    style: null,
    observer: null,
    uiTimer: null,
    runtimeWaitCancel: null,
  };

  const previous = hostWindow[INSTANCE_KEY];
  if (previous && typeof previous.dispose === 'function') {
    try { previous.dispose(); } catch (error) { console.warn('[伊雍工作台] 清理旧自动更新加载器失败', error); }
  }
  const previousEmbedded = hostWindow[LEGACY_INSTANCE_KEY];
  if (previousEmbedded && typeof previousEmbedded.dispose === 'function') {
    try { previousEmbedded.dispose(); } catch (error) { console.warn('[伊雍工作台] 清理旧脚本实例失败', error); }
  }
  const legacyExtension = hostWindow[LEGACY_EXTENSION_KEY];
  if (legacyExtension && typeof legacyExtension.stop === 'function') {
    // Avoid two runtime owners listening to the same MVU/message events.
    try { legacyExtension.stop(); } catch (error) { console.warn('[伊雍工作台] 停止旧原生扩展失败', error); }
  }
  hostWindow[INSTANCE_KEY] = state;

  const emitStatus = (phase, detail, level = 'info') => {
    const payload = { source: 'eyon-history-workbench-auto-loader', phase, detail, level, version: state.version };
    try { scriptWindow.dispatchEvent(new CustomEvent('eyon-history-workbench:status', { detail: payload })); } catch {}
    if (hostWindow !== scriptWindow) {
      try { hostWindow.dispatchEvent(new CustomEvent('eyon-history-workbench:status', { detail: payload })); } catch {}
    }
    if (level === 'error') console.error('[伊雍工作台]', detail);
  };

  const hostMenu = () => hostDocument.querySelector('#sp_wand_container')
    || hostDocument.querySelector('#extensionsMenu')
    || hostDocument.querySelector('.extensionsMenu');

  const ensureEntryStyle = () => {
    if (hostDocument.getElementById(WAND_STYLE_ID)) return;
    const style = hostDocument.createElement('style');
    style.id = WAND_STYLE_ID;
    style.textContent = [
      '#' + WAND_ENTRY_ID + '{display:flex;align-items:center;gap:.55em;cursor:pointer;}',
      '#' + WAND_ENTRY_ID + '.eyon-loader-pending{opacity:.72;}',
      '#' + WAND_ENTRY_ID + '.eyon-loader-error{color:#b65a5a;}',
    ].join('');
    (hostDocument.head || hostDocument.documentElement).appendChild(style);
  };

  const openWorkbench = () => {
    state.openRequested = true;
    if (hostWindow.EyonHistoryWorkbenchShell && typeof hostWindow.EyonHistoryWorkbenchShell.open === 'function') {
      hostWindow.EyonHistoryWorkbenchShell.open();
      return;
    }
    void load();
  };

  const createWandEntry = (menu) => {
    let entry = hostDocument.getElementById(WAND_ENTRY_ID);
    if (!entry) {
      entry = hostDocument.createElement('div');
      entry.id = WAND_ENTRY_ID;
      entry.className = 'list-group-item flex-container flexGap5 interactable';
      entry.setAttribute('role', 'button');
      entry.setAttribute('tabindex', '0');
      entry.innerHTML = '<i class="fa-solid fa-book-open"></i><span>伊雍历史工作台</span>';
      entry.addEventListener('click', openWorkbench);
      entry.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openWorkbench(); }
      });
    }
    entry.classList.toggle('eyon-loader-pending', !state.facade);
    entry.classList.toggle('eyon-loader-error', false);
    const label = entry.querySelector('span');
    const nextLabel = state.version ? '伊雍历史工作台' : '伊雍历史工作台（加载中）';
    if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
    if (entry.parentElement !== menu) menu.appendChild(entry);
  };

  const ensureEntryControls = () => {
    ensureEntryStyle();
    const menu = hostMenu();
    if (menu) createWandEntry(menu);
  };

  const markEntryError = () => {
    const entry = hostDocument.getElementById(WAND_ENTRY_ID);
    if (!entry) return;
    entry.classList.remove('eyon-loader-pending');
    entry.classList.add('eyon-loader-error');
    const label = entry.querySelector('span');
    if (label && label.textContent !== '伊雍历史工作台（加载失败）') {
      label.textContent = '伊雍历史工作台（加载失败）';
    }
  };

  const observeHostUi = () => {
    if (state.observer || !hostDocument.documentElement) return;
    const target = hostDocument.body || hostDocument.documentElement;
    if (!target) return;
    const schedule = () => {
      if (state.uiTimer || state.disposed) return;
      state.uiTimer = setTimeout(() => {
        state.uiTimer = null;
        if (!state.disposed) ensureEntryControls();
      }, 120);
    };
    state.observer = new MutationObserver(schedule);
    state.observer.observe(target, { childList: true, subtree: true });
  };

  const bytesToHex = (bytes) => Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('');
  const sha256Bytes = async (bytes) => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) throw new Error('当前酒馆环境没有可用的 Web Crypto，无法安全校验工作台');
    return bytesToHex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  };

  const validateManifest = (manifest) => {
    if (!manifest || typeof manifest !== 'object') throw new Error('远端 manifest 不是对象');
    if (manifest.channel !== 'stable') throw new Error('远端 manifest 不是 stable 频道');
    if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) throw new Error('远端 manifest 版本号无效');
    for (const key of ['entry', 'workbenchEntry']) {
      if (typeof manifest[key] !== 'string' || !manifest[key] || manifest[key].includes('..') || manifest[key].startsWith('/')) {
        throw new Error('远端 manifest 路径无效：' + key);
      }
    }
    for (const key of ['sha256', 'workbenchSha256']) {
      if (!/^[a-f0-9]{64}$/i.test(String(manifest[key]))) throw new Error('远端 manifest 校验值无效：' + key);
    }
    return manifest;
  };

  const cacheOpen = async () => {
    if (!globalThis.caches || typeof globalThis.caches.open !== 'function') return null;
    try { return await globalThis.caches.open(CACHE_NAME); } catch { return null; }
  };
  const cacheRead = async (key) => {
    const cache = await cacheOpen();
    if (!cache) return null;
    try {
      const response = await cache.match(key);
      return response ? new Uint8Array(await response.arrayBuffer()) : null;
    } catch { return null; }
  };
  const cacheWrite = async (key, bytes, version) => {
    const cache = await cacheOpen();
    if (!cache) return;
    try {
      await cache.put(key, new Response(bytes, { headers: {
        'content-type': 'application/octet-stream',
        'x-eyon-version': String(version || ''),
      }}));
    } catch {}
  };

  const fetchBytes = async (url) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('HTTP ' + response.status + '：' + url);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('网络请求超时：' + url);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const manifestCacheKey = MANIFEST_URL;
  const readNetworkManifest = async () => {
    const separator = MANIFEST_URL.includes('?') ? '&' : '?';
    const bytes = await fetchBytes(MANIFEST_URL + separator + 'eyon_loader=' + encodeURIComponent(LOADER_VERSION) + '&t=' + Date.now());
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
    await cacheWrite(manifestCacheKey, bytes, manifest.version);
    return { manifest, source: 'network' };
  };
  const readCachedManifest = async () => {
    const bytes = await cacheRead(manifestCacheKey);
    if (!bytes) throw new Error('没有可用的已验证缓存 manifest');
    return { manifest: validateManifest(JSON.parse(new TextDecoder().decode(bytes))), source: 'cache' };
  };

  const resolveRemoteUrl = (relativePath) => new URL(relativePath, MANIFEST_URL).href;
  const readBundle = async (url, expectedHash, version, preferNetwork) => {
    let networkError = null;
    if (preferNetwork) {
      try {
        const bytes = await fetchBytes(url);
        const actual = await sha256Bytes(bytes);
        if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) throw new Error('远端文件校验失败：' + url);
        await cacheWrite(url, bytes, version);
        return bytes;
      } catch (error) { networkError = error; }
    }
    const cached = await cacheRead(url);
    if (cached) {
      const actual = await sha256Bytes(cached);
      if (actual.toLowerCase() === String(expectedHash).toLowerCase()) return cached;
    }
    throw networkError || new Error('没有可用的已验证缓存：' + url);
  };

  const loadVerifiedArtifacts = async () => {
    let networkManifest;
    try {
      networkManifest = await readNetworkManifest();
      const manifest = networkManifest.manifest;
      const runtimeUrl = resolveRemoteUrl(manifest.entry);
      const workbenchUrl = resolveRemoteUrl(manifest.workbenchEntry);
      const runtimeBytes = await readBundle(runtimeUrl, manifest.sha256, manifest.version, true);
      const workbenchBytes = await readBundle(workbenchUrl, manifest.workbenchSha256, manifest.version, true);
      return { manifest, runtimeBytes, workbenchBytes, runtimeUrl, workbenchUrl, source: networkManifest.source };
    } catch (networkError) {
      console.warn('[伊雍工作台] GitHub 读取失败，尝试最后一次已验证缓存', networkError);
      const cachedManifest = await readCachedManifest();
      const manifest = cachedManifest.manifest;
      const runtimeUrl = resolveRemoteUrl(manifest.entry);
      const workbenchUrl = resolveRemoteUrl(manifest.workbenchEntry);
      const runtimeBytes = await readBundle(runtimeUrl, manifest.sha256, manifest.version, false);
      const workbenchBytes = await readBundle(workbenchUrl, manifest.workbenchSha256, manifest.version, false);
      return { manifest, runtimeBytes, workbenchBytes, runtimeUrl, workbenchUrl, source: cachedManifest.source };
    }
  };

  const publishFacade = (facade) => {
    if (!facade) throw new Error('远端运行时加载后没有暴露 EyonHistoryWorkbench');
    state.facade = facade;
    hostWindow.EyonHistoryWorkbench = facade;
    ensureEntryControls();
    try { hostWindow.dispatchEvent(new CustomEvent('eyon-history-workbench:ready', { detail: { facade, version: state.version } })); } catch {}
  };

  const waitForRuntimeReady = () => {
    let cleanup = () => {};
    let rejectReady = (_error) => {};
    const promise = new Promise((resolve, reject) => {
      if (scriptWindow.EyonHistoryWorkbench) { resolve(scriptWindow.EyonHistoryWorkbench); return; }
      rejectReady = reject;
      const onReady = (event) => {
        cleanup();
        state.runtimeWaitCancel = null;
        resolve(event && event.detail && event.detail.facade ? event.detail.facade : scriptWindow.EyonHistoryWorkbench);
      };
      const poll = setInterval(() => {
        if (scriptWindow.EyonHistoryWorkbench) {
          cleanup();
          state.runtimeWaitCancel = null;
          resolve(scriptWindow.EyonHistoryWorkbench);
        }
      }, 1000);
      cleanup = () => { clearInterval(poll); scriptWindow.removeEventListener('eyon-history-workbench:ready', onReady); };
      scriptWindow.addEventListener('eyon-history-workbench:ready', onReady, { once: true });
    });
    const cancel = (error) => {
      cleanup();
      state.runtimeWaitCancel = null;
      rejectReady(error);
    };
    state.runtimeWaitCancel = cancel;
    return { promise, cancel };
  };

  const importRuntime = async (bytes) => {
    if (scriptWindow.EyonHistoryWorkbench) return scriptWindow.EyonHistoryWorkbench;
    // Attach the ready listener before importing: bootstrap may finish in the
    // same task in a warm Tavern Helper context.
    const ready = waitForRuntimeReady();
    const blob = new Blob([bytes], { type: 'text/javascript' });
    state.runtimeUrl = URL.createObjectURL(blob);
    try {
      await import(state.runtimeUrl);
    } catch (error) {
      ready.cancel(error);
      throw error;
    } finally {
      URL.revokeObjectURL(state.runtimeUrl);
      state.runtimeUrl = null;
    }
    return await ready.promise;
  };

  const mountWorkbench = async (bytes) => {
    if (state.moduleScript && state.moduleScript.isConnected) return;
    const style = hostDocument.createElement('style');
    style.dataset.eyonHistoryWorkbenchLoader = 'auto';
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
    (hostDocument.head || hostDocument.documentElement).append(style);
    const overlay = hostDocument.createElement('section');
    overlay.dataset.eyonHistoryOverlay = '';
    overlay.dataset.theme = 'light';
    overlay.setAttribute('aria-label', '伊雍历史工作台');
    const container = hostDocument.createElement('main');
    container.dataset.eyonWorkbenchShell = '';
    overlay.append(container);
    overlay.hidden = true;
    (hostDocument.body || hostDocument.documentElement).append(overlay);
    container.addEventListener('eyon-history-workbench:close', () => { overlay.hidden = true; });
    state.style = style;
    state.overlay = overlay;
    const blob = new Blob([bytes], { type: 'text/javascript' });
    state.workbenchUrl = hostWindow.URL.createObjectURL(blob);
    const script = hostDocument.createElement('script');
    script.type = 'module';
    script.src = state.workbenchUrl;
    state.moduleScript = script;
    const loaded = new Promise((resolve, reject) => {
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('工作台界面模块加载失败')), { once: true });
    });
    (hostDocument.head || hostDocument.documentElement).appendChild(script);
    await loaded;
    hostWindow.URL.revokeObjectURL(state.workbenchUrl);
    state.workbenchUrl = null;
  };

  const load = () => {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      emitStatus('loading', '正在读取伊雍历史工作台远端 manifest');
      const artifacts = await loadVerifiedArtifacts();
      state.version = artifacts.manifest.version;
      state.manifestSource = artifacts.source;
      emitStatus('verified', '已验证伊雍历史工作台 ' + state.version + '（' + artifacts.source + '）');
      const facade = await importRuntime(artifacts.runtimeBytes);
      publishFacade(facade);
      await mountWorkbench(artifacts.workbenchBytes);
      ensureEntryControls();
      if (state.openRequested && hostWindow.EyonHistoryWorkbenchShell) hostWindow.EyonHistoryWorkbenchShell.open();
      emitStatus('ready', '伊雍历史工作台已就绪');
      return facade;
    })().catch((error) => {
      state.loading = null;
      markEntryError();
      emitStatus('error', '伊雍历史工作台加载失败：' + (error && error.message ? error.message : String(error)), 'error');
      throw error;
    });
    return state.loading;
  };

  state.dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    if (state.observer) state.observer.disconnect();
    if (state.uiTimer) clearTimeout(state.uiTimer);
    state.uiTimer = null;
    state.runtimeWaitCancel?.(new Error('伊雍历史工作台加载器已停止'));
    if (state.moduleScript && state.moduleScript.isConnected) state.moduleScript.remove();
    if (state.overlay) state.overlay.remove();
    if (state.style) state.style.remove();
    if (hostWindow.EyonHistoryWorkbenchShell && typeof hostWindow.EyonHistoryWorkbenchShell.dispose === 'function') {
      try { hostWindow.EyonHistoryWorkbenchShell.dispose(); } catch {}
    }
    const entry = hostDocument.getElementById(WAND_ENTRY_ID);
    if (entry) entry.remove();
    const style = hostDocument.getElementById(WAND_STYLE_ID);
    if (style) style.remove();
    if (hostWindow[INSTANCE_KEY] === state) delete hostWindow[INSTANCE_KEY];
  };

  ensureEntryControls();
  observeHostUi();
  void load().catch(() => {});
})();
