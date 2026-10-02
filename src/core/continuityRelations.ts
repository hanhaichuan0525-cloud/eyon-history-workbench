import type { ContinuityView, GeneratedContinuityAnchor } from './continuityAnchors.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import { namespaceKey } from './namespace.ts';
import { fingerprintText } from '../runtime/transactionIdentity.ts';

export const CONTINUITY_RELATION_SCHEMA = 'eyon.continuity.relation.v1' as const;

export type ContinuityRelationKind = 'parallelView' | 'sourceConflict';
export type ContinuityRelationDimension =
  | 'time'
  | 'location'
  | 'participant'
  | 'relationship'
  | 'ownership'
  | 'objectState'
  | 'outcome';

export interface ContinuityRelationProposalCandidate {
  kind: ContinuityRelationKind;
  currentEventRef: string;
  otherHandle: string;
  dimension: ContinuityRelationDimension;
  note?: string;
}

/** 句柄在模型可见视图消失前立即冻结成 anchorId；模型从不填写内部 id。 */
export interface ResolvedContinuityRelationProposal {
  /** auto 表示模型只裁决“同一事件”，关系种类由双边来源确定。 */
  kind: ContinuityRelationKind | 'auto';
  currentEventRef: string;
  otherHandle: string;
  dimension: ContinuityRelationDimension;
  note?: string;
  producerUnitRef: string;
  otherAnchorId: string;
}

export interface ContinuityEventPairCurrent {
  producerUnitRef: string;
  currentEventRef: string;
  participants: string[];
  locations: string[];
  objects: string[];
}

/** 宽松召回只决定“哪些事件值得让现有全文复核比较”，绝不直接建立关系。 */
export interface ContinuityEventPairCandidate {
  pairId: string;
  producerUnitRef: string;
  currentEventRef: string;
  otherHandle: string;
  otherAnchorId: string;
}

export interface ContinuityEventJudgeVerdict {
  pairId: string;
  verdict: 'sameEvent' | 'differentEvent' | 'uncertain';
  dimension?: ContinuityRelationDimension;
  note?: string;
}

/**
 * 解析独立裁判的简短中文行。它不是通用自然语言抽取器：只接受已投递的 P 编号、
 * 三种明确结论，以及“主要差异”后的一个受限维度。无法识别的行逐条 fail-open。
 */
export function parseContinuityEventJudgeText(
  raw: string,
  eventPairs: readonly ContinuityEventPairCandidate[],
): ContinuityEventJudgeVerdict[] {
  const known = new Set(eventPairs.map(pair => pair.pairId.toUpperCase()));
  const verdicts = new Map<string, ContinuityEventJudgeVerdict>();
  const normalized = raw.normalize('NFKC').replace(/\r\n?/gu, '\n');
  const rows = normalized.matchAll(
    /(?:^|\n)\s*(?:[-*•]\s*)?(P\d+)\s*[：:]\s*([\s\S]*?)(?=(?:\n\s*(?:[-*•]\s*)?P\d+\s*[：:])|$)/giu,
  );
  for (const match of rows) {
    const pairId = (match[1] ?? '').toUpperCase();
    if (!known.has(pairId) || verdicts.has(pairId)) continue;
    const body = (match[2] ?? '').replace(/\s+/gu, ' ').trim();
    if (!body) continue;
    let verdict: ContinuityEventJudgeVerdict['verdict'] | null = null;
    if (/(?:不同事件|并非同一事件|不是同一事件|两次不同(?:的)?(?:发生|事件)|different\s*event)/iu.test(body)) {
      verdict = 'differentEvent';
    } else if (/(?:无法确认|不能确认|不足以确认|信息不足|uncertain|cannot\s*determine)/iu.test(body)) {
      verdict = 'uncertain';
    } else if (/(?:同一事件|同一次(?:历史)?发生|same\s*event)/iu.test(body)) {
      verdict = 'sameEvent';
    }
    if (!verdict) continue;
    const dimensionText = body.match(
      /(?:主要)?差异(?:维度)?\s*[：:]?\s*(?:为|在)?\s*([^；;。\n]+)/iu,
    )?.[1]?.trim();
    const dimension = verdict === 'sameEvent'
      ? continuityDimensionFromNaturalText(dimensionText ?? '')
      : undefined;
    verdicts.set(pairId, {
      pairId,
      verdict,
      ...(dimension ? { dimension } : {}),
      note: body,
    });
  }
  return eventPairs.flatMap(pair => {
    const verdict = verdicts.get(pair.pairId.toUpperCase());
    return verdict ? [verdict] : [];
  });
}

