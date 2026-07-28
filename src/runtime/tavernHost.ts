import type {
  ArchiveAdapter,
  ButterflyFreezeSnapshot,
  ButterflyHostAdapter,
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
  strategy?: {
    type: 'constant' | 'selective' | 'vectorized';
    keys: Array<string | RegExp>;
    keys_secondary: {
      logic: 'and_any' | 'and_all' | 'not_all' | 'not_any';
      keys: Array<string | RegExp>;
    };
    scan_depth: 'same_as_global' | number;
  };
  position?: {
    type: string;
    role: 'system' | 'assistant' | 'user';
    depth: number;
    order: number;
  };
  probability?: number;
  recursion?: {
    prevent_incoming: boolean;
    prevent_outgoing: boolean;
    delay_until: null | number;
  };
  effect?: {
    sticky: null | number;
    cooldown: null | number;
    delay: null | number;
  };
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
  getWorldbookNames?(): string[];
  createWorldbook?(name: string): Promise<void>;
  rebindGlobalWorldbooks?(names: string[]): Promise<void>;
  createWorldbookEntries?(
    name: string,
    entries: Array<Partial<HostWorldbookEntry>>,
  ): Promise<{ new_entries: HostWorldbookEntry[] }>;
  updateWorldbookWith?(
    name: string,
    updater: (entries: HostWorldbookEntry[]) => HostWorldbookEntry[],
  ): Promise<HostWorldbookEntry[]>;
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
        if (
          !entry.enabled
          || !content
          || entry.extra?.source === 'eyon_butterfly_anchor'
        ) return [];
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
    const chatId = this.getNamespace().chatId;
    const names = boundWorldbookNames(this.bindings);
    const books = await Promise.all(names.map(async name => ({
      name,
      entries: await this.bindings.getWorldbook(name),
    })));
    return books.flatMap(({ name, entries }) =>
      entries.flatMap(entry => {
        const content = entry.content?.trim();
        if (
          !entry.enabled
          || !content
          || entry.extra?.source !== 'eyon_butterfly_anchor'
          || entry.extra?.chat_id !== chatId
        ) return [];
        return [{
          sourceId: `butterfly:${name}:${entry.uid}`,
          title: entry.name?.trim() || `${name} #${entry.uid}`,
          content,
        }];
      }));
  }
}

export class TavernWorkbenchHost implements HostAdapter, ButterflyHostAdapter {
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

  async getButterflyFreezeSnapshot(): Promise<ButterflyFreezeSnapshot> {
    const stat = statData(this.bindings.getChatVariables());
    const state = recordAt(stat, ['墟境系统', '运行状态']);
    const snapshot = recordAt(stat, ['墟境系统', '虚嗣指南快照']);
    const flowState = normalizeFlowState(valueAt(state, ['墟境流程状态']));
    if (flowState === 'idle') throw new Error('当前没有可遣返的墟境轮次');
    const stateRunId = textAt(state, ['墟境轮次']);
    const snapshotRunId = textAt(snapshot, ['runId']);
    if (stateRunId && snapshotRunId && stateRunId !== snapshotRunId) {
      throw new Error('运行状态与快照的活动轮次不一致，已拒绝冻结');
    }
    const runId = stateRunId;
    const matchingSnapshot = snapshotRunId === runId ? snapshot : {};
    const reality = atomicPair(
      state,
      [['本轮现实时间', '本轮现实地点'], ['墟境进入前时间', '墟境进入前地点']],
      matchingSnapshot,
      [['lockedRealTime', 'lockedRealLocation'], ['lastRealityTime', 'lastRealityLocation']],
    );
    const ruinEntry = atomicPair(
      state,
      [['本轮墟境进入时间', '本轮墟境进入地点']],
      matchingSnapshot,
      [['entryRuinTime', 'entryRuinLocation']],
    );
    const ruinExit = atomicPair(
      state,
      [
        ['本轮墟境离开时间', '本轮墟境离开地点'],
        ['墟境当前时间', '墟境当前地点'],
      ],
      matchingSnapshot,
      [['exitRuinTime', 'exitRuinLocation'], ['ruinTime', 'ruinLocation']],
    );
    if (!runId || !reality || !ruinEntry || !ruinExit) {
      throw new Error('当前轮次缺少完整的现实、进入或离开时地，已拒绝冻结');
    }
    return { flowState, runId, reality, ruinEntry, ruinExit };
  }

