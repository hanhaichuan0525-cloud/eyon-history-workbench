import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkbenchNamespace } from '../src/core/namespace.ts';
import {
  MemoryGenealogyRepository,
  genealogyBelongsToCharacter,
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

test('单人物清空同时删除新旧谱系，保留其他人物、同名不同ID和其他聊天', async () => {
  const repository = new MemoryGenealogyRepository();
  const person = { mvuId: '玲山-id', name: '玲山·哈姆斯沃思' };
  const record = (namespace: WorkbenchNamespace, key: string, id: string, name = person.name) => ({
    ...genealogyRecord(namespace, key),
    result: { focusCharacterId: id, focusCharacterName: name } as GenealogyRecord['result'],
  });
  await repository.save(record(current, 'old', person.mvuId));
  await repository.save(record(current, 'new', person.mvuId));
  await repository.save(record(current, 'legacy', '', ' 玲山·哈姆斯沃思 '));
  await repository.save(record(current, 'same-name', '别的-id'));
  await repository.save(record(current, 'other-person', '珊奈-id', '美墨珊奈'));
  await repository.save(record(other, 'other-chat', person.mvuId));
  assert.deepEqual((await repository.clearCharacter(current, person)).map(item => item.requestId).sort(), ['legacy', 'new', 'old']);
  assert.deepEqual((await repository.list(current)).map(item => item.requestId).sort(), ['other-person', 'same-name']);
  assert.equal((await repository.list(other)).length, 1);
  assert.deepEqual(await repository.clearCharacter(current, person), [], '再次清空不影响剩余人物');
});

test('旧谱系输入仍有MVU身份时，不因姓名相同删错；特殊身份不影响归属', () => {
  const record = genealogyRecord(current, 'creation');
  record.input = { focusCharacter: { mvuId: '构装-id', name: '艾琳一号', aliases: [] }, depth: { ancestors: 4, descendants: 0, maxPerGeneration: 7 }, lineageKind: 'creation' };
  record.result = { focusCharacterName: '艾琳一号' } as GenealogyRecord['result'];
  assert.equal(genealogyBelongsToCharacter(record, { mvuId: '同名-id', name: '艾琳一号' }), false);
  assert.equal(genealogyBelongsToCharacter(record, { mvuId: '构装-id', name: '已改名' }), true);
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
