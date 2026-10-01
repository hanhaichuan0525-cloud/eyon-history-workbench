import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { characterDocumentOwner, templateIndependentText } from '../src/retrieval/sourceOwnership.ts';
import { extractRecordedAge } from '../src/retrieval/catalog.ts';
import { resolveLifespanFromBaseline } from '../src/retrieval/temporal.ts';
import type { GenealogyContextBundle } from '../src/core/context.ts';
import { buildGenealogyApiPrompt, buildGenealogyRepairPrompt } from '../src/prompts/genealogy.ts';

async function source(id: string, title: string, content: string, sourceType = 'worldbook' as const) {
  return createSourceSnapshot({ logicalId: `${sourceType}:fixture:${id}`, sourceType, title, content, metadata: {} });
}

async function fixtures() {
  return [
    await source('main', '[WS][DLC][角色][测试少女]测试少女(主档)',
      '<测试少女 角色详情>\n<%_ { const view = {}; if (view.open) { /* UI only */ } } %>\n姓名: 测试少女\n生日: 复兴纪元470年7月15日(18岁)\n</测试少女 角色详情>'),
    await source('habits', '[WS][DLC][角色][测试少女]测试少女有一个习惯',
      '<测试少女 角色详情>\n---\n睡眠习惯: 开着台灯入睡(对应经历: 测试少女8岁生日当晚20:00，姐姐遇害。)\n避险习惯: 避开危险高度(对应经历: 测试少女6岁生日当天，母亲遇害。)\n</测试少女 角色详情>'),
    await source('company', '[WS][DLC][角色][测试少女]海潮工坊',
      '<测试少女 角色详情>\n---\n# 海潮工坊\n总部: 无固定总部\n势力标识: 珊瑚\n成员: 测试少女及其分身\n</测试少女 角色详情>'),
  ];
}

test('明确人物归属的习惯条目归入本人，不被标题造出第二个人', async () => {
  const sources = await fixtures();
  const catalog = buildRetrievalIndex(sources).catalog;
  const person = catalog.entities.find(e => e.canonicalName === '测试少女')!;
  assert.ok(person.kinds.includes('person'));
  assert.ok(person.sourceSnapshotIds.includes(sources[1]!.snapshotId));
  assert.equal(catalog.entities.some(e => e.canonicalName === '测试少女有一个习惯'), false);
  assert.deepEqual(person.lifespan?.born, { era: '复兴纪元', year: 470 });
});

test('角色经营的独立组织不并入人物身份，也不当作第二个人', async () => {
  const sources = await fixtures();
  const catalog = buildRetrievalIndex(sources).catalog;
  const company = catalog.entities.find(e => e.canonicalName === '海潮工坊')!;
  assert.ok(company.kinds.includes('organization'));
  assert.ok(!company.kinds.includes('person'));
  const person = catalog.entities.find(e => e.canonicalName === '测试少女')!;
  assert.ok(!person.sourceSnapshotIds.includes(sources[2]!.snapshotId));
});

for (const taskType of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
  test(`${taskType}: 未手选但点名本人时跟读主档、习惯与组织补充完整原文`, async () => {
    const sources = await fixtures();
    const result = await new UnifiedShadowRetrievalEngine(sources).retrieve({
      requestId: `known-event-${taskType}`, taskType, mode: 'active',
      query: '复兴纪元 测试少女姐姐遇害当晚，重点放在测试少女的视角', baselineWorldTime: '复兴纪元488年3月1日',
    });
    const attachments = result.bundle.taskAnchorAttachments!.filter(a => a.canonicalName === '测试少女');
    assert.equal(attachments.length, 3);
    for (const item of sources) {
      assert.equal(attachments.find(a => a.snapshotId === item.snapshotId)?.content, item.content);
    }
    assert.match(attachments[1]!.content, /8岁生日当晚20:00/u);
    assert.equal(result.bundle.personTimeline!.find(e => e.name === '测试少女')?.lifespan?.born?.year, 470);
  });
}

