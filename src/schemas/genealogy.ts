import { z } from 'zod';

z.config({ jitless: true });

export const GenealogyEraSchema = z.string().trim().max(80);

export const GenealogyLifeDateSchema = z.strictObject({
  status: z.enum(['known', 'unknown', 'alive', 'deceased']),
  era: GenealogyEraSchema,
  year: z.number().int().nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  day: z.number().int().min(1).max(31).nullable(),
  precision: z.enum(['exact', 'approximate', 'unknown']),
  label: z.string().min(1),
});

export const GenealogyLineageKindSchema = z.enum([
  'native', 'same-world-travel', 'cross-world-travel', 'possession',
  'reincarnation', 'adoption', 'creation',
]);
const IdentityTrackSchema = z.object({
  name: z.string().trim().max(80).optional().catch(undefined),
  world: z.string().trim().max(80).optional(),
  birth: GenealogyLifeDateSchema.optional(),
  death: GenealogyLifeDateSchema.optional(),
});
export const GenealogyIdentitySchema = z.object({
  lineageKind: GenealogyLineageKindSchema,
  body: IdentityTrackSchema.optional().catch(undefined),
  soul: IdentityTrackSchema.optional().catch(undefined),
  arrival: GenealogyLifeDateSchema.optional().catch(undefined),
  activation: GenealogyLifeDateSchema.optional().catch(undefined),
  incarnation: GenealogyLifeDateSchema.optional().catch(undefined),
  identityEnd: GenealogyLifeDateSchema.optional().catch(undefined),
  originAge: z.object({ years: z.number().nonnegative(), at: GenealogyLifeDateSchema }).optional().catch(undefined),
  note: z.string().trim().max(240).optional().catch(undefined),
});

export const GenealogyNodeSchema = z.strictObject({
  id: z.string().min(1),
  mvuId: z.string(),
  name: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  generation: z.number().int(),
  isFocus: z.boolean(),
  isMvuCharacter: z.boolean(),
  viewable: z.literal(true),
  canInjectToRuin: z.boolean(),
  provenance: z.enum(['explicit', 'inferred', 'generated']),
  identity: GenealogyIdentitySchema.optional().catch(undefined),
  birth: GenealogyLifeDateSchema,
  death: GenealogyLifeDateSchema,
  race: z.string().min(1),
  identities: z.array(z.string().min(1)),
  professions: z.array(z.string().min(1)).min(1),
  lifeLevel: z.string(),
  relationToFocus: z.string().min(1),
  summary: z.string().min(1),
  profile: z.strictObject({
    personality: z.string().min(1),
    lifeExperience: z.string().min(1),
  }).default({
    personality: '性格资料不详。',
    lifeExperience: '经历资料不详。',
  }),
  sourceRefs: z.array(z.string().min(1)),
  historyRefs: z.array(z.strictObject({
    biographyId: z.string().min(1),
    stageId: z.string().min(1),
  })).default([]).catch([]),
});

export const GenealogyRelationTypeSchema = z.enum([
  'parent',
  'child',
  'spouse',
  'sibling',
  'halfSibling',
  'adoptiveParent',
  'adoptiveChild',
  'guardian',
  'ward',
  'grandparent',
  'grandchild',
  'uncleAunt',
  'nephewNiece',
  'cousin',
  'ancestor',
  'descendant',
  'creator',
  'creation',
  'soulOrigin',
  'incarnation',
  'owner',
  'owned',
  'predecessor',
  'successor',
  'sameSource',
]);

export const GenealogyEdgeSchema = z.strictObject({
  track: z.enum(['body', 'soul', 'social', 'creation']).optional().catch(undefined),
  period: z.object({
    from: GenealogyLifeDateSchema.optional().catch(undefined),
    to: GenealogyLifeDateSchema.optional().catch(undefined),
  }).optional().catch(undefined),
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  relationType: GenealogyRelationTypeSchema,
  label: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)),
});

export const GenealogyResultSchema = z.strictObject({
  schema: z.literal('eyon.genealogy.v2'),
  requestId: z.string().min(1),
  focusCharacterId: z.string().min(1),
  focusCharacterName: z.string().min(1),
  depth: z.strictObject({
    ancestors: z.number().int().min(1).max(8),
    descendants: z.number().int().min(0).max(6),
    maxPerGeneration: z.number().int().min(1).max(7).default(4),
  }),
  nodes: z.array(GenealogyNodeSchema).min(1),
  edges: z.array(GenealogyEdgeSchema),
  referenceSummary: z.strictObject({
    familyNames: z.array(z.string().min(1)),
    knownResidences: z.array(z.string().min(1)),
    knownOrganizations: z.array(z.string().min(1)),
    brief: z.string().min(1),
  }),
  qualityChecks: z.strictObject({
    focusIsMvuCharacter: z.boolean(),
    generatedNodesHaveProvenance: z.boolean(),
    allNodesHaveLifeDates: z.boolean(),
    allNodesHaveBasicProfiles: z.boolean(),
    // Legacy compatibility marker, no longer an authorization decision.
    onlyMvuNodesCanInjectToRuin: z.boolean().optional().default(false),
    noConflictNarrative: z.boolean(),
  }),
});

export const GenealogyErrorSchema = z.strictObject({
  schema: z.literal('eyon.genealogy.v2'),
  requestId: z.string(),
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const GenealogyGenerationInputSchema = z.strictObject({
  lineageKind: z.union([z.literal('auto'), GenealogyLineageKindSchema]).optional(),
  identityNote: z.string().trim().max(240).optional(),
  focusCharacter: z.strictObject({
    mvuId: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
  }),
  depth: z.strictObject({
    ancestors: z.number().int().min(1).max(8),
    descendants: z.number().int().min(0).max(6),
    maxPerGeneration: z.number().int().min(1).max(7).default(4),
  }),
});

export type GenealogyResult = z.infer<typeof GenealogyResultSchema>;
export type GenealogyNode = z.infer<typeof GenealogyNodeSchema>;
export type GenealogyGenerationInput = z.infer<typeof GenealogyGenerationInputSchema>;
