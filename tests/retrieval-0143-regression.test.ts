import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuinContextBundle } from '../src/core/context.ts';
import type { RuinGenerationInput } from '../src/schemas/ruin.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { resolveAutomaticRuinRange } from '../src/runtime/ruinAutomaticRange.ts';
import { buildRuinOutlineBatchApiPrompt, buildCompactRuinExpansionRecoveryPrompt } from '../src/prompts/ruin.ts';

function input(): RuinGenerationInput {
  return { era: '复兴纪元', start: null, end: null, location: '测试港',
    supplementaryDirection: '探讨测试少女姐姐遇害当晚的事件', selectedCharacters: [],
    autoGenealogy: false, wave: { level: 'stable', candidateCount: 3 },
    materials: Array.from({ length: 3 }, (_, index) => ({ candidateKey: `candidate-${index + 1}`,
      periodType: 'transition', background: '地方日常', conflict: '未知动机', trigger: '事发当晚' })) };
}

async function context(): Promise<RuinContextBundle> {
  const entries = [
    ['main', '[角色][测试少女]测试少女', '<测试少女 角色详情>\n生日: 复兴纪元470年7月15日(18岁)\n' + '完整背景。'.repeat(4500) + '\n主档末尾保留\n</测试少女 角色详情>'],
    ['habits', '[角色][测试少女]习惯补充', '<测试少女 角色详情>\n睡眠习惯: 留灯(对应经历: 测试少女8岁生日当晚20:00，姐姐遇害。)\n敬畏习惯: 不惧强者(对应经历: 测试少女10岁时哥哥遇难。)\n</测试少女 角色详情>'],
    ['company', '[角色][测试少女]潮汐工坊', '<测试少女 角色详情>\n# 潮汐工坊\n总部: 无固定总部\n成员: 测试少女\n工坊末尾保留\n</测试少女 角色详情>'],
  ];
  const snapshots = await Promise.all(entries.map(([id, title, content]) => createSourceSnapshot({
    logicalId: `worldbook:fixture:${id}`, sourceType: 'worldbook', title: title!, content: content!, metadata: {},
  })));
  const result = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({ requestId: 'fixture-0143',
    taskType: 'ruin', mode: 'active', query: '复兴纪元 测试港 测试少女姐姐遇害当晚',
    baselineWorldTime: '复兴纪元488年3月1日' });
  return { schema: 'eyon.context.v1', taskType: 'ruin', requestId: 'fixture-0143',
    scope: { characterKey: 'fixture', chatId: 'fixture', triggerMessageId: 1 },
    currentWorld: { time: '复兴纪元488年3月1日', location: '测试港' },
    evidenceBundle: result.bundle, worldbookContext: [], recentContext: [], characterContext: [],
    genealogyRefs: [], biographyRefs: [], butterflyRefs: [],
    // 模拟无关旧产物年份挤占了 sourceIndex：不能据其中位数排除生日事件。
    sourceIndex: [475, 481, 485, 487, 488].map(year => ({ sourceId: `old:${year}`,
      sourceType: 'biography', title: '无关史稿', content: `复兴纪元${year}年，另一地点。`, authority: 70 })),
    actorPolicy: { autoGenealogy: false, requestedSubjects: [], referenceNames: ['测试少女'],
      genealogyActors: [], blockedGenealogy: [], unresolvedRelatives: [] },
    warnings: [], sourceHash: 'fixture' };
}

test('0.14.3: 亲属定语中的资料参照不升级为演员，但自动包络不排除已知往事', async () => {
  const ctx = await context();
  const before = structuredClone(ctx.actorPolicy);
  const request = input();
  const resolved = resolveAutomaticRuinRange(request, ctx, [request.supplementaryDirection]);
  assert.equal(resolved.automatic, true);
  assert.deepEqual(resolved.input.start, { year: 40, month: 1, day: 1 });
  assert.deepEqual(resolved.input.end, { year: 488, month: 3, day: 1 });
  assert.ok(resolved.input.start!.year! <= 478 && resolved.input.end!.year! >= 478);
  assert.deepEqual(ctx.actorPolicy, before);
  assert.equal(request.start, null);
});

