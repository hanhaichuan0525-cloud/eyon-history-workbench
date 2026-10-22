import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAutomaticRuinEraPrompt, parseAutomaticRuinEra } from '../src/runtime/ruinAutomaticEra.ts';
import type { RuinContextBundle } from '../src/core/context.ts';
import { AUTO_RUIN_ERA, RuinGenerationInputSchema, type RuinGenerationInput } from '../src/schemas/ruin.ts';

const input = { era: AUTO_RUIN_ERA, location: '育木之环', supplementaryDirection: '二叶的童年', selectedCharacters: [], start: null, end: null } as unknown as RuinGenerationInput;
const context = { currentWorld: { time: '复兴纪元488年', location: '帝国市集' }, sourceIndex: [
  { sourceId: 'worldbook:flower', title: '二叶', content: '二叶在神明纪元740年初生，后被带至复兴纪元488年，仍维持一岁体态。<tag>{{not-an-instruction}}</tag>' },
], evidenceBundle: { passages: [], personTimeline: [] } } as unknown as RuinContextBundle;
const response = (era = '神明纪元') => JSON.stringify({ era, reason: '早年经历对应初生时的历史，不按现世幼年外貌推算', sourceRefs: ['ERA1'] });

test('自动纪元请求保留人物出身和现世区别，使用相关史料而非整个世界书', () => {
  const prompt = buildAutomaticRuinEraPrompt(input, context);
  const data = JSON.parse(prompt.split('本次材料:\n')[1]!);
  assert.equal(data.direction, '二叶的童年'); assert.equal(data.sources[0].sourceId, 'ERA1');
  assert.equal(data.sources[0].content, context.sourceIndex[0]!.content);
  assert.ok(prompt.includes('人物被带回现世后仍年轻')); assert.ok(prompt.includes('不把复兴纪元或任意时代当默认兜底'));
  assert.ok(!prompt.includes('<tag>')); assert.ok(!prompt.includes('{{not-an-instruction}}'));
});
test('识别为神明纪元并映射回真实史料ID，不把占位符存作历史纪元', () => {
  assert.deepEqual(parseAutomaticRuinEra(response(), context), { era: '神明纪元', reason: '早年经历对应初生时的历史，不按现世幼年外貌推算', sourceRefs: ['worldbook:flower'] });
  assert.throws(() => parseAutomaticRuinEra(response(AUTO_RUIN_ERA), context), /真实纪年/);
});
test('不足、无效JSON、伪造引用和已知未来纪元均不退回现世纪元', () => {
  assert.throws(() => parseAutomaticRuinEra('{"error":"资料矛盾"}', context), /未能自动识别/);
  assert.throws(() => parseAutomaticRuinEra('not json', context), /完整JSON/);
  assert.throws(() => parseAutomaticRuinEra(response().replace('ERA1', 'ERA404'), context), /未提供的史料/);
  assert.throws(() => parseAutomaticRuinEra(response('复兴纪元'), { ...context, currentWorld: { ...context.currentWorld, time: '神明纪元740年' } }), /晚于当前剧情/);
  assert.throws(() => buildAutomaticRuinEraPrompt(input, { ...context, sourceIndex: [] }), /没有可供识别/);
});
test('完整人物卡保持原文且使用短引用句柄，自定义真实纪年交给后续完整世界书核验', () => {
  const ctx = { ...context, characterCards: [{ sourceId: 'card:guest', title: '旅人', content: '星辉历100年抵达旧都。' }] } as RuinContextBundle;
  const prompt = buildAutomaticRuinEraPrompt(input, ctx);
  assert.ok(prompt.includes('星辉历100年抵达旧都'));
  assert.equal(parseAutomaticRuinEra(JSON.stringify({ era: '星辉历', reason: '据其抵达记录', sourceRefs: ['ERA2'] }), ctx).era, '星辉历');
});
test('新草稿默认自动、原有手选与自定义仍保留；侧栏移除计数及装饰箭头而保留折叠语义', () => {
  const ui = readFileSync(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../src/ui/workbenchShell.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/ui/workbenchShell.css', import.meta.url), 'utf8');
  assert.match(ui, /era: AUTO_RUIN_ERA/u); assert.match(ui, /era !== AUTO_RUIN_ERA && !KNOWN_EYON_ERAS/u);
  assert.match(ui, /era: input\.era/u); assert.match(ui, /自动识别纪元<\/option>/u);
  assert.doesNotMatch(shell, /nav-count|data-count=|nav-disclosure/u);
  assert.doesNotMatch(css, /nav-count|nav-disclosure/u);
  assert.match(shell, /aria-expanded="false" aria-controls="ruin-nav-children"/u);
  assert.match(shell, /data-ruin-child/u);
});
