import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import type { RuinCandidates, RuinGenerationInput } from '../schemas/ruin.ts';
import type {
  ArtifactCanonBinding,
  TaskCitationRegistry,
} from '../retrieval/contracts.ts';
import type { RuinContextBundle } from '../core/context.ts';
import {
  historyDatabase,
  requestResult,
  RUIN_STORE,
  transactionComplete,
} from './database.ts';

export interface RuinCandidateRecord {
  key: string;
  namespace: WorkbenchNamespace;
  requestId: string;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  sourceHash: string;
  citationRegistry?: TaskCitationRegistry;
  /**
   * 本次探索唯一语义编译产出的冻结上下文。所有候选扩写与重试只能复用它，
   * 不得依据模型生成的标题、演员或节点重新打开检索。
   */
  frozenContext?: RuinContextBundle;
  input: RuinGenerationInput;
  result: RuinCandidates;
  expandedCandidateIds: string[];
  candidateStates?: Record<string, RuinCandidateGenerationState>;
  /** P2-A：候选锚、history 与 node 的不可变 Canon 依赖；旧记录缺省即 unbound。 */
  canonBindings?: ArtifactCanonBinding[];
  createdAt: number;
}

export type RuinCandidateGenerationStatus =
  | 'pending'
  | 'generating'
  | 'ready'
  | 'failed';

export interface RuinCandidateGenerationState {
  status: RuinCandidateGenerationStatus;
  attempt: number;
  generationEpoch: number;
  updatedAt: number;
  error?: {
    phase: 'transport' | 'parse' | 'validation' | 'unknown';
    message: string;
  };
}

export function ruinCandidateState(
  record: RuinCandidateRecord,
  candidateId: string,
): RuinCandidateGenerationState {
  const stored = record.candidateStates?.[candidateId];
  if (stored) return stored;
  return {
    status: (record.expandedCandidateIds ?? []).includes(candidateId)
      ? 'ready'
      : 'pending',
    attempt: 0,
    generationEpoch: 0,
    updatedAt: record.createdAt,
  };
}

function normalizeCandidateStates(
  record: RuinCandidateRecord,
): RuinCandidateRecord {
  const candidateStates = Object.fromEntries(
    (record.result?.candidates ?? []).map(candidate => [
      candidate.id,
      ruinCandidateState(record, candidate.id),
    ]),
  );
  return { ...record, candidateStates };
}

export interface RuinCandidateRepository {
  save(record: RuinCandidateRecord): Promise<void>;
  replace(record: RuinCandidateRecord): Promise<void>;
  replaceNamespace(record: RuinCandidateRecord): Promise<number>;
  get(key: string): Promise<RuinCandidateRecord | null>;
  list(namespace: WorkbenchNamespace): Promise<RuinCandidateRecord[]>;
  clear(namespace: WorkbenchNamespace): Promise<number>;
}

export function ruinCandidateRecordKey(
  namespace: WorkbenchNamespace,
  requestId: string,
): string {
  return recordKey(namespace, 'ruinCandidates', requestId);
}

export class MemoryRuinCandidateRepository implements RuinCandidateRepository {
  private readonly records = new Map<string, RuinCandidateRecord>();

  async save(record: RuinCandidateRecord): Promise<void> {
    if (this.records.has(record.key)) {
      throw new Error('Ruin candidate record already exists');
    }
    this.records.set(record.key, structuredClone(record));
  }

  async replace(record: RuinCandidateRecord): Promise<void> {
    if (!this.records.has(record.key)) {
      throw new Error('Ruin candidate record does not exist');
    }
    this.records.set(record.key, structuredClone(record));
  }

  async replaceNamespace(record: RuinCandidateRecord): Promise<number> {
    const keys = [...this.records.entries()]
      .filter(([, existing]) =>
        existing.namespace.characterKey === record.namespace.characterKey
        && existing.namespace.chatId === record.namespace.chatId)
      .map(([key]) => key);
    keys.forEach(key => this.records.delete(key));
    this.records.set(record.key, structuredClone(record));
    return keys.length;
  }

  async get(key: string): Promise<RuinCandidateRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(normalizeCandidateStates(record)) : null;
  }

  async list(namespace: WorkbenchNamespace): Promise<RuinCandidateRecord[]> {
    return [...this.records.values()]
      .filter(record =>
        record.namespace.characterKey === namespace.characterKey
        && record.namespace.chatId === namespace.chatId)
      .map(record => structuredClone(normalizeCandidateStates(record)));
  }

  async clear(namespace: WorkbenchNamespace): Promise<number> {
    const keys = [...this.records.entries()]
      .filter(([, record]) =>
        record.namespace.characterKey === namespace.characterKey
        && record.namespace.chatId === namespace.chatId)
      .map(([key]) => key);
    keys.forEach(key => this.records.delete(key));
    return keys.length;
  }
}

export class IndexedDbRuinCandidateRepository implements RuinCandidateRepository {
  async save(record: RuinCandidateRecord): Promise<void> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_STORE);
    const existing = await requestResult(store.get(record.key));
    if (existing) {
      transaction.abort();
      throw new Error('Ruin candidate record already exists');
    }
    store.add({
      ...record,
      namespaceKey: namespaceKey(record.namespace),
    });
    await transactionComplete(transaction);
  }

  async replace(record: RuinCandidateRecord): Promise<void> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_STORE);
    const existing = await requestResult(store.get(record.key));
    if (!existing) {
      transaction.abort();
      throw new Error('Ruin candidate record does not exist');
    }
    store.put({
      ...record,
      namespaceKey: namespaceKey(record.namespace),
    });
    await transactionComplete(transaction);
  }

  async replaceNamespace(record: RuinCandidateRecord): Promise<number> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_STORE);
    const keys = await requestResult(
      store.index('namespace').getAllKeys(namespaceKey(record.namespace)),
    );
    keys.forEach(key => store.delete(key));
    store.put({
      ...record,
      namespaceKey: namespaceKey(record.namespace),
    });
    await transactionComplete(transaction);
    return keys.length;
  }

  async get(key: string): Promise<RuinCandidateRecord | null> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readonly');
    const record = await requestResult<
      (RuinCandidateRecord & { namespaceKey: string }) | undefined
    >(transaction.objectStore(RUIN_STORE).get(key));
    await transactionComplete(transaction);
    if (!record) return null;
    const { namespaceKey: _namespaceKey, ...result } = record;
    return normalizeCandidateStates({
      ...result,
      expandedCandidateIds: result.expandedCandidateIds ?? [],
    });
  }

  async list(namespace: WorkbenchNamespace): Promise<RuinCandidateRecord[]> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readonly');
    const records = await requestResult<
      Array<RuinCandidateRecord & { namespaceKey: string }>
    >(
      transaction
        .objectStore(RUIN_STORE)
        .index('namespace')
        .getAll(namespaceKey(namespace)),
    );
    await transactionComplete(transaction);
    return records.map(({ namespaceKey: _namespaceKey, ...record }) =>
      normalizeCandidateStates({
        ...record,
        expandedCandidateIds: record.expandedCandidateIds ?? [],
      }));
  }

  async clear(namespace: WorkbenchNamespace): Promise<number> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_STORE);
    const keys = await requestResult(
      store.index('namespace').getAllKeys(namespaceKey(namespace)),
    );
    keys.forEach(key => store.delete(key));
    await transactionComplete(transaction);
    return keys.length;
  }
}
