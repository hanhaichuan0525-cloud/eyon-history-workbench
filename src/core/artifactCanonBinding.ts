import type {
  ArtifactCanonBinding,
  ArtifactCanonBoundView,
  CanonBranch,
  CanonResolvedView,
  EvidencePassage,
  InterventionDelta,
} from '../retrieval/contracts.ts';
import type { BiographyPassageResponse } from '../schemas/biography.ts';
import type { ButterflyResult } from '../schemas/butterfly.ts';
import type { GenealogyResult } from '../schemas/genealogy.ts';
import type { RuinCandidates } from '../schemas/ruin.ts';
import type { GenealogyEvidenceRoster } from './genealogyEvidence.ts';

export interface ArtifactCanonBindingUnitInput {
  unitType: string;
  unitId: string;
  entityNames?: string[];
  entityIds?: string[];
  factIds?: string[];
  /** 产物由某次 Canon 操作直接生成时，显式绑定该操作。 */
  operationRefs?: ArtifactCanonBinding['operationRefs'];
  sourceRefs?: string[];
}

export interface ArtifactCanonBindingBuildInput {
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  view?: CanonResolvedView | ArtifactCanonBoundView;
  /** 冻结视图只保留身份时，另存其 receipt 中实际 applied 的 delta IDs。 */
  appliedDeltaIds?: string[];
  branch?: CanonBranch;
  units: ArtifactCanonBindingUnitInput[];
  createdAt: number;
}

export interface ArtifactCanonBindingDiagnostic {
  code: 'binding-missing';
  artifactType: ArtifactCanonBinding['artifactType'];
  artifactId: string;
  unitType?: string;
  unitId?: string;
  message: string;
  createdAt: number;
}

const DIAGNOSTIC_LIMIT = 64;
const diagnostics: ArtifactCanonBindingDiagnostic[] = [];

export function artifactCanonBoundView(
  view: CanonResolvedView,
): ArtifactCanonBoundView {
  return {
    branchId: view.branchId,
    viewId: view.viewId,
    resolvedRevision: view.resolvedRevision,
    queryScopeHash: view.queryScopeHash,
  };
}

/**
 * 只消费已验证结构字段；不解析正文、不猜关键词，也不触发任何模型或检索。
 */
export function buildArtifactCanonBindings(
  input: ArtifactCanonBindingBuildInput,
): ArtifactCanonBinding[] {
  const view = input.view;
  if (!view) throw new Error('The committed artifact did not retain its consumed Canon view');
  if (!input.artifactId.trim()) throw new Error('Artifact id is empty');

  const resolvedView = isCanonResolvedView(view) ? view : null;
  const factsById = new Map(
    (resolvedView?.activeFacts ?? []).map(fact => [fact.factId, fact]),
  );
  if (!resolvedView) {
    const appliedDeltaIds = new Set(input.appliedDeltaIds ?? []);
    for (const delta of input.branch?.deltas ?? []) {
      if (!appliedDeltaIds.has(delta.deltaId)) continue;
      for (const operation of delta.operations) {
        factsById.set(operation.current.factId, operation.current);
      }
    }
  }

  return input.units.map(unit => {
    if (!unit.unitType.trim() || !unit.unitId.trim()) {
      throw new Error('Artifact binding unit identity is empty');
    }
    const factIds = uniqueSorted(unit.factIds ?? [])
      .filter(factId => factsById.has(factId));
    const appliedDeltaIds = isCanonResolvedView(view)
      ? view.resolutionReceipt.appliedDeltaIds
      : input.appliedDeltaIds ?? [];
    if (factIds.length > 0 && appliedDeltaIds.length > 0 && !input.branch) {
      throw new Error('Canon branch is unavailable for applied operation tracing');
    }
    const entityIds = new Set(uniqueSorted(unit.entityIds ?? []));
    for (const name of unit.entityNames ?? []) {
      const normalized = normalizeName(name);
      const person = resolvedView?.personViews.find(item =>
        [item.canonicalName, ...item.aliases]
          .some(candidate => normalizeName(candidate) === normalized));
      if (person) entityIds.add(person.entityId);
    }
    for (const factId of factIds) {
      const fact = factsById.get(factId);
      if (fact) entityIds.add(fact.subjectEntityId);
    }
    const operationRefs = uniqueOperationRefs([
      ...resolveOperationRefs(
        input.branch,
        view,
        factIds,
        input.appliedDeltaIds,
      ),
      ...(unit.operationRefs ?? []),
    ]);
    const canonical = {
      schema: 'eyon.canon.artifact-binding.v1' as const,
      branchId: view.branchId,
      artifactType: input.artifactType,
      artifactId: input.artifactId,
      unitType: unit.unitType,
      unitId: unit.unitId,
      boundView: {
        viewId: view.viewId,
        resolvedRevision: view.resolvedRevision,
        queryScopeHash: view.queryScopeHash,
      },
      entityIds: [...entityIds].sort(compareText),
      factIds,
      operationRefs,
      sourceRefs: uniqueSorted(unit.sourceRefs ?? []),
      createdAt: input.createdAt,
    };
    return {
      ...canonical,
      bindingId: `artifact-binding:${fingerprint(JSON.stringify(canonical))}`,
    };
  }).sort(compareBindings);
}

