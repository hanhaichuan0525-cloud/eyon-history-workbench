import type { BiographyRecord } from '../storage/biographies.ts';
import type { ArtifactCanonBinding, PersonCanonView } from '../retrieval/contracts.ts';
import { fingerprintText } from '../runtime/transactionIdentity.ts';

export const CONTINUITY_ANCHOR_SCHEMA = 'eyon.continuity.anchor.v1' as const;
export const CONTINUITY_VIEW_SCHEMA = 'eyon.continuity.view.v1' as const;

/** P4-A 的唯一投递预算。后续调参只改这里，不把限制散落到提示词。 */
export const CONTINUITY_VIEW_BUDGET = Object.freeze({
  maxAnchors: 6,
  maxTotalCharacters: 1_600,
  maxClaimCharacters: 240,
  // 高于 sourceSelection 的人物形态保底分，确保无词面/实体命中的锚不会跨题注入。
  minimumSelectionScore: 25,
});

export interface GeneratedContinuityAnchor {
  schema: typeof CONTINUITY_ANCHOR_SCHEMA;
  anchorId: string;
  branchId: string;
  canonRevision: number;
  producer: {
    artifactType: 'biography';
    artifactId: string;
    unitId: string;
    bindingId?: string;
  };
  eventId: string;
  /** 缺省为原 P4-A 的冻结事件槽；final-prose 是 P4-A2 的最终正文低权补充。 */
  claimSource?: 'final-prose';
  claim: string;
  temporalScope: {
    label: string;
    start?: string;
    end?: string;
  };
  participants: Array<{ entityId?: string; name: string }>;
  locations: Array<{ entityId?: string; name: string }>;
  /** 旧 P4-A 记录可缺省；P4-A2 用它让具名物件状态能按物件名被检索。 */
  objects?: Array<{ entityId?: string; name: string }>;
  sourceRefs: string[];
  stance: 'asserted' | 'hypothesis';
  createdAt: number;
}

export interface ContinuityView {
  schema: typeof CONTINUITY_VIEW_SCHEMA;
  branchId: string;
  canonRevision: number;
  queryScopeHash: string;
  anchors: Array<{
    /** 仅供脚本把本次可见句柄冻结回内部锚；不会由 renderer 暴露给模型。 */
    anchorId: string;
    handle: string;
    claim: string;
    time: string;
    participants: string[];
    locations: string[];
    /** 仅供同事件候选召回；模型仍以完整正文和锚主张作语义裁决。 */
    objects?: string[];
    stance: 'asserted' | 'hypothesis';
    origin: string;
    /** 仅在传记全文复核时投递；来自所选锚对应的已提交正文，不是新正史。 */
    finalProseExcerpt?: string;
    /** 同一旧传记的现状摘录，帮助区分一次事件与延续至今的状态。 */
    statusExcerpt?: string;
  }>;
  relationGroups: Array<{
    kind: 'parallelView' | 'sourceConflict';
    dimension: 'time' | 'location' | 'participant' | 'relationship' | 'ownership' | 'objectState' | 'outcome';
    handles: [string, string];
    omittedMemberCount: number;
  }>;
  omittedCount: number;
  warnings: string[];
}

export interface BiographyContinuityAnchorUnit {
  unitId: string;
  eventId: string;
  claimSource?: 'final-prose';
  eventUsage: 'occurs' | 'aftermath' | 'recollection' | 'evidence' | 'background';
  claim: string;
  temporalScope: {
    label: string;
    start?: string;
    end?: string;
  };
  people: string[];
  factions: string[];
  objects: string[];
  locations: string[];
  sourceRefs: string[];
  inference: boolean;
}

export type ContinuityAnchorDiagnosticCode =
  | 'anchor-created'
  | 'not-occurs'
  | 'binding-missing'
  | 'event-mismatch'
  | 'claim-not-independent'
  | 'cross-artifact-value-insufficient'
  | 'legacy-record'
  | 'scope-mismatch'
  | 'view-failed';

export interface ContinuityAnchorDiagnostic {
  code: ContinuityAnchorDiagnosticCode;
  artifactId?: string;
  unitId?: string;
  anchorId?: string;
  message: string;
  createdAt: number;
}

