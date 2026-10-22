(() => {
  'use strict';

  // This script is intentionally small: runtime and UI bytes are fetched from the
  // public release manifest and are executed only after SHA-256 verification.
  const MANIFEST_URL = "https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@main/manifest.json";
  const RAW_BASE = "https://raw.githubusercontent.com/hanhaichuan0525-cloud/eyon-history-workbench/main/";
  const LOADER_VERSION = "0.3.3";
  // 清单来源可能被切到固定提交；bundle 相对它解析。
  let activeManifestUrl = MANIFEST_URL;
  const DOWNLOAD_TIMEOUT_MS = { manifest: 30000, bundle: 120000 };
  const CACHE_NAME = 'eyon-history-workbench-verified-v1';
  const INSTANCE_KEY = '__eyonHistoryWorkbenchAutoLoader';
  const LEGACY_INSTANCE_KEY = '__eyonHistoryWorkbenchInternalLoader';
  const LEGACY_EXTENSION_KEY = '__eyonHistoryWorkbenchExtension';

  const scriptWindow = window;
  // β1.3：宿主窗口一路上溯到最顶层可访问窗口——与悬浮球（运行时 resolveHostDocument）
  // 同一口径。旧实现只取 window.parent：手机上脚本 iframe 嵌得更深时，球挂在顶层、
  // 工作台外壳与 open 事件监听器挂在上一层，于是"点悬浮球打不开工作台"。
  const resolveHostWindow = () => {
    let current = scriptWindow;
    for (let depth = 0; depth < 8; depth += 1) {
      try {
        const parent = current.parent;
        if (!parent || parent === current) break;
        if (!parent.document || !parent.document.body) break;
        current = parent;
      } catch {
        break;
      }
    }
    return current;
  };
  const hostWindow = resolveHostWindow();
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

  const openWorkbench = () => {
    state.openRequested = true;
    if (hostWindow.EyonHistoryWorkbenchShell && typeof hostWindow.EyonHistoryWorkbenchShell.open === 'function') {
      hostWindow.EyonHistoryWorkbenchShell.open();
      return;
    }
    void load();
  };

  // β1：魔术棒入口整段退役。工作台只由角色卡悬浮球打开——悬浮球点击派发
  // eyon-history-workbench:open，该事件此前只有原生扩展入口在监听，脚本通道
  // 必须自己接上，否则点了悬浮球没有任何反应。
  const onOpenRequest = () => openWorkbench();

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

  const CDN_PATTERN = /^https:\/\/cdn\.jsdelivr\.net\/gh\/hanhaichuan0525-cloud\/eyon-history-workbench@([^/]+)\/(.*)$/;
  const RAW_PATTERN = /^https:\/\/raw\.githubusercontent\.com\/hanhaichuan0525-cloud\/eyon-history-workbench\/([^/]+)\/(.*)$/;
  const fallbackUrl = (url) => {
    const target = new URL(url);
    const cdn = target.href.match(CDN_PATTERN);
    if (cdn) return 'https://raw.githubusercontent.com/hanhaichuan0525-cloud/eyon-history-workbench/' + cdn[1] + '/' + cdn[2];
    const raw = target.href.match(RAW_PATTERN);
    if (raw) return 'https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@' + raw[1] + '/' + raw[2];
    return null;
  };
  const fetchBytes = async (url, timeoutMs = DOWNLOAD_TIMEOUT_MS.manifest, verify) => {
    const backup = fallbackUrl(url);
    const candidates = backup ? [url, backup] : [url];
    let lastError;
    for (const candidate of candidates) {
      if (candidate !== url) emitStatus('loading', '主下载暂不可用，正在从备用来源读取工作台');
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(candidate, {
          cache: 'no-store', credentials: 'omit', signal: controller.signal,
        });
        if (!response.ok) throw new Error('HTTP ' + response.status + '：' + candidate);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (verify) await verify(bytes);
        return bytes;
      } catch (error) {
        lastError = error && error.name === 'AbortError' ? new Error('网络请求超时：' + candidate) : error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastError;
  };

  const manifestCacheKey = MANIFEST_URL;
  // 清单来源：jsDelivr @main、GitHub raw、以及 GitHub API 解析出的最新提交（不可缓存）。
  // 取版本号最高的一份，避免 CDN 的 @main 旧缓存把升级整个挡掉。
  const COMMIT_API = 'https://api.github.com/repos/hanhaichuan0525-cloud/eyon-history-workbench/commits/main';
  const versionParts = (value) => String(value).split('.').map(part => Number.parseInt(part, 10) || 0);
  const isNewer = (a, b) => {
    const x = versionParts(a); const y = versionParts(b);
    for (let i = 0; i < 3; i += 1) { if (x[i] !== y[i]) return x[i] > y[i]; }
    return false;
  };
  const withBust = (base) => base + (base.includes('?') ? '&' : '?')
    + 'eyon_loader=' + encodeURIComponent(LOADER_VERSION) + '&t=' + Date.now();
  const readNetworkManifest = async () => {
    const candidates = [MANIFEST_URL, RAW_BASE + 'manifest.json'];
    try {
      const apiBytes = await fetchBytes(COMMIT_API, 8000);
      const sha = JSON.parse(new TextDecoder().decode(apiBytes)).sha;
      if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) {
        candidates.push('https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@' + sha + '/manifest.json');
      }
    } catch {}
    let best = null;
    for (const candidate of candidates) {
      try {
        const bytes = await fetchBytes(withBust(candidate), DOWNLOAD_TIMEOUT_MS.manifest,
          value => validateManifest(JSON.parse(new TextDecoder().decode(value))));
        const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
        if (!best || isNewer(manifest.version, best.manifest.version)) best = { manifest, bytes, url: candidate };
      } catch {}
    }
    if (!best) throw new Error('所有清单来源均不可用');
    activeManifestUrl = best.url;
    return { manifest: best.manifest, bytes: best.bytes, source: 'network' };
  };
  const readCachedManifest = async () => {
    const bytes = await cacheRead(manifestCacheKey);
    if (!bytes) throw new Error('没有可用的已验证缓存 manifest');
    return { manifest: validateManifest(JSON.parse(new TextDecoder().decode(bytes))), source: 'cache' };
  };

  // 版本参数隔离本地缓存；CDN可能忽略查询参数或返回旧字节，仍逐字节校验SHA-256。
  const resolveRemoteUrl = (relativePath, version) => {
    const url = new URL(relativePath, activeManifestUrl).href;
    if (!version) return url;
    return url + (url.includes('?') ? '&' : '?') + 'eyon_v=' + encodeURIComponent(String(version));
  };
  const readBundle = async (url, expectedHash, version, preferNetwork) => {
    let networkError = null;
    if (preferNetwork) {
      try {
        const bytes = await fetchBytes(url, DOWNLOAD_TIMEOUT_MS.bundle, async candidate => {
          const actual = await sha256Bytes(candidate);
          if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) throw new Error('远端文件校验失败：' + url);
        });
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

  // 清掉上一版留下的 bundle 缓存条目（键里带 eyon_v= 的都不是当前版本）。
  const pruneStaleBundles = async (currentVersion) => {
    const cache = await cacheOpen();
    if (!cache || typeof cache.keys !== 'function') return;
    try {
      const keys = await cache.keys();
      await Promise.all(keys.map(async (request) => {
        const key = typeof request === 'string' ? request : request.url;
        if (!key.includes('eyon_v=')) return;
        if (key.includes('eyon_v=' + encodeURIComponent(String(currentVersion)))) return;
        try {
          await cache.delete(request);
        } catch {}
      }));
    } catch {}
  };

  const loadVerifiedArtifacts = async () => {
    let networkManifest;
    try {
      networkManifest = await readNetworkManifest();
      const manifest = networkManifest.manifest;
      const runtimeUrl = resolveRemoteUrl(manifest.entry, manifest.version);
      const workbenchUrl = resolveRemoteUrl(manifest.workbenchEntry, manifest.version);
      const runtimeBytes = await readBundle(runtimeUrl, manifest.sha256, manifest.version, true);
      const workbenchBytes = await readBundle(workbenchUrl, manifest.workbenchSha256, manifest.version, true);
      // 两个 bundle 全部校验通过，才把这一组提升为新的回退基线；manifest 最后写。
      await cacheWrite(runtimeUrl, runtimeBytes, manifest.version);
      await cacheWrite(workbenchUrl, workbenchBytes, manifest.version);
      await cacheWrite(manifestCacheKey, networkManifest.bytes, manifest.version);
      void pruneStaleBundles(manifest.version);
      return { manifest, runtimeBytes, workbenchBytes, runtimeUrl, workbenchUrl, source: networkManifest.source };
    } catch (networkError) {
      console.warn('[伊雍工作台] 远端读取失败，尝试最后一次已验证缓存', networkError);
      const cachedManifest = await readCachedManifest();
      const manifest = cachedManifest.manifest;
      const runtimeUrl = resolveRemoteUrl(manifest.entry, manifest.version);
      const workbenchUrl = resolveRemoteUrl(manifest.workbenchEntry, manifest.version);
      const runtimeBytes = await readBundle(runtimeUrl, manifest.sha256, manifest.version, false);
      const workbenchBytes = await readBundle(workbenchUrl, manifest.workbenchSha256, manifest.version, false);
      return { manifest, runtimeBytes, workbenchBytes, runtimeUrl, workbenchUrl, source: cachedManifest.source };
    }
  };

  const publishFacade = (facade) => {
    if (!facade) throw new Error('远端运行时加载后没有暴露 EyonHistoryWorkbench');
    state.facade = facade;
    hostWindow.EyonHistoryWorkbench = facade;
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
      if (state.openRequested && hostWindow.EyonHistoryWorkbenchShell) hostWindow.EyonHistoryWorkbenchShell.open();
      emitStatus('ready', '伊雍历史工作台已就绪');
      // 运行时的通知表只在 error / success / cancelled 上安排退场，phase:'ready' 会永久驻留
      // （真机现象：悬浮球停在"加载完毕"动作，不回 idle 日常循环）。保留 ready 事件兼容其它
      // 消费者，随后补一次 success 让同 key 条目自然退场。
      setTimeout(() => emitStatus('success', '伊雍历史工作台已就绪'), 150);
      return facade;
    })().catch((error) => {
      state.loading = null;
      emitStatus('error', '伊雍历史工作台加载失败：' + (error && error.message ? error.message : String(error)), 'error');
      throw error;
    });
    return state.loading;
  };

  state.dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    state.runtimeWaitCancel?.(new Error('伊雍历史工作台加载器已停止'));
    hostWindow.removeEventListener('eyon-history-workbench:open', onOpenRequest);
    if (state.moduleScript && state.moduleScript.isConnected) state.moduleScript.remove();
    if (state.overlay) state.overlay.remove();
    if (state.style) state.style.remove();
    if (hostWindow.EyonHistoryWorkbenchShell && typeof hostWindow.EyonHistoryWorkbenchShell.dispose === 'function') {
      try { hostWindow.EyonHistoryWorkbenchShell.dispose(); } catch {}
    }
    // β1.4：必须清掉外壳全局。旧实现留着它，于是 openWorkbench() 看到"外壳还在"
    // 就直接 open() 一个已被 dispose 的空壳，永远走不到 void load() 重载分支。
    if (hostWindow.EyonHistoryWorkbenchShell) {
      try { delete hostWindow.EyonHistoryWorkbenchShell; } catch {}
    }
    if (hostWindow[INSTANCE_KEY] === state) delete hostWindow[INSTANCE_KEY];
  };

  /**
   * β1.4 真机病历（仅移动端）：手机切后台/锁屏触发 pagehide，加载器把 overlay 与监听器
   * 全拆掉，而悬浮球属于运行时、不会跟着死——球还在、能拖，点上去毫无反应；bfcache
   * 恢复时脚本不会重新执行，也不会自愈。修法：
   *   ①只有真正离开页面（persisted === false）才销毁；
   *   ②从 bfcache 回来（pageshow persisted）时自检，缺 overlay 就按已验证缓存重装（幂等）。
   */
  const onPageHide = (event) => {
    if (event && event.persisted) return;
    state.dispose();
  };
  const ensureMounted = () => {
    if (state.disposed) return;
    if (hostWindow[INSTANCE_KEY] && hostWindow[INSTANCE_KEY] !== state) return;
    if (!state.overlay) void load().catch(() => {});
  };
  const onPageShow = (event) => {
    if (event && event.persisted) ensureMounted();
  };

  hostWindow.addEventListener('eyon-history-workbench:open', onOpenRequest);
  hostWindow.addEventListener('pagehide', onPageHide);
  hostWindow.addEventListener('pageshow', onPageShow);
  void load().catch(() => {});
})();
