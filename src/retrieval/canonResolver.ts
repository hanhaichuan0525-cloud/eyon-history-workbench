import {
  CANON_RESOLVED_VIEW_SCHEMA,
  type CanonBaseView,
  type CanonBranch,
  type CanonEventRelation,
  type CanonFact,
  type CanonInactiveFact,
  type CanonPassageView,
  type CanonQueryScope,
  type CanonResolutionBranch,
  type CanonResolvedView,
  type CanonTimeInterval,
  type EvidenceBundle,
  type EvidenceClaim,
  type EvidencePassage,
  type KnowledgeEntity,
  type PersonCanonView,
} from './contracts.ts';
import {
  operationRebaseState,
  projectCanonCausalRebase,
} from '../core/causalRebase.ts';
import { projectContinuousStates } from './continuousState.ts';
import {
  assessPersonTimeline,
  describePersonLifespanWindow,
} from './temporal.ts';

/**
 * P1-1 唯一当前视图。纯确定性、只读、无模型、无网络；所有输出均为新对象。
 */
export function resolveCanon(
  sourceBranch: CanonResolutionBranch,
  revision: number,
  sourceScope: CanonQueryScope,
): CanonResolvedView {
  const branch = structuredClone(sourceBranch);
  const queryScope = normalizeQueryScope(sourceScope);
  assertValidRequest(branch, revision);

  const queryScopeHash = fingerprint(stableJson(queryScope));
  const baseFactById = new Map(branch.baseCanon.facts.map(fact => [fact.factId, fact]));
  const interventionFactById = new Map(branch.deltas.flatMap(delta =>
    delta.operations.map(operation => [operation.current.factId, operation.current] as const)));
  const dependencyFactIds = new Set(branch.deltas
    .filter(delta => delta.revision <= revision)
    .flatMap(delta => [
      ...delta.preconditionFactIds,
      ...delta.operations.flatMap(operation => operation.originalFactIds),
    ]));
  const activeFacts = new Map<string, CanonFact>();
  for (const fact of branch.baseCanon.facts) {
    if (dependencyFactIds.has(fact.factId) || factMatchesQuery(fact, queryScope)) {
      activeFacts.set(fact.factId, normalizeBaseFact(fact));
    }
  }

  const inactiveFacts: CanonInactiveFact[] = [];
  const uncertainItems: string[] = [];
  const appliedDeltaIds: string[] = [];
  const skippedDeltaIds: string[] = [];
  const supersededDeltaIds: string[] = [];
  const activeRevisionByNumber = new Map(branch.revisions
    .filter(item => item.status === 'active' && item.revision <= revision)
    .map(item => [item.revision, item]));
  const causalRebase = projectCanonCausalRebase({ ...branch, headRevision: revision });
  const factKeyByFactId = new Map<string, string>();
  const knownSourceIds = new Set([
    ...branch.baseCanon.sourceSnapshots.flatMap(snapshot => [snapshot.logicalId, snapshot.snapshotId]),
    ...branch.actions.flatMap(action => action.sourceRefs),
  ]);

  const deltas = [...branch.deltas]
    .filter(delta => delta.revision <= revision)
    .sort((left, right) => left.revision - right.revision || left.deltaId.localeCompare(right.deltaId));
  for (const delta of deltas) {
    const revisionRecord = activeRevisionByNumber.get(delta.revision);
    if (!revisionRecord || revisionRecord.deltaId !== delta.deltaId
      || delta.branchId !== branch.branchId || delta.status === 'reverted' || !delta.verified) {
      skippedDeltaIds.push(delta.deltaId);
      if (revisionRecord && (!delta.verified || delta.status === 'reverted')) {
        uncertainItems.push(`${delta.deltaId}: inactive-or-unverified-delta`);
      }
      continue;
    }
    const scopeMatch = deltaMatchesQuery(delta.cascadeScope, queryScope);
    // State intervals outlive an occurrence window. Keep the entity/place gate,
    // and expose only dated state operations outside that occurrence window.
    const stateOnly = scopeMatch !== 'inside' && delta.operations.some(op => !!op.current.continuousState)
      && deltaMatchesQuery({ ...delta.cascadeScope, time: undefined }, queryScope) === 'inside';
    if (scopeMatch === 'outside' && !stateOnly) {
      skippedDeltaIds.push(delta.deltaId);
      continue;
    }
    if (scopeMatch === 'unknown' && !stateOnly) {
      skippedDeltaIds.push(delta.deltaId);
      uncertainItems.push(`${delta.deltaId}: undecidable-query-scope`);
      continue;
    }

    const action = branch.actions.find(item => item.actionId === delta.actionRef);
    let appliedOperations = 0;
    for (const [operationIndex, operation] of delta.operations.entries()) {
      if (stateOnly && !operation.current.continuousState) continue;
      const label = `${delta.deltaId}/operation-${operationIndex + 1}`;
      const rebaseState = causalRebase.status === 'bounded-overflow'
        ? legacyOperationState(delta.status)
        : operationRebaseState(causalRebase, {
          deltaId: delta.deltaId,
          factKey: operation.factKey,
        }) ?? 'uncertain';
      if (rebaseState !== 'active') {
        if (rebaseState === 'uncertain') {
          uncertainItems.push(`${label}: causal-rebase-uncertain`);
        } else if (operation.op !== 'retract') {
          inactiveFacts.push({
            fact: { ...operation.current, revisionRetired: delta.revision },
            retiredByDeltaId: delta.deltaId,
            reason: `causal-rebase:${rebaseState}`,
          });
        }
        continue;
      }
      if (!operation.factKey.trim() || !validFact(operation.current)) {
        uncertainItems.push(`${label}: malformed-operation`);
        continue;
      }
      const traceable = operation.current.sourceRefs.some(sourceRef =>
        knownSourceIds.has(sourceRef) || action?.sourceRefs.includes(sourceRef));
      if (!traceable) {
        uncertainItems.push(`${label}: untraceable-operation-source`);
        continue;
      }
      const originalFacts = operation.originalFactIds.map(id =>
        activeFacts.get(id) ?? baseFactById.get(id) ?? interventionFactById.get(id));
      if (operation.op !== 'assert'
        && (operation.originalFactIds.length === 0 || originalFacts.some(fact => !fact))) {
        uncertainItems.push(`${label}: missing-original-fact`);
        continue;
      }
      if (originalFacts.some(fact => fact && !factKeyCompatible(operation.factKey, fact))) {
        uncertainItems.push(`${label}: fact-key-mismatch`);
        continue;
      }

      if (operation.op === 'replace' || operation.op === 'retract') {
        const retireIds = new Set(operation.originalFactIds);
        if (operation.op === 'replace') {
          for (const [factId, factKey] of factKeyByFactId) {
            if (factKey === operation.factKey) retireIds.add(factId);
          }
        }
        for (const factId of retireIds) {
          const fact = activeFacts.get(factId);
          if (!fact) continue;
          activeFacts.delete(factId);
          factKeyByFactId.delete(factId);
          inactiveFacts.push({
            fact: { ...fact, revisionRetired: delta.revision },
            retiredByDeltaId: delta.deltaId,
            reason: `${operation.op}:${operation.factKey}`,
          });
        }
      }
      if (operation.op !== 'retract') {
        const current = normalizeCurrentFact(operation.current, delta.revision);
        activeFacts.set(current.factId, current);
        factKeyByFactId.set(current.factId, operation.factKey);
      }
      appliedOperations += 1;
    }
    if (appliedOperations === 0) {
      skippedDeltaIds.push(delta.deltaId);
      continue;
    }
    appliedDeltaIds.push(delta.deltaId);
    supersededDeltaIds.push(...delta.supersedesDeltaIds);
  }

  const sortedActiveFacts = sortFacts([...activeFacts.values()]);
  const activeFactIds = new Set(sortedActiveFacts.map(fact => fact.factId));
  const eventRelations = uniqueRelations(branch.baseCanon.eventRelations)
    .filter(relation => activeFactIds.has(relation.fromFactId)
      && activeFactIds.has(relation.toFactId));
  const personViews = projectPersonViews(
    branch.baseCanon.personViews,
    sortedActiveFacts,
    eventRelations,
  );
  const passageViews = projectPassageViews(
    branch.baseCanon.passages,
    sortedActiveFacts,
    inactiveFacts,
  );
  const receipt = {
    schema: 'eyon.canon.resolve-receipt.v1' as const,
    branchId: branch.branchId,
    requestedRevision: revision,
    resolvedRevision: revision,
    queryScopeHash,
    appliedDeltaIds: unique(appliedDeltaIds),
    skippedDeltaIds: unique(skippedDeltaIds),
    supersededDeltaIds: unique(supersededDeltaIds),
    uncertainItems: unique(uncertainItems),
  };
  const viewIdentity = stableJson({
    branchId: branch.branchId,
    revision,
    queryScopeHash,
    activeFacts: sortedActiveFacts.map(fact => [
      fact.factId,
      fact.subjectEntityId,
      fact.predicate,
      fact.object,
      fact.temporalScope,
      fact.spatialScope,
      fact.revisionIntroduced,
      fact.continuousState,
    ]),
    inactiveFacts: inactiveFacts.map(item => [
      item.fact.factId,
      item.retiredByDeltaId,
      item.fact.revisionRetired,
    ]),
    receipt,
  });
  // F-02 v5：本次命中干涉的行动摘要（actionRecord 人话断言）——事实卡之外的
  // 「谁在何时何地做了什么」，注入视图供模型采用。
  const appliedDeltaByRef = new Map(branch.deltas
    .filter(delta => appliedDeltaIds.includes(delta.deltaId)
      && deltaMatchesQuery(delta.cascadeScope, queryScope) === 'inside')
    .map(delta => [delta.actionRef, delta]));
  const interventionSummaries = branch.actions
    .filter(action => appliedDeltaByRef.has(action.actionId))
    .map(action => {
      const delta = appliedDeltaByRef.get(action.actionId);
      return {
        revision: delta?.revision ?? 0,
        record: (action.actionRecord ?? '').slice(0, 240),
        time: action.occurredAt?.label,
        locations: delta?.cascadeScope.locations ?? [],
      };
    })
    .filter(item => item.record.length > 0)
    .sort((left, right) => left.revision - right.revision);
  return {
    schema: CANON_RESOLVED_VIEW_SCHEMA,
    viewId: `canon-view:${fingerprint(viewIdentity)}`,
    branchId: branch.branchId,
    requestedRevision: revision,
    resolvedRevision: revision,
    queryScopeHash,
    activeFacts: sortedActiveFacts,
    continuousStates: projectContinuousStates(sortedActiveFacts),
    inactiveFacts: inactiveFacts
      .sort((left, right) => left.fact.factId.localeCompare(right.fact.factId)),
    uncertainItems: receipt.uncertainItems,
    eventRelations,
    personViews,
    passageViews,
    resolutionReceipt: receipt,
    ...(interventionSummaries.length > 0 ? { interventionSummaries } : {}),
  };
}

