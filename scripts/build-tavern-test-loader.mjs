import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const releaseDir = path.join(root, 'release');
const previewPath = path.join(root, 'prototype', 'workbench-runtime.html');
const prototypeIndexPath = path.join(root, 'prototype', 'index.html');
const regexNames = [
  'regex-伊雍-传记美化（as）.json',
  'regex-伊雍-对话框美化（as）.json',
  'regex-伊雍-蝴蝶效应面板美化（as）.json',
  'regex-伊雍-墟境输出面板美化（as）.json',
];

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const stableVersion = /^\d+\.\d+\.\d+$/u.test(manifest.version) && manifest.channel === 'stable';
const internalBuild = manifest.version.match(/internal\.(\d+)$/u)?.[1] ?? '';
if (!stableVersion && !internalBuild) {
  throw new Error(`清单版本 ${manifest.version} 与通道 ${manifest.channel} 不构成可发布版本`);
}
const outputName = stableVersion
  ? `酒馆助手脚本-伊雍历史工作台-v${manifest.version}.json`
  : '酒馆助手脚本-伊雍历史工作台-内测.json';
const outputPath = path.join(releaseDir, outputName);
const artifacts = [
  ['sha256', manifest.entry],
  ['workbenchSha256', manifest.workbenchEntry],
];

for (const [hashKey, relativePath] of artifacts) {
  const bytes = await readFile(path.join(root, relativePath));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest[hashKey]) {
    throw new Error(`${relativePath} SHA-256 与 manifest.json 不一致，请先重新构建并更新清单`);
  }
}

const runtimeSource = await readFile(path.join(root, manifest.entry), 'utf8');
const workbenchSource = await readFile(path.join(root, manifest.workbenchEntry), 'utf8');
const previewSource = await readFile(previewPath, 'utf8');
const prototypeIndexSource = await readFile(prototypeIndexPath, 'utf8');
if (!runtimeSource.includes(manifest.version)) {
  throw new Error(`主运行时未包含清单版本 ${manifest.version}，拒绝打包`);
}
for (const marker of ['rail-ornament', 'data-ledger', 'ARCHIVE SHELF']) {
  if (!workbenchSource.includes(marker)) {
    throw new Error(`正式工作台缺少视觉同源标记 ${marker}，拒绝嵌入旧界面`);
  }
}
const previewVersion = stableVersion ? manifest.version : internalBuild;
for (const marker of [
  'data-preview-source="production-bundle"',
  `../${manifest.workbenchEntry}?v=${previewVersion}`,
  manifest.version,
]) {
  if (!previewSource.includes(marker)) {
    throw new Error(`正式网页预览缺少同源标记 ${marker}，拒绝打包`);
  }
}
for (const marker of ['workbench-runtime.html', 'legacy-design']) {
  if (!prototypeIndexSource.includes(marker)) {
    throw new Error(`网页入口没有指向正式运行时（缺少 ${marker}），拒绝打包`);
  }
}
const loaderGlue = createLoaderGlue(workbenchSource, manifest.version);
const content = `${runtimeSource}\n;${loaderGlue}\n`;

const exportedScript = {
  type: 'script',
  enabled: true,
  name: stableVersion
    ? `伊雍历史工作台 ${manifest.version}`
    : `伊雍历史工作台 内测 ${manifest.version}`,
  id: stableVersion
    ? 'eyon-history-workbench-loader'
    : 'eyon-history-workbench-internal-loader',
  info: [
    stableVersion
      ? `伊雍历史工作台稳定整合包 ${manifest.version}。`
      : `伊雍历史工作台内测整合包 ${manifest.version}。`,
    '已内置墟境时间内核与正式工作台界面。',
    '启用前必须关闭旧版伊雍墟境系统脚本与旧悬浮球，避免重复监听变量。',
  ].join(''),
  button: {
    enabled: true,
    buttons: [],
  },
  data: {},
  export_with: {
    data: true,
    button: true,
  },
  content,
};

