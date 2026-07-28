import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import type {
  ButterflyRequest,
  ButterflyResult,
} from '../schemas/butterfly.ts';
import {
  BUTTERFLY_STORE,
  PENDING_SETTLEMENT_STORE,
  historyDatabase,
  requestResult,
  transactionComplete,
} from './database.ts';

export type ButterflyCommitStatus =
  | 'validated'
  | 'message_committed'
  | 'mirror_pending'
  | 'committed';

export interface PendingSettlement {
  key: string;
  namespace: WorkbenchNamespace;
  runId: string;
  request: ButterflyRequest;
  assistantSwipeId: number | null;
  sourceHash: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  failure?: { code: string; message: string };
}

export interface ButterflyRecord {
  key: string;
  namespace: WorkbenchNamespace;
  runId: string;
  requestId: string;
  request: ButterflyRequest;
  result: ButterflyResult;
  sourceHash: string;
  panel: string;
  archiveEntry: string;
  assistantMessageId: number;
  status: ButterflyCommitStatus;
  revision: number;
  worldbookName?: string;
  worldbookUid?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ButterflyRepository {
  savePending(record: PendingSettlement): Promise<void>;
  updatePending(record: PendingSettlement): Promise<void>;
  getPending(key: string): Promise<PendingSettlement | null>;
  listPending(namespace: WorkbenchNamespace): Promise<PendingSettlement[]>;
  deletePending(key: string): Promise<void>;
  saveRecord(record: ButterflyRecord): Promise<void>;
  updateRecord(record: ButterflyRecord): Promise<void>;
  getRecord(key: string): Promise<ButterflyRecord | null>;
  list(namespace: WorkbenchNamespace): Promise<ButterflyRecord[]>;
}

export function pendingSettlementKey(
  namespace: WorkbenchNamespace,
  runId: string,
): string {
  return recordKey(namespace, 'pending-butterfly', runId);
}

export function butterflyRecordKey(
  namespace: WorkbenchNamespace,
  runId: string,
): string {
  return recordKey(namespace, 'butterfly', runId);
}

export class MemoryButterflyRepository implements ButterflyRepository {
  private readonly pending = new Map<string, PendingSettlement>();
  private readonly records = new Map<string, ButterflyRecord>();

  async savePending(record: PendingSettlement): Promise<void> {
    if (this.pending.has(record.key)) throw new Error('Pending settlement already exists');
    this.pending.set(record.key, structuredClone(record));
  }
  async updatePending(record: PendingSettlement): Promise<void> {
    if (!this.pending.has(record.key)) throw new Error('Pending settlement does not exist');
    this.pending.set(record.key, structuredClone(record));
  }
  async getPending(key: string) {
    const value = this.pending.get(key);
    return value ? structuredClone(value) : null;
  }
  async deletePending(key: string) {
    this.pending.delete(key);
  }
  async listPending(namespace: WorkbenchNamespace) {
    return [...this.pending.values()]
      .filter(record => namespaceKey(record.namespace) === namespaceKey(namespace))
      .map(record => structuredClone(record));
  }
  async saveRecord(record: ButterflyRecord): Promise<void> {
    if (this.records.has(record.key)) throw new Error('Butterfly record already exists');
    this.records.set(record.key, structuredClone(record));
  }
  async updateRecord(record: ButterflyRecord): Promise<void> {
    if (!this.records.has(record.key)) throw new Error('Butterfly record does not exist');
    this.records.set(record.key, structuredClone(record));
  }
  async getRecord(key: string) {
    const value = this.records.get(key);
    return value ? structuredClone(value) : null;
  }
  async list(namespace: WorkbenchNamespace) {
    return [...this.records.values()]
      .filter(record => namespaceKey(record.namespace) === namespaceKey(namespace))
      .map(record => structuredClone(record));
  }
}

export class IndexedDbButterflyRepository implements ButterflyRepository {
  savePending(record: PendingSettlement) {
    return addRecord(PENDING_SETTLEMENT_STORE, record);
  }
  updatePending(record: PendingSettlement) {
    return putExisting(PENDING_SETTLEMENT_STORE, record);
  }
  getPending(key: string) {
    return getRecord<PendingSettlement>(PENDING_SETTLEMENT_STORE, key);
  }
  listPending(namespace: WorkbenchNamespace) {
    return listRecords<PendingSettlement>(PENDING_SETTLEMENT_STORE, namespace);
  }
  deletePending(key: string) {
    return deleteRecord(PENDING_SETTLEMENT_STORE, key);
  }
  saveRecord(record: ButterflyRecord) {
    return addRecord(BUTTERFLY_STORE, record);
  }
  updateRecord(record: ButterflyRecord) {
    return putExisting(BUTTERFLY_STORE, record);
  }
  getRecord(key: string) {
    return getRecord<ButterflyRecord>(BUTTERFLY_STORE, key);
  }
  list(namespace: WorkbenchNamespace) {
    return listRecords<ButterflyRecord>(BUTTERFLY_STORE, namespace);
  }
}

async function addRecord(
  storeName: string,
  record: PendingSettlement | ButterflyRecord,
): Promise<void> {
  const database = await historyDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).add({
    ...record,
    namespaceKey: namespaceKey(record.namespace),
  });
  await transactionComplete(transaction);
}

async function putExisting(
  storeName: string,
  record: PendingSettlement | ButterflyRecord,
): Promise<void> {
  const database = await historyDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  const store = transaction.objectStore(storeName);
  const existing = await requestResult(store.get(record.key));
  if (!existing) {
    transaction.abort();
    throw new Error('Butterfly transaction record does not exist');
  }
  store.put({ ...record, namespaceKey: namespaceKey(record.namespace) });
  await transactionComplete(transaction);
}

async function getRecord<T>(storeName: string, key: string): Promise<T | null> {
  const database = await historyDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const value = await requestResult<(T & { namespaceKey: string }) | undefined>(
    transaction.objectStore(storeName).get(key),
  );
  await transactionComplete(transaction);
  if (!value) return null;
  const { namespaceKey: _namespaceKey, ...record } = value;
  return record as T;
}

async function deleteRecord(storeName: string, key: string): Promise<void> {
  const database = await historyDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(key);
  await transactionComplete(transaction);
}

async function listRecords<T>(
  storeName: string,
  namespace: WorkbenchNamespace,
): Promise<T[]> {
  const database = await historyDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  const values = await requestResult<Array<T & { namespaceKey: string }>>(
    transaction.objectStore(storeName).index('namespace').getAll(namespaceKey(namespace)),
  );
  await transactionComplete(transaction);
  return values.map(value => {
    const { namespaceKey: _namespaceKey, ...record } = value;
    return record as T;
  });
}
