import assert from 'node:assert/strict';
import test from 'node:test';
import { CharacterCatalogService } from '../src/runtime/characterCatalog.ts';
import {
  MemoryCharacterVisibilityRepository,
} from '../src/storage/characterVisibility.ts';

const chatA = { characterKey: '命定之诗', chatId: '存档一' };
const chatB = { characterKey: '命定之诗', chatId: '存档二' };

function sources() {
  return {
    async getCharacterSources() {
      return [
        {
          sourceId: 'mvu-character:维奥莱塔',
          title: '维奥莱塔',
          content: JSON.stringify({ name: '维奥莱塔', 种族: '人类', 等级: 24 }),
        },
        {
          sourceId: 'mvu-character:伊伽',
          title: '伊伽',
          content: JSON.stringify({ name: '伊伽', 种族: '精灵' }),
        },
      ];
    },
  };
}

test('界面隐藏人物不改MVU来源，同步后恢复全部人物', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  const service = new CharacterCatalogService(
    sources(),
    repository,
    () => chatA,
    () => 100,
  );

  const initial = await service.getCatalog();
  assert.deepEqual(initial.characters.map(character => character.id), [
    '维奥莱塔',
    '伊伽',
  ]);

  const hidden = await service.hide('维奥莱塔');
  assert.deepEqual(hidden.characters.map(character => character.id), ['伊伽']);
  assert.equal(hidden.hiddenCount, 1);
  assert.equal(hidden.totalCount, 2);
  assert.equal((await sources().getCharacterSources()).length, 2);

  const restored = await service.sync();
  assert.deepEqual(restored.characters.map(character => character.id), [
    '维奥莱塔',
    '伊伽',
  ]);
  assert.equal(restored.hiddenCount, 0);
});

test('人物隐藏清单按角色卡与聊天存档隔离', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  let namespace = chatA;
  const service = new CharacterCatalogService(
    sources(),
    repository,
    () => namespace,
  );

  await service.hide('伊伽');
  namespace = chatB;
  assert.deepEqual(
    (await service.getCatalog()).characters.map(character => character.id),
    ['维奥莱塔', '伊伽'],
  );
  namespace = chatA;
  assert.deepEqual(
    (await service.getCatalog()).characters.map(character => character.id),
    ['维奥莱塔'],
  );
});

test('人物目录修改期间切换聊天会拒绝落库', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  let namespace = chatA;
  const service = new CharacterCatalogService(
    {
      async getCharacterSources() {
        namespace = chatB;
        return sources().getCharacterSources();
      },
    },
    repository,
    () => namespace,
  );

  await assert.rejects(
    () => service.hide('维奥莱塔'),
    /聊天已经切换/u,
  );
  assert.equal(await repository.get(chatA), null);
  assert.equal(await repository.get(chatB), null);
});

test('custom groups support create, rename, and single-group assignment', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  const ids = ['a', 'b'];
  const service = new CharacterCatalogService(
    sources(),
    repository,
    () => chatA,
    () => 100,
    () => ids.shift() ?? 'fallback',
  );

  let catalog = await service.createGroup('重点溯源');
  assert.deepEqual(catalog.groups, [{
    id: 'group-a',
    name: '重点溯源',
    characterIds: [],
    order: 0,
  }]);
  catalog = await service.createGroup('墟境关联');
  catalog = await service.moveCharacter('维奥莱塔', 'group-a');
  catalog = await service.moveCharacter('维奥莱塔', 'group-b');
  assert.deepEqual(catalog.groups.map(group => group.characterIds), [
    [],
    ['维奥莱塔'],
  ]);

  catalog = await service.renameGroup('group-b', '王庭档案');
  assert.equal(catalog.groups[1]?.name, '王庭档案');
});

test('deleting a group only unassigns characters, while sync preserves groups', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  const service = new CharacterCatalogService(
    sources(),
    repository,
    () => chatA,
    () => 100,
    () => 'stable',
  );

  await service.createGroup('重点溯源');
  await service.moveCharacter('伊伽', 'group-stable');
  await service.hide('伊伽');
  const synced = await service.sync();
  assert.deepEqual(synced.characters.map(character => character.id), [
    '维奥莱塔',
    '伊伽',
  ]);
  assert.deepEqual(synced.groups[0]?.characterIds, ['伊伽']);

  const deleted = await service.deleteGroup('group-stable');
  assert.deepEqual(deleted.groups, []);
  assert.deepEqual(deleted.characters.map(character => character.id), [
    '维奥莱塔',
    '伊伽',
  ]);
});

test('custom groups reject empty names, duplicate names, and unknown characters', async () => {
  const service = new CharacterCatalogService(
    sources(),
    new MemoryCharacterVisibilityRepository(),
    () => chatA,
    Date.now,
    () => 'stable',
  );
  assert.throws(() => service.createGroup('  '), /组别名称不能为空/u);
  await service.createGroup('重点溯源');
  await assert.rejects(() => service.createGroup('重点溯源'), /同名组别/u);
  await assert.rejects(
    () => service.moveCharacter('不存在的人物', 'group-stable'),
    /没有这个人物/u,
  );
});

test('custom groups are isolated by character card and chat', async () => {
  const repository = new MemoryCharacterVisibilityRepository();
  let namespace = chatA;
  const service = new CharacterCatalogService(
    sources(),
    repository,
    () => namespace,
    () => 100,
    () => namespace.chatId,
  );

  await service.createGroup('存档一组别');
  namespace = chatB;
  assert.deepEqual((await service.getCatalog()).groups, []);
  await service.createGroup('存档二组别');
  namespace = chatA;
  assert.deepEqual(
    (await service.getCatalog()).groups.map(group => group.name),
    ['存档一组别'],
  );
});
