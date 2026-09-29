import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import {
  MemoryGenealogyRepository,
  type GenealogyRecord,
} from '../src/storage/genealogies.ts';
import {
  MemoryRuinCandidateRepository,
  type RuinCandidateRecord,
} from '../src/storage/ruins.ts';

const current: WorkbenchNamespace = { characterKey: 'eyon', chatId: 'chat-current' };
const other: WorkbenchNamespace = { characterKey: 'eyon', chatId: 'chat-other' };

test('clearing genealogy cache only removes the current chat namespace', async () => {
  const repository = new MemoryGenealogyRepository();
  await repository.save(genealogyRecord(current, 'current'));
  await repository.save(genealogyRecord(other, 'other'));

  assert.equal(await repository.clear(current), 1);
  assert.deepEqual(await repository.list(current), []);
  assert.equal((await repository.list(other)).length, 1);
});

test('clearing ruin cache only removes the current chat namespace', async () => {
  const repository = new MemoryRuinCandidateRepository();
  await repository.save(ruinRecord(current, 'current'));
  await repository.save(ruinRecord(other, 'other'));

  assert.equal(await repository.clear(current), 1);
  assert.deepEqual(await repository.list(current), []);
  assert.equal((await repository.list(other)).length, 1);
});

function genealogyRecord(
  namespace: WorkbenchNamespace,
  requestId: string,
): GenealogyRecord {
  return {
    key: `${namespace.chatId}:${requestId}`,
    namespace,
    requestId,
    triggerMessageId: 1,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    sourceHash: 'source',
    input: {} as GenealogyRecord['input'],
    result: {} as GenealogyRecord['result'],
    createdAt: 1,
  };
}

function ruinRecord(
  namespace: WorkbenchNamespace,
  requestId: string,
): RuinCandidateRecord {
  return {
    key: `${namespace.chatId}:${requestId}`,
    namespace,
    requestId,
    triggerMessageId: 1,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    sourceHash: 'source',
    input: {} as RuinCandidateRecord['input'],
    result: {} as RuinCandidateRecord['result'],
    expandedCandidateIds: [],
    createdAt: 1,
  };
}
