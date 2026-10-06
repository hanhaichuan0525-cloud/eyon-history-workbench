import type { WorkbenchNamespace } from '../core/namespace.ts';
import type {
  ButterflyFreezeSnapshot,
  ButterflyHostAdapter,
} from '../adapters/host.ts';
import {
  ButterflyRequestSchema,
  type ButterflyRequest,
  type ButterflyScope,
} from '../schemas/butterfly.ts';
import {
  loadRuntimeWorldbookCorpus,
  type RuntimeChatMessage,
  type RuntimeContextSourceProvider,
  type TavernRuntime,
} from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';
import type { RetrievalShadowCapture } from '../retrieval/runtimeShadow.ts';
import type { ContextSource } from '../core/context.ts';
import { resolveActiveRetrieval } from './activeRetrieval.ts';
import { isPureUpdateProtocol } from '../retrieval/sourcePurpose.ts';
import type { ActiveEvidenceView } from '../prompts/activeEvidence.ts';
import {
  buildActiveEvidenceView,
  requestedEraFromText,
} from '../prompts/activeEvidence.ts';
import {
  canonicalTaskSourceId,
  projectTaskCitationRegistrySources,
} from '../retrieval/citations.ts';
import {
  buildEntityLinkingIndex,
  type EntityLinkCandidate,
} from '../retrieval/entityLinking.ts';
import type { CanonRepository } from '../storage/canon.ts';
import { artifactCanonBoundView } from '../core/artifactCanonBinding.ts';
import type {
  ArtifactCanonBoundView,
  CanonBranch,
  CanonResolutionBranch,
} from '../retrieval/contracts.ts';
import { resolveCanon } from '../retrieval/canonResolver.ts';
import { buildButterflySourceScope } from './butterflySources.ts';
import type { ButterflyReferences } from '../core/creativeReferences.ts';

// 仅用于识别旧版裁剪策略的 pending；新版选择完整楼/来源，不裁掉契约确认。
// API prompt 对重复来源去重投递，控制体量而不切正文。
export const BUTTERFLY_FREEZE_SOURCE_LIMIT = 1500;
const RUIN_ENTRY_REQUEST_KEY = 'eyonHistoryRuinEntryRequest';

/**
 * 结算替换要读取“当前分支仍有效的既成状态”，不能只依赖本次任务检索命中的窄视图。
 * 这里只返回脚本内部归并所需的稳定主键，不进入提示词；解析异常时留空并沿用原流程。
 */
export function currentBranchActiveStateFacts(
  branch: CanonBranch,
): NonNullable<ActiveEvidenceView['activeCanonStateFacts']> {
  try {
    const resolutionBranch: CanonResolutionBranch = {
      ...structuredClone(branch),
      // 这里仅解析 revision > 0 的干涉状态身份；世界书基线仍由任务自己的
      // ActiveEvidence/personCanonViews 提供。去掉对本次窄检索 Bundle 的依赖，
      // 避免同一 Canon 分支因检索命中不同而漏掉既有干涉状态。
      baseCanon: {
        facts: [],
        eventRelations: [],
        personViews: [],
        passages: [],
        sourceSnapshots: [],
      },
    };
    return resolveCanon(
      resolutionBranch,
      branch.headRevision,
      buildButterflySourceScope(branch),
    ).activeFacts
      .filter(fact => fact.revisionIntroduced > 0)
      .map(fact => ({
        factId: fact.factId,
        subjectEntityId: fact.subjectEntityId,
        predicate: fact.predicate,
        ...(fact.continuousState ? { continuousState: fact.continuousState,
          epistemicStatus: fact.epistemicStatus, confidence: fact.confidence } : {}),
      }));
  } catch {
    return [];
  }
}

