import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const testLoaderPath = resolve(root, 'scripts/build-tavern-test-loader.mjs');
const autoLoaderPath = resolve(root, 'scripts/build-auto-update-loader.mjs');

/**
 * β1.4 真机病历（仅移动端）：手机切后台/锁屏触发 pagehide，加载器把自己整段拆掉，
 * 但悬浮球属于运行时、不会跟着死——球还在、能拖，点上去却毫无反应；bfcache 恢复时
 * 脚本不会重新执行，也不会自愈。同时 `window.EyonHistoryWorkbenchShell` 全仓没有
 * 任何地方删除，残留的"死壳"会挡住重新挂载路径。
 * 因此三个加载器都必须满足：只有真正离开才销毁、bfcache 回来自检重挂、销毁时清全局。
 */
for (const [label, path] of [
  ['测试加载器', testLoaderPath],
  ['自动更新加载器', autoLoaderPath],
] as const) {
  test(`${label}：pagehide 只在真正离开时销毁，bfcache 回来自愈，且销毁清掉外壳全局`, async () => {
    const source = await readFile(path, 'utf8');
    assert.match(source, /pagehide/u, '必须监听 pagehide');
    assert.match(source, /pageshow/u, '必须监听 pageshow（bfcache 恢复自检）');
    assert.match(source, /event\.persisted/u, '必须以 persisted 区分"真正离开"与"进 bfcache"');
    assert.match(source, /delete hostWindow\.EyonHistoryWorkbenchShell/u, '销毁时必须清掉外壳全局，避免死壳挡住重载');
    // 旧写法：无条件 dispose + { once: true }，会导致 bfcache 恢复后永久死球。
    assert.doesNotMatch(
      source,
      /addEventListener\('pagehide', (?:dispose|state\.dispose), \{ once: true \}\)/u,
      'pagehide 不得无条件一次性销毁',
    );
  });
}

test('悬浮球：找不到外壳时广播 :open 让活着的加载器重挂，并给出可见反馈', async () => {
  const companion = await readFile(resolve(root, 'src/ui/hostStatusToast.ts'), 'utf8');
  assert.match(companion, /collectHostFrames/u, '必须沿 frame 树查找宿主层');
  assert.match(companion, /WORKBENCH_OPEN_EVENT/u, '必须派发 :open');
  assert.match(companion, /workbench_open_failed/u, '找不到外壳时要在屏幕上给出可截图提示');
  assert.match(companion, /showTapFeedback/u, '点击必须给可见反馈，不能静默');
});

for (const path of [testLoaderPath, autoLoaderPath, resolve(root, 'extension/index.js')]) {
  test(`${path.split(/[\\/]/u).at(-1)}：弹层用动态视口尺寸，不能依赖宿主 html 的百分比高度`, async () => {
    const source = await readFile(path, 'utf8');
    const overlay = source.match(/\[data-eyon-history-overlay\]\s*\{([^}]+)\}/u)?.[1] ?? '';
    assert.match(overlay, /width:\s*100vw;\s*width:\s*100dvw;/u);
    assert.match(overlay, /height:\s*100vh;\s*height:\s*100dvh;/u);
    assert.doesNotMatch(overlay, /(?:width|height):\s*100%;/u);
    assert.doesNotMatch(source, /(?:html|body)\s*\{[^}]*transform:\s*none/u, '不可重写酒馆宿主全局样式');
  });
}

test('宗族关联开关嵌入参考人物标题，样式隔离于普通输入框并保留绑定', async () => {
  const source = await readFile(resolve(root, 'src/ui/ruinWorkbench.ts'), 'utf8');
  const css = await readFile(resolve(root, 'src/ui/ruinWorkbench.css'), 'utf8');
  assert.match(source, /reference-field-heading[\s\S]*?重点参考人物[\s\S]*?role="switch"[\s\S]*?data-auto-genealogy/u);
  assert.match(source, /aria-label="自动关联宗族人物"/u);
  assert.equal(source.match(/data-auto-genealogy \$/gu)?.length, 1);
  assert.match(css, /\.field \.genealogy-policy-toggle > input\[type="checkbox"\]\s*\{[\s\S]*?width: 32px;[\s\S]*?height: 20px;/u);
  assert.match(css, /\.genealogy-policy-toggle\s*\{[\s\S]*?min-height: 44px;/u);
  assert.match(css, /input:focus-visible \+ \.genealogy-policy-track/u);
});
