import { z } from 'zod';

export const EyonEraSchema = z.enum([
  '创世纪元',
  '神明纪元',
  '混乱纪元',
  '英雄纪元',
  '复兴纪元',
]);

export const RuinPeriodTypeSchema = z.enum([
  'stable',
  'transition',
  'turbulent',
]);

export const RuinWaveLevelSchema = z.enum([
  'stable',
  'ripple',
  'surge',
  'howl',
]);

const NullableCalendarPart = z.number().int().nullable();
const SourceRefs = z.array(z.string().min(1));

export const RuinDateSchema = z.strictObject({
  year: z.number().int(),
  month: NullableCalendarPart,
  day: NullableCalendarPart,
});

export const RuinNodeTimeSchema = RuinDateSchema.extend({
  hour: NullableCalendarPart,
  minute: NullableCalendarPart,
  label: z.string().min(1),
});

const RuinBranchSchema = z.strictObject({
  condition: z.string().min(1),
  consequence: z.string().min(1),
});

const RuinInterestSchema = z.strictObject({
  actor: z.string().min(1),
  wants: z.string().min(1),
  fears: z.string().min(1),
});

export const RuinNodeSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['origin', 'process', 'anomaly', 'result']),
  time: RuinNodeTimeSchema,
  location: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  cause: z.string().min(1),
  causalMechanism: z.string().min(1),
  participants: z.array(z.string().min(1)),
  interests: z.array(RuinInterestSchema),
  materialConditions: z.array(z.string().min(1)),
  opposition: z.string(),
  visibleTrace: z.string().min(1),
  intervention: z.string(),
  possibleBranches: z.array(RuinBranchSchema),
  enterable: z.boolean(),
  inference: z.boolean(),
  sourceRefs: SourceRefs,
});

const RuinCastSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(['person', 'family', 'organization', 'faction', 'community']),
  identity: z.string().min(1),
  role: z.string().min(1),
  desire: z.string().min(1),
  constraint: z.string().min(1),
  sourceRefs: SourceRefs,
  inference: z.boolean(),
});

const SelectedCharacterUsageSchema = z.strictObject({
  name: z.string().min(1),
  mode: z.enum([
    'actor',
    'lineage',
    'organization',
    'objectLegacy',
    'laterRecord',
    'notApplicable',
  ]),
  role: z.string().min(1),
  reason: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
});

const BiographyUsageSchema = z.strictObject({
  biographyId: z.string().min(1),
  stageId: z.string().min(1),
  usage: z.enum([
    'factAnchor',
    'witness',
    'causalBridge',
    'legacy',
    'sourceConflict',
  ]),
  explanation: z.string().min(1),
});

export const RuinCandidateSchema = z.strictObject({
  id: z.string().min(1),
  candidateKey: z.string().min(1),
  title: z.string().min(1),
  periodType: RuinPeriodTypeSchema,
  span: z.strictObject({
    start: RuinDateSchema,
    end: RuinDateSchema,
    label: z.string().min(1),
  }),
  premise: z.string().min(1),
  summary: z.string().min(1),
  historyProse: z.string().min(1),
  fusion: z.strictObject({
    normalOrder: z.string().min(1),
    latentFault: z.string().min(1),
    pressuredActors: z.array(z.string().min(1)).min(1),
    bridge: z.strictObject({
      type: z.enum([
        'person',
        'resource',
        'institution',
        'location',
        'relationship',
        'technology',
        'custom',
        'other',
      ]),
      name: z.string().min(1),
      explanation: z.string().min(1),
    }),
    triggerImpact: z.string().min(1),
    forcedDecision: z.string().min(1),
    irreversibleTurn: z.string().min(1),
    historicalResult: z.string().min(1),
  }),
  shift: z.strictObject({
    from: RuinPeriodTypeSchema,
    to: RuinPeriodTypeSchema,
    explanation: z.string().min(1),
  }),
  nodes: z.array(RuinNodeSchema).min(4).max(8),
  cast: z.array(RuinCastSchema).min(1),
  selectedCharacterUsage: z.array(SelectedCharacterUsageSchema),
  historicalTexture: z.strictObject({
    dailyLife: z.array(z.string().min(1)).min(1),
    institutions: z.array(z.string().min(1)).min(1),
    materialCulture: z.array(z.string().min(1)).min(1),
    socialDivisions: z.array(z.string().min(1)).min(1),
  }),
  sourceRefs: SourceRefs,
  biographyUsage: z.array(BiographyUsageSchema).max(3),
  inferenceNotes: z.array(z.string().min(1)),
  qualityChecks: z.strictObject({
    threeMaterialsIntegrated: z.boolean(),
    causalChainComplete: z.boolean(),
    anomalyEnterable: z.boolean(),
    timelineConsistent: z.boolean(),
    distinctFromOtherCandidates: z.boolean(),
    supplementaryDirectionFulfilled: z.boolean(),
    selectedCharactersReconciled: z.boolean(),
    clicheDependence: z.boolean(),
  }),
});

export const RuinCandidatesSchema = z.strictObject({
  schema: z.literal('eyon.ruin.candidates.v2'),
  requestId: z.string().min(1),
  era: EyonEraSchema,
  location: z.string().min(1),
  wave: z.strictObject({
    level: RuinWaveLevelSchema,
    candidateCount: z.number().int().min(3).max(5),
  }),
  candidates: z.array(RuinCandidateSchema).min(3).max(5),
});

export const RuinCandidatesErrorSchema = z.strictObject({
  schema: z.literal('eyon.ruin.candidates.v2'),
  requestId: z.string(),
  era: z.string(),
  location: z.string(),
  wave: z.strictObject({
    level: z.string(),
    candidateCount: z.number().int(),
  }),
  candidates: z.array(z.never()),
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const RuinSelectedCharacterSchema = z.strictObject({
  mvuId: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['mvu', 'genealogy']),
  identities: z.array(z.string().min(1)),
  race: z.string(),
  professions: z.array(z.string().min(1)),
  relations: z.array(z.string().min(1)),
  lifespan: z.string(),
  contextSummary: z.string(),
});

export const RuinMaterialSchema = z.strictObject({
  candidateKey: z.string().min(1),
  periodType: RuinPeriodTypeSchema,
  background: z.string().min(1),
  conflict: z.string().min(1),
  trigger: z.string().min(1),
});

export const RuinGenerationInputSchema = z.strictObject({
  era: EyonEraSchema,
  start: RuinDateSchema.nullable(),
  end: RuinDateSchema.nullable(),
  location: z.string().trim().min(1),
  supplementaryDirection: z.string(),
  selectedCharacters: z.array(RuinSelectedCharacterSchema),
  wave: z.strictObject({
    level: RuinWaveLevelSchema,
    candidateCount: z.number().int().min(3).max(5),
  }),
  materials: z.array(RuinMaterialSchema).min(3).max(5),
});

export type RuinCandidates = z.infer<typeof RuinCandidatesSchema>;
export type RuinCandidate = z.infer<typeof RuinCandidateSchema>;
export type RuinNode = z.infer<typeof RuinNodeSchema>;
export type RuinGenerationInput = z.infer<typeof RuinGenerationInputSchema>;
