import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostAdapter } from '../src/adapters/host.ts';
import type { TavernRuntime } from '../src/runtime/contracts.ts';
import { TavernRuinTurnGuard } from '../src/runtime/ruinTurnGuard.ts';

test('活动墟境普通轮次注入防误返边界，渲染后可清除', async () => {
  const prompts: Array<{ key: string; value: string }> = [];
  const runtime = {
    setExtensionPrompt: async (key: string, value: string) => {
      prompts.push({ key, value });
    },
  } as unknown as TavernRuntime;
  const host = {
    getRuinRuntimeSnapshot: async () => ({
      flowState: 'exploring' as const,
      runId: 'run-1',
      realityTime: '现实',
      realityLocation: '现实地点',
      ruinTime: '历史',
      ruinLocation: '历史地点',
    }),
  } as HostAdapter;
  const guard = new TavernRuinTurnGuard(runtime, host);

  await guard.prepareOrdinaryTurn();
  assert.match(prompts[0].value, /任务完成.*不等于玩家授权遣返/u);
  assert.match(prompts[0].value, /不得把流程状态改为 idle/u);
  await guard.clear();
  assert.equal(prompts.at(-1)?.value, '');
});

test('现实 idle 轮次不注入墟境防误返提示', async () => {
  const prompts: Array<{ key: string; value: string }> = [];
  const runtime = {
    setExtensionPrompt: async (key: string, value: string) => {
      prompts.push({ key, value });
    },
  } as unknown as TavernRuntime;
  const host = {
    getRuinRuntimeSnapshot: async () => ({
      flowState: 'idle' as const,
      runId: '',
      realityTime: '现实',
      realityLocation: '现实地点',
      ruinTime: '',
      ruinLocation: '',
    }),
  } as HostAdapter;

  await new TavernRuinTurnGuard(runtime, host).prepareOrdinaryTurn();
  assert.equal(prompts.length, 0);
});
