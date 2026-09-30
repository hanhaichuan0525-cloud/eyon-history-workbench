import {
  EVIDENCE_BUNDLE_SCHEMA,
  RETRIEVAL_RECEIPT_SCHEMA,
  RETRIEVAL_STRATEGY_V12,
  type EvidenceBundle,
  type CastManifest,
  type KnowledgeCatalogCoverage,
  type RetrievalDecision,
  type RetrievalMode,
  type RetrievalTaskType,
  type SourceSnapshot,
  type WorldbookCorpusReceipt,
} from './contracts.ts';
import {
  attachCastPassages,
  buildCastManifest,
  buildEventFrame,
  castDesiredAnchors,
  castRequiredAnchors,
  castSourceSnapshotIds,
} from './cast.ts';
import {
  buildRetrievalIndex,
  normalizeRetrievalText,
  type RetrievalIndex,
} from './index.ts';
import {
  RETRIEVAL_TASK_PROFILES,
  type RetrievalTaskProfile,
} from './profiles.ts';
import {
  assembleEvidencePassages,
  attachClaimPassages,
} from './passages.ts';
import { stableSha256 } from './sourceSnapshot.ts';
import { buildTaskPersonArtifacts } from './characterFacts.ts';
import { buildQualifiedEvidenceView } from './qualification.ts';
import {
  assessPersonTimeline,
  describePersonLifespanWindow,
  entityTemporallyEligible,
  parseWorldTime,
  resolveLifespanFromBaseline,
} from './temporal.ts';
import { buildTaskCitationRegistry } from './citations.ts';

export interface ShadowComparison {
  legacyLogicalIds: string[];
  unifiedLogicalIds: string[];
  sharedLogicalIds: string[];
  legacyOnlyLogicalIds: string[];
  unifiedOnlyLogicalIds: string[];
}

export interface ShadowRetrievalResult {
  bundle: EvidenceBundle;
  comparison: ShadowComparison;
}

interface RankedSource {
  snapshot: SourceSnapshot;
  score: number;
  reasons: string[];
  eligible: boolean;
  strongPrimary: boolean;
  specificContentAnchor: boolean;
  rejectionReason?: 'temporal-scope-incompatible' | 'temporal-scope-unanchored';
}

export class UnifiedShadowRetrievalEngine {
  private readonly index: RetrievalIndex;

  constructor(snapshots: SourceSnapshot[]) {
    this.index = buildRetrievalIndex(snapshots);
  }

  getDiagnostics(): {
    sourceCount: number;
    claimCount: number;
    entityCount: number;
    relationCount: number;
    catalogCoverageCount: number;
    indexBuildMs: number;
  } {
    return {
      sourceCount: this.index.sources.length,
      claimCount: this.index.claims.length,
      entityCount: this.index.catalog.entities.length,
      relationCount: this.index.catalog.relations.length,
      catalogCoverageCount: this.index.catalog.coverage.length,
      indexBuildMs: this.index.buildDurationMs,
    };
  }

