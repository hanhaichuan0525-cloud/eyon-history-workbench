import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessPresenceInWindow,
  assessStagePerson,
  buildStagePersonTimeline,
  deriveFeasibleWindow,
  parseWorldTime,
  personAvailabilityLine,
  type PersonTimelineEntry,
  type StageSpanLike,
} from '../src/retrieval/temporal.ts';

test('自定义纪年可从世界时间开头精确解析', () => {
  assert.deepEqual(parseWorldTime('星辉历127年-4月-18日'), {
    era: '星辉历',
    year: 127,
  });
  assert.deepEqual(parseWorldTime('星辉历前12年'), {
    era: '星辉历',
    year: -12,
  });
});
import {
  collectPassageObjectStateEvidence,
  explicitAgeConflictNames,
  knownPersonNamesMentioned,
  revisionObjectStateConflictNames,
  softenExplicitAgeConflicts,
} from '../src/retrieval/prosePersonReview.ts';

/** 梅薇娜：488 年基准 88 岁 → 出生 400 年（ageBased，无死亡记录）。 */
const MEVINA: PersonTimelineEntry = {
  name: '梅薇娜·王尔德',
  state: 'alive',
  narrative: '',
  lifespan: {
    born: { era: '复兴纪元', year: 400 },
    ageAtRecord: 88,
    basedOnEra: '复兴纪元',
    basedOnYear: 488,
    ageBased: true,
  },
};

/** 有明确亡故的人物：复兴纪元400年出生，479年亡故。 */
const WITH_DIED: PersonTimelineEntry = {
  name: '凡多·灰袍',
  state: 'unknown',
  narrative: '',
  lifespan: {
    born: { era: '复兴纪元', year: 400 },
    died: { era: '复兴纪元', year: 479 },
  },
};

/** 界外来客：年龄为抵达后累计（抵达年即「出生」锚）。 */
const ARRIVAL: PersonTimelineEntry = {
  name: '镜中旅人',
  state: 'alive',
  narrative: '',
  lifespan: {
    born: { era: '复兴纪元', year: 400 },
    ageAtRecord: 88,
    basedOnEra: '复兴纪元',
    basedOnYear: 488,
    ageBased: true,
    arrivalBased: true,
  },
};

function span(start: Partial<StageSpanLike['start']>, end: Partial<StageSpanLike['end']>): StageSpanLike {
  return {
    start: { era: null, year: null, age: null, ...start },
    end: { era: null, year: null, age: null, ...end },
  };
}

test('在场段：整段落在出生后 → alive 且年龄区间 = 段年份 − 出生年', () => {
  const assessment = assessStagePerson(
    MEVINA,
    span({ era: '复兴纪元', year: 448 }, { era: '复兴纪元', year: 458 }),
  );
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 48, end: 58 });
  assert.match(assessment.guidance, /48~58/u);
  assert.match(assessment.guidance, /梅薇娜·王尔德在场/u);
  assert.match(assessment.guidance, /复兴纪元448年=48岁/u);
  assert.match(assessment.guidance, /复兴纪元458年=58岁/u);
});

test('明确短年份段逐年给出唯一年龄对照，避免从区间错取年龄', () => {
  const lingshan: PersonTimelineEntry = {
    name: '玲山·哈姆斯沃思',
    state: 'alive',
    narrative: '',
    lifespan: { born: { era: '复兴纪元', year: 461 } },
  };
  const assessment = assessStagePerson(
    lingshan,
    span({ era: '复兴纪元', year: 480 }, { era: '复兴纪元', year: 482 }),
  );
  assert.match(assessment.guidance, /复兴纪元480年=19岁/u);
  assert.match(assessment.guidance, /复兴纪元481年=20岁/u);
  assert.match(assessment.guidance, /复兴纪元482年=21岁/u);
  assert.match(assessment.guidance, /写到哪一年就只能采用该项/u);
});

