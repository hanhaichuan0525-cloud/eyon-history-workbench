import type {
  CanonBranch,
  CanonCausalRef,
  CanonCausalReconcileDecision,
  CanonCausalRebaseReceipt,
  CanonCausalSupportUnit,
  CanonOperationCausalBasis,
  CanonOperationRebaseState,
  CanonOperationRef,
  InterventionDelta,
  InterventionDeltaStatus,
} from '../retrieval/contracts.ts';

export type CanonCausalSupportState = 'satisfied' | 'broken' | 'uncertain';

export interface CanonCausalRebaseProjection {
  schema: 'eyon.canon.causal-rebase-projection.v1';
  branchId: string;
  headRevision: number;
  status: 'projected' | 'bounded-overflow';
  modelCalls: 0;
  operationStates: Array<{
    operationRef: CanonOperationRef;
    state: CanonOperationRebaseState;
    basis: CanonOperationCausalBasis['basis'];
    reasonCodes: string[];
  }>;
  supportStates: Array<{
    supportId: string;
    state: CanonCausalSupportState;
    outputRef: CanonCausalRef;
  }>;
  warnings: string[];
}

const MAX_OPERATIONS = 512;
const MAX_SUPPORT_UNITS = 1024;

interface OperationEntry {
  delta: InterventionDelta;
  operationRef: CanonOperationRef;
  currentFactId: string;
}

/**
 * P3-B 唯一 operation 状态投影。纯函数、零模型、零网络，不修改 branch。
 * 只认稳定引用与显式 replace/retract/supersedes/support/precondition/dependency。
 */