  async retrieve(input: {
    requestId: string;
    taskType: RetrievalTaskType;
    query: string;
    contextQuery?: string;
    legacyLogicalIds?: string[];
    mode?: RetrievalMode;
    worldbookCorpusReceipt?: WorldbookCorpusReceipt;
    /**
     * 作为「疆域/地点范围」引用而非在场演员的实体名。
     * 目标纪元不可用时只降级为 warning，不触发 temporal conflict fatal。
     */
    territorialReferences?: string[];
    /** 仅作检索焦点、不自动成为 required 演员的实体名。 */
    focusEntityNames?: string[];
    /** 只有此文本中的直接实体可升级为 required 演员。 */
    castRequirementQuery?: string;
    /** 开局锁定的年龄基准时间（人物时间锚换算用）。 */
    baselineWorldTime?: string | null;
    /**
     * 显式选中的来源（如工作台「引用传记」）：用户明确要求参考，即使检索未命中
     * 也要强制入选——与全世界书/正文同池同门（sourceType/句柄/分组不变），
     * 不注入旁门、不改变引用边界。时间资格门仍生效（纪元不符的参考不进）。
     */
    forcedSourceLogicalIds?: string[];
  }): Promise<ShadowRetrievalResult> {
    const started = performance.now();
    const profile = RETRIEVAL_TASK_PROFILES[input.taskType];
    const query = normalizeRetrievalText(input.query);
    const fragments = queryFragments(input.query);
    const eventFrame = buildEventFrame(input.query, this.index.catalog);
    const castRequirementFrame = input.castRequirementQuery === undefined
      ? eventFrame
      : buildEventFrame(input.castRequirementQuery, this.index.catalog);
    const initialCastManifest = buildCastManifest(eventFrame, this.index.catalog, {
      focusEntityNames: input.focusEntityNames,
      requiredDirectEntityIds: castRequirementFrame.directEntityIds,
    });
    const requestedEras = [...new Set(eventFrame.temporalTerms.flatMap(term =>
      term.match(/[\p{Script=Han}]{2,8}纪元/gu) ?? []))];
    const territorialNames = new Set(
      (input.territorialReferences ?? []).map(normalizeRetrievalText),
    );
    const territorialWarnings: string[] = [];
    if ((input.mode ?? 'shadow') === 'active' && requestedEras.length === 1) {
      const directConflicts = eventFrame.directEntityIds.flatMap(entityId =>
        this.index.catalog.entities.find(entity => entity.entityId === entityId) ?? [])
        .filter(entity => !entityTemporallyEligible(
          entity,
          requestedEras[0],
          this.index.catalog.temporalEligibility,
        ));
      // 时间冲突不再致命：一律降级为 warning，由模型基于时代画像合理处理
      // （异界来源/疆域语义/时间错位锚），保证任务不截断。
      for (const entity of directConflicts) {
        const territorial = territorialNames.has(normalizeRetrievalText(entity.canonicalName));
        territorialWarnings.push(
          `${entity.canonicalName} is unavailable in ${requestedEras[0]}; `
          + (territorial
            ? 'treated as territorial reference, not a present actor'
            : 'temporal conflict degraded to warning: model must justify its presence or treat it as an anachronism'),
        );
      }
    }
    const castSnapshotIds = castSourceSnapshotIds(initialCastManifest);
    const directlyNamedSnapshotIds = new Set(eventFrame.directEntityIds.flatMap(entityId =>
      this.index.catalog.entities.find(entity => entity.entityId === entityId)?.sourceSnapshotIds ?? []));
    const matchedEntities = [...this.index.entities.keys()]
      .filter(entity => fragments.some(fragment =>
        fragment.includes(entity) || entity.includes(fragment)));
    const ranked = this.index.sources.map(source => {
      const item = rankDirect(
        source.snapshot,
        source.normalizedTitle,
        source.searchTerms,
        source.strongSearchTerms,
        query,
        fragments,
        this.index.entities,
      );
      item.eligible = item.score > 0 && (
        !profile.strongPrimarySourceTypes.includes(item.snapshot.sourceType)
        || item.strongPrimary
      );
      return item;
    });
    const bySnapshotId = new Map(ranked.map(item => [item.snapshot.snapshotId, item]));
    // 显式选中的来源（如「引用传记」）：检索未命中也强制入选（开门加分）。
    // 与 cast boost 同级后的确定性通道；时间资格门照常在下方 applyTemporalSourceGate 生效。
    const forcedLogicalIds = new Set(input.forcedSourceLogicalIds ?? []);
    if (forcedLogicalIds.size > 0) {
      for (const source of this.index.sources) {
        if (!forcedLogicalIds.has(source.snapshot.logicalId)) continue;
        boost(
          bySnapshotId.get(source.snapshot.snapshotId),
          240,
          `forced-reference:${source.snapshot.logicalId}`,
          true,
        );
      }
    }
    for (const entityId of eventFrame.directEntityIds) {
      const entity = this.index.catalog.entities.find(candidate => candidate.entityId === entityId);
      if (!entity) continue;
      for (const snapshotId of entity?.sourceSnapshotIds ?? []) {
        boost(bySnapshotId.get(snapshotId), 520, `catalog-direct:${entity.canonicalName}`, true);
      }
    }
    for (const entry of initialCastManifest.entries) {
      if (!['group-required', 'recommended'].includes(entry.disposition)) continue;
      const score = entry.disposition === 'group-required' ? 360 : 120;
      for (const snapshotId of entry.identity.sourceSnapshotIds) {
        boost(bySnapshotId.get(snapshotId), score, `cast-${entry.disposition}:${entry.identity.canonicalName}`, true);
      }
    }
    expandRelations(this.index, profile, matchedEntities, bySnapshotId);
    applyContextSupport(this.index, ranked, input.contextQuery);
    for (const item of ranked) {
      if (!item.eligible) continue;
      const sourceWeight = profile.sourceWeights[item.snapshot.sourceType] ?? 0;
      if (sourceWeight > 0) {
        boost(item, sourceWeight, `source-priority:${item.snapshot.sourceType}`);
      }
    }
    const temporallyEssentialSnapshotIds = new Set([
      ...directlyNamedSnapshotIds,
      ...castSnapshotIds,
    ]);
    // 唯一人物的整条目可能同时记载多个时代。原文保留不等于允许人物越过生卒约束；
    // 同名跨时代的不同实体仍走原来的来源门，避免把两个身份合成一个人。
    const personNameCounts = new Map<string, number>();
    for (const entity of this.index.catalog.entities) {
      if (entity.kinds.includes('person')) personNameCounts.set(entity.normalizedName, (personNameCounts.get(entity.normalizedName) ?? 0) + 1);
    }
    const personRawSnapshotIds = new Set(this.index.catalog.entities.flatMap(entity =>
      entity.kinds.includes('person')
      && personNameCounts.get(entity.normalizedName) === 1
        ? entity.sourceSnapshotIds.filter(id => temporallyEssentialSnapshotIds.has(id)) : []));
    for (const item of ranked) {
      applyTemporalSourceGate(item, eventFrame.temporalTerms, temporallyEssentialSnapshotIds, personRawSnapshotIds);
    }

    const requiredAuthoritySnapshotIds = new Set<string>();
    for (const entry of initialCastManifest.entries) {
      if (!['required', 'group-required'].includes(entry.disposition)) continue;
      const authority = entry.identity.sourceSnapshotIds
        .flatMap(snapshotId => bySnapshotId.get(snapshotId) ?? [])
        .filter(item => item.eligible && item.score > 0)
        .sort((left, right) =>
          right.score - left.score
          || (right.snapshot.sourceOrder ?? -1) - (left.snapshot.sourceOrder ?? -1)
          || left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId))[0];
      if (authority) requiredAuthoritySnapshotIds.add(authority.snapshot.snapshotId);
    }
    if (requiredAuthoritySnapshotIds.size > profile.maxSources) {
      throw new Error('Retrieval v1.2 required cast exceeds source candidate budget');
    }