await mkdir(releaseDir, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(exportedScript, null, 2)}\n`, 'utf8');
if (stableVersion) {
  const releaseRegexDir = path.join(releaseDir, 'regex');
  await mkdir(releaseRegexDir, { recursive: true });
  for (const name of regexNames) {
    await copyFile(path.join(root, 'regex', name), path.join(releaseRegexDir, name));
  }

  const checksumTargets = [
    [outputName, outputPath],
    ...regexNames.map(name => [`regex/${name}`, path.join(releaseRegexDir, name)]),
  ];
  const checksumLines = [];
  for (const [label, filePath] of checksumTargets) {
    const digest = createHash('sha256').update(await readFile(filePath)).digest('hex');
    checksumLines.push(`${digest}  ${label}`);
  }
  await writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), `${checksumLines.join('\n')}\n`, 'utf8');
}
console.info(`已生成 ${outputPath}`);

function createLoaderGlue(uiSource, version) {
  return `(() => {
  'use strict';

  const hostWindow = window.parent || window;
  const hostDocument = hostWindow.document;
  const instanceKey = '__eyonHistoryWorkbenchInternalLoader';
  const previous = hostWindow[instanceKey];
  if (previous && typeof previous.dispose === 'function') previous.dispose();

  const state = {
    disposed: false,
    facade: null,
    overlay: null,
    style: null,
    moduleScript: null,
    moduleUrl: '',
    openRequested: false,
  };

  const forwardStatus = event => {
    if (state.disposed) return;
    hostWindow.dispatchEvent(new hostWindow.CustomEvent('eyon-history-workbench:status', {
      detail: event.detail,
    }));
  };

  const publishFacade = facade => {
    if (state.disposed || !facade) return;
    state.facade = facade;
    hostWindow.EyonHistoryWorkbench = facade;
    mountWorkbench();
  };

  const mountWorkbench = () => {
    if (state.disposed || state.overlay) return;

    const style = hostDocument.createElement('style');
    style.dataset.eyonHistoryWorkbenchLoader = '${version}';
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
    hostDocument.head.append(style);

    const overlay = hostDocument.createElement('section');
    overlay.dataset.eyonHistoryOverlay = '';
    overlay.dataset.theme = 'light';
    overlay.setAttribute('aria-label', '伊雍历史工作台');
    const container = hostDocument.createElement('main');
    container.dataset.eyonWorkbenchShell = '';
    overlay.append(container);
    overlay.hidden = true;
    hostDocument.body.append(overlay);

    container.addEventListener('eyon-history-workbench:close', () => {
      overlay.hidden = true;
    });

    const moduleUrl = hostWindow.URL.createObjectURL(new hostWindow.Blob(
      [${JSON.stringify(uiSource)}],
      { type: 'text/javascript' },
    ));
    const moduleScript = hostDocument.createElement('script');
    moduleScript.type = 'module';
    moduleScript.src = moduleUrl;
    moduleScript.addEventListener('load', () => {
      hostWindow.dispatchEvent(new hostWindow.CustomEvent(
        'eyon-history-workbench:ready',
        { detail: state.facade },
      ));
      if (state.openRequested) {
        overlay.hidden = false;
        hostWindow.EyonHistoryWorkbenchShell?.open?.();
      }
    }, { once: true });
    moduleScript.addEventListener('error', () => {
      console.error('[Eyon History Workbench] 正式工作台界面载入失败');
    }, { once: true });
    hostDocument.head.append(moduleScript);

    state.style = style;
    state.overlay = overlay;
    state.moduleScript = moduleScript;
    state.moduleUrl = moduleUrl;
  };

  const onReady = event => publishFacade(event.detail || window.EyonHistoryWorkbench);
  const onOpen = () => {
    state.openRequested = true;
    if (state.overlay) state.overlay.hidden = false;
    hostWindow.EyonHistoryWorkbenchShell?.open?.();
  };
  window.addEventListener('eyon-history-workbench:status', forwardStatus);
  window.addEventListener('eyon-history-workbench:ready', onReady);
  hostWindow.addEventListener('eyon-history-workbench:open', onOpen);
  if (window.EyonHistoryWorkbench) publishFacade(window.EyonHistoryWorkbench);

  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    window.removeEventListener('eyon-history-workbench:status', forwardStatus);
    window.removeEventListener('eyon-history-workbench:ready', onReady);
    hostWindow.removeEventListener('eyon-history-workbench:open', onOpen);
    hostWindow.EyonHistoryWorkbenchShell?.dispose?.();
    state.moduleScript?.remove();
    state.overlay?.remove();
    state.style?.remove();
    if (state.moduleUrl) hostWindow.URL.revokeObjectURL(state.moduleUrl);
    if (hostWindow.EyonHistoryWorkbench === state.facade) {
      delete hostWindow.EyonHistoryWorkbench;
    }
    if (hostWindow[instanceKey]?.dispose === dispose) {
      delete hostWindow[instanceKey];
    }
  };

  hostWindow[instanceKey] = { dispose, version: '${version}' };
  window.addEventListener('pagehide', dispose, { once: true });
})();`;
}
