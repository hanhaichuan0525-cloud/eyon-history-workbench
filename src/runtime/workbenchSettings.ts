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

export const WorkbenchSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generation: TaskSettingsSchema.default({
    genealogy: { mode: 'follow_tavern' },
    ruin: { mode: 'follow_tavern' },
    biography: { mode: 'follow_tavern' },
    butterfly: { mode: 'follow_tavern' },
  }),
  ruinDraft: RuinGenerationInputSchema.nullable().default(null),
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
    taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly',
  ): Promise<GenerationSettings> {
    return this.read().generation[taskType];
  }

  async getInput(_command: WorkbenchCommand): Promise<RuinGenerationInput> {
    const draft = this.read().ruinDraft;
    if (!draft) {
      throw new Error('请先在伊雍历史工作台中填写墟境生成条件');
    }
    return draft;
  }
}
