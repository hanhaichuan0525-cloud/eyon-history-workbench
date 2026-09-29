import { fingerprintText } from '../runtime/transactionIdentity.ts';

export const P4_ASSESSMENT_POLICY_VERSION = 'p4-derived-cache.v1' as const;

export interface P4DerivedCacheScope {
  namespace: string;
  branchId: string;
  canonRevision: number;
  queryScopeHash: string;
  module: string;
  subjectScope: readonly string[];
  timeScope: readonly string[];
  locationScope: readonly string[];
  anchorSetHash: string;
  assessmentPolicyVersion?: string;
}

export interface P4DerivedCacheDiagnostic {
  event: 'hit' | 'miss' | 'stored' | 'corrupt' | 'write-failed' | 'evicted' | 'cleared';
  key: string;
  namespace: string;
  branchId: string;
  canonRevision: number;
  module: string;
  anchorSetHash: string;
  message?: string;
  createdAt: number;
}

interface CacheEntry {
  scope: Required<P4DerivedCacheScope>;
  value: unknown;
  touchedAt: number;
}

const DEFAULT_CAPACITY = 96;
const DIAGNOSTIC_LIMIT = 128;
const entries = new Map<string, CacheEntry>();
const diagnostics: P4DerivedCacheDiagnostic[] = [];
let capacity = DEFAULT_CAPACITY;

function normalized(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

function completeScope(scope: P4DerivedCacheScope): Required<P4DerivedCacheScope> {
  return {
    ...scope,
    namespace: scope.namespace.trim(),
    branchId: scope.branchId.trim(),
    queryScopeHash: scope.queryScopeHash.trim(),
    module: scope.module.trim(),
    subjectScope: normalized(scope.subjectScope),
    timeScope: normalized(scope.timeScope),
    locationScope: normalized(scope.locationScope),
    anchorSetHash: scope.anchorSetHash.trim(),
    assessmentPolicyVersion: scope.assessmentPolicyVersion ?? P4_ASSESSMENT_POLICY_VERSION,
  };
}

export function p4DerivedCacheKey(scope: P4DerivedCacheScope): string {
  return fingerprintText(JSON.stringify(completeScope(scope)));
}

function record(
  event: P4DerivedCacheDiagnostic['event'],
  key: string,
  scope: Required<P4DerivedCacheScope>,
  message?: string,
): void {
  diagnostics.push({
    event,
    key,
    namespace: scope.namespace,
    branchId: scope.branchId,
    canonRevision: scope.canonRevision,
    module: scope.module,
    anchorSetHash: scope.anchorSetHash,
    ...(message ? { message: message.slice(0, 180) } : {}),
    createdAt: Date.now(),
  });
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.splice(0, diagnostics.length - DIAGNOSTIC_LIMIT);
}

/**
 * Read-only optimization for P4-derived views. A missing/corrupt value is always a cold miss.
 * The caller remains the sole source of truth and supplies the shape validator.
 */
export function readP4DerivedCache<T>(
  inputScope: P4DerivedCacheScope,
  isValid: (value: unknown) => value is T,
): T | undefined {
  const scope = completeScope(inputScope);
  const key = p4DerivedCacheKey(scope);
  const entry = entries.get(key);
  if (!entry) {
    record('miss', key, scope);
    return undefined;
  }
  try {
    if (!isValid(entry.value)) {
      entries.delete(key);
      record('corrupt', key, scope, 'cached value failed its derived-view shape check');
      return undefined;
    }
    const clone = structuredClone(entry.value) as T;
    entries.delete(key);
    entries.set(key, { ...entry, touchedAt: Date.now() });
    record('hit', key, scope);
    return clone;
  } catch (error) {
    entries.delete(key);
    record('corrupt', key, scope, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export function writeP4DerivedCache<T>(scopeInput: P4DerivedCacheScope, value: T): void {
  const scope = completeScope(scopeInput);
  const key = p4DerivedCacheKey(scope);
  try {
    if (capacity <= 0) {
      record('write-failed', key, scope, 'cache capacity is zero');
      return;
    }
    const stored = structuredClone(value);
    entries.delete(key);
    entries.set(key, { scope, value: stored, touchedAt: Date.now() });
    record('stored', key, scope);
    while (entries.size > capacity) {
      const oldest = entries.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = entries.get(oldest);
      entries.delete(oldest);
      if (evicted) record('evicted', oldest, evicted.scope, `capacity=${capacity}`);
    }
  } catch (error) {
    record('write-failed', key, scope, error instanceof Error ? error.message : String(error));
  }
}

export function clearP4DerivedCache(reason = 'manual'): void {
  const removed = [...entries.entries()];
  entries.clear();
  if (removed.length === 0) return;
  const [key, entry] = removed[removed.length - 1];
  record('cleared', key, entry.scope, `${reason}; removed=${removed.length}`);
}

export function inspectP4DerivedCache(): {
  policyVersion: string;
  size: number;
  capacity: number;
  entries: Array<{ key: string; scope: Required<P4DerivedCacheScope>; touchedAt: number }>;
  diagnostics: P4DerivedCacheDiagnostic[];
} {
  return {
    policyVersion: P4_ASSESSMENT_POLICY_VERSION,
    size: entries.size,
    capacity,
    entries: [...entries.entries()].map(([key, entry]) => ({
      key,
      scope: structuredClone(entry.scope),
      touchedAt: entry.touchedAt,
    })),
    diagnostics: structuredClone(diagnostics),
  };
}

/** Test-only hooks. They are not exposed through the workbench facade. */
export function resetP4DerivedCacheForTests(nextCapacity = DEFAULT_CAPACITY): void {
  entries.clear();
  diagnostics.splice(0, diagnostics.length);
  capacity = nextCapacity;
}

export function corruptP4DerivedCacheForTests(scope: P4DerivedCacheScope): void {
  const completed = completeScope(scope);
  const key = p4DerivedCacheKey(completed);
  entries.set(key, { scope: completed, value: { corrupt: true }, touchedAt: Date.now() });
}
