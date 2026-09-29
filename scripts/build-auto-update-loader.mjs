import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'manifest.json');
const distRuntimePath = resolve(root, 'dist/index.js');
const distWorkbenchPath = resolve(root, 'dist/workbench.js');
const releaseDir = resolve(root, 'release');

// β1：清单与 bundle 全部走 jsDelivr。GitHub raw 对 .js 返回 text/plain，静态 import 会被
// 浏览器按 MIME 拒绝（真机病历：加载器整段不执行、控制台无日志）；jsDelivr 返回
// application/javascript，且分支缓存可用 purge 接口刷新，因此加载器整段内联、不再依赖
// 宿主的模块加载路径。
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@main';
const MANIFEST_URL = `${CDN_BASE}/manifest.json`;
const RELEASE_LABEL = 'β1';
const AUTO_LOADER_VERSION = '0.3.1';
const AUTO_LOADER_ID = 'eyon-history-workbench-auto-loader';

const outputPath = resolve(releaseDir, `酒馆助手脚本-伊雍历史工作台-${RELEASE_LABEL}.json`);
const sumsPath = resolve(releaseDir, 'SHA256SUMS.txt');
const remoteLoaderPath = resolve(root, 'extension/auto-loader.js');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('manifest.json 不是对象');
  if (manifest.channel !== 'stable') throw new Error(`manifest channel 必须为 stable，当前为 ${manifest.channel}`);
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version))) throw new Error(`manifest version 无效：${manifest.version}`);
  for (const [key, value] of [['entry', manifest.entry], ['workbenchEntry', manifest.workbenchEntry]]) {
    if (typeof value !== 'string' || !value || value.includes('..') || value.startsWith('/')) {
      throw new Error(`manifest ${key} 无效`);
    }
  }
  for (const [key, value] of [['sha256', manifest.sha256], ['workbenchSha256', manifest.workbenchSha256]]) {
    if (!/^[a-f0-9]{64}$/i.test(String(value))) throw new Error(`manifest ${key} 不是 SHA-256`);
  }
}

