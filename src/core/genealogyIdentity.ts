import type { GenealogyNode, GenealogyResult } from '../schemas/genealogy.ts';

export const lineageKindLabels = {
  auto: '自动识别身份', native: '本世界原生', 'same-world-travel': '同世界时间穿越',
  'cross-world-travel': '异界穿越', possession: '灵魂夺舍', reincarnation: '转生',
  adoption: '收养谱系', creation: '构装体／机器人／创造物',
} as const;
export function isDualTrack(node: GenealogyNode): boolean {
  return !!node.identity && !['native', 'adoption'].includes(node.identity.lineageKind);
}
export function hasOrdinaryGenerationChronology(node: GenealogyNode): boolean {
  return !isDualTrack(node);
}
/** Generation positions express layout, not biological proof. */
export function biologicalEdge(edge: GenealogyResult['edges'][number]): boolean {
  return (!edge.track || edge.track === 'body')
    && ['parent', 'child', 'grandparent', 'grandchild', 'ancestor', 'descendant'].includes(edge.relationType);
}
export function biologicalFamilyIds(genealogy: GenealogyResult, focusId: string): Set<string> {
  const ids = new Set([focusId]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const edge of genealogy.edges) {
      if (biologicalEdge(edge) && (ids.has(edge.from) || ids.has(edge.to))) {
        ids.add(edge.from); ids.add(edge.to);
      }
    }
  }
  return ids;
}
export function genealogyIdentityLines(node: GenealogyNode): string[] {
  const identity = node.identity;
  if (!identity) return [];
  return [
    `谱系类型：${lineageKindLabels[identity.lineageKind]}`,
    ...(identity.body ? [`肉身原点：${identity.body.world ?? '世界待考'} · ${identity.body.birth?.label ?? '生年待考'}`] : []),
    ...(identity.soul ? [`原身份：${identity.soul.name ?? node.name} · ${identity.soul.world ?? '世界待考'} · ${identity.soul.birth?.label ?? '源年待考'}；其亲属、死亡和经历不自动归属当前肉身`] : []),
    ...(identity.arrival ? [`本界抵达：${identity.arrival.label}（不是出生）`] : []),
    ...(identity.activation ? [`启动／创造：${identity.activation.label}（不是血缘出生）`] : []),
    ...(identity.incarnation ? [`夺舍／转生：${identity.incarnation.label}（不覆盖原肉身家族）`] : []),
    ...(identity.originAge ? [`原点年龄：${identity.originAge.at.label}时${identity.originAge.years}岁；本界经过时间另计`] : []),
    ...(identity.note ? [identity.note] : []),
  ];
}

export type GenealogyFamilyTrack = 'body' | 'soul';
export function hasOriginFamily(genealogy: GenealogyResult): boolean {
  const focus = genealogy.nodes.find(node => node.isFocus);
  return ['possession', 'reincarnation'].includes(focus?.identity?.lineageKind ?? '')
    && genealogy.edges.some(edge => edge.track === 'soul' && (edge.from === focus?.id || edge.to === focus?.id)
      && genealogy.nodes.some(node => node.id === (edge.from === focus?.id ? edge.to : edge.from)));
}

/** Display projection only: never write a filtered family back to the saved record. */
export function genealogyFamilyView(genealogy: GenealogyResult, track: GenealogyFamilyTrack = 'body'): GenealogyResult {
  if (!hasOriginFamily(genealogy)) return genealogy;
  const focus = genealogy.nodes.find(node => node.isFocus)!;
  const allowed = genealogy.edges.filter(edge => track === 'soul' ? edge.track === 'soul' : edge.track !== 'soul');
  const ids = new Set([focus.id]);
  for (let size = -1; size !== ids.size;) {
    size = ids.size;
    for (const edge of allowed) if (ids.has(edge.from) || ids.has(edge.to)) { ids.add(edge.from); ids.add(edge.to); }
  }
  return { ...genealogy, nodes: genealogy.nodes.filter(node => ids.has(node.id)),
    edges: allowed.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}

export function genealogyRelationText(genealogy: GenealogyResult, node: GenealogyNode, track: GenealogyFamilyTrack = 'body'): string {
  if (node.isFocus) return '本人';
  const focus = genealogy.nodes.find(item => item.isFocus);
  const labels = genealogyFamilyView(genealogy, track).edges
    .filter(edge => (edge.from === node.id && edge.to === focus?.id) || (edge.to === node.id && edge.from === focus?.id))
    .map(edge => edge.label.trim()).filter(Boolean);
  return labels.length && (hasOriginFamily(genealogy) || focus?.identity?.lineageKind === 'creation')
    ? [...new Set(labels)].join(' · ') : node.relationToFocus;
}

/** Natural, compact dates; a body's death never declares its occupant's identity dead. */
export function genealogyDisplayDates(node: GenealogyNode, track: GenealogyFamilyTrack = 'body'): { title: string; label: string } {
  const identity = node.identity;
  if (node.isFocus && track === 'soul' && identity?.soul) {
    return { title: '原身份', label: [identity.soul.birth?.label ?? '生年不详', identity.soul.death?.label ?? '卒年不详'].join('—') };
  }
  if (identity?.lineageKind === 'creation') {
    return { title: '启停', label: `${identity.activation?.label ?? '启动时间不详'}—${identity.identityEnd?.label ?? (node.death.status === 'alive' ? '运行中' : '停用时间不详')}` };
  }
  const birth = identity?.body?.birth ?? node.birth;
  const death = ['possession', 'reincarnation'].includes(identity?.lineageKind ?? '')
    ? identity?.identityEnd : node.death;
  return { title: '生卒', label: `${birth.label}—${death?.label ?? (node.death.status === 'alive' ? '在世' : '状态不详')}` };
}

export function genealogyMilestone(node: GenealogyNode): { title: string; label: string } | null {
  const identity = node.identity;
  if (identity?.arrival) return { title: '抵达', label: identity.arrival.label };
  if (identity?.incarnation) return { title: identity.lineageKind === 'reincarnation' ? '转生' : '寄宿', label: identity.incarnation.label };
  return null;
}

export function genealogyEdgeDescription(edge: GenealogyResult['edges'][number]): string {
  const scope = edge.track === 'soul' ? '原身份家族' : edge.track === 'body' ? '肉身家族' : '';
  const period = [edge.period?.from?.label, edge.period?.to?.label].filter(Boolean).join('—');
  return [edge.label, scope, period].filter(Boolean).join(' · ');
}
/** Presence boundary only; no fabricated biological age for a traveler or machine. */
export function genealogyPresenceOrigin(node: GenealogyNode): GenealogyNode['birth'] {
  const identity = node.identity;
  if (!identity) return node.birth;
  const date = identity.lineageKind === 'creation' ? identity.activation
    : ['possession', 'reincarnation'].includes(identity.lineageKind) ? identity.incarnation
    : ['same-world-travel', 'cross-world-travel'].includes(identity.lineageKind) ? identity.arrival
    : undefined;
  return date ?? (isDualTrack(node)
    ? { status: 'unknown', era: '', year: null, month: null, day: null, precision: 'unknown', label: '本界在场原点待考' }
    : node.birth);
}
