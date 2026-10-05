import type {
  ContextSource,
  RuinContextAssembler,
  RuinContextBundle,
} from '../core/context.ts';
import {
  loadRuntimeWorldbookCorpus,
  type RuntimeContextSourceProvider,
  type TavernRuntime,
} from './contracts.ts';
import { selectRelevantContextSources } from './sourceSelection.ts';
import { digestBiographySource, biographyFullReference } from './biographyContext.ts';
import type {
  RetrievalShadowCapture,
} from '../retrieval/runtimeShadow.ts';
import type { CanonBranch, CanonResolvedView, EvidenceBundle } from '../retrieval/contracts.ts';
import { resolveActiveRetrieval } from './activeRetrieval.ts';
import type { CanonRepository } from '../storage/canon.ts';
import {
  buildCurrentSceneSnapshot,
  type CurrentSceneSnapshot,
} from '../core/currentSceneReference.ts';
import type { BiographyRepository } from '../storage/biographies.ts';
import { buildContinuityViewSafely } from './continuityAnchors.ts';
import type { ContinuityView } from '../core/continuityAnchors.ts';
import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import { applyRuinActorPolicy, scopeRuinGenealogy } from './ruinActorPolicy.ts';

const RECENT_MESSAGE_LIMIT = 8;
const CURRENT_SCENE_MESSAGE_LIMIT = 12;

