import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { GenealogyNode, GenealogyResult } from '../schemas/genealogy.ts';
import type { ArtifactCanonAssessment, CanonBranch, CanonFact } from '../retrieval/contracts.ts';
import { assessArtifactCanonBinding, createIneligibleArtifactCanonAssessment } from './artifactCanonAssessment.ts';
import { currentArtifactCanonAssessmentTarget, decideArtifactCanonConsumption } from './artifactCanonConsumption.ts';
import { parseWorldTime } from '../retrieval/temporal.ts';
import { biologicalEdge } from './genealogyIdentity.ts';
import { namespaceKey } from './namespace.ts';
import { fingerprintText } from '../runtime/transactionIdentity.ts';
import {
  readP4DerivedCache,
  writeP4DerivedCache,
  type P4DerivedCacheScope,
} from './p4DerivedCache.ts';

/** Script-owned receipt. No model IDs, prose extraction or second Canon store. */
export interface GenealogyLocalEvidence {
  nodes: Array<{ nodeId: string; entityId: string }>;
  facts: Array<Pick<CanonFact, 'factId' | 'subjectEntityId' | 'predicate' | 'object' | 'temporalScope' | 'epistemicStatus'>>;
}

export interface GenealogyUnitState {
  unitId: string;
  unitType: 'node' | 'edge';
  status: ArtifactCanonAssessment['status'] | 'unbound';
  disposition: 'available' | 'available-with-warning' | 'excluded' | 'manual-review';
  reasonCodes: string[];
  /** Only positively current edges may become relationship evidence. */
  reusable: boolean;
}

export interface GenealogyLocalView {
  schema: 'eyon.genealogy.local-view.v1';
  artifactId: string;
  branchId: string;
  canonRevision: number;
  units: GenealogyUnitState[];
  nodes: GenealogyNode[];
  edges: GenealogyResult['edges'];
}

type Fact = GenealogyLocalEvidence['facts'][number];
type Point = { era: string; year: number };

export function buildGenealogyLocalView(record: GenealogyRecord, branch?: CanonBranch): GenealogyLocalView {
  const cacheScope = genealogyCacheScope(record, branch);
  const cached = readP4DerivedCache(cacheScope, isGenealogyLocalView);
  if (cached) return cached;
  const view = computeGenealogyLocalView(record, branch);
  writeP4DerivedCache(cacheScope, view);
  return view;
}

