import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import type {
  CharacterVisibilityRepository,
} from '../storage/characterVisibility.ts';
import { characterVisibilityKey } from '../storage/characterVisibility.ts';
import type {
  WorkbenchCharacter,
  WorkbenchCharacterCatalog,
} from './facade.ts';

interface CharacterSource {
  sourceId: string;
  title: string;
  content: string;
}

export interface CharacterCatalogSources {
  getCharacterSources(): Promise<CharacterSource[]>;
}

export class CharacterCatalogService {
  private mutation = Promise.resolve();
  private readonly sources: CharacterCatalogSources;
  private readonly repository: CharacterVisibilityRepository;
  private readonly getNamespace: () => WorkbenchNamespace;
  private readonly now: () => number;

  constructor(
    sources: CharacterCatalogSources,
    repository: CharacterVisibilityRepository,
    getNamespace: () => WorkbenchNamespace,
    now: () => number = Date.now,
  ) {
    this.sources = sources;
    this.repository = repository;
    this.getNamespace = getNamespace;
    this.now = now;
  }

  getCatalog(): Promise<WorkbenchCharacterCatalog> {
    return this.readCurrentCatalog();
  }

  hide(characterId: string): Promise<WorkbenchCharacterCatalog> {
    return this.serialize(async () => {
      const normalizedId = characterId.trim();
      if (!normalizedId) throw new Error('人物标识不能为空');
      const namespace = this.getNamespace();
      const characterSources = await this.sources.getCharacterSources();
      this.assertNamespace(namespace);
      const exists = characterSources.some(source =>
        source.sourceId === `mvu-character:${normalizedId}`);
      if (!exists) throw new Error('当前MVU关系列表中没有这个人物');
      const current = await this.repository.get(namespace);
      this.assertNamespace(namespace);
      const hiddenCharacterIds = [...new Set([
        ...(current?.hiddenCharacterIds ?? []),
        normalizedId,
      ])].sort((left, right) => left.localeCompare(right, 'zh-CN'));
      await this.repository.put({
        key: characterVisibilityKey(namespace),
        namespace,
        hiddenCharacterIds,
        updatedAt: this.now(),
      });
      this.assertNamespace(namespace);
      return catalogFrom(characterSources, hiddenCharacterIds);
    });
  }

  sync(): Promise<WorkbenchCharacterCatalog> {
    return this.serialize(async () => {
      const namespace = this.getNamespace();
      await this.repository.clear(namespace);
      this.assertNamespace(namespace);
      const characterSources = await this.sources.getCharacterSources();
      this.assertNamespace(namespace);
      return catalogFrom(characterSources, []);
    });
  }

  private async readCurrentCatalog(): Promise<WorkbenchCharacterCatalog> {
    const namespace = this.getNamespace();
    const [characterSources, visibility] = await Promise.all([
      this.sources.getCharacterSources(),
      this.repository.get(namespace),
    ]);
    this.assertNamespace(namespace);
    return catalogFrom(characterSources, visibility?.hiddenCharacterIds ?? []);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation, operation);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private assertNamespace(expected: WorkbenchNamespace): void {
    if (namespaceKey(expected) !== namespaceKey(this.getNamespace())) {
      throw new Error('人物目录操作期间聊天已经切换，已取消本次修改');
    }
  }
}

function catalogFrom(
  sources: CharacterSource[],
  hiddenCharacterIds: string[],
): WorkbenchCharacterCatalog {
  const hiddenIds = new Set(hiddenCharacterIds);
  const allCharacters = sources.flatMap(source => {
    const character = characterFromSource(source);
    return character ? [character] : [];
  });
  return {
    characters: allCharacters.filter(character => !hiddenIds.has(character.id)),
    hiddenCount: allCharacters.filter(character => hiddenIds.has(character.id)).length,
    totalCount: allCharacters.length,
  };
}

function characterFromSource(source: CharacterSource): WorkbenchCharacter | null {
  if (!source.sourceId.startsWith('mvu-character:')) return null;
  const id = source.sourceId.slice('mvu-character:'.length).trim();
  if (!id) return null;
  try {
    const parsed = JSON.parse(source.content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return {
      id,
      name: source.title.trim() || id,
      data: parsed as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}
