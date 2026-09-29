import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampCompanionPosition,
  companionPresentation,
} from '../src/ui/companionPresentation.ts';

test('伴生入口按任务状态选择役情动作与文案', () => {
  assert.deepEqual(companionPresentation({
    status: 'assembling_context',
    detail: '正在查找史料',
    taskType: 'biography',
    phase: 'running',
  }), {
    title: '我去书架上找那一卷……',
    motion: 'biography',
    state: 'working',
  });
  assert.equal(companionPresentation({
    status: 'entering_ruin',
    detail: '时光之门已然洞开，正在等待正文',
    taskType: 'ruin',
    phase: 'running',
  }).motion, 'ruin-portal');
  assert.equal(companionPresentation({
    status: 'failed',
    detail: '境界生成未完成',
    taskType: 'ruin',
    phase: 'error',
  }).title, '本次处理未完成');
});

test('伴生入口坐标始终被限制在视口中', () => {
  assert.deepEqual(clampCompanionPosition(-100, -20, 800, 600), { left: 8, top: 8 });
  assert.deepEqual(clampCompanionPosition(900, 700, 800, 600), { left: 736, top: 536 });
  assert.deepEqual(clampCompanionPosition(120, 220, 800, 600), { left: 120, top: 220 });
});
