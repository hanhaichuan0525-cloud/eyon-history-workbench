import type { WorkbenchNamespace } from '../core/namespace.ts';

export interface RuinRuntimeSnapshot {
  flowState: 'idle' | 'exploring' | 'anchored' | 'returning';
  runId: string;
  realityTime: string;
  realityLocation: string;
  ruinTime: string;
  ruinLocation: string;
}

export interface HostAdapter {
  getNamespace(): Promise<WorkbenchNamespace>;
  getRuinRuntimeSnapshot(): Promise<RuinRuntimeSnapshot>;
  getLatestUserText(): Promise<string>;
  replaceAssistantSlot(messageId: number, slot: string, content: string): Promise<void>;
}

export interface GenerationAdapter {
  generate(taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly', prompt: string): Promise<string>;
}

export interface ArchiveAdapter {
  mirrorButterflyRecord(runId: string, entry: string): Promise<void>;
}

export interface UserTurnAdapter {
  sendUserTurn(text: string): Promise<{
    messageId: number;
  }>;
}
