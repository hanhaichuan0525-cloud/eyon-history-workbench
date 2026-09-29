import type { GenealogyNode, GenealogyResult } from '../schemas/genealogy.ts';

export const GENEALOGY_NODE_WIDTH = 156;
export const GENEALOGY_NODE_HEIGHT = 78;

const MIN_BOARD_WIDTH = 1120;
const BOARD_SIDE_PADDING = 112;
const GENERATION_TOP = 58;
const BASE_ROW_GAP = 214;
const CONNECTOR_LANE_GAP = 18;
const SIBLING_GAP = GENEALOGY_NODE_WIDTH + 30;
const SAME_BRANCH_GAP = GENEALOGY_NODE_WIDTH + 56;
const SEPARATE_BRANCH_GAP = GENEALOGY_NODE_WIDTH + 96;

export interface PositionedGenealogyNode {
  node: GenealogyNode;
  x: number;
  y: number;
  branch: 'direct' | 'collateral';
}

export interface GenealogyBoardLayout {
  width: number;
  height: number;
  positions: PositionedGenealogyNode[];
  generationLabels: Array<{ label: string; y: number }>;
}

export interface GenealogyBoardConnector {
  edgeIds: string[];
  path: string;
  kind: 'family';
  familyId: string;
  parentIds: string[];
  childIds: string[];
  lane: number;
}

interface ParentChildEdge {
  edgeId: string;
  parentId: string;
  childId: string;
}

interface FamilyGroup {
  id: string;
  parents: string[];
  children: string[];
  edgeIds: string[];
  lane: number;
}

interface OrderedRow {
  generation: number;
  nodes: GenealogyNode[];
}

/**
 * Relationship-aware, deterministic family layout. Explicit parent-child
 * edges define clusters; relation labels are only a stable fallback for nodes
 * whose structural branch is absent from older generated records.
 */
export function createGenealogyBoardLayout(result: GenealogyResult): GenealogyBoardLayout {
  const focus = result.nodes.find(node => node.isFocus) ?? result.nodes[0];
  if (!focus) {
    return { width: MIN_BOARD_WIDTH, height: 520, positions: [], generationLabels: [] };
  }

  const parentChildEdges = result.edges.flatMap(edge => {
    const normalized = normalizeParentChild(edge);
    return normalized ? [normalized] : [];
  });
  const parentsByChild = collectRelations(parentChildEdges, 'childId', 'parentId');
  const childrenByParent = collectRelations(parentChildEdges, 'parentId', 'childId');
  const grouped = new Map<number, GenealogyNode[]>();
  for (const node of result.nodes) {
    const row = grouped.get(node.generation) ?? [];
    row.push(node);
    grouped.set(node.generation, row);
  }

  const generations = [...grouped.keys()].sort((left, right) => left - right);
  const rows: OrderedRow[] = generations.map(generation => ({
    generation,
    nodes: orderGeneration(grouped.get(generation) ?? [], focus),
  }));
  improveRowOrder(rows, parentsByChild, childrenByParent, focus);

  const rawX = seedRowCoordinates(rows, parentsByChild, childrenByParent);
  relaxCoordinates(rows, rawX, parentsByChild, childrenByParent);

  const focusX = rawX.get(focus.id) ?? 0;
  const relativeXs = [...rawX.values()].map(value => value - focusX);
  const halfSpan = Math.max(
    MIN_BOARD_WIDTH / 2,
    ...relativeXs.map(value => Math.abs(value) + GENEALOGY_NODE_WIDTH / 2 + BOARD_SIDE_PADDING),
  );
  const width = Math.ceil(halfSpan * 2);
  const centreX = width / 2;

  const laneCounts = connectorLaneCounts(result, rows, rawX);
  const rowYs: number[] = [];
  let nextY = GENERATION_TOP;
  for (const [index] of rows.entries()) {
    rowYs.push(nextY);
    const lanes = laneCounts.get(index) ?? 1;
    nextY += BASE_ROW_GAP + Math.max(0, lanes - 1) * CONNECTOR_LANE_GAP;
  }

  const positions: PositionedGenealogyNode[] = [];
  const generationLabels: Array<{ label: string; y: number }> = [];
  for (const [rowIndex, row] of rows.entries()) {
    const y = rowYs[rowIndex] ?? GENERATION_TOP;
    generationLabels.push({
      label: generationLabel(row.generation - focus.generation),
      y,
    });
    for (const node of row.nodes) {
      positions.push({
        node,
        x: centreX + (rawX.get(node.id) ?? 0) - focusX,
        y,
        branch: isCollateralNode(node) ? 'collateral' : 'direct',
      });
    }
  }

  const lastY = rowYs.at(-1) ?? GENERATION_TOP;
  const height = Math.max(520, lastY + GENEALOGY_NODE_HEIGHT + 74);
  return { width, height, positions, generationLabels };
}

