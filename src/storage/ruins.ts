import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import type { RuinCandidates, RuinGenerationInput } from '../schemas/ruin.ts';
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
  input: RuinGenerationInput;
  result: RuinCandidates;
  createdAt: number;
}

export interface RuinCandidateRepository {
  save(record: RuinCandidateRecord): Promise<void>;
  get(key: string): Promise<RuinCandidateRecord | null>;
  list(namespace: WorkbenchNamespace): Promise<RuinCandidateRecord[]>;
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

  async get(key: string): Promise<RuinCandidateRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  async list(namespace: WorkbenchNamespace): Promise<RuinCandidateRecord[]> {
    return [...this.records.values()]
      .filter(record =>
        record.namespace.characterKey === namespace.characterKey
        && record.namespace.chatId === namespace.chatId)
      .map(record => structuredClone(record));
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

  async get(key: string): Promise<RuinCandidateRecord | null> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_STORE, 'readonly');
    const record = await requestResult<
      (RuinCandidateRecord & { namespaceKey: string }) | undefined
    >(transaction.objectStore(RUIN_STORE).get(key));
    await transactionComplete(transaction);
    if (!record) return null;
    const { namespaceKey: _namespaceKey, ...result } = record;
    return result;
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
    return records.map(({ namespaceKey: _namespaceKey, ...record }) => record);
  }
}
