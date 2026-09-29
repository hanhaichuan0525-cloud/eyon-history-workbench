import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const artifactPath = resolve(root, 'release/酒馆助手脚本-伊雍历史工作台-β1.json');
const remoteLoaderPath = resolve(root, 'extension/auto-loader.js');

/**
 * β1（internal.89）：加载器契约。
 * 真机病历：①静态 import GitHub raw 的 .js 会因 text/plain 被浏览器按 MIME 拒绝，
 * 加载器整段不执行、控制台无日志；②悬浮球点击派发的 eyon-history-workbench:open
 * 原本只有原生扩展在监听；③运行时通知表只在 error/success/cancelled 上安排退场，
 * phase:'ready' 会永久驻留，悬浮球停在"加载完毕"不回 idle。
 * 因此这里锁死：整段内联、清单走 jsDelivr、桥接与通知退场补丁在位、魔术棒入口退役。
 */
test('β1 加载器产物：整段内联 + CDN 清单 + 悬浮球桥接 + 通知退场，且不再挂魔术棒入口', async () => {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
    type: string;
    enabled: boolean;
    id: string;
    name: string;
    content: string;
  };
  assert.equal(artifact.type, 'script');
  assert.equal(artifact.enabled, true);
  assert.equal(artifact.id, 'eyon-history-workbench-auto-loader');
  assert.match(artifact.name, /β1/u, '产物名带对外版本名');
  // ① 整段内联：不允许任何静态 import。
  assert.doesNotMatch(artifact.content, /^\s*import\s/mu);
  assert.match(
    artifact.content,
    /cdn\.jsdelivr\.net\/gh\/hanhaichuan0525-cloud\/eyon-history-workbench@main\/manifest\.json/,
  );
  // ② 悬浮球桥接。
  assert.match(artifact.content, /addEventListener\('eyon-history-workbench:open', onOpenRequest\)/);
  assert.match(artifact.content, /removeEventListener\('eyon-history-workbench:open', onOpenRequest\)/);
  // ③ 通知退场补丁。
  assert.match(artifact.content, /emitStatus\('success', '伊雍历史工作台已就绪'\)/);
  // ④ 魔术棒入口退役。
  assert.doesNotMatch(artifact.content, /eyon-history-workbench-wand-entry/);
  assert.doesNotMatch(artifact.content, /sp_wand_container/);
  assert.doesNotMatch(artifact.content, /\beval\s*\(/u);
  assert.doesNotMatch(artifact.content, /Function\s*\(/u);
  // 产物内容与仓库内远端模块同源（同一份代码，两种投递方式）。
  assert.equal(artifact.content, (await readFile(remoteLoaderPath, 'utf8')).trimEnd());
});

test('远端加载器模块保留 SHA-256 校验、缓存回退与超时控制', async () => {
  const loader = await readFile(remoteLoaderPath, 'utf8');
  assert.match(loader, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(loader, /CACHE_NAME = 'eyon-history-workbench-verified-v1'/);
  assert.match(loader, /new URL\(relativePath, MANIFEST_URL\)/);
  assert.match(loader, /AbortController/);
  assert.match(loader, /setTimeout\(.*15000/);
  assert.match(loader, /if \(!\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(String\(manifest\.version\)\)\)/);
  assert.doesNotMatch(loader, /eyon-history-workbench-wand-entry/);
  assert.doesNotMatch(loader, /\beval\s*\(/u);
  assert.doesNotMatch(loader, /Function\s*\(/u);
});

/**
 * β1.1（半新半旧窗口）：bundle 地址带版本参数 → 新版本即新缓存键（jsDelivr 边缘与浏览器
 * 都以完整 URL 为键），第一次请求必然回源；manifest 缓存改到两个 bundle 都通过 SHA-256
 * 校验之后才写，成为这一组的提交点；旧版本 bundle 条目随后清理。
 */
test('加载器缓存语义：版本化 bundle 地址 + manifest 最后提交 + 旧条目清理', async () => {
  const loader = await readFile(remoteLoaderPath, 'utf8');
  assert.match(loader, /'eyon_v=' \+ encodeURIComponent\(String\(version\)\)/u, 'bundle 地址带版本参数');
  assert.match(loader, /resolveRemoteUrl\(manifest\.entry, manifest\.version\)/u, '取地址时带上 manifest 版本');
  assert.match(
    loader,
    /cacheWrite\(runtimeUrl[\s\S]*cacheWrite\(workbenchUrl[\s\S]*cacheWrite\(manifestCacheKey/u,
    'manifest 缓存必须在两个 bundle 之后写',
  );
  assert.doesNotMatch(loader, /cacheWrite\(manifestCacheKey, bytes,/u, 'manifest 读取阶段不得提前落盘');
  assert.match(loader, /pruneStaleBundles/u, '旧版本 bundle 条目应被清理');
});
