import type { RuinRuntimeSnapshot } from '../adapters/host.ts';

export type RuinPanel = 'generation' | 'tasks' | 'butterfly';
type RuinPresence = Pick<RuinRuntimeSnapshot, 'flowState' | 'runId'>;

/** 页面入口与操作入口共用当前聊天状态；未知状态不放行。 */
export function canOpenRuinPanel(runtime: RuinPresence, panel: RuinPanel): boolean {
  if (panel === 'generation') return runtime.flowState === 'idle';
  if (panel !== 'tasks' && panel !== 'butterfly') return false;
  return typeof runtime.runId === 'string' && Boolean(runtime.runId.trim())
    && ['exploring', 'anchored', 'returning'].includes(runtime.flowState);
}

export function availableRuinPanel(runtime: RuinPresence, preferred: RuinPanel): RuinPanel {
  if (canOpenRuinPanel(runtime, preferred)) return preferred;
  return canOpenRuinPanel(runtime, 'tasks') ? 'tasks' : 'generation';
}

export function assertRuinGenerationAvailable(runtime: RuinPresence): void {
  if (!canOpenRuinPanel(runtime, 'generation')) {
    throw new Error('当前仍在墟境内，墟境生成已锁定；请在蝴蝶效应工作台遣返现世后再操作');
  }
}
