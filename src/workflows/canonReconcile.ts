import type { GenerationAdapter } from '../adapters/host.ts';
import { projectCanonCausalRebase } from '../core/causalRebase.ts';
import type { ActiveEvidenceView } from '../prompts/activeEvidence.ts';
import type {
  CanonBranch,
  CanonCausalRef,
  CanonCausalSupportUnit,
  CanonOperationRef,
  InterventionDeltaOperation,
} from '../retrieval/contracts.ts';
import { isTaskCancellationError } from '../runtime/tavernGeneration.ts';
import {
  previewCanonIntervention,
  type CanonRepository,
  type CommitCanonInterventionInput,
  type CommitCanonReconcilePlan,
  type CommitCanonReconcileTarget,
} from '../storage/canon.ts';

const MAX_TARGETS = 8;
const MAX_NEW_OPERATIONS = 12;
const MAX_SUPPORTS = 16;

interface ReconcileTarget {
  handle: string;
  target: CommitCanonReconcileTarget;
  statement: string;
  state: 'orphaned' | 'uncertain';
  supports: CanonCausalSupportUnit[];
  sourceRefs: string[];
}

interface ReconcileTask {
  branch: CanonBranch;
  targets: ReconcileTarget[];
  newOperations: Array<{
    handle: string;
    factKey: string;
    statement: string;
    sourceRefs: string[];
  }>;
  sourceByHandle: Map<string, string>;
  prompt: string;
}

/**
 * P3-C 唯一模型入口。无准入目标时严格 no-op；失败时返回带 uncertain
 * 决策的提交草案，让确定安全子集仍能在原有单次 Canon 事务里发布。
 */