function computeGenealogyLocalView(record: GenealogyRecord, branch?: CanonBranch): GenealogyLocalView {
  const bindings = record.canonBindings ?? [];
  const foreignNamespace = !!branch && (record.namespace.characterKey !== branch.characterKey || record.namespace.chatId !== branch.chatId);
  const target = branch ? currentArtifactCanonAssessmentTarget({ bindings, branch }) : undefined;
  const facts = new Map((record.localEvidence?.facts ?? []).map(fact => [fact.factId, fact]));
  if (target) {
    for (const id of target.inactiveFactIds) facts.delete(id);
    for (const delta of branch!.deltas) {
      for (const operation of delta.operations) {
        if (target.activeFactIds.includes(operation.current.factId)) facts.set(operation.current.factId, operation.current);
        else facts.delete(operation.current.factId);
      }
    }
  }
  const units: GenealogyUnitState[] = [];
  function state(unitType: 'node' | 'edge', unitId: string): GenealogyUnitState {
    const binding = bindings.find(item => item.unitType === unitType && item.unitId === unitId);
    let result: GenealogyUnitState = { unitType, unitId, status: 'unbound', disposition: 'manual-review', reusable: false, reasonCodes: ['unbound'] };
    if (target) {
      try {
        const assessment = binding ? assessArtifactCanonBinding({ binding, view: target, branch })
          : createIneligibleArtifactCanonAssessment({ artifactType: 'genealogy', artifactId: record.requestId, unitType, unitId, eligibility: bindings.length ? 'binding-missing' : 'unbound', view: target });
        const decision = decideArtifactCanonConsumption(assessment);
        result = { unitType, unitId, status: assessment.status ?? 'unbound', disposition: decision.disposition, reasonCodes: decision.reasonCodes, reusable: assessment.status === 'current' };
        if (binding && (binding.branchId !== branch!.branchId || binding.boundView.resolvedRevision > branch!.headRevision)) {
          result = { ...result, status: 'uncertain', disposition: 'manual-review', reusable: false, reasonCodes: [...result.reasonCodes, 'outside-current-branch-history'] };
        }
      } catch {
        result.reasonCodes = ['assessment-failed'];
      }
    }
    if (foreignNamespace) result = { ...result, status: 'uncertain', disposition: 'manual-review', reusable: false, reasonCodes: ['outside-current-branch-history'] };
    units.push(result);
    return result;
  }
  const states = new Map(record.result.nodes.map(node => [node.id, state('node', node.id)]));
  const identities = new Map(record.localEvidence?.nodes.map(item => [item.nodeId, item.entityId]) ?? []);
  // Older bindings may contain multiple related entities; never guess which is the node.
  for (const node of record.result.nodes) {
    const binding = bindings.find(item => item.unitType === 'node' && item.unitId === node.id);
    if (!identities.has(node.id) && binding?.entityIds.length === 1) identities.set(node.id, binding.entityIds[0]);
  }
  function pointFor(nodeId: string, predicate: 'birth_time' | 'death_time'): Point | undefined {
    if (!target) return undefined;
    const entityId = identities.get(nodeId);
    if (!entityId) return undefined;
    const points = [...facts.values()].filter(fact => fact.subjectEntityId === entityId && fact.predicate === predicate && strong(fact))
      .map(fact => point(fact.object)).filter((value): value is Point => !!value);
    const unique = new Map(points.map(value => [`${value.era}:${value.year}`, value]));
    return unique.size === 1 ? [...unique.values()][0] : undefined;
  }
  function changedLifeSince(nodeIds: string[], revision: number): boolean {
    return !!branch?.deltas.some(delta => delta.revision > revision
      && delta.operations.some(operation => target?.activeFactIds.includes(operation.current.factId)
        && ['birth_time', 'death_time'].includes(operation.current.predicate)
        && nodeIds.map(id => identities.get(id)).includes(operation.current.subjectEntityId)));
  }
  for (const node of record.result.nodes) {
    const binding = bindings.find(item => item.unitType === 'node' && item.unitId === node.id);
    const s = states.get(node.id)!;
    if (s.reusable && binding && changedLifeSince([node.id], binding.boundView.resolvedRevision)) {
      Object.assign(s, { status: 'partially-stale', disposition: 'available-with-warning', reusable: false });
      s.reasonCodes.push('life-fact-changed');
    }
  }
  const edges = record.result.edges.filter(edge => {
    const s = state('edge', edge.id);
    if (!states.has(edge.from) || !states.has(edge.to)) {
      Object.assign(s, { status: 'uncertain', disposition: 'manual-review', reusable: false });
      s.reasonCodes.push('endpoint-missing');
      return false;
    }
    if ([edge.from, edge.to].some(id => states.get(id)!.reasonCodes.includes('outside-current-branch-history'))) {
      Object.assign(s, { status: 'uncertain', disposition: 'manual-review', reusable: false });
      s.reasonCodes.push('endpoint-unavailable');
      return false;
    }
    const binding = bindings.find(item => item.unitType === 'edge' && item.unitId === edge.id);
    // Baseline deaths must not retroactively disqualify an ordinary old marriage.
    // Only a life-date change after this edge's evidence snapshot triggers temporal review.
    const changedLife = changedLifeSince([edge.from, edge.to], binding?.boundView.resolvedRevision ?? Infinity);
    const relationDates = (binding?.factIds ?? []).flatMap(id => {
      const fact = facts.get(id);
      const value = fact && strong(fact) ? point(fact.temporalScope) : undefined;
      return value ? [value] : [];
    });
    const parent = edge.relationType === 'parent' ? edge.from : edge.relationType === 'child' ? edge.to : undefined;
    const child = parent === edge.from ? edge.to : edge.from;
    // Birth after death is not proof of conception after death (posthumous or non-human births).
    // Keep the person, suspend only the unsupported relation; never invent another parent.
    if (changedLife && parent && biologicalEdge(edge)) {
      const death = pointFor(parent, 'death_time');
      const birth = pointFor(child, 'birth_time');
      const parentBirth = pointFor(parent, 'birth_time');
      if (parentBirth && birth && parentBirth.era === birth.era && parentBirth.year > birth.year) {
        invalidate(s, 'parent-born-after-child');
      }
      if (death) {
        if (!birth || birth.era !== death.era || birth.year > death.year) uncertain(s, 'conception-time-unresolved');
      } else if (!birth || !parentBirth || birth.era !== parentBirth.era) {
        uncertain(s, 'relationship-time-unresolved');
      }
    } else if (changedLife && edge.track !== 'soul' && ['spouse', 'adoptiveParent', 'adoptiveChild', 'guardian', 'ward'].includes(edge.relationType)) {
      for (const id of [edge.from, edge.to]) {
        const death = pointFor(id, 'death_time');
        if (!death) continue;
        if (relationDates.length && relationDates.every(time => time.era === death.era && time.year > death.year)) invalidate(s, 'relationship-after-death');
        else if (!relationDates.length) uncertain(s, 'relationship-time-unresolved');
      }
    }
    return s.reusable;
  });
  // Keep original tree for display. Only this derived, deliberately compact projection leaves the module.
  const affected = new Set(units.filter(unit => unit.unitType === 'node' && !unit.reusable).map(unit => unit.unitId));
  for (const edge of record.result.edges) {
    if (units.some(unit => unit.unitType === 'edge' && unit.unitId === edge.id && !unit.reusable)) {
      affected.add(edge.from); affected.add(edge.to);
    }
  }
  const connected = new Set(record.result.nodes.filter(node => node.isFocus).map(node => node.id));
  for (let size = -1; size !== connected.size;) {
    size = connected.size;
    for (const edge of edges) if (connected.has(edge.from) || connected.has(edge.to)) { connected.add(edge.from); connected.add(edge.to); }
  }
  const nodes = record.result.nodes.filter(node => {
    const s = states.get(node.id)!;
    return !s.reasonCodes.includes('outside-current-branch-history');
  }).map(node => {
    const s = states.get(node.id)!;
    const copy = structuredClone(node);
    copy.canInjectToRuin = true;
    copy.historyRefs = []; // revalidated by the runtime against current committed producers
    // Linked prose is not a second store of continuity claims. Deleting its producer
    // must not leave a copied claim alive in an otherwise-current node's old profile.
    if (node.historyRefs?.length) {
      copy.summary = '关联经历以当前有效的同版传记附注为准。';
      copy.profile.lifeExperience = '传记经历通过当前附注提供，旧短传不重复作为事实来源。';
    }
    // Relation summaries and profiles can repeat an invalid edge even when the edge is removed.
    if (affected.has(node.id) || !connected.has(node.id)) {
      copy.relationToFocus = node.isFocus ? '本人' : '旧谱系人物；关系以当前有效关系为准';
      copy.summary = '人物来自已保存谱系；只引用当前有效关系。';
      copy.profile = { personality: '资料未复核', lifeExperience: '旧短传未自动复用' };
    }
    if (!s.reusable) {
      copy.birth = unknownDate(); copy.death = unknownDate();
      if (copy.identity) copy.identity = { lineageKind: copy.identity.lineageKind, note: '时间轨待复核；不沿用旧版本原点。' };
      copy.identities = []; copy.professions = ['职业不详']; copy.race = '不详'; copy.lifeLevel = '';
      copy.provenance = 'inferred';
    }
    for (const kind of ['birth', 'death'] as const) {
      const value = pointFor(node.id, kind === 'birth' ? 'birth_time' : 'death_time');
      if (value) {
        setLifeDate(copy, kind, value);
        if (copy.identity && copy.identity.lineageKind !== 'creation') {
          copy.identity.body = { ...copy.identity.body, [kind]: structuredClone(copy[kind]) };
        }
      }
    }
    return copy;
  });
  const nodeIds = new Set(nodes.map(node => node.id));
  return { schema: 'eyon.genealogy.local-view.v1', artifactId: record.requestId, branchId: branch?.branchId ?? '', canonRevision: branch?.headRevision ?? 0, units, nodes, edges: structuredClone(edges.filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))) };
}