function legacyOperationState(
  status: CanonResolutionBranch['deltas'][number]['status'],
): 'active' | 'superseded' | 'orphaned' | 'uncertain' | 'reverted' {
  if (status === 'active' || status === 'partially-active') return 'active';
  return status;
}

/** 把当前任务的已召回 revision 0 事实附着到分支，不修改仓库存档。 */
export function canonResolutionBranch(
  branch: CanonBranch,
  bundle: EvidenceBundle,
): CanonResolutionBranch {
  return {
    ...structuredClone(branch),
    baseCanon: buildBaseCanon(bundle),
  };
}

/** EvidenceBundle 已经完成检索收口；queryScope 只描述该 Bundle 的边界。 */
export function canonQueryScopeFromBundle(bundle: EvidenceBundle): CanonQueryScope {
  const castEntries = bundle.castManifest?.entries ?? [];
  const personViews = bundle.personCanonViews ?? [];
  return normalizeQueryScope({
    subjectEntityIds: unique([
      ...personViews.map(view => view.entityId),
      ...castEntries.map(entry => entry.entityId),
    ]),
    temporalScopes: unique([
      ...(bundle.qualifiedEvidence?.requestedScope.eras ?? []),
    ]),
    spatialScopes: unique([
      ...(bundle.qualifiedEvidence?.requestedScope.locations ?? []),
    ]),
    sourceIds: unique(bundle.sourceSnapshots.flatMap(snapshot => [
      snapshot.logicalId,
      snapshot.snapshotId,
    ])),
    // F-02：查询侧名称集合（人物视图/角色编排/时间锚的正式名与别名），
    // 供 generated 叙事实体按名称投递；不引入 passage 正文噪声。
    names: unique([
      ...personViews.flatMap(view => [view.canonicalName, ...(view.aliases ?? [])]),
      ...castEntries.flatMap(entry => [
        entry.identity.canonicalName,
        ...(entry.identity.aliases ?? []),
      ]),
      ...(bundle.personTimeline ?? []).map(item => item.name),
    ]),
  });
}

