import { z } from 'zod';
import type { CanonFact } from './contracts.ts';
import { parseWorldTime } from './temporal.ts';

/** Open-domain evidence, never a classifier for player prose. */
export const ContinuousStateSchema = z.object({
  dimension: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(160),
  start: z.string().trim().min(1).max(100),
  end: z.string().trim().min(1).max(100).optional(),
  world: z.string().trim().min(1).max(80).optional(),
});
export type ContinuousState = z.infer<typeof ContinuousStateSchema>;
export interface ContinuousStateInterval extends ContinuousState {
  entityId: string;
  factId: string;
  sourceFactIds: string[];
  certainty: 'supported' | 'uncertain';
  reason?: string;
}
type DateRange = { era: string; min: number; max: number };

/** Partial dates remain ranges; no guessed season or cross-world order. */
function dateRange(label: string): DateRange | null {
  const point = parseWorldTime(label);
  if (!point.era || point.year === null) return null;
  const tail = label.normalize('NFKC').split('年').slice(1).join('年');
  const month = tail.match(/^[-\s]*(\d{1,2})月/u);
  const day = tail.match(/^[-\s]*\d{1,2}月[-\s]*(\d{1,2})日/u);
  const m = month ? Number(month[1]) : null;
  const d = day ? Number(day[1]) : null;
  const clock = tail.split('日')[1]?.match(/^[-\s]*(\d{1,2})[:：时](\d{1,2})(?:分)?/u);
  const hour = clock ? Number(clock[1]) : 0;
  const minute = clock ? Number(clock[2]) : 0;
  if ((m !== null && (m < 1 || m > 12)) || (d !== null && (d < 1 || d > 31))) return null;
  if (hour > 23 || minute > 59) return null;
  const base = point.year * 372;
  return {
    era: point.era,
    min: (base + (m === null ? 0 : (m - 1) * 31) + (d === null ? 0 : d - 1)) * 1440 + hour * 60 + minute,
    max: (base + (m === null ? 371 : (m - 1) * 31 + (d === null ? 30 : d - 1))) * 1440
      + (d === null ? 1439 : hour * 60 + minute),
  };
}

/** Derived only from resolved active facts; rollback rebuilds, never edits history. */
export function projectContinuousStates(facts: readonly CanonFact[]): ContinuousStateInterval[] {
  const groups = new Map<string, Array<{ fact: CanonFact; state: ContinuousState }>>();
  for (const fact of facts) {
    const parsed = ContinuousStateSchema.safeParse(fact.continuousState);
    if (!parsed.success || fact.revisionRetired !== null) continue;
    const state = parsed.data;
    const key = JSON.stringify([fact.subjectEntityId, state.dimension, state.world ?? '']);
    const row = groups.get(key) ?? [];
    row.push({ fact, state }); groups.set(key, row);
  }
  const output: ContinuousStateInterval[] = [];
  for (const row of groups.values()) {
    const dated = row.flatMap(other => {
      const point = dateRange(other.state.start);
      return point && other.fact.confidence !== 'low'
        && !['reported', 'contested', 'inferred'].includes(other.fact.epistemicStatus) ? [{ ...other, point }] : [];
    }).sort((a, b) => a.point.era.localeCompare(b.point.era) || a.point.min - b.point.min || a.fact.factId.localeCompare(b.fact.factId));
    const byEra = new Map<string, typeof dated>();
    for (const item of dated) {
      const ordered = byEra.get(item.point.era) ?? []; ordered.push(item); byEra.set(item.point.era, ordered);
    }
    for (const { fact, state } of row) {
      const start = dateRange(state.start);
      const uncertain = !start || fact.confidence === 'low'
        || ['reported', 'contested', 'inferred'].includes(fact.epistemicStatus);
      const item: ContinuousStateInterval = {
        ...state, entityId: fact.subjectEntityId, factId: fact.factId,
        sourceFactIds: [fact.factId], certainty: uncertain ? 'uncertain' : 'supported',
        ...(uncertain ? { reason: 'date-or-evidence-unresolved' } : {}),
      };
      if (start) {
        const ordered = byEra.get(start.era) ?? [];
        let lo = 0; let hi = ordered.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (ordered[mid].point.min <= start.max) lo = mid + 1; else hi = mid;
        }
        const next = ordered[lo];
        const end = state.end ? dateRange(state.end) : null;
        if (state.end && (!end || end.era !== start.era || end.max <= start.min)) {
          item.certainty = 'uncertain'; item.reason = 'end-unresolved-or-reversed';
        }
        if (next && (!state.end || (end && next.point.max < end.min))) {
          item.end = next.state.start; item.sourceFactIds.push(next.fact.factId);
        }
      }
      output.push(item);
    }
  }
  return output.sort((a, b) => a.entityId.localeCompare(b.entityId)
    || a.dimension.localeCompare(b.dimension) || a.start.localeCompare(b.start)
    || a.factId.localeCompare(b.factId));
}

