import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import { applyCanonCausalRebase } from '../core/causalRebase.ts';
import type {
  CanonBranch,
  CanonCausalRef,
  CanonCausalReconcileDecision,
  CanonCausalReconcileReceipt,
  CanonCausalSupportUnit,
  CanonFact,
  CanonOperationCausalBasis,
  CanonOperationRef,
  CanonResolutionReceipt,
  InterventionAction,
  InterventionDelta,
  InterventionDeltaOperation,
} from '../retrieval/contracts.ts';
import {
  CANON_BRANCH_STORE,
  historyDatabase,
  requestResult,
  transactionComplete,
} from './database.ts';

export interface CommitCanonInterventionInput {
  namespace: WorkbenchNamespace;
  action: Omit<InterventionAction, 'actionId' | 'branchId'>;
  delta: Omit<
    InterventionDelta,
    | 'deltaId'
    | 'branchId'
    | 'revision'
    | 'parentRevision'
    | 'actionRef'
    | 'causalBasis'
    | 'causalSupportUnits'
    | 'causalReconcileDecisions'
  >;
  /** P3-A：提交时的局部草案；仓储层在稳定 id 落定后原子化写入。 */
  causalPlan?: CommitCanonCausalPlan;
  /** P3-C：事务外模型协调后的局部提案；仓储层仍会逐项复核。 */
  causalReconcilePlan?: CommitCanonReconcilePlan;
}

export type CommitCanonCausalInputRef =
  | { kind: 'fact'; factId: string }
  | { kind: 'operation'; factKey: string }
  | { kind: 'action' };

export interface CommitCanonCausalPlan {
  directOperationFactKeys: string[];
  supports: Array<{
    inputRefs: CommitCanonCausalInputRef[];
    outputFactKey: string;
    claimText: string;
    sourceRefs: string[];
  }>;
}

/** P3-C 事务内目标：既可以指向既有结果，也可以指向尚未获得稳定 deltaId 的本次新结果。 */
export type CommitCanonReconcileTarget =
  | { kind: 'existing'; operationRef: CanonOperationRef }
  | { kind: 'current'; factKey: string };

export interface CommitCanonReconcilePlan {
  expectedParentRevision: number;
  modelCalls: 1;
  repairCalls: 0 | 1;
  consideredTargets: CommitCanonReconcileTarget[];
  proposals: Array<
    | {
        kind: 'support';
        target: CommitCanonReconcileTarget;
        inputRefs: CommitCanonCausalInputRef[];
        claimText: string;
        sourceRefs: string[];
      }
    | {
        kind: 'decision';
        target: CommitCanonReconcileTarget;
        decision: 'retire' | 'uncertain';
        reason: string;
        sourceRefs: string[];
      }
    | {
        kind: 'replace';
        target: CommitCanonReconcileTarget;
        replacementFactKey: string;
        reason: string;
        sourceRefs: string[];
      }
  >;
  droppedProposalCount: number;
  warnings: string[];
  failureCode?: string;
}

export interface CanonCommitResult {
  branch: CanonBranch;
  action: InterventionAction;
  delta: InterventionDelta;
  receipt: CanonResolutionReceipt;
}

export interface CanonRollbackResult {
  branch: CanonBranch;
  receipt: CanonResolutionReceipt;
}

export interface CanonRepository {
  getBranch(namespace: WorkbenchNamespace): Promise<CanonBranch>;
  commitIntervention(input: CommitCanonInterventionInput): Promise<CanonCommitResult>;
  rollbackByMessageId(
    namespace: WorkbenchNamespace,
    assistantMessageId: number,
    now: number,
  ): Promise<CanonRollbackResult | null>;
}

export function canonBranchId(namespace: WorkbenchNamespace): string {
  return `canon:${encodeURIComponent(namespaceKey(namespace))}`;
}

export class MemoryCanonRepository implements CanonRepository {
  private readonly branches = new Map<string, CanonBranch>();

  async getBranch(namespace: WorkbenchNamespace): Promise<CanonBranch> {
    return structuredClone(this.branches.get(canonBranchId(namespace)) ?? emptyBranch(namespace, 0));
  }

