const SINGLE_JSON_FENCE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/iu;

export interface JsonObjectSelector {
  schema: string;
  discriminators?: Record<string, string>;
}

export function parseSingleJsonObject(
  raw: string,
  selector?: JsonObjectSelector,
): unknown {
  const normalized = raw.trim();
  if (!normalized) {
    throw new Error('API response is empty');
  }

  const fenced = SINGLE_JSON_FENCE.exec(normalized);
  const source = fenced ? fenced[1].trim() : normalized;
  const parsed = parseWholeOrEmbeddedObject(source, selector);

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('API response must be one JSON object');
  }

  return parsed;
}

function parseWholeOrEmbeddedObject(
  source: string,
  selector?: JsonObjectSelector,
): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (wholeError) {
    const scan = scanTopLevelJsonObjects(source);
    const parsedObjects = scan.objects.flatMap(candidate => {
      try {
        const parsed: unknown = JSON.parse(candidate);
        return parsed !== null && !Array.isArray(parsed) && typeof parsed === 'object'
          ? [parsed]
          : [];
      } catch {
        return [];
      }
    });

    if (scan.hasUnclosedObject) {
      throw new Error('API response contains an incomplete JSON object (outer object was not closed)');
    }
    if (parsedObjects.length === 1) return parsedObjects[0];
    if (parsedObjects.length > 1) {
      const matching = selector
        ? parsedObjects.filter(value => matchesSelector(value, selector))
        : [];
      if (matching.length) {
        // Models sometimes emit a draft/example before the corrected final object.
        // Contract identity makes choosing the last matching object deterministic.
        return matching[matching.length - 1];
      }
      throw new Error(
        `API response contains multiple JSON objects (${describeObjectIdentities(parsedObjects)})`,
      );
    }
    throw wholeError;
  }
}

function describeObjectIdentities(values: unknown[]): string {
  const identities = values.slice(0, 6).map((value, index) => {
    const record = value as Record<string, unknown>;
    const fields = ['schema', 'requestId', 'candidateKey']
      .flatMap(key => typeof record[key] === 'string' && record[key]
        ? [`${key}=${truncateIdentity(String(record[key]))}`]
        : []);
    const keys = Object.keys(record).slice(0, 5).join('|');
    return `#${index + 1}{${fields.length ? fields.join(',') : `keys=${keys || 'none'}`}}`;
  });
  const suffix = values.length > identities.length ? `,+${values.length - identities.length}` : '';
  return `count=${values.length}; ${identities.join(' ')}${suffix}`;
}

function truncateIdentity(value: string): string {
  return value.length > 48 ? `${value.slice(0, 45)}...` : value;
}

function matchesSelector(value: unknown, selector: JsonObjectSelector): boolean {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== selector.schema) return false;
  return Object.entries(selector.discriminators ?? {}).every(
    ([key, expected]) => record[key] === expected,
  );
}

function scanTopLevelJsonObjects(source: string): {
  objects: string[];
  hasUnclosedObject: boolean;
} {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (depth === 0) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return {
    objects: results,
    hasUnclosedObject: depth > 0,
  };
}
