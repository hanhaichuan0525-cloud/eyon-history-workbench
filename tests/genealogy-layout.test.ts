import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenealogyNode, GenealogyResult } from '../src/schemas/genealogy.ts';
import {
  createGenealogyBoardConnectors,
  createGenealogyBoardLayout,
  displayGenealogyDateLabel,
  GENEALOGY_NODE_WIDTH,
} from '../src/ui/genealogyLayout.ts';

function node(
  id: string,
  name: string,
  generation: number,
  relationToFocus: string,
  isFocus = false,
): GenealogyNode {
  return {
    id, mvuId: isFocus ? name : '', name, aliases: [], generation, isFocus,
    isMvuCharacter: isFocus, viewable: true, canInjectToRuin: true,
    provenance: isFocus ? 'explicit' : 'generated',
    birth: { status: 'unknown', era: '', year: null, month: null, day: null, precision: 'unknown', label: '不详' },
    death: { status: 'alive', era: '', year: null, month: null, day: null, precision: 'unknown', label: '在世' },
    race: '人类', identities: [], professions: ['职业不详'], lifeLevel: '', relationToFocus,
    summary: `${name}的谱系记录。`, profile: { personality: '沉静', lifeExperience: '拥有可供查阅的人生经历。' },
    sourceRefs: [], historyRefs: [],
  };
}

function fixture(): GenealogyResult {
  const nodes = [
    node('aunt', '姑母', -1, '姑母'),
    node('father', '父亲', -1, '父亲'),
    node('mother', '母亲', -1, '母亲'),
    node('uncle', '舅父', -1, '舅父'),
    node('sister', '姐姐', 0, '姐姐'),
    node('focus', '本人', 0, '本人', true),
    node('cousin', '表兄', 0, '表兄'),
  ];
  return {
    schema: 'eyon.genealogy.v2', requestId: 'layout', focusCharacterId: '本人', focusCharacterName: '本人',
    depth: { ancestors: 1, descendants: 0, maxPerGeneration: 7 }, nodes,
    edges: [
      { id: 'father-focus', from: 'father', to: 'focus', relationType: 'parent', label: '父子', sourceRefs: [] },
      { id: 'mother-focus', from: 'mother', to: 'focus', relationType: 'parent', label: '母子', sourceRefs: [] },
      { id: 'father-sister', from: 'father', to: 'sister', relationType: 'parent', label: '父女', sourceRefs: [] },
      { id: 'mother-sister', from: 'mother', to: 'sister', relationType: 'parent', label: '母女', sourceRefs: [] },
      { id: 'father-mother', from: 'father', to: 'mother', relationType: 'spouse', label: '夫妻', sourceRefs: [] },
      { id: 'aunt-focus', from: 'aunt', to: 'focus', relationType: 'uncleAunt', label: '姑侄', sourceRefs: [] },
      { id: 'uncle-focus', from: 'uncle', to: 'focus', relationType: 'uncleAunt', label: '舅甥', sourceRefs: [] },
    ],
    referenceSummary: { familyNames: [], knownResidences: [], knownOrganizations: [], brief: '布局夹具' },
    qualityChecks: {
      focusIsMvuCharacter: true, generatedNodesHaveProvenance: true,
      allNodesHaveLifeDates: true, allNodesHaveBasicProfiles: true,
      onlyMvuNodesCanInjectToRuin: false, noConflictNarrative: true,
    },
  };
}

test('谱系布局按父系—中心—母系排序，并保留分代行', () => {
  const result = fixture();
  const layout = createGenealogyBoardLayout(result);
  const positions = new Map(layout.positions.map(position => [position.node.id, position]));
  assert.ok(positions.get('aunt')!.x < positions.get('father')!.x);
  assert.ok(positions.get('father')!.x < positions.get('mother')!.x);
  assert.ok(positions.get('mother')!.x < positions.get('uncle')!.x);
  assert.ok(positions.get('sister')!.x < positions.get('focus')!.x);
  assert.ok(positions.get('focus')!.x < positions.get('cousin')!.x);
  assert.ok(positions.get('focus')!.y - positions.get('father')!.y >= 190);
  assert.deepEqual(layout.generationLabels.map(item => item.label), ['父母辈', '同辈']);
});

test('共同父母与多个子女合并为一组树枝，不再叠成横贯整行的重复连线', () => {
  const result = fixture();
  const layout = createGenealogyBoardLayout(result);
  const connectors = createGenealogyBoardConnectors(result, layout);
  const family = connectors.find(connector => connector.kind === 'family');
  assert.ok(family);
  assert.deepEqual(new Set(family.edgeIds), new Set([
    'father-focus', 'mother-focus', 'father-sister', 'mother-sister',
  ]));
  assert.equal(connectors.filter(connector => connector.kind === 'family').length, 1);
  assert.equal(connectors.length, 1);
});

test('谱系卡片隐藏年龄推断来源，但不改写原始日期字段', () => {
  const stored = '约复兴纪元461年（按世界书年龄推断）';
  assert.equal(displayGenealogyDateLabel(stored), '约复兴纪元461年');
  assert.equal(stored, '约复兴纪元461年（按世界书年龄推断）');
});

test('多人谱系按家庭分支展开，卡片不重叠且无关家庭不共用横线', () => {
  const result = fixture();
  result.nodes.push(
    node('aunt-partner', '姑父', -1, '姑父'),
    node('paternal-cousin', '堂弟', 0, '堂弟'),
    node('uncle-partner', '舅母', -1, '舅母'),
  );
  result.edges.push(
    { id: 'aunt-paternal-cousin', from: 'aunt', to: 'paternal-cousin', relationType: 'parent', label: '母子', sourceRefs: [] },
    { id: 'aunt-partner-paternal-cousin', from: 'aunt-partner', to: 'paternal-cousin', relationType: 'parent', label: '父子', sourceRefs: [] },
    { id: 'uncle-cousin', from: 'uncle', to: 'cousin', relationType: 'parent', label: '父子', sourceRefs: [] },
    { id: 'uncle-partner-cousin', from: 'uncle-partner', to: 'cousin', relationType: 'parent', label: '母子', sourceRefs: [] },
    { id: 'aunt-spouse', from: 'aunt', to: 'aunt-partner', relationType: 'spouse', label: '夫妻', sourceRefs: [] },
  );

  const layout = createGenealogyBoardLayout(result);
  const connectors = createGenealogyBoardConnectors(result, layout);
  const rows = new Map<number, typeof layout.positions>();
  for (const position of layout.positions) {
    const row = rows.get(position.node.generation) ?? [];
    row.push(position);
    rows.set(position.node.generation, row);
  }
  for (const row of rows.values()) {
    const ordered = [...row].sort((left, right) => left.x - right.x);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.ok(ordered[index]!.x - ordered[index - 1]!.x >= GENEALOGY_NODE_WIDTH + 30);
    }
  }
  assert.equal(connectors.length, 3);
  assert.ok(connectors.every(connector => !connector.edgeIds.includes('aunt-spouse')));
  assert.ok(connectors.some(connector =>
    new Set(connector.parentIds).has('aunt')
    && connector.childIds.includes('paternal-cousin')
    && !connector.childIds.includes('focus'),
  ));
  assert.ok(layout.width > 1120, '多人分支应扩展画布，而不是压缩卡片');
});
