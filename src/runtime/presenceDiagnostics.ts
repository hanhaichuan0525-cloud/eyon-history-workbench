import type { RuinContextBundle } from '../core/context.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type { RuinRuleSet } from '../prompts/ruin.ts';
import { renderCharacterTimeAnchors } from '../prompts/ruin.ts';
import {
  findPersonTimelineEntry,
  personAvailabilityLine,
} from '../retrieval/temporal.ts';

/**
 * 人物时间锚诊断（工作台排查用）：
 * 每次墟境生成后记录「自动时间范围 + 选中人物时间锚命中情况 + 注入的锚文本」，
 * 工作台设置页可直接查看——定位「人物时间锚未生效」类问题（MVU/世界书双源、
 * 名字不一致、基准时间未锁定等），无需抓包。
 */

export interface RuinPresenceCharacterDiagnostic {
  name: string;
  /** personTimeline 是否命中该人物 */
  matched: boolean;
  /** 窗口行（personAvailabilityLine）；未命中/无生卒信息为 null */
  window: string | null;
}

export interface RuinPresenceDiagnostic {
  occurredAt: number;
  requestId: string;
  /** 是否走自动时间范围（玩家未填时间） */
  automatic: boolean;
  /** 生效的时间范围（start/end 展示文本） */
  range: { start: string; end: string } | null;
  characters: RuinPresenceCharacterDiagnostic[];
  /** CHARACTER_TIME_ANCHORS + RUIN_ABSENCE_MODE 注入文本（选中人物非空时） */
  anchorText: string;
}

const DIAGNOSTIC_LIMIT = 20;
const diagnostics: RuinPresenceDiagnostic[] = [];

export function recordRuinPresenceDiagnostic(entry: RuinPresenceDiagnostic): void {
  diagnostics.unshift(entry);
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.length = DIAGNOSTIC_LIMIT;
}

export function listRuinPresenceDiagnostics(): RuinPresenceDiagnostic[] {
  return [...diagnostics];
}

export function buildRuinPresenceDiagnostic(input: {
  requestId: string;
  directive: string;
  input: RuinGenerationInput;
  effectiveInput: RuinGenerationInput;
  context: RuinContextBundle;
  rules: RuinRuleSet;
}): RuinPresenceDiagnostic {
  const characters = input.input.selectedCharacters.map(character => {
    const entry = findPersonTimelineEntry(
      input.context.evidenceBundle.personTimeline,
      character.name,
    );
    return {
      name: character.name,
      matched: Boolean(entry),
      window: entry ? personAvailabilityLine(entry) : null,
    };
  });
  const anchorText = renderCharacterTimeAnchors({
    requestId: input.requestId,
    directive: input.directive,
    generationInput: input.effectiveInput,
    context: input.context,
    rules: input.rules,
  }).join('\n');
  return {
    occurredAt: Date.now(),
    requestId: input.requestId,
    automatic: input.effectiveInput.start !== null && input.effectiveInput.end !== null,
    range: input.effectiveInput.start && input.effectiveInput.end
      ? {
          start: formatRangePoint(input.effectiveInput.era, input.effectiveInput.start),
          end: formatRangePoint(input.effectiveInput.era, input.effectiveInput.end),
        }
      : null,
    characters,
    anchorText,
  };
}

function formatRangePoint(
  era: string,
  point: { year: number | null; month: number | null; day: number | null },
): string {
  const year = point.year ?? '?';
  const month = point.month ?? '?';
  const day = point.day ?? '?';
  return `${era}${year}年${month}月${day}日`;
}
