import assert from 'node:assert/strict';
import test from 'node:test';

import type { ContextSource } from '../src/core/context.ts';
import { selectBiographyEvidence } from '../src/runtime/biographyEvidence.ts';

function source(
  sourceId: string,
  title: string,
  content: string,
  keywords: string[] = [],
): ContextSource {
  return {
    sourceId,
    sourceType: 'worldbook',
    title,
    content,
    authority: 100,
    keywords,
  };
}

test('传记实体补召回按精确标题找到既有人物身份', () => {
  const ilena = source(
    'worldbook:伊莲娜',
    '[角色]伊莲娜·A·梦露',
    '伊莲娜·A·梦露:\n  身份: 白鲸杂志社社长\n  职业: 时尚杂志主编',
  );
  const selected = selectBiographyEvidence(
    ['伊莲娜·A·梦露'],
    [],
    [],
    [ilena],
  );
  assert.deepEqual(selected.map(item => item.sourceId), ['worldbook:伊莲娜']);
});

test('短姓名也能从角色标题的显式名称槽精确命中', () => {
  const rhys = source(
    'worldbook:瑞丝',
    '[DLC][角色][瑞丝]瑞丝(rhys-血族)',
    '瑞丝:\n  身份: 棺材里的少女',
  );
  assert.deepEqual(
    selectBiographyEvidence(['瑞丝'], [], [], [rhys]).map(item => item.sourceId),
    ['worldbook:瑞丝'],
  );
});

test('传记实体补召回支持条目显式别名，但不按正文偶然提及宽泛命中', () => {
  const namedByAlias = source(
    'worldbook:报业女王',
    '[角色]玲山·哈姆斯沃思',
    '别名: 风暴剪报人、头版女王\n身份: 琉璃塔信报社社长',
  );
  const incidentalMention = source(
    'worldbook:帝国报业史',
    '[历史]帝国报业史',
    '某一期杂志曾顺带提到伊莲娜·A·梦露，但这里不是她的人物条目。',
  );

  assert.deepEqual(
    selectBiographyEvidence(['头版女王'], [], [], [namedByAlias, incidentalMention])
      .map(item => item.sourceId),
    ['worldbook:报业女王'],
  );
  assert.deepEqual(
    selectBiographyEvidence(['伊莲娜·A·梦露'], [], [], [incidentalMention]),
    [],
  );
});

test('传记实体补召回不会阻止原创人物，直接冻结引用仍保持最高优先', () => {
  const frozen = source('worldbook:玲山', '[角色]玲山·哈姆斯沃思', '身份: 琉璃塔信报社社长');
  const catalog = source('worldbook:伊莲娜', '[角色]伊莲娜·A·梦露', '身份: 白鲸杂志社社长');

  assert.deepEqual(
    selectBiographyEvidence(['原创装订师赛拉斯'], [], [frozen], [catalog]),
    [],
  );
  assert.deepEqual(
    selectBiographyEvidence([], ['worldbook:玲山'], [frozen], [catalog])
      .map(item => item.sourceId),
    ['worldbook:玲山'],
  );
});
