import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkbenchDisplayText } from '../src/runtime/displayText.ts';

test('工作台可见文本把 user 宏和泛称玩家展开为当前酒馆玩家名', () => {
  const globalObject = {
    SillyTavern: {
      getContext: () => ({ name1: '海因里希·山德士' }),
    },
  };
  assert.equal(
    resolveWorkbenchDisplayText(
      '<user>敲了两人的脑袋，玩家随后离开石灶间。',
      globalObject,
    ),
    '海因里希·山德士敲了两人的脑袋，海因里希·山德士随后离开石灶间。',
  );
});

test('工作台宏展开只返回显示副本，不改写原始档案文本', () => {
  const original = '<user>保留了一角旧文书。';
  const displayed = resolveWorkbenchDisplayText(original, {
    SillyTavern: { getContext: () => ({ name1: '海因里希' }) },
  });
  assert.equal(displayed, '海因里希保留了一角旧文书。');
  assert.equal(original, '<user>保留了一角旧文书。');
});

test('宿主姓名暂不可读时保留 user 宏，不臆造玩家名', () => {
  assert.equal(
    resolveWorkbenchDisplayText('<user>正在检查档案。', {}),
    '<user>正在检查档案。',
  );
});
