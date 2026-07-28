import { z } from 'zod';
import type { WorkbenchCommand } from '../core/commands.ts';
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

const TaskSettingsSchema = z.object({
  genealogy: GenerationSettingsSchema.default({ mode: 'follow_tavern' }),
  ruin: GenerationSettingsSchema.default({ mode: 'follow_tavern' }),
  biography: GenerationSettingsSchema.default({ mode: 'follow_tavern' }),
  butterfly: GenerationSettingsSchema.default({ mode: 'follow_tavern' }),
});

export const GENERATION_TASK_TYPES = [
  'genealogy',
  'ruin',
  'biography',
  'butterfly',
] as const;

export type GenerationTaskType = typeof GENERATION_TASK_TYPES[number];

export const WorkbenchSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generation: TaskSettingsSchema.default({
    genealogy: { mode: 'follow_tavern' },
    ruin: { mode: 'follow_tavern' },
    biography: { mode: 'follow_tavern' },
    butterfly: { mode: 'follow_tavern' },
  }),
  ruinDraft: RuinGenerationInputSchema.nullable().default(null),
  genealogyDepth: z.object({
    ancestors: z.number().int().min(1).max(8).default(4),
    descendants: z.number().int().min(0).max(6).default(3),
  }).default({
    ancestors: 4,
    descendants: 3,
  }),
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

  constructor(bindings: ScriptVariableBindings) {
    this.bindings = bindings;
  }

  read(): WorkbenchSettings {
    const variables = this.bindings.getScriptVariables();
    return WorkbenchSettingsSchema.parse(variables[SETTINGS_KEY] ?? {});
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

  async get(
    taskType: GenerationTaskType,
  ): Promise<GenerationSettings> {
    return this.read().generation[taskType];
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
    const draft = this.read().ruinDraft;
    if (!draft) {
      throw new Error('请先在伊雍历史工作台中填写墟境生成条件');
    }
    return draft;
  }

  getGenealogyDepth(): { ancestors: number; descendants: number } {
    return this.read().genealogyDepth;
  }
}