export function projectCanonCausalRebase(branch: CanonBranch): CanonCausalRebaseProjection {
  const revisionByDelta = new Map(branch.revisions.map(revision => [revision.deltaId, revision]));
  const entries: OperationEntry[] = branch.deltas.flatMap(delta => delta.operations.map(operation => ({
    delta,
    operationRef: { deltaId: delta.deltaId, factKey: operation.factKey },
    currentFactId: operation.current.factId,
  })));
  const supports = branch.deltas.flatMap(delta => delta.causalSupportUnits ?? []);
  const activeEntries = entries.filter(entry => {
    const revision = revisionByDelta.get(entry.delta.deltaId);
    return revision?.status === 'active' && entry.delta.revision <= branch.headRevision;
  });
  const activeSupports = supports.filter(support => {
    const revision = revisionByDelta.get(support.introducedByDeltaId);
    return support.branchId === branch.branchId
      && revision?.status === 'active'
      && support.introducedRevision <= branch.headRevision;
  });
  if (activeEntries.length > MAX_OPERATIONS || activeSupports.length > MAX_SUPPORT_UNITS) {
    return {
      schema: 'eyon.canon.causal-rebase-projection.v1',
      branchId: branch.branchId,
      headRevision: branch.headRevision,
      status: 'bounded-overflow',
      modelCalls: 0,
      operationStates: [],
      supportStates: [],
      warnings: [
        `causal-rebase-bounded: operations=${activeEntries.length}/${MAX_OPERATIONS}, supports=${activeSupports.length}/${MAX_SUPPORT_UNITS}`,
      ],
    };
  }

  const warnings = new Set<string>();
  const entryGroups = new Map<string, OperationEntry[]>();
  for (const entry of entries) {
    const key = operationRefKey(entry.operationRef);
    const group = entryGroups.get(key) ?? [];
    group.push(entry);
    entryGroups.set(key, group);
  }
  const entryByRef = new Map<string, OperationEntry>();
  for (const [key, group] of entryGroups) {
    if (group.length === 1) entryByRef.set(key, group[0]!);
    else warnings.add(`ambiguous-operation-ref:${key}`);
  }
  const basisByRef = new Map<string, CanonOperationCausalBasis>();
  for (const delta of branch.deltas) {
    for (const basis of delta.causalBasis ?? []) {
      const key = operationRefKey(basis.operationRef);
      if (basisByRef.has(key)) warnings.add(`duplicate-causal-basis:${key}`);
      else basisByRef.set(key, basis);
    }
  }
  const supportById = new Map<string, CanonCausalSupportUnit>();
  const supportIdsByOutput = new Map<string, string[]>();
  for (const support of supports) {
    const introducedBy = revisionByDelta.get(support.introducedByDeltaId);
    if (support.branchId !== branch.branchId) {
      warnings.add(`cross-branch-support:${support.supportId}`);
      continue;
    }
    if (introducedBy?.status !== 'active' || support.introducedRevision > branch.headRevision) continue;
    if (supportById.has(support.supportId)) warnings.add(`duplicate-causal-support:${support.supportId}`);
    else {
      supportById.set(support.supportId, support);
      if (support.outputRef.kind === 'operation') {
        const key = operationRefKey(support.outputRef.operationRef);
        const ids = supportIdsByOutput.get(key) ?? [];
        ids.push(support.supportId);
        supportIdsByOutput.set(key, ids);
      }
    }
  }
  const reconcileDecisionByTarget = new Map<string, CanonCausalReconcileDecision>();
  for (const delta of branch.deltas
    .filter(item => {
      const revision = revisionByDelta.get(item.deltaId);
      return revision?.status === 'active' && item.revision <= branch.headRevision;
    })
    .sort((left, right) => left.revision - right.revision)) {
    for (const decision of delta.causalReconcileDecisions ?? []) {
      if (decision.branchId !== branch.branchId) {
        warnings.add(`cross-branch-reconcile-decision:${decision.decisionId}`);
        continue;
      }
      reconcileDecisionByTarget.set(
        operationRefKey(decision.targetOperationRef),
        decision,
      );
    }
  }
  const actionStatus = new Map(branch.revisions
    .filter(revision => revision.revision <= branch.headRevision)
    .map(revision => [revision.actionId, revision.status]));
  const operationByFactId = new Map<string, CanonOperationRef>();
  const entriesByFactId = new Map<string, OperationEntry[]>();
  for (const entry of activeEntries) {
    const factEntries = entriesByFactId.get(entry.currentFactId) ?? [];
    factEntries.push(entry);
    entriesByFactId.set(entry.currentFactId, factEntries);
    const existing = operationByFactId.get(entry.currentFactId);
    if (existing) {
      warnings.add(`restated-current-fact:${entry.currentFactId}`);
      const existingRevision = entryByRef.get(operationRefKey(existing))?.delta.revision ?? -1;
      if (entry.delta.revision >= existingRevision) operationByFactId.set(entry.currentFactId, entry.operationRef);
    } else {
      operationByFactId.set(entry.currentFactId, entry.operationRef);
    }
  }

  const explicitSuperseded = new Set<string>();
  const activeRetiredFacts = new Set<string>();
  const ordered = [...entries].sort((left, right) =>
    left.delta.revision - right.delta.revision
    || operationRefKey(left.operationRef).localeCompare(operationRefKey(right.operationRef), 'en'));
  for (const changedBy of ordered) {
    const revision = revisionByDelta.get(changedBy.delta.deltaId);
    if (revision?.status !== 'active' || changedBy.delta.revision > branch.headRevision) continue;
    const operation = changedBy.delta.operations.find(item =>
      item.factKey === changedBy.operationRef.factKey);
    if (!operation) continue;
    for (const factId of operation.originalFactIds) {
      activeRetiredFacts.add(factId);
      for (const affected of entriesByFactId.get(factId) ?? []) {
        if (affected.delta.revision < changedBy.delta.revision) {
          explicitSuperseded.add(operationRefKey(affected.operationRef));
        }
      }
    }
    if (operation.op !== 'retract') activeRetiredFacts.delete(operation.current.factId);
    for (const deltaId of changedBy.delta.supersedesDeltaIds) {
      for (const entry of entries.filter(item => item.delta.deltaId === deltaId)) {
        explicitSuperseded.add(operationRefKey(entry.operationRef));
      }
    }
    if (operation.op !== 'assert') {
      for (const earlier of ordered) {
        if (earlier.delta.revision >= changedBy.delta.revision) break;
        if (earlier.operationRef.factKey === changedBy.operationRef.factKey) {
          explicitSuperseded.add(operationRefKey(earlier.operationRef));
        }
      }
    }
  }

  const operationMemo = new Map<string, CanonOperationRebaseState>();
  const operationReasons = new Map<string, string[]>();
  const supportMemo = new Map<string, CanonCausalSupportState>();

  const evaluateRef = (reference: CanonCausalRef, stack: string[]): CanonCausalSupportState => {
    if (reference.kind === 'action') {
      const state = actionStatus.get(reference.actionId);
      return state === undefined ? 'uncertain' : state === 'active' ? 'satisfied' : 'broken';
    }
    if (reference.kind === 'operation') {
      return supportStateFromOperation(evaluateOperation(reference.operationRef, stack));
    }
    const producer = operationByFactId.get(reference.factId);
    if (producer) return supportStateFromOperation(evaluateOperation(producer, stack));
    // BaseCanon 事实未存入 branch；它在 support 建立时已通过验证，除非后续显式退休，否则保持满足。
    return activeRetiredFacts.has(reference.factId) ? 'broken' : 'satisfied';
  };

  const evaluateSupport = (supportId: string, stack: string[]): CanonCausalSupportState => {
    const cached = supportMemo.get(supportId);
    if (cached) return cached;
    const support = supportById.get(supportId);
    if (!support || support.inputRefs.length === 0) {
      warnings.add(!support ? `missing-causal-support:${supportId}` : `empty-causal-support:${supportId}`);
      supportMemo.set(supportId, 'uncertain');
      return 'uncertain';
    }
    const states = support.inputRefs.map(reference => evaluateRef(reference, stack));
    const state: CanonCausalSupportState = states.some(item => item === 'broken')
      ? 'broken'
      : states.some(item => item === 'uncertain')
      ? 'uncertain'
      : 'satisfied';
    supportMemo.set(supportId, state);
    return state;
  };

  const evaluateDeltaDependency = (deltaId: string, stack: string[]): CanonCausalSupportState => {
    const dependency = branch.deltas.find(delta => delta.deltaId === deltaId);
    const revision = revisionByDelta.get(deltaId);
    if (!dependency || !revision) return 'uncertain';
    if (revision.status !== 'active') return 'broken';
    const states = dependency.operations.map(operation => evaluateOperation({
      deltaId,
      factKey: operation.factKey,
    }, stack));
    if (states.length === 0) return 'uncertain';
    // delta 依赖承认“该次历史曾发生”：后续 supersede 不抹去其 occurrence；
    // 只有 revision 回滚或结果从未获得支撑时才算断裂。
    if (states.every(state => state === 'active' || state === 'superseded')) return 'satisfied';
    if (states.every(state => state === 'reverted' || state === 'orphaned')) return 'broken';
    return 'uncertain';
  };

  function evaluateOperation(
    operationRef: CanonOperationRef,
    stack: string[],
  ): CanonOperationRebaseState {
    const key = operationRefKey(operationRef);
    const cached = operationMemo.get(key);
    if (cached) return cached;
    const entry = entryByRef.get(key);
    if (!entry) {
      operationReasons.set(key, ['operation-reference-unresolved']);
      return 'uncertain';
    }
    const revision = revisionByDelta.get(entry.delta.deltaId);
    if (!revision || revision.status === 'reverted') {
      operationMemo.set(key, 'reverted');
      operationReasons.set(key, ['revision-reverted']);
      return 'reverted';
    }
    if (revision.status === 'orphaned') {
      operationMemo.set(key, 'orphaned');
      operationReasons.set(key, ['legacy-revision-orphaned']);
      return 'orphaned';
    }
    if (revision.status !== 'active' || entry.delta.revision > branch.headRevision) {
      operationMemo.set(key, 'uncertain');
      operationReasons.set(key, ['revision-state-unresolved']);
      return 'uncertain';
    }
    if (explicitSuperseded.has(key)) {
      operationMemo.set(key, 'superseded');
      operationReasons.set(key, ['explicitly-superseded']);
      return 'superseded';
    }
    if (stack.includes(key)) {
      const cycle = [...stack.slice(stack.indexOf(key)), key];
      for (const cycleKey of cycle) {
        operationMemo.set(cycleKey, 'uncertain');
        operationReasons.set(cycleKey, ['causal-cycle']);
      }
      warnings.add(`causal-cycle:${cycle.join('->')}`);
      return 'uncertain';
    }

    const basis = basisByRef.get(key);
    const nextStack = [...stack, key];
    if (basis?.basis === 'direct') {
      operationMemo.set(key, 'active');
      operationReasons.set(key, ['direct-action-root']);
      return 'active';
    }
    const reconcileDecision = reconcileDecisionByTarget.get(key);
    if (reconcileDecision?.decision === 'retire') {
      operationMemo.set(key, 'orphaned');
      operationReasons.set(key, ['canon-reconcile-retired']);
      return 'orphaned';
    }
    if (reconcileDecision?.decision === 'uncertain') {
      operationMemo.set(key, 'uncertain');
      operationReasons.set(key, ['canon-reconcile-uncertain']);
      return 'uncertain';
    }

    const prerequisiteStates = [
      ...entry.delta.preconditionFactIds.map(factId => evaluateRef({ kind: 'fact', factId }, nextStack)),
      ...entry.delta.dependsOnDeltaIds.map(deltaId => evaluateDeltaDependency(deltaId, nextStack)),
    ];
    const prerequisite = combineAnd(prerequisiteStates);

    const recordedSupportIds = uniqueStrings([
      ...(basis?.basis === 'supported' ? basis.supportIds : []),
      ...(supportIdsByOutput.get(key) ?? []),
    ]);
    if ((!basis || basis.basis === 'opaque') && recordedSupportIds.length === 0) {
      if (prerequisite === 'broken') {
        operationMemo.set(key, 'orphaned');
        operationReasons.set(key, [
          'causal-basis-opaque',
          'explicit-prerequisite-broken',
        ]);
        return 'orphaned';
      }
      if (prerequisite === 'uncertain') {
        operationMemo.set(key, 'uncertain');
        operationReasons.set(key, ['causal-basis-opaque', 'explicit-prerequisite-uncertain']);
        return 'uncertain';
      }
      const deltaHasExplicitConflict = entry.delta.operations.some(operation =>
        explicitSuperseded.has(operationRefKey({
          deltaId: entry.delta.deltaId,
          factKey: operation.factKey,
        })));
      if (!basis && entry.delta.status === 'partially-active' && !deltaHasExplicitConflict) {
        operationMemo.set(key, 'uncertain');
        operationReasons.set(key, ['legacy-partial-operation-unresolved']);
        return 'uncertain';
      }
      operationMemo.set(key, 'active');
      operationReasons.set(key, ['causal-basis-opaque-untouched']);
      return 'active';
    }

    const supportStates = recordedSupportIds.map(supportId => evaluateSupport(supportId, nextStack));
    let state: CanonOperationRebaseState;
    const reasons: string[] = [];
    if (prerequisite === 'broken') {
      state = 'orphaned';
      reasons.push('explicit-prerequisite-broken');
    } else if (prerequisite === 'uncertain') {
      state = 'uncertain';
      reasons.push('explicit-prerequisite-uncertain');
    } else if (supportStates.some(item => item === 'satisfied')) {
      state = 'active';
      reasons.push('recorded-support-survives');
    } else if (supportStates.length > 0 && supportStates.every(item => item === 'broken')) {
      state = 'orphaned';
      reasons.push('all-recorded-supports-broken');
    } else {
      state = 'uncertain';
      reasons.push('recorded-support-uncertain');
    }
    operationMemo.set(key, state);
    operationReasons.set(key, reasons);
    return state;
  }

  for (const entry of ordered) evaluateOperation(entry.operationRef, []);
  // 确保孤立但合法的 support 也能在诊断中显示；坏引用仅局部 uncertain。
  for (const supportId of supportById.keys()) evaluateSupport(supportId, []);

  return {
    schema: 'eyon.canon.causal-rebase-projection.v1',
    branchId: branch.branchId,
    headRevision: branch.headRevision,
    status: 'projected',
    modelCalls: 0,
    operationStates: ordered.map(entry => {
      const key = operationRefKey(entry.operationRef);
      return {
        operationRef: entry.operationRef,
        state: operationMemo.get(key) ?? 'uncertain',
        basis: basisByRef.get(key)?.basis ?? 'opaque',
        reasonCodes: operationReasons.get(key) ?? ['operation-state-unresolved'],
      };
    }),
    supportStates: [...supportById.values()]
      .map(support => ({
        supportId: support.supportId,
        state: supportMemo.get(support.supportId) ?? 'uncertain',
        outputRef: support.outputRef,
      }))
      .sort((left, right) => left.supportId.localeCompare(right.supportId, 'en')),
    warnings: [...warnings].sort((left, right) => left.localeCompare(right, 'en')),
  };
}

