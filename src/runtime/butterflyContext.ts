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

const RECENT_LIMIT = 36;
// 全源内容上限（internal.81 v15 瘦身）：6000 → 1500。
// 真机病历：蝴蝶请求体量 72,248 字符（线上约 216KB）——request JSON 集齐
// 12 条干预全文×6000 + chat/worldbook/genealogy/biography 等全部 6KB 上限源后
// 单次请求逼近 60s 超时线 → 反复重试 → 4 分钟级卡死（别模块 prompt 小所以快）。
// 统一降到 1500：request JSON 约 72KB → ~18KB（-70%），单请求回到 15-30s 区间。
// 导出供 ButterflyController 对历史遗留冻结快照做版本体检（internal.81 v16）：
// 旧上限（6000）时代存下的 pending 若被直接复用，瘦身永不生效。
export const BUTTERFLY_FREEZE_SOURCE_LIMIT = 1500;
const CONTENT_LIMIT = BUTTERFLY_FREEZE_SOURCE_LIMIT;
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

  async freeze(input: {
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
    const messages = this.runMessages(input.userMessageId);
    const entrySource = messages.find(isRuinEntryMessage);
    const chatSources = messages.map(message => ({
      sourceId: `chat:${message.message_id}`,
      title: `${message.role} floor ${message.message_id}`,
      content: message.message.trim().slice(0, CONTENT_LIMIT),
    }));
    const interventions = chatSources.filter(source =>
      source.sourceId !== (entrySource ? `chat:${entrySource.message_id}` : '')
      && !/^(?:请)?(?:进入节点|遣返|返回现世|回到现实|结算蝴蝶效应)/u.test(source.content)
    );
    const playerInterventions = (
      interventions.filter(source => source.title.startsWith('user '))
        .concat(interventions.filter(source => source.title.startsWith('assistant ')))
        .slice(-12)
    );
    if (playerInterventions.length === 0) {
      throw new Error('本轮没有可追溯的玩家干涉正文，已拒绝建立空结算');
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
    const worldbooks = worldbookCorpus.sources;
    const relevantWorldbook = trimSources(worldbooks, 18);
    const involvedEntities = trimSources(characters, 12);
    const relevantGenealogy = trimSources(genealogies, 8);
    const relevantBiographies = trimSources(biographies, 8);
    const previousButterflyAnchors = trimSources(butterflies, 8);
    const relevantChatFacts = trimSources(chatSources, 24);
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
    const active = await resolveActiveRetrieval({
      retrieval: this.retrievalShadow,
      requestId: input.requestId,
      taskType: 'butterfly',
      query: [
        input.rawCommand,
        legacyRequest.ruinHistory.title,
        legacyRequest.ruinHistory.era,
        legacyRequest.ruinHistory.originalTrajectory,
        legacyRequest.ruinHistory.historicalBackground,
        legacyRequest.ruinHistory.enteredAnomaly,
        ...legacyRequest.ruinHistory.locationChain,
        ...legacyRequest.playerInterventions.flatMap(source => [source.title, source.content]),
      ].join('\n'),
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
      content: assistant.message.trim().slice(0, CONTENT_LIMIT),
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

  private runMessages(userMessageId: number) {
    const messages = this.runtime
      .getChatMessages(`0-${userMessageId}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim());
    let entryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isRuinEntryMessage(messages[index])) {
        entryIndex = index;
        break;
      }
    }
    if (entryIndex < 0) return messages.slice(-RECENT_LIMIT);
    const run = messages.slice(entryIndex);
    if (run.length <= RECENT_LIMIT) return run;
    // A long ruin run may exceed the ordinary recent-chat window. Preserve the
    // authoritative entry floor for its structured history, then keep only the
    // most recent intervention floors for retrieval and settlement.
    return [run[0], ...run.slice(-(RECENT_LIMIT - 1))];
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
      content: source.content.trim().slice(0, CONTENT_LIMIT),
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
    era: stored?.era || field('目标纪元') || traceField('Span') || traceField('Type'),
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