test('正文人物复核只抓明确岁数冲突，并支持中文岁数与两字姓名', () => {
  const assessment = assessStagePerson(
    {
      name: '玲山·哈姆斯沃思',
      state: 'alive',
      narrative: '',
      lifespan: { born: { era: '复兴纪元', year: 461 } },
    },
    span({ era: '复兴纪元', year: 481 }, { era: '复兴纪元', year: 481 }),
  );
  assert.deepEqual(
    explicitAgeConflictNames('十二岁的玲山在押送途中抬起头。', [assessment]),
    ['玲山·哈姆斯沃思'],
  );
  assert.deepEqual(
    explicitAgeConflictNames('二十岁的玲山在押送途中抬起头。', [assessment]),
    [],
  );
  assert.deepEqual(
    explicitAgeConflictNames('玲山看起来仍很年轻，但正文没有精确年龄。', [assessment]),
    [],
  );
  assert.deepEqual(
    knownPersonNamesMentioned('玲山推开了门。', ['玲山·哈姆斯沃思', '梅薇娜·王尔德']),
    ['玲山·哈姆斯沃思'],
  );
});

test('最终年龄软护栏只删可证明的错龄，不改正确年龄与外貌年龄', () => {
  const assessment = assessStagePerson(
    {
      name: '玲山·哈姆斯沃思',
      state: 'alive',
      narrative: '',
      lifespan: { born: { era: '复兴纪元', year: 461 } },
    },
    span({ era: '复兴纪元', year: 481 }, { era: '复兴纪元', year: 481 }),
  );
  const reviewed = softenExplicitAgeConflicts(
    '十二岁的玲山冒雨越境。二十岁的玲山握紧相机。玲山看起来仍像十九岁的少女。',
    [assessment],
  );
  assert.doesNotMatch(reviewed.content, /十二岁的玲山/u);
  assert.match(reviewed.content, /玲山冒雨越境/u);
  assert.match(reviewed.content, /二十岁的玲山/u);
  assert.match(reviewed.content, /十九岁的少女/u);
  assert.deepEqual(reviewed.correctedNames, ['玲山·哈姆斯沃思']);
});

test('物品风险触发器只标记明确原件复活，修复、遗存物与同年叙事均放过', () => {
  const evidence = [{
    statement: '海因里希在梵尼亚黑曜监牢亲手撬毁玲山的黑曜石圣纹压制环。',
    temporalScope: '复兴纪元481年',
  }];
  const later = { era: '复兴纪元', startYear: 485, endYear: 485 };
  assert.deepEqual(
    revisionObjectStateConflictNames(
      '玲山抚摸着高领下冰冷的圣纹压制环，继续审阅稿件。',
      ['圣纹压制环'],
      later,
      evidence,
    ),
    ['圣纹压制环'],
  );
  assert.deepEqual(
    revisionObjectStateConflictNames(
      '玲山收好重新修复的圣纹压制环。',
      ['圣纹压制环'],
      later,
      evidence,
    ),
    [],
  );
  assert.deepEqual(
    revisionObjectStateConflictNames(
      '海因里希撬毁了玲山颈间的圣纹压制环。',
      ['圣纹压制环'],
      { era: '复兴纪元', startYear: 481, endYear: 481 },
      evidence,
    ),
    [],
  );

  for (const allowed of [
    '她颈间只剩圣纹压制环留下的勒痕。',
    '她把圣纹压制环的断裂残片收进匣中。',
    '她看着旧照片中的圣纹压制环。',
    '她佩戴着后来重制的圣纹压制环替代品。',
  ]) {
    assert.deepEqual(
      revisionObjectStateConflictNames(
        allowed,
        ['圣纹压制环'],
        { era: '复兴纪元', startYear: 488, endYear: 488 },
        evidence,
      ),
      [],
    );
  }
});