test('只有姓名相似或标签/详情主人不一致，不自动归并补充条目', async () => {
  const mismatched = await source('mismatch', '[角色][测试少女]测试少女的记事', '<另一少女 角色详情>\n年龄: 21岁\n</另一少女 角色详情>');
  const mentioned = await source('mention', '[角色]其他少女', '其他少女曾与测试少女同行。');
  assert.equal(characterDocumentOwner(mismatched), undefined);
  assert.equal(characterDocumentOwner(mentioned), undefined);
  const catalog = buildRetrievalIndex([mismatched]).catalog;
  assert.equal(catalog.entities.some(e => e.canonicalName === '测试少女'), false);
});

test('EJS条件正文生日不提取，块间和模板外独立生日可用且原文不改', async () => {
  const conditional = '<% if (stage) { %>\n生日: 复兴纪元400年\n<% } else { %>\n生日: 复兴纪元430年\n<% } %>';
  assert.doesNotMatch(templateIndependentText(conditional), /400|430/u);
  const raw = `${conditional}\n生日: 复兴纪元470年7月15日`;
  const snap = await source('outside', '[角色]测试少女', raw);
  const catalog = buildRetrievalIndex([snap]).catalog;
  assert.equal(catalog.entities.find(e => e.canonicalName === '测试少女')?.lifespan?.born?.year, 470);
  assert.equal(snap.content, raw);
  const inside = buildRetrievalIndex([await source('inside', '[角色]测试少女', conditional)]).catalog;
  assert.equal(inside.entities.find(e => e.canonicalName === '测试少女')?.lifespan, undefined);
  const between = `<%_ { const ui = { label: '{示例}', note: 'if' }; if (ui) { /* view */ } } %>\n生日: 复兴纪元470年7月15日\n${conditional}`;
  const middle = buildRetrievalIndex([await source('between', '[角色]测试少女', between)]).catalog;
  assert.equal(middle.entities.find(e => e.canonicalName === '测试少女')?.lifespan?.born?.year, 470);
  const wrapped = `<%_ { const ui = {}; if (ui) { /* initialization */ } %>\n生日: 复兴纪元470年7月15日\n${conditional}\n<%_ } %>`;
  const bareScope = buildRetrievalIndex([await source('wrapped', '[角色]测试少女', wrapped)]).catalog;
  assert.equal(bareScope.entities.find(e => e.canonicalName === '测试少女')?.lifespan?.born?.year, 470);
});

test('MVU介绍中的明确实龄优先于外观年龄，恢复原有基准年换算', async () => {
  const snap = await createSourceSnapshot({ logicalId: 'mvu:fixture:age', sourceType: 'mvu', title: '测试少女',
    content: JSON.stringify({ name: '测试少女', 外貌: '外观年龄16岁、实龄18岁，身高153cm。' }), metadata: {} });
  const person = buildRetrievalIndex([snap]).catalog.entities.find(e => e.canonicalName === '测试少女')!;
  assert.equal(person.lifespan?.ageAtRecord, 18);
  assert.equal(resolveLifespanFromBaseline(person, '复兴纪元488年')?.born?.year, 470);
  assert.equal(extractRecordedAge('外观年龄16岁、实龄18岁'), 18);
  assert.equal(extractRecordedAge('外观年龄16岁'), undefined);
});

test('EJS未执行函数或循环里的字面生日也不是独立档案', async () => {
  for (const open of ['function render() {', 'const render = () => {', 'for (const x of list) {']) {
    const raw = `<% ${open} %>\n生日: 复兴纪元400年\n<% } %>`;
    const catalog = buildRetrievalIndex([await source('deferred', '[角色]测试少女', raw)]).catalog;
    assert.equal(catalog.entities.find(e => e.canonicalName === '测试少女')?.lifespan, undefined);
  }
});

test('生日只有月日、背景事件年龄或含糊实龄不会伪造生年', async () => {
  for (const content of [
    '生日: 7月15日\n背景: 八岁时搬家，复兴纪元481年见证港口重建。',
    '背景: 复兴纪元481年，实龄18岁的她探访港口。',
    '外貌: 外观年龄16岁、实龄约18岁。',
    '外貌: 外观年龄16岁。',
  ]) {
    const snap = await source('unknown', '[角色]测试少女', content);
    assert.equal(buildRetrievalIndex([snap]).catalog.entities.find(e => e.canonicalName === '测试少女')?.lifespan, undefined, content);
  }
});

