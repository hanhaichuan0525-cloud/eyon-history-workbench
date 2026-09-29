import type { RuinNode } from '../schemas/ruin.ts';

/**
 * 墟境时间/跨度的确定性渲染(单一真源):
 * 模型输出的 label 一律丢弃,展示标签统一由脚本渲染,
 * 面板([RuinTrace])、注入契约、工作台 UI 与 validators 共用本模块,永不漂移。
 */

export interface RuinCalendarDate {
  year: number | null;
  month: number | null;
  day: number | null;
}

/** 「145-5-10」式日期片段(年-月-日,缺失段省略) */
export function dateLabel(date: RuinCalendarDate): string {
  const parts = [
    date.year === null ? '' : String(date.year),
    date.month === null ? '' : String(date.month),
    date.day === null ? '' : String(date.day),
  ].filter(Boolean);
  return parts.join('-');
}

function formatDateHan(date: RuinCalendarDate, era: string): string {
  const rendered = [
    date.year === null ? '' : `${era}${date.year}年`,
    date.month === null ? '' : `${date.month}月`,
    date.day === null ? '' : `${date.day}日`,
  ].join('');
  return rendered || '（相对纪年）';
}

/**
 * 候选跨度标签(汉字单位):「创世纪元240年1月15日 —— 250年12月31日」。
 * 同纪元时后段省略纪元名;跨纪元时后段带自身纪元名(endEra)。
 */
export function formatRuinSpanLabel(
  era: string,
  start: RuinCalendarDate,
  end: RuinCalendarDate,
  endEra = era,
): string {
  const startText = formatDateHan(start, era);
  const endText = formatDateHan(end, endEra === era ? '' : endEra);
  return startText === endText ? startText : `${startText} —— ${endText}`;
}

/**
 * 节点时间标签(角色卡风格,与《变量更新规则》世界.时间格式对齐):
 * 「创世纪元247年-7月-7日-19:30」;年缺失时以「（相对纪年）」开头;
 * 仅脚本可确定的部分(星期由正文模型按剧情日历推算,脚本不伪造)。
 */
export function formatRuinNodeTimeCard(
  era: string,
  time: Omit<RuinNode['time'], 'label'>,
): string {
  const parts: string[] = [];
  if (time.year === null) {
    parts.push('（相对纪年）');
  } else {
    parts.push(`${era}${time.year}年`);
  }
  if (time.month !== null) parts.push(`${time.month}月`);
  if (time.day !== null) parts.push(`${time.day}日`);
  if (time.hour !== null) {
    const minute = time.minute === null
      ? '00'
      : String(time.minute).padStart(2, '0');
    parts.push(`${String(time.hour).padStart(2, '0')}:${minute}`);
  }
  return parts.join('-');
}

/**
 * 节点精确时间标签:「复兴纪元145年5月20日14:28」(缺失单位标注未详)。
 * 原实现位于 ui/ruinPresentation.ts,迁至公共模块供 validators 确定性渲染复用。
 * label 由脚本渲染,参数不需要也不接受模型输出的 label。
 */
export function formatRuinNodeExactTime(
  era: string,
  time: Omit<RuinNode['time'], 'label'>,
): string {
  const parts: string[] = [];
  const missing: string[] = [];

  if (time.year === null) missing.push('年');
  else parts.push(`${era}${time.year}年`);
  if (time.month === null) missing.push('月');
  else parts.push(`${time.month}月`);
  if (time.day === null) missing.push('日');
  else parts.push(`${time.day}日`);
  if (time.hour === null) {
    missing.push('时');
  } else {
    const minute = time.minute === null
      ? ''
      : `:${String(time.minute).padStart(2, '0')}`;
    parts.push(`${String(time.hour).padStart(2, '0')}${minute}`);
  }

  const exact = parts.join('');
  return missing.length ? `${exact}（${missing.join('、')}未详）` : exact;
}
