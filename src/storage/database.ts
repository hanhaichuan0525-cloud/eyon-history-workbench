const DATABASE_NAME = 'eyon-history-system';
const DATABASE_VERSION = 4;

export const BIOGRAPHY_STORE = 'biographies';
export const RUIN_STORE = 'ruinCandidates';
export const GENEALOGY_STORE = 'genealogies';
export const BUTTERFLY_STORE = 'butterflyRecords';
export const PENDING_SETTLEMENT_STORE = 'pendingSettlements';

let databasePromise: Promise<IDBDatabase> | null = null;

export function historyDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BIOGRAPHY_STORE)) {
        const store = database.createObjectStore(BIOGRAPHY_STORE, { keyPath: 'key' });
        store.createIndex('namespace', 'namespaceKey', { unique: false });
        store.createIndex('requestId', 'requestId', { unique: true });
      }
      if (!database.objectStoreNames.contains(RUIN_STORE)) {
        const store = database.createObjectStore(RUIN_STORE, { keyPath: 'key' });
        store.createIndex('namespace', 'namespaceKey', { unique: false });
        store.createIndex('requestId', 'requestId', { unique: true });
      }
      if (!database.objectStoreNames.contains(GENEALOGY_STORE)) {
        const store = database.createObjectStore(GENEALOGY_STORE, { keyPath: 'key' });
        store.createIndex('namespace', 'namespaceKey', { unique: false });
        store.createIndex('requestId', 'requestId', { unique: true });
      }
      for (const storeName of [BUTTERFLY_STORE, PENDING_SETTLEMENT_STORE]) {
        if (!database.objectStoreNames.contains(storeName)) {
          const store = database.createObjectStore(storeName, { keyPath: 'key' });
          store.createIndex('namespace', 'namespaceKey', { unique: false });
          store.createIndex('runId', 'runId', { unique: false });
          store.createIndex('requestId', 'request.requestId', { unique: true });
        }
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Unable to open history database'));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error('History database upgrade is blocked by an older workbench tab'));
    };
  });

  return databasePromise;
}

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
  });
}
