import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MemoryRuinCharacterReferenceRepository,
  pruneStaleGenealogyReferences,
} from '../src/storage/ruinReferences.ts';

const firstChat = { characterKey: '命定之诗', chatId: '存档一' };
const secondChat = { characterKey: '命定之诗', chatId: '存档二' };
const character = {
  mvuId: '维奥莱塔',
  name: '维奥莱塔',
  source: 'genealogy' as const,
  identities: ['女皇'],
  race: '人类',
  professions: ['统治者'],
  relations: ['谱系中心'],
  lifespan: '复兴纪元464年 - 在世',
  contextSummary: '奥古斯提姆帝国女皇。',
};

test('墟境人物参考按角色卡与聊天隔离并去重', async () => {
  const repository = new MemoryRuinCharacterReferenceRepository();
  assert.deepEqual(await repository.read(firstChat), []);
  assert.deepEqual(
    await repository.write(firstChat, [character, character]),
    [character],
  );
  assert.deepEqual(await repository.read(firstChat), [character]);
  assert.deepEqual(await repository.read(secondChat), []);
});

test('墟境人物参考拒绝不完整的非 MVU 结构', async () => {
  const repository = new MemoryRuinCharacterReferenceRepository();
  await assert.rejects(
    () => repository.write(firstChat, [{
      ...character,
      mvuId: '',
    }]),
  );
});

test('同一人物的不同谱系记录按 referenceId 独立保存并精确去重', async () => {
  const repository = new MemoryRuinCharacterReferenceRepository();
  const older = {
    ...character,
    referenceId: 'genealogy:request-old:node-focus',
  };
  const newer = {
    ...character,
    referenceId: 'genealogy:request-new:node-focus',
    contextSummary: '重新构建后得到的新谱系人物简介。',
  };

  assert.deepEqual(
    await repository.write(firstChat, [older, newer, newer]),
    [older, newer],
  );
});

test('重建同一人物谱系时只清理旧版本的显式墟境引用', () => {
  const oldFocus = {
    ...character,
    referenceId: 'genealogy:request-old:node-focus',
  };
  const oldRelative = {
    ...character,
    mvuId: 'relative-old',
    name: '旧谱系亲属',
    referenceId: 'genealogy:request-old:node-relative',
  };
  const newestRelative = {
    ...character,
    mvuId: 'relative-new',
    name: '新谱系亲属',
    referenceId: 'genealogy:request-new:node-relative',
  };
  const otherPerson = {
    ...character,
    mvuId: 'other-focus',
    name: '其他人物谱系',
    referenceId: 'genealogy:request-other:node-focus',
  };
  const manual = {
    ...character,
    source: 'mvu' as const,
  };

  assert.deepEqual(
    pruneStaleGenealogyReferences(
      [oldFocus, oldRelative, newestRelative, otherPerson, manual, character],
      new Set(['request-old']),
      character.mvuId,
    ),
    [newestRelative, otherPerson, manual],
  );
});

test('重建谱系会清理没有记录身份的同人物旧式引用', () => {
  const legacy = { ...character };
  const unrelated = {
    ...character,
    mvuId: 'other-focus',
    name: '其他人物',
  };

  assert.deepEqual(
    pruneStaleGenealogyReferences(
      [legacy, unrelated],
      new Set(),
      character.mvuId,
    ),
    [unrelated],
  );
});
