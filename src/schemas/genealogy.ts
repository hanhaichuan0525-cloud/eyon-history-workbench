import { z } from 'zod';

z.config({ jitless: true });

export const GenealogyEraSchema = z.enum([
  '创世纪元',
  '神明纪元',
  '混乱纪元',
  '英雄纪元',
  '复兴纪元',
  '',
]);

export const GenealogyLifeDateSchema = z.strictObject({
  status: z.enum(['known', 'unknown', 'alive', 'deceased']),
  era: GenealogyEraSchema,
  year: z.number().int().nullable(),
  month: z.number().int().min(1).max(12).nullable(),
  day: z.number().int().min(1).max(31).nullable(),
  precision: z.enum(['exact', 'approximate', 'unknown']),
  label: z.string().min(1),
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
]);

export const GenealogyEdgeSchema = z.strictObject({
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
