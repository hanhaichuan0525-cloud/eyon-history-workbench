import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKBENCH_GLOBAL,
  WORKBENCH_READY_EVENT,
  WORKBENCH_STATUS_EVENT,
  type EyonHistoryWorkbenchFacade,
} from '../src/runtime/facade.ts';
import { WorkbenchUiClient } from '../src/ui/workbenchClient.ts';

function makeFacade(): EyonHistoryWorkbenchFacade {
  const settings = {
    schemaVersion: 1 as const,
    generation: {
      genealogy: { mode: 'follow_tavern' as const },
      ruin: { mode: 'follow_tavern' as const },
      biography: { mode: 'follow_tavern' as const },
      butterfly: { mode: 'follow_tavern' as const },
    },
    ruinDraft: null,
    genealogyDepth: { ancestors: 4, descendants: 3 },
  };
  return {
    version: 'test',
    getSettings: () => settings,
    updateSettings: () => settings,
    setGenerationSettings: () => settings,
    applyGenerationSettingsToAll: () => settings,
    setRuinDraft: () => settings,
    generateGenealogy: async () => { throw new Error('not used'); },
    listGenealogies: async () => [],
    generateRuin: async () => { throw new Error('not used'); },
    listRuins: async () => [],
    listBiographies: async () => [],
    listButterflies: async () => [],
    enterRuin: async () => undefined,
    returnRuin: async () => undefined,
    retryButterfly: async () => undefined,
    dispose() {},
  };
}

test('UI客户端只通过公开门面读取当前命名空间快照', async () => {
  const facade = makeFacade();
  const globals = { [WORKBENCH_GLOBAL]: facade };
  const client = new WorkbenchUiClient(globals, new EventTarget());
  assert.equal(client.isReady(), true);
  assert.deepEqual(await client.readSnapshot(), {
    version: 'test',
    settings: facade.getSettings(),
    biographies: [],
    genealogies: [],
    ruins: [],
    butterflies: [],
  });
});

test('UI客户端订阅并释放工作台状态与就绪事件', () => {
  const events = new EventTarget();
  const client = new WorkbenchUiClient({}, events);
  const statuses: string[] = [];
  const ready: string[] = [];
  const offStatus = client.onStatus(detail => statuses.push(detail.status));
  const offReady = client.onReady(facade => ready.push(facade.version));
  events.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, {
    detail: { status: 'generating_ruin', detail: '伊雍正在编排历史节点' },
  }));
  events.dispatchEvent(new CustomEvent(WORKBENCH_READY_EVENT, {
    detail: makeFacade(),
  }));
  offStatus();
  offReady();
  events.dispatchEvent(new CustomEvent(WORKBENCH_STATUS_EVENT, {
    detail: { status: 'ignored', detail: '' },
  }));
  assert.deepEqual(statuses, ['generating_ruin']);
  assert.deepEqual(ready, ['test']);
});
