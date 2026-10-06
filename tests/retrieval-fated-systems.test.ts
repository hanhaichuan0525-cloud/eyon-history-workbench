import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSourcePurpose } from '../src/retrieval/sourcePurpose.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { isBiographyMechanismSource, mayUseBiographySource } from '../src/runtime/biographySourcePurpose.ts';
import { selectBiographyEvidence } from '../src/runtime/biographyEvidence.ts';

// 明确标注合成系统，不依赖伊雍的专有词，覆盖类别识别与普通史料的边界。
const cores = [
  { title: '[DLC][命定系统]星枢核心(作者甲)', content: '运行规则：启动星枢后显示系统面板，必须按固定格式输出孤悬天壁状态。\n姓名: 星枢\n身份: 系统助理' },
  { title: '【DLC】【命定系统】【归途】交互协议', content: '归途启动说明：角色发出命令时生成面板。输出格式：<return_panel>孤悬天壁</return_panel>' },
  { title: '命定系统-审律-启动规则', content: '启动审律模块后遵守以下生成指令：输出孤悬天壁的审查面板。' },
  { title: '[DLC][命定系统]其他系统核心', content: '运行规则：角色启动此模块后显示系统面板，按此处规定的固定格式输出状态。' },
  { title: '[DLC][命定系统]星枢模板', content: '<% if (active) { %>必须生成孤悬天壁的系统面板。<% } %>' },
  { title: '[DLC]伊雍核心', content: '虚嗣王权与命定契约的运行说明，必须输出孤悬天壁的面板。' },
];
const tasks = ['ruin', 'butterfly', 'biography', 'genealogy'] as const;
const source = (record: { title: string; content: string }) => ({ ...record, sourceType: 'worldbook' as const });

test('所有命定系统纯运行资料按类别隔离，不依赖伊雍词汇或作者题注', () => {
  for (const taskType of tasks) for (const record of cores) {
    assert.equal(assessSourcePurpose(source(record), { taskType, query: '孤悬天壁的历史' }).use, 'not-used', record.title);
    assert.equal(isBiographyMechanismSource(source(record)), true, record.title);
    assert.equal(mayUseBiographySource(source(record), '对孤悬天壁寻根溯源'), false, record.title);
  }
});

test('系统呼语、同地点和首稿借名不能开启核心；明确研究只开启对应系统', () => {
  for (const record of cores) assert.equal(mayUseBiographySource(source(record), '星枢，帮我研究孤悬天壁的经历'), false);
  for (const query of ['研究星枢的来历', '探讨星枢核心的运行方式', '星枢']) {
    assert.equal(mayUseBiographySource(source(cores[0]!), query), true, query);
    for (const record of cores.slice(1, 4)) assert.equal(mayUseBiographySource(source(record), query), false, record.title);
    assert.equal(mayUseBiographySource(source(cores[5]!), query), false);
  }
  for (const record of cores) assert.equal(mayUseBiographySource(source(record), record.title), true, '完整题名的明确查询兼容作者题注');
  for (const [record, query] of [[cores[1]!, '研究归途的机制'], [cores[2]!, '探讨审律的运行规则']] as const) {
    assert.equal(mayUseBiographySource(source(record), query), true, query);
  }
  for (const query of ['对伊雍核心进行寻根溯源', '探讨命定契约的历史', '研究伊雍的来历']) {
    assert.equal(mayUseBiographySource(source(cores[5]!), query), true, query);
    assert.equal(mayUseBiographySource(source(cores[0]!), query), false, '伊雍研究不能开启其他系统');
  }
  for (const record of cores) assert.equal(mayUseBiographySource(source(record), '研究全部命定系统的运行原理'), true);
});

test('命定系统混合人物/世界事实从宽保留全文，EJS不执行，真实行动不被当核心删除', () => {
  const records = [
    { title: '[DLC][命定系统]星枢补充', content: '运行规则：输出系统面板。\n世界设定: 星枢村居民使用羽币交易。' },
    { title: '[DLC][命定系统][角色][雨禾]雨禾', content: '<雨禾 角色详情>\n姓名: 雨禾\n背景故事: 雨禾八岁时姐姐去世。\n' + '完整的求学经历。'.repeat(2000) + '\n末尾事实：十二岁在482年经历海难。\n</雨禾 角色详情>' },
    { title: '[DLC][命定系统][角色]澜禾', content: '<% const profile = { name: "澜禾", back_story: "澜禾十二岁经历月牙湖海难" }; %>' },
    { title: '[命定系统]星枢混合档案', content: '<% if (alternate) { %>\n背景故事: 雨禾在另一分支与归途订立契约。\n<% } %>' },
    { title: '[命定系统]乡间杂记', content: '雨禾曾在旧港求学，后来成为村里的织工。' },
  ];
  for (const record of records) {
    assert.notEqual(assessSourcePurpose(source(record), { taskType: 'biography', query: '雨禾的经历' }).use, 'not-used');
    assert.equal(mayUseBiographySource(source(record), '雨禾的经历'), true);
    assert.equal(isBiographyMechanismSource(source(record)), false, '保留的人物事实不能整份标成机制而否定身份');
  }
  for (const sourceType of ['chat', 'mvu', 'biography', 'butterfly'] as const) {
    const record = { ...cores[0]!, sourceType, content: '玩家已与雨禾签约并将她带出现世，雨禾离开原历史。' };
    assert.equal(assessSourcePurpose(record, { taskType: 'butterfly', query: '雨禾的变化' }).use, 'primary');
    assert.equal(mayUseBiographySource(record, '雨禾的经历'), true);
  }
  assert.equal(isBiographyMechanismSource(source({ title: '[器物]炼金炉核心', content: '炼金炉核心于470年制造，属于旧港工坊。' })), false);
  assert.equal(isBiographyMechanismSource(source({ title: '[世界]命定系统之外的遗物', content: '这枚遗物由古代匠人制成，留在山间洞穴。' })), false, '提及系统不是资料归属');
});