    ranked.sort((left, right) =>
      Number(requiredAuthoritySnapshotIds.has(right.snapshot.snapshotId))
      - Number(requiredAuthoritySnapshotIds.has(left.snapshot.snapshotId))
      || right.score - left.score
      || (right.snapshot.sourceOrder ?? -1) - (left.snapshot.sourceOrder ?? -1)
      || left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId));
    const selected: RankedSource[] = [];
    const rejected: RetrievalDecision[] = [];
    for (const item of ranked) {
      if (item.score <= 0) {
        rejected.push(decision(item, 'no-retrieval-signal'));
      } else if (!item.eligible) {
        rejected.push(decision(item, item.rejectionReason ?? 'insufficient-primary-anchor'));
      } else if (selected.length >= profile.maxSources) {
        rejected.push(decision(item, 'source-budget-exhausted'));
      } else {
        selected.push(item);
      }
    }

    const selectedIds = new Set(selected.map(item => item.snapshot.snapshotId));
    const selectedClaims = this.index.claims.filter(claim =>
      claim.sourceSnapshotIds.some(snapshotId => selectedIds.has(snapshotId)));
    const queryHash = await stableSha256({
      profileId: profile.id,
      passageBudget: profile.passageBudget,
      query,
      contextQuery: normalizeRetrievalText(input.contextQuery ?? ''),
      snapshotIds: this.index.sources.map(source => source.snapshot.snapshotId),
    });
    const passageStarted = performance.now();
    const desiredCoverageAnchors = castDesiredAnchors(initialCastManifest);
    const passageAssembly = await assembleEvidencePassages({
      snapshots: selected.map(item => item.snapshot),
      queryAnchors: [...fragments, ...matchedEntities, ...desiredCoverageAnchors],
      fatalCoverageAnchors: castRequiredAnchors(initialCastManifest),
      requiredSourceAnchors: initialCastManifest.entries
        .filter(entry => ['required', 'group-required'].includes(entry.disposition))
        .map(entry => ({
          anchor: entry.identity.canonicalName,
          snapshotIds: entry.identity.sourceSnapshotIds,
        })),
      claims: selectedClaims,
      budget: profile.passageBudget,
    });
    const finalPassages = passageAssembly.passages;
    const passageDurationMs = performance.now() - passageStarted;
    const passageSnapshotIds = new Set(finalPassages.map(passage => passage.snapshotId));
    const groundedSelected = ranked.filter(item => passageSnapshotIds.has(item.snapshot.snapshotId));
    const ungroundedSelected = selected.filter(item => !passageSnapshotIds.has(item.snapshot.snapshotId));
    const groundedSnapshotIds = new Set(groundedSelected.map(item => item.snapshot.snapshotId));
    const groundedSelectedClaims = this.index.claims.flatMap(claim => {
      const sourceSnapshotIds = claim.sourceSnapshotIds.filter(id => groundedSnapshotIds.has(id));
      return sourceSnapshotIds.length > 0 ? [{ ...claim, sourceSnapshotIds }] : [];
    });
    const claims = attachClaimPassages(groundedSelectedClaims, finalPassages);
    const castManifest = attachCastPassages(initialCastManifest, finalPassages);
    const conflictGroupIds = [...new Set(claims.flatMap(claim =>
      claim.conflictGroupId ? [claim.conflictGroupId] : []))].sort();
    const personTimeline = buildPersonTimeline(
      this.index.catalog.entities,
      requestedEras[0] ?? null,
      input.baselineWorldTime ?? null,
      input.query,
    );
    const personArtifacts = await buildTaskPersonArtifacts({
      taskType: input.taskType,
      query: input.query,
      entities: this.index.catalog.entities,
      snapshots: this.index.sources.map(source => source.snapshot),
      eventFrame,
      castManifest,
    });
    const qualifiedEvidence = buildQualifiedEvidenceView({
      taskType: input.taskType,
      frame: eventFrame,
      castManifest,
      passages: finalPassages,
      claims,
      catalog: this.index.catalog,
      requestedLocations: input.territorialReferences,
    });
    const citationRegistry = buildTaskCitationRegistry({
      passages: finalPassages,
      personCanonViews: personArtifacts.personCanonViews,
      sourceSnapshots: groundedSelected.map(item => item.snapshot),
    });
    const bundle: EvidenceBundle = {
      schema: EVIDENCE_BUNDLE_SCHEMA,
      requestId: input.requestId,
      taskType: input.taskType,
      query: input.query,
      sourceSnapshots: groundedSelected.map(item => item.snapshot),
      passages: finalPassages,
      claims,
      conflictGroupIds,
      catalogCoverage: this.index.catalog.coverage,
      temporalEligibility: this.index.catalog.temporalEligibility,
      eventFrame,
      castManifest,
      personTimeline: personTimeline.length > 0 ? personTimeline : undefined,
      personCanonViews: personArtifacts.personCanonViews.length > 0
        ? personArtifacts.personCanonViews
        : undefined,
      taskAnchorAttachments: personArtifacts.taskAnchorAttachments.length > 0
        ? personArtifacts.taskAnchorAttachments
        : undefined,
      qualifiedEvidence,
      citationRegistry,
      receipt: {
        schema: RETRIEVAL_RECEIPT_SCHEMA,
        requestId: input.requestId,
        mode: input.mode ?? 'shadow',
        taskType: input.taskType,
        profileId: profile.id,
        strategyVersion: RETRIEVAL_STRATEGY_V12,
        queryHash,
        candidateSnapshotIds: this.index.sources.map(source => source.snapshot.snapshotId),
        selected: groundedSelected.map(item => decision(
          item,
          item.reasons.length > 0 ? item.reasons.join(';') : 'passage-evidence',
        )),
        rejected: [
          ...rejected.filter(item => !groundedSnapshotIds.has(item.snapshotId)),
          ...ungroundedSelected.map(item => decision(item, 'passage-budget-exhausted')),
        ],
        passageBudget: {
          ...profile.passageBudget,
          usedChars: finalPassages.reduce((sum, passage) => sum + passage.charCount, 0),
        },
        selectedPassages: finalPassages.map(passage => ({
          snapshotId: passage.snapshotId,
          startOffset: passage.startOffset,
          endOffset: passage.endOffset,
          passageId: passage.passageId,
          contentHash: passage.contentHash,
          sectionPath: passage.sectionPath,
          extractionMode: passage.extractionMode,
          matchedAnchors: passage.matchedAnchors,
          temporalScopes: passage.temporalScopes,
          reason: passage.selectionReasons.join(';'),
          charCount: passage.charCount,
        })),
        rejectedPassages: passageAssembly.rejected,
        warnings: [
          ...territorialWarnings,
          ...(passageAssembly.omittedAnchors.length > 0
            ? [`passage budget omitted desired anchors: ${passageAssembly.omittedAnchors.join(',')}`]
            : []),
          ...(ungroundedSelected.length > 0
            ? [`${ungroundedSelected.length} selected source(s) dropped by passage budget`]
            : []),
        ],
        omittedAnchors: passageAssembly.omittedAnchors,
        passageDurationMs,
        fallback: 'none',
        durationMs: performance.now() - started,
        catalog: {
          schema: this.index.catalog.schema,
          catalogHash: await stableSha256({
            entities: this.index.catalog.entities.map(entity => [
              entity.entityId,
              entity.sourceSnapshotIds,
              entity.characterFacts?.facts.map(fact => fact.factId) ?? [],
            ]),
            relations: this.index.catalog.relations.map(relation => relation.relationId),
            temporalEligibility: this.index.catalog.temporalEligibility,
            coverage: this.index.catalog.coverage,
          }),
          entityCount: this.index.catalog.entities.length,
          relationCount: this.index.catalog.relations.length,
          temporalRuleCount: this.index.catalog.temporalEligibility.rules.length,
          coverage: catalogCoverageCounts(this.index.catalog.coverage),
        },
        cast: castReceipt(castManifest),
        personCanon: {
          viewCount: personArtifacts.personCanonViews.length,
          requiredFactIds: [...new Set(personArtifacts.personCanonViews.flatMap(view =>
            view.requiredFactIds))].sort(),
          attachments: personArtifacts.taskAnchorAttachments.map(attachment => ({
            attachmentId: attachment.attachmentId,
            snapshotId: attachment.snapshotId,
            contentHash: attachment.contentHash,
            charCount: attachment.charCount,
          })),
        },
        qualification: {
          schema: qualifiedEvidence.schema,
          passageCount: qualifiedEvidence.passages.length,
          stageEligiblePassageIds: qualifiedEvidence.passages
            .filter(item => item.allowedUses.includes('stage'))
            .map(item => item.passageId),
          externalPassageIds: qualifiedEvidence.passages
            .filter(item => item.geographic.fit === 'external')
            .map(item => item.passageId),
          details: qualifiedEvidence.passages.map(item => structuredClone(item)),
        },
        ...(input.worldbookCorpusReceipt
          ? { worldbookCorpus: input.worldbookCorpusReceipt }
          : {}),
      },
    };
    return {
      bundle,
      comparison: compareLogicalIds(
        input.legacyLogicalIds ?? [],
        groundedSelected.map(item => item.snapshot.logicalId),
      ),
    };
  }
}

