import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { CanonBranch } from '../retrieval/contracts.ts';
import type { RuinSelectedCharacter } from '../storage/ruinReferences.ts';
import { buildGenealogyLocalView, type GenealogyLocalView } from '../core/genealogyLocalView.ts';
import { historyReferencesForPerson, type GenealogyHistoryReference } from './genealogyContinuity.ts';

export function projectGenealogyRecords(records: GenealogyRecord[], branch?: CanonBranch): GenealogyRecord[] {
  return records.map(record => ({ ...record, localView: buildGenealogyLocalView(record, branch) }));
}

export function genealogySources(records: GenealogyRecord[], branch?: CanonBranch, history: GenealogyHistoryReference[] = []) {
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();
  return projectGenealogyRecords(records, branch).sort((a, b) => b.createdAt - a.createdAt).flatMap(record => {
    const view = record.localView!;
    const ids = new Map(record.localEvidence?.nodes.map(node => [node.nodeId, node.entityId]) ?? []);
    const nodeKey = (id: string) => ids.get(id) ?? `${record.requestId}:${id}`;
    const edges = view.edges.filter(edge => {
      const key = `${nodeKey(edge.from)}\u0000${edge.relationType}\u0000${nodeKey(edge.to)}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key); return true;
    });
    const endpoints = new Set(edges.flatMap(edge => [edge.from, edge.to]));
    const nodes = view.nodes.filter(node => {
      const key = nodeKey(node.id);
      const current = view.units.find(unit => unit.unitType === 'node' && unit.unitId === node.id)?.reusable;
      // An uncertain newer node must not hide a current older node.
      if (seenNodes.has(key) && !endpoints.has(node.id)) return false;
      if (current) seenNodes.add(key);
      return true;
    }).map(node => ({ ...node, historyRefs: undefined, historyNotes: historyReferencesForPerson(history, node.name, ids.get(node.id))
      .filter(ref => record.result.nodes.find(item => item.id === node.id)?.historyRefs?.some(old => old.biographyId === ref.biographyId && old.stageId === ref.stageId))
      .map(ref => ref.claim) }));
    if (!nodes.length) return [];
    const data = { schema: 'eyon.genealogy.current.v1', nodes, edges, notice: '已按当前历史版本筛选；待核实节点只供辨识，不证明亲缘。历史附注是同版作品的低权连续性。' };
    return [{ sourceId: `genealogy:${record.requestId}`, title: `${record.result.focusCharacterName}宗族谱系（当前局部）`, content: JSON.stringify(data) },
      ...nodes.map(node => ({ sourceId: `genealogy:${record.requestId}:${node.id}`, title: `${node.name}（谱系人物）`, content: JSON.stringify({ schema: 'eyon.genealogy.node.v1', node, relatedEdges: edges.filter(edge => edge.from === node.id || edge.to === node.id), notice: data.notice }) }))];
  });
}

export function genealogyNodeToRuinReference(record: GenealogyRecord, nodeId: string, view: GenealogyLocalView): RuinSelectedCharacter | null {
  const node = view.nodes.find(item => item.id === nodeId);
  if (!node) return null;
  const referenceId = `genealogy:${record.requestId}:${node.id}`;
  const names = new Map(view.nodes.map(item => [item.id, item.name]));
  const relations = view.edges.filter(edge => edge.from === node.id || edge.to === node.id)
    .map(edge => `${names.get(edge.from) ?? ''} → ${edge.label} → ${names.get(edge.to) ?? ''}`);
  return { referenceId, mvuId: node.mvuId || referenceId, name: node.name, source: 'genealogy', identities: node.identities, race: node.race, professions: node.professions, relations,
    lifespan: `${node.birth.label} - ${node.death.label}`, contextSummary: [node.summary, node.profile.personality, node.profile.lifeExperience].join('；') };
}

/** Rebuild on each read; retained selections are never deleted on a Canon change. */
export function projectGenealogyRuinReferences(selected: RuinSelectedCharacter[], records: GenealogyRecord[], branch?: CanonBranch): RuinSelectedCharacter[] {
  const byReference = new Map<string, RuinSelectedCharacter>();
  for (const record of records) {
    const view = buildGenealogyLocalView(record, branch);
    for (const node of view.nodes) {
      const reference = genealogyNodeToRuinReference(record, node.id, view);
      if (reference) byReference.set(reference.referenceId!, reference);
    }
  }
  return selected.flatMap(reference => reference.source !== 'genealogy' ? [reference]
    : reference.referenceId && byReference.has(reference.referenceId) ? [byReference.get(reference.referenceId)!] : []);
}
