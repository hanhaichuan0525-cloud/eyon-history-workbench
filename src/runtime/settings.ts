import { z } from 'zod';

z.config({ jitless: true });

/**
 * 独立 API 配置（v0.10 起为唯一生成路由，不再有 follow_tavern 模式）。
 * apiurl/key/model 允许为空：未配置的模块在生成时由运行时给出明确中文报错
 * （“独立 API 密钥为空”“接口地址为空”），而不是在设置解析阶段卡死。
 */
export const CustomApiSchema = z.object({
  apiurl: z.string().trim().optional().default(''),
  key: z.string().optional().default(''),
  model: z.string().trim().optional().default(''),
  source: z.string().trim().optional().default('openai'),
  maxTokens: z.number().int().min(256).max(60000).default(60000),
  temperature: z.number().min(0).max(2).default(0.8),
});

export type CustomApiConfig = z.infer<typeof CustomApiSchema>;

export const GenerationSettingsSchema = CustomApiSchema;

export type GenerationSettings = CustomApiConfig;

export function parseGenerationSettings(input: unknown): GenerationSettings {
  return GenerationSettingsSchema.parse(input);
}
