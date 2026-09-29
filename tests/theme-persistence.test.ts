import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const THEMED_WORKBENCHES = [
  'genealogyWorkbench.ts',
  'ruinWorkbench.ts',
  'biographyWorkbench.ts',
  'timelineWorkbench.ts',
];

test('异步工作台重绘使用当前主题，不回退到初始化主题', async () => {
  for (const filename of THEMED_WORKBENCHES) {
    const source = await readFile(
      new URL(`../src/ui/${filename}`, import.meta.url),
      'utf8',
    );

    assert.match(source, /let theme = options\.theme \?\? 'light';/);
    assert.match(source, /theme = nextTheme;/);
    assert.match(
      source,
      /setAppearance\(appearance\)[\s\S]*?setAttribute\('data-theme', appearance\.mode\)/,
    );
    assert.doesNotMatch(source, /data-theme="\$\{options\.theme \?\? 'dark'\}"/);
  }
});