/**
 * 强匹配词判定（独证资格）：≥3 字（专名/词组，如「荷马史诗」）或目录实体名
 * （任意长度，如「玲山」「翼民」——实体资格来自索引提取的标题/别名/字段/关系）。
 * 2 字非实体词为弱词（如「史诗」「品质」），不能独立成证，必须共证。
 */
function isStrongMatchTerm(term: string, entityNames: ReadonlyMap<unknown, unknown>): boolean {
  return term.length >= 3 || entityNames.has(term);
}

/**
 * 检索信号分级（共证门）：强词可独立开门；2 字非实体弱词必须与
 * 强词/正文命中佐证，或 ≥2 个弱词互证，才能计分与开门。
 * 目的：堵住「补充方向『英雄史诗』→ 装备品质条目（关键词『史诗』）」这类
 * 同形泛词污染（indexed-term 裸子串 + strongSearchTerms 开门的历史路径），
 * 同时保全「史诗品质装备」（三弱词互证）与「荷马史诗」（4 字长词）等真实需求。
 */
function rankDirect(
  snapshot: SourceSnapshot,
  normalizedTitle: string,
  searchTerms: string[],
  strongSearchTerms: string[],
  query: string,
  fragments: string[],
  entityNames: ReadonlyMap<unknown, unknown>,
): RankedSource {
  let score = 0;
  const reasons: string[] = [];
  let strongPrimary = false;
  const strongSet = new Set(strongSearchTerms);
  // 标题直中：强标题（实体/≥3 字）独立开门；弱标题（2 字非实体）只留痕迹不设分。
  const titleHit = normalizedTitle.length >= 2 && query.includes(normalizedTitle);
  if (titleHit && isStrongMatchTerm(normalizedTitle, entityNames)) {
    score += 140;
    strongPrimary = true;
    reasons.push('title-exact-in-query');
  } else if (titleHit) {
    reasons.push('title-weak-in-query');
  }
  // 索引词命中分组：强词 vs 弱词（弱词=2 字非实体泛词，如「史诗」「品质」）。
  const strongMatched: string[] = [];
  const weakMatched: string[] = [];
  for (const term of searchTerms) {
    if (!query.includes(term)) continue;
    if (isStrongMatchTerm(term, entityNames)) strongMatched.push(term);
    else weakMatched.push(term);
  }
  if (strongMatched.length > 0) {
    score += Math.min(100, strongMatched.length * 35);
    reasons.push(`indexed-term:${strongMatched.slice(0, 3).join(',')}`);
    if (strongMatched.some(term => strongSet.has(term))) strongPrimary = true;
  }
  const normalizedContent = normalizeRetrievalText(snapshot.content);
  const contentHits = independentContentHits(
    fragments.filter(fragment => normalizedContent.includes(fragment)),
  );
  if (contentHits.length > 0) {
    // 一个长复合锚（如完整事件名）比多个泛词更可靠。它既能打开来源，
    // 也避免“必须同时命中两个短词”把真正的事件条目挡在门外。
    score += Math.min(140, contentHits.reduce(
      (total, hit) => total + Math.min(64, hit.length * 8),
      0,
    ));
    reasons.push(`content-term:${contentHits.slice(0, 3).join(',')}`);
    if (contentHits.length >= 2 || contentHits.some(hit => hit.length >= 6)) {
      strongPrimary = true;
    }
  }
  // 弱词佐证规则（共证门核心）：2 字非实体泛词不能独自成证——
  // 需强词/正文命中佐证（说明查询有更具体的主目标），或 ≥2 个弱词互证
  // （说明查询本身把该条目编码为多个维度，如「史诗品质装备」）。
  const weakDistinct = [...new Set(weakMatched)];
  if (weakDistinct.length > 0) {
    const witnessed = strongMatched.length > 0
      || contentHits.length > 0
      || weakDistinct.length >= 2;
    if (witnessed) {
      score += Math.min(45, weakDistinct.length * 15);
      reasons.push(`indexed-weak:${weakDistinct.slice(0, 3).join(',')}`);
      if (
        weakDistinct.length >= 2
        && strongMatched.length === 0
        && contentHits.length === 0
      ) {
        // 多弱词互证：查询多词同中一条目关键词（如「史诗品质装备」连中三词），
        // 是与单弱词歧义完全不同的强信号，允许开门。
        strongPrimary = true;
      }
    }
  }
  return {
    snapshot,
    score,
    reasons,
    eligible: false,
    strongPrimary,
    specificContentAnchor: contentHits.some(hit => hit.length >= 6),
  };
}

