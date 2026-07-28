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
    `Title:: ${candidate.title.trim()}`,
    `Type:: ${candidate.periodType.trim()}`,
    `Span:: ${candidate.span.label.trim()}`,
    `History:: ${candidate.historyProse.trim()}`,
    `Shift:: ${candidate.shift.trim()}`,
    `NodeTime:: ${node.time.label.trim()}`,
    '[/RuinTrace]',
  ].join('\n');
}
