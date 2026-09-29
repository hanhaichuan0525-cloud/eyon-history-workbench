import type { BiographyContextAssembler } from '../core/context.ts';
import type { ContextSource } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import { createSlot } from '../core/slots.ts';
import type { GenerationAdapter } from '../adapters/host.ts';
import {
  buildBiographyPlanPrompt,
  buildBiographyPlanRepairPrompt,
  buildBiographyPassagePrompt,
  buildBiographyPassageRepairPrompt,
  buildBiographyPassageBatchPrompt,
  buildBiographyContinuityJudgePrompt,
  buildBiographyShellInstruction,
  type BiographyPassageBlock,
  type BiographyRuleSet,
} from '../prompts/biography.ts';
import {
  buildActiveEvidenceView,
  requestedEraFromText,
} from '../prompts/activeEvidence.ts';
import {
  biographyRecordKey,
  type BiographyRecord,
  type BiographyRepository,
} from '../storage/biographies.ts';
import {
  BiographyValidationError,
  parseAndValidateBiography,
  parseAndValidateBiographyPassage,
  parseAndValidateBiographyPassageBatch,
  parseAndValidateBiographyPlan,
} from '../validators/biography.ts';
import { insertRootTrace } from './messageAssembly.ts';
import { renderSpanLabel } from '../renderers/spanLabel.ts';
import { parseStoryClock, type StoryClock } from '../runtime/storyClock.ts';
import type { BiographyStagePlan } from '../runtime/biographyDiceCore.ts';
import {
  buildStagePersonTimeline,
  type StagePersonAssessment,
} from '../retrieval/temporal.ts';
import {
  collectPassageObjectStateEvidence,
  explicitAgeConflictNames,
  knownPersonNamesMentioned,
  revisionObjectStateConflictNames,
  softenExplicitAgeConflicts,
  type PassageTimeWindow,
  type RevisionObjectStateEvidence,
} from '../retrieval/prosePersonReview.ts';
import { extendTaskCitationRegistry } from '../retrieval/citations.ts';
import type { Biography, BiographyPassageResponse, BiographyPlan } from '../schemas/biography.ts';
import type { BiographyContextBundle } from '../core/context.ts';
import { BIOGRAPHY_CONTRACT } from '../core/biographyContract.ts';
import {
  biographyBindingUnits,
  buildArtifactCanonBindingsSafely,
} from '../core/artifactCanonBinding.ts';
import type { CanonRepository } from '../storage/canon.ts';
import {
  buildBiographyContinuityAnchorsSafely,
  continuityAnchorsFromCommittedRecords,
  type BiographyContinuityAnchorUnit,
} from '../core/continuityAnchors.ts';
import { buildContinuityViewSafely } from '../runtime/continuityAnchors.ts';
import {
  buildContinuityViewRelationsSafely,
  parseContinuityEventJudgeText,
  recallContinuityEventPairCandidates,
  recordContinuityRelationDiagnostic,
  type ContinuityEventPairCandidate,
  type ResolvedContinuityRelationProposal,
} from '../core/continuityRelations.ts';

export interface BiographyShellAdapter {
  readAssistantMessage(messageId: number): Promise<string>;
  writeAssistantMessage(messageId: number, content: string): Promise<void>;
  refreshAssistantMessage(messageId: number): Promise<void>;
}

export interface BiographyWorkflowScope {
  namespace: {
    characterKey: string;
    chatId: string;
  };
  triggerMessageId: number;
}

export interface BiographyWorkflowDependencies {
  contextAssembler: BiographyContextAssembler;
  generator: GenerationAdapter;
  shell: BiographyShellAdapter;
  repository: BiographyRepository;
  rules: BiographyRuleSet;
  getScope(): Promise<BiographyWorkflowScope>;
  createRequestId(): string;
  now(): number;
  createStagePlan(): BiographyStagePlan;
  canonRepository?: CanonRepository;
  /**
   * 二次检索：按本批或首稿实际借用的具名实体精确补齐身份资料。
   * 它不按年代扩张历史事实集；timeHints 仅保留为兼容参数，当前不得用于宽泛召回。
   */
  resolveEvidence?: (
    names: string[],
    sourceRefs: string[],
    context: BiographyContextBundle,
    timeHints?: string[],
  ) => Promise<ContextSource[]>;
}

export interface BiographyWorkflowResult {
  requestId: string;
  biographyId: string;
  assistantMessageId: number;
  warning: 'none' | 'slot_missing' | 'court_missing' | 'trailing_discarded';
  /** 从正文楼层解析出的剧情时间戳（首尾 HTML 注释）；无戳为 null */
  storyClock: StoryClock | null;
}

export interface BiographyPreparation {
  requestId: string;
  biographyId: string;
  recordKey: string;
  scope: BiographyWorkflowScope;
  sourceHash: string;
  slot: string;
  instruction: string;
  rootTrace: string;
}

export interface BiographyPrepareOptions {
  scope?: BiographyWorkflowScope;
  assertCurrent?(scope: BiographyWorkflowScope): Promise<void>;
}

export class BiographyWorkflow {
  private readonly dependencies: BiographyWorkflowDependencies;