test('已校验前文的物品终止状态可成为本篇临时证据，不依赖全局 Canon', () => {
  const evidence = collectPassageObjectStateEvidence(
    '海因里希撬毁了玲山颈间的圣纹压制环。雨水冲走了碎屑。',
    ['圣纹压制环'],
    '复兴纪元481年',
  );
  assert.deepEqual(evidence, [{
    statement: '海因里希撬毁了玲山颈间的圣纹压制环。',
    temporalScope: '复兴纪元481年',
  }]);
  assert.deepEqual(
    collectPassageObjectStateEvidence(
      '海因里希并未撬毁玲山颈间的圣纹压制环。',
      ['圣纹压制环'],
      '复兴纪元481年',
    ),
    [],
  );
  assert.deepEqual(
    collectPassageObjectStateEvidence(
      '海因里希没有执行逮捕，而是用重剑亲手撬毁了玲山颈间的圣纹压制环。',
      ['圣纹压制环'],
      '复兴纪元481年',
    ),
    [{
      statement: '海因里希没有执行逮捕，而是用重剑亲手撬毁了玲山颈间的圣纹压制环。',
      temporalScope: '复兴纪元481年',
    }],
  );
  assert.deepEqual(
    revisionObjectStateConflictNames(
      '复兴纪元488年，她的高领下若隐若现着那枚圣纹压制环。',
      ['圣纹压制环'],
      { era: '复兴纪元', startYear: 488, endYear: 488 },
      evidence,
    ),
    ['圣纹压制环'],
  );
});

test('未出生段：整段早于出生 → before-birth 且含缺席叙事方针', () => {
  const assessment = assessStagePerson(
    MEVINA,
    span({ era: '复兴纪元', year: 300 }, { era: '复兴纪元', year: 310 }),
  );
  assert.equal(assessment.state, 'before-birth');
  assert.deepEqual(assessment.ageRange, { start: null, end: null });
  assert.match(assessment.guidance, /尚不存在/u);
  assert.match(assessment.guidance, /缺席叙事/u);
  assert.match(assessment.guidance, /异界来源/u);
});

test('跨纪元未出生段：神明纪元早于复兴纪元出生年 → before-birth', () => {
  const assessment = assessStagePerson(
    MEVINA,
    span({ era: '神明纪元', year: 1 }, { era: '神明纪元', year: 100 }),
  );
  assert.equal(assessment.state, 'before-birth');
});

test('已故段：整段晚于亡故 → after-death 且含遗产缺席方针', () => {
  const assessment = assessStagePerson(
    WITH_DIED,
    span({ era: '复兴纪元', year: 485 }, { era: '复兴纪元', year: 488 }),
  );
  assert.equal(assessment.state, 'after-death');
  assert.match(assessment.guidance, /已不在世/u);
  assert.match(assessment.guidance, /遗产/u);
});

test('段内出生跨接：段首早于出生、段末晚于出生 → alive 且年龄从 0 起', () => {
  const assessment = assessStagePerson(
    MEVINA,
    span({ era: '复兴纪元', year: 390 }, { era: '复兴纪元', year: 410 }),
  );
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 0, end: 10 });
  assert.match(assessment.guidance, /横跨其出生/u);
});

test('段内亡故跨接：段末晚于亡故 → alive 且年龄封顶于亡故年', () => {
  const assessment = assessStagePerson(
    WITH_DIED,
    span({ era: '复兴纪元', year: 470 }, { era: '复兴纪元', year: 490 }),
  );
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 70, end: 79 });
  assert.match(assessment.guidance, /横跨其亡故/u);
});

test('段起止缺纪元：回退 contextEra 换算（同纪元省略纪元名）', () => {
  const assessment = assessStagePerson(
    MEVINA,
    span({ year: 448 }, { year: 458 }),
    '复兴纪元',
  );
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 48, end: 58 });
});

test('纯年龄锚点段：直接用规划年龄锚，判定在场', () => {
  const assessment = assessStagePerson(MEVINA, span({ age: 48 }, { age: 58 }));
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 48, end: 58 });
  assert.match(assessment.guidance, /规划年龄锚点/u);
});