/** Half-open intervals; ambiguity is returned, never guessed away. */
export function continuousStateAt(
  intervals: readonly ContinuousStateInterval[], entityId: string, dimension: string,
  at: string, world?: string,
): { status: 'known' | 'unknown'; value?: string; factIds: string[]; reason?: string } {
  const query = dateRange(at);
  const row = intervals.filter(item => item.entityId === entityId && item.dimension === dimension
    && (world === undefined || item.world === world));
  const candidates: ContinuousStateInterval[] = [];
  let unresolved = !query;
  for (const item of row) {
    const start = dateRange(item.start);
    const end = item.end ? dateRange(item.end) : null;
    if (!query || !start || query.era !== start.era) { unresolved = true; continue; }
    if (query.max < start.min || (end && query.min >= end.max)) continue;
    if (query.min < start.max || (end && query.max >= end.min)
      || item.certainty !== 'supported' || (item.end && !end)) unresolved = true;
    candidates.push(item);
  }
  const values = new Set(candidates.map(item => item.value));
  const worlds = new Set(candidates.map(item => item.world ?? ''));
  const factIds = [...new Set(candidates.flatMap(item => item.sourceFactIds))].sort();
  return !unresolved && values.size === 1 && worlds.size === 1
    ? { status: 'known', value: [...values][0], factIds }
    : { status: 'unknown', factIds, reason: values.size > 1 || worlds.size > 1 ? 'conflicting-states' : 'insufficient-date-or-evidence' };
}

export function previousContinuousState(intervals: readonly ContinuousStateInterval[], current: ContinuousStateInterval): ContinuousStateInterval | null {
  const point = dateRange(current.start);
  if (!point) return null;
  const row = intervals.filter(item => item.entityId === current.entityId && item.dimension === current.dimension
    && item.world === current.world && item.factId !== current.factId && item.certainty === 'supported')
    .flatMap(item => {
      const start = dateRange(item.start);
      const end = item.end ? dateRange(item.end) : null;
      return start && start.era === point.era && start.max < point.min
        && (!end || end.max >= point.min) ? [{ item, start }] : [];
    }).sort((a, b) => b.start.max - a.start.max);
  if (!row.length || (row[1] && row[0].start.max === row[1].start.max && row[0].item.value !== row[1].item.value)) return null;
  return row[0].item;
}

export function renderContinuousStateContract(intervals: readonly ContinuousStateInterval[]): string[] {
  if (!intervals.length) return [];
  return [
    '<CONTINUOUS_STATES_READ_ONLY>',
    '事件发生事实与持续状态不同。状态仅在 start（含）到 end（不含）有效；无 end 表示尚无已知后续转变，不是永恒定律。逐场景按日期使用，不能把最新状态倒灌到早年，也不能把曾被监禁写成永久缺席。',
    'uncertain、无明确日期或跨世界不可比的状态不得硬判在场。监禁、失踪、伤病只限制活动条件，不删除人物。完整保留玩家自由指令，允许描写越狱、康复等转变；候选只是任务局部假设，未通过正常干涉提交前不改变正史。“从未发生”须经 replace/retract 核验，不能由生成抹去旧事件。',
    ...intervals.map(({ sourceFactIds: _refs, ...item }) => JSON.stringify(item)),
    '</CONTINUOUS_STATES_READ_ONLY>',
  ];
}

/** Exact dates come from the frozen plan, not from interpreting the player's intent. */
export function renderContinuousStatesAtTimes(intervals: readonly ContinuousStateInterval[], times: readonly string[]): string[] {
  if (!intervals.length || !times.length) return [];
  const groups = new Map(intervals.map(item => [JSON.stringify([item.entityId, item.dimension, item.world]), item]));
  return ['<SCENE_STATE_PROJECTIONS_READ_ONLY>',
    '以下是各冻结时间点的状态投影。unknown 不等于缺席；本段跨过转变时按各自时间分开写，不能整段套用首末状态。',
    ...[...new Set(times)].flatMap(at => [...groups.values()].map(item => JSON.stringify({
      at, entityId: item.entityId, dimension: item.dimension, world: item.world,
      ...continuousStateAt(intervals, item.entityId, item.dimension, at, item.world),
    }))), '</SCENE_STATE_PROJECTIONS_READ_ONLY>'];
}