function genealogyCacheScope(record: GenealogyRecord, branch?: CanonBranch): P4DerivedCacheScope {
  const entityIds = new Set(record.localEvidence?.nodes.map(item => item.entityId) ?? []);
  const factIds = new Set(record.localEvidence?.facts.map(item => item.factId) ?? []);
  const bindingDeltaIds = new Set((record.canonBindings ?? []).flatMap(binding =>
    binding.operationRefs.map(ref => ref.deltaId)));
  const relevantDeltas = branch?.deltas.flatMap(delta => {
    const operations = delta.operations.filter(operation =>
      entityIds.has(operation.current.subjectEntityId)
      || factIds.has(operation.current.factId)
      || bindingDeltaIds.has(delta.deltaId));
    return operations.length ? [{
      deltaId: delta.deltaId,
      revision: delta.revision,
      status: delta.status,
      operations,
    }] : [];
  }) ?? [];
  const branchId = branch?.branchId
    ?? record.canonBindings?.[0]?.branchId
    ?? 'unbound';
  const canonRevision = branch?.headRevision
    ?? Math.max(0, ...(record.canonBindings ?? []).map(binding => binding.boundView.resolvedRevision));
  return {
    namespace: branch ? namespaceKey(branch) : namespaceKey(record.namespace),
    branchId,
    canonRevision,
    queryScopeHash: fingerprintText([record.requestId, record.result.focusCharacterId].join('\n')),
    module: 'genealogy-local',
    subjectScope: [
      record.result.focusCharacterId,
      ...record.result.nodes.flatMap(node => [node.id, node.name]),
      ...entityIds,
    ],
    timeScope: record.result.nodes.flatMap(node => [node.birth.label, node.death.label]),
    locationScope: record.result.referenceSummary.knownResidences,
    anchorSetHash: fingerprintText(JSON.stringify({
      requestId: record.requestId,
      result: record.result,
      canonBindings: record.canonBindings ?? [],
      localEvidence: record.localEvidence ?? null,
      relevantDeltas,
    })),
  };
}

