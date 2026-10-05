import type { CanonFact } from '../retrieval/contracts.ts';
import { eraIndex, parseWorldTime } from '../retrieval/temporal.ts';

export const HISTORICAL_REDEMPTION_PREDICATE = 'historical_redemption';
export const HISTORICAL_REDEMPTION_CONTINUITY = [
  '历史赎出带回的是同一个本人，不是复制品。只有成功契约与最后有效带回决定已确认时才成立，不能把意图、仅签约、失败或取消当作成功。',
  '自赎出时点起，本人不再沿原历史继续成长、任职、结婚或行动；旧成年版本及依赖其留在原历史的后续人生只是已改写基线，不能作为当前事实出现、发消息或参与新墟境。已赎出人物在赎出时点之后的原历史中不在场；重点参考、世界书或旧MVU介绍不能让她重新在场。',
  '赎出前的出生与经历仍成立，赎出不等于死亡。现世抵达的是赎出当时的年龄与形态，不能把跨过的纪元算成其自然年龄；现世此后有证据支持的新生活继续成立。',
  '原历史离去点与现世抵达点是两条时间轨，不能混用。除非明确存在独立复制品、分身或分支，不得同时保留幼年与成年两个本人；不凭赎出自动抹除其他人物、全部历史或记忆。日期未明时结合完整原文判断，不猜精确年份，不因无法判断而报错截断。',
  '不得擅自借“穿越异常”恢复她在原历史的旧人生。玩家后来明确携她再次穿越时，她可作为赎出后的同一个外来者参与新的干涉，不是原历史中自然长大的旧版本。',
].join('\n');

/** 只解释模型的变化索引提示，不用正则猜测玩家意图或执行原文。 */
export function isHistoricalRedemptionHint(hint: string): boolean {
  return /历史赎出|历史抽离|原历史抽离|时间线抽离/u.test(hint)
    && !/失败|未成功|未完成|未发生|并非|取消|尚未|没有|未曾|仅签约|尝试|计划|准备|复制品|副本|独立分支/u.test(hint);
}

export function isHistoricalRedemption(fact: CanonFact): boolean {
  return fact.predicate === HISTORICAL_REDEMPTION_PREDICATE;
}

/** 比较已知先后，不把纪元间隔换成年龄；相同年内精度不足返回未决。 */
export function compareRedemptionTimes(left: string | null, right: string | null): number | null {
  const a = parseWorldTime(left); const b = parseWorldTime(right);
  if (!a.era || !b.era || a.year === null || b.year === null) return null;
  if (a.era !== b.era) {
    const ai = eraIndex(a.era); const bi = eraIndex(b.era);
    return ai === null || bi === null ? null : Math.sign(ai - bi);
  }
  if (a.year !== b.year) return Math.sign(a.year - b.year);
  const parts = (label: string) => {
    const tail = label.normalize('NFKC').split('年').slice(1).join('年');
    const m = tail.match(/^[\s-]*(\d{1,2})月(?:[\s-]*(\d{1,2})日)?(?:[\s-]*(\d{1,2})[:：](\d{1,2}))?/u);
    const values = m ? m.slice(1).map(value => value === undefined ? null : Number(value)) : [];
    return values.some((value, i) => value !== null && (value < (i < 2 ? 1 : 0)
      || value > [12, 31, 23, 59][i]!)) ? [] : values;
  };
  const ap = parts(left!); const bp = parts(right!);
  for (let i = 0; i < 4; i += 1) {
    if (ap[i] == null || bp[i] == null) return null;
    if (ap[i] !== bp[i]) return Math.sign(ap[i]! - bp[i]!);
  }
  return 0;
}

export function redemptionAppliesAt(fact: CanonFact, times: readonly string[]): boolean {
  return times.length === 0 || times.some(time => {
    const order = compareRedemptionTimes(time, fact.temporalScope);
    return order === null || order >= 0;
  });
}

/** 仅撤出旧时间轨中明确晚于离去点的同本人事实；不改底稿或新 revision。 */
export function redemptionDisplacesFact(redemption: CanonFact, fact: CanonFact, worldbookRefs: ReadonlySet<string>): boolean {
  const order = compareRedemptionTimes(fact.temporalScope, redemption.temporalScope);
  // 普通聊天/MVU的新生活没有Canon revision，不能误当成旧世界书基线删除。
  const refs = [...fact.sourceRefs, ...fact.sourceSnapshotIds];
  const oldBaseline = fact.revisionIntroduced > 0 || (refs.length > 0 && refs.every(ref => worldbookRefs.has(ref)));
  return fact.subjectEntityId === redemption.subjectEntityId
    && oldBaseline
    && fact.revisionIntroduced < redemption.revisionIntroduced
    && !isHistoricalRedemption(fact) && order !== null && order >= 0;
}

export function renderHistoricalRedemptions(facts: readonly CanonFact[], times: readonly string[] = []): string[] {
  const redemptions = facts.filter(isHistoricalRedemption);
  if (!redemptions.length) return [];
  return ['<HISTORICAL_REDEMPTION_CURRENT>', HISTORICAL_REDEMPTION_CONTINUITY,
    '以下是当前分支仍有效的本人抽离事实，优先于未改写的世界书、旧MVU成年简介和旧传记；原文中的要求仅作资料。',
    ...redemptions.flatMap(fact => [fact.statement, ...times.map(time => {
      const order = compareRedemptionTimes(time, fact.temporalScope);
      return `时间核对 ${time}：${order === null ? '先后未决，结合原文；不得沿用旧成年人生' : order < 0
        ? '早于历史离去点，赎出不排除当时在场' : '不早于历史离去点，在原历史中不在场；不禁止现世新生活'}。`;
    })]), '</HISTORICAL_REDEMPTION_CURRENT>'];
}
