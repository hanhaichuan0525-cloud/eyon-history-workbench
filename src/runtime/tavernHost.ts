import type {
  ArchiveAdapter,
  ButterflyFreezeSnapshot,
  ButterflyHostAdapter,
  HostAdapter,
  MirrorRetirementResult,
  RuinRuntimeSnapshot,
  RuinTaskSnapshot,
  UserTurnAdapter,
} from '../adapters/host.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { BiographyRepository } from '../storage/biographies.ts';
import type { GenealogyRepository } from '../storage/genealogies.ts';
import type { ButterflyRecord, ButterflyRepository } from '../storage/butterflies.ts';
import type { CanonRepository } from '../storage/canon.ts';
import type {
  RuntimeWorldbookCorpus,
  RuntimeWorldbookSource,
  WorldbookCorpusEntryReceipt,
  WorldbookCorpusEntryStatus,
  WorldbookBindingScope,
} from '../retrieval/contracts.ts';
import { worldbookLogicalId } from '../retrieval/sourceSnapshot.ts';
import type {
  RuntimeContextSourceProvider,
  TavernRuntime,
} from './contracts.ts';
import { normalizeCommandInput } from '../core/commands.ts';
import { isLatestVisibleTurnPair } from './visibleTurns.ts';
import { loadCurrentButterflySources } from './butterflySources.ts';
import { fingerprintText } from './transactionIdentity.ts';
import { genealogySources, projectGenealogyRecords, projectGenealogyRuinReferences } from './genealogySources.ts';
import { currentGenealogyHistoryReferences } from './genealogyContinuity.ts';
import type { RuinSelectedCharacter } from '../storage/ruinReferences.ts';

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

export interface CharacterWorldbookEntryOption {
  key: string;
  scope: 'character' | 'global';
  worldbookName: string;
  uid: number;
  name: string;
  preview: string;
  enabledInTavern: boolean;
  selectedForWorkbench: boolean;
}

export interface TavernDataBindings {
  getChatVariables(): Variables;
  getCurrentVariables(): Variables;
  getMessageVariables?(messageId: number): Variables;
  replaceMessageVariables?(
    messageId: number,
    variables: Variables,
  ): Promise<void>;
  getCharWorldbookNames(): {
    primary: string | null;
    additional: string[];
  };
  getChatWorldbookName(): string | null;
  getGlobalWorldbookNames(): string[];
  getWorldbook(name: string): Promise<HostWorldbookEntry[]>;
  getWorldbookNames?(): string[];
  rebindGlobalWorldbooks?(names: string[]): Promise<void>;
  deleteWorldbookEntries?(
    name: string,
    predicate: (entry: HostWorldbookEntry) => boolean,
  ): Promise<{ deleted_entries: HostWorldbookEntry[] }>;
  createUserMessage(text: string): Promise<void>;
  triggerReply(): Promise<void>;
}

export class TavernContextSourceProvider implements RuntimeContextSourceProvider {
  private readonly bindings: TavernDataBindings;
  private readonly biographies: BiographyRepository;
  private readonly genealogies: GenealogyRepository;
  private readonly getNamespace: () => WorkbenchNamespace;
  private readonly getExcludedWorldbookEntryKeys: (
    namespace: WorkbenchNamespace,
  ) => ReadonlySet<string>;
  /** internal.87（§6 步 B）：蝴蝶史料源改为本地记录 + Canon 投影；未接线时返回空。 */
  private readonly butterflies?: ButterflyRepository;
  private readonly canon?: CanonRepository;

  constructor(
    bindings: TavernDataBindings,
    biographies: BiographyRepository,
    genealogies: GenealogyRepository,
    getNamespace: () => WorkbenchNamespace,
    getExcludedWorldbookEntryKeys: (
      namespace: WorkbenchNamespace,
    ) => ReadonlySet<string> = () => new Set(),
    butterflies?: ButterflyRepository,
    canon?: CanonRepository,
  ) {
    this.bindings = bindings;
    this.biographies = biographies;
    this.genealogies = genealogies;
    this.getNamespace = getNamespace;
    this.getExcludedWorldbookEntryKeys = getExcludedWorldbookEntryKeys;
    this.butterflies = butterflies;
    this.canon = canon;
  }