function createLoaderContent() {
  return `(() => {
  'use strict';

  // This script is intentionally small: runtime and UI bytes are fetched from the
  // public release manifest and are executed only after SHA-256 verification.
  const MANIFEST_URL = ${JSON.stringify(MANIFEST_URL)};
  const LOADER_VERSION = ${JSON.stringify(AUTO_LOADER_VERSION)};
  const CACHE_NAME = 'eyon-history-workbench-verified-v1';
  const INSTANCE_KEY = '__eyonHistoryWorkbenchAutoLoader';
  const LEGACY_INSTANCE_KEY = '__eyonHistoryWorkbenchInternalLoader';
  const LEGACY_EXTENSION_KEY = '__eyonHistoryWorkbenchExtension';

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
    if (!/^\\d+\\.\\d+\\.\\d+$/.test(String(manifest.version))) throw new Error('远端 manifest 版本号无效');
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
    // β1.1：这里不再立刻写 manifest 缓存。它是 (manifest, runtime, workbench) 这一组的
    // 提交点，必须等两个 bundle 都通过 SHA-256 校验后再落盘（见 loadVerifiedArtifacts）。
    // 旧实现先写 manifest 再验 bundle，于是"新 manifest + 旧 bundle"的窗口会把回退基线
    // 也污染成不匹配的一对，导致那一次加载直接失败。
    return { manifest, bytes, source: 'network' };
  };
  const readCachedManifest = async () => {
    const bytes = await cacheRead(manifestCacheKey);
    if (!bytes) throw new Error('没有可用的已验证缓存 manifest');
    return { manifest: validateManifest(JSON.parse(new TextDecoder().decode(bytes))), source: 'cache' };
  };

  // β1.1：bundle 地址带 manifest 版本参数。jsDelivr 的边缘缓存与浏览器缓存都以完整 URL
  // 为键，于是"新版本"天然就是"新缓存键"，第一次请求必然回源取新字节——不再依赖推送后
  // 手动 purge，也不会再出现 manifest 已刷新、bundle 还是旧缓存的一对。
  const resolveRemoteUrl = (relativePath, version) => {
    const url = new URL(relativePath, MANIFEST_URL).href;
    if (!version) return url;
    return url + (url.includes('?') ? '&' : '?') + 'eyon_v=' + encodeURIComponent(String(version));
  };
  const readBundle = async (url, expectedHash, version, preferNetwork) => {
    let networkError = null;
    if (preferNetwork) {
      try {
        const bytes = await fetchBytes(url);
        const actual = await sha256Bytes(bytes);
        if (actual.toLowerCase() !== String(expectedHash).toLowerCase()) throw new Error('远端文件校验失败：' + url);
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
    style.textContent = \`
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
    \`;
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
    if (hostWindow[INSTANCE_KEY] === state) delete hostWindow[INSTANCE_KEY];
  };

  hostWindow.addEventListener('eyon-history-workbench:open', onOpenRequest);
  void load().catch(() => {});
})();`;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assertManifest(manifest);
const runtimeBytes = await readFile(distRuntimePath);
const workbenchBytes = await readFile(distWorkbenchPath);
const runtimeHash = sha256(runtimeBytes);
const workbenchHash = sha256(workbenchBytes);
if (runtimeHash !== manifest.sha256) throw new Error(`dist/index.js hash mismatch: ${runtimeHash} != ${manifest.sha256}`);
if (workbenchHash !== manifest.workbenchSha256) throw new Error(`dist/workbench.js hash mismatch: ${workbenchHash} != ${manifest.workbenchSha256}`);

const remoteLoaderContent = createLoaderContent();
await writeFile(remoteLoaderPath, `${remoteLoaderContent}\n`, 'utf8');
// β1：不再生成"只 import 远端模块"的一行脚本。那条路径在 GitHub raw 上会因为
// text/plain 被浏览器按 MIME 拒绝；现在把实现整段内联进脚本，远端只提供 manifest 与
// dist（全部经 jsDelivr + SHA-256 校验），修加载器本身与修 bundle 因此互不牵连。
const artifact = {
  type: 'script',
  enabled: true,
  name: `伊雍历史工作台-${RELEASE_LABEL}（自动更新加载器）`,
  id: AUTO_LOADER_ID,
  info: `伊雍历史工作台 ${RELEASE_LABEL}（内部版本 ${manifest.version}，loader ${AUTO_LOADER_VERSION}）。`
    + `①加载器整段内联，无静态 import，规避 GitHub raw 的 text/plain 导致的 module MIME 拒绝；`
    + `②manifest 与 dist 全走 jsDelivr，读取后逐字节校验 SHA-256，失败则回退最后一次已验证缓存；`
    + `③魔术棒入口已退役，工作台只由角色卡悬浮球打开，并已接上 eyon-history-workbench:open 桥接；`
    + `④ready 通知后补一次 success，避免通知条目永久驻留导致悬浮球不回日常动作。`
    + `请停用旧版原生扩展和旧版自动更新脚本，避免重复监听。`,
  button: { enabled: true, buttons: [] },
  data: {},
  export_with: { data: true, button: true },
  content: remoteLoaderContent,
};
await writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

const artifactName = basename(outputPath);
const sums = [
  `# Release checksums (SHA-256)`,
  `${sha256(await readFile(resolve(releaseDir, `酒馆助手脚本-伊雍历史工作台-v${manifest.version}.json`)))}  酒馆助手脚本-伊雍历史工作台-v${manifest.version}.json`,
  `${sha256(await readFile(outputPath))}  ${artifactName}`,
  `${sha256(await readFile(remoteLoaderPath))}  extension/auto-loader.js`,
];
const releaseRegexDir = resolve(releaseDir, 'regex');
for (const fileName of ['regex-伊雍-传记美化（as）.json', 'regex-伊雍-对话框美化（as）.json', 'regex-伊雍-蝴蝶效应面板美化（as）.json', 'regex-伊雍-墟境输出面板美化（as）.json']) {
  const filePath = resolve(releaseRegexDir, fileName);
  try { sums.push(`${sha256(await readFile(filePath))}  regex/${fileName}`); } catch {}
}
await writeFile(sumsPath, sums.join('\n') + '\n', 'utf8');
console.log(`generated ${outputPath}`);
