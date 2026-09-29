import assert from 'node:assert/strict';
import test from 'node:test';
import type { ButterflyRecord } from '../src/storage/butterflies.ts';
import {
  runtimeStateLabel,
  visibleButterflyArchives,
} from '../src/ui/timelineView.ts';

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
