import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as creativeReferences from '../src/core/creativeReferences.ts';
import * as ruinPanelAccess from '../src/core/ruinPanelAccess.ts';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { selectAddedRuinReferences } from '../src/ui/ruinReferenceSelection.ts';
import { ruinCharacterReferenceIdentity } from '../src/storage/ruinReferences.ts';
import type { RuinSelectedCharacter } from '../src/storage/ruinReferences.ts';
import { createRuinMaterialsFromRules, waveForCandidateCount } from '../src/runtime/ruinDiceCore.ts';
import { isTaskBusy } from '../src/runtime/taskStatus.ts';
import { ViewRefreshGuard, preserveDomState } from '../src/ui/viewRefresh.ts';

const person = (id: string): RuinSelectedCharacter => ({
  mvuId: id, referenceId: id, name: id, source: 'genealogy', race: '人类',
  identities: ['父亲'], lifespan: '不详', professions: [], relations: [], contextSummary: '',
});

test('手动加入的墟境人物默认启用，不勾回已有但关闭的人物', () => {
  const old = person('旧引用');
  const added = person('塞缪尔·克罗');
  const selected = new Set<string>();
  selectAddedRuinReferences([old], [old, added], selected);
  assert.deepEqual([...selected], [added.referenceId]);
  selectAddedRuinReferences([old, added], [old, added], selected);
  assert.deepEqual([...selected], [added.referenceId], '重复广播及重建谱系不打开旧引用');
});

test('玩家取消勾选、新建任务、移除及重新加入分别保留正确选择', () => {
  const reference = person('手选人物');
  const selected = new Set<string>();
  selectAddedRuinReferences([], [reference], selected);
  assert.ok(selected.has(reference.mvuId));
  selected.delete(reference.mvuId);
  selectAddedRuinReferences([reference], [reference], selected);
  assert.equal(selected.size, 0, '取消后同一引用广播不恢复');
  selected.add(reference.mvuId);
  selected.clear();
  selectAddedRuinReferences([reference], [reference], selected);
  assert.equal(selected.size, 0, '新建任务清空后不恢复旧勾选');
  selected.add(reference.mvuId);
  selectAddedRuinReferences([reference], [], selected);
  assert.equal(selected.size, 0, '删除引用同时清理选择');
  selectAddedRuinReferences([], [reference], selected);
  assert.ok(selected.has(reference.mvuId), '再次明确加入恢复启用');
});