  async getCurrentWorld() {
    const stat = statData(this.bindings.getCurrentVariables());
    return {
      time: textAt(stat, ['世界', '时间']),
      location: textAt(stat, ['世界', '地点']),
    };
  }

  async getWorldbookSources(): Promise<RuntimeWorldbookSource[]> {
    return (await this.getWorldbookCorpus()).sources;
  }

  async getWorldbookCorpus(): Promise<RuntimeWorldbookCorpus> {
    const bindings = boundWorldbookBindings(this.bindings);
    const excluded = this.getExcludedWorldbookEntryKeys(this.getNamespace());
    const books = await Promise.all(bindings.map(async binding => ({
      ...binding,
      entries: await this.bindings.getWorldbook(binding.name),
    })));
    const sources: RuntimeWorldbookSource[] = [];
    const receiptEntries: WorldbookCorpusEntryReceipt[] = [];
    for (const { name, scopes, entries } of books) {
      for (const entry of entries) {
        const content = entry.content?.trim();
        const sourceId = `worldbook:${name}:${entry.uid}`;
        const logicalId = worldbookLogicalId(name, entry.uid);
        const status: WorldbookCorpusEntryStatus = !entry.enabled
          ? 'disabled'
          // internal.87（§6 步 B）：镜像条目已退役——蝴蝶史料改由本地记录供给，
          // 残留的旧镜像条目继续排除在检索语料之外（清理前也不会回流）。
          : entry.extra?.source === 'eyon_butterfly_anchor'
            ? 'routed-generated'
            : excluded.has(worldbookEntryKey(name, entry.uid))
              ? 'user-excluded'
              : !content
                ? 'empty'
                : 'retrievable';
        receiptEntries.push({
          logicalId,
          sourceId,
          worldbookName: name,
          uid: entry.uid,
          title: entry.name?.trim() || `${name} #${entry.uid}`,
          bindingScopes: [...scopes],
          enabled: entry.enabled,
          status,
        });
        if (status !== 'retrievable' || !content) continue;
        const primaryKeys = (entry.strategy?.keys ?? [])
          .map(normalizeWorldbookKey)
          .filter(Boolean);
        sources.push({
          sourceId,
          title: entry.name?.trim() || `${name} #${entry.uid}`,
          content,
          strategyType: entry.strategy?.type === 'constant' ? 'constant' : 'selective',
          keywords: primaryKeys,
          worldbook: {
            schema: 'eyon.retrieval.worldbook-metadata.v1',
            logicalId,
            worldbookName: name,
            uid: entry.uid,
            bindingScopes: [...scopes],
            enabled: entry.enabled,
            strategy: {
              type: entry.strategy?.type ?? 'selective',
              primaryKeys,
              secondary: {
                logic: entry.strategy?.keys_secondary.logic ?? 'and_any',
                keys: (entry.strategy?.keys_secondary.keys ?? [])
                  .map(normalizeWorldbookKey)
                  .filter(Boolean),
              },
              scanDepth: entry.strategy?.scan_depth ?? 'same_as_global',
            },
            position: entry.position ? { ...entry.position } : null,
            probability: entry.probability ?? null,
            recursion: entry.recursion ? {
              preventIncoming: entry.recursion.prevent_incoming,
              preventOutgoing: entry.recursion.prevent_outgoing,
              delayUntil: entry.recursion.delay_until,
            } : null,
            effect: entry.effect ? { ...entry.effect } : null,
            extra: entry.extra ? { ...entry.extra } : {},
          },
        });
      }
    }
    const count = (status: WorldbookCorpusEntryStatus) =>
      receiptEntries.filter(entry => entry.status === status).length;
    return {
      sources,
      receipt: {
        schema: 'eyon.retrieval.worldbook-corpus.v1',
        complete: true,
        bindings: bindings.map(binding => ({
          worldbookName: binding.name,
          scopes: [...binding.scopes],
        })),
        entries: receiptEntries,
        counts: {
          total: receiptEntries.length,
          enabled: receiptEntries.filter(entry => entry.enabled).length,
          retrievable: count('retrievable'),
          disabled: count('disabled'),
          empty: count('empty'),
          'user-excluded': count('user-excluded'),
          'routed-generated': count('routed-generated'),
        },
      },
    };
  }

