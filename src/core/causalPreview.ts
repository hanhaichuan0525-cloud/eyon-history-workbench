import type {
  CanonBranch,
  CanonCausalRef,
  CanonCausalSupportUnit,
  CanonOperationCausalBasis,
  CanonOperationRef,
  InterventionDelta,
  InterventionDeltaOperation,
} from '../retrieval/contracts.ts';

export type CanonCausalPreviewState =
  | 'would-remain-active'
  | 'would-be-superseded'
  | 'would-be-orphaned'
  | 'uncertain'
  | 'opaque';

export interface CanonCausalConflictPreview {
  schema: 'eyon.canon.causal-preview.v1';
  branchId: string;
  headRevision: number;
  status: 'no-conflict' | 'conflict-preview' | 'bounded-overflow';
  modelCalls: 0;
  counts: {
    activeOperations: number;
    recordedBases: number;
    supportUnits: number;
    opaqueOperations: number;
    conflictRoots: number;
    brokenSupports: number;
    survivingSupports: number;
    affectedOperations: number;
  };
  conflictRoots: Array<{
    rootId: string;
    reason: 'operation-replaced' | 'delta-superseded' | 'support-fact-replaced';
    changedBy: CanonOperationRef;
    affectedRef: CanonCausalRef;
  }>;
  supports: Array<{
    supportId: string;
    status: 'satisfied' | 'broken' | 'uncertain';
    outputRef: CanonCausalRef;
    claimText: string;
  }>;
  affectedOperations: Array<{
    operationRef: CanonOperationRef;
    basis: CanonOperationCausalBasis['basis'];
    state: CanonCausalPreviewState;
    reasonCodes: string[];
  }>;
  stopPoints: Array<{
    operationRef: CanonOperationRef;
    reason: 'alternative-support-survives' | 'opaque-boundary' | 'uncertain-boundary';
  }>;
  warnings: string[];
}

const MAX_ACTIVE_OPERATIONS = 512;
const MAX_SUPPORT_UNITS = 1024;

interface OperationEntry {
  delta: InterventionDelta;
  operation: InterventionDeltaOperation;
  operationRef: CanonOperationRef;
}

/**
 * P3-A 只读预演：只承认稳定引用与显式 replace/retract/supersedes 证据。
 * 不修改 branch，不调用模型，不改变 resolveCanon 的既有结果。
 */
