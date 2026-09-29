import assert from 'node:assert/strict';
import test from 'node:test';

import {
  carryPlayerFloor,
  normalizeRuinVariables,
  strengthenEntryCommands,
} from '../src/runtime/ruinTimeKernel.ts';

function activeVariables(overrides: Record<string, unknown> = {}) {
  return {
    stat_data: {
      世界: {
        时间: '复兴纪元145年-5月-20日-23:15',
        地点: '地下教堂',
      },
      墟境系统: {
        运行状态: {
          墟境流程状态: 'exploring',
          墟境任务规则锁定: 1,
          墟境待遣返: 0,
          墟境待蝴蝶效应结算: 0,
          墟境轮次: 'RUN-145',
          墟境进入前时间: '复兴纪元488年-5月-10日-14:28',
          墟境进入前地点: '源泉温床',
          本轮现实时间: '复兴纪元488年-5月-10日-14:28',
          本轮现实地点: '源泉温床',
          墟境当前时间: '复兴纪元145年-5月-20日-23:15',
          墟境当前地点: '地下教堂',
          本轮墟境进入时间: '复兴纪元145年-5月-20日-23:15',
          本轮墟境进入地点: '地下教堂',
          本轮墟境离开时间: '复兴纪元145年-5月-20日-23:15',
          本轮墟境离开地点: '地下教堂',
          归档轮次: '',
          归档现实时间: '',
          归档现实地点: '',
          归档墟境进入时间: '',
          归档墟境进入地点: '',
          归档墟境离开时间: '',
          归档墟境离开地点: '',
          蝴蝶效应锚定计数: 2,
          ...overrides,
        },
      },
    },
  };
}

function patch(operations: unknown[]): string {
  return `正文\n\n${JSON.stringify(operations)}`;
}

test('完整进入契约会建立活动轮次、同步世界时地并生成快照', () => {
  const variables = { stat_data: { 世界: { 时间: '现实', 地点: '现实地点' } } };
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 1 },
    { op: 'replace', path: '/墟境系统/运行状态/墟境轮次', value: 'RUN-145' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实时间', value: '现实 14:28' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实地点', value: '现实地点' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入时间', value: '历史 23:15' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入地点', value: '地下教堂' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '历史 23:15' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '地下教堂' },
    { op: 'replace', path: '/世界/时间', value: '历史 23:15' },
    { op: 'replace', path: '/世界/地点', value: '地下教堂' },
  ]);
  assert.equal(normalizeRuinVariables(variables, null, text), true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '历史 23:15');
  assert.equal(stat.墟境系统.运行状态.本轮墟境离开时间, '历史 23:15');
  assert.equal(stat.墟境系统.虚嗣指南快照.flowState, 'exploring');
  assert.equal(stat.墟境系统.虚嗣指南快照.lockedRealTime, '现实 14:28');
});

test('同一轮推进只更新墟境当前与离开锚点，不允许进入锚点和现实锚点漂移', () => {
  const previous = activeVariables();
  const variables = activeVariables({
    墟境流程状态: 'idle',
    墟境任务规则锁定: 0,
    本轮现实时间: '错误现实',
    本轮现实地点: '错误地点',
    本轮墟境进入时间: '错误进入时间',
    本轮墟境进入地点: '错误进入地点',
    墟境当前时间: '',
    墟境当前地点: '',
  });
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '复兴纪元145年-5月-20日-23:20' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '祭坛后室' },
  ]);
  normalizeRuinVariables(variables, previous, text);
  const state = (variables.stat_data as Record<string, any>).墟境系统.运行状态;
  assert.equal(state.墟境流程状态, 'exploring');
  assert.equal(state.本轮现实时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(state.本轮墟境进入时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(state.墟境当前时间, '复兴纪元145年-5月-20日-23:20');
  assert.equal(state.本轮墟境离开地点, '祭坛后室');
});

test('覆盖层擦掉轮次后先补回同轮身份，再锁住现实与进入锚点', () => {
  const previous = activeVariables();
  const variables = activeVariables({
    墟境轮次: '',
    墟境流程状态: 'idle',
    墟境任务规则锁定: 0,
    本轮现实时间: '错误现实',
    本轮现实地点: '错误地点',
    本轮墟境进入时间: '错误进入时间',
    本轮墟境进入地点: '错误进入地点',
    墟境当前时间: '',
    墟境当前地点: '',
  });
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '复兴纪元145年-5月-20日-23:21' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '钟楼夹层' },
  ]);

  normalizeRuinVariables(variables, previous, text);
  const state = (variables.stat_data as Record<string, any>).墟境系统.运行状态;
  assert.equal(state.墟境轮次, 'RUN-145');
  assert.equal(state.本轮现实时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(state.本轮墟境进入时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(state.墟境当前时间, '复兴纪元145年-5月-20日-23:21');
  assert.equal(state.本轮墟境离开地点, '钟楼夹层');
});

