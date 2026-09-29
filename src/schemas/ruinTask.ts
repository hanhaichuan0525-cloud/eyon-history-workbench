import { z } from 'zod';

z.config({ jitless: true });
import { parseSingleJsonObject } from '../core/json.ts';

export const RUIN_TASK_FP = {
  D: 100,
  C: 300,
  B: 900,
  A: 2200,
  S: 5000,
} as const;

export const RuinTaskInterpretationSchema = z.enum([
  '原意锁定',
  '情境补全',
  '自由演绎',
]);

export const RuinTaskScaleSchema = z.enum([
  '即时互动',
  '短程目标',
  '阶段任务',
]);

export type RuinTaskInterpretation = z.infer<typeof RuinTaskInterpretationSchema>;
export type RuinTaskScale = z.infer<typeof RuinTaskScaleSchema>;

export const RuinTaskDraftSchema = z.object({
  schema: z.literal('eyon.ruin-task.v1'),
  task: z.object({
    title: z.string().trim().min(2).max(28),
    mode: z.enum(['个人', '团队']),
    status: z.literal('进行中'),
    attention: z.enum(['高', '中', '低']),
    progress: z.string().trim().min(2).max(120),
    detail: z.string().trim().min(8).max(360),
    objective: z.string().trim().min(8).max(280),
    difficulty: z.enum(['D', 'C', 'B', 'A', 'S']),
    /** @deprecated 货币由脚本从当前世界书解析；仅容忍旧模型多返回此字段。 */
    currencyReward: z.string().trim().min(2).max(60)
      .refine(value => !/(?:^|[^A-Z])G(?:$|[^A-Z])/u.test(value.toUpperCase()), {
        message: '必须写世界内货币，不能使用通用G占位',
      })
      .refine(value => !/\bEXP\b/iu.test(value), {
        message: '墟境任务不发放EXP',
      }).optional(),
    itemReward: z.string().trim().min(2).max(80),
  }).strict(),
}).strict();

export type RuinTaskDraft = z.infer<typeof RuinTaskDraftSchema>;

export interface RuinTaskRecord {
  title: string;
  mode: '个人' | '团队';
  difficulty: keyof typeof RUIN_TASK_FP;
  commissioner: '伊雍';
  name: string;
  value: {
    状态: string;
    关注度: '高' | '中' | '低';
    进展: string;
    详情: string;
    目标: string;
    奖励: string;
  };
}

export function parseRuinTaskDraft(raw: string): RuinTaskDraft {
  const parsed = parseSingleJsonObject(raw, { schema: 'eyon.ruin-task.v1' });
  const result = RuinTaskDraftSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 6)
      .map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
    throw new Error(`墟境任务草案不符合契约：${detail}`);
  }
  return result.data;
}

export function materializeRuinTask(
  draft: RuinTaskDraft,
  currencyReward: string,
): RuinTaskRecord {
  const title = draft.task.title
    .replace(/^\[墟境任务[·・](?:个人|团队)\]\s*/u, '')
    .trim();
  if (!title) throw new Error('墟境任务名称为空');
  const fp = RUIN_TASK_FP[draft.task.difficulty];
  const rewards = [
    `${fp} FP`,
    currencyReward,
    draft.task.itemReward,
  ];
  return {
    title,
    mode: draft.task.mode,
    difficulty: draft.task.difficulty,
    commissioner: '伊雍',
    name: `[墟境任务·${draft.task.mode}]${title}`,
    value: {
      状态: draft.task.status,
      关注度: draft.task.attention,
      进展: draft.task.progress,
      详情: `${draft.task.difficulty}级。${draft.task.detail}`,
      目标: draft.task.objective,
      奖励: rewards.join('；'),
    },
  };
}