  async listCharacterWorldbookEntries(): Promise<CharacterWorldbookEntryOption[]> {
    const characterNames = characterWorldbookNames(this.bindings);
    const characterNameSet = new Set(characterNames);
    const booksToRead = [
      ...characterNames.map(worldbookName => ({
        scope: 'character' as const,
        worldbookName,
      })),
      ...this.bindings.getGlobalWorldbookNames()
        .filter(worldbookName => !characterNameSet.has(worldbookName))
        .map(worldbookName => ({
          scope: 'global' as const,
          worldbookName,
        })),
    ];
    const excluded = this.getExcludedWorldbookEntryKeys(this.getNamespace());
    const books = await Promise.all(booksToRead.map(async ({ scope, worldbookName }) => ({
      scope,
      worldbookName,
      entries: await this.bindings.getWorldbook(worldbookName),
    })));
    return books.flatMap(({ scope, worldbookName, entries }) =>
      entries.map(entry => {
        const key = worldbookEntryKey(worldbookName, entry.uid);
        const content = entry.content?.trim() ?? '';
        return {
          key,
          scope,
          worldbookName,
          uid: entry.uid,
          name: entry.name?.trim() || `${worldbookName} #${entry.uid}`,
          preview: content.replace(/\s+/gu, ' ').slice(0, 120),
          enabledInTavern: entry.enabled,
          selectedForWorkbench: entry.enabled && !excluded.has(key),
        };
      }));
  }

