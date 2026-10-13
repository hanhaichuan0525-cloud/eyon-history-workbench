import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { WorkbenchSettingsSchema } from '../src/runtime/workbenchSettings.ts';
import { COURT_FONT_OPTIONS, COURT_FONT_STACKS, courtReadingSize } from '../src/ui/courtTypography.ts';

test('界面默认固定旧字体，正文默认 14px 霞鹜臻楷；旧备份与 API 配置不变', () => {
  const next = WorkbenchSettingsSchema.parse({});
  assert.equal(next.appearance.uiFont, 'mixed');
  assert.equal(next.appearance.proseFont, 'zhenkai');
  assert.equal(next.appearance.readingSize, 14);
  const old = WorkbenchSettingsSchema.parse({ appearance: { mode: 'dark', accent: 'gold', text: 'warm' } });
  assert.deepEqual(old.appearance, { mode: 'dark', accent: 'gold', text: 'warm' });
  assert.deepEqual(old.generation, next.generation);
  assert.match(COURT_FONT_STACKS.mixed, /Microsoft YaHei/);
  assert.equal(courtReadingSize(old.appearance), 14);
});
test('旧自动 18px 默认缩小，新手动 18px 选择保留，不反复迁移', () => {
  const base = WorkbenchSettingsSchema.parse({}).appearance;
  assert.equal(courtReadingSize({ ...base, readingSize: 18, readingSizeVersion: undefined }), 14);
  assert.equal(courtReadingSize({ ...base, readingSize: 18 }), 18);
  assert.equal(courtReadingSize({ ...base, readingSize: 16, readingSizeVersion: undefined }), 16);
  assert.equal(courtReadingSize({ ...base, readingSize: 20, readingSizeVersion: undefined }), 20);
});
test('界面字体选择退役；行动、证据、历史演变使用同一正文规则', () => {
  const ui = readFileSync(new URL('../src/ui/settingsWorkbench.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/courtModule.css', import.meta.url), 'utf8');
  const appearance = readFileSync(new URL('../src/ui/appearance.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(ui, /data-court-font="uiFont"/);
  assert.match(ui, /data-court-font="proseFont"/);
  assert.match(css, /\.dossier-conclusion p, \.dossier-evidence-grid p, \.dossier-evidence-grid ul/);
  assert.match(appearance, /setProperty\('--font-ui', COURT_FONT_STACKS.mixed\)/);
});
test('独立字体选择与字号合法，坏字段不会成为 CSS 文本', () => {
  const selected = { mode: 'dark', accent: 'gold', text: 'warm', uiFont: 'sans', proseFont: 'song', readingSize: 20 };
  assert.deepEqual(WorkbenchSettingsSchema.parse({ appearance: selected }).appearance, selected);
  assert.equal(WorkbenchSettingsSchema.safeParse({ appearance: { ...selected, uiFont: 'url(fake)' } }).success, false);
  assert.equal(WorkbenchSettingsSchema.safeParse({ appearance: { ...selected, readingSize: 200 } }).success, false);
  assert.equal(COURT_FONT_OPTIONS.length, 5);
});
function fontRuntime() {
  const source = readFileSync(new URL('../src/ui/courtAssets.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const registered = new Set<any>(), faces: any[] = [];
  class Face {
    family: string;
    constructor(family: string) { this.family = family; faces.push(this); }
    load() { return Promise.resolve(this); }
  }
  const exports = {};
  runInNewContext(code, { exports, require: () => ({ default: 'data:fixture' }), WeakMap });
  const owner = { defaultView: { FontFace: Face }, fonts: registered };
  return { acquire: (exports as any).acquireCourtFonts, owner, faces, registered };
}
test('字体注册按所属 document 引用计数，重复卸载不删除新实例字体', () => {
  const { acquire, owner, faces, registered } = fontRuntime();
  const first = acquire(owner), second = acquire(owner);
  assert.equal(faces.length, 2); assert.equal(registered.size, 2);
  first(); first(); assert.equal(registered.size, 2);
  second(); assert.equal(registered.size, 0);
  const third = acquire(owner); assert.equal(faces.length, 4);
  second(); assert.equal(registered.size, 2);
  third(); assert.equal(registered.size, 0);
});
test('不支持字体 API 的 WebView 使用系统回退，不抛出挂载错误', () => {
  const { acquire } = fontRuntime();
  assert.doesNotThrow(() => acquire({ defaultView: {}, fonts: undefined })());
  assert.doesNotThrow(() => acquire({ defaultView: { FontFace: class {} }, fonts: {} })());
});