  async assertButterflyTarget(request: {
    requestId: string;
    userMessageId: number;
    assistantMessageId: number;
    assistantSwipeId: number | null;
    rawCommand: string;
  }): Promise<void> {
    const user = this.runtime
      .getChatMessages(request.userMessageId, { include_swipes: false })
      .find(message => message.message_id === request.userMessageId);
    const assistant = this.runtime
      .getChatMessages(request.assistantMessageId, { include_swipes: false })
      .find(message => message.message_id === request.assistantMessageId);
    if (
      !user
      || user.role !== 'user'
      || user.is_hidden
      || user.message.trim() !== request.rawCommand.trim()
      || !assistant
      || assistant.role !== 'assistant'
      || assistant.is_hidden
      || request.assistantMessageId !== request.userMessageId + 1
      || this.runtime.getMessageSwipeId(request.assistantMessageId) !== request.assistantSwipeId
      || this.runtime.getLastMessageId() !== request.assistantMessageId
    ) {
      throw new Error('遣返楼层身份已经变化，结算结果已停止提交');
    }
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

  async appendButterflyPanel(
    messageId: number,
    requestId: string,
    panel: string,
  ): Promise<void> {
    const message = this.runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.role !== 'assistant' || message.is_hidden) {
      throw new Error('绑定的遣返正文楼已经不可用');
    }
    const existingRequest = recordAt(message.extra ?? {}, ['eyonButterflyRequest']);
    if (
      existingRequest.requestId === requestId
      && message.message.includes('<butterfly_panel>')
    ) return;
    if (message.message.includes('<butterfly_panel>')) {
      throw new Error('绑定的遣返楼已经包含另一份蝴蝶效应面板');
    }
    await this.runtime.setChatMessages([{
      message_id: messageId,
      message: `${message.message.trimEnd()}\n\n${panel}`,
      extra: {
        ...(message.extra ?? {}),
        eyonButterflyRequest: {
          requestId,
          swipeId: this.runtime.getMessageSwipeId(messageId),
        },
      },
    }], { refresh: 'affected' });
  }
}

export class TavernButterflyArchiveAdapter implements ArchiveAdapter {
  private readonly bindings: TavernDataBindings;

  constructor(bindings: TavernDataBindings) {
    this.bindings = bindings;
  }

  async activateNamespace(namespace: WorkbenchNamespace): Promise<void> {
    const getNames = requireBinding(
      this.bindings.getWorldbookNames,
      'getWorldbookNames',
    );
    const rebind = requireBinding(
      this.bindings.rebindGlobalWorldbooks,
      'rebindGlobalWorldbooks',
    );
    const target = archiveWorldbookName(namespace.chatId);
    const globals = this.bindings.getGlobalWorldbookNames()
      .filter(value => !value.startsWith('伊雍-蝴蝶效应锚定-'));
    await rebind(
      getNames().includes(target) ? [...globals, target] : globals,
    );
  }