  async getCharacterSources() {
    const characters = recordAt(
      statData(this.bindings.getCurrentVariables()),
      ['关系列表'],
    );
    return Object.entries(characters).flatMap(([name, value]) => {
      // 关系列表值可能是对象（结构化人物卡）或整段文本（含 EJS/人设的字符串）。
      // 字符串值绝不能展开：...value 会把字符串拆成逐字符索引对象，JSON 化后
      // 「年龄: 27岁」等连续文本被打散，catalog 的任意位置提取将整链失效。
      // 统一包装进 entry 字段，保证连续文本可读。
      if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return [];
        return [{
          sourceId: `mvu-character:${name}`,
          title: name,
          content: JSON.stringify({ name, entry: text }),
        }];
      }
      if (!isRecord(value)) return [];
      return [{
        sourceId: `mvu-character:${name}`,
        title: name,
        content: JSON.stringify({ name, ...value }),
      }];
    });
  }

  async getGenealogySources() {
    const namespace = this.getNamespace();
    try {
      const [records, branch, biographies] = await Promise.all([
        this.genealogies.list(namespace), this.canon?.getBranch(namespace), this.biographies.list(namespace),
      ]);
      return genealogySources(records, branch, branch ? currentGenealogyHistoryReferences(biographies, branch) : []);
    } catch (error) {
      console.warn('[Eyon History Workbench] genealogy projection unavailable', error);
      return [];
    }
  }

  async getCurrentGenealogyRecords() {
    const namespace = this.getNamespace();
    const [records, branch] = await Promise.all([this.genealogies.list(namespace), this.canon?.getBranch(namespace)]);
    return projectGenealogyRecords(records, branch);
  }

  async projectRuinCharacters(selected: RuinSelectedCharacter[]) {
    const namespace = this.getNamespace();
    try {
      const [records, branch] = await Promise.all([this.genealogies.list(namespace), this.canon?.getBranch(namespace)]);
      return projectGenealogyRuinReferences(selected, records, branch);
    } catch (error) {
      console.warn('[Eyon History Workbench] genealogy references unavailable', error);
      return selected.filter(item => item.source !== 'genealogy');
    }
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
    // internal.87（§6 步 B）：镜像退役——源改为本地记录 + 唯一当前视图投影。
    if (!this.butterflies || !this.canon) return [];
    try {
      return await loadCurrentButterflySources({
        butterflies: this.butterflies,
        canon: this.canon,
        namespace: this.getNamespace(),
      });
    } catch (error) {
      console.error(
        '[Eyon History Workbench] butterfly source projection failed',
        error,
      );
      return [];
    }
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
    let stat = statData(this.bindings.getCurrentVariables());
    let state = recordAt(stat, ['墟境系统', '运行状态']);
    let flowState = normalizeFlowState(valueAt(state, ['墟境流程状态']));
    // 玩家楼刚建立而 MVU 尚未完成同层复制时，读取上一可见 AI 楼的活动状态。
    // 只在“当前楼是玩家楼且当前读到 idle”时回看，避免遣返后的历史活动态复活。
    if (flowState === 'idle' && this.bindings.getMessageVariables) {
      const lastMessageId = this.runtime.getLastMessageId();
      const last = this.runtime
        .getChatMessages(lastMessageId, { include_swipes: false })
        .find(message => message.message_id === lastMessageId);
      if (last?.role === 'user') {
        const messages = this.runtime.getChatMessages(
          `0-${Math.max(-1, lastMessageId - 1)}`,
          { include_swipes: false },
        );
        const previous = [...messages].reverse().find(message =>
          !message.is_hidden && message.role === 'assistant'
        );
        if (previous) {
          const priorStat = statData(
            this.bindings.getMessageVariables(previous.message_id),
          );
          const priorState = recordAt(priorStat, ['墟境系统', '运行状态']);
          const priorFlow = normalizeFlowState(
            valueAt(priorState, ['墟境流程状态']),
          );
          if (priorFlow !== 'idle') {
            stat = priorStat;
            state = priorState;
            flowState = priorFlow;
          }
        }
      }
    }
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
      ruinTasks: readRuinTasks(stat),
    };
  }

  async getButterflyFreezeSnapshot(
    sourceMessageId?: number,
  ): Promise<ButterflyFreezeSnapshot> {
    const variables = sourceMessageId === undefined
      ? this.bindings.getCurrentVariables()
      : requireBinding(
          this.bindings.getMessageVariables,
          'getMessageVariables',
        )(sourceMessageId);
    const stat = statData(variables);
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
    userSwipeId?: number | null;
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
      || normalizeCommandInput(user.message)
        !== normalizeCommandInput(request.rawCommand)
      || (
        request.userSwipeId !== undefined
        && this.runtime.getMessageSwipeId(request.userMessageId) !== request.userSwipeId
      )
      || !assistant
      || assistant.role !== 'assistant'
      || assistant.is_hidden
      || !isLatestVisibleTurnPair(
        this.runtime,
        request.userMessageId,
        request.assistantMessageId,
      )
      || this.runtime.getMessageSwipeId(request.assistantMessageId) !== request.assistantSwipeId
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
    const panelPattern = /<butterfly_panel>[\s\S]*?<\/butterfly_panel>/gu;
    const matches = [...message.message.matchAll(panelPattern)];
    if (matches.length > 1) {
      throw new Error('绑定的遣返楼包含多份蝴蝶效应面板，已拒绝猜测替换目标');
    }
    const existingRequest = recordAt(message.extra ?? {}, ['eyonButterflyRequest']);
    // internal.81 v20：面板与穿越 RuinTrace 同款楼层契约——插到正文之后、MVU
    // 变量面板（<UpdateVariable>）之前；楼里没有 MVU 面板时才文末追加。
    // 恰有一份且是本请求自己上次写入的面板时，先剥离再按同一规则重插
    // （把历史上已落在 MVU 之后的面板自动归位），同一请求重复提交幂等。
    const selfAdded = matches.length === 1
      && existingRequest.requestId === requestId;
    const nextMessage = selfAdded || matches.length === 0
      ? insertButterflyPanelText(message.message, panel)
      : message.message.replace(panelPattern, panel);
    if (
      existingRequest.requestId === requestId
      && nextMessage === message.message
    ) return;
    await this.runtime.setChatMessages([{
      message_id: messageId,
      message: nextMessage,
      extra: {
        ...(message.extra ?? {}),
        eyonButterflyRequest: {
          requestId,
          swipeId: this.runtime.getMessageSwipeId(messageId),
          // 正文里的标签本身不具备授权；只有脚本写入的确切面板文本与
          // 当前 swipe 元数据同时匹配，渲染入口才会把它当作正式面板。
          panelHash: fingerprintText(panel),
        },
      },
    }], { refresh: 'affected' });
  }
}

/**
 * internal.87 · 蓝图 §6 步 B：世界书镜像退役后的收尾适配器。
 *
 * 只保留一件事——**显式清理存量镜像**（驾驶员点按钮触发）：
 * - 把 `伊雍-蝴蝶效应锚定-*` 从全局世界书绑定里摘掉（这些书由旧版脚本自动挂载）；
 * - 删除这些书里 `extra.source === 'eyon_butterfly_anchor'` 的条目（脚本自建副本）；
 * - **不删除世界书文件本身**：空书留给玩家自行处理，避免物理删除用户数据。
 *
 * 迁移后蝴蝶史料源与正文可见性都不再经过世界书（见 runtime/butterflySources.ts
 * 与 runtime/canonMemoryChannel.ts），因此清理不会掉功能。
 */
