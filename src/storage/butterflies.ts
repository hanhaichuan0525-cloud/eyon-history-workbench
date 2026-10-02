import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import type {
  ButterflyRequest,
  ButterflyResult,
} from '../schemas/butterfly.ts';
import type { ActiveEvidenceView } from '../prompts/activeEvidence.ts';
import type { EntityLinkCandidate } from '../retrieval/entityLinking.ts';
import type {
  ArtifactCanonBinding,
  ArtifactCanonBoundView,
  CanonResolutionReceipt,
  InterventionDeltaStatus,
} from '../retrieval/contracts.ts';
import {
  BUTTERFLY_STORE,
  CANON_MEMORY_TOMBSTONE_STORE,
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
  /** 冻结时的 Active 精简证据视图（无正文），结算时注入 prompt 与 validator。可选：旧记录兼容。 */
  activeEvidence?: ActiveEvidenceView;
  /** P2-A：冻结任务实际消费的视图身份；不复制 passage 或 prompt 正文。 */
  canonBindingView?: ArtifactCanonBoundView;
  /** P2-A：只保留冻结视图 receipt 中已应用的 delta IDs，供 operationRefs 追溯。 */
  canonBindingAppliedDeltaIds?: string[];
  /**
   * internal.82（F-01）：冻结时从检索 Bundle 抽取的「稳定实体名 → entityId」
   * 映射索引，供结算提交前把模型 carrier 归并到 catalog 实体空间。
   * 可选：旧 pending/旧记录缺省即跳过归并（行为 = entity:generated 兜底）。
   */
  linkingIndex?: EntityLinkCandidate[];
  triggerSwipeId?: number | null;
  assistantSwipeId: number | null;
  sourceHash: string;
  /** 内部事务身份：完整可见行动楼摘要；不增加模型输出字段。 */
  triggerEvidenceHash?: string;
  /** 引用来源身份规则版本；旧 pending 缺省时按兼容体检决定是否重新冻结。 */
  sourceIdentityVersion?: number;
  /** 最终 sourceIndex 的规范化集合摘要，用于拒绝复用来源合同已经漂移的 pending。 */
  citationSourceSetHash?: string;
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
  triggerEvidenceHash?: string;
  panel: string;
  archiveEntry: string;
  assistantMessageId: number;
  status: ButterflyCommitStatus;
  revision: number;
  /** P0-B：绑定当前聊天正史分支；旧记录兼容时可缺省。 */
  branchId?: string;
  canonRevision?: number;
  actionRef?: string;
  deltaRef?: string;
  canonReceipt?: CanonResolutionReceipt;
  canonStatus?: InterventionDeltaStatus;
  /** P2-A：action/operation/panel 的不可变 Canon 依赖；旧记录缺省即 unbound。 */
  canonBindings?: ArtifactCanonBinding[];
  /** 旧版世界书镜像坐标（internal.87 §6 步 B 起不再写入；仅为读取既有记录保留）。 */
  worldbookName?: string;
  worldbookUid?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * G-09：可见蝴蝶档案删除后，为仍 active 的 Canon 干涉保留的有界记忆残片。
 * 它不是档案备份：不保存面板、历史演变全文、模型结果或正文副本。
 */
export interface CanonMemoryTombstone {
  key: string;
  namespace: WorkbenchNamespace;
  runId: string;
  branchId: string;
  canonRevision: number;
  actionRef: string;
  deltaRef: string;
  title: string;
  spacetime: string;
  actionRecord: string;
  softKeywords: string[];
  createdAt: number;
  deletedAt: number;
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
  listMemoryTombstones(namespace: WorkbenchNamespace): Promise<CanonMemoryTombstone[]>;
  /**
   * 幂等删除同轮可见档案与待结算快照；若给出 memoryTombstone，则在同一事务中
   * 保存紧凑因果摘要。返回此前是否存在可见档案。
   */
  deleteRun(
    namespace: WorkbenchNamespace,
    runId: string,
    memoryTombstone?: CanonMemoryTombstone,
  ): Promise<boolean>;
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

export function canonMemoryTombstoneKey(
  namespace: WorkbenchNamespace,
  runId: string,
): string {
  return recordKey(namespace, 'canon-memory-tombstone', runId);
}

export class MemoryButterflyRepository implements ButterflyRepository {
  private readonly pending = new Map<string, PendingSettlement>();
  private readonly records = new Map<string, ButterflyRecord>();
  private readonly memoryTombstones = new Map<string, CanonMemoryTombstone>();

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
  async listMemoryTombstones(namespace: WorkbenchNamespace) {
    return [...this.memoryTombstones.values()]
      .filter(record => namespaceKey(record.namespace) === namespaceKey(namespace))
      .map(record => structuredClone(record));
  }
  async deleteRun(
    namespace: WorkbenchNamespace,
    runId: string,
    memoryTombstone?: CanonMemoryTombstone,
  ) {
    const recordKey = butterflyRecordKey(namespace, runId);
    const existed = this.records.delete(recordKey);
    this.pending.delete(pendingSettlementKey(namespace, runId));
    if (existed && memoryTombstone) {
      this.memoryTombstones.set(memoryTombstone.key, structuredClone(memoryTombstone));
    }
    return existed;
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
  listMemoryTombstones(namespace: WorkbenchNamespace) {
    return listRecords<CanonMemoryTombstone>(CANON_MEMORY_TOMBSTONE_STORE, namespace);
  }
  async deleteRun(
    namespace: WorkbenchNamespace,
    runId: string,
    memoryTombstone?: CanonMemoryTombstone,
  ): Promise<boolean> {
    const database = await historyDatabase();
    const transaction = database.transaction(
      [BUTTERFLY_STORE, PENDING_SETTLEMENT_STORE, CANON_MEMORY_TOMBSTONE_STORE],
      'readwrite',
    );
    const recordStore = transaction.objectStore(BUTTERFLY_STORE);
    const key = butterflyRecordKey(namespace, runId);
    const existing = await requestResult(recordStore.get(key));
    recordStore.delete(key);
    transaction.objectStore(PENDING_SETTLEMENT_STORE)
      .delete(pendingSettlementKey(namespace, runId));
    if (existing && memoryTombstone) {
      transaction.objectStore(CANON_MEMORY_TOMBSTONE_STORE).put({
        ...memoryTombstone,
        namespaceKey: namespaceKey(memoryTombstone.namespace),
      });
    }
    await transactionComplete(transaction);
    return Boolean(existing);
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