function continuityDimensionFromNaturalText(value: string): ContinuityRelationDimension | undefined {
  if (!value || /^(?:无|没有|一致|none)$/iu.test(value)) return undefined;
  if (/(?:时间|年份|日期|时点|年代|time)/iu.test(value)) return 'time';
  if (/(?:地点|位置|场所|location)/iu.test(value)) return 'location';
  if (/(?:参与者|人物|当事人|participant)/iu.test(value)) return 'participant';
  if (/(?:关系|relationship)/iu.test(value)) return 'relationship';
  if (/(?:归属|所有权|持有者|ownership)/iu.test(value)) return 'ownership';
  if (/(?:物品状态|原件状态|损坏状态|存续状态|object\s*state)/iu.test(value)) return 'objectState';
  if (/(?:结果|后果|结局|outcome)/iu.test(value)) return 'outcome';
  return undefined;
}

export interface ContinuityViewRelation {
  schema: typeof CONTINUITY_RELATION_SCHEMA;
  relationId: string;
  namespace: string;
  branchId: string;
  canonRevision: number;
  kind: ContinuityRelationKind;
  dimension: ContinuityRelationDimension;
  memberAnchorIds: [string, string];
  sourceRefs: string[];
  producerArtifactId: string;
  producerUnitRef: string;
  createdAt: number;
}

export type ContinuityRelationDiagnosticCode =
  | 'relation-created'
  | 'event-pair-review-accepted'
  | 'event-pair-review-rejected'
  | 'event-pair-review-missing'
  | 'unknown-handle'
  | 'current-anchor-missing'
  | 'scope-mismatch'
  | 'shared-ground-missing'
  | 'identical-claim'
  | 'source-conflict-source-insufficient'
  | 'corrupt-record'
  | 'cluster-omitted'
  | 'relation-view-failed';

export interface ContinuityRelationDiagnostic {
  code: ContinuityRelationDiagnosticCode;
  artifactId?: string;
  unitId?: string;
  relationId?: string;
  message: string;
  createdAt: number;
}

const DIAGNOSTIC_LIMIT = 96;
const diagnostics: ContinuityRelationDiagnostic[] = [];

export function recallContinuityEventPairCandidates(input: {
  currentEvents: readonly ContinuityEventPairCurrent[];
  continuityView: ContinuityView | undefined;
  maxPairs?: number;
  maxPairsPerEvent?: number;
}): ContinuityEventPairCandidate[] {
  const view = input.continuityView;
  if (!view?.anchors.length || !input.currentEvents.length) return [];
  const ranked = input.currentEvents.flatMap((current, currentIndex) =>
    view.anchors.flatMap((other, otherIndex) => {
      const participantOverlap = exactNameOverlap(current.participants, other.participants);
      const locationOverlap = exactNameOverlap(current.locations, other.locations);
      const objectOverlap = exactNameOverlap(current.objects, other.objects ?? []);
      const sharedSignals = participantOverlap + locationOverlap + objectOverlap;
      if (sharedSignals < 2 || participantOverlap + objectOverlap < 1) return [];
      return [{
        current, other, currentIndex, otherIndex,
        score: participantOverlap * 5 + locationOverlap * 4 + objectOverlap * 4,
      }];
    }));
  ranked.sort((left, right) => right.score - left.score
    || left.currentIndex - right.currentIndex
    || left.otherIndex - right.otherIndex
    || left.current.currentEventRef.localeCompare(right.current.currentEventRef));
  const selected: typeof ranked = [];
  const perEvent = new Map<string, number>();
  const maxPairs = Math.max(1, input.maxPairs ?? 6);
  const maxPairsPerEvent = Math.max(1, input.maxPairsPerEvent ?? 2);
  for (const candidate of ranked) {
    const used = perEvent.get(candidate.current.producerUnitRef) ?? 0;
    if (used >= maxPairsPerEvent) continue;
    selected.push(candidate);
    perEvent.set(candidate.current.producerUnitRef, used + 1);
    if (selected.length >= maxPairs) break;
  }
  return selected.map((candidate, index) => ({
    pairId: `P${index + 1}`,
    producerUnitRef: candidate.current.producerUnitRef,
    currentEventRef: candidate.current.currentEventRef,
    otherHandle: candidate.other.handle,
    otherAnchorId: candidate.other.anchorId,
  }));
}