/** 在候选分支内只写 delta 汇总状态；operation 原稿与 causal support 永不覆盖。 */
export function applyCanonCausalRebase(
  candidate: CanonBranch,
  previous?: CanonBranch,
): CanonCausalRebaseReceipt {
  const projection = projectCanonCausalRebase(candidate);
  const previousProjection = previous ? projectCanonCausalRebase(previous) : undefined;
  if (projection.status === 'bounded-overflow') {
    return {
      schema: 'eyon.canon.causal-rebase-receipt.v1',
      status: 'bounded-overflow',
      modelCalls: 0,
      changedOperations: [],
      brokenSupportIds: [],
      survivingSupportIds: [],
      uncertainOperationRefs: [],
      restoredOperationRefs: [],
      warnings: projection.warnings,
    };
  }

  const revisionByDelta = new Map(candidate.revisions.map(revision => [revision.deltaId, revision]));
  const statesByDelta = new Map<string, CanonOperationRebaseState[]>();
  for (const item of projection.operationStates) {
    const states = statesByDelta.get(item.operationRef.deltaId) ?? [];
    states.push(item.state);
    statesByDelta.set(item.operationRef.deltaId, states);
  }
  for (const delta of candidate.deltas) {
    const revision = revisionByDelta.get(delta.deltaId);
    delta.status = summarizeDeltaStatus(statesByDelta.get(delta.deltaId) ?? [], revision?.status);
  }

  const previousStates = new Map((previousProjection?.operationStates ?? []).map(item => [
    operationRefKey(item.operationRef), item.state,
  ]));
  const previousRefs = new Set(previousStates.keys());
  const changedOperations = projection.operationStates
    .filter(item => {
      const key = operationRefKey(item.operationRef);
      return previousRefs.has(key) && previousStates.get(key) !== item.state;
    })
    .map(item => ({
      operationRef: item.operationRef,
      previousState: previousStates.get(operationRefKey(item.operationRef)),
      currentState: item.state,
      reasonCodes: item.reasonCodes,
    }));
  const restoredOperationRefs = changedOperations
    .filter(item => item.currentState === 'active' && item.previousState !== 'active')
    .map(item => item.operationRef);
  const uncertainOperationRefs = projection.operationStates
    .filter(item => item.state === 'uncertain')
    .map(item => item.operationRef);
  return {
    schema: 'eyon.canon.causal-rebase-receipt.v1',
    status: changedOperations.length > 0 ? 'rebased' : 'no-conflict',
    modelCalls: 0,
    changedOperations,
    brokenSupportIds: projection.supportStates
      .filter(item => item.state === 'broken').map(item => item.supportId),
    survivingSupportIds: projection.supportStates
      .filter(item => item.state === 'satisfied').map(item => item.supportId),
    uncertainOperationRefs,
    restoredOperationRefs,
    warnings: projection.warnings,
  };
}