  async commitIntervention(input: CommitCanonInterventionInput): Promise<CanonCommitResult> {
    const branchId = canonBranchId(input.namespace);
    const current = this.branches.get(branchId) ?? emptyBranch(input.namespace, input.action.createdAt);
    const result = applyCommit(structuredClone(current), input);
    this.branches.set(branchId, structuredClone(result.branch));
    return structuredClone(result);
  }

  async rollbackByMessageId(
    namespace: WorkbenchNamespace,
    assistantMessageId: number,
    now: number,
  ): Promise<CanonRollbackResult | null> {
    const branchId = canonBranchId(namespace);
    const current = this.branches.get(branchId);
    if (!current) return null;
    const result = applyRollback(structuredClone(current), assistantMessageId, now);
    if (!result) return null;
    this.branches.set(branchId, structuredClone(result.branch));
    return structuredClone(result);
  }
}

export class IndexedDbCanonRepository implements CanonRepository {
  async getBranch(namespace: WorkbenchNamespace): Promise<CanonBranch> {
    const database = await historyDatabase();
    const transaction = database.transaction(CANON_BRANCH_STORE, 'readonly');
    const stored = await requestResult<(CanonBranch & { namespaceKey: string }) | undefined>(
      transaction.objectStore(CANON_BRANCH_STORE).get(canonBranchId(namespace)),
    );
    await transactionComplete(transaction);
    if (!stored) return emptyBranch(namespace, 0);
    const { namespaceKey: _namespaceKey, ...branch } = stored;
    return branch;
  }

  async commitIntervention(input: CommitCanonInterventionInput): Promise<CanonCommitResult> {
    const database = await historyDatabase();
    const transaction = database.transaction(CANON_BRANCH_STORE, 'readwrite');
    const store = transaction.objectStore(CANON_BRANCH_STORE);
    const branchId = canonBranchId(input.namespace);
    const stored = await requestResult<(CanonBranch & { namespaceKey: string }) | undefined>(
      store.get(branchId),
    );
    const current = stored
      ? stripNamespaceKey(stored)
      : emptyBranch(input.namespace, input.action.createdAt);
    const result = applyCommit(current, input);
    store.put({ ...result.branch, namespaceKey: namespaceKey(input.namespace) });
    await transactionComplete(transaction);
    return result;
  }

  async rollbackByMessageId(
    namespace: WorkbenchNamespace,
    assistantMessageId: number,
    now: number,
  ): Promise<CanonRollbackResult | null> {
    const database = await historyDatabase();
    const transaction = database.transaction(CANON_BRANCH_STORE, 'readwrite');
    const store = transaction.objectStore(CANON_BRANCH_STORE);
    const branchId = canonBranchId(namespace);
    const stored = await requestResult<(CanonBranch & { namespaceKey: string }) | undefined>(
      store.get(branchId),
    );
    if (!stored) {
      await transactionComplete(transaction);
      return null;
    }
    const result = applyRollback(stripNamespaceKey(stored), assistantMessageId, now);
    if (result) store.put({ ...result.branch, namespaceKey: namespaceKey(namespace) });
    await transactionComplete(transaction);
    return result;
  }
}

/** P3-C：只在内存中构造候选分支，供事务外决定是否需要一次局部协调。 */
export function previewCanonIntervention(
  branch: CanonBranch,
  input: CommitCanonInterventionInput,
): CanonCommitResult {
  return applyCommit(structuredClone(branch), structuredClone(input));
}

