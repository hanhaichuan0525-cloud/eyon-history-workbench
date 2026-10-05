import { z } from 'zod';
import { GenealogyIdentitySchema } from './genealogy.ts';
import { RuinCreativeReferencesSchema } from '../core/creativeReferences.ts';

z.config({ jitless: true });

export const KNOWN_EYON_ERAS = [
  '创世纪元',
  '神明纪元',
  '混乱纪元',
  '英雄纪元',
  '复兴纪元',
] as const;

export type KnownEyonEra = typeof KNOWN_EYON_ERAS[number];

/**
 * 墟境可读取角色卡扩展自定义的纪年名。这里只接受一个简短的
 * 纪年标识；具体是否真实存在，由墟境 Context 在完整世界书语料中
 * 做精确锚定，而不在 schema 里猜测。
 */
export const EyonEraSchema = z.preprocess(
  value => typeof value === 'string' ? value.normalize('NFKC').trim() : value,
  z.string()
    .min(2, '纪年名称至少需要2个字符')
    .max(32, '纪年名称不得超过32个字符')
    .refine(value => !/[\r\n<>]/u.test(value), '纪年名称不得包含换行或标签字符'),
);

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

function ruinNodeTimeTuple(value: unknown): number[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const time = (value as Record<string, unknown>).time;
  if (!time || typeof time !== 'object' || Array.isArray(time)) return null;
  const record = time as Record<string, unknown>;
  if (typeof record.year !== 'number') return null;
  return [
    record.year,
    typeof record.month === 'number' ? record.month : 0,
    typeof record.day === 'number' ? record.day : 0,
    typeof record.hour === 'number' ? record.hour : 0,
    typeof record.minute === 'number' ? record.minute : 0,
  ];
}

function compareTimeTuple(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizeRuinNodeOrder(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value
    .map((node, index) => ({ node, index, time: ruinNodeTimeTuple(node) }))
    .sort((left, right) => {
      if (!left.time || !right.time) return left.index - right.index;
      return compareTimeTuple(left.time, right.time) || left.index - right.index;
    })
    .map(item => item.node);
}

const RUIN_CAST_KIND_ALIASES: Readonly<Record<string, string>> = {
  individual: 'person',
  character: 'person',
  npc: 'person',
  '人物': 'person',
  '个人': 'person',
  clan: 'family',
  house: 'family',
  lineage: 'family',
  dynasty: 'family',
  '家族': 'family',
  '宗族': 'family',
  '氏族': 'family',
  institution: 'organization',
  guild: 'organization',
  church: 'organization',
  company: 'organization',
  academy: 'organization',
  order: 'organization',
  '组织': 'organization',
  '机构': 'organization',
  '教会': 'organization',
  '行会': 'organization',
  '商会': 'organization',
  '学院': 'organization',
  camp: 'faction',
  bloc: 'faction',
  party: 'faction',
  force: 'faction',
  '势力': 'faction',
  '阵营': 'faction',
  '派系': 'faction',
  settlement: 'community',
  village: 'community',
  town: 'community',
  population: 'community',
  '社群': 'community',
  '社区': 'community',
  '聚落': 'community',
  '村镇': 'community',
};

function normalizeRuinCastKind(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return RUIN_CAST_KIND_ALIASES[normalized] ?? normalized;
}

function normalizeModelBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== 'string') return value;
  const normalized = value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  if (['true', 'yes', 'y', '1', '是', '真', '通过', '符合'].includes(normalized)) {
    return true;
  }
  if (['false', 'no', 'n', '0', '否', '假', '不通过', '不符合'].includes(normalized)) {
    return false;
  }
  return value;
}

function normalizeInferenceFlag(value: unknown): boolean {
  const normalized = normalizeModelBoolean(value);
  return typeof normalized === 'boolean' ? normalized : true;
}

const ModelBoolean = z.preprocess(normalizeModelBoolean, z.boolean());
const InferenceBoolean = z.preprocess(normalizeInferenceFlag, z.boolean());

export const RuinDateSchema = z.strictObject({
  year: z.number().int().nullable(),
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
  fears: z.preprocess(
    value => typeof value === 'string' && value.trim()
      ? value.trim()
      : '其既有立场、资源或安全保障遭到破坏',
    z.string().min(1),
  ),
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
  enterable: ModelBoolean,
  inference: InferenceBoolean,
  sourceRefs: SourceRefs,
});

const RuinCastSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.preprocess(
    normalizeRuinCastKind,
    z.enum(['person', 'family', 'organization', 'faction', 'community']),
  ),
  identity: z.string().min(1),
  role: z.string().min(1),
  desire: z.string().min(1),
  constraint: z.string().min(1),
  sourceRefs: SourceRefs,
  inference: InferenceBoolean,
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

