import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyPassageResponse } from '../src/schemas/biography.ts';
import { parseAndValidateBiographyPassage } from '../src/validators/biography.ts';

const requestId = 'bio-passage-001';
const sourceId = 'worldbook:维奥莱塔';
const knownSources = new Set([sourceId]);

function longText(): string {
  const passage = '她没有把这段关系当作宫廷传闻中的点缀，而是在一次次会面、书信、误解与和解中衡量欲望、责任和权力的边界。身边人的选择不断改变局势，她也必须为自己的决定承担真实后果。多年以后，这些具体经历仍留在她处理亲密关系与帝国事务的方式里，成为旁人能够察觉却无法轻易说破的旧痕。';
  return `${passage}${passage}${passage}${passage}`;
}

function makePassage(kind: 'origin' | 'stage' | 'status' = 'stage'): BiographyPassageResponse {
  return {
    schema: 'eyon.biography.passage.v1',
    requestId,
    passageId: kind === 'stage' ? 'stage-1' : kind,
    kind,
    title: kind === 'stage' ? '第1时期' : kind === 'origin' ? '起源(二十四岁)' : '现状(二十八岁)',
    content: longText(),
    people: ['维奥莱塔'],
    factions: [],
    objects: [],
    locations: ['皇宫'],
    sourceRefs: [sourceId],
    biographyUsage: [],
    eventId: `invented:${kind === 'stage' ? 'stage-1' : kind}:passage`,
    eventUsage: 'occurs',
    inference: true,
    elementChecklist: { sceneGrounded: true, figureVivid: true, decisiveMoment: true },
  };
}

test('合法单块正文通过校验', () => {
  const raw = makePassage('stage');
  const passage = parseAndValidateBiographyPassage(JSON.stringify(raw), {
    requestId, passageId: 'stage-1', kind: 'stage', eventId: raw.eventId, eventUsage: raw.eventUsage, knownSources,
  });
  assert.equal(passage.kind, 'stage');
  assert.ok(passage.content.length >= 450);
});

test('旧版连续性结构字段会被静默丢弃，不再污染普通正文协议', () => {
  const raw = {
    ...makePassage(),
    continuityClaim: '旧版正文事实锚',
    continuityRelations: [
      { kind: 'parallelView', currentEventRef: 'invented:stage-1:passage', otherHandle: 'C1' },
    ],
    continuityEventVerdicts: [{ pair: 'P1', verdict: 'sameEvent', dimension: 'time' }],
  };
  const parsed = parseAndValidateBiographyPassage(JSON.stringify(raw), {
    requestId, passageId: 'stage-1', kind: 'stage', eventId: raw.eventId,
    eventUsage: raw.eventUsage, knownSources,
  });
  const legacy = parsed as unknown as Record<string, unknown>;
  assert.equal(legacy.continuityClaim, undefined);
  assert.equal(legacy.continuityRelations, undefined);
  assert.equal(legacy.continuityEventVerdicts, undefined);
  assert.match(parsed.content, /她没有把这段关系/u);
});

test('当前场景地点语义只由提示词约束，不因脚本猜测外迁而截断正文', () => {
  const expected = {
    requestId,
    passageId: 'stage-1',
    kind: 'stage' as const,
    eventId: 'invented:stage-1:passage',
    eventUsage: 'occurs' as const,
    knownSources,
    directive: '对这皇宫中的黄昏花室进行寻根溯源',
    targetName: '黄昏花室',
    currentSceneLocation: '奥古斯提姆帝国-艾瑟嘉德-皇宫-黄昏花室',
  };
  const wrong = makePassage('stage');
  wrong.title = '花室初建';
  wrong.content = `黄昏花室坐落于瓦伦蒂亚城堡群。${longText()}`;
  assert.doesNotThrow(() => parseAndValidateBiographyPassage(JSON.stringify(wrong), expected));

  const allowed = makePassage('stage');
  allowed.title = '西廊增建';
  allowed.content = `工匠从瓦伦蒂亚城运来月光岩，在皇宫中的黄昏花室内部增建回廊。${longText()}`;
  assert.doesNotThrow(() => parseAndValidateBiographyPassage(JSON.stringify(allowed), expected));

  const runtimeCase = makePassage('stage');
  runtimeCase.title = '高塔余晖';
  runtimeCase.content = `黄昏花室位于艾瑟嘉德皇宫高塔。${longText()}`;
  assert.doesNotThrow(() => parseAndValidateBiographyPassage(JSON.stringify(runtimeCase), {
    ...expected,
    currentSceneLocation: '大陆中东部-奥古斯提姆帝国-艾瑟嘉德-皇宫高塔-黄昏花室',
  }));
});