function applyContextSupport(
  index: RetrievalIndex,
  ranked: RankedSource[],
  contextQuery: string | undefined,
): void {
  if (!contextQuery?.trim()) return;
  const normalizedContext = normalizeRetrievalText(contextQuery);
  const fragments = queryFragments(contextQuery);
  for (let indexPosition = 0; indexPosition < ranked.length; indexPosition += 1) {
    const item = ranked[indexPosition];
    if (!item.eligible) continue;
    const source = index.sources[indexPosition];
    const support = rankDirect(
      item.snapshot,
      source.normalizedTitle,
      source.searchTerms,
      source.strongSearchTerms,
      normalizedContext,
      fragments,
      index.entities,
    );
    const supportScore = Math.min(30, Math.round(support.score * 0.2));
    if (supportScore <= 0) continue;
    boost(item, supportScore, `context-support:${support.reasons[0] ?? 'matched'}`);
  }
}

function applyTemporalSourceGate(
  item: RankedSource,
  temporalTerms: string[],
  essentialSnapshotIds: Set<string>,
  personRawSnapshotIds: Set<string>,
): void {
  if (!item.eligible) return;
  const requestedEras = extractEraTerms(temporalTerms.join('\n'));
  if (!requestedEras.length) return;
  const sourceEras = extractEraTerms(`${item.snapshot.title}\n${item.snapshot.content}`);
  if (requestedEras.some(era => sourceEras.includes(era))) return;
  if (personRawSnapshotIds.has(item.snapshot.snapshotId)) {
    item.reasons.push('person-raw-temporal-reference');
    return;
  }
  if (sourceEras.length > 0) {
    item.eligible = false;
    item.rejectionReason = 'temporal-scope-incompatible';
    return;
  }
  // 来源没有写纪元名，但完整复合锚已经在本地打开了来源时，保留为高召回
  // 候选；其真实年代与用途仍由 passage qualification 判定，不能在来源门提前删除。
  if (item.specificContentAnchor) return;
  if (essentialSnapshotIds.has(item.snapshot.snapshotId)) return;
  item.eligible = false;
  item.rejectionReason = 'temporal-scope-unanchored';
}

