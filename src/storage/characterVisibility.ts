import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  CHARACTER_VISIBILITY_STORE,
  historyDatabase,
  requestResult,
  transactionComplete,
} from './database.ts';

export interface CharacterVisibilityRecord {
  key: string;
  namespace: WorkbenchNamespace;
  hiddenCharacterIds: string[];
  groups?: CharacterGroupRecord[];
  updatedAt: number;
}

export interface CharacterGroupRecord {
  id: string;
  name: string;
  characterIds: string[];
  order: number;
}

export interface CharacterVisibilityRepository {
  get(namespace: WorkbenchNamespace): Promise<CharacterVisibilityRecord | null>;
  put(record: CharacterVisibilityRecord): Promise<void>;
  clear(namespace: WorkbenchNamespace): Promise<void>;
}

export function characterVisibilityKey(namespace: WorkbenchNamespace): string {
  return namespaceKey(namespace);
}

export class MemoryCharacterVisibilityRepository
implements CharacterVisibilityRepository {
  private readonly records = new Map<string, CharacterVisibilityRecord>();

  async get(namespace: WorkbenchNamespace) {
    return structuredClone(this.records.get(characterVisibilityKey(namespace)) ?? null);
  }

  async put(record: CharacterVisibilityRecord) {
    this.records.set(record.key, structuredClone(record));
  }

  async clear(namespace: WorkbenchNamespace) {
    this.records.delete(characterVisibilityKey(namespace));
  }
}

export class IndexedDbCharacterVisibilityRepository
implements CharacterVisibilityRepository {
  async get(namespace: WorkbenchNamespace) {
    const database = await historyDatabase();
    const transaction = database.transaction(CHARACTER_VISIBILITY_STORE, 'readonly');
    const record = await requestResult<CharacterVisibilityRecord | undefined>(
      transaction.objectStore(CHARACTER_VISIBILITY_STORE).get(
        characterVisibilityKey(namespace),
      ),
    );
    return record ?? null;
  }

  async put(record: CharacterVisibilityRecord) {
    const database = await historyDatabase();
    const transaction = database.transaction(CHARACTER_VISIBILITY_STORE, 'readwrite');
    transaction.objectStore(CHARACTER_VISIBILITY_STORE).put(record);
    await transactionComplete(transaction);
  }

  async clear(namespace: WorkbenchNamespace) {
    const database = await historyDatabase();
    const transaction = database.transaction(CHARACTER_VISIBILITY_STORE, 'readwrite');
    transaction.objectStore(CHARACTER_VISIBILITY_STORE).delete(
      characterVisibilityKey(namespace),
    );
    await transactionComplete(transaction);
  }
}
