import type { WorkbenchNamespace } from './namespace.ts';
import type { EvidenceBundle } from '../retrieval/contracts.ts';
import type { CurrentSceneSnapshot } from './currentSceneReference.ts';
import type { ContinuityView } from './continuityAnchors.ts';

export interface ContextSource {
  sourceId: string;
  sourceType: 'worldbook' | 'chat' | 'mvu' | 'genealogy' | 'biography' | 'butterfly';
  title: string;
  content: string;
  authority: number;
  /** 世界书条目的检索策略：constant=常驻（始终入选），selective=按 keys/正文命中 */
  strategyType?: 'constant' | 'selective';
  /** 世界书条目自带的检索关键词（strategy.keys），用于提升召回 */
  keywords?: string[];
}

export interface BiographyContextBundle {
  schema: 'eyon.context.v1';
  taskType: 'biography';
  requestId: string;
  scope: WorkbenchNamespace & {
    triggerMessageId: number;
  };
  currentWorld: {
    time: string;
    location: string;
  };
  /** 仅在玩家指向当前对象时出现；保留附近聊天原文，不预判用途与归属。 */
  currentSceneSnapshot?: CurrentSceneSnapshot;
  worldbookContext: ContextSource[];
  recentContext: ContextSource[];
  characterContext: ContextSource[];
  genealogyContext: ContextSource[];
  biographyRefs: ContextSource[];
  butterflyRefs: ContextSource[];
  sourceIndex: ContextSource[];
  /** Retrieval v1.1+ 当前任务的瞬时模型可见证据真源（与墟境同构）。 */
  evidenceBundle: EvidenceBundle;
  /** P4-A：同聊天/分支/revision 的低权生成连续性；故障时为空或缺省。 */
  continuityView?: ContinuityView;
  warnings: string[];
  sourceHash: string;
}

export interface BiographyContextAssembler {
  assemble(input: {
    requestId: string;
    namespace: WorkbenchNamespace;
    triggerMessageId: number;
    directive: string;
  }): Promise<BiographyContextBundle>;
}

export interface RuinContextBundle {
  schema: 'eyon.context.v1';
  taskType: 'ruin';
  requestId: string;
  scope: WorkbenchNamespace & {
    triggerMessageId: number;
  };
  currentWorld: {
    time: string;
    location: string;
  };
  /** 仅在玩家指向当前对象时出现；保留附近聊天原文，不预判用途与归属。 */
  currentSceneSnapshot?: CurrentSceneSnapshot;
  worldbookContext: ContextSource[];
  recentContext: ContextSource[];
  characterContext: ContextSource[];
  genealogyRefs: ContextSource[];
  biographyRefs: ContextSource[];
  butterflyRefs: ContextSource[];
  sourceIndex: ContextSource[];
  /** Retrieval v1.1 当前任务的瞬时模型可见证据真源。 */
  evidenceBundle: EvidenceBundle;
  /** P4-A：同聊天/分支/revision 的低权生成连续性；故障时为空或缺省。 */
  continuityView?: ContinuityView;
  /** 重点参考人物的完整人物卡（原始全文，仅供 prompt 整条注入；不参与检索）。 */
  characterCards?: ContextSource[];
  warnings: string[];
  sourceHash: string;
}

export interface RuinContextAssembler {
  assemble(input: {
    requestId: string;
    namespace: WorkbenchNamespace;
    triggerMessageId: number;
    directive: string;
    /**
     * 作为「疆域/地点范围」引用而非在场演员的实体名（如地点范围=奥古斯提姆帝国）。
     * 目标纪元不可用时降级为 warning，不触发 temporal conflict fatal。
     */
    territorialReferences?: string[];
    /**
     * 工作台显式勾选的重点参考人物。它们提高资料召回与提示词注意力，
     * 但不因此成为 required 演员；补充方向中另行点名的实体不在此列。
     */
    focusCharacterNames?: string[];
    /** 只有这部分玩家输入可以建立 required 演员；重点参考资料本身不能。 */
    castRequirementQuery?: string;
    /**
     * 工作台最终选定的真实纪年名，不得是“自定义”占位文本。
     * 自定义纪年必须在完整世界书中精确命中，并强制进入本次检索。
     */
    eraAnchor?: string;
    customEra?: boolean;
  }): Promise<RuinContextBundle>;
}

export interface GenealogyContextBundle {
  schema: 'eyon.context.v1';
  taskType: 'genealogy';
  requestId: string;
  scope: WorkbenchNamespace & {
    triggerMessageId: number;
  };
  currentWorld: {
    time: string;
    location: string;
  };
  worldbookContext: ContextSource[];
  recentContext: ContextSource[];
  characterContext: ContextSource[];
  biographyRefs: ContextSource[];
  sourceIndex: ContextSource[];
  /** Retrieval v1.1+ 当前任务的瞬时模型可见证据真源（与墟境同构）。 */
  evidenceBundle: EvidenceBundle;
  continuityView?: ContinuityView;
  /** Script-only links; never exposed as model output requirements. */
  historyReferenceCandidates?: import('../runtime/genealogyContinuity.ts').GenealogyHistoryReference[];
  warnings: string[];
  sourceHash: string;
}

export interface GenealogyContextAssembler {
  assemble(input: {
    requestId: string;
    namespace: WorkbenchNamespace;
    triggerMessageId: number;
    directive: string;
  }): Promise<GenealogyContextBundle>;
}
