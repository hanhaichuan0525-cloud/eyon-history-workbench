import { assessArtifactCanonBinding } from '../core/artifactCanonAssessment.ts';
import { currentArtifactCanonAssessmentTarget } from '../core/artifactCanonConsumption.ts';
import { namespaceKey } from '../core/namespace.ts';
import type { CanonBranch } from '../retrieval/contracts.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import { ArchiveMemoryIndex, type ArchiveMemoryUnit } from './archiveMemoryIndex.ts';

interface PassageUnit extends ArchiveMemoryUnit {
  record: BiographyRecord;
  unitId: string;
  time: string;
}

/** Original origin/stage/status passages; summaries and anchors are never substituted for prose. */
export function buildBiographyArchiveMemory(input: {
  records: readonly BiographyRecord[];
  branch: CanonBranch;
  query: string;
  focus?: string;
  index?: ArchiveMemoryIndex;
}): { text: string; passageCount: number; omittedCount: number; warnings: string[] } {
  const records = input.records.filter(record => record.status === 'committed'
    && record.namespace.characterKey === input.branch.characterKey
    && record.namespace.chatId === input.branch.chatId);
  const units: PassageUnit[] = records.flatMap(record => {
    const bio = record.biography;
    return [
      { ...bio.origin, id: 'origin' },
      ...(bio.stages ?? []),
      { ...bio.status, id: 'status' },
    ].filter(passage => typeof passage.content === 'string' && passage.content.trim())
      .map(passage => ({
        key: JSON.stringify([record.biographyId, passage.id]), record, unitId: passage.id,
        title: passage.title, content: passage.content,
        time: 'span' in passage ? passage.span : bio.span?.label ?? '',
        keywords: [bio.target?.name, ...(bio.target?.aliases ?? []),
          ...('people' in passage ? passage.people : []),
          ...('factions' in passage ? passage.factions : []),
          ...('objects' in passage ? passage.objects : []),
          ...('locations' in passage ? passage.locations : []),
        ].filter((word): word is string => typeof word === 'string'),
      }));
  });
  const index = input.index ?? new ArchiveMemoryIndex();
  index.sync(JSON.stringify([input.branch.characterKey, input.branch.chatId, input.branch.branchId]), units);
  const warnings: string[] = [];
  const bindings = records.flatMap(record => record.canonBindings ?? []);
  const target = currentArtifactCanonAssessmentTarget({ bindings, branch: input.branch });
  const eligible = new Map<string, string | null>();
  const assess = (unit: PassageUnit): string | null => {
    if (eligible.has(unit.key)) return eligible.get(unit.key)!;
    const ownBindings = unit.record.canonBindings ?? [];
    const binding = ownBindings.find(item => item.unitId === unit.unitId);
    const unitAnchors = (unit.record.continuityAnchors ?? []).filter(item => item.producer.unitId === unit.unitId);
    let label = '已提交传记原文；未经当前历史依赖核定，不作为现行事实裁决';
    try {
      if ((ownBindings.length > 0 && !ownBindings.some(item => item.branchId === input.branch.branchId))
        || unitAnchors.some(item => item.branchId !== input.branch.branchId
          || item.canonRevision > input.branch.headRevision)
        || (binding && (binding.branchId !== input.branch.branchId
          || binding.boundView.resolvedRevision > input.branch.headRevision))) {
        eligible.set(unit.key, null);
        return null;
      }
      if (binding) {
        const assessment = assessArtifactCanonBinding({ binding, view: target, branch: input.branch });
        if (['stale', 'partially-stale', 'orphaned'].includes(assessment.status ?? '')) {
          warnings.push(`传记「${unit.record.biography.target.name}」章节「${unit.title}」历史依赖已失效，原文未投递。`);
          eligible.set(unit.key, null);
          return null;
        }
        if (assessment.status === 'current') label = '已提交传记原文；现有依赖仍有效，属于低权历史记载';
      }
    } catch {
      warnings.push(`传记「${unit.title}」依赖无法核定，仅作为旧记载，不作当前事实。`);
    }
    eligible.set(unit.key, label);
    return label;
  };
  const ranked = units.map(unit => ({ unit, ...index.score(unit.key, input.query, input.focus) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || b.unit.record.updatedAt - a.unit.record.updatedAt
      || a.unit.key.localeCompare(b.unit.key));
  const byKey = new Map(units.map(unit => [unit.key, unit]));
  const anchorKeys = new Map(records.flatMap(record => (record.continuityAnchors ?? [])
    .filter(anchor => anchor.schema === 'eyon.continuity.anchor.v1'
      && anchor.producer?.artifactId === record.biographyId
      && anchor.branchId === input.branch.branchId && anchor.canonRevision <= input.branch.headRevision)
    .map(anchor => [anchor.anchorId, JSON.stringify([record.biographyId, anchor.producer.unitId])] as const)));
  // Keep known conflict/parallel sides together even after an unrelated Canon revision advances.
  const namespace = namespaceKey(input.branch);
  const relations = records.flatMap(record => (record.continuityRelations ?? [])
    .filter(relation => relation?.schema === 'eyon.continuity.relation.v1'
      && relation.producerArtifactId === record.biographyId && relation.namespace === namespace
      && (relation.kind === 'sourceConflict' || relation.kind === 'parallelView')
      && relation.branchId === input.branch.branchId && Number.isInteger(relation.canonRevision)
      && relation.canonRevision <= input.branch.headRevision
      && Array.isArray(relation.memberAnchorIds) && relation.memberAnchorIds.length === 2
      && relation.memberAnchorIds.every(id => typeof id === 'string' && id.length > 0)));
  const relationKeys = (ids: readonly string[]) => ids.map(id =>
    anchorKeys.get(id) ?? `missing-anchor:${JSON.stringify(id)}`);
  const selected: PassageUnit[] = [];
  const selectedKeys = new Set<string>();
  const MAX_PASSAGES = 3;
  for (const candidate of ranked) {
    if (selectedKeys.has(candidate.unit.key) || !assess(candidate.unit)) continue;
    const groupKeys = new Set([candidate.unit.key]);
    // Transitive closure prevents the same known three-way conflict from leaking one side.
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const relation of relations) {
        const keys = relationKeys(relation.memberAnchorIds);
        if (!keys.some(key => groupKeys.has(key))) continue;
        for (const key of keys) if (!groupKeys.has(key)) { groupKeys.add(key); expanded = true; }
      }
    }
    const group = [...groupKeys].map(key => byKey.get(key));
    if (group.some(unit => !unit || !assess(unit))) {
      warnings.push('相关传记的并存／冲突记载无法完整投递，本组暂不作为正文记忆。');
      continue;
    }
    const additional = (group as PassageUnit[]).filter(unit => !selectedKeys.has(unit.key));
    if (selected.length + additional.length > MAX_PASSAGES) continue;
    for (const unit of additional) { selected.push(unit); selectedKeys.add(unit.key); }
  }
  const labels = new Map(selected.map((unit, i) => [unit.key, `传记原文${i + 1}`]));
  const relationLines = relations.flatMap(relation => {
    const names = relation.memberAnchorIds.map(id => labels.get(anchorKeys.get(id) ?? ''));
    return names.length === 2 && names.every(Boolean)
      ? [`${relation.kind === 'sourceConflict' ? '来源冲突' : '并存视角'}：${names.join('与')}是同一事件的不同记载，未裁定，不得静默选边。`]
      : [];
  });
  return {
    text: [...selected.map(unit => [
      `[${labels.get(unit.key)}] ${unit.record.biography.target.name} — ${unit.title}`,
      unit.time ? `记载时段：${unit.time}` : '',
      assess(unit), unit.content,
    ].filter(Boolean).join('\n')), ...new Set(relationLines)].join('\n\n'),
    passageCount: selected.length,
    omittedCount: ranked.filter(item => !selectedKeys.has(item.unit.key)).length,
    warnings: [...new Set(warnings)],
  };
}