export class TavernRuinContextAssembler implements RuinContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;
  private readonly selectedBiographyIds: () => Promise<ReadonlySet<string>>;
  private readonly retrievalShadow?: RetrievalShadowCapture;
  /** 年龄基准时间 ensure（按聊天开局锁定）；未提供则 null。 */
  private readonly ensureBaselineTime?: (
    namespace: WorkbenchNamespace,
    currentWorldTime: string,
  ) => string;
  private readonly canonRepository?: CanonRepository;
  private readonly biographyRepository?: BiographyRepository;

  constructor(
    runtime: TavernRuntime,
    sources: RuntimeContextSourceProvider,
    selectedBiographyIds: () => Promise<ReadonlySet<string>> = async () => new Set(),
    retrievalShadow?: RetrievalShadowCapture,
    ensureBaselineTime?: (
      namespace: WorkbenchNamespace,
      currentWorldTime: string,
    ) => string,
    canonRepository?: CanonRepository,
    biographyRepository?: BiographyRepository,
  ) {
    this.runtime = runtime;
    this.sources = sources;
    this.selectedBiographyIds = selectedBiographyIds;
    this.retrievalShadow = retrievalShadow;
    this.ensureBaselineTime = ensureBaselineTime;
    this.canonRepository = canonRepository;
    this.biographyRepository = biographyRepository;
  }

  async assemble(input: {
    requestId: string;
    namespace: { characterKey: string; chatId: string };
    triggerMessageId: number;
    directive: string;
    territorialReferences?: string[];
    focusCharacterNames?: string[];
    castRequirementQuery?: string;
    eraAnchor?: string;
    customEra?: boolean;
    actorSelection?: Pick<RuinGenerationInput, 'autoGenealogy' | 'location' | 'selectedCharacters' | 'supplementaryDirection'>;
  }): Promise<RuinContextBundle> {
    const [
      currentWorld,
      worldbookCorpus,
      characters,
      allGenealogies,
      biographies,
      butterflies,
    ] = await Promise.all([
      this.sources.getCurrentWorld(),
      loadRuntimeWorldbookCorpus(this.sources),
      this.sources.getCharacterSources(),
      this.sources.getGenealogySources(),
      this.sources.getBiographySources(),
      this.sources.getButterflySources(),
    ]);
    const worldbook = worldbookCorpus.sources;
    const scopedGenealogy = input.actorSelection
      ? scopeRuinGenealogy(allGenealogies, input.actorSelection)
      : null;
    if (scopedGenealogy?.policy.unresolvedRelatives.length) {
      throw new Error(`无法唯一确认亲属：${scopedGenealogy.policy.unresolvedRelatives.join('、')}。请在补充方向填写姓名，或明确选择谱系人物。`);
    }
    const genealogies = scopedGenealogy?.sources ?? allGenealogies;
    const actorNames = scopedGenealogy?.policy.requestedSubjects ?? [];
    const retrievalDirective = [input.directive, ...actorNames].join('\n');
    const eraAnchor = input.eraAnchor?.normalize('NFKC').trim() ?? '';
    const exactEraSources = eraAnchor
      ? worldbook.filter(source => worldbookSourceMentionsExactEra(source, eraAnchor))
      : [];
    if (input.customEra && exactEraSources.length === 0) {
      throw new Error(
        `自定义纪年“${eraAnchor || '未填写'}”未在当前角色卡的完整世界书中精确命中。`
        + '请确认名称与世界书条目完全一致，且该条目已启用。',
      );
    }
    const recentWindow = this.buildRecentSources(
      input.triggerMessageId,
      CURRENT_SCENE_MESSAGE_LIMIT,
    );
    const recent = recentWindow.slice(-RECENT_MESSAGE_LIMIT);
    const currentSceneSnapshot = buildCurrentSceneSnapshot(
      input.directive,
      currentWorld.location,
      recentWindow,
    );
    const recentCandidates = mapSources(
      recent,
      'chat',
      80,
    );
    const retrievalQuery = [
      retrievalDirective,
      currentWorld.time,
      currentWorld.location,
      ...recent.slice(-8).flatMap(item => [item.title, item.content]),
    ].join('\n');
    const worldbookCandidates = mapSources(worldbook, 'worldbook', 100);
    const characterCandidates = mapSources(characters, 'mvu', 95);
    const genealogyCandidates = mapSources(genealogies, 'genealogy', 75);
    const allowedBiographyIds = await this.selectedBiographyIds();
    // 玩家显式引用的传记先给连续性摘要，再给全文。摘要把阶段、事件与物件状态
    // 放在高注意力位置；全文保留可解释空间。两者仍是同一来源，不新增第二真源。
    const biographyCandidates = mapSources(
      biographies.map(biography => ({
        ...biography,
        content: allowedBiographyIds.has(
          biography.sourceId.replace(/^biography:/u, ''),
        )
          ? [
            '【引用传记连续性摘要】',
            digestBiographySource(biography.content),
            '【引用传记原文】',
            biographyFullReference(biography.content),
          ].join('\n\n')
          : digestBiographySource(biography.content),
      })),
      'biography',
      70,
    );
    const butterflyCandidates = mapSources(butterflies, 'butterfly', 70);
    const legacyWorldbookContext = selectRelevantContextSources(
      worldbookCandidates, retrievalQuery,
      { limit: 18, fallbackCount: 5 },
    );
    const legacyCharacterContext = selectRelevantContextSources(
      characterCandidates, retrievalQuery,
      { limit: 12, fallbackCount: 2 },
    );
    const legacyGenealogyRefs = selectRelevantContextSources(
      genealogyCandidates, retrievalQuery,
      { limit: 8, fallbackCount: 0 },
    );
    // 引用传记 legacy 观察路径（正式注入由 forced 通道 + 全文/摘要候选承担）。
    const legacyBiographyRefs = biographyCandidates.filter(source =>
      allowedBiographyIds.has(source.sourceId.replace(/^biography:/u, '')));
    const legacyButterflyRefs = selectRelevantContextSources(
      butterflyCandidates, retrievalQuery,
      { limit: 6, fallbackCount: 0 },
    );
    const legacySourceIndex = [
      ...legacyWorldbookContext,
      ...legacyCharacterContext,
      ...recentCandidates,
      ...legacyGenealogyRefs,
      ...legacyBiographyRefs,
      ...legacyButterflyRefs,
    ];
    const canonBranch = await this.canonRepository?.getBranch(input.namespace);
    const active = await resolveActiveRetrieval({
      retrieval: this.retrievalShadow,
      requestId: input.requestId,
      taskType: 'ruin',
      query: retrievalDirective,
      contextQuery: [
        currentWorld.time,
        currentWorld.location,
        ...recent.slice(-8).flatMap(item => [item.title, item.content]),
      ].join('\n'),
      runtimeCandidates: [
        ...worldbook.map(source => ({ ...source, sourceType: 'worldbook' as const })),
        ...characterCandidates,
        ...recentCandidates,
        ...genealogyCandidates,
        ...biographyCandidates,
        ...butterflyCandidates,
      ],
      contextCandidates: [
        ...worldbookCandidates,
        ...characterCandidates,
        ...recentCandidates,
        ...genealogyCandidates,
        ...biographyCandidates,
        ...butterflyCandidates,
      ],
      legacySourceIds: legacySourceIndex.map(source => source.sourceId),
      worldbookCorpusReceipt: worldbookCorpus.receipt,
      territorialReferences: input.territorialReferences,
      focusEntityNames: input.focusCharacterNames,
      castRequirementQuery: [input.castRequirementQuery ?? '', ...actorNames].join('\n'),
      baselineWorldTime: this.ensureBaselineTime?.(input.namespace, currentWorld.time) ?? null,
      // 工作台「引用传记」：显式选中的传记即使检索未命中也强制入选
      // （与全世界书/正文同池同门，sourceType/句柄/分组不变；时间资格门仍生效）。
      forcedSourceLogicalIds: [
        ...[...allowedBiographyIds].map(key => `biography:${key}`),
        // 普通纪元名不是“强制参考全体当代条目”的按钮，否则挤掉真正相关的人物。
        ...(input.customEra ? exactEraSources.map(source => source.worldbook.logicalId) : []),
      ],
      canonBranch,
    });
    if (scopedGenealogy) {
      active.bundle.castManifest = applyRuinActorPolicy(active.bundle.castManifest, scopedGenealogy.policy, input.actorSelection!.supplementaryDirection);
      const dispositions = new Map(active.bundle.castManifest?.entries.map(entry => [entry.entityId, entry]));
      for (const passage of active.bundle.qualifiedEvidence?.passages ?? []) {
        passage.entityRoles = passage.entityRoles.map(role => {
          const entry = dispositions.get(role.entityId);
          return entry ? { ...role, disposition: entry.disposition, role: entry.role } : role;
        });
        if (passage.entityRoles.length && passage.entityRoles.every(role => role.role === 'context')) {
          passage.allowedUses = passage.allowedUses.filter(use => use !== 'actor');
        }
      }
    }
    const sourceIndex = active.sourceIndex;
    if (
      input.customEra
      && !sourceIndex.some(source => exactEraSources.some(match => match.sourceId === source.sourceId))
    ) {
      throw new Error(
        `自定义纪年“${eraAnchor}”的世界书条目未能进入本次检索证据，已中止生成，避免使用错误纪年。`,
      );
    }
    const continuityView = await this.continuityView(
      input.namespace,
      canonBranch,
      active.bundle.canonResolvedView,
      retrievalQuery,
      input.directive,
      currentWorld.time,
      currentWorld.location,
    );
    const worldbookContext = sourceIndex.filter(source => source.sourceType === 'worldbook');
    const recentContext = sourceIndex.filter(source => source.sourceType === 'chat');
    const characterContext = sourceIndex.filter(source => source.sourceType === 'mvu');
    const genealogyRefs = sourceIndex.filter(source => source.sourceType === 'genealogy');
    const biographyRefs = sourceIndex.filter(source => source.sourceType === 'biography');
    const butterflyRefs = sourceIndex.filter(source => source.sourceType === 'butterfly');
    const warnings: string[] = [];
    if (worldbookContext.length === 0) warnings.push('worldbook_context_empty');
    if (recentContext.length === 0) warnings.push('recent_context_empty');
    if (sourceIndex.length === 0) warnings.push('active_retrieval_empty');

    return {
      schema: 'eyon.context.v1',
      taskType: 'ruin',
      requestId: input.requestId,
      scope: {
        ...input.namespace,
        triggerMessageId: input.triggerMessageId,
      },
      currentWorld,
      ...(currentSceneSnapshot ? { currentSceneSnapshot } : {}),
      worldbookContext,
      recentContext,
      characterContext,
      genealogyRefs,
      biographyRefs,
      butterflyRefs,
      sourceIndex,
      evidenceBundle: active.bundle,
      ...(continuityView ? { continuityView } : {}),
      // 完整人物卡（原始全文，不参与检索；上限放宽——中心人物整条注入用）。
      characterCards: mapSources(characters, 'mvu', 95),
      ...(scopedGenealogy ? { actorPolicy: scopedGenealogy.policy } : {}),
      warnings,
      sourceHash: await hashSources(
        input.directive,
        currentWorld,
        sourceIndex,
        active.bundle,
        currentSceneSnapshot,
        continuityView,
      ),
    };
  }

  private async continuityView(
    namespace: { characterKey: string; chatId: string },
    branch: CanonBranch | undefined,
    canonView: CanonResolvedView | undefined,
    query: string,
    subject: string,
    time: string,
    location: string,
  ): Promise<ContinuityView | undefined> {
    if (!this.biographyRepository || !branch || !canonView) return undefined;
    try {
      return buildContinuityViewSafely({
        records: await this.biographyRepository.list(namespace),
        branchId: branch.branchId,
        canonRevision: canonView.resolvedRevision,
        query,
        targetView: canonView,
        branch,
        cacheScope: {
          namespace: namespaceKey(namespace),
          module: 'ruin',
          subjectScope: [subject],
          timeScope: [time],
          locationScope: [location],
        },
      });
    } catch (error) {
      console.warn('[Eyon History Workbench] continuity view unavailable; continuing ruin without it', error);
      return undefined;
    }
  }

  private buildRecentSources(triggerMessageId: number, limit = RECENT_MESSAGE_LIMIT) {
    const start = Math.max(0, triggerMessageId - limit + 1);
    return this.runtime
      .getChatMessages(`${start}-${triggerMessageId}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim())
      .map(message => ({
        sourceId: `chat:${message.message_id}`,
        title: `${message.role} floor ${message.message_id}`,
        content: message.message,
      }));
  }
}

function worldbookSourceMentionsExactEra(
  source: {
    title: string;
    content: string;
    keywords: string[];
  },
  era: string,
): boolean {
  const anchor = normalizeEraAnchor(era);
  if (!anchor) return false;
  return [source.title, source.content, ...source.keywords]
    .some(value => normalizeEraAnchor(value).includes(anchor));
}

function normalizeEraAnchor(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function mapSources(
  sources: Array<{ sourceId: string; title: string; content: string }>,
  sourceType: ContextSource['sourceType'],
  authority: number,
): ContextSource[] {
  const seen = new Set<string>();
  return sources.flatMap(source => {
    const sourceId = source.sourceId.trim();
    const content = source.content.trim();
    if (!sourceId || !content || seen.has(sourceId)) return [];
    seen.add(sourceId);
    return [{
      sourceId,
      sourceType,
      title: source.title.trim() || sourceId,
      content,
      authority,
    }];
  });
}

async function hashSources(
  directive: string,
  currentWorld: { time: string; location: string },
  sources: ContextSource[],
  evidenceBundle: EvidenceBundle,
  currentSceneSnapshot?: CurrentSceneSnapshot | null,
  continuityView?: ContinuityView,
): Promise<string> {
  const input = JSON.stringify({
    directive,
    currentWorld,
    currentSceneSnapshot: currentSceneSnapshot
      ? [
          currentSceneSnapshot.location,
          ...currentSceneSnapshot.evidence.map(item => [item.sourceId, item.content]),
        ]
      : null,
    sources: sources.map(source => [
      source.sourceId,
      source.sourceType,
      source.content,
    ]),
    passageStrategyVersion: evidenceBundle.receipt.passageBudget.strategyVersion,
    passages: evidenceBundle.passages.map(passage => [
      passage.passageId,
      passage.contentHash,
    ]),
    personFactIds: evidenceBundle.personCanonViews?.flatMap(view => view.relevantFactIds) ?? [],
    taskAnchorAttachments: evidenceBundle.taskAnchorAttachments?.map(attachment => [
      attachment.attachmentId,
      attachment.contentHash,
    ]) ?? [],
    canonView: evidenceBundle.canonResolvedView
      ? [
          evidenceBundle.canonResolvedView.viewId,
          evidenceBundle.canonResolvedView.branchId,
          evidenceBundle.canonResolvedView.resolvedRevision,
          evidenceBundle.canonResolvedView.queryScopeHash,
        ]
      : null,
    continuityView: continuityView
      ? [
          continuityView.branchId,
          continuityView.canonRevision,
          continuityView.queryScopeHash,
          ...continuityView.anchors.map(anchor => [anchor.handle, anchor.claim]),
          ...continuityView.relationGroups.map(group => [
            group.kind, group.dimension, ...group.handles, group.omittedMemberCount,
          ]),
        ]
      : null,
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
