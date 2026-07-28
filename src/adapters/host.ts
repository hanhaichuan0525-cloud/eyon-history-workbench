import type { WorkbenchNamespace } from '../core/namespace.ts';

export interface RuinRuntimeSnapshot {
  flowState: 'idle' | 'exploring' | 'anchored' | 'returning';
  runId: string;
  realityTime: string;
  realityLocation: string;
  ruinTime: string;
  ruinLocation: string;
}

export interface ButterflyFreezeSnapshot {
  flowState: 'exploring' | 'anchored' | 'returning';
  runId: string;
  reality: { time: string; location: string };
  ruinEntry: { time: string; location: string };
  ruinExit: { time: string; location: string };
}

export interface HostAdapter {
  getNamespace(): Promise<WorkbenchNamespace>;
  getRuinRuntimeSnapshot(): Promise<RuinRuntimeSnapshot>;
  getLatestUserText(): Promise<string>;
  replaceAssistantSlot(messageId: number, slot: string, content: string): Promise<void>;
}

export interface ButterflyHostAdapter extends HostAdapter {
  getButterflyFreezeSnapshot(): Promise<ButterflyFreezeSnapshot>;
  assertButterflyTarget(request: {
    requestId: string;
    userMessageId: number;
    assistantMessageId: number;
    assistantSwipeId: number | null;
    rawCommand: string;
  }): Promise<void>;
  appendButterflyPanel(
    messageId: number,
    requestId: string,
    panel: string,
  ): Promise<void>;
}

export interface GenerationAdapter {
  generate(taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly', prompt: string): Promise<string>;
}

export interface ArchiveAdapter {
  activateNamespace?(namespace: WorkbenchNamespace): Promise<void>;
  mirrorButterflyRecord(input: {
    namespace: WorkbenchNamespace;
    runId: string;
    assistantMessageId: number;
    title: string;
    content: string;
    keywords: string[];
    signature: string;
  }): Promise<{ worldbookName: string; uid: number }>;
}

export interface UserTurnAdapter {
  sendUserTurn(text: string): Promise<{
    messageId: number;
  }>;
}
