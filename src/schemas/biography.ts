import { z } from 'zod';

z.config({ jitless: true });

const SourceRefs = z.array(z.string().min(1));
const NullableInteger = z.number().int().nullable();

const BiographyDateSchema = z.object({
  year: NullableInteger,
  month: NullableInteger,
  day: NullableInteger,
  // 时精度：可缺省（模型不写时视为无）
  hour: NullableInteger.optional(),
  age: NullableInteger,
  // 纪元名（如「复兴纪元」）：跨纪元判定与展示用，可缺省
  era: z.string().optional(),
});

const BiographyPassageSchema = z.object({
  title: z.string().min(1),
  content: z.string().min(1),
  sourceRefs: SourceRefs,
  inference: z.boolean(),
});

const BiographyUsageSchema = z.object({
  biographyId: z.string().min(1),
  stageId: z.string().min(1),
  usage: z.enum(['factAnchor', 'parallelView', 'relationshipBridge', 'legacy', 'sourceConflict']),
});

/** 可选展示建议；缺失或不合格时由共享展示解析器静默回退。 */
const BiographyPresentationSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
});

/**
 * 规划阶段冻结的主事件占位。一个 passage 只能有一个主事件；同一 eventId
 * 可以在别处作为回忆/余波出现，但不能被改个年份再次当作“发生中”的事件。
 */
export const BiographyEventAssignmentSchema = z.object({
  passageId: z.string().min(1),
  eventId: z.string().min(1),
  summary: z.string().min(1),
  usage: z.enum(['occurs', 'aftermath', 'recollection', 'evidence', 'background']),
  sourceRefs: SourceRefs,
});

export const BiographyStageSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['stable', 'transition', 'turbulent']),
  title: z.string().min(1),
  span: z.string().min(1),
  diceMaterial: z.string().min(1),
  content: z.string().min(1),
  // 本段新登场的人物/种族/机构（由 plan.introduced 透传，供展示与校验）
  introduced: z.array(z.string().min(1)).default([]),
  // 停滞期标记：本段没有戏剧性推进时合法（写恢复条件而非硬编转折）
  stalled: z.boolean().optional(),
  // 本段推进者：player = 主角介入推动，world = 历史/世界自演化
  driver: z.enum(['player', 'world']).optional(),
  people: z.array(z.string().min(1)),
  factions: z.array(z.string().min(1)),
  objects: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  sourceRefs: SourceRefs,
  biographyUsage: z.array(BiographyUsageSchema),
  inference: z.boolean(),
});

export const BiographySchema = z.object({
  schema: z.literal('eyon.biography.v1'),
  requestId: z.string().min(1),
  playerDirective: z.object({
    raw: z.string().min(1),
    interpretedTarget: z.string().min(1),
    hardTimeScope: z.string(),
    primaryDirection: z.string().min(1),
    secondaryInterests: z.array(z.string().min(1)),
    reconciliation: z.string(),
  }),
  target: z.object({
    type: z.enum([
      'person',
      'region',
      'object',
      'organ',
      'institution',
      'concept',
      'entity',
    ]),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    sourceRefs: SourceRefs,
    // 消歧声明：玩家指令中逐字指代目标的那段原话（校验依据，缺省回退 interpretedTarget）
    playerReference: z.string().optional(),
    // 空白层原创对象标记：资料库中不存在该实体时由模型声明 true
    inference: z.boolean().optional(),
  }),
  presentation: BiographyPresentationSchema.optional(),
  span: z.object({
    mode: z.enum(['calendar', 'age', 'mixed']),
    start: BiographyDateSchema,
    end: BiographyDateSchema,
    // 展示标签由脚本按跨度自适应生成（renderSpanLabel），模型可不输出；
    // 组装阶段总会确定性重渲染为非空值。
    label: z.string().optional(),
  }),
  origin: BiographyPassageSchema,
  stages: z.array(BiographyStageSchema).min(5).max(8),
  status: BiographyPassageSchema,
  summary: z.string().min(1),
  indexes: z.object({
    people: z.array(z.string().min(1)),
    factions: z.array(z.string().min(1)),
    objects: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    themes: z.array(z.string().min(1)),
    potentialRuinLinks: z.array(z.string().min(1)),
  }),
  rootTrace: z.string().min(1),
  qualityChecks: z.object({
    playerDirectionFulfilled: z.boolean(),
    hardTimeScopeRespected: z.boolean(),
    worldbookConsistent: z.boolean(),
    diceIntegratedWithoutHijacking: z.boolean(),
    existingBiographiesUsedResponsibly: z.boolean(),
    rootTraceMatchesStructuredData: z.boolean(),
  }),
});

