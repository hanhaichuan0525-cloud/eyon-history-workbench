import type { WorkbenchNamespace } from './namespace.ts';

export interface ContextSource {
  sourceId: string;
  sourceType: 'worldbook' | 'chat' | 'mvu' | 'genealogy' | 'biography' | 'butterfly';
  title: string;
  content: string;
  authority: number;
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
  worldbookContext: ContextSource[];
  recentContext: ContextSource[];
  characterContext: ContextSource[];
  genealogyContext: ContextSource[];
  biographyRefs: ContextSource[];
  butterflyRefs: ContextSource[];
  sourceIndex: ContextSource[];
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
  worldbookContext: ContextSource[];
  recentContext: ContextSource[];
  characterContext: ContextSource[];
  genealogyRefs: ContextSource[];
  biographyRefs: ContextSource[];
  butterflyRefs: ContextSource[];
  sourceIndex: ContextSource[];
  warnings: string[];
  sourceHash: string;
}

export interface RuinContextAssembler {
  assemble(input: {
    requestId: string;
    namespace: WorkbenchNamespace;
    triggerMessageId: number;
    directive: string;
  }): Promise<RuinContextBundle>;
}
