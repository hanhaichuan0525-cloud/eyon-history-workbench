import type { RuinNode } from '../schemas/ruin.ts';

export { formatRuinNodeExactTime } from '../renderers/ruinTimeLabel.ts';

export function fullRuinStageIntroduction(node: RuinNode): string {
  return node.summary.trim();
}
