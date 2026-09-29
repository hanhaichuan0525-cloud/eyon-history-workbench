import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import type {
  GenealogyGenerationInput,
  GenealogyResult,
} from '../schemas/genealogy.ts';
import type { ArtifactCanonBinding } from '../retrieval/contracts.ts';
import type { GenealogyLocalEvidence, GenealogyLocalView } from '../core/genealogyLocalView.ts';
import {
  GENEALOGY_STORE,
  historyDatabase,
  requestResult,
  transactionComplete,
} from './database.ts';

export interface GenealogyRecord {
  key: string;
  namespace: WorkbenchNamespace;
  requestId: string;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  sourceHash: string;
  input: GenealogyGenerationInput;
  result: GenealogyResult;
  /** P2-A：每个 node/edge 的不可变 Canon 依赖；旧记录缺省即 unbound。 */
  canonBindings?: ArtifactCanonBinding[];
  /** P4-B immutable script-owned identity and temporal evidence receipt. */
  localEvidence?: GenealogyLocalEvidence;
  validationWarnings?: string[];
  /** Read-time UI envelope only; never persisted by the generation workflow. */
  localView?: GenealogyLocalView;
  createdAt: number;
}

export interface GenealogyRepository {
  save(record: GenealogyRecord): Promise<void>;
  get(key: string): Promise<GenealogyRecord | null>;
  list(namespace: WorkbenchNamespace): Promise<GenealogyRecord[]>;
  clear(namespace: WorkbenchNamespace): Promise<number>;
}

export function genealogyRecordKey(
  namespace: WorkbenchNamespace,
  requestId: string,
): string {
  return recordKey(namespace, 'genealogy', requestId);
}

export class MemoryGenealogyRepository implements GenealogyRepository {
  private readonly records = new Map<string, GenealogyRecord>();

  async save(record: GenealogyRecord): Promise<void> {
    if (this.records.has(record.key)) throw new Error('Genealogy record already exists');
    this.records.set(record.key, structuredClone(record));
  }

  async get(key: string): Promise<GenealogyRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  async list(namespace: WorkbenchNamespace): Promise<GenealogyRecord[]> {
    return [...this.records.values()]
      .filter(record =>
        record.namespace.characterKey === namespace.characterKey
        && record.namespace.chatId === namespace.chatId)
      .map(record => structuredClone(record));
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

export class IndexedDbGenealogyRepository implements GenealogyRepository {
  async save(record: GenealogyRecord): Promise<void> {
    const database = await historyDatabase();
    const transaction = database.transaction(GENEALOGY_STORE, 'readwrite');
    const store = transaction.objectStore(GENEALOGY_STORE);
    const existing = await requestResult(store.get(record.key));
    if (existing) {
      transaction.abort();
      throw new Error('Genealogy record already exists');
    }
    store.add({ ...record, namespaceKey: namespaceKey(record.namespace) });
    await transactionComplete(transaction);
  }

  async get(key: string): Promise<GenealogyRecord | null> {
    const database = await historyDatabase();
    const transaction = database.transaction(GENEALOGY_STORE, 'readonly');
    const record = await requestResult<
      (GenealogyRecord & { namespaceKey: string }) | undefined
    >(transaction.objectStore(GENEALOGY_STORE).get(key));
    await transactionComplete(transaction);
    if (!record) return null;
    const { namespaceKey: _namespaceKey, ...result } = record;
    return result;
  }

  async list(namespace: WorkbenchNamespace): Promise<GenealogyRecord[]> {
    const database = await historyDatabase();
    const transaction = database.transaction(GENEALOGY_STORE, 'readonly');
    const records = await requestResult<
      Array<GenealogyRecord & { namespaceKey: string }>
    >(
      transaction
        .objectStore(GENEALOGY_STORE)
        .index('namespace')
        .getAll(namespaceKey(namespace)),
    );
    await transactionComplete(transaction);
    return records.map(({ namespaceKey: _namespaceKey, ...record }) => record);
  }

  async clear(namespace: WorkbenchNamespace): Promise<number> {
    const database = await historyDatabase();
    const transaction = database.transaction(GENEALOGY_STORE, 'readwrite');
    const store = transaction.objectStore(GENEALOGY_STORE);
    const keys = await requestResult(
      store.index('namespace').getAllKeys(namespaceKey(namespace)),
    );
    keys.forEach(key => store.delete(key));
    await transactionComplete(transaction);
    return keys.length;
  }
}
