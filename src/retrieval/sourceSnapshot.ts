import {
  SOURCE_SNAPSHOT_SCHEMA,
  type RuntimeWorldbookSource,
  type SourceSnapshot,
  type WorldbookRetrievalMetadata,
} from './contracts.ts';

export function worldbookLogicalId(worldbookName: string, uid: number): string {
  return `worldbook:${encodeURIComponent(worldbookName.trim())}:${uid}`;
}

export async function createSourceSnapshot<TMetadata>(input: {
  logicalId: string;
  sourceType: SourceSnapshot<TMetadata>['sourceType'];
  title: string;
  content: string;
  sourceOrder?: number;
  metadata: TMetadata;
}): Promise<SourceSnapshot<TMetadata>> {
  const versionHash = await stableSha256(input);
  return {
    schema: SOURCE_SNAPSHOT_SCHEMA,
    ...input,
    snapshotId: `${input.logicalId}@sha256:${versionHash}`,
    versionHash,
  };
}

export async function createWorldbookSourceSnapshot(
  source: RuntimeWorldbookSource,
): Promise<SourceSnapshot<WorldbookRetrievalMetadata>> {
  return createSourceSnapshot({
    logicalId: source.worldbook.logicalId,
    sourceType: 'worldbook',
    title: source.title,
    content: source.content,
    metadata: source.worldbook,
  });
}

export async function stableSha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

/** JSON 语义不变、对象键顺序无关的确定性序列化。 */
export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(item => item === undefined ? null : canonicalize(item));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .flatMap(key => {
          const item = record[key];
          return item === undefined
            || typeof item === 'function'
            || typeof item === 'symbol'
            ? []
            : [[key, canonicalize(item)]];
        }),
    );
  }
  return null;
}