test('生卒窗口缺失 → unknown 且不约束', () => {
  const assessment = assessStagePerson(
    { name: '路人甲', state: 'unknown', narrative: '' },
    span({ era: '复兴纪元', year: 300 }, { era: '复兴纪元', year: 310 }),
  );
  assert.equal(assessment.state, 'unknown');
});

test('界外来客：在场结论带「抵达后累计」注解', () => {
  const assessment = assessStagePerson(
    ARRIVAL,
    span({ era: '复兴纪元', year: 448 }, { era: '复兴纪元', year: 458 }),
  );
  assert.equal(assessment.state, 'alive');
  assert.match(assessment.guidance, /界外来客/u);
});

test('personAvailabilityLine：年龄换算 + 在世缺省 + 已故 + 界外来客', () => {
  assert.equal(
    personAvailabilityLine(MEVINA),
    '【梅薇娜·王尔德】出生/抵达复兴纪元400年（由基准时间复兴纪元488年时88岁推算）— 在世（无死亡记录）',
  );
  assert.match(personAvailabilityLine(WITH_DIED) ?? '', /复兴纪元479年（已故）/u);
  assert.match(personAvailabilityLine(ARRIVAL) ?? '', /界外来客/u);
  assert.equal(personAvailabilityLine({ name: '路人甲', state: 'unknown', narrative: '' }), null);
});

test('buildStagePersonTimeline：逐段分组输出，unknown 保留供调用方过滤', () => {
  const timeline = buildStagePersonTimeline(
    [
      { id: 'stage-1', span: span({ era: '复兴纪元', year: 300 }, { era: '复兴纪元', year: 310 }) },
      { id: 'stage-2', span: span({ era: '复兴纪元', year: 448 }, { era: '复兴纪元', year: 458 }) },
    ],
    [MEVINA, { name: '路人甲', state: 'unknown', narrative: '' }],
  );
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0]!.stageId, 'stage-1');
  assert.equal(timeline[0]!.assessments[0]!.state, 'before-birth');
  assert.equal(timeline[1]!.assessments[0]!.state, 'alive');
  assert.equal(timeline[0]!.assessments[1]!.state, 'unknown');
});

test('deriveFeasibleWindow：下界 = 最晚出生年，上界 = 当前剧情时间；无信息为 empty', () => {
  const window = deriveFeasibleWindow([MEVINA], '复兴纪元488年-10月-16日-星期日-22:45');
  assert.equal(window.empty, false);
  assert.deepEqual(window.earliestBorn, { era: '复兴纪元', year: 400 });
  assert.deepEqual(window.latestAllowed, { era: '复兴纪元', year: 488 });
  assert.equal(window.earliestBornInferred, true);

  // 多人物取下界最晚者。
  const multi = deriveFeasibleWindow(
    [MEVINA, WITH_DIED],
    '复兴纪元488年',
  );
  assert.deepEqual(multi.earliestBorn, { era: '复兴纪元', year: 400 });

  // 无人物/无生卒信息 → empty（调用方回退现状，不误伤）。
  const empty = deriveFeasibleWindow([], '复兴纪元488年');
  assert.equal(empty.empty, true);
  assert.equal(empty.earliestBorn, null);
  const noInfo = deriveFeasibleWindow(
    [{ name: '路人甲', state: 'unknown', narrative: '' }],
    '复兴纪元488年',
  );
  assert.equal(noInfo.empty, true);

  // 当前时间解析失败 → 上界 null（不误伤）。
  const noNow = deriveFeasibleWindow([MEVINA], '未知时刻');
  assert.equal(noNow.latestAllowed, null);
  assert.deepEqual(noNow.earliestBorn, { era: '复兴纪元', year: 400 });
});

test('assessPresenceInWindow：引擎公用入口与 assessStagePerson 同源', () => {
  const assessment = assessPresenceInWindow(
    MEVINA,
    span({ era: '复兴纪元', year: 448 }, { era: '复兴纪元', year: 458 }),
  );
  assert.equal(assessment.state, 'alive');
  assert.deepEqual(assessment.ageRange, { start: 48, end: 58 });
});
