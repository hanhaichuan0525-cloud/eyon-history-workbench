import assert from 'node:assert/strict';
import test from 'node:test';

import { createButtonCommand, parseTextCommand } from '../src/core/commands.ts';

test('墟境探索与宗族谱系没有文本入口，只能由工作台界面发起（β1.1）', () => {
  // 真机病历：聊天里输入「我要墟境探索」→ 卡片以为要探索、脚本不认；精确输入
  // 「墟境探索」又因工作台草稿为空而掐掉整楼生成。两条链路现在都撤销。
  assert.equal(parseTextCommand('墟境探索'), null);
  assert.equal(parseTextCommand('请墟境探索'), null);
  assert.equal(parseTextCommand('我要墟境探索'), null);
  assert.equal(parseTextCommand('关于墟境探索的规则仍有争议。'), null);
  assert.equal(parseTextCommand('宗族谱系'), null);
  assert.equal(parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系'), null);
  assert.equal(parseTextCommand('我要宗族谱系'), null);
  // 界面按钮路径不受影响。
  assert.equal(createButtonCommand('ruin.generate', '墟境探索').type, 'ruin.generate');
  assert.equal(
    createButtonCommand('genealogy.generate', '维奥莱塔').type,
    'genealogy.generate',
  );
  // 进入节点仍是文本指令（需要工作台给出的进入契约）。
  assert.equal(parseTextCommand('进入节点：候选02')?.type, 'ruin.enter');
});

test('寻根溯源保留玩家补充方向', () => {
  const command = parseTextCommand('对维奥莱塔进行寻根溯源，主要方向是她24岁到28岁的猎艳史');
  assert.equal(command?.type, 'biography.generate');
  assert.match(command?.payload ?? '', /24岁到28岁/u);
});

test('寻根溯源可出现在自然玩家句子的任意位置', () => {
  const command = parseTextCommand(
    '伊雍，我想请你对维奥莱塔进行寻根溯源，重点看看她二十四岁以后。',
  );
  assert.equal(command?.type, 'biography.generate');
  assert.match(command?.raw ?? '', /维奥莱塔/u);
  assert.match(command?.payload ?? '', /二十四岁以后/u);
});

test('叙事里的普通词语不会被误判为命令', () => {
  assert.equal(parseTextCommand('她担心自己终有一天会被遣返。'), null);
  assert.equal(parseTextCommand('任务完成后，系统自动遣返了调查者。'), null);
  assert.equal(parseTextCommand('先不要遣返，我还要检查现场。'), null);
  assert.equal(parseTextCommand('如果以后返回现世，我会整理证据。'), null);
  assert.equal(parseTextCommand('我们讨论一下遣返机制。'), null);
  assert.equal(parseTextCommand('遣返？不，我还没准备好。'), null);
  assert.equal(parseTextCommand('关于墟境探索的规则仍有争议。'), null);
  assert.equal(parseTextCommand('进入节点后的空气很冷。'), null);
});

test('玩家可以在自然叙事末尾明确执行遣返', () => {
  assert.equal(
    parseTextCommand('我收好证据，与她告别，然后遣返。')?.type,
    'ruin.return',
  );
  assert.equal(
    parseTextCommand('处理完伤口后返回现世')?.type,
    'ruin.return',
  );
  assert.equal(
    parseTextCommand('这次调查到此为止，我决定回到现实。')?.type,
    'ruin.return',
  );
  assert.equal(
    parseTextCommand('然后，我对伊雍说：好了，遣返吧')?.type,
    'ruin.return',
  );
  assert.equal(
    parseTextCommand('好了伊雍，遣返回去吧')?.type,
    'ruin.return',
  );
  assert.equal(parseTextCommand('请遣返回到现世')?.type, 'ruin.return');
  assert.equal(parseTextCommand('伊雍，带我们回现实好吗')?.type, 'ruin.return');
  assert.equal(
    parseTextCommand('**好了，我跑到了他们看不到的地方，任务完成，遣返吧**')?.type,
    'ruin.return',
    '整句 Markdown 加粗不应遮蔽明确遣返意图',
  );
  assert.equal(
    parseTextCommand('**先不要遣返，我还要检查现场。**'),
    null,
    '去除 Markdown 包裹后仍须保留否定保护',
  );
  assert.equal(parseTextCommand('回去吧'), null, '无对象的普通回去仍不应触发遣返');
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
