import { z } from 'zod';

z.config({ jitless: true });
import type { WorkbenchCommand } from '../core/commands.ts';
import { WorkbenchGuidanceError } from '../core/workbenchGuidance.ts';
import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import {
  RuinGenerationInputSchema,
  type RuinGenerationInput,
} from '../schemas/ruin.ts';
import type { RuinGenerationInputProvider } from './workbenchLifecycle.ts';
import {
  GenerationSettingsSchema,
  type GenerationSettings,
} from './settings.ts';
import type { GenerationSettingsProvider } from './tavernGeneration.ts';
import { ButterflyReferencesSchema, type ButterflyReferences } from '../core/creativeReferences.ts';

const emptyGenerationSettings = (): GenerationSettings => ({
  apiurl: '',
  key: '',
  model: '',
  source: 'openai',
  maxTokens: 60000,
  temperature: 0.8,
});

const TaskSettingsSchema = z.object({
  genealogy: GenerationSettingsSchema.default(emptyGenerationSettings),
  ruin: GenerationSettingsSchema.default(emptyGenerationSettings),
  biography: GenerationSettingsSchema.default(emptyGenerationSettings),
  butterfly: GenerationSettingsSchema.default(emptyGenerationSettings),
});

const AppearanceSettingsSchema = z.object({
  mode: z.enum(['dark', 'light']).default('light'),
  accent: z.enum(['jade', 'gold', 'blue', 'crimson']).default('jade'),
  text: z.enum(['neutral', 'warm', 'cool']).default('neutral'),
});

const RuinPreferencesSchema = z.object({
  candidateCount: z.number().int().min(3).max(5).default(3),
});

const RetrievalSettingsSchema = z.object({
  biographyEnabled: z.boolean().default(false),
  worldbookScope: z.enum(['eyon', 'all_enabled']).default('eyon'),
  mergeAliases: z.boolean().default(true),
  worldbookEntryExclusions: z.record(
    z.string(),
    z.array(z.string()),
  ).default({}),
});

export const GENERATION_TASK_TYPES = [
  'genealogy',
  'ruin',
  'biography',
  'butterfly',
] as const;

export type GenerationTaskType = typeof GENERATION_TASK_TYPES[number];

const RetrySettingsSchema = z.object({
  genealogy: z.number().int().min(0).max(5).default(2),
  ruin: z.number().int().min(0).max(5).default(2),
  biography: z.number().int().min(0).max(5).default(2),
  butterfly: z.number().int().min(0).max(5).default(2),
});

const ErrorLogEntrySchema = z.object({
  id: z.string().min(1),
  taskType: z.enum(GENERATION_TASK_TYPES),
  message: z.string(),
  // 生成层错误码（标准信封 code，如 PLAN_SCHEMA_INVALID / UPSTREAM_BAD_GATEWAY）：
  // 用户设置页一眼分流「校验 vs 环境 vs 临时」，不再只靠读原文。
  code: z.string().optional(),
  occurredAt: z.number().int().nonnegative(),
});

export const WorkbenchSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  // 工作台开关：扩展始终自动载入；设置页负责将工作台功能标记为启用/停用。
  // 保持默认开启，兼容旧版脚本设置与首次安装；魔术棒入口始终保留以便恢复。
  // 旧设置没有这个字段时按“开启”解释；保持 optional 让旧版测试夹具/备份无需迁移。
  workbenchEnabled: z.boolean().optional(),
  generation: TaskSettingsSchema.default(() => ({
    genealogy: emptyGenerationSettings(),
    ruin: emptyGenerationSettings(),
    biography: emptyGenerationSettings(),
    butterfly: emptyGenerationSettings(),
  })),
  ruinDraft: RuinGenerationInputSchema.nullable().default(null),
  ruinDrafts: z.record(z.string(), RuinGenerationInputSchema.nullable()).optional(),
  butterflyReferences: z.record(z.string(), z.object({
    references: ButterflyReferencesSchema,
    confirmed: z.boolean(),
  })).optional(),
  genealogyDepth: z.object({
    ancestors: z.number().int().min(1).max(8).default(4),
    descendants: z.number().int().min(0).max(6).default(3),
    maxPerGeneration: z.number().int().min(1).max(7).default(4),
  }).default({
    ancestors: 4,
    descendants: 3,
    maxPerGeneration: 4,
  }),
  appearance: AppearanceSettingsSchema.default({
    mode: 'light',
    accent: 'jade',
    text: 'neutral',
  }),
  ruinPreferences: RuinPreferencesSchema.default({
    candidateCount: 3,
  }),
  retrieval: RetrievalSettingsSchema.default({
    biographyEnabled: false,
    worldbookScope: 'eyon',
    mergeAliases: true,
    worldbookEntryExclusions: {},
  }),
  retries: RetrySettingsSchema.default({
    genealogy: 2,
    ruin: 2,
    biography: 2,
    butterfly: 2,
  }),
  // custom API 请求超时（毫秒，0 = 不限制）。默认 10 分钟：
  // 慢中转上游正常成功可达 5 分钟以上，超时设置过短会把「慢但会成功」判死。
  customApiTimeoutMs: z.number().int().min(0).max(900_000).default(600_000),
  // 剧情时钟：最近一次传记正文产出的剧情时间戳（首尾 HTML 注释解析结果）。
  // 时间跟着剧情走——正文写到哪里，时钟推进到哪里。
  storyClock: z.object({
    start: z.string(),
    end: z.string(),
  }).nullable().default(null),
  // 旧版全局年龄基准。保留只为兼容旧设置的解析/导出，不再参与新任务换算；
  // 否则同一脚本切换聊天后会把上一存档的年份带进下一存档。
  baselineWorldTime: z.string().nullable().default(null),
  // 年龄基准按角色卡 + 聊天命名空间锁定。之后同一聊天内不随剧情楼层漂移，
  // 换聊天/角色卡则在对应命名空间首次任务时独立建立基准。
  baselineWorldTimes: z.record(z.string(), z.string()).default({}),
  // DeepSeek 一键结构化：json_object + thinking disabled + 输出上限 8192。
  // 面向 DeepSeek 官方 API 或 DeepSeek 系中转；其他模型保持关闭。
  deepseekStructured: z.boolean().default(false),
  errorLog: z.array(ErrorLogEntrySchema).max(50).default([]),
});

