import type {
  HostAdapter,
  RuinRuntimeSnapshot,
  UserTurnAdapter,
} from '../adapters/host.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { BiographyRepository } from '../storage/biographies.ts';
import type { GenealogyRepository } from '../storage/genealogies.ts';
import type {
  RuntimeContextSourceProvider,
  TavernRuntime,
} from './contracts.ts';

type Variables = Record<string, unknown>;

export interface HostWorldbookEntry {
  uid: number;
  name: string;
  enabled: boolean;
  content: string;
  extra?: Record<string, unknown>;
}

export interface TavernDataBindings {
  getChatVariables(): Variables;
  getCharWorldbookNames(): {
    primary: string | null;
    additional: string[];
  };
  getChatWorldbookName(): string | null;
  getGlobalWorldbookNames(): string[];
  getWorldbook(name: string): Promise<HostWorldbookEntry[]>;
  createUserMessage(text: string): Promise<void>;
  triggerReply(): Promise<void>;
}

export class TavernContextSourceProvider implements RuntimeContextSourceProvider {
  private readonly bindings: TavernDataBindings;
  private readonly biographies: BiographyRepository;
  private readonly genealogies: GenealogyRepository;
  private readonly getNamespace: () => WorkbenchNamespace;

  constructor(
    bindings: TavernDataBindings,
    biographies: BiographyRepository,
    genealogies: GenealogyRepository,
    getNamespace: () => WorkbenchNamespace,
  ) {
    this.bindings = bindings;
    this.biographies = biographies;
    this.genealogies = genealogies;
    this.getNamespace = getNamespace;
  }

  async getCurrentWorld() {
    const stat = statData(this.bindings.getChatVariables());
    return {
      time: textAt(stat, ['世界', '时间']),
      location: textAt(stat, ['世界', '地点']),
    };
  }

  async getWorldbookSources() {
    const names = boundWorldbookNames(this.bindings);
    const books = await Promise.all(names.map(async name => ({
      name,
      entries: await this.bindings.getWorldbook(name),
    })));
    return books.flatMap(({ name, entries }) =>
      entries.flatMap(entry => {
        const content = entry.content?.trim();
        if (!entry.enabled || !content) return [];
        return [{
          sourceId: `worldbook:${name}:${entry.uid}`,
          title: entry.name?.trim() || `${name} #${entry.uid}`,
          content,
        }];
      }));
  }

  async getCharacterSources() {
    const characters = recordAt(statData(this.bindings.getChatVariables()), ['关系列表']);
    return Object.entries(characters).flatMap(([name, value]) => {
      if (!isRecord(value)) return [];
      return [{
        sourceId: `mvu-character:${name}`,
        title: name,
        content: JSON.stringify({ name, ...value }),
      }];
    });
  }

  async getGenealogySources() {
    const records = await this.genealogies.list(this.getNamespace());
    const latestByFocus = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const focusId = record.result.focusCharacterId;
      const current = latestByFocus.get(focusId);
      if (!current || record.createdAt > current.createdAt) {
        latestByFocus.set(focusId, record);
      }
    }
    return [...latestByFocus.values()].map(record => ({
      sourceId: `genealogy:${record.requestId}`,
      title: `${record.result.focusCharacterName}宗族谱系`,
      content: JSON.stringify(record.result),
    }));
  }

  async getBiographySources() {
    const records = await this.biographies.list(this.getNamespace());
    return records
      .filter(record => record.status === 'committed')
      .map(record => ({
        sourceId: `biography:${record.biographyId}`,
        title: record.biography.target.name,
        content: JSON.stringify(record.biography),
      }));
  }

  async getButterflySources() {
    const sources = await this.getWorldbookSources();
    return sources.filter(source =>
      source.title.includes('蝴蝶效应锚定日志')
      || source.content.includes('蝴蝶效应锚定日志'));
  }
}

export class TavernWorkbenchHost implements HostAdapter {
  private readonly runtime: TavernRuntime;
  private readonly bindings: TavernDataBindings;

  constructor(
    runtime: TavernRuntime,
    bindings: TavernDataBindings,
  ) {
    this.runtime = runtime;
    this.bindings = bindings;
  }