function applyCommit(
  branch: CanonBranch,
  input: CommitCanonInterventionInput,
): CanonCommitResult {
  const previousBranch = structuredClone(branch);
  const existingRevision = branch.revisions.find(revision => {
    if (revision.status !== 'active') return false;
    return branch.actions.find(action => action.actionId === revision.actionId)?.runId
      === input.action.runId;
  });
  const existingAction = existingRevision
    ? branch.actions.find(action => action.actionId === existingRevision.actionId)
    : undefined;
  if (existingAction) {
    const delta = branch.deltas.find(item => item.deltaId === existingRevision?.deltaId);
    const receipt = delta && branch.receipts.find(item =>
      item.appliedDeltaIds.includes(delta.deltaId));
    if (!delta || !receipt) throw new Error('Canon branch contains an incomplete intervention commit');
    return { branch, action: existingAction, delta, receipt };
  }
  const parentRevision = branch.headRevision;
  const revision = Math.max(0, ...branch.revisions.map(item => item.revision)) + 1;
  const actionId = `action:${encodeURIComponent(branch.branchId)}:${revision}:${encodeURIComponent(input.action.runId)}`;
  const deltaId = `delta:${encodeURIComponent(branch.branchId)}:${revision}`;
  const action: InterventionAction = { ...input.action, actionId, branchId: branch.branchId };
  let operations = input.delta.operations.map(operation => ({
    ...operation,
    current: normalizeFactRevision(operation.current, revision),
  }));
  const reconciliation = input.causalReconcilePlan
    ? materializeCausalReconcilePlan({
      branch,
      parentRevision,
      branchId: branch.branchId,
      revision,
      deltaId,
      actionId,
      operations,
      causalPlan: input.causalPlan,
      plan: input.causalReconcilePlan,
    })
    : undefined;
  if (reconciliation) operations = reconciliation.operations;
  const causalMetadata: {
    causalBasis?: CanonOperationCausalBasis[];
    causalSupportUnits?: CanonCausalSupportUnit[];
  } = input.causalPlan
    ? materializeCausalPlan({
      branchId: branch.branchId,
      revision,
      deltaId,
      actionId,
      operations,
      plan: input.causalPlan,
    })
    : {};
  const causalSupportUnits = [
    ...(causalMetadata.causalSupportUnits ?? []),
    ...(reconciliation?.causalSupportUnits ?? []),
  ];
  const delta: InterventionDelta = {
    ...input.delta,
    ...causalMetadata,
    deltaId,
    branchId: branch.branchId,
    revision,
    parentRevision,
    actionRef: actionId,
    operations,
    ...(causalSupportUnits.length > 0 ? { causalSupportUnits } : {}),
    ...(reconciliation?.decisions.length
      ? { causalReconcileDecisions: reconciliation.decisions }
      : {}),
  };
  const receipt: CanonResolutionReceipt = {
    schema: 'eyon.canon.resolution-receipt.v1',
    receiptId: `canon-receipt:${encodeURIComponent(branch.branchId)}:${revision}`,
    branchId: branch.branchId,
    parentRevision,
    canonRevision: revision,
    appliedDeltaIds: [deltaId],
    skippedDeltaIds: [],
    supersededDeltaIds: [...delta.supersedesDeltaIds],
    orphanedDeltaIds: [],
    revertedDeltaIds: [],
    preserves: [...delta.preserves],
    affectedArtifactSegmentIds: [],
    resolutionMode: delta.verified ? 'deterministic' : 'safe-with-uncertainty',
    uncertainItems: delta.verified ? [] : ['delta-not-yet-verified-by-version-arbitration'],
    sourceRefs: uniqueStrings([
      ...action.sourceRefs,
      ...delta.operations.flatMap(operation => operation.current.sourceRefs),
    ]),
    durationMs: 0,
    createdAt: delta.createdAt,
    ...(reconciliation ? { causalReconcile: reconciliation.receipt } : {}),
  };
  branch.actions.push(action);
  branch.deltas.push(delta);
  branch.receipts.push(receipt);
  branch.revisions.push({
    revision,
    parentRevision,
    actionId,
    deltaId,
    assistantMessageId: action.assistantMessageId,
    status: 'active',
    receiptId: receipt.receiptId,
    createdAt: delta.createdAt,
  });
  branch.headRevision = revision;
  branch.updatedAt = delta.createdAt;
  const causalRebase = applyCanonCausalRebase(branch, previousBranch);
  receipt.causalRebase = causalRebase;
  receipt.orphanedDeltaIds = changedDeltaIds(causalRebase, branch, 'orphaned');
  receipt.supersededDeltaIds = uniqueStrings([
    ...receipt.supersededDeltaIds,
    ...changedDeltaIds(causalRebase, branch, 'superseded'),
  ]);
  receipt.resolutionMode = causalRebase.status === 'bounded-overflow'
    || causalRebase.uncertainOperationRefs.length > 0
    ? 'safe-with-uncertainty'
    : receipt.resolutionMode;
  receipt.uncertainItems = uniqueStrings([
    ...receipt.uncertainItems,
    ...causalRebase.uncertainOperationRefs.map(ref =>
      `${ref.deltaId}/${ref.factKey}: causal-rebase-uncertain`),
    ...causalRebase.warnings,
  ]);
  return { branch, action, delta, receipt };
}