for (const repair of [false, true]) {
  test(`谱系${repair ? '纠正' : '初次'}提示词整条投递中心人物主档与补充，不裁切或堆入无关人物`, async () => {
    const middle = '传承补充：前代实例是独立个体，不是亲生父亲。';
    const raw = '<测试少女 角色详情>\n生日: 复兴纪元470年7月15日\n'
      + '普通档案描述。\n'.repeat(1250) + middle + '\n'
      + '普通档案描述。\n'.repeat(1250)
      + '<% if (stage) { %>身份: 公主<% } else { %>身份: 执政官<% } %>\n主档末尾保留\n</测试少女 角色详情>';
    const entries = [await source('long', '[角色][测试少女]测试少女', raw), ...(await fixtures()).slice(1),
      await createSourceSnapshot({ logicalId: 'mvu:fixture:focus', sourceType: 'mvu', title: '测试少女',
        content: JSON.stringify({ name: '测试少女', 介绍: '补充介绍。'.repeat(1800) + 'MVU末尾保留' }), metadata: {} })];
    const result = await new UnifiedShadowRetrievalEngine(entries).retrieve({ requestId: 'genealogy-full-raw',
      taskType: 'genealogy', mode: 'active', query: '测试少女宗族谱系', baselineWorldTime: '复兴纪元488年' });
    const bundle = result.bundle;
    const first = bundle.taskAnchorAttachments![0]!;
    bundle.taskAnchorAttachments!.push(structuredClone(first), {
      ...first, attachmentId: 'attachment:unrelated', entityId: 'entity:unrelated',
      canonicalName: '无关人物', content: '无关人物完整主档不应堆入附件',
    });
    const sourceIndex = bundle.sourceSnapshots.map(snapshot => ({
      sourceId: snapshot.logicalId, sourceType: snapshot.sourceType, title: snapshot.title,
      content: bundle.passages.filter(passage => passage.snapshotId === snapshot.snapshotId)
        .map(passage => passage.content).join('\n\n'), authority: 100,
    }));
    const context: GenealogyContextBundle = {
      schema: 'eyon.context.v1', taskType: 'genealogy', requestId: 'genealogy-full-raw',
      scope: { characterKey: 'fixture', chatId: 'fixture', triggerMessageId: 1 },
      currentWorld: { time: '复兴纪元488年', location: '测试港' },
      worldbookContext: sourceIndex, recentContext: [], characterContext: [], biographyRefs: [],
      sourceIndex, evidenceBundle: bundle, warnings: [], sourceHash: 'fixture',
    };
    const before = structuredClone(context);
    const input = { requestId: context.requestId, directive: '测试少女宗族谱系', context,
      generationInput: { focusCharacter: { mvuId: 'fixture', name: '少女', aliases: ['测试少女'] },
        depth: { ancestors: 4, descendants: 1, maxPerGeneration: 4 } },
      rules: { generationContract: '' } };
    const prompt = repair ? buildGenealogyRepairPrompt({ ...input, validationError: 'fixture' })
      : buildGenealogyApiPrompt(input);
    assert.ok(prompt.includes(raw), '长主档必须在模型提示词中保持完整');
    const block = prompt.split('<GENEALOGY_CHARACTER_SOURCES_READ_ONLY>')[1]!
      .split('</GENEALOGY_CHARACTER_SOURCES_READ_ONLY>')[0]!;
    for (const entry of entries) assert.ok(block.includes(entry.content), '主档、习惯与组织补充都应完整投递');
    assert.equal(block.split(middle).length - 1, 1, '重复附件只投递一次');
    assert.ok(!block.includes('无关人物完整主档不应堆入附件'));
    assert.match(block, /未求值.*条件|条件.*未求值/u);
    assert.match(block, /当前.*Canon|Canon.*当前/u);
    assert.deepEqual(context, before, '投递不改变检索证据、名册、引用及原文');
  });
}
