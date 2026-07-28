import { z } from 'zod';

const SourceRefs = z.array(z.string().min(1));
const NullableInteger = z.number().int().nullable();

const BiographyDateSchema = z.strictObject({
  year: NullableInteger,
  month: NullableInteger,
  day: NullableInteger,
  age: NullableInteger,
});

const BiographyPassageSchema = z.strictObject({
  title: z.string().min(1),
  content: z.string().min(1),
  sourceRefs: SourceRefs,
  inference: z.boolean(),
});

const BiographyUsageSchema = z.strictObject({
  biographyId: z.string().min(1),
  stageId: z.string().min(1),
  usage: z.enum(['factAnchor', 'parallelView', 'relationshipBridge', 'legacy', 'sourceConflict']),
});

const TransitionSchema = z.strictObject({
  inheritance: z.string(),
  unresolvedTension: z.string(),
  newPressure: z.string(),
  bridge: z.string().min(1),
  transitionEvent: z.string(),
  changedMeaning: z.string(),
});

export const BiographyStageSchema = z.strictObject({
  id: z.string().min(1),
  type: z.enum(['stable', 'transition', 'turbulent']),
  title: z.string().min(1),
  span: z.string().min(1),
  diceMaterial: z.string().min(1),
  content: z.string().min(1),
  transitionFromPrevious: TransitionSchema,
  people: z.array(z.string().min(1)),
  factions: z.array(z.string().min(1)),
  objects: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  sourceRefs: SourceRefs,
  biographyUsage: z.array(BiographyUsageSchema),
  inference: z.boolean(),
});

export const BiographySchema = z.strictObject({
  schema: z.literal('eyon.biography.v1'),
  requestId: z.string().min(1),
  playerDirective: z.strictObject({
    raw: z.string().min(1),
    interpretedTarget: z.string().min(1),
    hardTimeScope: z.string(),
    primaryDirection: z.string().min(1),
    secondaryInterests: z.array(z.string().min(1)),
    reconciliation: z.string(),
  }),
  target: z.strictObject({
    type: z.enum(['person', 'region', 'object']),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    sourceRefs: SourceRefs,
  }),
  span: z.strictObject({
    mode: z.enum(['calendar', 'age', 'mixed']),
    start: BiographyDateSchema,
    end: BiographyDateSchema,
    label: z.string().min(1),
  }),
  origin: BiographyPassageSchema,
  stages: z.array(BiographyStageSchema).min(5).max(8),
  status: BiographyPassageSchema,
  summary: z.string().min(1),
  indexes: z.strictObject({
    people: z.array(z.string().min(1)),
    factions: z.array(z.string().min(1)),
    objects: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    themes: z.array(z.string().min(1)),
    potentialRuinLinks: z.array(z.string().min(1)),
  }),
  rootTrace: z.string().min(1),
  qualityChecks: z.strictObject({
    playerDirectionFulfilled: z.boolean(),
    hardTimeScopeRespected: z.boolean(),
    worldbookConsistent: z.boolean(),
    stageTransitionsCoherent: z.boolean(),
    diceIntegratedWithoutHijacking: z.boolean(),
    existingBiographiesUsedResponsibly: z.boolean(),
    rootTraceMatchesStructuredData: z.boolean(),
  }),
});

export const BiographyErrorSchema = z.strictObject({
  schema: z.literal('eyon.biography.v1'),
  requestId: z.string().min(1),
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type Biography = z.infer<typeof BiographySchema>;
export type BiographyStage = z.infer<typeof BiographyStageSchema>;
export type BiographyError = z.infer<typeof BiographyErrorSchema>;
