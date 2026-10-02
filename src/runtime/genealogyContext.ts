import type {
  ContextSource,
  GenealogyContextAssembler,
  GenealogyContextBundle,
} from '../core/context.ts';
import {
  loadRuntimeWorldbookCorpus,
  type RuntimeContextSourceProvider,
  type TavernRuntime,
} from './contracts.ts';
import type { RetrievalShadowCapture } from '../retrieval/runtimeShadow.ts';
import type { EvidenceBundle } from '../retrieval/contracts.ts';
import { resolveActiveRetrieval } from './activeRetrieval.ts';
import type { CanonRepository } from '../storage/canon.ts';
import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import type { BiographyRepository } from '../storage/biographies.ts';
import { buildContinuityViewSafely } from './continuityAnchors.ts';
import { currentGenealogyHistoryReferences } from './genealogyContinuity.ts';

const RECENT_MESSAGE_LIMIT = 24;

export class TavernGenealogyContextAssembler implements GenealogyContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;
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
  }): Promise<GenealogyContextBundle> {
    const [
      currentWorld,
      worldbookCorpus,
      characters,
      genealogies,
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
    const worldbookContext = mapSources(worldbook, 'worldbook', 100);
    const recentContext = mapSources(
      this.buildRecentSources(input.triggerMessageId),
      'chat',
      80,
    );
    const characterContext = mapSources(characters, 'mvu', 95);
    const biographyRefs = mapSources(biographies, 'biography', 70);
    const genealogyCandidates = mapSources(genealogies, 'genealogy', 75);
    const butterflyCandidates = mapSources(butterflies, 'butterfly', 70);
    const legacySourceIndex = [
      ...worldbookContext,
      ...characterContext,
      ...recentContext,
      ...biographyRefs,
    ];
    const canonBranch = await this.canonRepository?.getBranch(input.namespace);
    const active = await resolveActiveRetrieval({
      retrieval: this.retrievalShadow,
      requestId: input.requestId,
      taskType: 'genealogy',
      query: input.directive,
      contextQuery: [
        currentWorld.time,
        currentWorld.location,
        ...recentContext.slice(-8).flatMap(source => [
          source.title,
          source.content,
        ]),
      ].join('\n'),
      runtimeCandidates: [
        ...worldbook.map(source => ({ ...source, sourceType: 'worldbook' as const })),
        ...characterContext,
        ...recentContext,
        ...genealogyCandidates,
        ...biographyRefs,
        ...butterflyCandidates,
      ],
      contextCandidates: [
        ...worldbookContext,
        ...characterContext,
        ...recentContext,
        ...genealogyCandidates,
        ...biographyRefs,
        ...butterflyCandidates,
      ],
      legacySourceIds: legacySourceIndex.map(source => source.sourceId),
      worldbookCorpusReceipt: worldbookCorpus.receipt,
      baselineWorldTime: this.ensureBaselineTime?.(input.namespace, currentWorld.time) ?? null,
      canonBranch,
    });
    const sourceIndex = active.sourceIndex;
    const activeWorldbookContext = sourceIndex.filter(source => source.sourceType === 'worldbook');
    const activeRecentContext = sourceIndex.filter(source => source.sourceType === 'chat');
    const activeCharacterContext = sourceIndex.filter(source => source.sourceType === 'mvu');
    const activeBiographyRefs = sourceIndex.filter(source => source.sourceType === 'biography');
    const warnings: string[] = [];
    if (activeWorldbookContext.length === 0) warnings.push('worldbook_context_empty');
    if (activeCharacterContext.length === 0) warnings.push('character_context_empty');
    if (sourceIndex.length === 0) warnings.push('active_retrieval_empty');
    let continuityView: GenealogyContextBundle['continuityView'];
    let historyReferenceCandidates: GenealogyContextBundle['historyReferenceCandidates'];
    if (canonBranch && active.bundle.canonResolvedView && this.biographyRepository) {
      try {
        const records = await this.biographyRepository.list(input.namespace);
        continuityView = buildContinuityViewSafely({ records, branchId: canonBranch.branchId, canonRevision: active.bundle.canonResolvedView.resolvedRevision,
          query: input.directive, targetView: active.bundle.canonResolvedView, branch: canonBranch,
          cacheScope: {
            namespace: namespaceKey(input.namespace),
            module: 'genealogy',
            subjectScope: [input.directive],
            timeScope: [currentWorld.time],
            locationScope: [currentWorld.location],
          } });
        historyReferenceCandidates = currentGenealogyHistoryReferences(records, canonBranch);
      } catch { warnings.push('genealogy_continuity_unavailable'); }
    }

    return {
      schema: 'eyon.context.v1',
      taskType: 'genealogy',
      requestId: input.requestId,
      scope: { ...input.namespace, triggerMessageId: input.triggerMessageId },
      currentWorld,
      worldbookContext: activeWorldbookContext,
      recentContext: activeRecentContext,
      characterContext: activeCharacterContext,
      currentMvuCharacters: characters.map(({ sourceId, title }) => ({ sourceId, title })),
      biographyRefs: activeBiographyRefs,
      sourceIndex,
      evidenceBundle: active.bundle,
      continuityView,
      historyReferenceCandidates,
      warnings,
      sourceHash: await hashSources(
        input.directive,
        currentWorld,
        sourceIndex,
        active.bundle,
        continuityView,
      ),
    };
  }

  private buildRecentSources(triggerMessageId: number) {
    const start = Math.max(0, triggerMessageId - RECENT_MESSAGE_LIMIT + 1);
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
  continuityView?: GenealogyContextBundle['continuityView'],
): Promise<string> {
  const input = JSON.stringify({
    directive,
    continuityView,
    currentWorld,
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
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
