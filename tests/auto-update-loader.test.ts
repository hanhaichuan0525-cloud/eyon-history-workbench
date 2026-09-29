import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const artifactPath = resolve(root, 'release/酒馆助手脚本-伊雍历史工作台-自动更新.json');
const remoteLoaderPath = resolve(root, 'extension/auto-loader.js');

test('auto-update loader artifact has a verified remote bootstrap contract', async () => {
  const artifact = JSON.parse(await readFile(artifactPath, 'utf8')) as {
    type: string;
    enabled: boolean;
    id: string;
    content: string;
  };
  assert.equal(artifact.type, 'script');
  assert.equal(artifact.enabled, true);
  assert.equal(artifact.id, 'eyon-history-workbench-auto-loader');
  assert.match(artifact.content, /import ['"]https:\/\/raw\.githubusercontent\.com\/hanhaichuan0525-cloud\/eyon-history-workbench\/main\/extension\/auto-loader\.js\?eyon_loader=/);
  assert.doesNotMatch(artifact.content, /\beval\s*\(/);
  assert.doesNotMatch(artifact.content, /Function\s*\(/);

  const loader = await readFile(remoteLoaderPath, 'utf8');
  assert.match(loader, /raw\.githubusercontent\.com\/hanhaichuan0525-cloud\/eyon-history-workbench\/main\/manifest\.json/);
  assert.match(loader, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(loader, /CACHE_NAME = 'eyon-history-workbench-verified-v1'/);
  assert.match(loader, /eyon-history-workbench-wand-entry/);
  assert.match(loader, /new URL\(relativePath, MANIFEST_URL\)/);
  assert.match(loader, /AbortController/);
  assert.match(loader, /setTimeout\(.*15000/);
  assert.match(loader, /state\.uiTimer/);
  assert.doesNotMatch(loader, /\beval\s*\(/);
  assert.doesNotMatch(loader, /Function\s*\(/);
});