function applyRollback(
  branch: CanonBranch,
  assistantMessageId: number,
  now: number,
): CanonRollbackResult | null {
  const previousBranch = structuredClone(branch);
  // 同一 AI 楼可能被多次重结算复用；删除该楼必须回滚该楼承载的全部版本。
  // P3-B 不再按版本号把所有后继 revision 粗暴孤儿化：后继 revision 恢复为可评估，
  // 其 direct / supported operation 由统一重基线函数逐项裁决。
  const targets = branch.revisions
    .filter(revision =>
      revision.status !== 'reverted'
      && revision.assistantMessageId === assistantMessageId
    )
    .sort((left, right) => left.revision - right.revision);
  if (targets.length === 0) return null;
  const targetRevisions = new Set(targets.map(target => target.revision));
  const maxTargetRevision = targets.at(-1)!.revision;
  const revertedDeltaIds: string[] = [];
  for (const revision of branch.revisions) {
    if (targetRevisions.has(revision.revision)) {
      revision.status = 'reverted';
      revision.revertedAt = now;
      revertedDeltaIds.push(revision.deltaId);
    } else if (revision.status === 'orphaned') {
      // 兼容 P3-B 前的“整段孤儿化”存档；恢复为 active 后再逐 operation 计算。
      revision.status = 'active';
      delete revision.revertedAt;
    }
  }
  branch.headRevision = Math.max(0, ...branch.revisions
    .filter(item => item.status === 'active')
    .map(item => item.revision));
  branch.updatedAt = now;
  const causalRebase = applyCanonCausalRebase(branch, previousBranch);
  const orphanedDeltaIds = changedDeltaIds(causalRebase, branch, 'orphaned');
  const supersededDeltaIds = changedDeltaIds(causalRebase, branch, 'superseded');
  const receipt: CanonResolutionReceipt = {
    schema: 'eyon.canon.resolution-receipt.v1',
    receiptId: `canon-receipt:${encodeURIComponent(branch.branchId)}:rollback-${targets.map(item => item.revision).join('-')}-${now}`,
    branchId: branch.branchId,
    parentRevision: maxTargetRevision,
    canonRevision: branch.headRevision,
    appliedDeltaIds: [],
    skippedDeltaIds: [],
    supersededDeltaIds,
    orphanedDeltaIds,
    revertedDeltaIds,
    preserves: [],
    affectedArtifactSegmentIds: [],
    resolutionMode: causalRebase.status === 'bounded-overflow'
      || causalRebase.uncertainOperationRefs.length > 0
      ? 'safe-with-uncertainty'
      : 'deterministic',
    uncertainItems: uniqueStrings([
      ...causalRebase.uncertainOperationRefs.map(ref =>
        `${ref.deltaId}/${ref.factKey}: causal-rebase-uncertain`),
      ...causalRebase.warnings,
    ]),
    sourceRefs: [],
    durationMs: 0,
    createdAt: now,
    causalRebase,
  };
  branch.receipts.push(receipt);
  return { branch, receipt };
}

function changedDeltaIds(
  rebase: NonNullable<CanonResolutionReceipt['causalRebase']>,
  branch: CanonBranch,
  status: InterventionDelta['status'],
): string[] {
  const changedIds = new Set(rebase.changedOperations.map(item => item.operationRef.deltaId));
  return uniqueStrings(branch.deltas
    .filter(delta => changedIds.has(delta.deltaId) && delta.status === status)
    .map(delta => delta.deltaId));
}