/** 绑定失败只留下诊断，绝不破坏已经通过 validator 的产物。 */
export function buildArtifactCanonBindingsSafely(
  input: ArtifactCanonBindingBuildInput,
): ArtifactCanonBinding[] {
  if (!input.view || !input.artifactId.trim()) {
    recordBindingDiagnostic(input);
    return [];
  }
  const bindings: ArtifactCanonBinding[] = [];
  for (const unit of input.units) {
    try {
      bindings.push(...buildArtifactCanonBindings({ ...input, units: [unit] }));
    } catch (error) {
      recordBindingDiagnostic(input, unit, error);
    }
  }
  return bindings.sort(compareBindings);
}

function recordBindingDiagnostic(
  input: ArtifactCanonBindingBuildInput,
  unit?: ArtifactCanonBindingUnitInput,
  error?: unknown,
): void {
  let message: string;
  try {
    if (error) throw error;
    buildArtifactCanonBindings({ ...input, units: unit ? [unit] : input.units });
    message = 'Artifact binding could not be established';
  } catch (caught) {
    message = caught instanceof Error ? caught.message : String(caught);
  }
  diagnostics.push({
    code: 'binding-missing',
    artifactType: input.artifactType,
    artifactId: input.artifactId,
    ...(unit ? { unitType: unit.unitType, unitId: unit.unitId } : {}),
    message,
    createdAt: input.createdAt,
  });
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
}

export function listArtifactCanonBindingDiagnostics(): ArtifactCanonBindingDiagnostic[] {
  return structuredClone(diagnostics);
}

export function clearArtifactCanonBindingDiagnosticsForTest(): void {
  diagnostics.length = 0;
}

export function mergeArtifactCanonBindings(
  current: ArtifactCanonBinding[] | undefined,
  incoming: ArtifactCanonBinding[],
): ArtifactCanonBinding[] {
  const byId = new Map((current ?? []).map(binding => [binding.bindingId, binding]));
  for (const binding of incoming) byId.set(binding.bindingId, binding);
  return [...byId.values()].sort(compareBindings);
}

export function biographyBindingUnits(
  passages: Iterable<BiographyPassageResponse>,
  targetNames: string[],
): ArtifactCanonBindingUnitInput[] {
  return [...passages].map(passage => ({
    unitType: passage.kind,
    unitId: passage.passageId,
    entityNames: uniqueSorted([
      ...targetNames,
      ...passage.people,
      ...passage.factions,
      ...passage.objects,
      ...passage.locations,
    ]),
    factIds: [passage.eventId],
    sourceRefs: passage.sourceRefs,
  }));
}

export function genealogyBindingUnits(
  result: GenealogyResult,
  roster: GenealogyEvidenceRoster,
): ArtifactCanonBindingUnitInput[] {
  const peopleByName = new Map<string, GenealogyEvidenceRoster['persons'][number]>();
  for (const person of roster.persons) {
    for (const name of [person.canonicalName, ...person.aliases]) {
      peopleByName.set(normalizeName(name), person);
    }
  }
  const nodeNames = new Map(result.nodes.map(node => [node.id, node.name]));
  return [
    ...result.nodes.map(node => {
      const person = peopleByName.get(normalizeName(node.name));
      return {
        unitType: 'node',
        unitId: node.id,
        entityNames: [node.name, ...node.aliases],
        factIds: person?.factIds ?? [],
        sourceRefs: node.sourceRefs,
      };
    }),
    ...result.edges.map(edge => {
      const fromName = nodeNames.get(edge.from) ?? edge.from;
      const toName = nodeNames.get(edge.to) ?? edge.to;
      const relation = roster.relations.find(item =>
        normalizeName(item.fromName) === normalizeName(fromName)
        && normalizeName(item.toName) === normalizeName(toName)
        && item.relationType === edge.relationType);
      return {
        unitType: 'edge',
        unitId: edge.id,
        entityNames: [fromName, toName],
        factIds: relation?.factIds ?? [],
        sourceRefs: edge.sourceRefs,
      };
    }),
  ];
}