export class TavernButterflyContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;
  private readonly host: ButterflyHostAdapter;
  private readonly retrievalShadow?: RetrievalShadowCapture;
  /** 年龄基准时间 ensure（按聊天开局锁定）；未提供则 null。 */
  private readonly ensureBaselineTime?: (
    namespace: WorkbenchNamespace,
    currentWorldTime: string,
  ) => string;
  private readonly canonRepository?: CanonRepository;

  constructor(
    runtime: TavernRuntime,
    sources: RuntimeContextSourceProvider,
    host: ButterflyHostAdapter,
    retrievalShadow?: RetrievalShadowCapture,
    ensureBaselineTime?: (
      namespace: WorkbenchNamespace,
      currentWorldTime: string,
    ) => string,
    canonRepository?: CanonRepository,
  ) {
    this.runtime = runtime;
    this.sources = sources;
    this.host = host;
    this.retrievalShadow = retrievalShadow;
    this.ensureBaselineTime = ensureBaselineTime;
    this.canonRepository = canonRepository;
  }

  currentRun(sourceMessageId?: number): Promise<ButterflyFreezeSnapshot> {
    return this.host.getButterflyFreezeSnapshot(sourceMessageId);
  }

  async freeze(input: {
    creativeReferences?: ButterflyReferences;
    requestId: string;
    namespace: WorkbenchNamespace;
    userMessageId: number;
    rawCommand: string;
    triggerType: 'button' | 'text';
    roll: number;
    sourceMessageId?: number;
  }): Promise<{
    request: ButterflyRequest;
    sourceHash: string;
    activeEvidence?: ActiveEvidenceView;
    canonBindingView?: ArtifactCanonBoundView;
    canonBindingAppliedDeltaIds?: string[];
    /**
     * internal.82（F-01）：冻结检索 Bundle 抽取的稳定实体名 → entityId 索引，
     * 随 pending 保存，供结算提交前归并模型 carrier（见 retrieval/entityLinking.ts）。
     */
    linkingIndex?: EntityLinkCandidate[];
  }> {
    const snapshot = await this.host.getButterflyFreezeSnapshot(
      input.sourceMessageId,
    );
    const messages = this.runMessages(input.userMessageId, snapshot);
    const entrySource = messages.find(isRuinEntryMessage)
      ?? (messages[0]?.role === 'assistant' ? messages[0] : undefined);
    const chatSources = messages.map(message => ({
      sourceId: `chat:${message.message_id}`,
      title: `${message.role} floor ${message.message_id}`,
      content: message.message.trim(),
    }));
    // 按钮在建玩家楼之前冻结：输入框原文就是预定的最后一楼，
    // 必须先参与空行动检查与检索，不能仅在 request.trigger 里回显。
    if (!chatSources.some(source => source.sourceId === `chat:${input.userMessageId}`)) {
      chatSources.push({ sourceId: `chat:${input.userMessageId}`,
        title: `user floor ${input.userMessageId}`, content: input.rawCommand });
    }
    const interventions = chatSources.filter(source =>
      source.sourceId !== (entrySource ? `chat:${entrySource.message_id}` : '')
      && !/^(?:请)?(?:进入节点|遣返|返回现世|回到现实|结算蝴蝶效应)[吧。！!\s]*$/u.test(source.content)
    );
    // 按可见楼顺序保留完整事实，不能先放玩家、后放AI再取尾部而挤掉玩家。
    const playerInterventions = [...interventions];
    if (playerInterventions.length === 0) {
      throw new Error('本轮没有可追溯的玩家干涉正文，已拒绝建立空结算');
    }
    if (!playerInterventions.some(source => source.sourceId === `chat:${input.userMessageId}`)) {
      playerInterventions.push({ sourceId: `chat:${input.userMessageId}`,
        title: `user floor ${input.userMessageId}`, content: input.rawCommand });
    }
    const [
      worldbookCorpus,
      characters,
      genealogies,
      biographies,
      butterflies,
    ] = await Promise.all([
      loadRuntimeWorldbookCorpus(this.sources),
      this.sources.getCharacterSources(),
      this.sources.getGenealogySources(),
      this.sources.getBiographySources(),
      this.sources.getButterflySources(),
    ]);
    // 消费端用途路由，不改宿主世界书/完整语料回执，也不裁任何正文。
    const worldbooks = worldbookCorpus.sources.filter(source => !isPureUpdateProtocol(source));
    const relevantWorldbook = trimSources(worldbooks, 18);
    const involvedEntities = trimSources(characters, 12);
    const relevantGenealogy = trimSources(genealogies, 8);
    const relevantBiographies = trimSources(biographies, 8);
    const previousButterflyAnchors = trimSources(butterflies, 8);
    const relevantChatFacts = [...chatSources];
    const currentRealityContext = [{
      sourceId: `frozen-reality:${snapshot.runId}`,
      title: 'frozen reality anchor',
      content: `${snapshot.reality.time}\n${snapshot.reality.location}`,
    }];
    const sourceIndex = dedupeSources([
      ...playerInterventions,
      ...involvedEntities,
      ...currentRealityContext,
      ...relevantWorldbook,
      ...relevantChatFacts,
      ...relevantGenealogy,
      ...relevantBiographies,
      ...previousButterflyAnchors,
    ]);
    const legacyRequest = ButterflyRequestSchema.parse({
      schema: 'eyon.butterfly.request.v1',
      requestId: input.requestId,
      characterKey: input.namespace.characterKey,
      chatId: input.namespace.chatId,
      runId: snapshot.runId,
      trigger: {
        type: input.triggerType,
        userMessageId: input.userMessageId,
        returnAssistantMessageId: 0,
        rawCommand: input.rawCommand,
      },
      anchors: {
        reality: snapshot.reality,
        ruinEntry: snapshot.ruinEntry,
        ruinExit: snapshot.ruinExit,
      },
      dice: {
        roll: input.roll,
        scope: scopeForRoll(input.roll),
      },
      ...(input.creativeReferences ? { creativeReferences: input.creativeReferences } : {}),
      ruinHistory: historyFromEntry(entrySource, snapshot),
      playerInterventions,
      involvedEntities,
      currentRealityContext,
      relevantWorldbook,
      relevantChatFacts,
      relevantGenealogy,
      relevantBiographies,
      previousButterflyAnchors,
      sourceIndex,
    });
    const contextCandidates = [
      ...toContextSources(worldbooks, 'worldbook', 100),
      ...toContextSources(characters, 'mvu', 95),
      ...toContextSources(chatSources, 'chat', 80),
      ...toContextSources(genealogies, 'genealogy', 75),
      ...toContextSources(biographies, 'biography', 70),
      ...toContextSources(butterflies, 'butterfly', 70),
      ...toContextSources(currentRealityContext, 'mvu', 100),
    ];
    const canonBranch = await this.canonRepository?.getBranch(input.namespace);
    const actionQuery = [
        input.rawCommand,
        legacyRequest.ruinHistory.title,
        legacyRequest.ruinHistory.era,
        legacyRequest.ruinHistory.originalTrajectory,
        legacyRequest.ruinHistory.historicalBackground,
        legacyRequest.ruinHistory.enteredAnomaly,
        ...legacyRequest.ruinHistory.locationChain,
        entrySource?.message ?? '',
        ...legacyRequest.playerInterventions.flatMap(source => [source.title, source.content]),
      ].join('\n');
    const active = await resolveActiveRetrieval({
      retrieval: this.retrievalShadow,
      requestId: input.requestId,
      taskType: 'butterfly',
      query: [actionQuery, ...(input.creativeReferences ? [
        input.creativeReferences.focus.trim(),
        input.creativeReferences.domain === '顺势生长' ? '' : input.creativeReferences.domain,
      ] : [])].filter(Boolean).join('\n'),
      // 关注栏是资料/未来传播的观察重心，不是已发生的行动或必到场演员。
      castRequirementQuery: actionQuery,
      contextQuery: [
        ...legacyRequest.involvedEntities.flatMap(source => [source.title, source.content]),
        ...legacyRequest.currentRealityContext.flatMap(source => [source.title, source.content]),
      ].join('\n'),
      runtimeCandidates: [
        ...worldbooks.map(source => ({ ...source, sourceType: 'worldbook' as const })),
        ...characters.map(source => ({ ...source, sourceType: 'mvu' as const })),
        ...chatSources.map(source => ({ ...source, sourceType: 'chat' as const })),
        ...genealogies.map(source => ({ ...source, sourceType: 'genealogy' as const })),
        ...biographies.map(source => ({ ...source, sourceType: 'biography' as const })),
        ...butterflies.map(source => ({ ...source, sourceType: 'butterfly' as const })),
        ...currentRealityContext.map(source => ({ ...source, sourceType: 'mvu' as const })),
      ],
      contextCandidates,
      legacySourceIds: legacyRequest.sourceIndex.map(source => source.sourceId),
      worldbookCorpusReceipt: worldbookCorpus.receipt,
      baselineWorldTime: this.ensureBaselineTime?.(input.namespace, snapshot.reality.time) ?? null,
      canonBranch,
    });
    const selected = active.sourceIndex.map(toButterflySource);
    const selectedByType = (sourceType: ContextSource['sourceType']) =>
      active.sourceIndex.filter(source => source.sourceType === sourceType)
        .map(toButterflySource);
    // 玩家实际行动和冻结现实是任务输入锚，不属于旧检索；即使证据预算未再次
    // 选中，也必须原样保留。其余知识来源只消费 Active EvidencePassage。
    const fixedAnchors = dedupeSources([
      ...chatSources,
      ...playerInterventions,
      ...currentRealityContext,
    ]);
    const request = ButterflyRequestSchema.parse({
      ...legacyRequest,
      playerInterventions,
      involvedEntities: selectedByType('mvu')
        .filter(source => !source.sourceId.startsWith('frozen-reality:')),
      currentRealityContext,
      relevantWorldbook: selectedByType('worldbook'),
      relevantChatFacts: dedupeSources([
        ...playerInterventions,
        ...selectedByType('chat'),
      ]),
      relevantGenealogy: selectedByType('genealogy'),
      relevantBiographies: selectedByType('biography'),
      previousButterflyAnchors: selectedByType('butterfly'),
      sourceIndex: dedupeSources([...fixedAnchors, ...selected]),
    });
    const activeEvidence = buildActiveEvidenceView(
      active.bundle,
      requestedEraFromText(
        `${legacyRequest.ruinHistory.era}\n${legacyRequest.anchors.ruinEntry.time}`,
      ),
    );
    if (canonBranch) {
      const branchStateFacts = currentBranchActiveStateFacts(canonBranch);
      if (branchStateFacts.length > 0) {
        activeEvidence.activeCanonStateFacts = [
          ...new Map([
            ...(activeEvidence.activeCanonStateFacts ?? []),
            ...branchStateFacts,
          ].map(fact => [fact.factId, fact])).values(),
        ];
      }
    }
    const allowedSourceIds = new Set(
      request.sourceIndex.map(source => canonicalTaskSourceId(source.sourceId)),
    );
    activeEvidence.passages = activeEvidence.passages.filter(passage =>
      allowedSourceIds.has(canonicalTaskSourceId(passage.sourceId))
    );
    if (activeEvidence.citationRegistry) {
      activeEvidence.citationRegistry = projectTaskCitationRegistrySources(
        activeEvidence.citationRegistry,
        request.sourceIndex.map(source => source.sourceId),
      );
    }
    // internal.82（F-01）：从冻结检索的角色编排与人物视图构建稳定实体映射索引。
    // 有界（≤200 候选）；检索未命中实体时为 undefined（结算走 generated 兜底）。
    const linkingIndex = buildEntityLinkingIndex([
      ...(active.bundle.castManifest?.entries ?? []).map(entry => ({
        entityId: entry.entityId,
        names: [
          entry.identity.canonicalName,
          ...(entry.identity.aliases ?? []),
        ],
      })),
      ...(active.bundle.personCanonViews ?? []).map(view => ({
        entityId: view.entityId,
        names: [view.canonicalName, ...(view.aliases ?? [])],
      })),
    ]);
    return {
      request,
      sourceHash: fingerprintText(JSON.stringify({
        request,
        canonViewId: active.bundle.canonResolvedView?.viewId ?? null,
      })),
      activeEvidence,
      ...(active.bundle.canonResolvedView
        ? {
          canonBindingView: artifactCanonBoundView(active.bundle.canonResolvedView),
          canonBindingAppliedDeltaIds: [
            ...active.bundle.canonResolvedView.resolutionReceipt.appliedDeltaIds,
          ],
        }
        : {}),
      ...(linkingIndex.length > 0 ? { linkingIndex } : {}),
    };
  }

  attachReturnFloor(request: ButterflyRequest, assistantMessageId: number): ButterflyRequest {
    const assistant = this.runtime
      .getChatMessages(assistantMessageId, { include_swipes: false })
      .find(message => message.message_id === assistantMessageId);
    if (!assistant || assistant.role !== 'assistant' || assistant.is_hidden) {
      throw new Error('遣返正文楼不存在或已隐藏');
    }
    const source = {
      sourceId: `chat:${assistant.message_id}`,
      title: `assistant floor ${assistant.message_id}`,
      content: assistant.message.trim(),
    };
    return ButterflyRequestSchema.parse({
      ...request,
      trigger: {
        ...request.trigger,
        returnAssistantMessageId: assistantMessageId,
      },
      currentRealityContext: dedupeSources([
        ...request.currentRealityContext,
        source,
      ]),
      relevantChatFacts: dedupeSources([
        ...request.relevantChatFacts,
        source,
      ]),
      sourceIndex: dedupeSources([...request.sourceIndex, source]),
    });
  }

  private runMessages(userMessageId: number, snapshot: ButterflyFreezeSnapshot) {
    const messages = this.runtime
      .getChatMessages(`0-${userMessageId}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim());
    const recovered = this.host.getRuinRoundStartMessageId?.(snapshot, userMessageId);
    if (recovered !== undefined) {
      return messages.filter(message => message.message_id >= recovered);
    }
    let entranceCue = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'user'
        && /^(?:(?:请)?进入节点(?:[\s，,：:]|$)|我(?:踏入|进入)这处历史特异点[。！!\s]*$)/u.test(message.message.trim())) {
        entranceCue = index;
        break;
      }
    }
    // 同地点、同纪元反复进入时，旧 metadata 也可能匹配；新入场时刻优先，
    // 且不能跨过更新的玩家入场楼去借旧史案。
    const entryTime = compactAnchor(snapshot.ruinEntry.time);
    const textEntry = messages.findIndex((message, index) => index >= entranceCue
      && message.role === 'assistant' && entryTime
      && compactAnchor(message.message).includes(entryTime));
    if (textEntry >= 0) return messages.slice(textEntry);
    let entryIndex = -1;
    for (let index = messages.length - 1; index >= Math.max(0, entranceCue); index -= 1) {
      if (isRuinEntryMessage(messages[index])
        && entryMatchesSnapshot(messages[index], snapshot)) {
        entryIndex = index;
        break;
      }
    }
    if (entryIndex >= 0) return messages.slice(entryIndex);
    if (messages.some(isRuinEntryMessage)) {
      throw new Error('无法确定本轮墟境入场楼；已拒绝借用上一轮资料，请恢复本轮楼层变量后重试');
    }
    // 首轮/兼容适配器没有任何旧轮标记：保留全部可见楼，不设最近楼窗口。
    return messages;
  }
}

function toContextSources(
  sources: Array<{ sourceId: string; title: string; content: string }>,
  sourceType: ContextSource['sourceType'],
  authority: number,
): ContextSource[] {
  return trimSources(sources, sources.length).map(source => ({
    ...source,
    sourceType,
    authority,
  }));
}

function toButterflySource(source: ContextSource) {
  return {
    sourceId: source.sourceId,
    title: source.title,
    content: source.content,
  };
}

function scopeForRoll(roll: number): ButterflyScope {
  if (roll <= 20) return '个人';
  if (roll <= 35) return '双人';
  if (roll <= 50) return '小队';
  if (roll <= 65) return '聚落';
  if (roll <= 78) return '城市';
  if (roll <= 88) return '省份级地区';
  if (roll <= 96) return '国家';
  return '跨国';
}

function trimSources(
  sources: Array<{ sourceId: string; title: string; content: string }>,
  limit: number,
) {
  return sources
    .filter(source => source.sourceId.trim() && source.content.trim())
    .slice(-limit)
    .map(source => ({
      sourceId: source.sourceId.trim(),
      title: source.title.trim() || source.sourceId.trim(),
      content: source.content.trim(),
    }));
}

function dedupeSources<T extends { sourceId: string }>(sources: T[]): T[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    if (seen.has(source.sourceId)) return false;
    seen.add(source.sourceId);
    return true;
  });
}

function historyFromEntry(
  message: RuntimeChatMessage | undefined,
  snapshot: ButterflyFreezeSnapshot,
) {
  const stored = storedRuinHistory(message);
  const text = message?.message ?? '';
  const field = (label: string) => {
    const match = text.match(new RegExp(`${label}：([^\\n]+)`, 'u'));
    return match?.[1]?.trim() ?? '';
  };
  const traceField = (label: string) => {
    const match = text.match(new RegExp(`^${label}::[ \\t]*([^\\n]+)`, 'mu'));
    return match?.[1]?.trim() ?? '';
  };
  return {
    title: stored?.title || field('史案标题') || traceField('Title'),
    era: stored?.era || field('目标纪元') || traceField('Span') || traceField('Type')
      || requestedEraFromText(snapshot.ruinEntry.time) || '',
    originalTrajectory:
      stored?.originalTrajectory || field('节点局势') || traceField('History'),
    historicalBackground:
      stored?.historicalBackground || field('直接成因') || traceField('Shift'),
    enteredAnomaly:
      stored?.enteredAnomaly || field('历史节点') || field('特异点') || traceField('NodeTime'),
    locationChain: dedupeText([
      ...(stored?.locationChain ?? []),
      field('目标墟境地点'),
      snapshot.ruinEntry.location,
      snapshot.ruinExit.location,
    ]),
  };
}

function isRuinEntryMessage(message: RuntimeChatMessage): boolean {
  return storedRuinHistory(message) !== null
    || /\[RuinTrace\][\s\S]*?\[\/RuinTrace\]/u.test(message.message)
    || /^(?:请)?进入节点(?:[\s，,：:]|$)/u.test(message.message.trim());
}

function compactAnchor(value: string): string {
  return value.normalize('NFKC').replace(/星期[一二三四五六日天]/gu, '')
    .replace(/[\s\-年月日:：]/gu, '');
}

function entryMatchesSnapshot(message: RuntimeChatMessage, snapshot: ButterflyFreezeSnapshot): boolean {
  const history = storedRuinHistory(message);
  if (!history) {
    const time = compactAnchor(snapshot.ruinEntry.time);
    return !!time && compactAnchor(message.message).includes(time);
  }
  const era = requestedEraFromText(snapshot.ruinEntry.time);
  return (!history.era || !era || history.era.includes(era))
    && (!history.locationChain.length || history.locationChain.some(location =>
      snapshot.ruinEntry.location.includes(location) || location.includes(snapshot.ruinEntry.location)));
}

function storedRuinHistory(message: RuntimeChatMessage | undefined) {
  if (!message) return null;
  const dataExtra = isRecord(message.data?.extra) ? message.data.extra : undefined;
  const metadata = [message.extra, dataExtra]
    .map(extra => extra?.[RUIN_ENTRY_REQUEST_KEY])
    .find(isRecord);
  const history = isRecord(metadata?.ruinHistory) ? metadata.ruinHistory : null;
  if (!history) return null;
  const stringField = (key: string) =>
    typeof history[key] === 'string' ? history[key].trim() : '';
  return {
    title: stringField('title'),
    era: stringField('era'),
    originalTrajectory: stringField('originalTrajectory'),
    historicalBackground: stringField('historicalBackground'),
    enteredAnomaly: stringField('enteredAnomaly'),
    locationChain: Array.isArray(history.locationChain)
      ? history.locationChain.filter((item): item is string => typeof item === 'string')
        .map(item => item.trim()).filter(Boolean)
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupeText(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