export function createGenealogyBoardConnectors(
  result: GenealogyResult,
  layout: GenealogyBoardLayout,
): GenealogyBoardConnector[] {
  const positions = new Map(layout.positions.map(position => [position.node.id, position]));
  const families = buildFamilyGroups(result, positions);
  assignConnectorLanes(families, positions);

  return families.flatMap(family => {
    const parents = family.parents
      .map(id => positions.get(id))
      .filter((value): value is PositionedGenealogyNode => !!value);
    const children = family.children
      .map(id => positions.get(id))
      .filter((value): value is PositionedGenealogyNode => !!value);
    if (!parents.length || !children.length) return [];

    const parentBottom = Math.max(...parents.map(parent => parent.y + GENEALOGY_NODE_HEIGHT));
    const childTop = Math.min(...children.map(child => child.y));
    const available = Math.max(56, childTop - parentBottom);
    const preferredY = parentBottom + 42 + family.lane * CONNECTOR_LANE_GAP;
    const busY = Math.min(childTop - 38, preferredY, parentBottom + available * .68);
    const parentXs = parents.map(parent => parent.x);
    const childXs = children.map(child => child.x);
    const allXs = [...parentXs, ...childXs];
    const parts = parents.map(parent =>
      `M${round(parent.x)} ${round(parent.y + GENEALOGY_NODE_HEIGHT)} V${round(busY)}`,
    );
    if (Math.max(...allXs) - Math.min(...allXs) > 1) {
      parts.push(`M${round(Math.min(...allXs))} ${round(busY)} H${round(Math.max(...allXs))}`);
    }
    parts.push(...children.map(child =>
      `M${round(child.x)} ${round(busY)} V${round(child.y)}`,
    ));

    return [{
      edgeIds: [...new Set(family.edgeIds)],
      path: parts.join(' '),
      kind: 'family' as const,
      familyId: family.id,
      parentIds: family.parents,
      childIds: family.children,
      lane: family.lane,
    }];
  });
}

export function displayGenealogyDateLabel(label: string): string {
  return label
    .replace(/\s*[（(](?:按世界书年龄推(?:断|算)|按MVU年龄推(?:断|算)|谱系推(?:断|算)|世界书年龄推(?:断|算))[）)]/gu, '')
    .trim();
}

function improveRowOrder(
  rows: OrderedRow[],
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
  focus: GenealogyNode,
): void {
  for (let sweep = 0; sweep < 6; sweep += 1) {
    for (let index = 1; index < rows.length; index += 1) {
      sortByNeighbourBarycentre(rows[index]!, rows[index - 1]!, parentsByChild, focus);
    }
    for (let index = rows.length - 2; index >= 0; index -= 1) {
      sortByNeighbourBarycentre(rows[index]!, rows[index + 1]!, childrenByParent, focus);
    }
  }
}

function sortByNeighbourBarycentre(
  row: OrderedRow,
  neighbourRow: OrderedRow,
  links: ReadonlyMap<string, string[]>,
  focus: GenealogyNode,
): void {
  const neighbourOrder = new Map(neighbourRow.nodes.map((node, index) => [node.id, index]));
  const originalOrder = new Map(row.nodes.map((node, index) => [node.id, index]));
  row.nodes.sort((left, right) => {
    const leftScore = neighbourBarycentre(left.id, links, neighbourOrder);
    const rightScore = neighbourBarycentre(right.id, links, neighbourOrder);
    if (leftScore != null && rightScore != null && leftScore !== rightScore) return leftScore - rightScore;
    return compareFallback(left, right, focus, originalOrder);
  });
}

