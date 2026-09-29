export interface RuinTraceCandidate {
  title: string;
  periodType: string;
  span: {
    label: string;
  };
  historyProse: string;
  shift: string;
}

export interface RuinTraceNode {
  time: {
    label: string;
  };
}

export function serializeRuinTrace(
  candidate: RuinTraceCandidate,
  node: RuinTraceNode,
): string {
  return [
    '[RuinTrace]',
    `Title:: ${panelUserName(candidate.title)}`,
    `Type:: ${panelUserName(candidate.periodType)}`,
    `Span:: ${panelUserName(candidate.span.label)}`,
    `History:: ${panelUserName(candidate.historyProse)}`,
    `Shift:: ${panelUserName(candidate.shift)}`,
    `NodeTime:: ${panelUserName(node.time.label)}`,
    '[/RuinTrace]',
  ].join('\n');
}

/** 可见面板由酒馆渲染，使用宏而非泛称，让宿主展开当前玩家姓名。 */
function panelUserName(value: string): string {
  return value.trim().replace(/玩家/gu, '<user>');
}