export type WorkbenchSettings = z.infer<typeof WorkbenchSettingsSchema>;

export interface ScriptVariableBindings {
  getScriptVariables(): Record<string, unknown>;
  replaceScriptVariables(variables: Record<string, unknown>): void;
}

const SETTINGS_KEY = 'eyonHistoryWorkbench';

export class ScriptWorkbenchSettings
implements GenerationSettingsProvider, RuinGenerationInputProvider {
  private readonly bindings: ScriptVariableBindings;
  private readonly namespace?: () => WorkbenchNamespace;

  constructor(bindings: ScriptVariableBindings, namespace?: () => WorkbenchNamespace) {
    this.bindings = bindings;
    this.namespace = namespace;
  }

  read(): WorkbenchSettings {
    const variables = this.bindings.getScriptVariables();
    const raw = variables[SETTINGS_KEY] ?? {};
    // 旧版（v0.10 之前）generation[task] 是 { mode: 'follow_tavern' | 'custom', custom? }。
    // follow_tavern → 空配置（未配置，生成时按未填写报错）；custom → 展开为 custom 字段。
    return WorkbenchSettingsSchema.parse(migrateLegacyGeneration(raw));
  }

  write(next: WorkbenchSettings): WorkbenchSettings {
    const parsed = WorkbenchSettingsSchema.parse(next);
    const variables = structuredClone(this.bindings.getScriptVariables());
    variables[SETTINGS_KEY] = parsed;
    this.bindings.replaceScriptVariables(variables);
    return parsed;
  }

  update(patch: Partial<WorkbenchSettings>): WorkbenchSettings {
    const current = this.read();
    return this.write({
      ...current,
      ...patch,
      generation: {
        ...current.generation,
        ...(patch.generation ?? {}),
      },
    });
  }

  getRuinDraft(namespace: WorkbenchNamespace): RuinGenerationInput | null {
    // 旧全局草稿不能冒充另一个聊天的选择。已归档候选不受此草稿迁移影响。
    return this.read().ruinDrafts?.[namespaceKey(namespace)] ?? null;
  }

  setRuinDraft(namespace: WorkbenchNamespace, draft: RuinGenerationInput | null): WorkbenchSettings {
    const current = this.read();
    return this.update({ ruinDrafts: { ...current.ruinDrafts, [namespaceKey(namespace)]: draft } });
  }

  getButterflyReferences(namespace: WorkbenchNamespace, runId: string) {
    return this.read().butterflyReferences?.[`${namespaceKey(namespace)}::${encodeURIComponent(runId)}`] ?? null;
  }

  clearButterflyReferences(namespace: WorkbenchNamespace): void {
    const prefix = `${namespaceKey(namespace)}::`;
    const current = this.read();
    this.update({ butterflyReferences: Object.fromEntries(Object.entries(current.butterflyReferences ?? {}).filter(([key]) => !key.startsWith(prefix))) });
  }

  setButterflyReferences(namespace: WorkbenchNamespace, runId: string, references: ButterflyReferences, confirmed: boolean) {
    if (!runId.trim()) throw new Error('进入墟境后才能设置本轮蝴蝶效应');
    const current = this.read();
    return this.update({ butterflyReferences: {
      ...current.butterflyReferences,
      [`${namespaceKey(namespace)}::${encodeURIComponent(runId)}`]: {
        references: ButterflyReferencesSchema.parse(references), confirmed,
      },
    } });
  }

  async get(
    taskType: GenerationTaskType,
  ): Promise<GenerationSettings> {
    return this.read().generation[taskType];
  }

  getRetryLimit(taskType: GenerationTaskType): number {
    return this.read().retries[taskType];
  }

  getCustomApiTimeoutMs(): number {
    return this.read().customApiTimeoutMs;
  }

  getDeepseekStructured(): boolean {
    return this.read().deepseekStructured;
  }

  setStoryClock(clock: { start: string; end: string } | null): WorkbenchSettings {
    return this.update({ storyClock: clock });
  }

  getStoryClock(): { start: string; end: string } | null {
    return this.read().storyClock;
  }

  /** 年龄基准时间：读取指定聊天命名空间的锁定值（可能为 null）。 */
  getBaselineWorldTime(namespace: WorkbenchNamespace): string | null {
    return this.read().baselineWorldTimes[namespaceKey(namespace)] ?? null;
  }

  /** 年龄基准时间：指定聊天首次任务时锁定；其他聊天的旧值不会串入。 */
  ensureBaselineWorldTime(
    namespace: WorkbenchNamespace,
    currentWorldTime: string,
  ): string {
    const current = this.read();
    const key = namespaceKey(namespace);
    const existing = current.baselineWorldTimes[key];
    if (existing) return existing;
    const baseline = currentWorldTime?.trim() ?? '';
    if (!baseline) return '';
    this.update({
      baselineWorldTimes: {
        ...current.baselineWorldTimes,
        [key]: baseline,
      },
    });
    return baseline;
  }

  appendError(entry: WorkbenchSettings['errorLog'][number]): WorkbenchSettings {
    const current = this.read();
    return this.write({
      ...current,
      errorLog: [
        entry,
        ...current.errorLog.filter(item => item.id !== entry.id),
      ].slice(0, 50),
    });
  }

  clearErrorLog(): WorkbenchSettings {
    const current = this.read();
    return this.write({
      ...current,
      errorLog: [],
    });
  }

  setGeneration(
    taskType: GenerationTaskType,
    next: GenerationSettings,
  ): WorkbenchSettings {
    const parsed = GenerationSettingsSchema.parse(next);
    const current = this.read();
    return this.write({
      ...current,
      generation: {
        ...current.generation,
        [taskType]: parsed,
      },
    });
  }

  applyGenerationToAll(next: GenerationSettings): WorkbenchSettings {
    const parsed = GenerationSettingsSchema.parse(next);
    const current = this.read();
    return this.write({
      ...current,
      generation: {
        genealogy: structuredClone(parsed),
        ruin: structuredClone(parsed),
        biography: structuredClone(parsed),
        butterfly: structuredClone(parsed),
      },
    });
  }

  async getInput(_command: WorkbenchCommand): Promise<RuinGenerationInput> {
    const draft = this.namespace ? this.getRuinDraft(this.namespace()) : this.read().ruinDraft;
    if (!draft) {
      // 引导类问题：不能走 fail-closed，否则会掐掉整楼生成（见 workbenchGuidance.ts）。
      throw new WorkbenchGuidanceError('请先在伊雍历史工作台中填写墟境生成条件');
    }
    return draft;
  }

  getGenealogyDepth(): {
    ancestors: number;
    descendants: number;
    maxPerGeneration: number;
  } {
    return this.read().genealogyDepth;
  }

  getWorldbookEntryExclusions(namespace: WorkbenchNamespace): Set<string> {
    const values = this.read().retrieval.worldbookEntryExclusions[namespaceKey(namespace)] ?? [];
    return new Set(values);
  }

  setWorldbookEntryEnabled(
    namespace: WorkbenchNamespace,
    entryKey: string,
    enabled: boolean,
  ): WorkbenchSettings {
    return this.setWorldbookEntriesEnabled(namespace, [entryKey], enabled);
  }

  setWorldbookEntriesEnabled(
    namespace: WorkbenchNamespace,
    entryKeys: readonly string[],
    enabled: boolean,
  ): WorkbenchSettings {
    const current = this.read();
    const scopeKey = namespaceKey(namespace);
    const excluded = new Set(
      current.retrieval.worldbookEntryExclusions[scopeKey] ?? [],
    );
    entryKeys.forEach(entryKey => {
      if (enabled) excluded.delete(entryKey);
      else excluded.add(entryKey);
    });
    return this.update({
      retrieval: {
        ...current.retrieval,
        worldbookEntryExclusions: {
          ...current.retrieval.worldbookEntryExclusions,
          [scopeKey]: [...excluded].sort(),
        },
      },
    });
  }
}

function migrateLegacyGeneration(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.generation)) return raw;
  const generation = { ...raw.generation };
  for (const task of Object.keys(generation)) {
    const entry = generation[task];
    if (!isRecord(entry)) continue;
    if (entry.mode === 'custom' && isRecord(entry.custom)) {
      // 旧版独立 API：展开 custom 字段（key 原样保留，重新导入脚本才需要重填）。
      generation[task] = entry.custom;
    } else if (entry.mode !== undefined) {
      // 旧版 follow_tavern（或任何带 mode 的旧形态）：转为未配置的空配置。
      generation[task] = {};
    }
  }
  return { ...raw, generation };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