function compareFallback(
  left: GenealogyNode,
  right: GenealogyNode,
  focus: GenealogyNode,
  originalOrder: ReadonlyMap<string, number>,
): number {
  return lineageScore(left) - lineageScore(right)
    || (left.id === focus.id ? -1 : right.id === focus.id ? 1 : 0)
    || (originalOrder.get(left.id) ?? 0) - (originalOrder.get(right.id) ?? 0)
    || roleOrder(left) - roleOrder(right)
    || left.name.localeCompare(right.name, 'zh-CN');
}

function neighbourBarycentre(
  nodeId: string,
  links: ReadonlyMap<string, string[]>,
  order: ReadonlyMap<string, number>,
): number | null {
  const values = (links.get(nodeId) ?? [])
    .map(id => order.get(id))
    .filter((value): value is number => value != null);
  return values.length ? average(values) : null;
}

function seedRowCoordinates(
  rows: OrderedRow[],
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
): Map<string, number> {
  const coordinates = new Map<string, number>();
  for (const row of rows) {
    let cursor = 0;
    row.nodes.forEach((node, index) => {
      if (index > 0) {
        cursor += gapBetween(row.nodes[index - 1]!, node, parentsByChild, childrenByParent);
      }
      coordinates.set(node.id, cursor);
    });
    const centre = average(row.nodes.map(node => coordinates.get(node.id) ?? 0));
    row.nodes.forEach(node => coordinates.set(node.id, (coordinates.get(node.id) ?? 0) - centre));
  }
  return coordinates;
}

function relaxCoordinates(
  rows: OrderedRow[],
  coordinates: Map<string, number>,
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
): void {
  for (let sweep = 0; sweep < 8; sweep += 1) {
    const topDown = sweep % 2 === 0;
    const orderedRows = topDown ? rows : [...rows].reverse();
    const links = topDown ? parentsByChild : childrenByParent;
    for (const row of orderedRows) {
      const desired = new Map<string, number>();
      for (const node of row.nodes) {
        const neighbours = (links.get(node.id) ?? [])
          .map(id => coordinates.get(id))
          .filter((value): value is number => value != null);
        const current = coordinates.get(node.id) ?? 0;
        desired.set(node.id, neighbours.length ? current * .35 + average(neighbours) * .65 : current);
      }
      enforceRowSeparation(row.nodes, coordinates, desired, parentsByChild, childrenByParent);
    }
  }
}

function enforceRowSeparation(
  nodes: GenealogyNode[],
  coordinates: Map<string, number>,
  desired: ReadonlyMap<string, number>,
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
): void {
  if (!nodes.length) return;
  const next: number[] = [];
  for (const [index, node] of nodes.entries()) {
    const target = desired.get(node.id) ?? coordinates.get(node.id) ?? 0;
    if (index === 0) {
      next.push(target);
      continue;
    }
    const required = gapBetween(nodes[index - 1]!, node, parentsByChild, childrenByParent);
    next.push(Math.max(target, next[index - 1]! + required));
  }
  for (let index = nodes.length - 2; index >= 0; index -= 1) {
    const required = gapBetween(nodes[index]!, nodes[index + 1]!, parentsByChild, childrenByParent);
    next[index] = Math.min(next[index]!, next[index + 1]! - required);
  }
  const desiredCentre = average(nodes.map(node => desired.get(node.id) ?? 0));
  const actualCentre = average(next);
  nodes.forEach((node, index) => coordinates.set(node.id, next[index]! + desiredCentre - actualCentre));
}