function materializeCausalReconcilePlan(input: {
  branch: CanonBranch;
  parentRevision: number;
  branchId: string;
  revision: number;
  deltaId: string;
  actionId: string;
  operations: InterventionDeltaOperation[];
  causalPlan?: CommitCanonCausalPlan;
  plan: CommitCanonReconcilePlan;
}): {
  operations: InterventionDeltaOperation[];
  causalSupportUnits: CanonCausalSupportUnit[];
  decisions: CanonCausalReconcileDecision[];
  receipt: CanonCausalReconcileReceipt;
} {
  const operations = structuredClone(input.operations);
  const warnings = new Set(input.plan.warnings);
  const supports: CanonCausalSupportUnit[] = [];
  const decisions: CanonCausalReconcileDecision[] = [];
  let dropped = input.plan.droppedProposalCount;
  let accepted = 0;

  const previousOperation = (reference: CanonOperationRef) => {
    const matches = input.branch.deltas.flatMap(delta => delta.operations
      .filter(operation => delta.deltaId === reference.deltaId
        && operation.factKey === reference.factKey)
      .map(operation => ({ delta, operation })));
    return matches.length === 1 ? matches[0]! : null;
  };
  const previousBasis = (reference: CanonOperationRef) => input.branch.deltas
    .flatMap(delta => delta.causalBasis ?? [])
    .find(item => sameOperationRef(item.operationRef, reference));
  const currentOperation = (factKey: string) => {
    const matches = operations.filter(operation => operation.factKey === factKey);
    return matches.length === 1 ? matches[0]! : null;
  };
  const resolveTarget = (target: CommitCanonReconcileTarget) => {
    if (target.kind === 'existing') {
      const resolved = previousOperation(target.operationRef);
      return resolved
        ? { operation: resolved.operation, operationRef: target.operationRef, current: false }
        : null;
    }
    const operation = currentOperation(target.factKey);
    return operation
      ? {
          operation,
          operationRef: { deltaId: input.deltaId, factKey: target.factKey },
          current: true,
        }
      : null;
  };
  const consideredOperationRefs = input.plan.consideredTargets
    .map(target => resolveTarget(target)?.operationRef)
    .filter((reference): reference is CanonOperationRef => reference !== undefined);
  const reject = (code: string) => {
    dropped += 1;
    warnings.add(code);
  };

  if (input.plan.expectedParentRevision !== input.parentRevision) {
    warnings.add(
      `canon-reconcile-stale-parent:${input.plan.expectedParentRevision}->${input.parentRevision}`,
    );
    const receipt: CanonCausalReconcileReceipt = {
      schema: 'eyon.canon.causal-reconcile-receipt.v1',
      status: 'stale',
      modelCalls: 1,
      repairCalls: input.plan.repairCalls,
      consideredOperationRefs: structuredClone(consideredOperationRefs),
      acceptedProposalCount: 0,
      droppedProposalCount: dropped + input.plan.proposals.length,
      decisionIds: [],
      supportIds: [],
      warnings: [...warnings].sort((left, right) => left.localeCompare(right, 'en')),
      failureCode: input.plan.failureCode ?? 'PARENT_REVISION_CHANGED',
    };
    return { operations, causalSupportUnits: [], decisions: [], receipt };
  }

  for (const [index, proposal] of input.plan.proposals.entries()) {
    const target = resolveTarget(proposal.target);
    if (!target) {
      reject(`canon-reconcile-target-unresolved:${index + 1}`);
      continue;
    }
    const currentTargetFactKey = proposal.target.kind === 'current'
      ? proposal.target.factKey
      : undefined;
    const currentTargetIsDirect = currentTargetFactKey !== undefined
      && (input.causalPlan?.directOperationFactKeys ?? []).includes(currentTargetFactKey);
    const currentTargetIsSupported = currentTargetFactKey === undefined
      || (input.causalPlan?.supports ?? []).some(support =>
        support.outputFactKey === currentTargetFactKey);
    if ((!target.current && previousBasis(target.operationRef)?.basis === 'direct')
      || currentTargetIsDirect) {
      reject(`canon-reconcile-direct-root-protected:${index + 1}`);
      continue;
    }
    if (target.current && !currentTargetIsSupported) {
      reject(`canon-reconcile-current-target-not-supported:${index + 1}`);
      continue;
    }
    if (proposal.sourceRefs.length === 0) {
      reject(`canon-reconcile-source-required:${index + 1}`);
      continue;
    }

    if (proposal.kind === 'support') {
      const refs = proposal.inputRefs
        .map(reference => materializeCausalRef(reference, input))
        .filter((reference): reference is CanonCausalRef => reference !== null);
      if (refs.length === 0 || refs.length !== proposal.inputRefs.length) {
        reject(`canon-reconcile-support-input-invalid:${index + 1}`);
        continue;
      }
      if (refs.some(reference => reference.kind === 'operation'
        && sameOperationRef(reference.operationRef, target.operationRef))) {
        reject(`canon-reconcile-self-support-rejected:${index + 1}`);
        continue;
      }
      const supportId = `support:${encodeURIComponent(input.deltaId)}:reconcile:${index + 1}`;
      supports.push({
        schema: 'eyon.canon.causal-support.v1',
        supportId,
        branchId: input.branchId,
        introducedRevision: input.revision,
        introducedByDeltaId: input.deltaId,
        inputRefs: refs,
        outputRef: { kind: 'operation', operationRef: target.operationRef },
        claimText: proposal.claimText.trim() || '局部替代支撑',
        sourceRefs: uniqueStrings(proposal.sourceRefs.filter(Boolean)),
      });
      accepted += 1;
      continue;
    }

    if (proposal.kind === 'replace') {
      const replacement = currentOperation(proposal.replacementFactKey);
      if (!replacement
        || (target.current && proposal.replacementFactKey === target.operationRef.factKey)
        || replacement.current.subjectEntityId !== target.operation.current.subjectEntityId
        || replacement.current.predicate !== target.operation.current.predicate) {
        reject(`canon-reconcile-replacement-incompatible:${index + 1}`);
        continue;
      }
      replacement.op = 'replace';
      replacement.originalFactIds = uniqueStrings([
        ...replacement.originalFactIds,
        target.operation.current.factId,
      ]);
      if (target.current) {
        const decisionId = `decision:${encodeURIComponent(input.deltaId)}:${index + 1}`;
        decisions.push({
          schema: 'eyon.canon.causal-reconcile-decision.v1',
          decisionId,
          branchId: input.branchId,
          introducedRevision: input.revision,
          introducedByDeltaId: input.deltaId,
          targetOperationRef: target.operationRef,
          decision: 'retire',
          reason: proposal.reason.trim() || '本次新结果由兼容结果替代',
          sourceRefs: uniqueStrings(proposal.sourceRefs.filter(Boolean)),
        });
      }
      accepted += 1;
      continue;
    }

    const decisionId = `decision:${encodeURIComponent(input.deltaId)}:${index + 1}`;
    decisions.push({
      schema: 'eyon.canon.causal-reconcile-decision.v1',
      decisionId,
      branchId: input.branchId,
      introducedRevision: input.revision,
      introducedByDeltaId: input.deltaId,
      targetOperationRef: target.operationRef,
      decision: proposal.decision,
      reason: proposal.reason.trim() || '局部因果协调',
      sourceRefs: uniqueStrings(proposal.sourceRefs.filter(Boolean)),
    });
    accepted += 1;
  }

  const failureCode = input.plan.failureCode;
  const receipt: CanonCausalReconcileReceipt = {
    schema: 'eyon.canon.causal-reconcile-receipt.v1',
    status: failureCode
      ? 'failed'
      : dropped > 0
      ? 'partial'
      : 'applied',
    modelCalls: 1,
    repairCalls: input.plan.repairCalls,
    consideredOperationRefs: structuredClone(consideredOperationRefs),
    acceptedProposalCount: accepted,
    droppedProposalCount: dropped,
    decisionIds: decisions.map(item => item.decisionId),
    supportIds: supports.map(item => item.supportId),
    warnings: [...warnings].sort((left, right) => left.localeCompare(right, 'en')),
    ...(failureCode ? { failureCode } : {}),
  };
  return { operations, causalSupportUnits: supports, decisions, receipt };
}