function extractEraTerms(value: string): string[] {
  return [...new Set(value.match(/[\p{Script=Han}]{2,8}纪元/gu) ?? [])];
}

function expandRelations(
  index: RetrievalIndex,
  profile: RetrievalTaskProfile,
  initialEntities: string[],
  ranked: Map<string, RankedSource>,
): void {
  let frontier = new Set(initialEntities);
  const visited = new Set(initialEntities);
  for (let depth = 1; depth <= profile.maxRelationDepth && frontier.size > 0; depth += 1) {
    const next = new Set<string>();
    for (const claim of index.claims) {
      const subject = normalizeRetrievalText(claim.subject);
      const object = normalizeRetrievalText(claim.object);
      const fromSubject = frontier.has(subject);
      const fromObject = frontier.has(object);
      if (!fromSubject && !fromObject) continue;
      const neighbor = fromSubject ? object : subject;
      const weight = profile.relationWeights[claim.predicate] ?? 0.5;
      const relationScore = Math.round((90 / depth) * weight);
      for (const sourceId of claim.sourceSnapshotIds) {
        boost(ranked.get(sourceId), relationScore, `relation-${depth}:${claim.predicate}`, true);
      }
      for (const sourceId of index.entities.get(neighbor) ?? []) {
        boost(ranked.get(sourceId), Math.round(relationScore * 0.8), `entity-${depth}:${neighbor}`, true);
      }
      if (!visited.has(neighbor)) next.add(neighbor);
    }
    for (const entity of next) visited.add(entity);
    frontier = next;
  }
}

