import { z } from 'zod';

export const ButterflyScopeSchema = z.enum([
  '个人',
  '双人',
  '小队',
  '聚落',
  '城市',
  '省份级地区',
  '国家',
  '跨国',
]);

export const ButterflyAnchorSchema = z.strictObject({
  time: z.string().min(1),
  location: z.string().min(1),
});

export const ButterflySourceSchema = z.strictObject({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
});

export const ButterflyRequestSchema = z.strictObject({
  schema: z.literal('eyon.butterfly.request.v1'),
  requestId: z.string().min(1),
  characterKey: z.string().min(1),
  chatId: z.string().min(1),
  runId: z.string().min(1),
  trigger: z.strictObject({
    type: z.enum(['button', 'text']),
    userMessageId: z.number().int().nonnegative(),
    returnAssistantMessageId: z.number().int().nonnegative(),
    rawCommand: z.string().min(1),
  }),
  anchors: z.strictObject({
    reality: ButterflyAnchorSchema,
    ruinEntry: ButterflyAnchorSchema,
    ruinExit: ButterflyAnchorSchema,
  }),
  dice: z.strictObject({
    roll: z.number().int().min(1).max(100),
    scope: ButterflyScopeSchema,
  }),
  ruinHistory: z.strictObject({
    title: z.string(),
    era: z.string(),
    originalTrajectory: z.string(),
    historicalBackground: z.string(),
    enteredAnomaly: z.string(),
    locationChain: z.array(z.string().min(1)),
  }),
  playerInterventions: z.array(ButterflySourceSchema).min(1),
  involvedEntities: z.array(ButterflySourceSchema),
  currentRealityContext: z.array(ButterflySourceSchema),
  relevantWorldbook: z.array(ButterflySourceSchema),
  relevantChatFacts: z.array(ButterflySourceSchema),
  relevantGenealogy: z.array(ButterflySourceSchema),
  relevantBiographies: z.array(ButterflySourceSchema),
  previousButterflyAnchors: z.array(ButterflySourceSchema),
  sourceIndex: z.array(ButterflySourceSchema).min(1),
});

export const ButterflyResultSchema = z.strictObject({
  schema: z.literal('eyon.butterfly.v1'),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  effect: z.strictObject({
    roll: z.number().int().min(1).max(100),
    scope: ButterflyScopeSchema,
    presentLanding: z.string().min(1),
    perceptibleEvidence: z.array(z.string().min(1)).min(1).max(4),
    ruinActionRecord: z.string().min(1),
    historicalEvolution: z.string().min(1),
    historicalKeywords: z.array(z.string().min(1)).min(4).max(10),
  }),
  causalStages: z.array(z.strictObject({
    order: z.number().int().positive(),
    time: z.string().min(1),
    carrier: z.string().min(1),
    change: z.string().min(1),
    linkToNext: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
  })).min(2).max(5),
  sourceIds: z.array(z.string().min(1)),
  inferences: z.array(z.strictObject({
    content: z.string().min(1),
    basisSourceIds: z.array(z.string().min(1)).min(1),
  })),
  warnings: z.array(z.string().min(1)),
  qualityChecks: z.strictObject({
    anchorsUntouched: z.boolean(),
    scopeRespected: z.boolean(),
    causalChainComplete: z.boolean(),
    presentEvidenceConcrete: z.boolean(),
    playerAgencyPreserved: z.boolean(),
    canonConflictsResolved: z.boolean(),
  }),
});

export const ButterflyErrorSchema = z.strictObject({
  schema: z.literal('eyon.butterfly.v1'),
  requestId: z.string(),
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type ButterflyScope = z.infer<typeof ButterflyScopeSchema>;
export type ButterflyRequest = z.infer<typeof ButterflyRequestSchema>;
export type ButterflyResult = z.infer<typeof ButterflyResultSchema>;