export function ruinBindingUnits(
  result: RuinCandidates,
  passages: ReadonlyArray<Pick<EvidencePassage, 'passageId' | 'sourceId'>> = [],
): ArtifactCanonBindingUnitInput[] {
  const sourceByPassageId = new Map(
    passages.map(passage => [passage.passageId, passage.sourceId]),
  );
  return result.candidates.flatMap(candidate => {
    const candidateNames = uniqueSorted([
      ...candidate.cast.map(item => item.name),
      ...candidate.selectedCharacterUsage.map(item => item.name),
    ]);
    const factIds = uniqueSorted([
      ...(candidate.canonInterpretation?.evidenceFactIds ?? []),
      ...(candidate.canonInterpretation?.assumptions.flatMap(item => item.evidenceFactIds) ?? []),
    ]);
    const citedSourceRefs = uniqueSorted([
      ...(candidate.canonInterpretation?.evidencePassageIds ?? []),
      ...(candidate.canonInterpretation?.assumptions
        .flatMap(item => item.evidencePassageIds) ?? []),
    ].filter((passageId): passageId is string => Boolean(passageId)).flatMap(passageId => {
      const sourceId = sourceByPassageId.get(passageId);
      return sourceId ? [sourceId] : [];
    }));
    return [
      {
        unitType: 'candidate',
        unitId: candidate.id,
        entityNames: candidateNames,
        sourceRefs: candidate.sourceRefs,
      },
      {
        unitType: 'candidate-history',
        unitId: `${candidate.id}:history`,
        entityNames: candidateNames,
        factIds,
        sourceRefs: uniqueSorted([...candidate.sourceRefs, ...citedSourceRefs]),
      },
      ...candidate.nodes.map(node => ({
        unitType: 'node',
        // node.id 只保证候选内部唯一；绑定身份必须同时保留候选作用域。
        unitId: `${candidate.id}:${node.id}`,
        entityNames: uniqueSorted([
          ...node.participants,
          ...node.interests.map(item => item.actor),
        ]),
        sourceRefs: node.sourceRefs,
      })),
    ];
  });
}

export function butterflyBindingUnits(input: {
  result: ButterflyResult;
  actionId: string;
  delta: InterventionDelta;
  runId: string;
}): ArtifactCanonBindingUnitInput[] {
  const operations = input.delta.operations;
  const sharedDependencies = uniqueSorted([
    ...input.delta.preconditionFactIds,
    ...operations.flatMap(operation => operation.originalFactIds),
  ]);
  const deltaOperationRefs = operations.map(operation => ({
    deltaId: input.delta.deltaId,
    factKey: operation.factKey,
  }));
  return [
    {
      unitType: 'action',
      unitId: input.actionId,
      entityIds: uniqueSorted(operations.map(item => item.current.subjectEntityId)),
      factIds: sharedDependencies,
      operationRefs: deltaOperationRefs,
      sourceRefs: input.result.sourceIds,
    },
    ...operations.map(operation => ({
      unitType: 'operation',
      unitId: `${input.delta.deltaId}:${operation.factKey}`,
      entityIds: [operation.current.subjectEntityId],
      factIds: uniqueSorted([
        ...input.delta.preconditionFactIds,
        ...operation.originalFactIds,
      ]),
      operationRefs: [{
        deltaId: input.delta.deltaId,
        factKey: operation.factKey,
      }],
      sourceRefs: operation.current.sourceRefs,
    })),
    {
      unitType: 'panel',
      unitId: `${input.runId}:panel`,
      entityIds: uniqueSorted(operations.map(item => item.current.subjectEntityId)),
      factIds: sharedDependencies,
      operationRefs: deltaOperationRefs,
      sourceRefs: input.result.sourceIds,
    },
  ];
}

function uniqueOperationRefs(
  refs: ArtifactCanonBinding['operationRefs'],
): ArtifactCanonBinding['operationRefs'] {
  const byKey = new Map<string, ArtifactCanonBinding['operationRefs'][number]>();
  for (const ref of refs) {
    const deltaId = ref.deltaId.trim();
    const factKey = ref.factKey.trim();
    if (!deltaId || !factKey) continue;
    byKey.set(`${deltaId}\u0000${factKey}`, { deltaId, factKey });
  }
  return [...byKey.values()].sort((left, right) =>
    compareText(left.deltaId, right.deltaId) || compareText(left.factKey, right.factKey));
}

function resolveOperationRefs(
  branch: CanonBranch | undefined,
  view: CanonResolvedView | ArtifactCanonBoundView,
  factIds: string[],
  frozenAppliedDeltaIds: string[] | undefined,
): ArtifactCanonBinding['operationRefs'] {
  if (!branch || factIds.length === 0) return [];
  const allowedDeltaIds = new Set([
    ...(isCanonResolvedView(view) ? view.resolutionReceipt.appliedDeltaIds : []),
    ...(frozenAppliedDeltaIds ?? []),
  ]);
  const factIdSet = new Set(factIds);
  return branch.deltas
    .filter(delta => allowedDeltaIds.has(delta.deltaId))
    .flatMap(delta => delta.operations
      .filter(operation => factIdSet.has(operation.current.factId))
      .map(operation => ({ deltaId: delta.deltaId, factKey: operation.factKey })))
    .sort((left, right) =>
      compareText(left.deltaId, right.deltaId) || compareText(left.factKey, right.factKey));
}

function isCanonResolvedView(
  view: CanonResolvedView | ArtifactCanonBoundView,
): view is CanonResolvedView {
  return 'activeFacts' in view;
}

function compareBindings(left: ArtifactCanonBinding, right: ArtifactCanonBinding): number {
  return compareText(left.unitType, right.unitType)
    || compareText(left.unitId, right.unitId)
    || compareText(left.bindingId, right.bindingId);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort(compareText);
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