export function operationRebaseState(
  projection: CanonCausalRebaseProjection,
  operationRef: CanonOperationRef,
): CanonOperationRebaseState | undefined {
  return projection.operationStates.find(item =>
    sameOperationRef(item.operationRef, operationRef))?.state;
}

function summarizeDeltaStatus(
  states: CanonOperationRebaseState[],
  revisionStatus: CanonBranch['revisions'][number]['status'] | undefined,
): InterventionDeltaStatus {
  if (revisionStatus === 'reverted') return 'reverted';
  if (revisionStatus === 'orphaned') return 'orphaned';
  if (states.length === 0) return 'partially-active';
  if (states.every(state => state === 'active')) return 'active';
  if (states.every(state => state === 'superseded')) return 'superseded';
  if (states.every(state => state === 'orphaned')) return 'orphaned';
  if (states.every(state => state === 'reverted')) return 'reverted';
  return 'partially-active';
}

function combineAnd(states: CanonCausalSupportState[]): CanonCausalSupportState {
  if (states.some(state => state === 'broken')) return 'broken';
  if (states.some(state => state === 'uncertain')) return 'uncertain';
  return 'satisfied';
}

function supportStateFromOperation(state: CanonOperationRebaseState): CanonCausalSupportState {
  if (state === 'active') return 'satisfied';
  if (state === 'uncertain') return 'uncertain';
  return 'broken';
}

function sameOperationRef(left: CanonOperationRef, right: CanonOperationRef): boolean {
  return left.deltaId === right.deltaId && left.factKey === right.factKey;
}

function operationRefKey(reference: CanonOperationRef): string {
  return `${reference.deltaId}\u0000${reference.factKey}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
