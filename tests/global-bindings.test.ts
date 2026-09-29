import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveGlobalMvu,
  waitForGlobalMvu,
} from '../src/runtime/globalBindings.ts';

test('原生扩展接收 Tavern Helper waitGlobalInitialized 返回的 MVU 接口', async () => {
  const mvu = {
    getMvuData: () => ({ stat_data: {} }),
    events: { VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended' },
  };
  const calls: string[] = [];
  const globalObject = {
    TavernHelper: {
      waitGlobalInitialized: async (name: string) => {
        calls.push(name);
        return mvu;
      },
    },
  } as unknown as Record<string, unknown>;

  await waitForGlobalMvu(globalObject);

  assert.deepEqual(calls, ['Mvu']);
  assert.equal(resolveGlobalMvu(globalObject), mvu);
});