export async function reconcileCanonIntervention(input: {
  repository: CanonRepository;
  generator: GenerationAdapter;
  intervention: CommitCanonInterventionInput;
  activeEvidence?: ActiveEvidenceView;
}): Promise<CommitCanonInterventionInput> {
  const branch = await input.repository.getBranch(input.intervention.namespace);
  const task = buildReconcileTask(branch, input.intervention, input.activeEvidence);
  if (!task) return input.intervention;

  let repairCalls: 0 | 1 = 0;
  try {
    let raw = await input.generator.generate('butterfly', task.prompt, {
      purpose: 'canon-reconcile',
      progressLabel: '局部因果协调',
    });
    let parsed = parseEnvelope(raw, task);
    if (!parsed.envelopeValid) {
      repairCalls = 1;
      raw = await input.generator.generate(
        'butterfly',
        buildRepairPrompt(task.prompt, parsed.error),
        { purpose: 'canon-reconcile', progressLabel: '局部因果协调修复' },
      );
      parsed = parseEnvelope(raw, task);
    }
    if (!parsed.envelopeValid) {
      return withFailurePlan(input.intervention, task, repairCalls, 'RECONCILE_SCHEMA_INVALID', [
        parsed.error,
      ]);
    }
    return {
      ...input.intervention,
      causalReconcilePlan: finalizePlan({
        intervention: input.intervention,
        task,
        repairCalls,
        proposals: parsed.proposals,
        dropped: parsed.dropped,
        warnings: parsed.warnings,
      }),
    };
  } catch (error) {
    if (isTaskCancellationError(error)) throw error;
    return withFailurePlan(
      input.intervention,
      task,
      repairCalls,
      'RECONCILE_GENERATION_FAILED',
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function buildReconcileTask(
  branch: CanonBranch,
  intervention: CommitCanonInterventionInput,
  activeEvidence?: ActiveEvidenceView,
): ReconcileTask | null {
  const preview = previewCanonIntervention(branch, intervention);
  const rebase = preview.receipt.causalRebase;
  if (!rebase || rebase.status === 'bounded-overflow') return null;

  const projection = projectCanonCausalRebase(preview.branch);
  if (projection.status !== 'projected') return null;
  const replacedFactIds = new Set(intervention.delta.operations
    .flatMap(operation => operation.originalFactIds));
  if (replacedFactIds.size === 0) return null;

  const operationByRef = new Map(preview.branch.deltas.flatMap(delta =>
    delta.operations.map(operation => [
      operationRefKey({ deltaId: delta.deltaId, factKey: operation.factKey }),
      operation,
    ] as const)));
  const basisByRef = new Map(preview.branch.deltas.flatMap(delta =>
    (delta.causalBasis ?? []).map(basis => [operationRefKey(basis.operationRef), basis] as const)));
  const supportById = new Map(preview.branch.deltas.flatMap(delta =>
    (delta.causalSupportUnits ?? []).map(support => [support.supportId, support] as const)));
  const supportStateById = new Map(projection.supportStates.map(item => [item.supportId, item.state]));
  const operationStateByRef = new Map(projection.operationStates.map(item => [
    operationRefKey(item.operationRef),
    item,
  ]));

  const changedTargets = rebase.changedOperations.filter(item =>
    item.previousState === 'active'
    && (item.currentState === 'orphaned' || item.currentState === 'uncertain'));
  const targets: ReconcileTarget[] = [];
  for (const changed of changedTargets) {
    if (basisByRef.get(operationRefKey(changed.operationRef))?.basis === 'direct') continue;
    const operation = operationByRef.get(operationRefKey(changed.operationRef));
    if (!operation) continue;
    const relatedSupports = [...supportById.values()].filter(support =>
      support.outputRef.kind === 'operation'
      && sameOperationRef(support.outputRef.operationRef, changed.operationRef)
      && support.inputRefs.some(reference => referencesReplacedFact(
        reference,
        replacedFactIds,
        operationByRef,
      ))
      && supportStateById.get(support.supportId) !== 'satisfied');
    if (relatedSupports.length === 0) continue;
    targets.push({
      handle: `O${targets.length + 1}`,
      target: { kind: 'existing', operationRef: changed.operationRef },
      statement: operation.current.statement,
      state: changed.currentState === 'orphaned' ? 'orphaned' : 'uncertain',
      supports: relatedSupports.slice(0, MAX_SUPPORTS),
      sourceRefs: uniqueStrings([
        ...operation.current.sourceRefs,
        ...relatedSupports.flatMap(support => support.sourceRefs),
      ]),
    });
    if (targets.length >= MAX_TARGETS) break;
  }

  // P3-C 还必须看见“本次干涉刚生成、但预演时已失去支撑”的局部结果。
  // 它们没有 previousState，不能依赖 changedOperations 进入协调。
  if (targets.length < MAX_TARGETS) {
    for (const operation of preview.delta.operations) {
      const reference = { deltaId: preview.delta.deltaId, factKey: operation.factKey };
      const key = operationRefKey(reference);
      const state = operationStateByRef.get(key);
      if (!state || (state.state !== 'orphaned' && state.state !== 'uncertain')) continue;
      if (basisByRef.get(key)?.basis !== 'supported') continue;
      const relatedSupports = [...supportById.values()].filter(support =>
        support.outputRef.kind === 'operation'
        && sameOperationRef(support.outputRef.operationRef, reference)
        && supportStateById.get(support.supportId) !== 'satisfied');
      if (relatedSupports.length === 0) continue;
      targets.push({
        handle: `O${targets.length + 1}`,
        target: { kind: 'current', factKey: operation.factKey },
        statement: operation.current.statement,
        state: state.state,
        supports: relatedSupports.slice(0, MAX_SUPPORTS),
        sourceRefs: uniqueStrings([
          ...operation.current.sourceRefs,
          ...relatedSupports.flatMap(support => support.sourceRefs),
        ]),
      });
      if (targets.length >= MAX_TARGETS) break;
    }
  }
  if (targets.length === 0) return null;

  const newOperations = intervention.delta.operations
    .slice(0, MAX_NEW_OPERATIONS)
    .map((operation, index) => ({
      handle: `N${index + 1}`,
      factKey: operation.factKey,
      statement: operation.current.statement,
      sourceRefs: operation.current.sourceRefs,
    }));
  if (newOperations.length === 0) return null;

  const sourceRefs = uniqueStrings([
    ...intervention.action.sourceRefs,
    ...targets.flatMap(target => target.sourceRefs),
    ...newOperations.flatMap(operation => operation.sourceRefs),
  ]).slice(0, 24);
  if (sourceRefs.length === 0) return null;
  const sourceByHandle = new Map(sourceRefs.map((sourceRef, index) => [`R${index + 1}`, sourceRef]));
  const handleBySource = new Map([...sourceByHandle].map(([handle, source]) => [source, handle]));
  const localSupports = targets.flatMap(target => target.supports.map(support => ({
    target: target.handle,
    state: supportStateById.get(support.supportId) ?? 'uncertain',
    claim: support.claimText,
    sources: support.sourceRefs.map(source => handleBySource.get(source)).filter(Boolean),
  })));
  const background = (activeEvidence?.canonResolvedView?.activeRevisionFacts ?? [])
    .slice(0, 8)
    .map(fact => ({
      statement: fact.statement,
      time: fact.temporalScope,
      location: fact.spatialScope,
      note: 'background_only_not_hard_cause',
    }));
  const requestData = {
    currentRevision: branch.headRevision,
    playerAction: intervention.action.actionRecord || intervention.action.rawCommand,
    actionTime: intervention.action.occurredAt.label,
    locations: intervention.delta.cascadeScope.locations,
    affectedResults: targets.map(target => ({
      handle: target.handle,
      state: target.state,
      statement: target.statement,
    })),
    currentNewOperations: newOperations.map(operation => ({
      handle: operation.handle,
      statement: operation.statement,
    })),
    localSupports,
    sources: [...sourceByHandle.keys()].map(handle => ({
      handle,
      meaning: handle === 'R1' ? 'current_action_or_local_evidence' : 'local_evidence',
    })),
    relevantBackground: background,
  };
  const prompt = `<CANON_RECONCILE>
You are deciding only the listed local causal frontier. Background is soft context, never a hard cause by itself.
Player action is immutable. Never invent a person, organization, event, source, or handle.
For each affected result choose only:
- "retire": the listed old result no longer follows;
- "uncertain": evidence cannot decide;
- "keep" or "reconnect": requires one or more N handles as inputs plus a short claim;
- "replace": requires exactly one compatible N handle.
Use only listed O/N/R handles. Every proposal requires at least one R source handle.
Bad or unsupported items will be dropped independently.
<REQUEST_DATA>${JSON.stringify(requestData)}</REQUEST_DATA>
<MANDATORY_FINAL_OUTPUT_CONTRACT>
Return exactly one JSON object:
{"schema":"eyon.canon.reconcile-proposal.v1","proposals":[{"target":"O1","decision":"retire|uncertain|keep|reconnect|replace","inputs":["N1"],"via":"N1","claim":"short natural-language reason or support","sources":["R1"]}]}
For retire/uncertain, inputs and via may be omitted. For keep/reconnect, inputs is required. For replace, via is required.
</MANDATORY_FINAL_OUTPUT_CONTRACT>
</CANON_RECONCILE>`;
  return { branch, targets, newOperations, sourceByHandle, prompt };
}

function parseEnvelope(raw: string, task: ReconcileTask): {
  envelopeValid: boolean;
  proposals: CommitCanonReconcilePlan['proposals'];
  dropped: number;
  warnings: string[];
  error: string;
} {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(raw));
  } catch {
    return invalidEnvelope('response-is-not-json');
  }
  if (!isRecord(value)
    || value.schema !== 'eyon.canon.reconcile-proposal.v1'
    || !Array.isArray(value.proposals)) {
    return invalidEnvelope('response-envelope-invalid');
  }

  const targetByHandle = new Map(task.targets.map(target => [target.handle, target]));
  const newByHandle = new Map(task.newOperations.map(operation => [operation.handle, operation]));
  const proposals: CommitCanonReconcilePlan['proposals'] = [];
  const warnings: string[] = [];
  const acceptedTargets = new Set<string>();
  let dropped = 0;
  for (const [index, item] of value.proposals.entries()) {
    if (!isRecord(item)) {
      dropped += 1;
      warnings.push(`proposal-${index + 1}-not-object`);
      continue;
    }
    const target = typeof item.target === 'string' ? targetByHandle.get(item.target) : undefined;
    const decision = typeof item.decision === 'string' ? item.decision : '';
    const sourceHandles = stringArray(item.sources);
    const sources = sourceHandles
      .map(handle => task.sourceByHandle.get(handle))
      .filter((source): source is string => !!source);
    if (!target || sources.length === 0 || sources.length !== sourceHandles.length) {
      dropped += 1;
      warnings.push(`proposal-${index + 1}-handle-or-source-invalid`);
      continue;
    }
    if (acceptedTargets.has(target.handle)) {
      dropped += 1;
      warnings.push(`proposal-${index + 1}-duplicate-target`);
      continue;
    }
    const claim = typeof item.claim === 'string' ? item.claim.trim() : '';
    if (decision === 'retire' || decision === 'uncertain') {
      proposals.push({
        kind: 'decision',
        target: target.target,
        decision,
        reason: claim || (decision === 'retire' ? '旧结果不再由现行因果支撑' : '局部证据不足'),
        sourceRefs: uniqueStrings(sources),
      });
      acceptedTargets.add(target.handle);
      continue;
    }
    if (decision === 'keep' || decision === 'reconnect') {
      const inputs = stringArray(item.inputs).map(handle => newByHandle.get(handle));
      if (!claim || inputs.length === 0 || inputs.some(operation => !operation)) {
        dropped += 1;
        warnings.push(`proposal-${index + 1}-support-invalid`);
        continue;
      }
      proposals.push({
        kind: 'support',
        target: target.target,
        inputRefs: inputs.map(operation => ({
          kind: 'operation' as const,
          factKey: operation!.factKey,
        })),
        claimText: claim,
        sourceRefs: uniqueStrings(sources),
      });
      acceptedTargets.add(target.handle);
      continue;
    }
    if (decision === 'replace') {
      const replacement = typeof item.via === 'string' ? newByHandle.get(item.via) : undefined;
      if (!replacement) {
        dropped += 1;
        warnings.push(`proposal-${index + 1}-replacement-invalid`);
        continue;
      }
      proposals.push({
        kind: 'replace',
        target: target.target,
        replacementFactKey: replacement.factKey,
        reason: claim || '本次新结果替代旧结果',
        sourceRefs: uniqueStrings(sources),
      });
      acceptedTargets.add(target.handle);
      continue;
    }
    dropped += 1;
    warnings.push(`proposal-${index + 1}-decision-invalid`);
  }
  return {
    envelopeValid: true,
    proposals,
    dropped,
    warnings,
    error: '',
  };
}

function finalizePlan(input: {
  intervention: CommitCanonInterventionInput;
  task: ReconcileTask;
  repairCalls: 0 | 1;
  proposals: CommitCanonReconcilePlan['proposals'];
  dropped: number;
  warnings: string[];
}): CommitCanonReconcilePlan {
  const addressed = new Set(input.proposals.map(proposal => reconcileTargetKey(proposal.target)));
  const fallbackSources = uniqueStrings([
    ...input.intervention.action.sourceRefs,
    ...input.task.targets.flatMap(target => target.sourceRefs),
  ]);
  const proposals = [...input.proposals];
  for (const target of input.task.targets) {
    if (addressed.has(reconcileTargetKey(target.target))) continue;
    proposals.push({
      kind: 'decision',
      target: target.target,
      decision: 'uncertain',
      reason: '协调未给出可验证的局部裁决',
      sourceRefs: fallbackSources,
    });
  }
  return {
    expectedParentRevision: input.task.branch.headRevision,
    modelCalls: 1,
    repairCalls: input.repairCalls,
    consideredTargets: input.task.targets.map(target => target.target),
    proposals,
    droppedProposalCount: input.dropped,
    warnings: input.warnings,
    ...(input.proposals.length === 0 ? { failureCode: 'NO_VALID_PROPOSALS' } : {}),
  };
}

function withFailurePlan(
  intervention: CommitCanonInterventionInput,
  task: ReconcileTask,
  repairCalls: 0 | 1,
  failureCode: string,
  warnings: string[],
): CommitCanonInterventionInput {
  const sourceRefs = uniqueStrings([
    ...intervention.action.sourceRefs,
    ...task.targets.flatMap(target => target.sourceRefs),
  ]);
  return {
    ...intervention,
    causalReconcilePlan: {
      expectedParentRevision: task.branch.headRevision,
      modelCalls: 1,
      repairCalls,
      consideredTargets: task.targets.map(target => target.target),
      proposals: task.targets.map(target => ({
        kind: 'decision' as const,
        target: target.target,
        decision: 'uncertain' as const,
        reason: '局部协调失败，保留不确定状态',
        sourceRefs,
      })),
      droppedProposalCount: 0,
      warnings: warnings.filter(Boolean),
      failureCode,
    },
  };
}

function buildRepairPrompt(original: string, error: string): string {
  return `<CANON_RECONCILE_REPAIR>
The previous response failed only the JSON envelope (${error}). Re-read the bounded task below and return the required single JSON object. Do not add explanations.
${original}
</CANON_RECONCILE_REPAIR>`;
}

function referencesReplacedFact(
  reference: CanonCausalRef,
  replacedFactIds: Set<string>,
  operationByRef: Map<string, InterventionDeltaOperation>,
): boolean {
  if (reference.kind === 'fact') return replacedFactIds.has(reference.factId);
  if (reference.kind === 'operation') {
    const operation = operationByRef.get(operationRefKey(reference.operationRef));
    return !!operation && replacedFactIds.has(operation.current.factId);
  }
  return false;
}

function invalidEnvelope(error: string) {
  return {
    envelopeValid: false as const,
    proposals: [] as CommitCanonReconcilePlan['proposals'],
    dropped: 0,
    warnings: [] as string[],
    error,
  };
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match?.[1]?.trim() ?? trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sameOperationRef(left: CanonOperationRef, right: CanonOperationRef): boolean {
  return left.deltaId === right.deltaId && left.factKey === right.factKey;
}

function operationRefKey(reference: CanonOperationRef): string {
  return `${reference.deltaId}\u0000${reference.factKey}`;
}

function reconcileTargetKey(target: CommitCanonReconcileTarget): string {
  return target.kind === 'existing'
    ? `existing\u0000${operationRefKey(target.operationRef)}`
    : `current\u0000${target.factKey}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