function boost(
  item: RankedSource | undefined,
  score: number,
  reason: string,
  opensGate = false,
): void {
  if (!item) return;
  item.score += score;
  if (opensGate) item.eligible = true;
  if (!item.reasons.includes(reason)) item.reasons.push(reason);
}

function queryFragments(value: string): string[] {
  const stripped = value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/(?:请|帮我|检索|查询|生成|寻找|历史资料|相关资料|当前世界)/gu, ' ');
  const coarse = stripped
    .split(/[\s，,。；;：:、!?！？|/]+/u)
    .map(term => term.trim())
    .filter(Boolean);
  const fragments = new Set<string>();
  for (const segment of coarse) {
    addQueryFragment(fragments, segment);
    for (const part of segment.split(
      /(?:所作(?:的)?|关于|相关|以及|或者|并且|其中|其他|的|对|与|和|及|在|于|从|至|到|为|时)/u,
    )) {
      addQueryFragment(fragments, part);
    }
  }
  return [...fragments];
}

const QUERY_FRAGMENT_STOPWORDS = new Set([
  '历史',
  '资料',
  '归属',
  '关系',
  '人物',
  '组织',
  '势力',
  '时期',
  '当前',
  '世界',
  '全境',
  '神明',
  '纪元',
  '大陆',
  '其他',
  '探索',
  '墟境',
  '墟境探索',
  '史诗',
  '史诗感',
  '传奇感',
  '悲剧感',
  '群像',
  '英雄群像',
  '有趣',
  'by',
  'the',
  'exp',
  'expand',
  'retry',
  'context',
  'outline',
]);

function independentContentHits(fragments: string[]): string[] {
  return fragments.filter((fragment, index) => !fragments.some((candidate, candidateIndex) =>
    candidateIndex !== index
    && candidate.length > fragment.length
    && candidate.includes(fragment)));
}

function addQueryFragment(output: Set<string>, raw: string): void {
  const normalized = normalizeRetrievalText(raw);
  if (!isMeaningfulQueryFragment(normalized)) return;
  if (!QUERY_FRAGMENT_STOPWORDS.has(normalized)) output.add(normalized);
  const locationCore = normalized.replace(/(?:大陆)?全境$/u, '').replace(/大陆$/u, '');
  if (locationCore.length >= 2 && locationCore !== normalized) output.add(locationCore);
  const namedCore = normalized
    .replace(/^(?:狡黠|智慧|幸运|旅途|战争|命运|月亮|太阳)?(?:女神|男神|神祇|神明|人物|组织|势力|地点|家族)/u, '')
    .replace(/^其他/u, '');
  if (
    namedCore.length >= 2
    && namedCore !== normalized
    && !QUERY_FRAGMENT_STOPWORDS.has(namedCore)
  ) output.add(namedCore);
}

function isMeaningfulQueryFragment(value: string): boolean {
  if (value.length < 2 || value.length > 24) return false;
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  if (/^[\d\s年月日时分秒:：.,，.\-—_/]+$/u.test(value)) return false;
  if (QUERY_FRAGMENT_STOPWORDS.has(value)) return false;
  // Three-letter ASCII fragments in workflow IDs (exp/by/the) are usually
  // transport noise. Keep longer English proper names and mixed-script names.
  if (/^[a-z]{2,3}$/u.test(value)) return false;
  return true;
}

function decision(item: RankedSource, reason: string): RetrievalDecision {
  return {
    snapshotId: item.snapshot.snapshotId,
    reason,
    score: item.score,
  };
}

function compareLogicalIds(legacyIds: string[], unifiedIds: string[]): ShadowComparison {
  const legacy = [...new Set(legacyIds)].sort();
  const unified = [...new Set(unifiedIds)].sort();
  const legacySet = new Set(legacy);
  const unifiedSet = new Set(unified);
  return {
    legacyLogicalIds: legacy,
    unifiedLogicalIds: unified,
    sharedLogicalIds: legacy.filter(id => unifiedSet.has(id)),
    legacyOnlyLogicalIds: legacy.filter(id => !unifiedSet.has(id)),
    unifiedOnlyLogicalIds: unified.filter(id => !legacySet.has(id)),
  };
}