  async mirrorButterflyRecord(input: {
    namespace: WorkbenchNamespace;
    runId: string;
    assistantMessageId: number;
    title: string;
    content: string;
    keywords: string[];
    signature: string;
  }): Promise<{ worldbookName: string; uid: number }> {
    const createEntries = requireBinding(
      this.bindings.createWorldbookEntries,
      'createWorldbookEntries',
    );
    const worldbookName = archiveWorldbookName(input.namespace.chatId);
    await this.ensureReady(worldbookName);
    const entries = await this.bindings.getWorldbook(worldbookName);
    const sameRun = entries.find(entry =>
      entry.extra?.source === 'eyon_butterfly_anchor'
      && entry.extra?.chat_id === input.namespace.chatId
      && entry.extra?.run_id === input.runId
    );
    if (sameRun) {
      const update = requireBinding(
        this.bindings.updateWorldbookWith,
        'updateWorldbookWith',
      );
      await update(worldbookName, current => current.map(entry =>
        entry.uid === sameRun.uid
          ? {
              ...entry,
              name: input.title,
              content: input.content,
              strategy: {
                ...(entry.strategy ?? defaultArchiveStrategy()),
                keys: input.keywords.length ? input.keywords : [input.title],
              },
              extra: {
                ...(entry.extra ?? {}),
                signature: input.signature,
                source: 'eyon_butterfly_anchor',
                message_id: input.assistantMessageId,
                run_id: input.runId,
                chat_id: input.namespace.chatId,
              },
            }
          : entry
      ));
      return { worldbookName, uid: sameRun.uid };
    }
    const result = await createEntries(worldbookName, [{
      name: input.title,
      enabled: true,
      content: input.content,
      strategy: {
        ...defaultArchiveStrategy(),
        keys: input.keywords.length ? input.keywords : [input.title],
      },
      position: {
        type: 'after_character_definition',
        role: 'system',
        depth: 4,
        order: 120,
      },
      probability: 100,
      recursion: {
        prevent_incoming: false,
        prevent_outgoing: true,
        delay_until: null,
      },
      effect: { sticky: null, cooldown: null, delay: null },
      extra: {
        signature: input.signature,
        source: 'eyon_butterfly_anchor',
        message_id: input.assistantMessageId,
        run_id: input.runId,
        chat_id: input.namespace.chatId,
      },
    }]);
    const created = result.new_entries[0];
    if (!created) throw new Error('世界书没有返回新建的蝴蝶效应条目');
    return { worldbookName, uid: created.uid };
  }

  private async ensureReady(name: string): Promise<void> {
    const getNames = requireBinding(this.bindings.getWorldbookNames, 'getWorldbookNames');
    const create = requireBinding(this.bindings.createWorldbook, 'createWorldbook');
    const rebind = requireBinding(
      this.bindings.rebindGlobalWorldbooks,
      'rebindGlobalWorldbooks',
    );
    if (!getNames().includes(name)) {
      await create(name);
    }
    const globals = this.bindings.getGlobalWorldbookNames()
      .filter(value => !value.startsWith('伊雍-蝴蝶效应锚定-'));
    await rebind([...globals, name]);
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

function atomicPair(
  primary: Variables,
  primaryPaths: Array<[string, string]>,
  fallback: Variables,
  fallbackPaths: Array<[string, string]>,
): { time: string; location: string } | null {
  for (const [timePath, locationPath] of primaryPaths) {
    const time = textAt(primary, [timePath]);
    const location = textAt(primary, [locationPath]);
    if (time && location) return { time, location };
  }
  for (const [timePath, locationPath] of fallbackPaths) {
    const time = textAt(fallback, [timePath]);
    const location = textAt(fallback, [locationPath]);
    if (time && location) return { time, location };
  }
  return null;
}

function archiveWorldbookName(chatId: string): string {
  const safeChatId = chatId.trim().replace(/[^\w-]+/gu, '_') || 'current';
  return `伊雍-蝴蝶效应锚定-${safeChatId}`;
}

function defaultArchiveStrategy() {
  return {
    type: 'selective' as const,
    keys: [] as Array<string | RegExp>,
    keys_secondary: {
      logic: 'and_any' as const,
      keys: [] as Array<string | RegExp>,
    },
    scan_depth: 8,
  };
}

function requireBinding<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  if (!value) throw new Error(`${name} is unavailable`);
  return value;
}
