import type { GenerationAdapter } from '../adapters/host.ts';
import type { TavernRuntime } from './contracts.ts';
import {
  parseGenerationSettings,
  type GenerationSettings,
} from './settings.ts';

export interface GenerationSettingsProvider {
  get(taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly'): Promise<unknown>;
}

export class TavernGenerationAdapter implements GenerationAdapter {
  private readonly runtime: TavernRuntime;
  private readonly settings: GenerationSettingsProvider;
  private readonly createGenerationId: () => string;

  constructor(
    runtime: TavernRuntime,
    settings: GenerationSettingsProvider,
    createGenerationId: () => string,
  ) {
    this.runtime = runtime;
    this.settings = settings;
    this.createGenerationId = createGenerationId;
  }

  async generate(
    taskType: 'genealogy' | 'ruin' | 'biography' | 'butterfly',
    prompt: string,
  ): Promise<string> {
    const settings = parseGenerationSettings(await this.settings.get(taskType));
    const generationId = this.createGenerationId();
    const config = {
      generation_id: generationId,
      user_input: '',
      should_stream: false,
      should_silence: true,
      ordered_prompts: [
        {
          role: 'system' as const,
          content: prompt,
        },
      ],
    };

    if (settings.mode === 'follow_tavern') {
      return this.runtime.generateRaw(config);
    }

    return this.runtime.generateRaw({
      ...config,
      custom_api: toRuntimeCustomApi(settings),
    });
  }
}

function toRuntimeCustomApi(
  settings: Extract<GenerationSettings, { mode: 'custom' }>,
) {
  const key = settings.custom.key.trim();
  return {
    apiurl: settings.custom.apiurl,
    ...(key ? { key } : {}),
    model: settings.custom.model,
    source: settings.custom.source,
    max_tokens: settings.custom.maxTokens,
    temperature: settings.custom.temperature,
  };
}
