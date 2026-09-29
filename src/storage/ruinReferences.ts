import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey, recordKey } from '../core/namespace.ts';
import {
  RuinSelectedCharacterSchema,
  type RuinGenerationInput,
} from '../schemas/ruin.ts';
import {
  historyDatabase,
  requestResult,
  RUIN_REFERENCE_STORE,
  transactionComplete,
} from './database.ts';

export type RuinSelectedCharacter = RuinGenerationInput['selectedCharacters'][number];

export interface RuinBiographyReference {
  referenceId: string;
  recordKey: string;
  biographyId: string;
  title: string;
  span: string;
  summary: string;
}

export interface RuinCharacterReferenceRecord {
  key: string;
  namespace: WorkbenchNamespace;
  selectedCharacters: RuinSelectedCharacter[];
  selectedBiographies?: RuinBiographyReference[];
  updatedAt: number;
}

export interface RuinCharacterReferenceRepository {
  read(namespace: WorkbenchNamespace): Promise<RuinSelectedCharacter[]>;
  write(
    namespace: WorkbenchNamespace,
    selectedCharacters: RuinSelectedCharacter[],
  ): Promise<RuinSelectedCharacter[]>;
  readBiographies(namespace: WorkbenchNamespace): Promise<RuinBiographyReference[]>;
  writeBiographies(
    namespace: WorkbenchNamespace,
    biographies: RuinBiographyReference[],
  ): Promise<RuinBiographyReference[]>;
}

export function ruinCharacterReferenceKey(
  namespace: WorkbenchNamespace,
): string {
  return recordKey(namespace, 'ruinCharacterReferences', 'current');
}

export class MemoryRuinCharacterReferenceRepository
implements RuinCharacterReferenceRepository {
  private readonly records = new Map<string, RuinCharacterReferenceRecord>();

  async read(namespace: WorkbenchNamespace): Promise<RuinSelectedCharacter[]> {
    return structuredClone(
      this.records.get(ruinCharacterReferenceKey(namespace))?.selectedCharacters
      ?? [],
    );
  }

  async write(
    namespace: WorkbenchNamespace,
    selectedCharacters: RuinSelectedCharacter[],
  ): Promise<RuinSelectedCharacter[]> {
    const parsed = parseCharacters(selectedCharacters);
    const key = ruinCharacterReferenceKey(namespace);
    const existing = this.records.get(key);
    this.records.set(key, {
      key: ruinCharacterReferenceKey(namespace),
      namespace: structuredClone(namespace),
      selectedCharacters: structuredClone(parsed),
      selectedBiographies: structuredClone(existing?.selectedBiographies ?? []),
      updatedAt: Date.now(),
    });
    return structuredClone(parsed);
  }

  async readBiographies(namespace: WorkbenchNamespace): Promise<RuinBiographyReference[]> {
    return structuredClone(
      this.records.get(ruinCharacterReferenceKey(namespace))?.selectedBiographies ?? [],
    );
  }

  async writeBiographies(
    namespace: WorkbenchNamespace,
    biographies: RuinBiographyReference[],
  ): Promise<RuinBiographyReference[]> {
    const key = ruinCharacterReferenceKey(namespace);
    const existing = this.records.get(key);
    const parsed = parseBiographies(biographies);
    this.records.set(key, {
      key,
      namespace: structuredClone(namespace),
      selectedCharacters: structuredClone(existing?.selectedCharacters ?? []),
      selectedBiographies: structuredClone(parsed),
      updatedAt: Date.now(),
    });
    return structuredClone(parsed);
  }
}