test('正文过短报 PASSAGE_CONTENT_TOO_SHORT（带扩写指引）', () => {
  const passage = makePassage('stage');
  passage.content = '太短';
  assert.throws(
    () => parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'stage-1', kind: 'stage', eventId: passage.eventId, eventUsage: passage.eventUsage, knownSources,
    }),
    (error: unknown) => error instanceof Error
      && /minimum 260/u.test(error.message)
      && /补充方向/u.test(error.message),
  );
});

test('字数下限弹性（internal.79 v5）：260~299 软放行，不再 300 一刀切判死', () => {
  const passage = makePassage('stage');
  passage.content = '玲'.repeat(280);
  const chars = Array.from(passage.content.replace(/\s/gu, '')).length;
  assert.equal(chars, 280, 'fixture 应为 280 字（260~299 区间）');
  const parsed = parseAndValidateBiographyPassage(JSON.stringify(passage), {
    requestId, passageId: 'stage-1', kind: 'stage', eventId: passage.eventId, eventUsage: passage.eventUsage, knownSources,
  });
  assert.equal(parsed.content, passage.content, '软放行：短文通过且内容原样保留');
});

test('PASSAGE_SCHEMA_INVALID 报错可操作化：eventId 空/eventUsage 非法时给出修复指引', () => {
  const passage = makePassage('stage');
  (passage as { eventId: string }).eventId = '';
  (passage as { eventUsage: string }).eventUsage = 'consequence';
  assert.throws(
    () => parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'stage-1', kind: 'stage', eventId: 'fact:f1', eventUsage: 'occurs', knownSources,
    }),
    (error: unknown) => error instanceof Error
      && /PASSAGE_SCHEMA_INVALID|eventId|冻结事件|occurs/.test(error.message),
  );
  try {
    parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'stage-1', kind: 'stage', eventId: 'fact:f1', eventUsage: 'occurs', knownSources,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    assert.ok(message.includes('eventId 缺失或为空'), 'eventId 应给出中文修复指引');
    assert.ok(message.includes('aftermath / recollection'), 'eventUsage 应给出枚举指引');
    assert.ok(message.includes('occurred/aftermath/recollection/evidence/background')
      || message.includes('aftermath / recollection / evidence / background'), '枚举完整列出');
    assert.ok(message.includes('原始校验问题'), '原始 Zod issues 应保留供诊断');
  }
});

test('内容要素缺失报 PASSAGE_ELEMENT_MISSING', () => {
  const passage = makePassage('stage');
  passage.elementChecklist = { ...passage.elementChecklist, decisiveMoment: false };
  assert.throws(
    () => parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'stage-1', kind: 'stage', eventId: passage.eventId, eventUsage: passage.eventUsage, knownSources,
    }),
    /not satisfied/u,
  );
});

test('kind 与期望不符报 PASSAGE_IDENTITY_MISMATCH', () => {
  const passage = makePassage('origin');
  assert.throws(
    () => parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'origin', kind: 'stage', eventId: passage.eventId, eventUsage: passage.eventUsage, knownSources,
    }),
    /identity mismatch/u,
  );
});

test('编造 sourceId 报 PASSAGE_SOURCE_NOT_FOUND', () => {
  const passage = makePassage('stage');
  passage.sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateBiographyPassage(JSON.stringify(passage), {
      requestId, passageId: 'stage-1', kind: 'stage', eventId: passage.eventId, eventUsage: passage.eventUsage, knownSources,
    }),
    /unknown source reference/u,
  );
});