export function buildContinuityViewRelationsSafely(input: {
  namespace: string;
  artifactId: string;
  newAnchors: readonly GeneratedContinuityAnchor[];
  existingAnchors: readonly GeneratedContinuityAnchor[];
  proposals: readonly ResolvedContinuityRelationProposal[];
  createdAt: number;
}): ContinuityViewRelation[] {
  const byExistingId = new Map(input.existingAnchors.map(anchor => [anchor.anchorId, anchor]));
  const byRelationId = new Map<string, ContinuityViewRelation>();
  for (const proposal of input.proposals) {
    try {
      const current = input.newAnchors.find(anchor =>
        anchor.claimSource === 'final-prose'
        && anchor.producer.artifactId === input.artifactId
        && anchor.producer.unitId === proposal.producerUnitRef
        && anchor.eventId === proposal.currentEventRef);
      if (!current) {
        recordRelationDiagnostic({
          code: 'current-anchor-missing', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'The current passage did not publish a matching final-prose anchor',
          createdAt: input.createdAt,
        });
        continue;
      }
      const other = byExistingId.get(proposal.otherAnchorId);
      if (!other) {
        recordRelationDiagnostic({
          code: 'unknown-handle', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'The frozen continuity handle no longer resolves to an existing anchor',
          createdAt: input.createdAt,
        });
        continue;
      }
      if (current.anchorId === other.anchorId
        || current.branchId !== other.branchId
        || current.canonRevision !== other.canonRevision) {
        recordRelationDiagnostic({
          code: 'scope-mismatch', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'Both relation members must be distinct and share branch/revision',
          createdAt: input.createdAt,
        });
        continue;
      }
      if (!anchorsShareExactGround(current, other)) {
        recordRelationDiagnostic({
          code: 'shared-ground-missing', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'No exact event or entity ground links the proposed views',
          createdAt: input.createdAt,
        });
        continue;
      }
      if (normalizeClaim(current.claim) === normalizeClaim(other.claim)) {
        recordRelationDiagnostic({
          code: 'identical-claim', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'Identical claims do not form a view relation',
          createdAt: input.createdAt,
        });
        continue;
      }
      const currentSources = uniqueText(current.sourceRefs);
      const otherSources = uniqueText(other.sourceRefs);
      const sourceRefs = uniqueText([...currentSources, ...otherSources]);
      const kind: ContinuityRelationKind = proposal.kind === 'auto'
        ? currentSources.length > 0 && otherSources.length > 0 && sourceRefs.length >= 2
          ? 'sourceConflict'
          : 'parallelView'
        : proposal.kind;
      if (kind === 'sourceConflict'
        && (currentSources.length === 0 || otherSources.length === 0 || sourceRefs.length < 2)) {
        recordRelationDiagnostic({
          code: 'source-conflict-source-insufficient', artifactId: input.artifactId,
          unitId: proposal.producerUnitRef,
          message: 'sourceConflict requires valid evidence on both sides and distinct source identities',
          createdAt: input.createdAt,
        });
        continue;
      }
      const memberAnchorIds = [current.anchorId, other.anchorId]
        .sort((left, right) => left.localeCompare(right)) as [string, string];
      const identity = {
        namespace: input.namespace,
        branchId: current.branchId,
        canonRevision: current.canonRevision,
        kind,
        dimension: proposal.dimension,
        memberAnchorIds,
      };
      const relation: ContinuityViewRelation = {
        schema: CONTINUITY_RELATION_SCHEMA,
        relationId: `continuity-relation:${fingerprintText(JSON.stringify(identity))}`,
        ...identity,
        sourceRefs,
        producerArtifactId: input.artifactId,
        producerUnitRef: proposal.producerUnitRef,
        createdAt: input.createdAt,
      };
      byRelationId.set(relation.relationId, relation);
      recordRelationDiagnostic({
        code: 'relation-created', artifactId: input.artifactId,
        unitId: proposal.producerUnitRef, relationId: relation.relationId,
        message: 'Low-authority continuity view relation created',
        createdAt: input.createdAt,
      });
    } catch (error) {
      recordRelationDiagnostic({
        code: 'relation-view-failed', artifactId: input.artifactId,
        unitId: proposal.producerUnitRef,
        message: error instanceof Error ? error.message : String(error),
        createdAt: input.createdAt,
      });
    }
  }
  return [...byRelationId.values()].sort(compareRelations);
}