test('传记章节补查沿用系统隔离，名称/sourceRefs不能把无关核心自证成史实', () => {
  const catalog = cores.map((record, i) => ({ ...source(record), sourceId: 'worldbook:system:' + i, authority: 100 }));
  assert.deepEqual(selectBiographyEvidence(['星枢核心', '归途', '审律'], [], [], catalog, '孤悬天壁的经历'), []);
  assert.deepEqual(selectBiographyEvidence([], catalog.map(s => s.sourceId), catalog, [], '孤悬天壁的经历'), []);
  assert.deepEqual(selectBiographyEvidence(['星枢核心'], [], [], catalog, '研究星枢的来历').map(s => s.sourceId), ['worldbook:system:0']);
});

test('四模块真实检索在演员/附件建立前隔离全部核心，保留语料回执与混合原文偏移', async () => {
  const mixed = { title: '[DLC][命定系统][角色][雨禾]雨禾', content: '<雨禾 角色详情>\n姓名: 雨禾\n背景故事: 雨禾八岁时姐姐去世。\n' + '完整经历。'.repeat(2500) + '\n末尾年龄事实。\n</雨禾 角色详情>' };
  const snapshots = await Promise.all([...cores, mixed].map((record, i) => createSourceSnapshot({
    ...source(record), logicalId: 'worldbook:fated:' + i, metadata: {},
  })));
  for (const taskType of tasks) {
    const { bundle } = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({
      requestId: taskType, taskType, query: '雨禾八岁时在孤悬天壁的经历', mode: 'active',
    });
    assert.equal(bundle.receipt.candidateSnapshotIds.length, snapshots.length);
    for (let i = 0; i < cores.length; i++) {
      assert.ok(!bundle.sourceSnapshots.some(s => s.logicalId === 'worldbook:fated:' + i));
      assert.ok(!bundle.taskAnchorAttachments?.some(s => s.sourceId === 'worldbook:fated:' + i));
      assert.ok(bundle.receipt.rejected.some(s => s.snapshotId === snapshots[i]!.snapshotId
        && /fated-system/u.test(s.reason)));
    }
    assert.ok(!bundle.castManifest?.entries.some(s => ['星枢', '归途', '审律'].includes(s.identity.canonicalName)));
    assert.equal(bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:fated:' + cores.length)?.content, mixed.content);
    assert.ok(bundle.taskAnchorAttachments?.some(s => s.content === mixed.content));
    for (const p of bundle.passages) {
      const s = snapshots.find(s => s.snapshotId === p.snapshotId)!;
      assert.equal(s.content.slice(p.startOffset, p.endOffset).trim(), p.content.trim());
    }
    assert.equal(bundle.semanticEvidence, undefined);
  }
});

test('显式研究和选择仍可读取系统原文，正文中的规则不会获得执行权限', async () => {
  const snapshots = await Promise.all(cores.map((record, i) => createSourceSnapshot({
    ...source(record), logicalId: 'worldbook:fated:' + i, metadata: {},
  })));
  for (const taskType of tasks) {
    const { bundle } = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({
      requestId: taskType, taskType, query: '探讨星枢核心的运行方式', mode: 'active',
    });
    assert.equal(bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:fated:0')?.content, cores[0]!.content);
    for (const i of [1, 2, 3, 5]) assert.ok(!bundle.sourceSnapshots.some(s => s.logicalId === 'worldbook:fated:' + i));
    const forced = await new UnifiedShadowRetrievalEngine(snapshots).retrieve({
      requestId: 'forced-' + taskType, taskType, query: '孤悬天壁的历史', mode: 'active',
      forcedSourceLogicalIds: ['worldbook:fated:1'],
    });
    assert.equal(forced.bundle.sourceSnapshots.find(s => s.logicalId === 'worldbook:fated:1')?.content, cores[1]!.content);
  }
});
