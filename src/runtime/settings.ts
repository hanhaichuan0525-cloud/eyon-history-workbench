import { z } from 'zod';

const CustomApiSchema = z.object({
  apiurl: z.string().trim().url(),
  key: z.string().optional().default(''),
  model: z.string().trim().min(1),
  source: z.string().trim().optional().default('openai'),
  maxTokens: z.number().int().min(256).max(32768).default(4096),
  temperature: z.number().min(0).max(2).default(0.8),
});

export const GenerationSettingsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('follow_tavern'),
  }),
  z.object({
    mode: z.literal('custom'),
    custom: CustomApiSchema,
  }),
]);

export type GenerationSettings = z.infer<typeof GenerationSettingsSchema>;

export function parseGenerationSettings(input: unknown): GenerationSettings {
  return GenerationSettingsSchema.parse(input);
}
