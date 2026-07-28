import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import type {
  CharacterGroupRecord,
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
  private readonly createId: () => string;

  constructor(
    sources: CharacterCatalogSources,
    repository: CharacterVisibilityRepository,
    getNamespace: () => WorkbenchNamespace,
    now: () => number = Date.now,
    createId: () => string = () => crypto.randomUUID(),
  ) {
    this.sources = sources;
    this.repository = repository;
    this.getNamespace = getNamespace;
    this.now = now;
    this.createId = createId;
  }

  getCatalog(): Promise<WorkbenchCharacterCatalog> {
    return this.readCurrentCatalog();
  }

  hide(characterId: string): Promise<WorkbenchCharacterCatalog> {
    const normalizedId = requireCharacterId(characterId);
    return this.mutate((preferences, characterSources) => {
      requireExistingCharacter(characterSources, normalizedId);
      return {
        ...preferences,
        hiddenCharacterIds: [...new Set([
          ...preferences.hiddenCharacterIds,
          normalizedId,
        ])].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      };
    });
  }

  sync(): Promise<WorkbenchCharacterCatalog> {
    return this.mutate(preferences => ({
      ...preferences,
      hiddenCharacterIds: [],
    }));
  }

  createGroup(name: string): Promise<WorkbenchCharacterCatalog> {
    const normalizedName = requireGroupName(name);
    return this.mutate(preferences => {
      requireUniqueGroupName(preferences.groups, normalizedName);
      return {
        ...preferences,
        groups: [
          ...preferences.groups,
          {
            id: `group-${this.createId()}`,
            name: normalizedName,
            characterIds: [],
            order: nextGroupOrder(preferences.groups),
          },
        ],
      };
    });
  }

  renameGroup(groupId: string, name: string): Promise<WorkbenchCharacterCatalog> {
    const normalizedGroupId = requireGroupId(groupId);
    const normalizedName = requireGroupName(name);
    return this.mutate(preferences => {
      requireGroup(preferences.groups, normalizedGroupId);
      requireUniqueGroupName(preferences.groups, normalizedName, normalizedGroupId);
      return {
        ...preferences,
        groups: preferences.groups.map(group =>
          group.id === normalizedGroupId
            ? { ...group, name: normalizedName }
            : group),
      };
    });
  }

  deleteGroup(groupId: string): Promise<WorkbenchCharacterCatalog> {
    const normalizedGroupId = requireGroupId(groupId);
    return this.mutate(preferences => {
      requireGroup(preferences.groups, normalizedGroupId);
      return {
        ...preferences,
        groups: preferences.groups.filter(group => group.id !== normalizedGroupId),
      };
    });
  }

  moveCharacter(
    characterId: string,
    groupId: string | null,
  ): Promise<WorkbenchCharacterCatalog> {
    const normalizedCharacterId = requireCharacterId(characterId);
    const normalizedGroupId = groupId === null ? null : requireGroupId(groupId);
    return this.mutate((preferences, characterSources) => {
      requireExistingCharacter(characterSources, normalizedCharacterId);
      if (normalizedGroupId !== null) {
        requireGroup(preferences.groups, normalizedGroupId);
      }
      return {
        ...preferences,
        groups: preferences.groups.map(group => ({
          ...group,
          characterIds: group.id === normalizedGroupId
            ? [...new Set([...group.characterIds, normalizedCharacterId])]
            : group.characterIds.filter(id => id !== normalizedCharacterId),
        })),
      };
    });
  }

  private async readCurrentCatalog(): Promise<WorkbenchCharacterCatalog> {
    const namespace = this.getNamespace();
    const [characterSources, visibility] = await Promise.all([
      this.sources.getCharacterSources(),
      this.repository.get(namespace),
    ]);
    this.assertNamespace(namespace);
    const preferences = normalizePreferences(visibility);
    return catalogFrom(
      characterSources,
      preferences.hiddenCharacterIds,
      preferences.groups,
    );
  }

  private mutate(
    transform: (
      preferences: CharacterPreferences,
      characterSources: CharacterSource[],
    ) => CharacterPreferences,
  ): Promise<WorkbenchCharacterCatalog> {
    return this.serialize(async () => {
      const namespace = this.getNamespace();
      const [characterSources, current] = await Promise.all([
        this.sources.getCharacterSources(),
        this.repository.get(namespace),
      ]);
      this.assertNamespace(namespace);
      const next = transform(normalizePreferences(current), characterSources);
      await this.repository.put({
        key: characterVisibilityKey(namespace),
        namespace,
        hiddenCharacterIds: next.hiddenCharacterIds,
        groups: next.groups,
        updatedAt: this.now(),
      });
      this.assertNamespace(namespace);
      return catalogFrom(
        characterSources,
        next.hiddenCharacterIds,
        next.groups,
      );
    });
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
  groups: CharacterGroupRecord[],
): WorkbenchCharacterCatalog {
  const hiddenIds = new Set(hiddenCharacterIds);
  const allCharacters = sources.flatMap(source => {
    const character = characterFromSource(source);
    return character ? [character] : [];
  });
  const visibleCharacters = allCharacters.filter(character => !hiddenIds.has(character.id));
  const visibleIds = new Set(visibleCharacters.map(character => character.id));
  return {
    characters: visibleCharacters,
    groups: [...groups]
      .sort((left, right) => left.order - right.order)
      .map(group => ({
        ...group,
        characterIds: group.characterIds.filter(id => visibleIds.has(id)),
      })),
    hiddenCount: allCharacters.filter(character => hiddenIds.has(character.id)).length,
    totalCount: allCharacters.length,
  };
}

interface CharacterPreferences {
  hiddenCharacterIds: string[];
  groups: CharacterGroupRecord[];
}

function normalizePreferences(
  record: {
    hiddenCharacterIds?: string[];
    groups?: CharacterGroupRecord[];
  } | null,
): CharacterPreferences {
  return {
    hiddenCharacterIds: [...new Set(
      (record?.hiddenCharacterIds ?? []).filter(id => typeof id === 'string' && id.trim()),
    )],
    groups: (record?.groups ?? [])
      .filter(group =>
        group
        && typeof group.id === 'string'
        && group.id.trim()
        && typeof group.name === 'string'
        && group.name.trim())
      .map((group, index) => ({
        id: group.id.trim(),
        name: group.name.trim(),
        characterIds: [...new Set(
          (group.characterIds ?? []).filter(id => typeof id === 'string' && id.trim()),
        )],
        order: Number.isFinite(group.order) ? group.order : index,
      })),
  };
}

function requireCharacterId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('人物标识不能为空');
  return normalized;
}

