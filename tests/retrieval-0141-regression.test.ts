import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { extractRecordedAge } from '../src/retrieval/catalog.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { assessStagePerson, assessPersonTimeline, resolveLifespanFromBaseline } from '../src/retrieval/temporal.ts';

async function personSource(content: string, name = '测试少女') {
  return createSourceSnapshot({ logicalId: `worldbook:test:${name}`, sourceType: 'worldbook', title: `[角色]${name}`, content, metadata: {} });
}
async function person(content: string) {
  return buildRetrievalIndex([await personSource(content)]).catalog.entities.find(e => e.canonicalName === '测试少女')!;
}

test('人物背景事件日期和年龄字段的记录日期都不能冒充出生年', async () => {
  const unknown = await person('身份: 档案员\n背景: 复兴纪元420年，她见证钟楼落成，未记出生日期。');
  assert.equal(unknown.lifespan, undefined);
  const explicit = await person('身份: 档案员\n出生: 复兴纪元400年\n背景: 复兴纪元420年钟楼落成。');
  assert.equal(explicit.lifespan?.born?.year, 400);
  assert.equal(explicit.lifespan?.died, undefined, '相邻背景事件不能冒充死亡');
  const recorded = await person('年龄: 20岁（复兴纪元480年记录）');
  assert.equal(recorded.lifespan?.born, undefined);
  assert.equal(resolveLifespanFromBaseline(recorded, '复兴纪元488年')?.born?.year, 460);
  const event = await person('年龄: 20岁（复兴纪元480年曾去钟楼）');
  assert.equal(event.lifespan?.basedOnYear, undefined, '年龄旁的经历年份不冒充记录基准');
});

test('明确年龄完整读取长寿位数，含糊/外貌年龄不强换算', () => {
  assert.equal(extractRecordedAge('1200岁'), 1200);
  assert.equal(extractRecordedAge('外貌1200岁'), undefined);
  assert.equal(extractRecordedAge('外貌16岁（实际28岁）'), 28);
  for (const value of ['20～30岁', '20岁或30岁', '不详，可能20岁', '大约20岁', '1.5岁']) {
    assert.equal(extractRecordedAge(value), undefined, value);
  }
});

test('既有成功链路保留：488年时18岁，482年事件对应12岁', async () => {
  const entity = await person('身份: 学生\n年龄: 18岁\n背景: 十二岁时卷入大海难。');
  const lifespan = resolveLifespanFromBaseline(entity, '复兴纪元488年');
  assert.deepEqual(lifespan?.born, { era: '复兴纪元', year: 470 });
  const assessment = assessStagePerson({ name: entity.canonicalName, state: 'unknown', narrative: '', lifespan }, {
    start: { era: '复兴纪元', year: 482 }, end: { era: '复兴纪元', year: 482 },
  });
  assert.deepEqual(assessment.ageRange, { start: 12, end: 12 });
  assert.match(assessment.guidance, /复兴纪元482年=12岁/u);
});

test('EJS未求值分支不拼接年龄或身份硬事实，原文仍可交给模型', async () => {
  const content = '<% if (getvar("stage") === 3) { %>\n身份: 执政官\n年龄: 38岁\n<% } else { %>\n身份: 公主\n年龄: 23岁\n<% } %>';
  const source = await personSource(content);
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({ requestId: 'branches', taskType: 'biography', query: '测试少女的历史', mode: 'active' });
  assert.equal(buildRetrievalIndex([source]).catalog.entities.find(e => e.canonicalName === '测试少女')?.lifespan, undefined);
  assert.equal(result.bundle.personCanonViews?.length ?? 0, 0);
  assert.equal(result.bundle.taskAnchorAttachments?.[0]?.content, content);
  assert.ok(result.bundle.castManifest?.entries[0]?.identity.passageIds.length);
});

for (const taskType of ['ruin', 'biography', 'genealogy', 'butterfly'] as const) {
  test(`${taskType}: 散文人设没有结构化字段仍交付原文与身份段`, async () => {
    const source = await personSource('她习惯把旧档案夹在衣袖里。此人经历了多次迁徙，原文未提供可解析年龄。');
    const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({ requestId: `raw-${taskType}`, taskType, query: '测试少女的历史', mode: 'active' });
    assert.equal(result.bundle.personCanonViews?.length ?? 0, 0);
    assert.equal(result.bundle.taskAnchorAttachments?.[0]?.content, source.content);
    assert.ok(result.bundle.castManifest?.entries[0]?.identity.passageIds.length);
  });
}

test('唯一人物的跨时代身世原文不被来源纪元门删除，但跨纪元不计算虚假年龄', async () => {
  const source = await personSource('身份: 当代仍活跃的魔女\n出生: 英雄纪元430年\n背景: 经历两次位面战争。');
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({ requestId: 'cross-era', taskType: 'ruin', query: '复兴纪元450年测试少女历史', mode: 'active' });
  assert.ok(result.bundle.sourceSnapshots.some(s => s.logicalId === source.logicalId));
  assert.ok(result.bundle.castManifest?.entries[0]?.identity.passageIds.length);
  const timeline = result.bundle.personTimeline![0]!;
  assert.deepEqual(assessStagePerson(timeline, { start: { era: '复兴纪元', year: 450 }, end: { era: '复兴纪元', year: 451 } }).ageRange, { start: null, end: null });
});

test('自定义纪年内同年轴可算年龄，纪年顺序未知则不硬断在世', async () => {
  const entity = await person('出生: 星历100年');
  assert.deepEqual(entity.lifespan?.born, { era: '星历', year: 100 });
  const result = assessStagePerson({ name: entity.canonicalName, state: 'unknown', narrative: '', lifespan: entity.lifespan }, {
    start: { era: '星历', year: 112 }, end: { era: '星历', year: 113 },
  });
  assert.deepEqual(result.ageRange, { start: 12, end: 13 });
  assert.equal(assessPersonTimeline(entity, '月历', 112).state, 'unknown');
  assert.equal(assessPersonTimeline(entity, '星历', null).state, 'unknown');
});

test('纪元前的目标年份保持负号，不被错误判成出生后的年份', async () => {
  const source = await personSource('出生: 复兴纪元前20年');
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({ requestId: 'before-zero', taskType: 'ruin', query: '复兴纪元前30年测试少女历史', mode: 'active' });
  assert.equal(result.bundle.personTimeline![0]!.state, 'not-born');
});
