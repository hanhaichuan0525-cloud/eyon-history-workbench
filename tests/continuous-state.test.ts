import assert from 'node:assert/strict';
import test from 'node:test';
import type { CanonFact } from '../src/retrieval/contracts.ts';
import { projectContinuousStates, continuousStateAt, renderContinuousStatesAtTimes } from '../src/retrieval/continuousState.ts';
import { stateTimesFromSpan } from '../src/prompts/activeEvidence.ts';

function fact(value: string, start: string, dimension = '拘束'): CanonFact {
  return { factId: `${dimension}:${value}`, subjectEntityId: 'A', predicate: `continuous:${dimension}`,
    object: value, statement: `A${value}`, temporalScope: start, spatialScope: '旧堡',
    epistemicStatus: 'explicit', confidence: 'high', sourceRefs: ['source'], sourceSnapshotIds: [], sourceSpans: [],
    revisionIntroduced: 0, revisionRetired: null, continuousState: { dimension, value, start } };
}
test('CS-01/02/05：监禁、越狱、赦免按日期投影，保留事件且不修改源记录', () => {
  const facts = [fact('监禁', '复兴纪元450年3月1日'), fact('越狱', '复兴纪元450年4月1日'), fact('赦免', '复兴纪元450年5月1日')];
  const old = JSON.stringify(facts);
  const states = projectContinuousStates(facts);
  for (const [at, expected] of [['3月20日', '监禁'], ['4月1日', '越狱'], ['5月2日', '赦免']]) {
    assert.equal(continuousStateAt(states, 'A', '拘束', `复兴纪元450年${at}`).value, expected);
  }
  assert.equal(states.length, 3); assert.equal(JSON.stringify(facts), old);
  assert.equal(continuousStateAt(states, 'A', '拘束', '复兴纪元450年2月1日').status, 'unknown');
  assert.ok(renderContinuousStatesAtTimes(states, ['复兴纪元450年4月2日']).join('\n').includes('越狱'));
});
test('CS-06：开放维度独立，精确到同日不同时刻，无状态词分类器', () => {
  const states = projectContinuousStates([fact('手臂受伤', '复兴纪元450年3月1日09:00', '伤势'),
    fact('痊愈', '复兴纪元450年3月1日18:00', '伤势'), fact('遗失', '复兴纪元450年3月1日', '钥匙持有')]);
  assert.equal(continuousStateAt(states, 'A', '伤势', '复兴纪元450年3月1日10:00').value, '手臂受伤');
  assert.equal(continuousStateAt(states, 'A', '伤势', '复兴纪元450年3月1日19:00').value, '痊愈');
  assert.equal(continuousStateAt(states, 'A', '钥匙持有', '复兴纪元450年4月1日').value, '遗失');
});
test('缺日期、部分日期、冲突和异界资料不得硬判', () => {
  const states = projectContinuousStates([fact('监禁', '复兴纪元450年'), fact('自由', '复兴纪元450年')]);
  assert.equal(continuousStateAt(states, 'A', '拘束', '复兴纪元450年4月2日').status, 'unknown');
  assert.equal(continuousStateAt(states, 'A', '拘束', '星历20年').status, 'unknown');
  const uncertain = fact('监禁', '复兴纪元450年3月1日'); uncertain.epistemicStatus = 'reported';
  assert.equal(continuousStateAt(projectContinuousStates([uncertain]), 'A', '拘束', '复兴纪元451年').status, 'unknown');
  assert.deepEqual(stateTimesFromSpan('复兴纪元450年3月1日 — 450年5月1日'), ['复兴纪元450年3月1日', '复兴纪元450年5月1日']);
});