function catalogCoverageCounts(
  coverage: KnowledgeCatalogCoverage[],
): Record<'indexed' | 'partial' | 'opaque' | 'total', number> {
  return {
    total: coverage.length,
    indexed: coverage.filter(item => item.status === 'indexed').length,
    partial: coverage.filter(item => item.status === 'partial').length,
    opaque: coverage.filter(item => item.status === 'opaque').length,
  };
}

function castReceipt(manifest: CastManifest): NonNullable<EvidenceBundle['receipt']['cast']> {
  const count = (disposition: CastManifest['entries'][number]['disposition']) =>
    manifest.entries.filter(entry => entry.disposition === disposition).length;
  return {
    entryCount: manifest.entries.length,
    dispositions: {
      required: count('required'),
      'group-required': count('group-required'),
      recommended: count('recommended'),
      optional: count('optional'),
      excluded: count('excluded'),
    },
    groupsComplete: manifest.groupCoverage.every(group => group.complete),
  };
}

/**
 * 人物时间锚：对 catalog 中的 person 实体评估出生/在世/缺席。
 * 显式生卒优先；否则用开局锁定的 baselineWorldTime 做年龄换算（ageBased）。
 * 结果由引擎算好写入 bundle，模型直接遵守，不做心算。
 * 目标纪元（requestedEra）只用于「整篇在场状态判定」（墟境等固定纪元任务）。
 * 传记等自由纪元任务的指令可能不含纪元名（目标纪元由模型在 plan 里规划）——
 * 此时**不再早退**：窗口输出（lifespan/lifeAnchors）与目标纪元无关，照常注入，
 * 各段在场与年龄由扩写阶段的区间相交（assessStagePerson）按段起止年份另行判定；
 * state 无法判定 → unknown。
 * 红线：绝不把 baselineWorldTime 的纪元冒充目标纪元去判状态（会输出错误纪元）。
 */
function buildPersonTimeline(
  entities: import('./contracts.ts').KnowledgeEntity[],
  requestedEra: string | null,
  baselineWorldTime: string | null,
  query: string,
): NonNullable<EvidenceBundle['personTimeline']> {
  // 从查询提取目标纪元的具体年份（如「复兴纪元310年」→ 310），用于 in-era 判定。
  const requestedPoint = requestedEra
    ? parseWorldTime(query.slice(query.indexOf(requestedEra))) : { era: null, year: null };
  const targetYear = requestedPoint.era === requestedEra ? requestedPoint.year : null;
  const output: NonNullable<EvidenceBundle['personTimeline']> = [];
  for (const entity of entities) {
    if (!entity.kinds.includes('person')) continue;
    const lifespan = resolveLifespanFromBaseline(entity, baselineWorldTime);
    const effective = lifespan ?? entity.lifespan;
    if (!effective?.born && !effective?.ageAtRecord) continue;
    const assessment = requestedEra
      ? assessPersonTimeline(
          { ...entity, lifespan: effective },
          requestedEra,
          targetYear,
        )
      : null;
    output.push({
      name: entity.canonicalName,
      state: assessment?.state ?? 'unknown',
      narrative: assessment?.narrative
        ?? describePersonLifespanWindow(entity.canonicalName, effective),
      // 机器可读生卒/抵达窗口：时期分区逐段推断在场与年龄用（personAvailabilityLine/assessStagePerson）。
      lifespan: effective,
      // 人物事件证据：保留事实本身，不把数组顺序冒充历史顺序。
      lifeAnchors: entity.lifeAnchors,
      // P0-C：只有带证据的关系边能约束 chronology；事件数组顺序本身无语义。
      eventRelations: entity.characterFacts?.eventRelations,
    });
  }
  // 同名实体（MVU 与 worldbook 双源）去重：保留信息最全的条目，避免渲染/匹配取到
  // 「无生卒」的那份导致人物时间锚整链失效。
  const byName = new Map<string, NonNullable<EvidenceBundle['personTimeline']>[number]>();
  for (const entry of output) {
    const key = entry.name.normalize('NFKC').replace(/\s+/gu, '');
    const existing = byName.get(key);
    const entryScore = personTimelineInfoScore(entry);
    if (!existing || entryScore > personTimelineInfoScore(existing)) byName.set(key, entry);
  }
  return [...byName.values()];
}

function personTimelineInfoScore(
  entry: NonNullable<EvidenceBundle['personTimeline']>[number],
): number {
  let score = 0;
  if (entry.lifespan?.born) score += 2;
  if (entry.lifespan) score += 1;
  if (entry.lifeAnchors?.length) score += 1;
  return score;
}
