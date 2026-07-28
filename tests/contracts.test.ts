import assert from 'node:assert/strict';
import test from 'node:test';

import { namespaceKey, recordKey } from '../src/core/namespace.ts';
import { createSlot } from '../src/core/slots.ts';
import { serializeButterflyPanel } from '../src/renderers/butterfly.ts';
import { validateRootTrace } from '../src/renderers/rootTrace.ts';
import { serializeRuinTrace } from '../src/renderers/ruinTrace.ts';

const namespace = {
  characterKey: '命定之诗',
  chatId: '存档 03',
};

test('持久化键严格包含角色卡和聊天', () => {
  assert.equal(namespaceKey(namespace), '%E5%91%BD%E5%AE%9A%E4%B9%8B%E8%AF%97::%E5%AD%98%E6%A1%A3%2003');
  assert.match(recordKey(namespace, 'biography', 'bio-1'), /biography::bio-1$/u);
});

test('占位槽只接受可控 requestId', () => {
  assert.equal(createSlot('rootTrace', 'bio-20260728-01'), '[EYON_ROOTTRACE_SLOT::bio-20260728-01]');
  assert.throws(() => createSlot('ruinTrace', '../run'));
});

test('RuinTrace 使用美化正则约定的固定字段顺序', () => {
  const output = serializeRuinTrace(
    {
      title: '旧影的回音',
      periodType: '过渡期',
      span: { label: '复兴纪元145年5月—180年冬' },
      historyProse: '一段经过校验的历史史稿。',
      shift: '稳定期 → 过渡期',
    },
    { time: { label: '复兴纪元145年5月20日 23:15' } },
  );

  assert.equal(
    output,
    [
      '[RuinTrace]',
      'Title:: 旧影的回音',
      'Type:: 过渡期',
      'Span:: 复兴纪元145年5月—180年冬',
      'History:: 一段经过校验的历史史稿。',
      'Shift:: 稳定期 → 过渡期',
      'NodeTime:: 复兴纪元145年5月20日 23:15',
      '[/RuinTrace]',
    ].join('\n'),
  );
});

test('RootTrace 禁止默认展开和跨工作流内容', () => {
  const valid = [
    '[RootTrace]',
    'Title:: 《伊雍传》',
    'Periods:: <details class="eybi-stage"><summary>稳定期</summary><div>正文</div></details>',
    '[/RootTrace]',
  ].join('\n');
  assert.equal(validateRootTrace(valid), valid);
  assert.throws(() => validateRootTrace(valid.replace('<details ', '<details open ')));
});

test('蝴蝶效应面板只序列化已校验结果', () => {
  const output = serializeButterflyPanel({
    roll: 42,
    scope: '聚落',
    presentLanding: '南侧荒原出现锈水镇。',
    perceptibleEvidence: ['麦田消失', '税册改写'],
    ruinActionRecord: '玩家截留水文残卷。',
    historicalEvolution: '残卷失踪改变了后续水网规划。',
    historicalKeywords: ['水文残卷', '锈水镇'],
  });

  assert.match(output, /^<butterfly_panel>/u);
  assert.match(output, /\[可感知证据\|麦田消失；税册改写\]/u);
  assert.match(output, /\[历史关键词\|水文残卷、锈水镇\]/u);
});