test('相邻玩家楼已授权遣返时，即使模型只写 idle 契约也会恢复现实', () => {
  const previous = activeVariables({
    本轮墟境离开时间: '复兴纪元145年-5月-20日-23:22',
    本轮墟境离开地点: '礼拜堂出口',
  });
  const variables = activeVariables();
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'idle' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 0 },
  ]);
  normalizeRuinVariables(variables, previous, text, true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(stat.世界.地点, '源泉温床');
  assert.equal(stat.墟境系统.运行状态.归档轮次, 'RUN-145');
  assert.equal(
    stat.墟境系统.运行状态.归档墟境离开时间,
    '复兴纪元145年-5月-20日-23:22',
  );
  assert.equal(stat.墟境系统.运行状态.墟境轮次, '');
  assert.equal(stat.墟境系统.虚嗣指南快照.flowState, 'idle');
});

test('任务完成但玩家没有授权遣返时，模型误写 idle 也会继续留在墟境', () => {
  const previous = activeVariables();
  const variables = activeVariables();
  const text = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'idle' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 0 },
    { op: 'replace', path: '/世界/时间', value: '错误的现实时间' },
    { op: 'replace', path: '/世界/地点', value: '错误的现实地点' },
  ]);

  normalizeRuinVariables(variables, previous, text, false);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'exploring');
  assert.equal(stat.墟境系统.运行状态.墟境任务规则锁定, 1);
  assert.equal(stat.世界.时间, '复兴纪元145年-5月-20日-23:15');
  assert.equal(stat.世界.地点, '地下教堂');
});

test('玩家已授权遣返时不依赖模型输出结构化字段也会确定性回正', () => {
  const previous = activeVariables({
    本轮墟境离开时间: '复兴纪元145年-5月-20日-23:25',
    本轮墟境离开地点: '地下教堂出口',
  });
  const variables = activeVariables();

  normalizeRuinVariables(variables, previous, '她穿过光门，回到了熟悉的房间。', true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.世界.时间, '复兴纪元488年-5月-10日-14:28');
  assert.equal(stat.世界.地点, '源泉温床');
  assert.equal(stat.墟境系统.运行状态.归档墟境离开地点, '地下教堂出口');
  assert.equal(stat.墟境系统.运行状态.墟境流程状态, 'idle');
  assert.equal(stat.墟境系统.运行状态.墟境轮次, '');
});

test('玩家楼只继承上一可见 AI 楼的墟境根；活动轮次同时继承世界时地', () => {
  const variables = { stat_data: { 世界: { 时间: '错误', 地点: '错误' } } };
  assert.equal(carryPlayerFloor(variables, activeVariables()), true);
  const stat = variables.stat_data as Record<string, any>;
  assert.equal(stat.墟境系统.运行状态.墟境轮次, 'RUN-145');
  assert.equal(stat.世界.时间, '复兴纪元145年-5月-20日-23:15');
});

test('COMMAND_PARSED 只对完整 entering 契约补强，不接受单独 exploring', () => {
  const incomplete: Array<Record<string, unknown>> = [];
  assert.equal(strengthenEntryCommands(incomplete, patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
  ])), false);
  assert.equal(incomplete.length, 0);

  const commands: Array<Record<string, unknown>> = [{
    type: 'set',
    args: ['墟境系统.运行状态.墟境流程状态', '"idle"'],
  }];
  const complete = patch([
    { op: 'replace', path: '/墟境系统/运行状态/墟境流程状态', value: 'exploring' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境任务规则锁定', value: 1 },
    { op: 'replace', path: '/墟境系统/运行状态/墟境轮次', value: 'RUN-145' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实时间', value: '现实' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮现实地点', value: '现实地点' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入时间', value: '历史' },
    { op: 'replace', path: '/墟境系统/运行状态/本轮墟境进入地点', value: '历史地点' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前时间', value: '历史' },
    { op: 'replace', path: '/墟境系统/运行状态/墟境当前地点', value: '历史地点' },
    { op: 'replace', path: '/世界/时间', value: '历史' },
    { op: 'replace', path: '/世界/地点', value: '历史地点' },
  ]);
  assert.equal(strengthenEntryCommands(commands, complete), true);
  assert.ok(commands.some(command => command.reason === 'eyon_time_kernel_runtime_init'));
  assert.ok(commands.some(command => (
    Array.isArray(command.args)
    && command.args[0] === '墟境系统.运行状态.墟境流程状态'
    && command.reason === 'eyon_time_kernel_entry_contract'
  )));
});
