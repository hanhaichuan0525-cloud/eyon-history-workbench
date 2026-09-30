import type { RuinContextBundle } from '../core/context.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import {
  deriveFeasibleWindow,
  parseWorldTime,
  personMentionedIn,
  personNameMatches,
} from '../retrieval/temporal.ts';

export interface AutomaticRuinRangeResolution {
  input: RuinGenerationInput;
  automatic: boolean;
}

/** 各纪元自动窗口的下界（防止随机落在纪元肇始之前）。上界不再有硬编码窗口：
 *  自动范围的上界 = 当前剧情时间（capYear）；剧情时间解析失败则不设上界。 */
const ERA_YEAR_MINIMUMS: Readonly<Record<string, number>> = {
  创世纪元: 120,
  神明纪元: 120,
  混乱纪元: 80,
  英雄纪元: 80,
  复兴纪元: 40,
};

/** 玩家完全留空时，把“自动”解析成可持久化、可复现的明确日期范围。 */
export function resolveAutomaticRuinRange(
  input: RuinGenerationInput,
  context: RuinContextBundle,
  mentionTexts: string[] = [],
): AutomaticRuinRangeResolution {
  if (input.start !== null || input.end !== null) return { input, automatic: false };

  const seed = [
    input.era,
    input.location,
    input.supplementaryDirection,
    ...input.materials.flatMap(material => [
      material.candidateKey,
      material.background,
      material.conflict,
      material.trigger,
    ]),
  ].join('|');
  const hash = stableHash(seed);
  const evidenceYears = collectEraYears(input.era, context);
  const durationYears = 3 + (hash % 10);
  const configuredMinimum = ERA_YEAR_MINIMUMS[input.era];
  if (configuredMinimum === undefined && evidenceYears.length === 0) {
    throw new Error(
      `自定义纪年“${input.era}”的世界书条目没有可解析的年份。`
      + '请在世界书中使用如“该纪年120年”的写法，或在工作台手动填写起止年份。',
    );
  }
  const minimum = configuredMinimum ?? evidenceYears[0];
  // 当前剧情时间上限：墟境穿越只能进入过去/现在，自动窗口不得越过剧情现在。
  // currentWorld.time 是每楼剧情时间。解析失败时不回退到任何硬编码上界
  // （旧 470 兜底曾把人物出生年钳回窗口内造成误拦，且 470 本身是拍脑袋数字）；
  // 此时自动窗口只受下界约束，跨度有限（≤24 年），不会失控。
  const now = parseWorldTime(context.currentWorld.time);
  const capYear = sameEra(now.era, input.era) && now.year !== null ? now.year : null;
  // 人物出生年下限：选中人物 + 补充方向/指令点名人物（无论选不选，点名即进入）中
  // 出生/抵达最晚者。玲山 27 岁（基准 488）→ 出生 461 → 自动范围不再落到她出生前。
  // 名字用保守匹配（覆盖关系列表 key 与选中人物名的全/简称不一致）。
  // 注意：人物下限只抬高不钳制——出生年可以晚于 capYear（如伊莲娜 472、出生仅数
  // 年的婴儿），自动窗口必须能够覆盖到他们。
  const selectedPersons = (context.evidenceBundle.personTimeline ?? [])
    .filter(entry => context.actorPolicy
      ? context.actorPolicy.requestedSubjects.some(name => personNameMatches(entry.name, name))
        || input.selectedCharacters.some(character => personNameMatches(entry.name, character.name)
          && !context.actorPolicy!.referenceNames.some(name => personNameMatches(entry.name, name)))
      : input.selectedCharacters.some(character =>
      personNameMatches(entry.name, character.name))
      || mentionTexts.some(text => personMentionedIn(text, entry.name)));
  const feasible = deriveFeasibleWindow(selectedPersons, context.currentWorld.time);
  const personFloor = feasible.earliestBorn
    && sameEra(feasible.earliestBorn.era, input.era)
    ? feasible.earliestBorn.year
    : null;
  const minimumEffective = personFloor === null
    ? minimum
    : Math.max(minimum, personFloor);
  const evidenceCenter = evidenceYears.length
    ? evidenceYears[Math.floor(evidenceYears.length / 2)]
    : null;

  let startYear: number;
  let endYear: number;
  if (capYear === null) {
    // 剧情时间解析失败：无上界，窗口 = [下界, 下界+跨度]（或史料年份居中）。
    const rawStart = evidenceCenter === null
      ? minimumEffective + (hash % 13)
      : Math.max(minimumEffective, evidenceCenter - Math.floor(durationYears / 2));
    startYear = rawStart;
    endYear = startYear + durationYears;
  } else {
    const maximum = capYear;
    const shortLifeWindow = personFloor !== null
      && maximum >= minimumEffective
      && maximum - minimumEffective <= 80;
    if (shortLifeWindow) {
      // 点名普通人物且其可用生涯本身不长时，自动范围是“可行包络”，
      // 不再用哈希把人物硬塞进出生后 3–12 年。具体故事发生在包络中的
      // 哪一段，交给模型依据事件前提、经历和世界书作出一次一致判断。
      startYear = minimumEffective;
      endYear = maximum;
    } else {
      const latestStart = Math.max(minimumEffective, maximum - durationYears);
      const rawStart = evidenceCenter === null
        ? minimumEffective + (hash % Math.max(1, latestStart - minimumEffective + 1))
        : Math.max(minimumEffective, Math.min(
            Math.max(1, evidenceCenter - Math.floor(durationYears / 2)),
            latestStart,
          ));
      startYear = Math.min(rawStart, latestStart);
      endYear = Math.min(startYear + durationYears, maximum);
    }
  }

  const startMonth = 1 + ((hash >>> 8) % 12);
  const startDay = 1 + ((hash >>> 16) % 28);
  let endMonth = 1 + ((hash >>> 4) % 12);
  let endDay = 1 + ((hash >>> 12) % 28);
  // 防御：窗口被上界压到同一年时，月/日不得倒置（start ≤ end 的硬不变量）。
  if (endYear === startYear) {
    if (endMonth < startMonth) {
      endMonth = startMonth;
      endDay = Math.max(endDay, startDay);
    } else if (endMonth === startMonth && endDay < startDay) {
      endDay = startDay;
    }
  }

  return {
    automatic: true,
    input: {
      ...input,
      start: { year: startYear, month: startMonth, day: startDay },
      end: { year: endYear, month: endMonth, day: endDay },
    },
  };
}

function sameEra(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return left.normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    === right.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function collectEraYears(era: string, context: RuinContextBundle): number[] {
  const escapedEra = era.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`${escapedEra}[^\\n。；]{0,16}?(\\d{1,6})年`, 'gu');
  const years = new Set<number>();
  for (const source of context.sourceIndex) {
    for (const match of source.content.matchAll(pattern)) {
      const year = Number(match[1]);
      if (Number.isInteger(year) && year > 0) years.add(year);
    }
  }
  return [...years].sort((left, right) => left - right);
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
