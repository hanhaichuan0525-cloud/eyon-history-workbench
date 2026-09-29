import type { WorkbenchNamespace } from '../core/namespace.ts';
import { recordKey } from '../core/namespace.ts';
import type { Biography } from '../schemas/biography.ts';
import type { ArtifactCanonBinding } from '../retrieval/contracts.ts';
import type { GeneratedContinuityAnchor } from '../core/continuityAnchors.ts';
import type { ContinuityViewRelation } from '../core/continuityRelations.ts';

export type BiographyCommitStatus = 'validated' | 'committed';

export interface BiographyRecord {
  key: string;
  namespace: WorkbenchNamespace;
  biographyId: string;
  requestId: string;
  triggerMessageId: number;
  assistantMessageId: number | null;
  sourceHash: string;
  status: BiographyCommitStatus;
  revision: number;
  biography: Biography;
  /** P2-A：按 origin/stage/status 分开的不可变 Canon 依赖；旧记录缺省即 unbound。 */
  canonBindings?: ArtifactCanonBinding[];
  /** P4-A：只由本记录现有事件槽派生；旧记录缺省且不会回扫正文。 */
  continuityAnchors?: GeneratedContinuityAnchor[];
  /** P4-C：同 revision 事实锚之间的低权并存/来源冲突关系；旧记录缺省。 */
  continuityRelations?: ContinuityViewRelation[];
  createdAt: number;
  updatedAt: number;
}

export interface BiographyRepository {
  saveValidated(record: BiographyRecord): Promise<void>;
  markCommitted(key: string, assistantMessageId: number): Promise<void>;
  get(key: string): Promise<BiographyRecord | null>;
  list(namespace: WorkbenchNamespace): Promise<BiographyRecord[]>;
  delete(key: string): Promise<boolean>;
}

export function biographyRecordKey(
  namespace: WorkbenchNamespace,
  biographyId: string,
): string {
  return recordKey(namespace, 'biography', biographyId);
}

export class MemoryBiographyRepository implements BiographyRepository {
  private readonly records = new Map<string, BiographyRecord>();

  async saveValidated(record: BiographyRecord): Promise<void> {
    if (this.records.has(record.key)) {
      throw new Error('Biography record already exists');
    }
    this.records.set(record.key, structuredClone(record));
  }

  async markCommitted(key: string, assistantMessageId: number): Promise<void> {
    const record = this.records.get(key);
    if (!record) {
      throw new Error('Biography record does not exist');
    }
    record.status = 'committed';
    record.assistantMessageId = assistantMessageId;
    record.revision += 1;
    record.updatedAt = Date.now();
  }

  async get(key: string): Promise<BiographyRecord | null> {
    const record = this.records.get(key);
    return record ? structuredClone(record) : null;
  }

  async list(namespace: WorkbenchNamespace): Promise<BiographyRecord[]> {
    return [...this.records.values()]
      .filter(record =>
        record.namespace.characterKey === namespace.characterKey
        && record.namespace.chatId === namespace.chatId)
      .map(record => structuredClone(record));
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}