function isGenealogyLocalView(value: unknown): value is GenealogyLocalView {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GenealogyLocalView>;
  return candidate.schema === 'eyon.genealogy.local-view.v1'
    && typeof candidate.artifactId === 'string'
    && typeof candidate.branchId === 'string'
    && typeof candidate.canonRevision === 'number'
    && Array.isArray(candidate.units)
    && Array.isArray(candidate.nodes)
    && Array.isArray(candidate.edges);
}

function invalidate(state: GenealogyUnitState, reason: string): void {
  state.status = 'stale'; state.disposition = 'excluded'; state.reusable = false; state.reasonCodes.push(reason);
}
function uncertain(state: GenealogyUnitState, reason: string): void {
  if (state.disposition === 'excluded') return;
  state.status = 'uncertain'; state.disposition = 'manual-review'; state.reusable = false; state.reasonCodes.push(reason);
}
function strong(fact: Fact): boolean { return ['explicit', 'structural', 'user-asserted'].includes(fact.epistemicStatus); }
function point(text: string | null): Point | undefined {
  if (!text) return undefined;
  const parsed = parseWorldTime(text);
  return parsed.era && parsed.year !== null ? { era: parsed.era, year: parsed.year } : undefined;
}
export function unknownDate(): GenealogyNode['birth'] {
  return { status: 'unknown', era: '', year: null, month: null, day: null, precision: 'unknown', label: '不详' };
}
export function setLifeDate(node: GenealogyNode, kind: 'birth' | 'death', value: Point): void {
  const era = value.era.trim().slice(0, 80);
  if (!era || !Number.isInteger(value.year)) return;
  node[kind] = { status: kind === 'birth' ? 'known' : 'deceased', era, year: value.year, month: null, day: null, precision: 'exact', label: `${era}${value.year}年` };
}

export function genealogyUnitLabel(state: GenealogyUnitState | undefined): string {
  return !state ? '未评估' : state.disposition === 'excluded' ? '已失效' : state.disposition === 'manual-review' ? '待核实' : state.disposition === 'available-with-warning' ? '部分受影响' : '当前有效';
}