  constructor(dependencies: BiographyWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  /**
   * 查询某个玩家触发楼下已保存的传记记录（validated 或 committed 均可）。
   * 重 roll（swipe/regenerate）时用它复用已有传记，只重滚正文壳，不重新规划扩写。
   * 不要求 committed：若上次 commit 失败但传记内容已校验通过（validated），
   * 同样可以复用其 RootTrace，避免无谓地重新生成整篇传记。
   */
  async findCommittedByTrigger(
    namespace: BiographyWorkflowScope['namespace'],
    triggerMessageId: number,
  ): Promise<BiographyRecord | null> {
    const records = await this.dependencies.repository.list(namespace);
    return records.find(record =>
      record.triggerMessageId === triggerMessageId
    ) ?? null;
  }

  async prepare(
    command: WorkbenchCommand,
    options: BiographyPrepareOptions = {},
  ): Promise<BiographyPreparation> {
    if (command.type !== 'biography.generate') {
      throw new Error('Biography workflow received a different command type');
    }

    const initialScope = options.scope ?? await this.dependencies.getScope();
    const requestId = this.dependencies.createRequestId();
    const stagePlan = this.dependencies.createStagePlan();
    const context = await this.dependencies.contextAssembler.assemble({
      requestId,
      namespace: initialScope.namespace,
      triggerMessageId: initialScope.triggerMessageId,
      directive: command.raw,
    });
    this.assertScope(initialScope, context.scope);

    // Step A：规划（1 个轻请求）
    const plan = await this.plan(requestId, command.raw, context, stagePlan);
    await this.assertCurrent(initialScope, options);

    // Step B：小批量扩写（严格顺序，逐块请求 + 定向修复）
    const expansion = await this.expandPassages(requestId, plan, context, initialScope, options);
    const passages = expansion.passages;

    // Step C：组装 + 整体校验（复用 parseAndValidateBiography 渲染 RootTrace）
    const biography = assembleBiography(plan, passages);
    const validated = parseAndValidateBiography(JSON.stringify(biography), {
      requestId,
      directive: command.raw,
      context,
      stagePlan,
    });

    await this.assertCurrent(initialScope, options);
    const biographyId = `bio-${requestId}`;
    const key = biographyRecordKey(initialScope.namespace, biographyId);
    const now = this.dependencies.now();
    const canonBindings = buildArtifactCanonBindingsSafely({
      artifactType: 'biography',
      artifactId: biographyId,
      view: context.evidenceBundle.canonResolvedView,
      branch: await loadCanonBranchSafely(
        this.dependencies.canonRepository,
        initialScope.namespace,
      ),
      units: biographyBindingUnits(passages.values(), [
        validated.target.name,
        ...validated.target.aliases,
      ]),
      createdAt: now,
    });
    const continuityAnchors = buildBiographyContinuityAnchorsSafely({
      artifactId: biographyId,
      units: biographyFinalProseContinuityUnits(plan, passages),
      canonBindings,
      personCanonViews: context.evidenceBundle.personCanonViews,
      createdAt: now,
    });
    const anchorScope = continuityAnchors[0];
    const existingRecords = anchorScope
      ? await this.dependencies.repository.list(initialScope.namespace)
      : [];
    const continuityRelations = anchorScope
      ? buildContinuityViewRelationsSafely({
        namespace: namespaceKey(initialScope.namespace),
        artifactId: biographyId,
        newAnchors: continuityAnchors,
        existingAnchors: continuityAnchorsFromCommittedRecords(
          existingRecords,
          anchorScope.branchId,
          anchorScope.canonRevision,
        ),
        proposals: expansion.relationProposals,
        createdAt: now,
      })
      : [];
    const record: BiographyRecord = {
      key,
      namespace: initialScope.namespace,
      biographyId,
      requestId,
      triggerMessageId: initialScope.triggerMessageId,
      assistantMessageId: null,
      sourceHash: context.sourceHash,
      status: 'validated',
      revision: 1,
      biography: validated,
      ...(canonBindings.length > 0 ? { canonBindings } : {}),
      ...(continuityAnchors.length > 0 ? { continuityAnchors } : {}),
      ...(continuityRelations.length > 0 ? { continuityRelations } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.dependencies.repository.saveValidated(record);

    const slot = createSlot('rootTrace', requestId);
    return {
      requestId,
      biographyId,
      recordKey: key,
      scope: initialScope,
      sourceHash: context.sourceHash,
      slot,
      instruction: buildBiographyShellInstruction(validated, slot),
      rootTrace: validated.rootTrace,
    };
  }

  private async plan(
    requestId: string,
    directive: string,
    context: BiographyContextBundle,
    stagePlan: BiographyStagePlan,
  ): Promise<BiographyPlan> {
    const input = {
      requestId,
      directive,
      context,
      rules: this.dependencies.rules,
      stagePlan,
    };
    const prompt = buildBiographyPlanPrompt(input);
    const rawResult = await this.dependencies.generator.generate(
      'biography',
      prompt,
      { progressLabel: '正在规划全篇 · 起源、5–8个阶段与现状' },
    );
    try {
      return parseAndValidateBiographyPlan(rawResult, { requestId, directive, stagePlan, context });
    } catch (error) {
      if (!(error instanceof BiographyValidationError)) throw error;
      const repairPrompt = buildBiographyPlanRepairPrompt({
        ...input,
        validationError: summarizeBiographyValidationError(error),
      });
      const repairedRaw = await this.dependencies.generator.generate(
        'biography',
        repairPrompt,
        { progressLabel: '规划需要修正 · 正在重新排页' },
      );
      return parseAndValidateBiographyPlan(repairedRaw, { requestId, directive, stagePlan, context });
    }
  }

  private async expandPassages(
    requestId: string,
    plan: BiographyPlan,
    context: BiographyContextBundle,
    initialScope: BiographyWorkflowScope,
    options: BiographyPrepareOptions,
  ): Promise<{
    passages: Map<string, BiographyPassageResponse>;
    relationProposals: ResolvedContinuityRelationProposal[];
  }> {
    const blocks = buildPassageBlocks(plan);
    const knownSources = new Set(context.sourceIndex.map(source => source.sourceId));
    // Plan A：篇章分区 × 人物时间锚——按 origin / stages / status 的 span 与引擎算好的生卒/抵达窗口
    // 做区间相交，得到每段相关人物的在场结论（年龄段/未出生/已故），随扩写 prompt 注入；
    // 纯软约束：模型据此写对在场与年龄，绝不因错位硬拦任务。
    const stageTimeline = buildStagePersonTimeline(
      [
        { id: 'origin', span: { start: plan.span.start, end: plan.span.start } },
        ...plan.stages.map(stage => ({ id: stage.id, span: stage.span })),
        { id: 'status', span: { start: plan.span.end, end: plan.span.end } },
      ],
      context.evidenceBundle.personTimeline ?? [],
      plan.span.start.era ?? null,
    );
    const activeEvidence = buildActiveEvidenceView(
      context.evidenceBundle,
      requestedEraFromText(
        `${context.evidenceBundle.query}\n${context.currentWorld.time}`,
      ),
    );
    const taskAnchorAttachments = context.evidenceBundle.taskAnchorAttachments ?? [];
    // 带完整人物锚的传记优先逐段生成。真实环境已证明长证据下批量响应会
    // 连续截断并再降级，直接逐段可少一次失败调用，同时让每段看到同一证据包。
    const preferSinglePassages = taskAnchorAttachments.some(attachment =>
      attachment.purpose === 'direct-character-entry');

    const passages = new Map<string, BiographyPassageResponse>();
    const relationProposals: ResolvedContinuityRelationProposal[] = [];
    for (let index = 0; index < blocks.length; index += BIOGRAPHY_CONTRACT.batchSize) {
      const batch = blocks.slice(index, index + BIOGRAPHY_CONTRACT.batchSize);
      const writingProgress = biographyPassageProgressLabel(
        plan,
        blocks,
        index,
        batch.length,
        'writing',
      );
      const plannedNames = collectPassageNames(batch, plan);
      // 二次检索：本批计划借用的具名实体 + 直接引用 → 精确补齐身份资料。
      const evidence = this.dependencies.resolveEvidence
        ? await this.dependencies.resolveEvidence(
          plannedNames,
          batch.flatMap(block => block.sourceRefs),
          context,
          collectTimeHints(batch, plan),
        )
        : [];
      for (const source of evidence) knownSources.add(source.sourceId);
      const stagePersonNotes = batch
        .flatMap(block => {
          const group = stageTimeline.find(item => item.stageId === block.passageId);
          return group
            ? [{ passageId: group.stageId, assessments: group.assessments }]
            : [];
        });
      const priorPassages = [...passages.values()];
      const initialContinuityNames = [...new Set([
        ...plannedNames,
        ...collectPersistentContinuityNames(priorPassages),
      ])];
      const promptInput = {
        requestId,
        plan,
        passages: batch,
        rules: this.dependencies.rules,
        evidence,
        personCanonViews: context.evidenceBundle.personCanonViews,
        activeEvidence,
        taskAnchorAttachments,
        stagePersonNotes,
        personTimeline: context.evidenceBundle.personTimeline,
        continuityPassages: priorPassages,
        continuityNames: initialContinuityNames,
        continuityView: context.continuityView,
        currentSceneLocation: context.currentWorld.location,
        currentSceneSnapshot: context.currentSceneSnapshot,
      };
      const generatedPassages = preferSinglePassages
        ? await this.expandBatchIndividually(
          promptInput,
          knownSources,
          writingProgress,
        )
        : await this.generateBatchWithRepair(
          promptInput,
          knownSources,
          writingProgress,
        );
      // 每个原始批次只追加一次完整自然语言复核：关键词检测只补充高风险实体与资料，
      // 不再决定某段是否有资格被审阅。否定范围、代词、部件与替代物交给模型结合
      // 完整首稿理解，同时避免“每段再生成一次”的请求倍增。
      // 正文复核只负责自然语言连续性，不再兼任 P4-A2/P4-C 结构化记账。
      const reconciledPassages: BiographyPassageResponse[] = generatedPassages.map(passage => ({
        ...passage,
      }));
      const reviewNames = new Set<string>();
      let reviewEvidence = [...evidence];
      const rollingContinuity = [...passages.values(), ...generatedPassages];
      const revisionObjectEvidence = collectRevisionObjectEvidence(activeEvidence);
      const revisionObjectNames = collectRevisionObjectNames(activeEvidence);
      for (let offset = 0; offset < generatedPassages.length; offset += 1) {
        const block = batch[offset];
        const initialPassage = generatedPassages[offset];
        if (!block || !initialPassage) continue;
        const actualNames = [...new Set([
          ...collectResponseEntityNames(initialPassage, plan),
          ...knownNamesMentionedInPassage(initialPassage, context),
          ...priorPeopleMentionedInPassage(initialPassage, rollingContinuity),
        ])];
        const lateEvidence = this.dependencies.resolveEvidence
          ? await this.dependencies.resolveEvidence(
            actualNames,
            [...block.sourceRefs, ...initialPassage.sourceRefs],
            context,
            collectTimeHints([block], plan),
          )
          : [];
        const mergedEvidence = mergeContextSources(evidence, lateEvidence);
        const borrowedKnownNames = namesBorrowedFromKnownCanon(
          actualNames,
          plan,
          context,
        );
        const impossibleNames = impossiblePresenceNames(
          initialPassage,
          stagePersonNotes.find(group => group.passageId === block.passageId)?.assessments ?? [],
        );
        const ageConflictNames = explicitAgeConflictNames(
          initialPassage.content,
          stagePersonNotes.find(group => group.passageId === block.passageId)?.assessments ?? [],
        );
        const priorPassages = [...passages.values(), ...generatedPassages.slice(0, offset)];
        const objectEvidence = [
          ...revisionObjectEvidence,
          ...collectPriorPassageObjectEvidence(priorPassages, plan, revisionObjectNames),
        ];
        const objectConflictNames = revisionObjectStateConflictNames(
          initialPassage.content,
          collectPassageObjectNames(initialPassage, plan, priorPassages, revisionObjectNames),
          passageTimeWindow(block, plan),
          objectEvidence,
        );
        const highRiskNames = [...new Set([
          ...borrowedKnownNames,
          ...impossibleNames,
          ...ageConflictNames,
          ...objectConflictNames,
        ])];
        for (const source of mergedEvidence) knownSources.add(source.sourceId);
        reviewEvidence = mergeContextSources(reviewEvidence, mergedEvidence).slice(0, 8);
        if (highRiskNames.length > 0) {
          highRiskNames.forEach(name => reviewNames.add(name));
        }
      }
      let relationViewForBatch = context.continuityView;
      let eventPairCandidatesForBatch: ContinuityEventPairCandidate[] = [];
      try {
        // 规划时还不知道本批会借用哪些旁支地点/物件。用完整首稿中的实际
        // 指称重新筛一次同 revision 锚，让「地下出版」写到某间旧书店时，
        // 复核能看见该店此前已焚毁的记录；失败仍沿用规划时的只读视图。
        let reviewContinuityView = context.continuityView;
        const canonView = context.evidenceBundle.canonResolvedView;
        if (canonView) {
          try {
            const refreshed = buildContinuityViewSafely({
              records: await this.dependencies.repository.list(initialScope.namespace),
              branchId: canonView.branchId,
              canonRevision: canonView.resolvedRevision,
              query: [
                plan.playerDirective.raw,
                plan.target.name,
                ...generatedPassages.flatMap(passage => [
                  ...passage.people,
                  ...passage.factions,
                  ...passage.objects,
                  ...passage.locations,
                  passage.content,
                ]),
              ].join('\n'),
              targetView: canonView,
              includeCommittedProse: true,
              branch: await loadCanonBranchSafely(
                this.dependencies.canonRepository,
                initialScope.namespace,
              ),
            });
            if (refreshed.anchors.length > 0 || !reviewContinuityView?.anchors.length) {
              reviewContinuityView = refreshed;
            }
          } catch (error) {
            console.warn('[Eyon History Workbench] draft continuity refresh unavailable; keeping initial view', error);
          }
        }
        relationViewForBatch = reviewContinuityView;
        eventPairCandidatesForBatch = recallContinuityEventPairCandidates({
          currentEvents: generatedPassages
            .filter(passage => passage.eventUsage === 'occurs')
            .map(passage => ({
              producerUnitRef: passage.passageId,
              currentEventRef: passage.eventId,
              participants: [...passage.people, ...passage.factions],
              locations: passage.locations,
              objects: passage.objects,
            })),
          continuityView: reviewContinuityView,
        });
        const reviewInput = {
            ...promptInput,
            continuityView: reviewContinuityView,
            evidence: reviewEvidence,
            continuityPassages: [...passages.values()],
            continuityNames: [...new Set([
              ...initialContinuityNames,
              ...reviewNames,
              ...collectPersistentContinuityNames(generatedPassages),
            ])],
            entityReview: [...reviewNames],
            draftPassages: generatedPassages,
          };
        let reviewed = await this.reviewBatchOnce(
          reviewInput,
          knownSources,
          biographyPassageProgressLabel(plan, blocks, index, batch.length, 'review'),
        );
        // 若相关旧作品的原文已送入复核，但本批仍有段落逐字未变，再给模型
        // 一次聚焦比较机会。只重写本批，失败保留首轮结果；不靠词段判错或截断。
        if (reviewContinuityView?.anchors.some(anchor => anchor.finalProseExcerpt)
          && reviewed.some(passage => generatedPassages.some(draft =>
            draft.passageId === passage.passageId && draft.content === passage.content))) {
          try {
            const focused = await this.reviewBatchOnce(
              {
                ...reviewInput,
                draftPassages: reviewed,
                focusedContinuityReview: true,
              },
              knownSources,
              biographyPassageProgressLabel(plan, blocks, index, batch.length, 'focused'),
            );
            if (focused.some(passage => reviewed.some(previous =>
              previous.passageId === passage.passageId && previous.content !== passage.content))) {
              reviewed = focused;
            }
          } catch (error) {
            if (isBiographyLifecycleError(error)) throw error;
            console.warn('[Eyon History Workbench] focused continuity review unavailable; keeping first review', error);
          }
        }
        const reviewedById = new Map(reviewed.map(passage => [passage.passageId, passage]));
        for (let offset = 0; offset < reconciledPassages.length; offset += 1) {
          const replacement = reviewedById.get(reconciledPassages[offset]?.passageId ?? '');
          if (replacement) reconciledPassages[offset] = replacement;
        }
      } catch (error) {
        if (isBiographyLifecycleError(error)) throw error;
        // 全文复核是可选质量增强；失败时保留已通过结构校验的首稿，不截断整篇。
        console.warn(
          '[Eyon History Workbench] optional biography full-passage review failed; keeping validated first drafts',
          error,
        );
      }
      // 精确岁数可以按人物时间轴安全地删去；物品连续性涉及部件、功能、代词、
      // 替代品与产出物，不能用逐字规则重写。物品复核失败时保留可用首稿，绝不
      // 插入“原件已于某年毁坏”式技术句，也不把语义瑕疵升级成整篇报错。
      for (let offset = 0; offset < reconciledPassages.length; offset += 1) {
        const passage = reconciledPassages[offset];
        const block = batch.find(item => item.passageId === passage?.passageId);
        if (!passage || !block) continue;
        const assessments = stagePersonNotes.find(group =>
          group.passageId === block.passageId)?.assessments ?? [];
        const ageReviewed = softenExplicitAgeConflicts(passage.content, assessments);
        if (ageReviewed.content !== passage.content) {
          // 最终正文在复核后又被确定性改写时，直接以改写后的正文作为后续裁判输入。
          reconciledPassages[offset] = {
            ...passage,
            content: ageReviewed.content,
          };
        }
      }
      const eventPairById = new Map(eventPairCandidatesForBatch.map(pair => [pair.pairId, pair]));
      const reviewedEventPairs = new Map<string, {
        verdict: 'sameEvent' | 'differentEvent' | 'uncertain';
        dimension?: ResolvedContinuityRelationProposal['dimension'];
        unitId: string;
      }>();
      if (eventPairCandidatesForBatch.length > 0 && relationViewForBatch) {
        try {
          const rawVerdicts = await this.dependencies.generator.generate(
            'biography',
            buildBiographyContinuityJudgePrompt({
              requestId,
              passages: reconciledPassages,
              eventPairs: eventPairCandidatesForBatch,
              continuityView: relationViewForBatch,
            }),
            {
              progressLabel: biographyPassageProgressLabel(
                plan,
                blocks,
                index,
                batch.length,
                'judge',
              ),
            },
          );
          for (const verdict of parseContinuityEventJudgeText(
            rawVerdicts,
            eventPairCandidatesForBatch,
          )) {
            const pair = eventPairById.get(verdict.pairId);
            if (!pair) continue;
            if (!reviewedEventPairs.has(pair.pairId)) {
              reviewedEventPairs.set(pair.pairId, {
                verdict: verdict.verdict,
                dimension: verdict.dimension,
                unitId: pair.producerUnitRef,
              });
            }
            if (verdict.verdict !== 'sameEvent' || !verdict.dimension) continue;
            relationProposals.push({
              kind: 'auto',
              currentEventRef: pair.currentEventRef,
              otherHandle: pair.otherHandle,
              dimension: verdict.dimension,
              note: verdict.note,
              producerUnitRef: pair.producerUnitRef,
              otherAnchorId: pair.otherAnchorId,
            });
          }
        } catch (error) {
          if (isBiographyLifecycleError(error)) throw error;
          console.warn('[Eyon History Workbench] continuity event judge unavailable; keeping biography without relations', error);
        }
      }
      for (const passage of reconciledPassages) {
        passages.set(passage.passageId, passage);
      }
      for (const pair of eventPairCandidatesForBatch) {
        const review = reviewedEventPairs.get(pair.pairId);
        const accepted = review?.verdict === 'sameEvent' && Boolean(review.dimension);
        recordContinuityRelationDiagnostic({
          code: accepted
            ? 'event-pair-review-accepted'
            : review
              ? 'event-pair-review-rejected'
              : 'event-pair-review-missing',
          artifactId: `bio-${requestId}`,
          unitId: pair.producerUnitRef,
          message: accepted
            ? `${pair.pairId} was accepted as the same event (${review.dimension})`
            : review
              ? `${pair.pairId} was reviewed as ${review.verdict}${review.verdict === 'sameEvent' ? ' without a usable difference dimension' : ''}`
              : `${pair.pairId} was delivered to semantic review but returned no usable verdict`,
          createdAt: this.dependencies.now(),
        });
      }
      await this.assertCurrent(initialScope, options);
    }
    return { passages, relationProposals };
  }

  private async generateBatchWithRepair(
    input: Parameters<typeof buildBiographyPassageBatchPrompt>[0],
    knownSources: Set<string>,
    progressLabel = '',
  ): Promise<BiographyPassageResponse[]> {
    const prompt = buildBiographyPassageBatchPrompt(input);
      const expected = {
      requestId: input.requestId,
      passages: input.passages.map(block => ({
        passageId: block.passageId,
        kind: block.kind,
        eventId: block.eventAssignment.eventId,
        eventUsage: block.eventAssignment.usage,
      })),
      knownSources,
      citationRegistry: input.activeEvidence?.citationRegistry
        ? extendTaskCitationRegistry(input.activeEvidence.citationRegistry, [...knownSources])
        : undefined,
      directive: input.plan.playerDirective.raw,
      targetName: input.plan.target.name,
      currentSceneLocation: input.currentSceneLocation,
    };
    try {
      // 截断/畸形响应可能来自传输层（generator.generate 抛错）或解析层，
      // 两层都在捕获范围内：批次失败统一降级为逐块单块生成。
      const raw = await this.dependencies.generator.generate(
        'biography',
        prompt,
        { progressLabel },
      );
      return parseAndValidateBiographyPassageBatch(raw, expected);
    } catch (error) {
      // 整批失败：降级为逐块独立生成（块间无需承接，各自成篇）。
      // 降级条件不限于校验错误：截断类错误（max_tokens 顶格无法翻倍、
      // 中转断流型 JSON 不完整）同样降级——单块输出远小于批次，8192 内大概率成功。
      const truncated = error instanceof Error
        && /(?:API response was truncated|incomplete JSON object|finish_reason=(?:length|max_tokens))/iu
          .test(error.message);
      if (!(error instanceof BiographyValidationError) && !truncated) {
        throw error;
      }
      return this.expandBatchIndividually(input, knownSources, progressLabel);
    }
  }

  private async reviewBatchOnce(
    input: Parameters<typeof buildBiographyPassageBatchPrompt>[0],
    knownSources: Set<string>,
    progressLabel: string,
  ): Promise<BiographyPassageResponse[]> {
    const prompt = buildBiographyPassageBatchPrompt(input);
    const raw = await this.dependencies.generator.generate('biography', prompt, { progressLabel });
    return parseAndValidateBiographyPassageBatch(raw, {
      requestId: input.requestId,
      passages: input.passages.map(block => ({
        passageId: block.passageId,
        kind: block.kind,
        eventId: block.eventAssignment.eventId,
        eventUsage: block.eventAssignment.usage,
      })),
      knownSources,
      citationRegistry: input.activeEvidence?.citationRegistry
        ? extendTaskCitationRegistry(input.activeEvidence.citationRegistry, [...knownSources])
        : undefined,
      directive: input.plan.playerDirective.raw,
      targetName: input.plan.target.name,
      currentSceneLocation: input.currentSceneLocation,
    });
  }

  private async expandBatchIndividually(
    input: Parameters<typeof buildBiographyPassageBatchPrompt>[0],
    knownSources: Set<string>,
    progressLabel = '',
  ): Promise<BiographyPassageResponse[]> {
    const result: BiographyPassageResponse[] = [];
    const continuityPassages = [...(input.continuityPassages ?? [])];
    const allBlocks = buildPassageBlocks(input.plan);
    for (const block of input.passages) {
      const passage = await this.generatePassageWithRepair(
        {
          requestId: input.requestId,
          plan: input.plan,
          passage: block,
          rules: input.rules,
          evidence: input.evidence,
          personCanonViews: input.personCanonViews,
          activeEvidence: input.activeEvidence,
          taskAnchorAttachments: input.taskAnchorAttachments,
          stagePersonNotes: input.stagePersonNotes,
          continuityPassages,
          continuityNames: [...new Set([
            ...collectPassageNames([block], input.plan),
            ...collectPersistentContinuityNames(continuityPassages),
          ])],
          continuityView: input.continuityView,
          currentSceneLocation: input.currentSceneLocation,
          currentSceneSnapshot: input.currentSceneSnapshot,
          entityReview: input.entityReview,
        },
        knownSources,
        biographyPassageProgressLabel(
          input.plan,
          allBlocks,
          Math.max(0, allBlocks.findIndex(item =>
            item.passageId === block.passageId)),
          1,
          'writing',
        ),
      );
      result.push(passage);
      continuityPassages.push(passage);
    }
    return result;
  }

  private async generatePassageWithRepair(
    input: Parameters<typeof buildBiographyPassagePrompt>[0],
    knownSources: Set<string>,
    progressLabel = '',
  ): Promise<BiographyPassageResponse> {
    const prompt = buildBiographyPassagePrompt(input);
    const raw = await this.dependencies.generator.generate(
      'biography',
      prompt,
      { progressLabel },
    );
      const expected = {
      requestId: input.requestId,
      passageId: input.passage.passageId,
      kind: input.passage.kind,
      eventId: input.passage.eventAssignment.eventId,
      eventUsage: input.passage.eventAssignment.usage,
      knownSources,
      citationRegistry: input.activeEvidence?.citationRegistry
        ? extendTaskCitationRegistry(input.activeEvidence.citationRegistry, [...knownSources])
        : undefined,
      directive: input.plan.playerDirective.raw,
      targetName: input.plan.target.name,
      currentSceneLocation: input.currentSceneLocation,
    };
    try {
      return parseAndValidateBiographyPassage(raw, expected);
    } catch (error) {
      if (!(error instanceof BiographyValidationError)) throw error;
      const repairPrompt = buildBiographyPassageRepairPrompt({
        ...input,
        validationError: summarizeBiographyValidationError(error),
        // 正文太短的定向补救：让模型直接重写长版，而不是“只补几个字”。
        extraGuidance: error.code === 'PASSAGE_CONTENT_TOO_SHORT'
          ? '本次是正文太短：请把本段重写成至少 330 个字符（去除空白后的字符总数，含标点）。直接写一份更充实的完整段落，不要只补几个字。'
          : undefined,
      });
      const repairedRaw = await this.dependencies.generator.generate('biography', repairPrompt);
      return parseAndValidateBiographyPassage(repairedRaw, expected);
    }
  }

  private async assertCurrent(
    scope: BiographyWorkflowScope,
    options: BiographyPrepareOptions,
  ): Promise<void> {
    if (options.assertCurrent) {
      await options.assertCurrent(scope);
    } else {
      await this.assertCurrentScope(scope);
    }
  }

  async commit(
    preparation: BiographyPreparation,
    assistantMessageId: number,
  ): Promise<BiographyWorkflowResult> {
    const message = await this.dependencies.shell.readAssistantMessage(assistantMessageId);
    const assembled = insertRootTrace(
      message,
      preparation.slot,
      preparation.rootTrace,
    );
    await this.dependencies.shell.writeAssistantMessage(
      assistantMessageId,
      assembled.content,
    );
    await this.dependencies.shell.refreshAssistantMessage(assistantMessageId);
    await this.dependencies.repository.markCommitted(
      preparation.recordKey,
      assistantMessageId,
    );

    return {
      requestId: preparation.requestId,
      biographyId: preparation.biographyId,
      assistantMessageId,
      warning: assembled.warning,
      // 剧情时钟：从正文楼层解析首尾时间戳，供上层维护「剧情现在」
      storyClock: parseStoryClock(message),
    };
  }

  private assertScope(
    expected: BiographyWorkflowScope,
    actual: BiographyWorkflowScope['namespace'] & { triggerMessageId: number },
  ): void {
    if (
      namespaceKey(expected.namespace) !== namespaceKey(actual)
      || expected.triggerMessageId !== actual.triggerMessageId
    ) {
      throw new Error('Biography context belongs to a different chat request');
    }
  }

  private async assertCurrentScope(expected: BiographyWorkflowScope): Promise<void> {
    const current = await this.dependencies.getScope();
    if (
      namespaceKey(expected.namespace) !== namespaceKey(current.namespace)
      || expected.triggerMessageId !== current.triggerMessageId
    ) {
      throw new Error('Chat changed while biography request was running');
    }
  }
}

async function loadCanonBranchSafely(
  repository: CanonRepository | undefined,
  namespace: BiographyWorkflowScope['namespace'],
) {
  if (!repository) return undefined;
  try {
    return await repository.getBranch(namespace);
  } catch {
    return undefined;
  }
}

function isRepairableBiographyError(error: unknown): error is BiographyValidationError {
  return error instanceof BiographyValidationError && [
    'JSON_PARSE_FAILED',
    'RESPONSE_IDENTITY_MISMATCH',
    'SCHEMA_INVALID',
    'REQUEST_MISMATCH',
    'DIRECTIVE_MISMATCH',
  ].includes(error.code);
}

function summarizeBiographyValidationError(error: BiographyValidationError): string {
  const compact = error.message.replace(/\s+/gu, ' ').trim();
  return `${error.code}: ${compact.slice(0, 800)}`;
}

export function buildPassageBlocks(plan: BiographyPlan): BiographyPassageBlock[] {
  const stageLabel = (stage: BiographyPlan['stages'][number]): string =>
    renderSpanLabel(stage.span.start, stage.span.end, plan.span.mode);
  const eventFor = (passageId: string): BiographyPlan['eventAssignments'][number] => {
    const assignment = plan.eventAssignments.find(item => item.passageId === passageId);
    if (!assignment) throw new Error(`Biography plan event assignment missing: ${passageId}`);
    return assignment;
  };
  return [
    {
      passageId: 'origin',
      kind: 'origin',
      title: plan.originTitle,
      // 起源只锚定整体起点，不能把整段人生跨度误写成“起源持续至现状”。
      span: renderSpanLabel(plan.span.start, plan.span.start, plan.span.mode),
      sourceRefs: plan.sourceRefs,
      eventAssignment: eventFor('origin'),
    },
    ...plan.stages.map(stage => ({
      passageId: stage.id,
      kind: 'stage' as const,
      title: stage.title,
      theme: stage.theme,
      span: stageLabel(stage),
      sourceRefs: stage.sourceRefs,
      diceMaterial: stage.diceMaterial,
      eventAssignment: eventFor(stage.id),
    })),
    {
      passageId: 'status',
      kind: 'status',
      title: plan.statusTitle,
      // 现状只锚定整体终点，与起源对称。
      span: renderSpanLabel(plan.span.end, plan.span.end, plan.span.mode),
      sourceRefs: plan.sourceRefs,
      eventAssignment: eventFor('status'),
    },
  ];
}

export function biographyPassageProgressLabel(
  plan: BiographyPlan,
  blocks: BiographyPassageBlock[],
  startIndex: number,
  count: number,
  mode: 'writing' | 'review' | 'focused' | 'judge',
): string {
  const safeStart = Math.min(Math.max(0, startIndex), Math.max(0, blocks.length - 1));
  const safeEnd = Math.min(blocks.length - 1, safeStart + Math.max(1, count) - 1);
  const range = safeStart === safeEnd
    ? `${safeStart + 1}/${blocks.length}`
    : `${safeStart + 1}–${safeEnd + 1}/${blocks.length}`;
  const first = blocks[safeStart];
  const last = blocks[safeEnd];
  const scope = first && last
    ? first === last
      ? describeBiographyBlock(plan, first)
      : `${describeBiographyBlock(plan, first)}至${describeBiographyBlock(plan, last)}`
    : '传记正文';
  if (mode === 'review') {
    return `正在从头读第 ${range} 段 · 检查人物、物件与前史`;
  }
  if (mode === 'focused') {
    return `正在核对第 ${range} 段 · 与已提交史料逐项比对`;
  }
  if (mode === 'judge') {
    return `正在判断第 ${range} 段 · 两份事件记载是否属于同一件事`;
  }
  return `正在写第 ${range} 段 · ${scope}`;
}

function describeBiographyBlock(
  plan: BiographyPlan,
  block: BiographyPassageBlock,
): string {
  if (block.kind === 'origin') return '起源';
  if (block.kind === 'status') return '现状';
  const stage = plan.stages.find(item => item.id === block.passageId);
  const type = stage
    ? { stable: '稳定期', transition: '过渡期', turbulent: '动荡期' }[stage.type]
    : '阶段';
  return `${type}「${block.title}」`;
}

/**
 * P4-A2：脚本用冻结事件、段落时间和已校验的实体索引建立低权锚；完整正文仍由
 * committedProseExcerpts 按 unitId 附着。模型不再另写 continuityClaim，也不承担记账。
 */
function biographyFinalProseContinuityUnits(
  plan: BiographyPlan,
  passages: Map<string, BiographyPassageResponse>,
): BiographyContinuityAnchorUnit[] {
  const blocks = new Map(buildPassageBlocks(plan).map(block => [block.passageId, block]));
  const targetSignals = continuityTargetSignals(plan);
  return plan.eventAssignments.flatMap(assignment => {
    const passage = passages.get(assignment.passageId);
    const block = blocks.get(assignment.passageId);
    if (!passage || !block || passage.eventUsage !== 'occurs') return [];
    const signalNames = [...new Set([
      ...targetSignals.people,
      ...targetSignals.factions,
      ...targetSignals.objects,
      ...targetSignals.locations,
      ...passage.people,
      ...passage.factions,
      ...passage.objects,
      ...passage.locations,
    ].map(value => value.trim()).filter(Boolean))];
    const subject = signalNames[0] ?? plan.target.name;
    const related = signalNames.filter(name => name !== subject).slice(0, 3);
    const claim = [
      `${block.span ? `${block.span}，` : ''}${subject}相关事件：${assignment.summary}`,
      related.length > 0 ? `涉及${related.join('、')}` : '',
    ].filter(Boolean).join('；').replace(/\s+/gu, ' ').trim().slice(0, 240);
    const stage = plan.stages.find(item => item.id === assignment.passageId);
    const start = assignment.passageId === 'origin'
      ? plan.span.start
      : assignment.passageId === 'status'
      ? plan.span.end
      : stage?.span.start;
    const end = assignment.passageId === 'origin'
      ? plan.span.start
      : assignment.passageId === 'status'
      ? plan.span.end
      : stage?.span.end;
    return [{
      unitId: assignment.passageId,
      eventId: passage.eventId,
      claimSource: 'final-prose' as const,
      eventUsage: passage.eventUsage,
      claim,
      temporalScope: {
        label: block.span ?? '',
        ...(start ? { start: continuityTimePoint(start) } : {}),
        ...(end ? { end: continuityTimePoint(end) } : {}),
      },
      people: [...targetSignals.people, ...passage.people],
      factions: [...targetSignals.factions, ...passage.factions],
      objects: [...targetSignals.objects, ...passage.objects],
      locations: [...targetSignals.locations, ...passage.locations],
      sourceRefs: [...assignment.sourceRefs, ...passage.sourceRefs],
      inference: passage.inference,
    }];
  });
}

function continuityTargetSignals(plan: BiographyPlan): {
  people: string[];
  factions: string[];
  objects: string[];
  locations: string[];
} {
  const empty = { people: [], factions: [], objects: [], locations: [] };
  if (plan.target.type === 'person') return { ...empty, people: [plan.target.name] };
  if (plan.target.type === 'region') return { ...empty, locations: [plan.target.name] };
  if (plan.target.type === 'institution') return { ...empty, factions: [plan.target.name] };
  return { ...empty, objects: [plan.target.name] };
}

function continuityTimePoint(value: {
  era?: string;
  year: number | null;
  month: number | null;
  day: number | null;
  hour?: number | null;
  age: number | null;
}): string {
  const calendar = [
    value.era ?? '',
    value.year === null ? '' : `${value.year}年`,
    value.month === null ? '' : `${value.month}月`,
    value.day === null ? '' : `${value.day}日`,
    value.hour === null || value.hour === undefined ? '' : `${value.hour}时`,
  ].join('');
  if (calendar) return calendar;
  return value.age === null ? '' : `${value.age}岁`;
}

export function assembleBiography(
  plan: BiographyPlan,
  passages: Map<string, BiographyPassageResponse>,
): Biography {
  const origin = passages.get('origin');
  const status = passages.get('status');
  if (!origin || !status) {
    throw new Error('Biography assembly is missing origin or status passage');
  }

  const stages: Biography['stages'] = plan.stages.map(stage => {
    const passage = passages.get(stage.id);
    if (!passage) {
      throw new Error(`Biography assembly is missing stage passage ${stage.id}`);
    }
    return {
      id: stage.id,
      type: stage.type,
      title: stage.title,
      // 展示标签由脚本按跨度自适应生成（跨纪元/跨年/跨月/跨日/跨时）
      span: renderSpanLabel(stage.span.start, stage.span.end, plan.span.mode),
      diceMaterial: stage.diceMaterial,
      content: passage.content,
      introduced: stage.introduced,
      stalled: stage.stalled ?? false,
      driver: stage.driver,
      people: passage.people,
      factions: passage.factions,
      objects: passage.objects,
      locations: passage.locations,
      sourceRefs: passage.sourceRefs,
      biographyUsage: passage.biographyUsage,
      inference: passage.inference,
    };
  });

  return {
    schema: 'eyon.biography.v1',
    requestId: plan.requestId,
    playerDirective: plan.playerDirective,
    target: {
      type: plan.target.type ?? 'person',
      name: plan.target.name,
      aliases: plan.target.aliases,
      sourceRefs: plan.target.sourceRefs,
      playerReference: plan.target.playerReference,
      inference: plan.target.inference ?? false,
    },
    ...(plan.presentation === undefined ? {} : { presentation: plan.presentation }),
    span: {
      ...plan.span,
      // 整体跨度标签同样由脚本按跨度自适应生成，覆盖模型写的 label
      label: renderSpanLabel(plan.span.start, plan.span.end, plan.span.mode),
    },
    origin: {
      title: plan.originTitle,
      content: origin.content,
      sourceRefs: origin.sourceRefs,
      inference: origin.inference,
    },
    stages,
    status: {
      title: plan.statusTitle,
      content: status.content,
      sourceRefs: status.sourceRefs,
      inference: status.inference,
    },
    summary: plan.summary,
    indexes: plan.indexes,
    // 占位，parseAndValidateBiography 会按结构化数据确定性重渲染
    rootTrace: '[RootTrace]\n[/RootTrace]',
    qualityChecks: {
      ...plan.qualityChecks,
      rootTraceMatchesStructuredData: true,
    },
  };
}

/** 收集本批实际需要的人名；不把全篇人物索引灌进每一段。 */
function collectPassageNames(
  batch: BiographyPassageBlock[],
  plan: BiographyPlan,
): string[] {
  const names: string[] = [];
  const push = (values: readonly string[]): void => {
    for (const value of values) {
      const trimmed = value.trim();
      if (trimmed) names.push(trimmed);
    }
  };
  push([plan.target.name, ...plan.target.aliases]);
  for (const block of batch) {
    if (block.kind === 'stage') {
      const stage = plan.stages.find(item => item.id === block.passageId);
      if (stage) push(stage.introduced);
    }
  }
  return [...new Set(names)];
}

/** 保留批次时间锚供兼容调用；精确实体补召回不得据此扩张历史事实集。 */
function collectTimeHints(
  batch: BiographyPassageBlock[],
  plan: BiographyPlan,
): string[] {
  const hints: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed && !hints.includes(trimmed)) hints.push(trimmed);
  };
  for (const block of batch) {
    if (block.kind !== 'stage') continue;
    const stage = plan.stages.find(item => item.id === block.passageId);
    if (!stage) continue;
    for (const point of [stage.span.start, stage.span.end]) {
      if (typeof point.year === 'number') {
        push(String(point.year));
        push(`${point.year}年`);
      }
      if (typeof point.era === 'string') push(point.era);
    }
  }
  return hints.slice(0, 8);
}

/** 首稿实际使用的实体名；结构化数组只负责索引，不把身份解释固化成字段。 */
function collectResponseEntityNames(
  passage: BiographyPassageResponse,
  plan: BiographyPlan,
): string[] {
  return [...new Set([
    plan.target.name,
    ...plan.target.aliases,
    ...passage.people,
    ...passage.factions,
    ...passage.objects,
    ...passage.locations,
  ].map(value => value.trim()).filter(Boolean))];
}

/** 物品候选只来自本段结构化索引、规划全局索引与明确的物品型目标，不扫描猜词。 */
function collectPassageObjectNames(
  passage: BiographyPassageResponse,
  plan: BiographyPlan,
  previous: readonly BiographyPassageResponse[] = [],
  knownRevisionNames: readonly string[] = [],
): string[] {
  return [...new Set([
    ...passage.objects,
    ...plan.indexes.objects,
    ...previous.flatMap(item => item.objects),
    ...knownRevisionNames,
    ...(plan.target.type === 'object' ? [plan.target.name] : []),
  ].map(value => value.trim()).filter(Boolean))];
}

/** 前文物品状态只在本次传记生成中生效，不写入 Canon，也不取代当前 revision。 */
function collectPriorPassageObjectEvidence(
  passages: readonly BiographyPassageResponse[],
  plan: BiographyPlan,
  knownRevisionNames: readonly string[],
): RevisionObjectStateEvidence[] {
  return passages.flatMap(passage => collectPassageObjectStateEvidence(
    passage.content,
    collectPassageObjectNames(passage, plan, [], knownRevisionNames),
    passageEvidenceTimeScope(passage, plan),
  ));
}

/** 只解码 Canon 已确认的 generated 物品主体；目录实体保持不猜名称。 */
function collectRevisionObjectNames(
  activeEvidence: ReturnType<typeof buildActiveEvidenceView>,
): string[] {
  const prefix = 'entity:generated:';
  return [...new Set((activeEvidence.activeCanonStateFacts ?? []).flatMap(fact => {
    if (fact.predicate !== 'object_status' || !fact.subjectEntityId.startsWith(prefix)) return [];
    try {
      return [decodeURIComponent(fact.subjectEntityId.slice(prefix.length))];
    } catch {
      return [];
    }
  }).map(name => name.trim()).filter(Boolean))];
}

function passageEvidenceTimeScope(
  passage: BiographyPassageResponse,
  plan: BiographyPlan,
): string | null {
  const stage = passage.kind === 'stage'
    ? plan.stages.find(item => item.id === passage.passageId)
    : null;
  const point = passage.kind === 'origin'
    ? plan.span.start
    : passage.kind === 'status'
    ? plan.span.end
    : stage?.span.start;
  return point?.era && point.year !== null ? `${point.era}${point.year}年` : null;
}

/** 当前 revision 的自然语言事实已经由 Canon 解析器筛成 active；这里只做只读投影。 */
function collectRevisionObjectEvidence(
  activeEvidence: ReturnType<typeof buildActiveEvidenceView>,
): RevisionObjectStateEvidence[] {
  const view = activeEvidence.canonResolvedView;
  if (!view) return [];
  return [
    ...view.activeRevisionFacts.map(fact => ({
      statement: fact.statement,
      temporalScope: fact.temporalScope,
    })),
    ...(view.interventionSummaries ?? []).map(summary => ({
      statement: summary.record,
      temporalScope: summary.time ?? null,
    })),
  ];
}

/** 使用规划已经冻结的结构化时段，不从模型正文或标题反推年份。 */
function passageTimeWindow(
  block: BiographyPassageBlock,
  plan: BiographyPlan,
): PassageTimeWindow {
  const stage = block.kind === 'stage'
    ? plan.stages.find(item => item.id === block.passageId)
    : null;
  const start = block.kind === 'origin'
    ? plan.span.start
    : block.kind === 'status'
    ? plan.span.end
    : stage?.span.start;
  const end = block.kind === 'origin'
    ? plan.span.start
    : block.kind === 'status'
    ? plan.span.end
    : stage?.span.end;
  return {
    era: start?.era ?? end?.era ?? plan.span.start.era ?? plan.span.end.era ?? null,
    startYear: start?.year ?? null,
    endYear: end?.year ?? start?.year ?? null,
  };
}

/** 人物、物件与机构的既成状态都可能跨段被无意重置，默认携带名称以筛选原文句。 */
function collectPersistentContinuityNames(
  passages: readonly BiographyPassageResponse[],
): string[] {
  return [...new Set(passages.flatMap(passage => [
    ...passage.people,
    ...passage.objects,
    ...passage.factions,
  ]).map(value => value.trim()).filter(Boolean))].slice(-18);
}

/**
 * 模型偶尔会在正文里借用世界书人物，却漏填 people 数组。这里不拆句、不猜角色，
 * 只用目录中的完整规范名做逐字命中，让已知人物仍能进入一次自然语言复核。
 */
function knownNamesMentionedInPassage(
  passage: BiographyPassageResponse,
  context: BiographyContextBundle,
): string[] {
  return knownPersonNamesMentioned(passage.content, knownPersonCanonicalNames(context));
}

/** 前段原创人物即使漏填本段 people，只要正文再次逐字写出同名，也继承既成状态。 */
function priorPeopleMentionedInPassage(
  passage: BiographyPassageResponse,
  previous: readonly BiographyPassageResponse[],
): string[] {
  const priorNames = [...new Set(previous.flatMap(item => item.people)
    .map(name => name.trim()).filter(Boolean))];
  return priorNames.filter(name => passage.content.includes(name));
}

/**
 * 已知人物条目是可选素材，不是登场配额。若玩家并未点名、又不是传记目标，
 * 只要首稿借用了其名字，就交给同一次模型复核判断是否有必要且有合理到场路径。
 */
function namesBorrowedFromKnownCanon(
  names: readonly string[],
  plan: BiographyPlan,
  context: BiographyContextBundle,
): string[] {
  const targetNames = [plan.target.name, ...plan.target.aliases]
    .map(normalizeEntityName).filter(Boolean);
  // 检索 query 可能已经被扩写进相关人物名，不能拿它冒充“玩家明确点名”。
  // 这里只看玩家原话，避免检索命中了某人物后反过来豁免其身份复核。
  const directive = plan.playerDirective.raw.normalize('NFKC');
  const known = knownPersonCanonicalNames(context);
  return known.filter(knownName => {
    const normalized = normalizeEntityName(knownName);
    if (!normalized || targetNames.some(name => entityNamesMatch(name, normalized))) return false;
    if (directive.includes(knownName)) return false;
    return names.some(name => entityNamesMatch(normalizeEntityName(name), normalized));
  });
}

/**
 * 只把机器已有生卒窗口能直接证明的在场矛盾视为冲突。
 * unknown 不猜；正文提到“尚未出生”但没有把人物列为在场者时也不误触发。
 */
function impossiblePresenceNames(
  passage: BiographyPassageResponse,
  assessments: readonly StagePersonAssessment[],
): string[] {
  const present = passage.people.map(normalizeEntityName).filter(Boolean);
  return assessments
    .filter(assessment => assessment.state === 'before-birth' || assessment.state === 'after-death')
    .filter(assessment => present.some(name => entityNamesMatch(
      name,
      normalizeEntityName(assessment.name),
    )))
    .map(assessment => assessment.name);
}

function knownPersonCanonicalNames(context: BiographyContextBundle): string[] {
  const fromViews = (context.evidenceBundle.personCanonViews ?? [])
    .flatMap(view => [view.canonicalName, ...view.aliases]);
  const fromTimeline = (context.evidenceBundle.personTimeline ?? [])
    .map(entry => entry.name);
  const fromCast = (context.evidenceBundle.castManifest?.entries ?? [])
    .filter(entry => entry.identity.kinds.includes('person'))
    .flatMap(entry => [entry.identity.canonicalName, ...entry.identity.aliases]);
  const fromTitles = context.sourceIndex
    .filter(source => source.sourceType === 'mvu'
      || /^\s*(?:[【[]\s*(?:角色|人物|NPC)\s*[】\]]|(?:角色|人物|NPC)\s*[:：])/iu.test(source.title))
    .map(source => stripLeadingBracketLabels(source.title)
      .replace(/^\s*(?:角色|人物|NPC)\s*[:：]\s*/iu, '')
      .replace(/\s*(?:变量|状态|角色卡)\s*$/iu, '')
      .trim())
    .filter(name => name.length >= 2 && name.length <= 40);
  return [...new Set([...fromViews, ...fromTimeline, ...fromCast, ...fromTitles]
    .map(name => name.trim()).filter(Boolean))];
}

function stripLeadingBracketLabels(value: string): string {
  let result = value.trimStart();
  while (/^[【[][^】\]]+[】\]]/u.test(result)) {
    result = result.replace(/^[【[][^】\]]+[】\]]/u, '').trimStart();
  }
  return result;
}

function isBiographyLifecycleError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /(?:lifecycle change|Chat changed|different chat request|anchor floor changed|request was cancelled|generation was cancelled|GenerationCancelledError)/iu.test(message);
}

function mergeContextSources(...groups: ReadonlyArray<readonly ContextSource[]>): ContextSource[] {
  const merged = new Map<string, ContextSource>();
  for (const source of groups.flat()) {
    if (!merged.has(source.sourceId)) merged.set(source.sourceId, source);
  }
  return [...merged.values()];
}

function entityNamesMatch(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  return left.length >= 4 && right.length >= 4
    && (left.includes(right) || right.includes(left));
}

function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·・._—–-]+/gu, '').toLocaleLowerCase('zh-CN');
}
