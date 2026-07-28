import assert from 'node:assert/strict';
import test from 'node:test';

import { createButtonCommand, parseTextCommand } from '../src/core/commands.ts';

test('墟境探索只生成候选，不等于进入节点', () => {
  assert.equal(parseTextCommand('墟境探索')?.type, 'ruin.generate');
  assert.equal(parseTextCommand('进入节点：候选02')?.type, 'ruin.enter');
});

test('寻根溯源保留玩家补充方向', () => {
  const command = parseTextCommand('对维奥莱塔进行寻根溯源，主要方向是她24岁到28岁的猎艳史');
  assert.equal(command?.type, 'biography.generate');
  assert.match(command?.payload ?? '', /24岁到28岁/u);
});

test('叙事里的普通词语不会被误判为命令', () => {
  assert.equal(parseTextCommand('她担心自己终有一天会被遣返。'), null);
  assert.equal(parseTextCommand('关于墟境探索的规则仍有争议。'), null);
  assert.equal(parseTextCommand('进入节点后的空气很冷。'), null);
});

test('按钮命令不依赖自然语言猜测', () => {
  const command = createButtonCommand('ruin.return', 'run-42');
  assert.deepEqual(command, {
    type: 'ruin.return',
    raw: 'run-42',
    payload: 'run-42',
    source: 'button',
  });
});
