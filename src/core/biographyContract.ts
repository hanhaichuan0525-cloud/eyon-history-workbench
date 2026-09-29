/**
 * 传记生成的单一真源约束。
 *
 * 提示词、规则文件与校验器都必须从这里读取硬约束，禁止再手写魔法数字，
 * 以免出现「规则文件说 100 字、提示词说 300 字、校验器判 300 字」的三层漂移。
 */

export const BIOGRAPHY_CONTRACT = {
  // 单块正文长度（去空白后的**字符总数，含标点**）
  // 断代志凝练目标：330~450 字/段；给模型的推荐下限抬到 330——
  // 让模型在 300 上下 ±10 的自然落点抖动永远跌不过校验硬门（minPassageChars=300）。
  minPassageChars: 300,          // 推荐下限（提示词要求；不再是判死硬门）
  softMinPassageChars: 260,      // 校验软下限（internal.79 v5：260~299 放行——字数下限是「防敷衍」
                                 // 的软质量代理，不是机器协议；79 v3 柔性方向使段落自然偏短，
                                 // 300 一刀切误杀擦边段落（真机 298 拒）；低于 260 仍拒并带扩写指引）
  targetPassageCharsMin: 330,    // 给模型的推荐下限（高于推荐下限，留安全余量）
  targetPassageCharsMax: 450,

  // 阶段数量（与骰表 table_1_stage_count 保持一致）
  minStages: 5,
  maxStages: 8,

  // 每次扩写请求承载的块数（小批量，严格顺序）。
  // 3 块一批时单请求输出约 1500~2100 字，容易触发截断重试反而更慢；
  // 2 块一批在 4096 token 预算内稳定不截断，兼顾请求数与速度。
  batchSize: 2,

  // 阶段节奏标签（骰表锁定，表示叙事节奏，与「变化轴 changeAxis」正交）
  stageTypes: ['stable', 'transition', 'turbulent'] as const,

  // 每段正文必须满足的内容要素（断代志体：落地/立人/决定性瞬间；因果不再是硬要素）
  passageElements: ['sceneGrounded', 'figureVivid', 'decisiveMoment'] as const,
} as const;