function requireExistingCharacter(
  sources: CharacterSource[],
  characterId: string,
): void {
  if (!sources.some(source => source.sourceId === `mvu-character:${characterId}`)) {
    throw new Error('当前MVU关系列表中没有这个人物');
  }
}

function requireGroupId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('组别标识不能为空');
  return normalized;
}

function requireGroupName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error('组别名称不能为空');
  if (normalized.length > 24) throw new Error('组别名称不能超过24个字符');
  return normalized;
}

function requireGroup(
  groups: CharacterGroupRecord[],
  groupId: string,
): CharacterGroupRecord {
  const group = groups.find(item => item.id === groupId);
  if (!group) throw new Error('当前聊天中没有这个自定义组别');
  return group;
}

function requireUniqueGroupName(
  groups: CharacterGroupRecord[],
  name: string,
  exceptGroupId?: string,
): void {
  const normalized = name.toLocaleLowerCase('zh-CN');
  if (groups.some(group =>
    group.id !== exceptGroupId
    && group.name.toLocaleLowerCase('zh-CN') === normalized)) {
    throw new Error('当前聊天中已经存在同名组别');
  }
}

function nextGroupOrder(groups: CharacterGroupRecord[]): number {
  return groups.reduce((maximum, group) => Math.max(maximum, group.order), -1) + 1;
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
