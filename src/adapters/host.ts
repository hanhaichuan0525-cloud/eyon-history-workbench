import type { WorkbenchNamespace } from '../core/namespace.ts';

export interface RuinRuntimeSnapshot {
  flowState: 'idle' | 'exploring' | 'anchored' | 'returning';
  runId: string;
  realityTime: string;
  realityLocation: string;
  ruinTime: string;
  ruinLocation: string;
  /** 当前 MVU `任务列表` 中的墟境任务；旧宿主适配器可暂不提供。 */
  ruinTasks?: RuinTaskSnapshot[];
}

export interface RuinTaskSnapshot {
  name: string;
  mode: '个人' | '团队';
  status: string;
  attention: '高' | '中' | '低' | string;
  progress: string;
  detail: string;
  objective: string;
  reward: string;
  terminal: boolean;
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
  getButterflyFreezeSnapshot(
    sourceMessageId?: number,
  ): Promise<ButterflyFreezeSnapshot>;
  assertButterflyTarget(request: {
    requestId: string;
    userMessageId: number;
    userSwipeId?: number | null;
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
  generate(
    taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly',
    prompt: string,
    options?: {
      progressLabel?: string;
      /** P0-D：复用同一生成通道，但切换到共享语义证据编译系统契约。 */
      purpose?: 'semantic-evidence' | 'canon-reconcile' | 'ruin-task';
    },
  ): Promise<string>;
}

/**
 * internal.87 · 蓝图 §6 步 B：世界书镜像已退役。
 *
 * 旧适配面（`mirrorButterflyRecord` / `activateNamespace` 的全局重挂）已删除：
 * 蝴蝶史料源改由 `runtime/butterflySources.ts` 从本地记录 + Canon 投影供给，
 * 正文可见性由 `runtime/canonMemoryChannel.ts` 的 `<CANON_MEMORY>` 承担。
 * 仅保留存量镜像世界书的**显式清理**（用户点按钮触发，不自动、不删用户数据）。
 */
export interface MirrorRetirementResult {
  /** 处理过的锚定世界书（`伊雍-蝴蝶效应锚定-*`）。 */
  worldbooks: string[];
  /** 删除的镜像条目数（只删脚本自建条目）。 */
  removedEntries: number;
  /** 清理后仍挂在全局的世界书（应不含锚定书）。 */
  globals: string[];
}

export interface ArchiveAdapter {
  retireLegacyMirrors(): Promise<MirrorRetirementResult>;
}

export interface UserTurnAdapter {
  sendUserTurn(
    text: string,
    options?: {
      signal?: AbortSignal;
      beforeCreate?(expectedMessageId: number): Promise<void>;
      afterCreate?(messageId: number): Promise<void>;
    },
  ): Promise<{
    messageId: number;
  }>;
}