function normalizeFactRevision(fact: CanonFact, revision: number): CanonFact {
  return {
    ...fact,
    revisionIntroduced: revision,
    revisionRetired: null,
  };
}

function sameOperationRef(left: CanonOperationRef, right: CanonOperationRef): boolean {
  return left.deltaId === right.deltaId && left.factKey === right.factKey;
}

function materializeCausalPlan(input: {
  branchId: string;
  revision: number;
  deltaId: string;
  actionId: string;
  operations: InterventionDeltaOperation[];
  plan: CommitCanonCausalPlan;
}): {
  causalBasis: CanonOperationCausalBasis[];
  causalSupportUnits: CanonCausalSupportUnit[];
} {
  const multiplicity = new Map<string, number>();
  for (const operation of input.operations) {
    multiplicity.set(operation.factKey, (multiplicity.get(operation.factKey) ?? 0) + 1);
  }
  const directKeys = new Set(input.plan.directOperationFactKeys.filter(Boolean));
  const supports: CanonCausalSupportUnit[] = [];
  const supportIdsByOutput = new Map<string, string[]>();
  const unresolvedOutputs = new Set<string>();

  for (const [index, draft] of input.plan.supports.entries()) {
    const outputFactKey = draft.outputFactKey.trim();
    if (!outputFactKey || multiplicity.get(outputFactKey) !== 1) {
      if (outputFactKey) unresolvedOutputs.add(outputFactKey);
      continue;
    }
    const inputRefs = draft.inputRefs
      .map(reference => materializeCausalRef(reference, input))
      .filter((reference): reference is CanonCausalRef => reference !== null);
    if (inputRefs.length !== draft.inputRefs.length || inputRefs.length === 0) {
      unresolvedOutputs.add(outputFactKey);
      continue;
    }
    const supportId = `support:${encodeURIComponent(input.deltaId)}:${index + 1}`;
    supports.push({
      schema: 'eyon.canon.causal-support.v1',
      supportId,
      branchId: input.branchId,
      introducedRevision: input.revision,
      introducedByDeltaId: input.deltaId,
      inputRefs,
      outputRef: {
        kind: 'operation',
        operationRef: { deltaId: input.deltaId, factKey: outputFactKey },
      },
      claimText: draft.claimText.trim() || '因果阶段承接',
      sourceRefs: uniqueStrings(draft.sourceRefs.filter(Boolean)),
    });
    const ids = supportIdsByOutput.get(outputFactKey) ?? [];
    ids.push(supportId);
    supportIdsByOutput.set(outputFactKey, ids);
  }

  const causalBasis: CanonOperationCausalBasis[] = [];
  for (const factKey of uniqueStrings(input.operations.map(operation => operation.factKey))) {
    const operationRef = { deltaId: input.deltaId, factKey };
    if (multiplicity.get(factKey) !== 1) {
      causalBasis.push({ basis: 'opaque', operationRef, reason: 'ambiguous-operation-fact-key' });
      continue;
    }
    const supportIds = supportIdsByOutput.get(factKey) ?? [];
    if (supportIds.length > 0) {
      causalBasis.push({ basis: 'supported', operationRef, supportIds });
      continue;
    }
    if (directKeys.has(factKey)) {
      causalBasis.push({ basis: 'direct', operationRef });
      continue;
    }
    causalBasis.push({
      basis: 'opaque',
      operationRef,
      reason: unresolvedOutputs.has(factKey)
        ? 'causal-support-unresolved'
        : 'causal-basis-not-recorded',
    });
  }
  return { causalBasis, causalSupportUnits: supports };
}

function materializeCausalRef(
  reference: CommitCanonCausalInputRef,
  input: {
    deltaId: string;
    actionId: string;
    operations: InterventionDeltaOperation[];
  },
): CanonCausalRef | null {
  if (reference.kind === 'action') return { kind: 'action', actionId: input.actionId };
  if (reference.kind === 'fact') {
    const factId = reference.factId.trim();
    return factId ? { kind: 'fact', factId } : null;
  }
  const factKey = reference.factKey.trim();
  if (!factKey) return null;
  const matches = input.operations.filter(operation => operation.factKey === factKey);
  if (matches.length !== 1) return null;
  return { kind: 'operation', operationRef: { deltaId: input.deltaId, factKey } };
}

function emptyBranch(namespace: WorkbenchNamespace, now: number): CanonBranch {
  return {
    schema: 'eyon.canon.branch.v1',
    branchId: canonBranchId(namespace),
    characterKey: namespace.characterKey,
    chatId: namespace.chatId,
    headRevision: 0,
    revisions: [],
    actions: [],
    deltas: [],
    receipts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function stripNamespaceKey(value: CanonBranch & { namespaceKey: string }): CanonBranch {
  const { namespaceKey: _namespaceKey, ...branch } = value;
  return branch;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