  async getNamespace(): Promise<WorkbenchNamespace> {
    const characterKey = this.runtime.getCurrentCharacterName()?.trim();
    const chatId = this.runtime.getCurrentChatId().trim();
    if (!characterKey || !chatId) {
      throw new Error('当前没有可用的角色聊天');
    }
    return { characterKey, chatId };
  }

  async getRuinRuntimeSnapshot(): Promise<RuinRuntimeSnapshot> {
    const stat = statData(this.bindings.getChatVariables());
    const state = recordAt(stat, ['墟境系统', '运行状态']);
    const flowState = normalizeFlowState(valueAt(state, ['墟境流程状态']));
    const worldTime = textAt(stat, ['世界', '时间']);
    const worldLocation = textAt(stat, ['世界', '地点']);
    return {
      flowState,
      runId: textAt(state, ['墟境轮次']),
      realityTime: flowState === 'idle'
        ? worldTime
        : firstText(state, ['本轮现实时间'], ['墟境进入前时间']),
      realityLocation: flowState === 'idle'
        ? worldLocation
        : firstText(state, ['本轮现实地点'], ['墟境进入前地点']),
      ruinTime: textAt(state, ['墟境当前时间']),
      ruinLocation: textAt(state, ['墟境当前地点']),
    };
  }

  async getLatestUserText(): Promise<string> {
    const messages = this.runtime.getChatMessages(
      `0-${this.runtime.getLastMessageId()}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user' && !message.is_hidden) return message.message;
    }
    return '';
  }

  async replaceAssistantSlot(
    messageId: number,
    slot: string,
    content: string,
  ): Promise<void> {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.role !== 'assistant' || !message.message.includes(slot)) {
      throw new Error('目标正文楼或占位符已经变化');
    }
    await this.runtime.setChatMessages([{
      message_id: messageId,
      message: message.message.replace(slot, content),
    }], { refresh: 'affected' });
  }
}

export class SerializedTavernUserTurnAdapter implements UserTurnAdapter {
  private tail: Promise<void> = Promise.resolve();
  private readonly runtime: TavernRuntime;
  private readonly bindings: TavernDataBindings;

  constructor(
    runtime: TavernRuntime,
    bindings: TavernDataBindings,
  ) {
    this.runtime = runtime;
    this.bindings = bindings;
  }

  async sendUserTurn(text: string): Promise<{ messageId: number }> {
    const run = this.tail.then(() => this.submit(text));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async submit(text: string): Promise<{ messageId: number }> {
    const normalized = text.trim();
    if (!normalized) throw new Error('不能发送空的墟境进入指令');
    await this.bindings.createUserMessage(normalized);
    const messageId = this.runtime.getLastMessageId();
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (
      !message
      || message.role !== 'user'
      || message.is_hidden
      || message.message.trim() !== normalized
    ) {
      throw new Error('酒馆没有建立预期的唯一玩家楼，已停止触发正文');
    }
    await this.bindings.triggerReply();
    return { messageId };
  }
}

function boundWorldbookNames(bindings: TavernDataBindings): string[] {
  const character = bindings.getCharWorldbookNames();
  return [...new Set([
    character.primary,
    ...character.additional,
    bindings.getChatWorldbookName(),
    ...bindings.getGlobalWorldbookNames(),
  ].filter((name): name is string => Boolean(name?.trim())))];
}

function statData(variables: Variables): Variables {
  const value = variables.stat_data;
  return isRecord(value) ? value : variables;
}

function normalizeFlowState(value: unknown): RuinRuntimeSnapshot['flowState'] {
  return value === 'exploring'
    || value === 'anchored'
    || value === 'returning'
    ? value
    : 'idle';
}

function firstText(source: Variables, ...paths: string[][]): string {
  for (const path of paths) {
    const value = textAt(source, path);
    if (value) return value;
  }
  return '';
}

function textAt(source: Variables, path: string[]): string {
  const value = valueAt(source, path);
  return typeof value === 'string' ? value.trim() : '';
}

function recordAt(source: Variables, path: string[]): Variables {
  const value = valueAt(source, path);
  return isRecord(value) ? value : {};
}

function valueAt(source: Variables, path: string[]): unknown {
  let current: unknown = source;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function isRecord(value: unknown): value is Variables {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
