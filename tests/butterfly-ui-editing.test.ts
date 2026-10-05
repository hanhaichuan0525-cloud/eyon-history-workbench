import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as creative from '../src/core/creativeReferences.ts';
import * as presentation from '../src/ui/butterflyReferencePresentation.ts';
import { ViewRefreshGuard } from '../src/ui/viewRefresh.ts';

class Control extends EventTarget {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  value = ''; textContent = ''; disabled = false; hidden = false;
  constructor(raw: string) {
    super();
    for (const match of raw.matchAll(/([\w-]+)="([^"]*)"/gu)) {
      this.attributes.set(match[1], match[2]);
      if (match[1].startsWith('data-')) this.dataset[match[1].slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = match[2];
    }
    for (const match of raw.matchAll(/\b(data-[\w-]+)(?=\s|$)/gu)) this.attributes.set(match[1], '');
    this.value = this.attributes.get('value') ?? '';
  }
  matches(selector: string): boolean {
    return selector.split(',').some(item => item.trim().startsWith('.')
      ? this.attributes.get('class')?.split(' ').includes(item.trim().slice(1))
      : this.attributes.has(item.trim().slice(1, -1)));
  }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
}
class Root extends EventTarget {
  elements: Control[] = []; activeElement: Control | null = null; paints = 0; html = '';
  set innerHTML(value: string) {
    this.paints++; this.html = value;
    this.elements = [...value.matchAll(/<(?:button|input|select|span|p|output)\b([^>]*)>/gu)].map(match => new Control(match[1]));
  }
  querySelectorAll(selector: string) { return this.elements.filter(element => element.matches(selector)); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
function harness() {
  const root = new Root();
  let saved = { runId: 'run', confirmed: false, references: { ...creative.DEFAULT_BUTTERFLY_REFERENCES } };
  let onData: (detail: any) => void = () => {};
  const writes: typeof saved[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let timerId = 0;
  const facade = {
    getRuinRuntimeSnapshot: async () => ({ flowState: 'exploring', runId: 'run' }),
    getButterflyReferences: async () => structuredClone(saved), listButterflyPending: async () => [],
    setButterflyReferences: async (runId: string, references: typeof saved.references, confirmed: boolean) => {
      saved = { runId, references: { ...references }, confirmed }; writes.push(structuredClone(saved));
      onData({ views: ['ruin'], reason: 'butterfly-references' });
    },
  };
  const client = { contextRevision: () => 0, isReady: () => true, facade: () => facade,
    onContextChanged: () => () => {}, onStatus: () => () => {},
    onDataChanged: (fn: typeof onData) => { onData = fn; return () => {}; },
  };
  const source = readFileSync(new URL('../src/ui/butterflyWorkbench.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { mountButterflyWorkbench?: Function } = {};
  const dependencies: Record<string, unknown> = {
    './workbenchClient.ts': {}, './appearance.ts': {},
    './viewRefresh.ts': { ViewRefreshGuard, preserveDomState: () => () => {} },
    '../core/creativeReferences.ts': creative,
    './butterflyReferencePresentation.ts': presentation,
    './ruinWorkbench.css?raw': { default: '' }, './creativeWorkbench.css?raw': { default: '' },
  };
  runInNewContext(compiled, { exports, require: (id: string) => dependencies[id],
    document: { createElement: () => ({ attachShadow: () => root, remove() {} }) },
    setTimeout: (fn: () => void, ms: number) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const handle = exports.mountButterflyWorkbench!({ append() {} }, client);
  return { root, handle, writes,
    tick(ms: number) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
  };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test('实际关注对象：自动保存和资料刷新不替换输入节点，连续中文值完整保存', async () => {
  const h = harness(); await h.handle.refresh();
  const input = h.root.querySelector('[data-focus]')!; h.root.activeElement = input;
  const paints = h.root.paints;
  for (const value of ['二叶', '二叶和后代', '二叶和后代的生活']) {
    input.value = value; input.dispatchEvent(new Event('input')); h.tick(500); await flush();
    assert.equal(h.root.querySelector('[data-focus]'), input);
    assert.equal(h.writes.at(-1)?.references.focus, value);
  }
  assert.equal(h.root.paints, paints);
  assert.equal(h.root.querySelector('[data-return]')!.disabled, true);
  h.root.activeElement = h.root.querySelector('[data-confirm]');
  h.root.activeElement!.dispatchEvent(new Event('click')); await flush();
  assert.equal(h.writes.at(-1)?.confirmed, true);
  assert.equal(h.root.querySelector('[data-return]')!.disabled, false);
  h.handle.dispose();
});

test('实际中文组字期间不保存、不重绘；最终输入完成后保存整句而非拼音', async () => {
  const h = harness(); await h.handle.refresh();
  const input = h.root.querySelector('[data-focus]')!; h.root.activeElement = input;
  const paints = h.root.paints;
  input.value = '旧草稿'; input.dispatchEvent(new Event('input'));
  h.root.dispatchEvent(new Event('compositionstart'));
  input.value = 'erye'; input.dispatchEvent(new Event('input')); h.tick(500); await flush();
  await h.handle.refresh();
  assert.equal(h.writes.length, 0); assert.equal(h.root.paints, paints);
  input.value = '二叶和珊奈'; h.root.dispatchEvent(new Event('compositionend'));
  input.dispatchEvent(new Event('input')); h.tick(0); h.tick(500); await flush();
  assert.equal(h.writes.at(-1)?.references.focus, '二叶和珊奈');
  assert.equal(h.root.querySelector('[data-focus]'), input);
  assert.equal(h.root.paints, paints);
  h.handle.dispose();
});

test('底部两句提示响应选项、预设和离奇度，不重建正在拖动的滑块', async () => {
  const h = harness(); await h.handle.refresh();
  const initial = h.root.querySelector('[data-style-preview]')!.textContent;
  const domain = h.root.querySelectorAll('[data-reference]').find(item => item.dataset.reference === 'domain')!;
  assert.match(h.root.html, /value="知识与技术"[^>]*>知识技术<\/option>/u);
  domain.value = '知识与技术'; domain.dispatchEvent(new Event('change')); await flush();
  assert.ok(h.root.querySelector('[data-style-preview]')!.textContent.includes('知识的实际用途'));
  assert.equal(h.writes.at(-1)?.references.domain, '知识与技术');
  const slider = h.root.querySelector('[data-absurdity]')!; h.root.activeElement = slider;
  const paints = h.root.paints, writes = h.writes.length;
  slider.value = '95'; slider.dispatchEvent(new Event('input'));
  assert.equal(h.root.querySelector('[data-absurdity]'), slider); assert.equal(h.root.paints, paints);
  assert.equal(h.writes.length, writes);
  assert.ok(h.root.querySelector('[data-style-preview]')!.textContent.includes('离奇但可追溯'));
  slider.dispatchEvent(new Event('change')); await flush();
  assert.equal(h.writes.at(-1)?.references.absurdity, 95);
  const preset = h.root.querySelectorAll('[data-preset]').find(item => item.dataset.preset === '2')!;
  h.root.activeElement = preset; preset.dispatchEvent(new Event('click')); await flush();
  assert.equal(h.root.querySelector('[data-style-preview]')!.textContent,
    presentation.butterflyStylePreview(creative.BUTTERFLY_PRESETS[2].references));
  assert.notEqual(h.root.querySelector('[data-style-preview]')!.textContent, initial);
  h.root.querySelector('[data-random]')!.dispatchEvent(new Event('click')); await flush();
  assert.equal(h.root.querySelector('[data-style-preview]')!.textContent, presentation.butterflyStylePreview(h.writes.at(-1)!.references));
  assert.ok(h.root.html.indexOf('data-style-preview') > h.root.html.indexOf('data-return'));
  h.handle.dispose();
});

test('三组有独立语义卡片且各三项，主题圆角与窄屏重排不改变控件协议', async () => {
  const h = harness(); await h.handle.refresh();
  const sections = [...h.root.html.matchAll(/<section class="reference-group ([^"]+)" aria-label="([^"]+)">([\s\S]*?)<\/section>/gu)];
  assert.deepEqual(sections.map(match => match[2]), ['影响重点', '历史发展', '阅读体验']);
  for (const section of sections) assert.equal(section[3].match(/<label class="field">/gu)?.length, 3);
  assert.match(sections[2][3], /data-reference="legend"/u);
  const css = readFileSync(new URL('../src/ui/creativeWorkbench.css', import.meta.url), 'utf8');
  assert.match(css, /\.reference-group \{[^}]*border-radius:var\(--archive-radius-panel/u);
  assert.match(css, /\.reference-group--history \{ --reference-accent:var\(--gold\)/u);
  assert.match(css, /@media\(max-width:580px\)[\s\S]*\.reference-group--experience \{ grid-template-columns:1fr/u);
  h.handle.dispose();
});

test('中文组字不更新提示或重绘，最终文本完整保存，长输入不膨胀提示或作为HTML执行', async () => {
  const h = harness(); await h.handle.refresh();
  const input = h.root.querySelector('[data-focus]')!; h.root.activeElement = input;
  const initial = h.root.querySelector('[data-style-preview]')!.textContent;
  h.root.dispatchEvent(new Event('compositionstart'));
  input.value = 'erye'; input.dispatchEvent(new Event('input'));
  assert.equal(h.root.querySelector('[data-style-preview]')!.textContent, initial);
  input.value = '二叶'.repeat(2000) + '<img src=x onerror=alert(1)>';
  h.root.dispatchEvent(new Event('compositionend')); input.dispatchEvent(new Event('input'));
  h.tick(0); h.tick(500); await flush();
  assert.equal(h.root.querySelector('[data-focus]'), input);
  assert.equal(h.writes.at(-1)?.references.focus, input.value);
  const preview = h.root.querySelector('[data-style-preview]')!.textContent;
  assert.ok(preview.includes('围绕重点对象')); assert.ok(preview.length <= 120);
  assert.equal(preview.match(/。/gu)?.length, 2);
  h.root.activeElement = h.root.querySelector('[data-confirm]');
  h.root.activeElement!.dispatchEvent(new Event('click')); await flush();
  assert.match(h.root.html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(h.root.html, /<img src=x/u);
  h.handle.dispose();
});