const RuinCanonInterpretationSchema = z.strictObject({
  /** 默认是独立事件；只有史料确实语焉不详时，才把多个候选声明为互斥解释。 */
  mode: z.enum(['independent-event', 'alternative-interpretation']),
  hypothesis: z.string().min(1),
  evidenceFactIds: z.array(z.string().min(1)),
  /** 世界书/MVU/历史产物中的 passage-local 证据；与人物 factId 严格分栏。 */
  evidencePassageIds: z.array(z.string().min(1)).optional(),
  eventUsages: z.array(z.strictObject({
    eventId: z.string().min(1),
    usage: z.enum(['occurs', 'aftermath', 'recollection', 'evidence', 'background']),
    explanation: z.string().min(1),
  })).min(1),
  assumptions: z.array(z.strictObject({
    claim: z.string().min(1),
    evidenceFactIds: z.array(z.string().min(1)),
    evidencePassageIds: z.array(z.string().min(1)).optional(),
    confidence: z.enum(['high', 'medium', 'low']),
    alternatives: z.array(z.string().min(1)),
  })),
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
  historyProse: z.string().trim().min(1),
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
  nodes: z.preprocess(
    normalizeRuinNodeOrder,
    z.array(RuinNodeSchema).min(4).max(8),
  ),
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
  /** P0-C 机器可读解释回执；旧缓存可缺省，新提纲会确定性补齐。 */
  canonInterpretation: RuinCanonInterpretationSchema.optional(),
  inferenceNotes: z.array(z.string().min(1)),
  qualityChecks: z.strictObject({
    threeMaterialsIntegrated: ModelBoolean,
    causalChainComplete: ModelBoolean,
    anomalyEnterable: ModelBoolean,
    timelineConsistent: ModelBoolean,
    distinctFromOtherCandidates: ModelBoolean,
    supplementaryDirectionFulfilled: ModelBoolean,
    selectedCharactersReconciled: ModelBoolean,
    clicheDependence: ModelBoolean,
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
  // 候选重名提示（internal.76 收尾 A3）：跨候选相同名字但不同身份 → warning，不 repair。
  castNameWarnings: z.array(z.string()).default([]),
});

export const RuinCandidateResponseSchema = z.strictObject({
  schema: z.literal('eyon.ruin.candidate.v1'),
  requestId: z.string().min(1),
  era: EyonEraSchema,
  location: z.string().min(1),
  candidateKey: z.string().min(1),
  candidate: RuinCandidateSchema,
});

export const RuinCandidatePlanSchema = z.strictObject({
  candidateKey: z.string().min(1),
  periodType: RuinPeriodTypeSchema,
  titleDirection: z.string().min(1),
  centralIncident: z.string().min(1),
  causalDifference: z.string().min(1),
  anomalyDirection: z.string().min(1),
  castDirection: z.array(z.strictObject({
    name: z.string().min(1),
    identity: z.string().min(1),
  })).min(1).max(5),
});

export const RuinPlanResponseSchema = z.strictObject({
  schema: z.literal('eyon.ruin.plan.v1'),
  requestId: z.string().min(1),
  plans: z.array(RuinCandidatePlanSchema).min(3).max(5),
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
  identity: GenealogyIdentitySchema.optional(),
  referenceId: z.string().min(1).optional(),
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
  creativeReferences: RuinCreativeReferencesSchema.optional(),
  era: EyonEraSchema,
  start: RuinDateSchema.nullable(),
  end: RuinDateSchema.nullable(),
  location: z.string().trim().min(1),
  supplementaryDirection: z.string(),
  selectedCharacters: z.array(RuinSelectedCharacterSchema),
  /** 旧草稿缺省时不自动拉入亲属；手选和明确方向不受开关限制。 */
  autoGenealogy: z.boolean().optional(),
  wave: z.strictObject({
    level: RuinWaveLevelSchema,
    candidateCount: z.number().int().min(3).max(5),
  }),
  materials: z.array(RuinMaterialSchema).min(3).max(5),
});

export type RuinCandidates = z.infer<typeof RuinCandidatesSchema>;
export type RuinCandidate = z.infer<typeof RuinCandidateSchema>;
export type RuinCandidateResponse = z.infer<typeof RuinCandidateResponseSchema>;
export type RuinCandidatePlan = z.infer<typeof RuinCandidatePlanSchema>;
export type RuinPlanResponse = z.infer<typeof RuinPlanResponseSchema>;
export type RuinPeriodType = z.infer<typeof RuinPeriodTypeSchema>;
export type RuinNode = z.infer<typeof RuinNodeSchema>;
export type RuinMaterial = z.infer<typeof RuinMaterialSchema>;
export type RuinGenerationInput = z.infer<typeof RuinGenerationInputSchema>;
