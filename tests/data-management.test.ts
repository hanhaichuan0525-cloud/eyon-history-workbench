import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkbenchBackup,
  inspectWorkbenchData,
  type WorkbenchDataCollection,
} from '../src/runtime/dataManagement.ts';
import { WorkbenchSettingsSchema } from '../src/runtime/workbenchSettings.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';

const namespace = { characterKey: 'eyon', chatId: 'chat-1' };

function emptyData(): WorkbenchDataCollection {
  return {
    biographies: [],
    genealogies: [],
    ruins: [],
    butterflies: [],
    pendingButterflies: [],
    canonMemoryTombstones: [],
    ruinReferences: [],
  };
}

test('资料完整性检查只接受当前聊天且不重复的记录', () => {
  const data = emptyData();
  data.ruinReferences = [reference('character-1')];
  const report = inspectWorkbenchData(namespace, data);
  assert.equal(report.healthy, true);
  assert.equal(report.counts.ruinReferences, 1);
});

test('资料完整性检查能发现跨聊天记录和重复参考人物', () => {
  const data = emptyData();
  data.biographies = [{
    namespace: { characterKey: 'eyon', chatId: 'chat-2' },
    requestId: 'request-1',
  } as BiographyRecord];
  const selected = reference('character-1');
  data.ruinReferences = [selected, selected];
  const report = inspectWorkbenchData(namespace, data);
  assert.equal(report.healthy, false);
  assert.equal(report.issues.length, 2);
});

test('导出备份保留模块配置但剔除独立API密钥', () => {
  const settings = WorkbenchSettingsSchema.parse({
    generation: {
      ruin: {
        apiurl: 'https://example.test/v1',
        key: 'secret',
        model: 'model',
        source: 'openai',
        maxTokens: 4096,
        temperature: 0.8,
      },
    },
  });
  const backup = createWorkbenchBackup(
    '0.10.0-internal.1',
    namespace,
    settings,
    emptyData(),
  );
  const ruin = backup.settings.generation.ruin;
  assert.equal(ruin.apiurl, 'https://example.test/v1');
  assert.equal(ruin.key, '');
  assert.equal(settings.generation.ruin.key, 'secret');
});

function reference(mvuId: string) {
  return {
    mvuId,
    name: '伊雍',
    source: 'mvu' as const,
    identities: [],
    race: '',
    professions: [],
    relations: [],
    lifespan: '',
    contextSummary: '',
  };
}
