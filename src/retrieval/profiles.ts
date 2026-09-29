import {
  EVIDENCE_PASSAGE_STRATEGY_VERSION,
  type EvidencePassageBudget,
  type RetrievalTaskType,
} from './contracts.ts';

export interface RetrievalTaskProfile {
  id: string;
  taskType: RetrievalTaskType;
  maxSources: number;
  maxCharacters: number;
  maxRelationDepth: 1 | 2;
  passageBudget: EvidencePassageBudget;
  relationWeights: Readonly<Record<string, number>>;
  /** 只在已有主目标信号后加权，不能单独让来源入选。 */
  sourceWeights: Readonly<Record<SourceSnapshotType, number>>;
  /** 被列来源至少需要两个正文锚点，或一个标题/索引锚点，才可开门。 */
  strongPrimarySourceTypes: readonly SourceSnapshotType[];
  /** 首次语义编译后允许的本地证据补齐次数；不会再次调用语义模型。 */
  localEvidenceExpansionPasses: 0 | 1;
}

type SourceSnapshotType =
  | 'worldbook'
  | 'chat'
  | 'mvu'
  | 'genealogy'
  | 'biography'
  | 'butterfly';

const SHARED_RELATIONS = {
  belongs_to: 1,
  parent: 1,
  father: 1,
  mother: 1,
  spouse: 0.9,
  child: 0.9,
  sibling: 0.7,
} as const;

const sharedPassageBudget = (
  softLimitChars: number,
  hardLimitChars: number,
): EvidencePassageBudget => ({
  strategyVersion: EVIDENCE_PASSAGE_STRATEGY_VERSION,
  softLimitChars,
  hardLimitChars,
  fullSourceLimitChars: 8_000,
  maxWindowChars: 2_400,
});

export const RETRIEVAL_TASK_PROFILES: Readonly<
  Record<RetrievalTaskType, RetrievalTaskProfile>
> = {
  biography: {
    id: 'eyon.retrieval.profile.biography.v4',
    taskType: 'biography',
    maxSources: 14,
    maxCharacters: 42_000,
    maxRelationDepth: 1,
    passageBudget: sharedPassageBudget(12_000, 16_000),
    relationWeights: { ...SHARED_RELATIONS, belongs_to: 1.2 },
    sourceWeights: {
      worldbook: 16,
      mvu: 18,
      genealogy: 14,
      biography: 12,
      butterfly: 6,
      chat: 4,
    },
    strongPrimarySourceTypes: ['chat', 'mvu'],
    localEvidenceExpansionPasses: 1,
  },
  genealogy: {
    id: 'eyon.retrieval.profile.genealogy.v4',
    taskType: 'genealogy',
    maxSources: 20,
    maxCharacters: 60_000,
    maxRelationDepth: 2,
    passageBudget: sharedPassageBudget(14_000, 18_000),
    relationWeights: {
      ...SHARED_RELATIONS,
      parent: 1.5,
      father: 1.5,
      mother: 1.5,
      spouse: 1.2,
      child: 1.3,
      sibling: 1,
    },
    sourceWeights: {
      genealogy: 18,
      biography: 16,
      mvu: 14,
      worldbook: 12,
      butterfly: 6,
      chat: 4,
    },
    strongPrimarySourceTypes: ['chat', 'mvu'],
    localEvidenceExpansionPasses: 1,
  },
  ruin: {
    id: 'eyon.retrieval.profile.ruin.v5',
    taskType: 'ruin',
    maxSources: 18,
    maxCharacters: 54_000,
    maxRelationDepth: 2,
    passageBudget: sharedPassageBudget(12_000, 16_000),
    relationWeights: { ...SHARED_RELATIONS, belongs_to: 1.6 },
    sourceWeights: {
      worldbook: 18,
      genealogy: 10,
      biography: 9,
      butterfly: 8,
      mvu: 4,
      chat: 2,
    },
    strongPrimarySourceTypes: ['chat', 'mvu', 'worldbook'],
    localEvidenceExpansionPasses: 1,
  },
  butterfly: {
    id: 'eyon.retrieval.profile.butterfly.v4',
    taskType: 'butterfly',
    maxSources: 16,
    maxCharacters: 48_000,
    maxRelationDepth: 2,
    passageBudget: sharedPassageBudget(12_000, 16_000),
    relationWeights: { ...SHARED_RELATIONS, belongs_to: 1.3 },
    sourceWeights: {
      chat: 18,
      butterfly: 16,
      mvu: 14,
      worldbook: 12,
      genealogy: 10,
      biography: 8,
    },
    strongPrimarySourceTypes: ['chat', 'mvu'],
    localEvidenceExpansionPasses: 1,
  },
};
