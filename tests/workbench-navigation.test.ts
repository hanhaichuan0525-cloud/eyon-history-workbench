import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  normalizeWorkbenchView,
  WORKBENCH_VIEWS,
  WORKBENCH_VIEW_IDS,
} from '../src/ui/workbenchNavigation.ts';

test('统一工作台只暴露五个正式模块且顺序稳定', () => {
  assert.deepEqual(
    WORKBENCH_VIEWS.map(view => view.id),
    [...WORKBENCH_VIEW_IDS],
  );
  assert.equal(new Set(WORKBENCH_VIEW_IDS).size, 5);
});

test('无效工作台栏目回退到墟境时空', () => {
  assert.equal(normalizeWorkbenchView('biography'), 'biography');
  assert.equal(normalizeWorkbenchView('character-viewer'), 'timeline');
  assert.equal(normalizeWorkbenchView(''), 'timeline');
});

test('传记后台准备完成、正文即将开始时才打开工作台并切到传记书库', async () => {
  const page = await readFile(new URL('../src/ui/workbenchPage.ts', import.meta.url), 'utf8');
  assert.match(page, /detail\?\.taskType !== 'biography'/u);
  assert.match(page, /detail\.status !== 'awaiting_narrative'/u);
  assert.doesNotMatch(page, /detail\.status !== 'assembling_context'/u);
  assert.doesNotMatch(page, /\['running', 'retrying'\]/u);
  assert.match(page, /EyonHistoryWorkbenchShell\?\.open\(\)/u);
  assert.match(page, /EyonHistoryWorkbenchShell\?\.navigate\('biography'\)/u);
});

test('传记后台完成后自动选中并展开待正文归档记录', async () => {
  const workbench = await readFile(new URL('../src/ui/biographyWorkbench.ts', import.meta.url), 'utf8');
  assert.match(workbench, /detail\.status === 'awaiting_narrative'/u);
  assert.match(workbench, /item\.record\.status === 'validated'/u);
  assert.match(workbench, /state\.selectedKey = awaitingNarrative\.record\.key/u);
  assert.match(workbench, /state\.open = true/u);
});

test('网页默认入口与发布包共用同一份正式工作台 bundle', async () => {
  const [entry, preview, packageText] = await Promise.all([
    readFile(new URL('../prototype/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../prototype/workbench-runtime.html', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ]);
  const packageVersion = JSON.parse(packageText).version as string;
  const previewVersion = packageVersion.match(/internal\.(\d+)$/u)?.[1] ?? packageVersion;
  assert.match(packageVersion, /^\d+\.\d+\.\d+(?:-internal\.\d+)?$/u);
  assert.match(entry, /workbench-runtime\.html/u);
  assert.match(entry, /legacy-design/u);
  assert.match(preview, /data-preview-source="production-bundle"/u);
  assert.ok(preview.includes(packageVersion));
  assert.ok(preview.includes(`../dist/workbench.js?v=${previewVersion}`));
  assert.match(preview, /listBiographies: async \(\) => structuredClone\(previewBiographyRecords\)/u);
});

test('工作台外壳固定且只有正文区承担纵向滚动', async () => {
  const [css, shell, packager] = await Promise.all([
    readFile(new URL('../src/ui/workbenchShell.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/workbenchShell.ts', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-tavern-test-loader.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /\.app\s*\{[\s\S]*?overflow:\s*hidden;/u);
  assert.match(css, /\.workspace\s*\{[\s\S]*?grid-template-rows:\s*auto minmax\(0, 1fr\);[\s\S]*?overflow:\s*hidden;/u);
  assert.match(css, /\.content\s*\{[\s\S]*?overflow-y:\s*auto;/u);
  assert.match(shell, /resetWorkspaceScroll\(\);/u);
  assert.match(packager, /\[data-eyon-history-overlay\][\s\S]*?overflow: hidden;/u);
  assert.match(packager, /正式网页预览缺少同源标记/u);
});

test('工作台栏目切换不建立 transform 定位容器，右键菜单保持贴近指针', async () => {
  const [shellCss, biographyCss, genealogyCss] = await Promise.all([
    readFile(new URL('../src/ui/workbenchShell.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/biographyWorkbench.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/genealogyWorkbench.css', import.meta.url), 'utf8'),
  ]);
  assert.match(shellCss, /@keyframes view-reveal \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/u);
  assert.doesNotMatch(shellCss, /@keyframes view-reveal[^\n]*transform:/u);
  assert.match(biographyCss, /\.biography-context-menu\s*\{[\s\S]*?position:\s*fixed;/u);
  assert.match(genealogyCss, /\.genealogy-context-menu\s*\{[\s\S]*?position:\s*fixed;/u);
});

test('正式传记封面带轻量纹路且展开页只使用统一纸张底色', async () => {
  const css = await readFile(new URL('../src/ui/biographyWorkbench.css', import.meta.url), 'utf8');
  assert.match(css, /\.codex-book\s*\{[\s\S]*?background:\s*var\(--paper\);/u);
  assert.match(css, /\.codex-cover\s*\{[\s\S]*?repeating-linear-gradient\(135deg/u);
  assert.match(css, /\.codex-cover::before/u);
  assert.match(css, /\.codex-spread\s*\{[\s\S]*?var\(--paper\);/u);
  assert.doesNotMatch(css, /\.workbench\[data-theme="light"\] \.codex-book/u);
});