export class TavernButterflyMirrorRetirement implements ArchiveAdapter {
  private readonly bindings: TavernDataBindings;

  constructor(bindings: TavernDataBindings) {
    this.bindings = bindings;
  }

  async retireLegacyMirrors(): Promise<MirrorRetirementResult> {
    const getNames = requireBinding(this.bindings.getWorldbookNames, 'getWorldbookNames');
    const allNames = getNames();
    const targets = allNames.filter(name => isButterflyMirrorWorldbook(name));
    const globals = this.bindings.getGlobalWorldbookNames()
      .filter(name => !isButterflyMirrorWorldbook(name));
    if (typeof this.bindings.rebindGlobalWorldbooks === 'function') {
      await this.bindings.rebindGlobalWorldbooks(globals);
    }
    let removedEntries = 0;
    if (this.bindings.deleteWorldbookEntries) {
      for (const name of targets) {
        try {
          const result = await this.bindings.deleteWorldbookEntries(
            name,
            entry => entry.extra?.source === 'eyon_butterfly_anchor',
          );
          removedEntries += result.deleted_entries.length;
        } catch (error) {
          console.warn(
            `[Eyon History Workbench] mirror cleanup failed for ${name}`,
            error,
          );
        }
      }
    }
    console.info(
      '[Eyon History Workbench] butterfly mirror retired: '
      + `worldbooks=${targets.length} removedEntries=${removedEntries} `
      + `globalsLeft=${globals.length}`,
    );
    return { worldbooks: targets, removedEntries, globals };
  }
}

export class SerializedTavernUserTurnAdapter implements UserTurnAdapter {
  private tail: Promise<void> = Promise.resolve();
  private readonly runtime: TavernRuntime;
  private readonly bindings: TavernDataBindings;
  private readonly onUserFloorCreated?: (
    text: string,
    messageId: number,
  ) => void | Promise<void>;

  constructor(
    runtime: TavernRuntime,
    bindings: TavernDataBindings,
    hooks: {
      onUserFloorCreated?(
        text: string,
        messageId: number,
      ): void | Promise<void>;
    } = {},
  ) {
    this.runtime = runtime;
    this.bindings = bindings;
    this.onUserFloorCreated = hooks.onUserFloorCreated;
  }