function gapBetween(
  left: GenealogyNode,
  right: GenealogyNode,
  parentsByChild: ReadonlyMap<string, string[]>,
  childrenByParent: ReadonlyMap<string, string[]>,
): number {
  if (sameSet(parentsByChild.get(left.id), parentsByChild.get(right.id))) return SIBLING_GAP;
  if (intersects(childrenByParent.get(left.id), childrenByParent.get(right.id))) return SIBLING_GAP;
  if (lineageBand(left) === lineageBand(right)) return SAME_BRANCH_GAP;
  return SEPARATE_BRANCH_GAP;
}

function buildFamilyGroups(
  result: GenealogyResult,
  positions: ReadonlyMap<string, PositionedGenealogyNode>,
): FamilyGroup[] {
  const childParents = new Map<string, ParentChildEdge[]>();
  for (const edge of result.edges) {
    const normalized = normalizeParentChild(edge);
    if (!normalized || !positions.has(normalized.parentId) || !positions.has(normalized.childId)) continue;
    const parents = childParents.get(normalized.childId) ?? [];
    parents.push(normalized);
    childParents.set(normalized.childId, parents);
  }

  const families = new Map<string, FamilyGroup>();
  for (const [childId, parentEdges] of childParents) {
    const parents = [...new Set(parentEdges.map(edge => edge.parentId))]
      .sort((left, right) => (positions.get(left)?.x ?? 0) - (positions.get(right)?.x ?? 0));
    const childGeneration = positions.get(childId)?.node.generation ?? 0;
    const key = `${parents.join('|')}@${childGeneration}`;
    const family = families.get(key) ?? {
      id: key, parents, children: [], edgeIds: [], lane: 0,
    };
    family.children.push(childId);
    family.edgeIds.push(...parentEdges.map(edge => edge.edgeId));
    families.set(key, family);
  }
  return [...families.values()].sort((left, right) =>
    familyInterval(left, positions)[0] - familyInterval(right, positions)[0],
  );
}

function assignConnectorLanes(
  families: FamilyGroup[],
  positions: ReadonlyMap<string, PositionedGenealogyNode>,
): void {
  const boundaryLanes = new Map<string, Array<Array<[number, number]>>>();
  for (const family of families) {
    const parents = family.parents.map(id => positions.get(id)).filter(Boolean) as PositionedGenealogyNode[];
    const children = family.children.map(id => positions.get(id)).filter(Boolean) as PositionedGenealogyNode[];
    if (!parents.length || !children.length) continue;
    const boundary = `${Math.max(...parents.map(item => item.y))}:${Math.min(...children.map(item => item.y))}`;
    const lanes = boundaryLanes.get(boundary) ?? [];
    const interval = familyInterval(family, positions);
    let lane = lanes.findIndex(occupied => occupied.every(other => !intervalsOverlap(interval, other)));
    if (lane < 0) {
      lane = lanes.length;
      lanes.push([]);
    }
    lanes[lane]!.push(interval);
    family.lane = lane;
    boundaryLanes.set(boundary, lanes);
  }
}

function connectorLaneCounts(
  result: GenealogyResult,
  rows: OrderedRow[],
  rawX: ReadonlyMap<string, number>,
): Map<number, number> {
  const temporaryPositions = new Map<string, PositionedGenealogyNode>();
  rows.forEach((row, rowIndex) => row.nodes.forEach(node => temporaryPositions.set(node.id, {
    node,
    x: rawX.get(node.id) ?? 0,
    y: rowIndex * BASE_ROW_GAP,
    branch: isCollateralNode(node) ? 'collateral' : 'direct',
  })));
  const families = buildFamilyGroups(result, temporaryPositions);
  assignConnectorLanes(families, temporaryPositions);
  const counts = new Map<number, number>();
  for (const family of families) {
    const parentRows = family.parents
      .map(id => temporaryPositions.get(id)?.node.generation)
      .filter((value): value is number => value != null);
    if (!parentRows.length) continue;
    const parentIndex = rows.findIndex(row => row.generation === Math.max(...parentRows));
    if (parentIndex >= 0) counts.set(parentIndex, Math.max(counts.get(parentIndex) ?? 1, family.lane + 1));
  }
  return counts;
}

