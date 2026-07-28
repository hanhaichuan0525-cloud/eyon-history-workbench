const SINGLE_JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu;

export function parseSingleJsonObject(raw: string): unknown {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error('API response is empty');
  }

  const fenced = SINGLE_JSON_FENCE.exec(normalized);
  const source = fenced ? fenced[1].trim() : normalized;
  const parsed: unknown = JSON.parse(source);

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('API response must be one JSON object');
  }

  return parsed;
}
