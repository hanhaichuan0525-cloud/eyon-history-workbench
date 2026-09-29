/**
 * 时间跨度自适应标签生成器。
 *
 * 标签精度 = 跨度的函数（由脚本确定性生成，不依赖模型写 label）：
 * - 跨纪元（起止纪元名不同）→ 「纪元A xx年 - 纪元B xx年」（必须带纪元名）
 * - 同纪元跨年 → 「纪元A xx年 - yy年」；纪元未知时只写年份
 * - 同年跨月 → 「纪元A xx年x月 - y月」
 * - 同月跨日 → 「纪元A xx年x月x日 - y日」
 * - 同日跨时 → 「纪元A xx年x月x日x时 - y时」
 * - 完全同点 → 按可用精度渲染单点（年→月→日→时逐级）
 * - age 模式（或两侧仅有年龄锚点）→ 「x岁至x岁」
 *
 * 鲁棒性：字段缺失时自动降级到下一精度级，绝不因时间信息不全而报错。
 */

export interface SpanPointLike {
  year?: number | null;
  month?: number | null;
  day?: number | null;
  hour?: number | null;
  age?: number | null;
  era?: string | null;
}

export function renderSpanLabel(
  start: SpanPointLike,
  end: SpanPointLike,
  mode: 'calendar' | 'age' | 'mixed',
): string {
  if (
    mode === 'age'
    || (start.age != null && end.age != null
      && start.year == null && end.year == null)
  ) {
    return `${start.age}岁至${end.age}岁`;
  }

  // 单侧无锚：按有锚一侧渲染单点（终点缺失常见于「至今」类开放终点）
  if (!hasCalendarAnchor(end)) return renderPoint(start);
  if (!hasCalendarAnchor(start)) return renderPoint(end);

  // 跨纪元：两侧都完整展开，避免年份基准与月份/日期归属混淆。
  if (start.era && end.era && start.era !== end.era) {
    return `${renderPoint(start)} - ${renderPoint(end)}`;
  }

  // 同纪元（或纪元未知）：可以压缩重复字段，但绝不能省略共同的年份。
  // 多阶段传记常有完全相同的月份范围；若把年份一起省略，读者将无法定位阶段。
  const era = sharedEra(start, end);
  if (start.year != null && end.year != null && start.year !== end.year) {
    return `${era}${start.year}年 - ${end.year}年`;
  }
  const year = start.year != null && start.year === end.year
    ? `${era}${start.year}年`
    : '';
  if (start.month != null && end.month != null && start.month !== end.month) {
    return `${year}${start.month}月 - ${end.month}月`;
  }
  const month = start.month != null && start.month === end.month
    ? `${start.month}月`
    : '';
  if (start.day != null && end.day != null && start.day !== end.day) {
    return `${year}${month}${start.day}日 - ${end.day}日`;
  }
  const day = start.day != null && start.day === end.day
    ? `${start.day}日`
    : '';
  if (start.hour != null && end.hour != null && start.hour !== end.hour) {
    return `${year}${month}${day}${start.hour}时 - ${end.hour}时`;
  }

  // 完全同点：按可用精度渲染单点
  return renderPoint(start);
}

function hasCalendarAnchor(point: SpanPointLike): boolean {
  return point.year != null
    || point.month != null
    || point.day != null
    || point.hour != null;
}

function renderPoint(point: SpanPointLike): string {
  const parts: string[] = [];
  if (point.era) parts.push(point.era);
  if (point.year != null) parts.push(`${point.year}年`);
  if (point.month != null) parts.push(`${point.month}月`);
  if (point.day != null) parts.push(`${point.day}日`);
  if (point.hour != null) parts.push(`${point.hour}时`);
  return parts.join('');
}

function sharedEra(start: SpanPointLike, end: SpanPointLike): string {
  if (start.era && end.era && start.era !== end.era) return '';
  return start.era ?? end.era ?? '';
}