function familyInterval(
  family: FamilyGroup,
  positions: ReadonlyMap<string, PositionedGenealogyNode>,
): [number, number] {
  const values = [...family.parents, ...family.children]
    .map(id => positions.get(id)?.x)
    .filter((value): value is number => value != null);
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 0];
}

function intervalsOverlap(left: [number, number], right: [number, number]): boolean {
  return left[0] <= right[1] + 14 && right[0] <= left[1] + 14;
}

function collectRelations(
  edges: ParentChildEdge[],
  source: 'parentId' | 'childId',
  target: 'parentId' | 'childId',
): Map<string, string[]> {
  const collected = new Map<string, string[]>();
  for (const edge of edges) {
    const values = collected.get(edge[source]) ?? [];
    if (!values.includes(edge[target])) values.push(edge[target]);
    collected.set(edge[source], values);
  }
  return collected;
}

function normalizeParentChild(edge: GenealogyResult['edges'][number]): ParentChildEdge | null {
  if (['parent', 'adoptiveParent'].includes(edge.relationType)) {
    return { edgeId: edge.id, parentId: edge.from, childId: edge.to };
  }
  if (['child', 'adoptiveChild'].includes(edge.relationType)) {
    return { edgeId: edge.id, parentId: edge.to, childId: edge.from };
  }
  return null;
}

function orderGeneration(nodes: GenealogyNode[], focus: GenealogyNode): GenealogyNode[] {
  return [...nodes].sort((left, right) => {
    return lineageScore(left) - lineageScore(right)
      || (left.id === focus.id ? -1 : right.id === focus.id ? 1 : 0)
      || roleOrder(left) - roleOrder(right)
      || left.name.localeCompare(right.name, 'zh-CN');
  });
}

function lineageScore(node: GenealogyNode): number {
  const relation = node.relationToFocus;
  if (node.isFocus) return 0;
  if (/^父亲$|^父$|生父|养父/u.test(relation)) return -10;
  if (/^母亲$|^母$|生母|养母/u.test(relation)) return 10;
  if (/母系|母方|^外祖|舅|姨/u.test(relation)) return 30;
  if (/父系|父方|祖母外|^祖|^曾祖|^高祖|伯|叔|姑/u.test(relation)) return -30;
  if (/堂/u.test(relation)) return -20;
  if (/表/u.test(relation)) return 20;
  if (/兄|姐|弟|妹/u.test(relation)) return -10;
  if (/配偶|丈夫|妻子|伴侣/u.test(relation)) return 10;
  return 0;
}

function lineageBand(node: GenealogyNode): 'paternal' | 'direct' | 'maternal' {
  const score = lineageScore(node);
  if (score < -12) return 'paternal';
  if (score > 12) return 'maternal';
  return 'direct';
}

function roleOrder(node: GenealogyNode): number {
  const relation = node.relationToFocus;
  if (/父$|祖父|曾祖父|高祖父|伯父|叔父|舅父/u.test(relation)) return 10;
  if (/母$|祖母|曾祖母|高祖母|伯母|叔母|舅母|姑母|姨母/u.test(relation)) return 20;
  if (node.isFocus) return 30;
  return 40;
}

function isCollateralNode(node: GenealogyNode): boolean {
  return /叔|伯|姑|姨|舅|侄|甥|堂|表|兄|弟|姐|妹|旁支|族亲/u.test(node.relationToFocus);
}

function generationLabel(relative: number): string {
  if (relative === 0) return '同辈';
  if (relative === 1) return '后代';
  if (relative > 1) return `${relative}代后`;
  if (relative === -1) return '父母辈';
  if (relative === -2) return '祖辈';
  if (relative === -3) return '曾祖辈';
  return `${Math.abs(relative)}代祖辈`;
}

function sameSet(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(value => rightSet.has(value));
}

function intersects(left: string[] | undefined, right: string[] | undefined): boolean {
  if (!left?.length || !right?.length) return false;
  const rightSet = new Set(right);
  return left.some(value => rightSet.has(value));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function round(value: number): number {
  return Number(value.toFixed(2));
}
