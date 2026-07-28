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