/** 将 resolver 结果放回任务 Bundle；原 SourceSnapshot 与原 passage 均保留只读。 */
export function projectEvidenceBundleCanon(
  bundle: EvidenceBundle,
  view: CanonResolvedView,
): EvidenceBundle {
  const passageStatus = new Map(view.passageViews.map(item => [item.passageId, item.status]));
  const qualifiedEvidence = bundle.qualifiedEvidence
    ? {
        ...bundle.qualifiedEvidence,
        passages: bundle.qualifiedEvidence.passages
          .filter(item => passageStatus.get(item.passageId) !== 'inactive')
          .map(item => ({
            ...item,
            revision: {
              fit: 'current' as const,
              reason: `CanonResolvedView ${view.viewId} @ revision ${view.resolvedRevision}`,
            },
          })),
      }
    : undefined;
  return {
    ...bundle,
    personCanonViews: view.personViews,
    personTimeline: projectPersonTimeline(bundle, view.personViews),
    qualifiedEvidence,
    canonResolvedView: view,
  };
}

/**
 * personTimeline 是各模块真正消费的年龄/在场窗口，不能停留在 resolveCanon 前的
 * revision 0 推导。当前视图一旦替换出生或死亡时间，这里同步重建叙事与机器值。
 */
function projectPersonTimeline(
  bundle: EvidenceBundle,
  personViews: PersonCanonView[],
): EvidenceBundle['personTimeline'] {
  const timeline = bundle.personTimeline ?? [];
  const byName = new Map<string, PersonCanonView>();
  for (const view of personViews) {
    for (const name of [view.canonicalName, ...view.aliases]) {
      byName.set(normalizeName(name), view);
    }
  }
  const requestedEra = bundle.qualifiedEvidence?.requestedScope.eras[0] ?? null;
  const yearMatch = bundle.query.match(
    /(?:创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(?:前)?\s*(\d+)\s*年/u,
  );
  const targetYear = yearMatch ? Number(yearMatch[1]) : null;
  return timeline.map(item => {
    const resolved = byName.get(normalizeName(item.name));
    if (!resolved?.lifespan) return structuredClone(item);
    if (requestedEra) {
      const assessment = assessPersonTimeline(personEntity(resolved), requestedEra, targetYear);
      return {
        ...structuredClone(item),
        state: assessment.state,
        narrative: assessment.narrative,
        lifespan: structuredClone(resolved.lifespan),
      };
    }
    return {
      ...structuredClone(item),
      state: 'unknown' as const,
      narrative: describePersonLifespanWindow(resolved.canonicalName, resolved.lifespan),
      lifespan: structuredClone(resolved.lifespan),
    };
  });
}

function personEntity(view: PersonCanonView): KnowledgeEntity {
  return {
    entityId: view.entityId,
    canonicalName: view.canonicalName,
    normalizedName: normalizeName(view.canonicalName),
    aliases: view.aliases,
    kinds: ['person'],
    tags: [],
    temporalScopes: [],
    locationScopes: [],
    identities: [],
    sourceSnapshotIds: view.sourceSnapshotIds,
    spans: [],
    lifespan: view.lifespan,
  };
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function buildBaseCanon(bundle: EvidenceBundle): CanonBaseView {
  const snapshotsById = new Map(bundle.sourceSnapshots.map(snapshot => [snapshot.snapshotId, snapshot]));
  const passageById = new Map(bundle.passages.map(passage => [passage.passageId, passage]));
  const timelineByName = new Map((bundle.personTimeline ?? []).map(item => [item.name, item]));
  const personViews = (bundle.personCanonViews ?? []).map(view => {
    const timeline = timelineByName.get(view.canonicalName);
    return {
      ...structuredClone(view),
      lifespan: timeline?.lifespan ? structuredClone(timeline.lifespan) : view.lifespan,
    };
  });
  const facts: CanonFact[] = [];
  for (const view of personViews) {
    facts.push(...view.facts.map(normalizeBaseFact));
    const timelineFacts = lifespanFacts(view);
    view.facts = sortFacts(uniqueFacts([...view.facts, ...timelineFacts]));
    view.relevantFactIds = unique([...view.relevantFactIds, ...timelineFacts.map(fact => fact.factId)]);
    facts.push(...timelineFacts);
  }
  facts.push(...bundle.claims.map(claim => claimToCanonFact(
    claim,
    personViews,
    snapshotsById,
    passageById,
  )));
  return {
    facts: sortFacts(uniqueFacts(facts)),
    eventRelations: uniqueRelations(personViews.flatMap(view => view.eventRelations ?? [])),
    personViews,
    passages: structuredClone(bundle.passages),
    sourceSnapshots: structuredClone(bundle.sourceSnapshots),
  };
}

function lifespanFacts(view: PersonCanonView): CanonFact[] {
  const lifespan = view.lifespan;
  if (!lifespan) return [];
  const points = [
    [lifespan.originKind && lifespan.originKind !== 'birth' ? `${lifespan.originKind}_time` : 'birth_time', lifespan.born] as const,
    [lifespan.originKind && lifespan.originKind !== 'birth' ? 'identity_end_time' : 'death_time', lifespan.died] as const,
  ];
  return points.flatMap(([predicate, point]) => {
    if (!point?.era || !Number.isFinite(point.year)) return [];
    const existing = view.facts.find(fact => fact.predicate === predicate);
    if (existing) return [];
    const label = `${point.era}${point.year}年`;
    return [{
      factId: `fact:base-lifespan:${encodeURIComponent(view.entityId)}:${predicate}`,
      subjectEntityId: view.entityId,
      predicate,
      object: label,
      statement: `${view.canonicalName}${predicate === 'birth_time' ? '出生于' : predicate === 'death_time' ? '逝世于' : `（${lifespan.originKind ?? '身份'}时间原点）`}${label}`,
      temporalScope: label,
      spatialScope: null,
      epistemicStatus: lifespan.ageBased ? 'inferred' as const : 'structural' as const,
      confidence: lifespan.ageBased ? 'medium' as const : 'high' as const,
      sourceRefs: [...view.sourceSnapshotIds],
      sourceSnapshotIds: [...view.sourceSnapshotIds],
      sourceSpans: [],
      revisionIntroduced: 0,
      revisionRetired: null,
    }];
  });
}

function claimToCanonFact(
  claim: EvidenceClaim,
  personViews: PersonCanonView[],
  snapshotsById: Map<string, EvidenceBundle['sourceSnapshots'][number]>,
  passageById: Map<string, EvidencePassage>,
): CanonFact {
  const person = personViews.find(view =>
    [view.canonicalName, ...view.aliases].some(name => normalize(name) === normalize(claim.subject)));
  const passages = claim.sourcePassageIds.flatMap(id => passageById.get(id) ?? []);
  return {
    factId: claim.claimId,
    subjectEntityId: person?.entityId
      ?? `entity:claim:${fingerprint(normalize(claim.subject))}`,
    predicate: claim.predicate,
    object: claim.object,
    statement: `${claim.subject} ${claim.predicate} ${claim.object}`.trim(),
    temporalScope: claim.temporalScope,
    spatialScope: null,
    epistemicStatus: claim.epistemicStatus === 'explicit'
      ? 'explicit'
      : claim.epistemicStatus === 'conflicted'
        ? 'contested'
        : 'inferred',
    confidence: claim.epistemicStatus === 'explicit' ? 'high' : 'low',
    sourceRefs: unique(claim.sourceSnapshotIds.flatMap(id =>
      snapshotsById.get(id)?.logicalId ?? [])),
    sourceSnapshotIds: unique(claim.sourceSnapshotIds),
    sourceSpans: passages.map(passage => ({
      snapshotId: passage.snapshotId,
      startOffset: passage.startOffset,
      endOffset: passage.endOffset,
    })),
    revisionIntroduced: 0,
    revisionRetired: null,
  };
}

function projectPersonViews(
  baseViews: PersonCanonView[],
  activeFacts: CanonFact[],
  eventRelations: CanonEventRelation[],
): PersonCanonView[] {
  const factsByEntity = new Map<string, CanonFact[]>();
  for (const fact of activeFacts) {
    const facts = factsByEntity.get(fact.subjectEntityId) ?? [];
    facts.push(fact);
    factsByEntity.set(fact.subjectEntityId, facts);
  }
  return baseViews.map(base => {
    const facts = sortFacts(factsByEntity.get(base.entityId) ?? []);
    const factIds = new Set(facts.map(fact => fact.factId));
    return {
      ...structuredClone(base),
      requiredFactIds: base.requiredFactIds.filter(id => factIds.has(id)),
      relevantFactIds: unique([
        ...base.relevantFactIds.filter(id => factIds.has(id)),
        ...facts.filter(fact => fact.revisionIntroduced > 0).map(fact => fact.factId),
      ]),
      eventRelations: eventRelations.filter(relation =>
        factIds.has(relation.fromFactId) && factIds.has(relation.toFactId)),
      facts,
      lifespan: projectLifespan(base.lifespan, facts),
    };
  });
}

function projectLifespan(
  base: PersonCanonView['lifespan'],
  facts: CanonFact[],
): PersonCanonView['lifespan'] {
  const result = base ? structuredClone(base) : {};
  const special = base?.originKind && base.originKind !== 'birth';
  const birth = latestFact(facts, special ? `${base.originKind}_time` : 'birth_time');
  const death = latestFact(facts, special ? 'identity_end_time' : 'death_time');
  if (birth) {
    result.born = timePointFromFact(birth);
    // 新 revision 的明确出生原点已经取代旧的“基准年龄反推”；保留旧 ageBased
    // 会让下游再次把过期年龄当成权威，形成两个出生年。
    if (birth.revisionIntroduced > 0) {
      delete result.ageAtRecord;
      delete result.basedOnEra;
      delete result.basedOnYear;
      delete result.ageBased;
    }
  }
  if (death) result.died = timePointFromFact(death);
  return Object.keys(result).length > 0 ? result : undefined;
}

function latestFact(facts: CanonFact[], predicate: string): CanonFact | undefined {
  return [...facts]
    .filter(fact => fact.predicate === predicate)
    .sort((left, right) => right.revisionIntroduced - left.revisionIntroduced)[0];
}

function timePointFromFact(fact: CanonFact): { era: string; year: number } | null {
  const parsed = parseYear(fact.object) ?? parseYear(fact.temporalScope ?? '');
  return parsed ? { era: parsed.era, year: parsed.year } : null;
}

function projectPassageViews(
  passages: EvidencePassage[],
  activeFacts: CanonFact[],
  inactiveFacts: CanonInactiveFact[],
): CanonPassageView[] {
  return passages.map(passage => {
    const active = activeFacts.filter(fact => factTouchesPassage(fact, passage));
    const inactive = inactiveFacts.filter(item => factTouchesPassage(item.fact, passage));
    if (inactive.length === 0) {
      return passageView(passage, 'active', passage.content, active, [], 'no-retired-facts');
    }
    const unsafe = inactive.some(item =>
      item.fact.sourceSnapshotIds.includes(passage.snapshotId)
      && item.fact.sourceSpans.every(span => span.snapshotId !== passage.snapshotId));
    const spans = inactive.flatMap(item => item.fact.sourceSpans
      .filter(span => span.snapshotId === passage.snapshotId)
      .map(span => ({
        start: Math.max(0, span.startOffset - passage.startOffset),
        end: Math.min(passage.content.length, span.endOffset - passage.startOffset),
      })))
      .filter(span => span.end > span.start);
    if (unsafe || spans.length === 0) {
      const capsule = active.map(fact => fact.statement).filter(Boolean).join('；');
      return passageView(
        passage,
        capsule ? 'fact-capsule' : 'inactive',
        capsule,
        active,
        inactive,
        capsule ? 'unsafe-span-split-used-active-fact-capsule' : 'unsafe-span-split-no-active-facts',
      );
    }
    let content = passage.content;
    for (const span of mergeSpans(spans).sort((left, right) => right.start - left.start)) {
      content = `${content.slice(0, span.start)}${content.slice(span.end)}`;
    }
    content = content.replace(/\n{3,}/gu, '\n\n').trim();
    if (!content) {
      const capsule = active.map(fact => fact.statement).filter(Boolean).join('；');
      return passageView(
        passage,
        capsule ? 'fact-capsule' : 'inactive',
        capsule,
        active,
        inactive,
        capsule ? 'retired-span-covered-passage-used-active-fact-capsule' : 'retired-span-covered-passage',
      );
    }
    return passageView(passage, 'partial', content, active, inactive, 'retired-fact-spans-masked');
  });
}

function passageView(
  passage: EvidencePassage,
  status: CanonPassageView['status'],
  content: string,
  activeFacts: CanonFact[],
  inactiveFacts: CanonInactiveFact[],
  reason: string,
): CanonPassageView {
  return {
    passageId: passage.passageId,
    snapshotId: passage.snapshotId,
    sourceId: passage.sourceId,
    status,
    content,
    activeFactIds: unique(activeFacts.map(fact => fact.factId)),
    inactiveFactIds: unique(inactiveFacts.map(item => item.fact.factId)),
    reason,
  };
}

function factTouchesPassage(fact: CanonFact, passage: EvidencePassage): boolean {
  return fact.sourceSpans.some(span => span.snapshotId === passage.snapshotId
    && span.startOffset < passage.endOffset && span.endOffset > passage.startOffset)
    || (fact.sourceSpans.length === 0 && fact.sourceSnapshotIds.includes(passage.snapshotId));
}

function factMatchesQuery(fact: CanonFact, scope: CanonQueryScope): boolean {
  const dimensions: boolean[] = [];
  if (scope.subjectEntityIds.length > 0) {
    dimensions.push(scope.subjectEntityIds.includes(fact.subjectEntityId));
  }
  if (scope.sourceIds.length > 0) {
    dimensions.push([...fact.sourceRefs, ...fact.sourceSnapshotIds]
      .some(id => scope.sourceIds.includes(id)));
  }
  if (scope.spatialScopes.length > 0 && fact.spatialScope) {
    dimensions.push(scope.spatialScopes.some(item => sameScope(item, fact.spatialScope!)));
  }
  return dimensions.length === 0 || dimensions.some(Boolean);
}

function deltaMatchesQuery(
  scope: {
    entityIds: string[];
    time?: CanonTimeInterval;
    locations: string[];
    subjectNames?: string[];
  },
  query: CanonQueryScope,
): 'inside' | 'outside' | 'unknown' {
  const queryHasEntities = query.subjectEntityIds.length > 0;
  const scopeHasEntities = scope.entityIds.length > 0;
  const intersects = scopeHasEntities && queryHasEntities
    && scope.entityIds.some(id => query.subjectEntityIds.includes(id));
  const hasStableEntity = scopeHasEntities
    && scope.entityIds.some(id => !id.startsWith('entity:generated:'));
  // 实体闸（P1-1 语义保持）：档案稳定实体存在却未精确命中 → outside。
  if (queryHasEntities && scopeHasEntities && !intersects && hasStableEntity) {
    return 'outside';
  }
  // F-02（internal.82 覆盖）：纯 generated（无档案、无交集）叙事实体豁免实体闸，
  // 改走叙事通道——「地点或名称」任一命中才继续（单向放宽：原先恒 outside）。
  const narrativeChannel = scopeHasEntities && !hasStableEntity && !intersects;
  if (narrativeChannel) {
    const located = scope.locations.length > 0 && query.spatialScopes.length > 0
      && scope.locations.some(location => query.spatialScopes.some(item =>
        locationOverlaps(location, item)));
    const named = (scope.subjectNames?.length ?? 0) > 0
      && (query.names?.length ?? 0) > 0
      && scope.subjectNames!.some(name => query.names!.some(item => nameOverlaps(name, item)));
    if (!located && !named) return 'outside';
  } else {
    // 档案/命中/无实体路径：地点闸保持 P1-1 精确相等语义（RC-04 依赖）。
    if (scope.locations.length > 0 && query.spatialScopes.length > 0
      && !scope.locations.some(location =>
        query.spatialScopes.some(item => sameScope(location, item)))) {
      return 'outside';
    }
  }
  // 时间闸（P1-1 原语义不变）。
  if (scope.time && query.temporalScopes.length > 0) {
    const deltaInterval = parseInterval(scope.time);
    const queryIntervals = query.temporalScopes.map(parseTemporalScope);
    if (!deltaInterval || queryIntervals.some(item => !item)) return 'unknown';
    if (!queryIntervals.some(item => item && intervalsOverlap(deltaInterval, item))) {
      return 'outside';
    }
  }
  return 'inside';
}

/**
 * F-02：地点粒度兼容（相等，或双向子串包含 ≥2 字）——覆盖
 * 「艾瑟嘉德皇宫高塔-黄昏花室」vs「黄昏花室」这类真实书写粒度差。
 * 只用于 generated 叙事实体投递；档案实体路径仍用 sameScope 精确相等。
 */
function locationOverlaps(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.includes(shorter);
}

/** F-02：名称命中（归一化相等或双向包含 ≥2 字；personNameMatches 同款语义）。 */
function nameOverlaps(left: string, right: string): boolean {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.includes(shorter);
}

function parseInterval(interval: CanonTimeInterval): ParsedInterval | null {
  const start = interval.start ? parseYear(interval.start.label) : null;
  const end = interval.end ? parseYear(interval.end.label) : null;
  if (interval.start && !start) return null;
  if (interval.end && !end) return null;
  const era = start?.era ?? end?.era;
  if (!era) return null;
  if (start && end && start.era !== end.era) return null;
  return { era, start: start?.year ?? Number.NEGATIVE_INFINITY, end: end?.year ?? Number.POSITIVE_INFINITY };
}

function parseTemporalScope(value: string): ParsedInterval | null {
  const matches = [...value.matchAll(/([\p{Script=Han}]{2,12}纪元)\s*(\d{1,6})\s*年/gu)];
  if (matches.length === 0) {
    const era = value.match(/[\p{Script=Han}]{2,12}纪元/u)?.[0];
    return era ? { era, start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY } : null;
  }
  const era = matches[0]?.[1];
  if (!era || matches.some(match => match[1] !== era)) return null;
  const years = matches.map(match => Number(match[2]));
  return { era, start: Math.min(...years), end: Math.max(...years) };
}

function parseYear(value: string): { era: string; year: number } | null {
  const match = value.match(/([\p{Script=Han}]{2,12}纪元)\s*(\d{1,6})\s*年/u);
  if (!match) return null;
  return { era: match[1], year: Number(match[2]) };
}

interface ParsedInterval { era: string; start: number; end: number }

function intervalsOverlap(left: ParsedInterval, right: ParsedInterval): boolean {
  return left.era === right.era && left.start <= right.end && right.start <= left.end;
}

function factKeyCompatible(factKey: string, fact: CanonFact): boolean {
  const [subject, predicate] = factKey.split('|');
  return subject === fact.subjectEntityId && predicate === fact.predicate;
}

function validFact(fact: CanonFact): boolean {
  return Boolean(fact.factId.trim() && fact.subjectEntityId.trim()
    && fact.predicate.trim() && fact.statement.trim());
}

function normalizeBaseFact(fact: CanonFact): CanonFact {
  return { ...structuredClone(fact), revisionIntroduced: 0, revisionRetired: null };
}

function normalizeCurrentFact(fact: CanonFact, revision: number): CanonFact {
  return { ...structuredClone(fact), revisionIntroduced: revision, revisionRetired: null };
}

function assertValidRequest(branch: CanonResolutionBranch, revision: number): void {
  if (branch.schema !== 'eyon.canon.branch.v1' || !branch.baseCanon) {
    throw new Error('Canon resolution requires a valid branch with immutable BaseCanon');
  }
  if (!Number.isInteger(revision) || revision < 0 || revision > branch.headRevision) {
    throw new Error(`Canon revision ${revision} is outside branch head ${branch.headRevision}`);
  }
  if (branch.characterKey.trim() === '' || branch.chatId.trim() === '') {
    throw new Error('Canon branch is not bound to a character and chat');
  }
}

function normalizeQueryScope(scope: CanonQueryScope): CanonQueryScope {
  return {
    subjectEntityIds: unique(scope.subjectEntityIds.map(normalizeId)).sort(),
    temporalScopes: unique(scope.temporalScopes.map(normalizeText)).sort(),
    spatialScopes: unique(scope.spatialScopes.map(normalizeText)).sort(),
    sourceIds: unique(scope.sourceIds.map(normalizeId)).sort(),
    ...(scope.names && scope.names.length > 0
      ? { names: unique(scope.names.map(normalizeText)).sort() }
      : {}),
  };
}

function sameScope(left: string, right: string): boolean {
  return normalize(left) === normalize(right);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function normalizeId(value: string): string {
  return value.normalize('NFKC').trim();
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function sortFacts(facts: CanonFact[]): CanonFact[] {
  return facts.map(fact => structuredClone(fact)).sort((left, right) =>
    left.subjectEntityId.localeCompare(right.subjectEntityId)
    || left.predicate.localeCompare(right.predicate)
    || left.factId.localeCompare(right.factId));
}

function uniqueFacts(facts: CanonFact[]): CanonFact[] {
  const byId = new Map<string, CanonFact>();
  for (const fact of facts) if (!byId.has(fact.factId)) byId.set(fact.factId, fact);
  return [...byId.values()];
}

function uniqueRelations(relations: CanonEventRelation[]): CanonEventRelation[] {
  const byId = new Map<string, CanonEventRelation>();
  for (const relation of relations) {
    if (!byId.has(relation.relationId)) byId.set(relation.relationId, structuredClone(relation));
  }
  return [...byId.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
}

function mergeSpans(spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...spans].sort((left, right) => left.start - right.start || left.end - right.end);
  const output: Array<{ start: number; end: number }> = [];
  for (const span of sorted) {
    const last = output.at(-1);
    if (!last || span.start > last.end) output.push({ ...span });
    else last.end = Math.max(last.end, span.end);
  }
  return output;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