  async sendUserTurn(
    text: string,
    options?: {
      signal?: AbortSignal;
      beforeCreate?(expectedMessageId: number): Promise<void>;
      afterCreate?(messageId: number): Promise<void>;
    },
  ): Promise<{ messageId: number }> {
    const run = this.tail.then(() => this.submit(text, options));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async submit(
    text: string,
    options?: {
      signal?: AbortSignal;
      beforeCreate?(expectedMessageId: number): Promise<void>;
      afterCreate?(messageId: number): Promise<void>;
    },
  ): Promise<{ messageId: number }> {
    const normalized = text.trim();
    if (!normalized) throw new Error('不能发送空的墟境进入指令');
    throwIfAborted(options?.signal);
    const expectedMessageId = this.runtime.getLastMessageId() + 1;
    await options?.beforeCreate?.(expectedMessageId);
    throwIfAborted(options?.signal);
    await this.bindings.createUserMessage(normalized);
    throwIfAborted(options?.signal);
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
    if (messageId !== expectedMessageId) {
      throw new Error('玩家楼编号在提交期间发生变化，已停止触发正文');
    }
    // 酒馆输入框必须在触发正常回复前释放。若等 /trigger 完成后才清空，
    // 宿主会把仍占据输入框的旧文本视为待发送内容，导致下一楼不生成或残留原文。
    // 此时唯一玩家楼已经核验成立；即使后续元数据确认失败，也不能恢复旧文本造成重复建楼。
    await this.onUserFloorCreated?.(normalized, messageId);
    await options?.afterCreate?.(messageId);
    throwIfAborted(options?.signal);
    await this.bindings.triggerReply();
    return { messageId };
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error('user turn was cancelled');
}

function boundWorldbookBindings(
  bindings: TavernDataBindings,
): Array<{ name: string; scopes: WorldbookBindingScope[] }> {
  const character = bindings.getCharWorldbookNames();
  const result = new Map<string, WorldbookBindingScope[]>();
  const add = (name: string | null, scope: WorldbookBindingScope) => {
    if (!name?.trim()) return;
    const scopes = result.get(name) ?? [];
    if (!scopes.includes(scope)) scopes.push(scope);
    result.set(name, scopes);
  };
  add(character.primary, 'character-primary');
  for (const name of character.additional) add(name, 'character-additional');
  add(bindings.getChatWorldbookName(), 'chat');
  for (const name of bindings.getGlobalWorldbookNames()) add(name, 'global');
  return [...result].map(([name, scopes]) => ({ name, scopes }));
}

function characterWorldbookNames(bindings: TavernDataBindings): string[] {
  const character = bindings.getCharWorldbookNames();
  return [...new Set([
    character.primary,
    ...character.additional,
  ].filter((name): name is string => Boolean(name?.trim())))];
}

function worldbookEntryKey(worldbookName: string, uid: number): string {
  return `${encodeURIComponent(worldbookName)}:${uid}`;
}

function normalizeWorldbookKey(key: string | RegExp): string {
  return String(key);
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

export function readRuinTasks(stat: Variables): RuinTaskSnapshot[] {
  const tasks = recordAt(stat, ['任务列表']);
  return Object.entries(tasks).flatMap(([name, value]) => {
    if (!/^\[墟境任务[·・](个人|团队)\]/u.test(name) || !isRecord(value)) return [];
    const mode = name.match(/^\[墟境任务[·・](个人|团队)\]/u)?.[1] === '团队'
      ? '团队' as const
      : '个人' as const;
    const status = textAt(value, ['状态']);
    return [{
      name,
      mode,
      status,
      attention: textAt(value, ['关注度']),
      progress: textAt(value, ['进展']),
      detail: textAt(value, ['详情']),
      objective: textAt(value, ['目标']),
      reward: textAt(value, ['奖励']),
      terminal: isTerminalRuinTaskStatus(status),
    }];
  });
}

export function isTerminalRuinTaskStatus(statusValue: string): boolean {
  const status = statusValue.replace(/\s+/gu, '');
  if (!status || /未完成|进行中|执行中|未结算/u.test(status)) return false;
  return /^(?:已完成|完成|失败|已失败|已取消|取消|放弃|终止|已终止|已结算|可结算)$/u.test(status);
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

/** 旧版脚本自动挂载的蝴蝶镜像世界书前缀（internal.87 起只用于清理识别）。 */
const BUTTERFLY_MIRROR_PREFIX = '伊雍-蝴蝶效应锚定-';

function isButterflyMirrorWorldbook(name: string): boolean {
  return name.trim().startsWith(BUTTERFLY_MIRROR_PREFIX);
}

function requireBinding<T extends (...args: never[]) => unknown>(
  value: T | undefined,
  name: string,
): T {
  if (!value) throw new Error(`${name} is unavailable`);
  return value;
}

const BUTTERFLY_PANEL_RE = /<butterfly_panel>[\s\S]*?<\/butterfly_panel>/gu;
const MVU_PANEL_ANCHOR = '<UpdateVariable>';

/**
 * internal.81 v20：把蝴蝶面板放进遣返正文楼（与穿越 RuinTrace 同款楼层契约）：
 * 1. 先剥离本楼已有的蝴蝶面板（迁移/重试场景，去掉历史尾置位置）；
 * 2. 插到正文之后、MVU 变量面板（<UpdateVariable>）之前——MVU 面板固定最尾；
 * 3. 楼里没有 MVU 面板时才文末追加（不丢面板）。
 */
function insertButterflyPanelText(message: string, panel: string): string {
  const stripped = message
    .replace(BUTTERFLY_PANEL_RE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd();
  const mvupIndex = stripped.indexOf(MVU_PANEL_ANCHOR);
  if (mvupIndex >= 0) {
    const head = stripped.slice(0, mvupIndex).trimEnd();
    const tail = stripped.slice(mvupIndex);
    return `${head}\n\n${panel.trim()}\n${tail}`;
  }
  return `${stripped}\n\n${panel.trim()}`;
}
