import assert from 'node:assert/strict';
import test from 'node:test';
import type { ButterflyRecord } from '../src/storage/butterflies.ts';
import { butterflyLogTitle, serializeButterflyArchive } from '../src/renderers/butterfly.ts';
import { butterflyRecordTitle } from '../src/runtime/butterflySources.ts';
import {
  runtimeStateLabel,
  visibleButterflyArchives,
  timelineJourney, timelineDisplayTitle,
} from '../src/ui/timelineView.ts';

test('三节点只读每份档案保存时地，不显示第四节点或改写原资料', () => {
  const item = record('committed', 2, 'route');
  item.request = { anchors: { reality: { time: '488年10:25', location: '现世' }, ruinEntry: { time: '740年09:10', location: '配药室' }, ruinExit: { time: '740年11:35', location: '外石阶' } } } as ButterflyRecord['request'];
  const before = structuredClone(item);
  assert.deepEqual(timelineJourney(item), [
    { label:'现世出发',time:'488年10:25',location:'现世' },
    { label:'墟境进入',time:'740年09:10',location:'配药室' },
    { label:'墟境离开',time:'740年11:35',location:'外石阶' },
  ]);
  assert.deepEqual(item, before);
});
test('旧档缺锚点和部分字段分开提示，日志展示名不改变保存标题', () => {
  const item = record('committed', 2, 'old');
  assert.equal(timelineJourney(item)[0].time, '时刻未记录');
  item.request = { anchors: { reality: { time:'旧日期' } } } as ButterflyRecord['request'];
  assert.equal(timelineJourney(item)[0].time, '旧日期');
  assert.equal(timelineJourney(item)[0].location, '地点未记录');
  assert.equal(timelineDisplayTitle('《蝴蝶效应日志：逆风旧誓》'), '逆风旧誓');
  assert.equal(timelineDisplayTitle('《蝴蝶效应锚定日志4》'), '《蝴蝶效应锚定日志4》');
});

function record(
  status: ButterflyRecord['status'],
  updatedAt: number,
  runId: string,
): ButterflyRecord {
  return {
    key: runId,
    namespace: { characterKey: '伊雍', chatId: 'chat-a' },
    runId,
    requestId: `request-${runId}`,
    request: {} as ButterflyRecord['request'],
    result: {
      schema: 'eyon.butterfly.v1',
      requestId: `request-${runId}`,
      runId,
      effect: {
        roll: 42,
        scope: '城市',
        presentLanding: `${runId}的现世落点`,
        perceptibleEvidence: ['证据'],
        ruinActionRecord: '行动',
        historicalEvolution: '演变',
        historicalKeywords: ['一', '二', '三', '四'],
      },
      causalStages: [],
      sourceIds: [],
      inferences: [],
      warnings: [],
      qualityChecks: {
        anchorsUntouched: true,
        scopeRespected: true,
        causalChainComplete: true,
        presentEvidenceConcrete: true,
        playerAgencyPreserved: true,
        canonConflictsResolved: true,
      },
    },
    sourceHash: 'hash',
    panel: '',
    archiveEntry: `### 《蝴蝶效应锚定日志${runId}》`,
    assistantMessageId: 10,
    status,
    revision: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}

test('墟境状态使用稳定中文标签', () => {
  assert.equal(runtimeStateLabel('idle'), '现实待命');
  assert.equal(runtimeStateLabel('exploring'), '墟境探索中');
  assert.equal(runtimeStateLabel('returning'), '遣返结算中');
});

test('时空页展示已写正文/已归档及失败待重试的蝴蝶效应，并按更新时间排序', () => {
  const failedReasons = new Map([
    ['3', 'mirror failed: worldbook write rejected'],
  ]);
  const result = visibleButterflyArchives([
    record('validated', 40, '0'),
    record('committed', 20, '1'),
    record('mirror_pending', 30, '2'),
    // validated + pending.failure（internal.81 v17：提交失败必须可见、可重试）
    record('validated', 50, '3'),
  ], failedReasons);
  assert.deepEqual(result.map(item => item.record.runId), ['3', '2', '1']);
  assert.equal(result[0]?.title, '《蝴蝶效应锚定日志3》');
  assert.equal(result[0]?.statusLabel, '待重试');
  assert.equal(result[0]?.retryable, true);
  assert.equal(result[0]?.failureReason, 'mirror failed: worldbook write rejected');
  assert.equal(result[1]?.statusLabel, '待归档');
  assert.equal(result[2]?.statusLabel, '已归档');
  assert.equal(result[2]?.retryable, false);
  assert.equal(result[2]?.failureReason, undefined);
});

test('新日志以短标题展示，缺失或无效标题用关键词兜底且不截正文', () => {
  const item = record('committed', 100, 'stable-run');
  const effect = item.result.effect;
  effect.title = '《蝴蝶效应日志：逆风新城》';
  effect.historicalKeywords = ['金谷新城', '战旗'];
  effect.historicalEvolution = '完整历史正文：未裁剪。'.repeat(200);
  effect.presentLanding = '现世窗口';
  const original = structuredClone(effect);
  const title = butterflyLogTitle(effect);
  assert.equal(title, '《蝴蝶效应日志：逆风新城》');
  item.archiveEntry = serializeButterflyArchive({
    title, effect,
    anchors: {
      reality: { time: '488年', location: '现世原地' },
      ruinEntry: { time: '129年', location: '旧时代原地' },
      ruinExit: { time: '130年', location: '离开地点' },
    },
  });
  assert.equal(visibleButterflyArchives([item])[0]?.title, title);
  assert.equal(butterflyRecordTitle(item), title, '召回源沿用归档标题');
  assert.equal(item.runId, 'stable-run', '展示改名不改变召回源标识');
  assert.ok(item.archiveEntry.includes(effect.historicalEvolution));
  assert.deepEqual(effect, original, '命名与渲染不改写原始结果');
  for (const invalid of [undefined, '', '12', '标题'.repeat(20), 123]) {
    const input = { ...effect, title: invalid } as typeof effect;
    assert.equal(butterflyLogTitle(input), '《蝴蝶效应日志：金谷新城》');
  }
  assert.equal(butterflyLogTitle({ ...effect, title: undefined, historicalKeywords: [] }),
    '《蝴蝶效应日志：历史余波》');
});

test('旧序号日志保留原文；无归档标题时不再用列表序号', () => {
  const legacy = record('committed', 100, 'legacy-run');
  legacy.archiveEntry = '### 《蝴蝶效应日志：3》\n\n旧档案完整正文';
  const current = record('committed', 200, 'current-run');
  current.archiveEntry = '';
  current.result.effect.title = '山谷改道';
  assert.deepEqual(visibleButterflyArchives([legacy, current]).map(item => item.title),
    ['《蝴蝶效应日志：山谷改道》', '《蝴蝶效应日志：3》']);
  assert.equal(legacy.archiveEntry, '### 《蝴蝶效应日志：3》\n\n旧档案完整正文');
});
