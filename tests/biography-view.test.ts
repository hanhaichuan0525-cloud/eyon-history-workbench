import assert from 'node:assert/strict';
import test from 'node:test';
import type { Biography } from '../src/schemas/biography.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';
import {
  biographyDisplayTitle,
  toBiographyShelfItem,
  visibleBiographyItems,
} from '../src/ui/biographyView.ts';

function record(
  key: string,
  name: string,
  updatedAt: number,
  status: 'validated' | 'committed' = 'committed',
): BiographyRecord {
  const biography = {
    target: { type: 'person', name, aliases: ['旧名'] },
    playerDirective: { primaryDirection: '猎艳史' },
    span: { label: '复兴纪元430—488年' },
    stages: [{}, {}],
    summary: '一份存在冲突的王庭档案。',
    indexes: {
      people: [name],
      factions: ['虚嗣王庭'],
      locations: ['金谷城'],
      themes: ['冲突史料'],
    },
  } as unknown as Biography;
  return {
    key,
    namespace: { characterKey: '伊雍', chatId: 'chat' },
    biographyId: key,
    requestId: key,
    triggerMessageId: 1,
    assistantMessageId: 2,
    sourceHash: key,
    status,
    revision: 1,
    biography,
    createdAt: updatedAt,
    updatedAt,
  };
}

test('旧传记按对象与跨度生成可区分书名，不再按类型派生地志/器物志', () => {
  const person = record('person', '伊雍', 1).biography;
  assert.equal(biographyDisplayTitle(person), '《伊雍传·复兴纪元430—488年》');
  assert.equal(biographyDisplayTitle({
    ...person,
    target: { ...person.target, type: 'region', name: '金谷城' },
  }), '《金谷城传·复兴纪元430—488年》');
  assert.equal(biographyDisplayTitle({
    ...person,
    target: { ...person.target, type: 'object', name: '皇袍上的第三颗盘扣' },
  }), '《皇袍上的第三颗盘扣传·复兴纪元430—488年》');
});

test('展示建议让同一对象的不同传记拥有不同标题，正文卡与工作台共用短副标题', () => {
  const base = record('life', '千爻', 1);
  const life = {
    ...base,
    biography: {
      ...base.biography,
      playerDirective: {
        ...base.biography.playerDirective,
        raw: '好的！伊雍，现在继续进行寻根溯源，写千爻的生平传记',
        primaryDirection: '写千爻的生平传记',
      },
      presentation: {
        title: '千爻生平传',
        subtitle: '从异乡流亡到重建自我的完整生命轨迹',
      },
    },
  } as BiographyRecord;
  const decade = {
    ...base,
    key: 'decade',
    biographyId: 'decade',
    biography: {
      ...base.biography,
      span: { ...base.biography.span, label: '复兴纪元478—488年' },
      presentation: {
        title: '千爻·索伦蒂斯十年',
        subtitle: '十年异乡生活如何改变她的选择与归属',
      },
    },
  } as BiographyRecord;

  const lifeItem = toBiographyShelfItem(life);
  const decadeItem = toBiographyShelfItem(decade);
  assert.equal(lifeItem.title, '《千爻生平传》');
  assert.equal(decadeItem.title, '《千爻·索伦蒂斯十年》');
  assert.notEqual(lifeItem.title, decadeItem.title);
  assert.equal(lifeItem.subtitle, life.biography.presentation?.subtitle);
  assert.doesNotMatch(lifeItem.subtitle, /好的|伊雍|寻根溯源/u);
});

test('不合格展示建议静默回退，不把玩家原始指令展示为副标题', () => {
  const raw = '好的！伊雍，现在继续进行寻根溯源，写千爻的生平传记';
  const base = record('legacy', '千爻', 1);
  const biography = {
    ...base.biography,
    playerDirective: { raw, primaryDirection: raw },
    presentation: { title: '千爻传', subtitle: raw },
    summary: '她在十年异乡生活里逐渐重建自己的归属与判断。',
  } as Biography;
  const item = toBiographyShelfItem({ ...base, biography });
  assert.equal(item.title, '《千爻传·复兴纪元430—488年》');
  assert.notEqual(item.subtitle, raw);
  assert.ok(Array.from(item.subtitle).length <= 36);
});

test('传记书架展示已校验与已提交记录，按更新时间排序并支持资料检索', () => {
  const records = [
    record('old', '伊雍', 10),
    record('new', '维奥莱塔', 20),
    record('draft', '未提交', 30, 'validated'),
  ];
  assert.deepEqual(
    visibleBiographyItems(records).map(item => item.record.key),
    ['draft', 'new', 'old'],
  );
  assert.deepEqual(
    visibleBiographyItems(records, '猎艳').map(item => item.record.key),
    ['draft', 'new', 'old'],
  );
  assert.deepEqual(
    visibleBiographyItems(records, '维奥莱塔').map(item => item.record.key),
    ['new'],
  );
});