test('只有人物引用变化应用默认启用，普通刷新与自动关联宗族独立', () => {
  const source = readFileSync(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8');
  assert.match(source, /onRuinReferences\(references => \{[\s\S]*?selectAddedRuinReferences\(state\.characters, references, state\.selectedCharacterIds\)/u);
  const refresh = source.slice(source.indexOf('async function refresh()'), source.indexOf('async function refreshRuntime()'));
  assert.doesNotMatch(refresh, /selectAddedRuinReferences/u, '读取候选池不等于玩家明确添加');
  assert.match(source, /autoGenealogy: false/u);
  assert.match(source, /selectedCharacters: state\.characters\.filter\(character =>\s*state\.selectedCharacterIds\.has/u);
});

test('实际UI事件、按钮与生成输入一致；关闭后刷新、新建任务均不勾回', async () => {
  class Button extends EventTarget {
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    constructor(raw: string) {
      super();
      for (const match of raw.matchAll(/([\w-]+)="([^"]*)"/gu)) {
        this.attributes.set(match[1], match[2]);
        if (match[1].startsWith('data-')) this.dataset[match[1].slice(5).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = match[2];
      }
      for (const match of raw.matchAll(/\b(data-[\w-]+)(?=\s|$)/gu)) this.attributes.set(match[1], '');
    }
    getAttribute(key: string) { return this.attributes.get(key); }
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  }
  class Root extends EventTarget {
    buttons: Button[] = [];
    html = '';
    set innerHTML(value: string) { this.html = value; this.buttons = [...value.matchAll(/<button\b([^>]*)>/gu)].map(match => new Button(match[1])); }
    querySelectorAll(selector: string) { return this.buttons.filter(button => button.attributes.has(selector.slice(1, -1))); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const root = new Root();
  const host = { attachShadow: () => root };
  const rules = readFileSync(new URL('../rules/08_伊雍骰子判定表-脚本数据.txt', import.meta.url), 'utf8');
  const materials = createRuinMaterialsFromRules(rules, 3, () => 0.5);
  let draft: import('../src/schemas/ruin.ts').RuinGenerationInput | null = {
    era: '复兴纪元', start: null, end: null, location: '港口', supplementaryDirection: '',
    autoGenealogy: false, selectedCharacters: [], wave: waveForCandidateCount(3), materials,
  };
  let pool: RuinSelectedCharacter[] = [person('已有但关闭的人物')];
  let onReferences: (references: RuinSelectedCharacter[]) => void = () => {};
  const submissions: NonNullable<typeof draft>[] = [];
  let runtime: { flowState: 'idle' | 'exploring' | 'anchored' | 'returning'; runId: string } = { flowState: 'idle', runId: '' };
  const panelChanges: string[] = [];
  const facade = {
    getSettings: () => ({ ruinDraft: draft }),
    setRuinDraft: (input: typeof draft) => { draft = input; },
    listRuins: async () => [],
    getRuinGeography: async () => [],
    generateRuin: async (input: NonNullable<typeof draft>) => { submissions.push(input); throw new Error('不调用模型'); },
  };
  const client = {
    contextRevision: () => 0, onContextChanged: () => () => {},
    isReady: () => true, facade: () => facade,
    onStatus: () => () => {}, onReady: () => () => {},
    onRuinReferences: (listener: typeof onReferences) => { onReferences = listener; return () => {}; },
    listRuinCharacterReferences: async () => pool,
    listRuinBiographyReferences: async () => [],
    getRuinRuntimeSnapshot: async () => runtime, getRuinTaskReview: async () => null,
  };
  const source = readFileSync(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { mountRuinWorkbench?: Function } = {};
  const dependencies: Record<string, unknown> = {
    '../runtime/taskStatus.ts': { isTaskBusy },
    './viewRefresh.ts': { ViewRefreshGuard, preserveDomState },
    '../runtime/ruinDice.ts': { createRuinMaterials: () => materials, waveForCandidateCount },
    '../schemas/ruin.ts': { KNOWN_EYON_ERAS: ['复兴纪元', '神明纪元'] },
    '../storage/ruins.ts': {}, '../storage/ruinReferences.ts': { ruinCharacterReferenceIdentity },
    './workbenchClient.ts': {}, './ruinReferenceSelection.ts': { selectAddedRuinReferences },
    './ruinWorkbench.css?raw': { default: '' }, './appearance.ts': {},
    './creativeWorkbench.css?raw': { default: '' },
    '../core/creativeReferences.ts': creativeReferences,
    '../core/ruinPanelAccess.ts': ruinPanelAccess,
    './butterflyWorkbench.ts': { mountButterflyWorkbench: () => ({ async refresh() {}, setAppearance() {}, dispose() {} }) },
    './scrollPan.ts': { installScrollPan: () => () => {} }, './ruinPresentation.ts': {},
  };
  runInNewContext(compiled, { exports, require: (id: string) => dependencies[id], document: { createElement: () => host } });
  const handle = exports.mountRuinWorkbench!({ replaceChildren() {} }, client, { onPanelChange: (panel: string) => panelChanges.push(panel) });
  await handle.refresh();
  handle.selectPanel('tasks'); handle.selectPanel('butterfly');
  assert.equal(panelChanges.length, 0, '未入境时程序化切页也不放行');
  const added = person('塞缪尔·克罗');
  pool = [...pool, added];
  onReferences(pool);
  const selectedButton = () => root.querySelectorAll('[data-character-id]').find(button => button.dataset.characterId === added.referenceId)!;
  assert.equal(selectedButton().getAttribute('aria-pressed'), 'true');
  assert.deepEqual(draft!.selectedCharacters.map(ruinCharacterReferenceIdentity), [added.referenceId]);
  root.querySelector('[data-generate]')!.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(submissions[0].selectedCharacters, ruinCharacterReferenceIdentity), [added.referenceId]);
  assert.equal(submissions[0].autoGenealogy, false);
  selectedButton().dispatchEvent(new Event('click'));
  assert.equal(draft!.selectedCharacters.length, 0);
  onReferences(pool);
  await handle.refresh();
  assert.equal(selectedButton().getAttribute('aria-pressed'), 'false');
  const preservedDraft = draft;
  runtime = { flowState: 'exploring', runId: '当前轮次' };
  await handle.refresh();
  assert.equal(panelChanges.at(-1), 'tasks');
  assert.equal(root.querySelector('[data-generate]'), null, '入境后生成按钮与编辑表单均不挂载');
  assert.equal(root.querySelector('[data-new-task]'), null);
  assert.match(root.html, /墟境生成已锁定/u);
  handle.selectPanel('generation');
  assert.equal(panelChanges.at(-1), 'tasks', '活动墟境不能程序化切回生成页');
  assert.equal(draft, preservedDraft, '锁定不清空草稿');
  handle.selectPanel('butterfly');
  assert.equal(panelChanges.at(-1), 'butterfly');
  runtime = { flowState: 'idle', runId: '' };
  await handle.refresh();
  assert.equal(panelChanges.at(-1), 'generation', '归返后自动回到可用的生成页');
  assert.ok(root.querySelector('[data-generate]'));
  assert.equal(draft, preservedDraft);
  selectedButton().dispatchEvent(new Event('click'));
  root.querySelector('[data-new-task]')!.dispatchEvent(new Event('click'));
  onReferences(pool);
  await handle.refresh();
  assert.equal(selectedButton().getAttribute('aria-pressed'), 'false');
  assert.equal(draft, null);
  handle.dispose();
});