const DIAGNOSTIC_LIMIT = 96;
const diagnostics: ContinuityAnchorDiagnostic[] = [];

/**
 * 只消费已经通过传记 validator 的结构字段。失败时逐单元跳过，绝不抛出到传记提交链。
 */
export function buildBiographyContinuityAnchorsSafely(input: {
  artifactId: string;
  units: BiographyContinuityAnchorUnit[];
  canonBindings?: ArtifactCanonBinding[];
  personCanonViews?: PersonCanonView[];
  createdAt: number;
}): GeneratedContinuityAnchor[] {
  const anchors: GeneratedContinuityAnchor[] = [];
  for (const unit of input.units) {
    try {
      if (unit.eventUsage !== 'occurs') {
        recordDiagnostic('not-occurs', input, unit, 'Only an occurs event may publish an anchor');
        continue;
      }
      const binding = input.canonBindings?.find(item =>
        item.artifactType === 'biography'
        && item.artifactId === input.artifactId
        && item.unitId === unit.unitId);
      if (!binding) {
        recordDiagnostic('binding-missing', input, unit, 'The producing biography unit has no Canon binding');
        continue;
      }
      const eventId = unit.eventId.trim();
      if (!eventId) {
        recordDiagnostic('event-mismatch', input, unit, 'The producing biography unit has no event id');
        continue;
      }
      const claim = normalizeClaim(unit.claim);
      const names = uniqueText([...unit.people, ...unit.factions]);
      const locations = uniqueText(unit.locations);
      const objects = uniqueText(unit.objects);
      const namedSignals = [...names, ...locations, ...objects];
      if (!claim || !namedSignals.some(name => claimIncludesName(claim, name))) {
        recordDiagnostic(
          'claim-not-independent',
          input,
          unit,
          'The event claim cannot be understood without hidden context',
        );
        continue;
      }
      const dimensions = [
        Boolean(unit.temporalScope.label.trim()),
        names.length > 0,
        locations.length > 0,
        objects.length > 0,
      ].filter(Boolean).length;
      // 时间 + 人物虽已达到最小二维，但只有人物和氛围的段落不值得跨产物共享。
      // 还需一个地点、持续物件、来源或既有 Canon 事件信号；这是保守“不发布”，不是硬错误。
      const durableSignal = locations.length > 0
        || objects.length > 0
        || unit.sourceRefs.length > 0
        || !eventId.startsWith('invented:');
      if (dimensions < 2 || !durableSignal) {
        recordDiagnostic(
          'cross-artifact-value-insufficient',
          input,
          unit,
          'The event has no durable cross-artifact value beyond its local prose',
        );
        continue;
      }
      const participants = names.map(name => ({
        name,
        ...entityIdentity(name, input.personCanonViews ?? []),
      }));
      const locationRows = locations.map(name => ({ name }));
      const objectRows = objects.map(name => ({ name }));
      const canonical = {
        schema: CONTINUITY_ANCHOR_SCHEMA,
        branchId: binding.branchId,
        canonRevision: binding.boundView.resolvedRevision,
        producer: {
          artifactType: 'biography' as const,
          artifactId: input.artifactId,
          unitId: unit.unitId,
          bindingId: binding.bindingId,
        },
        eventId,
        ...(unit.claimSource ? { claimSource: unit.claimSource } : {}),
        claim,
        temporalScope: compactTemporalScope(unit.temporalScope),
        participants,
        locations: locationRows,
        ...(objectRows.length > 0 ? { objects: objectRows } : {}),
        sourceRefs: uniqueText([
          ...unit.sourceRefs,
          ...binding.sourceRefs,
        ]),
        stance: (unit.inference || eventId.startsWith('invented:'))
          ? 'hypothesis' as const
          : 'asserted' as const,
        createdAt: input.createdAt,
      };
      const anchor: GeneratedContinuityAnchor = {
        ...canonical,
        anchorId: `continuity-anchor:${fingerprintText(JSON.stringify(canonical))}`,
      };
      anchors.push(anchor);
      recordDiagnostic('anchor-created', input, unit, 'Continuity anchor created', anchor.anchorId);
    } catch (error) {
      recordDiagnostic(
        'view-failed',
        input,
        unit,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return anchors.sort(compareAnchors);
}

export function continuityAnchorsFromCommittedRecords(
  records: readonly BiographyRecord[],
  branchId: string,
  canonRevision: number,
): GeneratedContinuityAnchor[] {
  const byId = new Map<string, GeneratedContinuityAnchor>();
  for (const record of records) {
    if (record.status !== 'committed') continue;
    if (!record.continuityAnchors) {
      recordViewDiagnostic({
        code: 'legacy-record',
        artifactId: record.biographyId,
        message: 'Committed biography has no P4-A anchors; no backfill was attempted',
        createdAt: Date.now(),
      });
      continue;
    }
    for (const anchor of record.continuityAnchors) {
      if (
        anchor.schema !== CONTINUITY_ANCHOR_SCHEMA
        || anchor.producer.artifactId !== record.biographyId
        || anchor.branchId !== branchId
        || anchor.canonRevision !== canonRevision
      ) {
        continue;
      }
      const binding = record.canonBindings?.find(item =>
        item.bindingId === anchor.producer.bindingId
        && item.unitId === anchor.producer.unitId
        && item.branchId === branchId
        && item.boundView.resolvedRevision === canonRevision);
      if (!binding) continue;
      byId.set(anchor.anchorId, structuredClone(anchor));
    }
  }
  return [...byId.values()].sort(compareAnchors);
}

export function listContinuityAnchorDiagnostics(): ContinuityAnchorDiagnostic[] {
  return structuredClone(diagnostics);
}

export function clearContinuityAnchorDiagnosticsForTest(): void {
  diagnostics.length = 0;
}

export function recordContinuityViewFailure(message: string): void {
  recordViewDiagnostic({ code: 'view-failed', message, createdAt: Date.now() });
}

function normalizeClaim(value: string): string {
  const claim = value.replace(/\s+/gu, ' ').trim();
  if (claim.length <= CONTINUITY_VIEW_BUDGET.maxClaimCharacters) return claim;
  return `${claim.slice(0, CONTINUITY_VIEW_BUDGET.maxClaimCharacters - 1).trimEnd()}…`;
}

function compactTemporalScope(
  scope: BiographyContinuityAnchorUnit['temporalScope'],
): GeneratedContinuityAnchor['temporalScope'] {
  const label = scope.label.replace(/\s+/gu, ' ').trim();
  const start = scope.start?.replace(/\s+/gu, ' ').trim();
  const end = scope.end?.replace(/\s+/gu, ' ').trim();
  return {
    label,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

function entityIdentity(name: string, views: PersonCanonView[]): { entityId?: string } {
  const normalized = normalizeName(name);
  const matches = views.filter(view =>
    [view.canonicalName, ...view.aliases].some(candidate => normalizeName(candidate) === normalized));
  const ids = uniqueText(matches.map(view => view.entityId));
  return ids.length === 1 ? { entityId: ids[0] } : {};
}

function claimIncludesName(claim: string, name: string): boolean {
  const normalizedName = normalizeName(name);
  return normalizedName.length >= 2 && normalizeName(claim).includes(normalizedName);
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s·•・]/gu, '');
}

function uniqueText(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function compareAnchors(
  left: GeneratedContinuityAnchor,
  right: GeneratedContinuityAnchor,
): number {
  return left.createdAt - right.createdAt
    || left.producer.artifactId.localeCompare(right.producer.artifactId)
    || left.producer.unitId.localeCompare(right.producer.unitId)
    || left.anchorId.localeCompare(right.anchorId);
}

function recordDiagnostic(
  code: ContinuityAnchorDiagnosticCode,
  input: { artifactId: string; createdAt: number },
  unit: { unitId: string },
  message: string,
  anchorId?: string,
): void {
  recordViewDiagnostic({
    code,
    artifactId: input.artifactId,
    unitId: unit.unitId,
    ...(anchorId ? { anchorId } : {}),
    message,
    createdAt: input.createdAt,
  });
}

function recordViewDiagnostic(diagnostic: ContinuityAnchorDiagnostic): void {
  diagnostics.push(diagnostic);
  if (diagnostics.length > DIAGNOSTIC_LIMIT) diagnostics.shift();
}
