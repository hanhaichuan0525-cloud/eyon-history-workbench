import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import type {
  BiographyRecord,
  BiographyRepository,
} from './biographies.ts';

const DATABASE_NAME = 'eyon-history-system';
const DATABASE_VERSION = 1;
const STORE_NAME = 'biographies';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbBiographyRepository implements BiographyRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('namespace', 'namespaceKey', { unique: false });
          store.createIndex('requestId', 'requestId', { unique: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Unable to open IndexedDB'));
    });

    return this.databasePromise;
  }

  async saveValidated(record: BiographyRecord): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
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
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
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
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const record = await requestResult<(BiographyRecord & { namespaceKey: string }) | undefined>(
      transaction.objectStore(STORE_NAME).get(key),
    );
    await transactionComplete(transaction);
    if (!record) {
      return null;
    }
    const { namespaceKey: _namespaceKey, ...biography } = record;
    return biography;
  }

  async list(namespace: WorkbenchNamespace): Promise<BiographyRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const index = transaction.objectStore(STORE_NAME).index('namespace');
    const records = await requestResult<Array<BiographyRecord & { namespaceKey: string }>>(
      index.getAll(namespaceKey(namespace)),
    );
    await transactionComplete(transaction);
    return records.map(({ namespaceKey: _namespaceKey, ...record }) => record);
  }
}
