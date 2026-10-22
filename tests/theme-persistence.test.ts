import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const THEMED_WORKBENCHES = [
  'genealogyWorkbench.ts',
  'ruinWorkbench.ts',
  'biographyWorkbench.ts',
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

test('新版历史长河在重绘、切主题与阅读弹层中共用当前appearance', async () => {
  const source = await readFile(new URL('../src/ui/timelineWorkbench.ts', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('timeline.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let setter = '';
  const walk = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'setAppearance') setter = node.getText(tree); ts.forEachChild(node, walk); };
  walk(tree);
  assert.ok(setter);
  const main = { dataset: { theme: 'light' } }, reader = { dataset: { theme: 'light' } };
  const applied: unknown[] = [];
  const context: any = { exports: {}, main, reader, host: {}, applyAppearance: (_host: unknown, next: unknown) => applied.push(next) };
  runInNewContext(ts.transpileModule(`let appearance={mode:'light'}; ${setter}; export {setAppearance}; export const current=()=>appearance;`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  for (const mode of ['dark', 'light', 'dark']) {
    const next = { mode, proseFont: 'zhenkai' };
    context.exports.setAppearance(next);
    assert.equal(context.exports.current(), next);
    assert.equal(main.dataset.theme, mode);
    assert.equal(reader.dataset.theme, mode);
    assert.equal(applied.at(-1), next);
  }
  assert.match(source, /function render\(\)[\s\S]*?main\.dataset\.theme = appearance\.mode;/u);
  assert.match(source, /setTheme\(mode\) \{ setAppearance\(\{ \.\.\.appearance, mode \}\); \}/u);
  assert.doesNotMatch(source, /data-theme="\$\{options\.theme/u);
});