export function previewCanonCausalConflicts(branch: CanonBranch): CanonCausalConflictPreview {
  const activeRevisionIds = new Set(branch.revisions
    .filter(revision => revision.status === 'active' && revision.revision <= branch.headRevision)
    .map(revision => revision.deltaId));
  const activeDeltas = branch.deltas
    .filter(delta => activeRevisionIds.has(delta.deltaId)
      && (delta.status === 'active' || delta.status === 'partially-active'))
    .sort((left, right) => left.revision - right.revision);
  const entries: OperationEntry[] = activeDeltas.flatMap(delta => delta.operations.map(operation => ({
    delta,
    operation,
    operationRef: { deltaId: delta.deltaId, factKey: operation.factKey },
  })));
  const bases = activeDeltas.flatMap(delta => delta.causalBasis ?? []);
  const supports = activeDeltas.flatMap(delta => delta.causalSupportUnits ?? []);
  const opaqueOperations = entries.filter(entry => !bases.some(basis =>
    operationRefKey(basis.operationRef) === operationRefKey(entry.operationRef))).length
    + bases.filter(basis => basis.basis === 'opaque').length;
  const baseCounts = {
    activeOperations: entries.length,
    recordedBases: bases.length,
    supportUnits: supports.length,
    opaqueOperations,
  };

  if (entries.length > MAX_ACTIVE_OPERATIONS || supports.length > MAX_SUPPORT_UNITS) {
    return emptyPreview(branch, baseCounts, 'bounded-overflow', [
      `causal-preview-bounded: operations=${entries.length}/${MAX_ACTIVE_OPERATIONS}, supports=${supports.length}/${MAX_SUPPORT_UNITS}`,
    ]);
  }

  const entryByRef = new Map(entries.map(entry => [operationRefKey(entry.operationRef), entry]));
  const basisByRef = new Map(bases.map(basis => [operationRefKey(basis.operationRef), basis]));
  const supportById = new Map(supports.map(support => [support.supportId, support]));
  const roots = collectConflictRoots(entries, supports);
  if (roots.length === 0) return emptyPreview(branch, baseCounts, 'no-conflict', []);

  const rootOperationKeys = new Set(roots.flatMap(root =>
    root.affectedRef.kind === 'operation'
      ? [operationRefKey(root.affectedRef.operationRef)]
      : []));
  const replacedFactIds = new Set(roots.flatMap(root =>
    root.affectedRef.kind === 'fact' ? [root.affectedRef.factId] : []));
  const actionStatus = new Map(branch.revisions.map(revision => [revision.actionId, revision.status]));
  const reachable = collectReachableOperationKeys({
    roots,
    supports,
    bases,
  });
  const warnings = new Set<string>();
  const operationMemo = new Map<string, CanonCausalPreviewState>();
  const supportMemo = new Map<string, 'satisfied' | 'broken' | 'uncertain'>();

  const evaluateRef = (reference: CanonCausalRef, stack: Set<string>): 'satisfied' | 'broken' | 'uncertain' => {
    if (reference.kind === 'fact') {
      return replacedFactIds.has(reference.factId) ? 'broken' : 'satisfied';
    }
    if (reference.kind === 'action') {
      const status = actionStatus.get(reference.actionId);
      if (!status) return 'uncertain';
      return status === 'active' ? 'satisfied' : 'broken';
    }
    const state = evaluateOperation(reference.operationRef, stack);
    if (state === 'would-remain-active') return 'satisfied';
    if (state === 'would-be-superseded' || state === 'would-be-orphaned') return 'broken';
    return 'uncertain';
  };

  const evaluateSupport = (
    support: CanonCausalSupportUnit,
    stack: Set<string>,
  ): 'satisfied' | 'broken' | 'uncertain' => {
    const cached = supportMemo.get(support.supportId);
    if (cached) return cached;
    const statuses = support.inputRefs.map(reference => evaluateRef(reference, stack));
    const status = statuses.some(item => item === 'broken')
      ? 'broken'
      : statuses.some(item => item === 'uncertain')
      ? 'uncertain'
      : 'satisfied';
    supportMemo.set(support.supportId, status);
    return status;
  };

  function evaluateOperation(
    operationRef: CanonOperationRef,
    stack: Set<string>,
  ): CanonCausalPreviewState {
    const key = operationRefKey(operationRef);
    const cached = operationMemo.get(key);
    if (cached) return cached;
    if (rootOperationKeys.has(key)) {
      operationMemo.set(key, 'would-be-superseded');
      return 'would-be-superseded';
    }
    if (!entryByRef.has(key)) {
      operationMemo.set(key, 'uncertain');
      return 'uncertain';
    }
    if (stack.has(key)) {
      warnings.add(`causal-cycle:${key}`);
      return 'uncertain';
    }
    const basis = basisByRef.get(key);
    if (!basis || basis.basis === 'opaque') {
      operationMemo.set(key, 'opaque');
      return 'opaque';
    }
    if (basis.basis === 'direct') {
      operationMemo.set(key, 'would-remain-active');
      return 'would-remain-active';
    }
    const nextStack = new Set(stack).add(key);
    const statuses = basis.supportIds.map(supportId => {
      const support = supportById.get(supportId);
      if (!support) {
        warnings.add(`missing-causal-support:${supportId}`);
        return 'uncertain' as const;
      }
      return evaluateSupport(support, nextStack);
    });
    const state: CanonCausalPreviewState = statuses.some(status => status === 'satisfied')
      ? 'would-remain-active'
      : statuses.length > 0 && statuses.every(status => status === 'broken')
      ? 'would-be-orphaned'
      : 'uncertain';
    operationMemo.set(key, state);
    return state;
  }

  for (const key of reachable) {
    const entry = entryByRef.get(key);
    if (entry) evaluateOperation(entry.operationRef, new Set());
  }

  const supportPreviews = [...supportMemo.entries()]
    .map(([supportId, status]) => {
      const support = supportById.get(supportId)!;
      return { supportId, status, outputRef: support.outputRef, claimText: support.claimText };
    })
    .sort((left, right) => left.supportId.localeCompare(right.supportId, 'en'));
  const affectedOperations = [...reachable]
    .map(key => {
      const entry = entryByRef.get(key);
      if (!entry) return null;
      const basis = basisByRef.get(key);
      const state = operationMemo.get(key) ?? 'uncertain';
      return {
        operationRef: entry.operationRef,
        basis: basis?.basis ?? 'opaque' as const,
        state,
        reasonCodes: operationReasonCodes(state, rootOperationKeys.has(key)),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => operationRefKey(left.operationRef)
      .localeCompare(operationRefKey(right.operationRef), 'en'));
  const stopPoints: CanonCausalConflictPreview['stopPoints'] = [];
  for (const item of affectedOperations) {
    if (item.state === 'would-remain-active') {
      stopPoints.push({ operationRef: item.operationRef, reason: 'alternative-support-survives' });
    }
    if (item.state === 'opaque') {
      stopPoints.push({ operationRef: item.operationRef, reason: 'opaque-boundary' });
    }
    if (item.state === 'uncertain') {
      stopPoints.push({ operationRef: item.operationRef, reason: 'uncertain-boundary' });
    }
  }

  return {
    schema: 'eyon.canon.causal-preview.v1',
    branchId: branch.branchId,
    headRevision: branch.headRevision,
    status: 'conflict-preview',
    modelCalls: 0,
    counts: {
      ...baseCounts,
      conflictRoots: roots.length,
      brokenSupports: supportPreviews.filter(item => item.status === 'broken').length,
      survivingSupports: supportPreviews.filter(item => item.status === 'satisfied').length,
      affectedOperations: affectedOperations.length,
    },
    conflictRoots: roots,
    supports: supportPreviews,
    affectedOperations,
    stopPoints,
    warnings: [...warnings].sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function collectConflictRoots(
  entries: OperationEntry[],
  supports: CanonCausalSupportUnit[],
): CanonCausalConflictPreview['conflictRoots'] {
  const roots = new Map<string, CanonCausalConflictPreview['conflictRoots'][number]>();
  const byFactId = new Map(entries.map(entry => [entry.operation.current.factId, entry]));
  const byFactKey = new Map<string, OperationEntry[]>();
  for (const entry of entries) {
    const group = byFactKey.get(entry.operation.factKey) ?? [];
    group.push(entry);
    byFactKey.set(entry.operation.factKey, group);
  }
  for (const changedBy of entries) {
    for (const originalFactId of changedBy.operation.originalFactIds) {
      const affected = byFactId.get(originalFactId);
      if (affected && affected.delta.revision < changedBy.delta.revision) {
        addRoot(roots, 'operation-replaced', changedBy.operationRef, {
          kind: 'operation', operationRef: affected.operationRef,
        });
      }
      if (supports.some(support => support.introducedRevision < changedBy.delta.revision
        && support.inputRefs.some(reference =>
          reference.kind === 'fact' && reference.factId === originalFactId))) {
        addRoot(roots, 'support-fact-replaced', changedBy.operationRef, {
          kind: 'fact', factId: originalFactId,
        });
      }
    }
    for (const supersededDeltaId of changedBy.delta.supersedesDeltaIds) {
      for (const affected of entries.filter(entry => entry.delta.deltaId === supersededDeltaId)) {
        addRoot(roots, 'delta-superseded', changedBy.operationRef, {
          kind: 'operation', operationRef: affected.operationRef,
        });
      }
    }
  }
  for (const group of byFactKey.values()) {
    const ordered = [...group].sort((left, right) => left.delta.revision - right.delta.revision);
    for (let index = 1; index < ordered.length; index += 1) {
      const changedBy = ordered[index];
      if (changedBy.operation.op === 'assert') continue;
      for (const affected of ordered.slice(0, index)) {
        addRoot(roots, 'operation-replaced', changedBy.operationRef, {
          kind: 'operation', operationRef: affected.operationRef,
        });
      }
    }
  }
  return [...roots.values()].sort((left, right) => left.rootId.localeCompare(right.rootId, 'en'));
}

function collectReachableOperationKeys(input: {
  roots: CanonCausalConflictPreview['conflictRoots'];
  supports: CanonCausalSupportUnit[];
  bases: CanonOperationCausalBasis[];
}): Set<string> {
  const allowedSupportIds = new Map(input.bases
    .filter(basis => basis.basis === 'supported')
    .map(basis => [operationRefKey(basis.operationRef), new Set(basis.supportIds)]));
  const reachable = new Set<string>();
  const queue: CanonCausalRef[] = input.roots.map(root => root.affectedRef);
  while (queue.length > 0 && reachable.size <= MAX_ACTIVE_OPERATIONS) {
    const reference = queue.shift()!;
    if (reference.kind === 'operation') reachable.add(operationRefKey(reference.operationRef));
    for (const support of input.supports) {
      if (!support.inputRefs.some(item => causalRefKey(item) === causalRefKey(reference))) continue;
      if (support.outputRef.kind !== 'operation') continue;
      const outputKey = operationRefKey(support.outputRef.operationRef);
      if (!allowedSupportIds.get(outputKey)?.has(support.supportId)) continue;
      if (reachable.has(outputKey)) continue;
      reachable.add(outputKey);
      queue.push(support.outputRef);
    }
  }
  return reachable;
}

function addRoot(
  roots: Map<string, CanonCausalConflictPreview['conflictRoots'][number]>,
  reason: CanonCausalConflictPreview['conflictRoots'][number]['reason'],
  changedBy: CanonOperationRef,
  affectedRef: CanonCausalRef,
): void {
  const rootId = `${reason}:${operationRefKey(changedBy)}:${causalRefKey(affectedRef)}`;
  roots.set(rootId, { rootId, reason, changedBy, affectedRef });
}

function emptyPreview(
  branch: CanonBranch,
  baseCounts: Pick<CanonCausalConflictPreview['counts'],
    'activeOperations' | 'recordedBases' | 'supportUnits' | 'opaqueOperations'>,
  status: CanonCausalConflictPreview['status'],
  warnings: string[],
): CanonCausalConflictPreview {
  return {
    schema: 'eyon.canon.causal-preview.v1',
    branchId: branch.branchId,
    headRevision: branch.headRevision,
    status,
    modelCalls: 0,
    counts: {
      ...baseCounts,
      conflictRoots: 0,
      brokenSupports: 0,
      survivingSupports: 0,
      affectedOperations: 0,
    },
    conflictRoots: [],
    supports: [],
    affectedOperations: [],
    stopPoints: [],
    warnings,
  };
}

function operationReasonCodes(state: CanonCausalPreviewState, root: boolean): string[] {
  return [
    ...(root ? ['explicit-conflict-root'] : []),
    ...(state === 'would-be-orphaned' ? ['all-recorded-supports-broken'] : []),
    ...(state === 'would-remain-active' ? ['recorded-support-survives'] : []),
    ...(state === 'opaque' ? ['causal-basis-opaque'] : []),
    ...(state === 'uncertain' ? ['causal-preview-uncertain'] : []),
  ];
}

function causalRefKey(reference: CanonCausalRef): string {
  if (reference.kind === 'operation') return `operation:${operationRefKey(reference.operationRef)}`;
  if (reference.kind === 'fact') return `fact:${reference.factId}`;
  return `action:${reference.actionId}`;
}

function operationRefKey(reference: CanonOperationRef): string {
  return `${reference.deltaId}\u0000${reference.factKey}`;
}