export function continuityRelationsFromCommittedRecords(input: {
  records: readonly BiographyRecord[];
  anchors: readonly GeneratedContinuityAnchor[];
  namespace: string;
  branchId: string;
  canonRevision: number;
}): ContinuityViewRelation[] {
  const anchorIds = new Set(input.anchors.map(anchor => anchor.anchorId));
  const byId = new Map<string, ContinuityViewRelation>();
  for (const record of input.records) {
    if (record.status !== 'committed' || !record.continuityRelations) continue;
    for (const raw of record.continuityRelations as unknown[]) {
      if (!isContinuityRelation(raw)) {
        recordRelationDiagnostic({
          code: 'corrupt-record', artifactId: record.biographyId,
          message: 'Malformed stored continuity relation was ignored', createdAt: Date.now(),
        });
        continue;
      }
      if (raw.producerArtifactId !== record.biographyId
        || raw.namespace !== input.namespace
        || raw.branchId !== input.branchId
        || raw.canonRevision !== input.canonRevision
        || raw.memberAnchorIds.some(anchorId => !anchorIds.has(anchorId))) {
        continue;
      }
      byId.set(raw.relationId, structuredClone(raw));
    }
  }
  return [...byId.values()].sort(compareRelations);
}

export function listContinuityRelationDiagnostics(): ContinuityRelationDiagnostic[] {
  return structuredClone(diagnostics);
}

export function clearContinuityRelationDiagnosticsForTest(): void {
  diagnostics.length = 0;
}

export function recordContinuityRelationDiagnostic(
  diagnostic: ContinuityRelationDiagnostic,
): void {
  recordRelationDiagnostic(diagnostic);
}

export function continuityNamespaceKey(value: BiographyRecord['namespace']): string {
  return namespaceKey(value);
}

function anchorsShareExactGround(
  left: GeneratedContinuityAnchor,
  right: GeneratedContinuityAnchor,
): boolean {
  if (left.eventId === right.eventId) return true;
  const leftIds = new Set([
    ...left.participants.map(item => item.entityId),
    ...left.locations.map(item => item.entityId),
    ...(left.objects ?? []).map(item => item.entityId),
  ].filter((value): value is string => Boolean(value)));
  const rightIds = [
    ...right.participants.map(item => item.entityId),
    ...right.locations.map(item => item.entityId),
    ...(right.objects ?? []).map(item => item.entityId),
  ].filter((value): value is string => Boolean(value));
  if (rightIds.some(id => leftIds.has(id))) return true;
  const leftNames = new Set([
    ...left.participants.map(item => item.name),
    ...left.locations.map(item => item.name),
    ...(left.objects ?? []).map(item => item.name),
  ].map(normalizeName).filter(Boolean));
  return [
    ...right.participants.map(item => item.name),
    ...right.locations.map(item => item.name),
    ...(right.objects ?? []).map(item => item.name),
  ].map(normalizeName).some(name => name && leftNames.has(name));
}

function exactNameOverlap(left: readonly string[], right: readonly string[]): number {
  const names = new Set(left.map(normalizeName).filter(Boolean));
  return new Set(right.map(normalizeName).filter(name => name && names.has(name))).size;
}

function isContinuityRelation(value: unknown): value is ContinuityViewRelation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.schema === CONTINUITY_RELATION_SCHEMA
    && typeof row.relationId === 'string'
    && typeof row.namespace === 'string'
    && typeof row.branchId === 'string'
    && Number.isInteger(row.canonRevision)
    && (row.kind === 'parallelView' || row.kind === 'sourceConflict')
    && ['time', 'location', 'participant', 'relationship', 'ownership', 'objectState', 'outcome']
      .includes(String(row.dimension))
    && Array.isArray(row.memberAnchorIds)
    && row.memberAnchorIds.length === 2
    && row.memberAnchorIds.every(item => typeof item === 'string' && item.length > 0)
    && Array.isArray(row.sourceRefs)
    && row.sourceRefs.every(item => typeof item === 'string')
    && typeof row.producerArtifactId === 'string'
    && typeof row.producerUnitRef === 'string'
    && typeof row.createdAt === 'number';
}

function normalizeClaim(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\s，。；、：:！？!?“”‘’'"《》【】（）()]/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
    .replace(/[\s·•・._—–\-《》【】（）()“”‘’'"，。；、：:！？!?]/gu, '');
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function compareRelations(left: ContinuityViewRelation, right: ContinuityViewRelation): number {
  return left.createdAt - right.createdAt || left.relationId.localeCompare(right.relationId);
}

function recordRelationDiagnostic(diagnostic: ContinuityRelationDiagnostic): void {
  diagnostics.push(diagnostic);
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
}