export class IndexedDbRuinCharacterReferenceRepository
implements RuinCharacterReferenceRepository {
  async read(namespace: WorkbenchNamespace): Promise<RuinSelectedCharacter[]> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_REFERENCE_STORE, 'readonly');
    const record = await requestResult<
      (RuinCharacterReferenceRecord & { namespaceKey: string }) | undefined
    >(transaction.objectStore(RUIN_REFERENCE_STORE).get(
      ruinCharacterReferenceKey(namespace),
    ));
    await transactionComplete(transaction);
    return record ? parseCharacters(record.selectedCharacters) : [];
  }

  async write(
    namespace: WorkbenchNamespace,
    selectedCharacters: RuinSelectedCharacter[],
  ): Promise<RuinSelectedCharacter[]> {
    const parsed = parseCharacters(selectedCharacters);
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_REFERENCE_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_REFERENCE_STORE);
    const key = ruinCharacterReferenceKey(namespace);
    const existing = await requestResult<RuinCharacterReferenceRecord | undefined>(store.get(key));
    store.put({
      key: ruinCharacterReferenceKey(namespace),
      namespace: structuredClone(namespace),
      namespaceKey: namespaceKey(namespace),
      selectedCharacters: structuredClone(parsed),
      selectedBiographies: structuredClone(existing?.selectedBiographies ?? []),
      updatedAt: Date.now(),
    });
    await transactionComplete(transaction);
    return structuredClone(parsed);
  }

  async readBiographies(namespace: WorkbenchNamespace): Promise<RuinBiographyReference[]> {
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_REFERENCE_STORE, 'readonly');
    const record = await requestResult<RuinCharacterReferenceRecord | undefined>(
      transaction.objectStore(RUIN_REFERENCE_STORE).get(ruinCharacterReferenceKey(namespace)),
    );
    await transactionComplete(transaction);
    return parseBiographies(record?.selectedBiographies ?? []);
  }

  async writeBiographies(
    namespace: WorkbenchNamespace,
    biographies: RuinBiographyReference[],
  ): Promise<RuinBiographyReference[]> {
    const parsed = parseBiographies(biographies);
    const database = await historyDatabase();
    const transaction = database.transaction(RUIN_REFERENCE_STORE, 'readwrite');
    const store = transaction.objectStore(RUIN_REFERENCE_STORE);
    const key = ruinCharacterReferenceKey(namespace);
    const existing = await requestResult<RuinCharacterReferenceRecord | undefined>(store.get(key));
    store.put({
      key,
      namespace: structuredClone(namespace),
      namespaceKey: namespaceKey(namespace),
      selectedCharacters: structuredClone(existing?.selectedCharacters ?? []),
      selectedBiographies: structuredClone(parsed),
      updatedAt: Date.now(),
    });
    await transactionComplete(transaction);
    return structuredClone(parsed);
  }
}

function parseBiographies(values: RuinBiographyReference[]): RuinBiographyReference[] {
  const unique = new Map<string, RuinBiographyReference>();
  for (const value of values) {
    if (!value || typeof value !== 'object') continue;
    const referenceId = String(value.referenceId ?? '').trim();
    const recordKey = String(value.recordKey ?? '').trim();
    const biographyId = String(value.biographyId ?? '').trim();
    if (!referenceId || !recordKey || !biographyId) continue;
    unique.set(referenceId, {
      referenceId,
      recordKey,
      biographyId,
      title: String(value.title ?? '').trim(),
      span: String(value.span ?? '').trim(),
      summary: String(value.summary ?? '').trim(),
    });
  }
  return [...unique.values()];
}

function parseCharacters(
  selectedCharacters: RuinSelectedCharacter[],
): RuinSelectedCharacter[] {
  const unique = new Map<string, RuinSelectedCharacter>();
  for (const value of selectedCharacters) {
    const parsed = RuinSelectedCharacterSchema.parse(value);
    unique.set(ruinCharacterReferenceIdentity(parsed), parsed);
  }
  return [...unique.values()];
}

export function ruinCharacterReferenceIdentity(
  character: RuinSelectedCharacter,
): string {
  return character.referenceId ?? character.mvuId;
}

export function pruneStaleGenealogyReferences(
  selectedCharacters: RuinSelectedCharacter[],
  staleRequestIds: ReadonlySet<string>,
  focusMvuId: string,
): RuinSelectedCharacter[] {
  return selectedCharacters.filter(character => {
    if (character.source !== 'genealogy') return true;
    if (!character.referenceId) return character.mvuId !== focusMvuId;

    for (const requestId of staleRequestIds) {
      if (character.referenceId.startsWith(`genealogy:${requestId}:`)) {
        return false;
      }
    }
    return true;
  });
}