test('0.14.3: 父辈历史不被子女出生年截断，手填范围保持原值', async () => {
  const ctx = await context();
  const request = input();
  request.supplementaryDirection = '探讨测试少女父亲的青年发家史';
  const resolved = resolveAutomaticRuinRange(request, ctx);
  assert.ok(resolved.input.start!.year! < 470);
  request.start = { year: 480, month: 1, day: 1 };
  request.end = { year: 482, month: 12, day: 31 };
  assert.deepEqual(resolveAutomaticRuinRange(request, ctx), { input: request, automatic: false });
});

test('0.14.3: 直接人物的生涯包络包含出生年年初，保留原有生年约束', async () => {
  const ctx = await context();
  ctx.actorPolicy!.requestedSubjects = ['测试少女'];
  const resolved = resolveAutomaticRuinRange(input(), ctx);
  assert.deepEqual(resolved.input.start, { year: 470, month: 1, day: 1 });
  assert.equal(resolved.input.end!.year, 488);
});

test('0.14.3: 模型沿用原字段，生日/相邻经历完整投递，不再要求同事件错开日期', async () => {
  const ctx = await context();
  const resolved = resolveAutomaticRuinRange(input(), ctx);
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId: 'fixture-0143', directive: '墟境探索',
    context: ctx, generationInput: resolved.input, automaticTimeRange: true, rules: { generationContract: '' } });
  for (const attachment of ctx.evidenceBundle.taskAnchorAttachments!) assert.ok(prompt.includes(attachment.content));
  assert.match(prompt, /470年7月15日/u);
  assert.match(prompt, /8岁生日当晚20:00/u);
  assert.match(prompt, /10岁时哥哥遇难/u);
  assert.match(prompt, /may share the same span and central date/u);
  assert.match(prompt, /same calendar day at successive hours/u);
  assert.match(prompt, /Cast identity, summaries and node times must agree/u);
  assert.doesNotMatch(prompt, /exact, distinct span|Node dates must be explicit, distinct/u);
});

test('0.14.3: 同一个附件因简称/全名重复命中只投递一次，完整内容不裁尾', async () => {
  const ctx = await context();
  const request = input();
  request.selectedCharacters = [{ mvuId: 'fixture', name: '测试少女', source: 'mvu', identities: [],
    race: '', professions: [], relations: [], lifespan: '', contextSummary: '' }];
  const prompt = buildRuinOutlineBatchApiPrompt({ requestId: 'fixture-0143', directive: '墟境探索',
    context: ctx, generationInput: request, rules: { generationContract: '' } });
  const full = prompt.split('<CHARACTER_CARDS_FULL>')[1]!.split('</CHARACTER_CARDS_FULL>')[0]!;
  assert.equal(full.split('主档末尾保留').length - 1, 1);
  assert.equal(full.split('工坊末尾保留').length - 1, 1);
});

test('0.14.3: 精简恢复只缩减输出，完整人物与舞台原文不丢失', async () => {
  const ctx = await context();
  const reference = buildRuinOutlineBatchApiPrompt({ requestId: 'fixture-0143', directive: '墟境探索',
    context: ctx, generationInput: input(), rules: { generationContract: '' } });
  const original = '<RUIN_SELECTED_CANDIDATE_EXPANSION>\n'
    + '\nCopy these fixed fields exactly: {"schema":"eyon.ruin.expansion.v1","requestId":"fixture-0143","candidateKey":"candidate-1"}'
    + '\n' + reference
    + '\n<SELECTED_OUTLINE_READ_ONLY>{"title":"冻结事件"}</SELECTED_OUTLINE_READ_ONLY>';
  const recovered = buildCompactRuinExpansionRecoveryPrompt(original)!;
  for (const attachment of ctx.evidenceBundle.taskAnchorAttachments!) assert.ok(recovered.includes(attachment.content));
  for (const tag of ['CHARACTER_CARDS_FULL', 'HISTORICAL_AUTHORITY_READ_ONLY', 'REFERENCE_DATA_READ_ONLY']) {
    const content = reference.split(`<${tag}>`)[1]!.split(`</${tag}>`)[0]!.trim();
    assert.ok(recovered.includes(content));
  }
  assert.match(recovered, /candidate contains exactly one field: historyProse/u);
});
