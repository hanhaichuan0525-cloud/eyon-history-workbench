import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import type {
  BiographyRecord,
  BiographyRepository,
} from './biographies.ts';
import {
  BIOGRAPHY_STORE,
  historyDatabase,
  requestResult,
  transactionComplete,
} from './database.ts';

export class IndexedDbBiographyRepository implements BiographyRepository {
  async saveValidated(record: BiographyRecord): Promise<void> {
    const database = await historyDatabase();
    const transaction = database.transaction(BIOGRAPHY_STORE, 'readwrite');
    const store = transaction.objectStore(BIOGRAPHY_STORE);
    const existing = await requestResult(store.get(record.key));
    if (existing) {
      transaction.abort();
      throw new Error('Biography record already exists');
    }
    store.add({
      ...record,
      namespaceKey: namespaceKey(record.namespace),
    });
    await transactionComplete(transaction);
  }

  async markCommitted(key: string, assistantMessageId: number): Promise<void> {
    const database = await historyDatabase();
    const transaction = database.transaction(BIOGRAPHY_STORE, 'readwrite');
    const store = transaction.objectStore(BIOGRAPHY_STORE);
    const record = await requestResult<(BiographyRecord & { namespaceKey: string }) | undefined>(
      store.get(key),
    );
    if (!record) {
      transaction.abort();
      throw new Error('Biography record does not exist');
    }
    store.put({
      ...record,
      status: 'committed',
      assistantMessageId,
      revision: record.revision + 1,
      updatedAt: Date.now(),
    });
    await transactionComplete(transaction);
  }

  async get(key: string): Promise<BiographyRecord | null> {
    const database = await historyDatabase();
    const transaction = database.transaction(BIOGRAPHY_STORE, 'readonly');
    const record = await requestResult<(BiographyRecord & { namespaceKey: string }) | undefined>(
      transaction.objectStore(BIOGRAPHY_STORE).get(key),
    );
    await transactionComplete(transaction);
    if (!record) {
      return null;
    }
    const { namespaceKey: _namespaceKey, ...biography } = record;
    return biography;
  }

  async list(namespace: WorkbenchNamespace): Promise<BiographyRecord[]> {
    const database = await historyDatabase();
    const transaction = database.transaction(BIOGRAPHY_STORE, 'readonly');
    const index = transaction.objectStore(BIOGRAPHY_STORE).index('namespace');
    const records = await requestResult<Array<BiographyRecord & { namespaceKey: string }>>(
      index.getAll(namespaceKey(namespace)),
    );
    await transactionComplete(transaction);
    return records.map(({ namespaceKey: _namespaceKey, ...record }) => record);
  }
}