export const BiographyErrorSchema = z.object({
  schema: z.literal('eyon.biography.v1'),
  requestId: z.string().min(1),
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type Biography = z.infer<typeof BiographySchema>;
export type BiographyStage = z.infer<typeof BiographyStageSchema>;
export type BiographyError = z.infer<typeof BiographyErrorSchema>;

/**
 * 规划阶段结果：四性质 + 每段语义规划 + 全局索引。
 * 取代 target.type 的生成职责；target.type 仅保留用于 UI 标题。
 */
export const BiographyPlanSchema = z.object({
  schema: z.literal('eyon.biography.plan.v1'),
  requestId: z.string().min(1),
  playerDirective: z.object({
    raw: z.string().min(1),
    interpretedTarget: z.string().min(1),
    hardTimeScope: z.string(),
    primaryDirection: z.string().min(1),
    secondaryInterests: z.array(z.string().min(1)),
    reconciliation: z.string(),
  }),
  target: z.object({
    // 仅 UI 标题显示用，不参与生成逻辑；覆盖人/地域/器物/器官/机构/概念等对象谱系
    type: z.enum([
      'person',
      'region',
      'object',
      'organ',
      'institution',
      'concept',
      'entity',
    ]).optional(),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    sourceRefs: SourceRefs,
    // 消歧声明：玩家指令中逐字指代目标的那段原话（校验依据，缺省回退 interpretedTarget）
    playerReference: z.string().optional(),
    // 空白层原创对象标记：资料库中不存在该实体时由模型声明 true
    inference: z.boolean().optional(),
  }),
  presentation: BiographyPresentationSchema.optional(),
  // —— 四性质（统一传记学核心）——
  subjectAnchor: z.string().min(1),     // 主体锚：它属于谁 / 与谁绑定
  changeAxis: z.string().min(1),        // 变化轴：它靠什么在时间里变化
  meaningCarrier: z.string().min(1),    // 意义载体：它的意义通过什么显现
  dramaticQuestion: z.string().min(1),  // 戏剧主线：这篇传记真正在追问什么
  dominantAxis: z.enum(['subjectAnchor', 'changeAxis', 'meaningCarrier', 'dramaticQuestion']),
  span: z.object({
    mode: z.enum(['calendar', 'age', 'mixed']),
    start: BiographyDateSchema,
    end: BiographyDateSchema,
    // 展示标签由脚本按跨度自适应生成（renderSpanLabel），模型可不输出
    label: z.string().optional(),
  }),
  originTitle: z.string().min(1),   // 必须形如「起源(时间)」
  statusTitle: z.string().min(1),   // 必须形如「现状(时间)」
  // origin、每个 stage 与 status 各占一个主事件槽；扩写只能执行本槽事件。
  eventAssignments: z.array(BiographyEventAssignmentSchema).min(7).max(10),
  stages: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['stable', 'transition', 'turbulent']),
    diceMaterial: z.string().min(1),
    title: z.string().min(1),
    // 本段结构化起止时间（至少一侧含 year 或 age 锚点）；展示标签由脚本按跨度自适应生成
    span: z.object({
      start: BiographyDateSchema,
      end: BiographyDateSchema,
    }),
    theme: z.string().min(1),        // 本段叙事主题 / 对戏剧主线的推进
    // 本段新登场的人物/种族/机构名（全篇宽松校验）
    introduced: z.array(z.string().min(1)).default([]),
    // 停滞期标记：没有戏剧性推进时合法，正文写恢复条件而非硬编转折
    stalled: z.boolean().optional(),
    // 本段推进者：player = 主角介入推动，world = 历史/世界自演化
    driver: z.enum(['player', 'world']).optional(),
    sourceRefs: SourceRefs,
  })).min(5).max(8),
  // —— 全局字段（供 assembleBiography 拼装完整 Biography）——
  summary: z.string().min(1),
  indexes: z.object({
    people: z.array(z.string().min(1)),
    factions: z.array(z.string().min(1)),
    objects: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    themes: z.array(z.string().min(1)),
    potentialRuinLinks: z.array(z.string().min(1)),
  }),
  qualityChecks: z.object({
    playerDirectionFulfilled: z.boolean(),
    hardTimeScopeRespected: z.boolean(),
    worldbookConsistent: z.boolean(),
    diceIntegratedWithoutHijacking: z.boolean(),
    existingBiographiesUsedResponsibly: z.boolean(),
  }),
  sourceRefs: SourceRefs,
});

/**
 * 单块扩写结果：origin / stage / status 之一的一段正文。
 * 与 BiographyPassageSchema（origin/status 的 shape）不同，这里是扩写响应的完整契约。
 */
export const BiographyPassageResponseSchema = z.object({
  schema: z.literal('eyon.biography.passage.v1'),
  requestId: z.string().min(1),
  passageId: z.string().min(1),      // 与 plan 里的 id 对齐（origin / stage-1 / status）
  kind: z.enum(['origin', 'stage', 'status']),
  title: z.string().min(1),
  content: z.string().min(1),
  people: z.array(z.string().min(1)),
  factions: z.array(z.string().min(1)),
  objects: z.array(z.string().min(1)),
  locations: z.array(z.string().min(1)),
  sourceRefs: SourceRefs,
  biographyUsage: z.array(BiographyUsageSchema),
  // 必须逐字回报规划分配给本段的事件身份与用法，供脚本做机器校验。
  eventId: z.string().min(1),
  eventUsage: z.enum(['occurs', 'aftermath', 'recollection', 'evidence', 'background']),
  inference: z.boolean(),
  // 内容要素自检（模型自报，脚本抽查；断代志体不设因果硬门槛）
  elementChecklist: z.object({
    sceneGrounded: z.boolean(),   // 有一段具体的时间/地点落点
    figureVivid: z.boolean(),     // 有人物立得住 / 或器物俗务被写活
    decisiveMoment: z.boolean(),  // 有一个决定性瞬间（不必是「因」）
  }),
});

/** 小批量扩写响应：一次请求生成 2 块正文（块间各自独立，仅时间与对象连续） */
export const BiographyPassageBatchSchema = z.object({
  schema: z.literal('eyon.biography.passage.batch.v1'),
  requestId: z.string().min(1),
  passages: z.array(BiographyPassageResponseSchema).min(1).max(3),
});

export type BiographyPlan = z.infer<typeof BiographyPlanSchema>;
export type BiographyPassageResponse = z.infer<typeof BiographyPassageResponseSchema>;
export type BiographyPassageBatch = z.infer<typeof BiographyPassageBatchSchema>;
