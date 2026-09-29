import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGenealogyLocalView, unknownDate } from '../src/core/genealogyLocalView.ts';
import { genealogySources, genealogyNodeToRuinReference, projectGenealogyRuinReferences } from '../src/runtime/genealogySources.ts';
import { currentGenealogyHistoryReferences, historyReferencesForPerson } from '../src/runtime/genealogyContinuity.ts';
import { inspectArtifactCanonConsumption } from '../src/runtime/artifactCanonDiagnostics.ts';
import type { ArtifactCanonBinding, CanonBranch, CanonFact, InterventionDelta } from '../src/retrieval/contracts.ts';
import type { GenealogyRecord } from '../src/storage/genealogies.ts';
import type { GenealogyNode } from '../src/schemas/genealogy.ts';
import type { BiographyRecord } from '../src/storage/biographies.ts';
import { MemoryBiographyRepository } from '../src/storage/biographies.ts';
import { MemoryCanonRepository } from '../src/storage/canon.ts';
import { TavernGenealogyContextAssembler } from '../src/runtime/genealogyContext.ts';
import { RuntimeShadowRetrievalObserver } from '../src/retrieval/runtimeShadow.ts';
import type { TavernRuntime, RuntimeContextSourceProvider } from '../src/runtime/contracts.ts';
import { buildGenealogyApiPrompt } from '../src/prompts/genealogy.ts';

const namespace = { characterKey: '伊雍', chatId: '谱系测试' };
const branchId = 'branch:family';
const fatherBirth = fact('father-birth', 'father', 'birth_time', '复兴纪元450年');
const childBirth = fact('child-birth', 'child', 'birth_time', '复兴纪元480年');
const siblingBirth = fact('sibling-birth', 'sibling', 'birth_time', '复兴纪元479年');
const spouseBirth = fact('spouse-birth', 'spouse', 'birth_time', '复兴纪元452年');
const fatherDeath = fact('father-death', 'father', 'death_time', '复兴纪元490年');
const parentFact = fact('parent', 'child', 'father', '父亲');
const siblingFact = fact('sibling', 'child', 'sister', '妹妹');
const spouseFact = { ...fact('spouse', 'father', 'spouse', '配偶'), temporalScope: '复兴纪元483年' };

function fact(id: string, subject: string, predicate: string, object: string): CanonFact {
  return { factId: id, subjectEntityId: `entity:${subject}`, predicate, object, statement: object,
    temporalScope: null, spatialScope: null, epistemicStatus: 'explicit', confidence: 'high',
    sourceRefs: ['worldbook:family'], sourceSnapshotIds: [], sourceSpans: [], revisionIntroduced: 0, revisionRetired: null };
}
function binding(type: 'node' | 'edge', id: string, factIds: string[], entityIds: string[]): ArtifactCanonBinding {
  return { schema: 'eyon.canon.artifact-binding.v1', bindingId: `binding:${type}:${id}`, branchId,
    artifactType: 'genealogy', artifactId: 'tree', unitType: type, unitId: id,
    boundView: { viewId: 'view:base', resolvedRevision: 0, queryScopeHash: 'scope' }, factIds, entityIds,
    operationRefs: [], sourceRefs: ['worldbook:family'], createdAt: 1 };
}
function node(id: string, name: string, generation: number, birth: number): GenealogyNode {
  return { id, name, mvuId: id === 'child' ? id : '', aliases: [], generation, isFocus: id === 'child', isMvuCharacter: id === 'child',
    viewable: true, canInjectToRuin: id === 'child', provenance: 'explicit',
    birth: { ...unknownDate(), status: 'known', era: '复兴纪元', year: birth, precision: 'exact', label: `复兴纪元${birth}年` },
    death: unknownDate(), race: '人类', identities: ['既有人物'], professions: ['史官'], lifeLevel: '', relationToFocus: '原关系',
    summary: `${name}的旧关系摘要`, profile: { personality: '严谨', lifeExperience: `${name}的旧关系短传` }, sourceRefs: ['worldbook:family'], historyRefs: [] };
}
function record(): GenealogyRecord {
  const nodes = [node('child', '子女甲', 0, 480), node('father', '父亲', -1, 450), node('sibling', '妹妹', 0, 479), node('spouse', '配偶', -1, 452)];
  const edges: GenealogyRecord['result']['edges'] = [
    { id: 'parent', from: 'father', to: 'child', relationType: 'parent', label: '父子', sourceRefs: ['worldbook:family'] },
    { id: 'sibling', from: 'child', to: 'sibling', relationType: 'sibling', label: '兄妹', sourceRefs: ['worldbook:family'] },
    { id: 'spouse', from: 'father', to: 'spouse', relationType: 'spouse', label: '婚姻', sourceRefs: ['worldbook:family'] },
  ];
  const depth = { ancestors: 2, descendants: 2, maxPerGeneration: 4 };
  return { key: 'tree', namespace, requestId: 'tree', triggerMessageId: 1, triggerTextHash: 'hash', triggerSwipeId: null, sourceHash: 'source',
    input: { focusCharacter: { mvuId: 'child', name: '子女甲', aliases: [] }, depth },
    result: { schema: 'eyon.genealogy.v2', requestId: 'tree', focusCharacterId: 'child', focusCharacterName: '子女甲', depth, nodes, edges,
      referenceSummary: { familyNames: [], knownResidences: [], knownOrganizations: [], brief: '不可直接复用的旧总摘要' },
      qualityChecks: { focusIsMvuCharacter: true, generatedNodesHaveProvenance: true, allNodesHaveLifeDates: true,
        allNodesHaveBasicProfiles: true, onlyMvuNodesCanInjectToRuin: true, noConflictNarrative: true } },
    canonBindings: [
      binding('node', 'father', [fatherBirth.factId, fatherDeath.factId], ['entity:father']),
      binding('node', 'child', [childBirth.factId], ['entity:child']),
      binding('node', 'sibling', [siblingBirth.factId], ['entity:sibling']),
      binding('node', 'spouse', [spouseBirth.factId], ['entity:spouse']),
      ...edges.map(edge => binding('edge', edge.id, [edge.id], [`entity:${edge.from}`, `entity:${edge.to}`])),
    ],
    localEvidence: { nodes: nodes.map(n => ({ nodeId: n.id, entityId: `entity:${n.id}` })), facts: structuredClone([fatherBirth, childBirth, siblingBirth, spouseBirth, fatherDeath, parentFact, siblingFact, spouseFact]) }, createdAt: 1 };
}
function delta(original: CanonFact, current: CanonFact): InterventionDelta {
  return { schema: 'eyon.canon.intervention-delta.v1', deltaId: 'delta:one', branchId, revision: 1, parentRevision: 0,
    actionRef: 'action:one', effectiveFrom: { label: '复兴纪元470年' },
    operations: [{ op: 'replace', factKey: `${original.subjectEntityId}|${original.predicate}`, originalFactIds: [original.factId], current: { ...current, revisionIntroduced: 1 } }],
    preconditionFactIds: [], dependsOnDeltaIds: [], cascadeScope: { entityIds: [original.subjectEntityId], locations: [] }, preserves: [], supersedesDeltaIds: [], status: 'active', verified: true, createdAt: 2 };
}
function branch(change?: InterventionDelta, rolledBack = false): CanonBranch {
  return { schema: 'eyon.canon.branch.v1', ...namespace, branchId, headRevision: change && !rolledBack ? 1 : 0,
    revisions: change ? [{ revision: 1, parentRevision: 0, actionId: change.actionRef, deltaId: change.deltaId, assistantMessageId: 3,
      status: rolledBack ? 'reverted' : 'active', receiptId: 'receipt', createdAt: 2 }] : [],
    actions: [], deltas: change ? [{ ...change, status: rolledBack ? 'reverted' : 'active' }] : [], receipts: [], createdAt: 1, updatedAt: 2 };
}
const earlyDeath = () => delta(fatherDeath, fact('early-death', 'father', 'death_time', '复兴纪元470年'));

test('GB-01 关系变更只停用对应边，不修改原图、无关兄妹或其侧写', () => {
  const tree = record(), before = structuredClone(tree);
  const view = buildGenealogyLocalView(tree, branch(delta(parentFact, fact('new-parent', 'child', 'father', '另一人'))));
  assert.equal(view.edges.some(edge => edge.id === 'parent'), false);
  assert.equal(view.edges.some(edge => edge.id === 'sibling'), true);
  assert.equal(view.units.find(unit => unit.unitId === 'sibling' && unit.unitType === 'node')?.status, 'current');
  assert.equal(view.nodes.find(n => n.id === 'sibling')?.profile.lifeExperience, '妹妹的旧关系短传');
  assert.doesNotMatch(JSON.stringify(view.nodes.find(n => n.id === 'father')), /父亲的旧关系短传/);
  assert.deepEqual(tree, before);
});

test('GB-02 提前死亡后受孕时间不明只标待核实，保留后代和无关亲缘', () => {
  const view = buildGenealogyLocalView(record(), branch(earlyDeath()));
  assert.equal(view.units.find(unit => unit.unitType === 'edge' && unit.unitId === 'parent')?.status, 'uncertain');
  assert.ok(view.nodes.some(n => n.id === 'child'));
  assert.ok(view.edges.some(e => e.id === 'sibling'));
  assert.equal(view.nodes.find(n => n.id === 'father')?.death.year, 470);
  assert.doesNotMatch(JSON.stringify(view), /替代父亲/);
});

test('GB-03 晚于新死亡年的明确婚姻退出，更早出生亲缘及原有死亡不误伤', () => {
  const tree = record();
  const baseline = buildGenealogyLocalView(tree, branch());
  assert.equal(baseline.edges.length, 3);
  const newDeath = delta(fatherDeath, fact('early-death', 'father', 'death_time', '复兴纪元481年'));
  const view = buildGenealogyLocalView(tree, branch(newDeath));
  assert.ok(view.edges.some(e => e.id === 'parent'));
  assert.equal(view.edges.some(e => e.id === 'spouse'), false);
  assert.equal(view.units.find(u => u.unitType === 'edge' && u.unitId === 'spouse')?.status, 'stale');
  tree.localEvidence!.facts.find(f => f.factId === 'spouse')!.temporalScope = null;
  assert.equal(buildGenealogyLocalView(tree, branch(newDeath)).units.find(u => u.unitType === 'edge' && u.unitId === 'spouse')?.status, 'uncertain');
});

test('GB-04 回滚恢复局部关系与显式墟境摘要，既有选择不被物理删除', () => {
  const tree = record();
  const initial = buildGenealogyLocalView(tree, branch());
  const selections = [genealogyNodeToRuinReference(tree, 'father', initial)!];
  const saved = structuredClone(selections);
  const changed = projectGenealogyRuinReferences(selections, [tree], branch(earlyDeath()));
  assert.equal(changed[0].relations.length, 0);
  assert.doesNotMatch(changed[0].contextSummary, /旧关系短传/);
  const restored = projectGenealogyRuinReferences(selections, [tree], branch(earlyDeath(), true));
  assert.deepEqual(restored, saved);
  assert.deepEqual(selections, saved);
});

test('GB-05 新的未绑定记录不遮盖旧有效关系，跨树同名不等于同实体', () => {
  const tree = record(), newer = structuredClone(tree);
  newer.requestId = 'new-tree'; newer.createdAt = 3; delete newer.canonBindings;
  const sources = genealogySources([tree, newer], branch());
  const old = JSON.parse(sources.find(s => s.sourceId === 'genealogy:tree')!.content);
  assert.equal(old.edges.length, 3);
  const other = structuredClone(tree); other.requestId = 'other'; other.createdAt = 2;
  other.localEvidence!.nodes.forEach(n => n.entityId = `another:${n.nodeId}`);
  const distinct = genealogySources([tree, other], branch());
  assert.ok(distinct.some(s => s.sourceId === 'genealogy:tree:child'));
  assert.ok(distinct.some(s => s.sourceId === 'genealogy:other:child'));
});

test('GB-06 旧无绑定档案保留只读辨识；跨聊天、分支、未来版本不外流', () => {
  const tree = record(); delete tree.canonBindings; delete tree.localEvidence;
  const view = buildGenealogyLocalView(tree, branch());
  assert.equal(view.nodes.length, 4); assert.equal(view.edges.length, 0);
  assert.equal(view.units[0].status, 'unbound');
  assert.equal(genealogySources([record()], { ...branch(), chatId: 'other' }).length, 0);
  assert.equal(genealogySources([record()], { ...branch(), branchId: 'other' }).length, 0);
  const future = record(); future.canonBindings!.forEach(b => b.boundView.resolvedRevision = 1);
  assert.equal(genealogySources([future], branch()).length, 0);
});

test('GB-09 非 MVU 亲属可作为安全参考，源出口与显式出口采用同一关系判断', () => {
  const tree = record(), current = branch(earlyDeath());
  const ref = genealogyNodeToRuinReference(tree, 'father', buildGenealogyLocalView(tree, current))!;
  assert.equal(ref.name, '父亲'); assert.equal(ref.source, 'genealogy');
  const sources = genealogySources([tree], current);
  assert.doesNotMatch(sources.map(s => s.content).join('\n'), /不可直接复用的旧总摘要|父亲的旧关系短传/);
  const whole = JSON.parse(sources.find(s => s.sourceId === 'genealogy:tree')!.content);
  assert.deepEqual(whole.edges.map((e: { id: string }) => e.id), ['sibling']);
  assert.equal(ref.relations.length, 0);
});

function biography(): BiographyRecord {
  const producer = { ...binding('node', 'stage', [], ['entity:child']), bindingId: 'bio-binding', artifactType: 'biography' as const, artifactId: 'bio', unitType: 'stage', unitId: 'stage' };
  return { key: 'bio', namespace, status: 'committed', biographyId: 'bio', requestId: 'bio-request', triggerMessageId: 1, assistantMessageId: 2,
    sourceHash: 'fixture', revision: 1, biography: {} as BiographyRecord['biography'], createdAt: 1, updatedAt: 1,
    canonBindings: [producer], continuityAnchors: [{
    schema: 'eyon.continuity.anchor.v1', anchorId: 'anchor', branchId, canonRevision: 0,
    producer: { artifactType: 'biography', artifactId: 'bio', unitId: 'stage', bindingId: 'bio-binding' },
    eventId: 'invented:gift', claimSource: 'final-prose', claim: '复兴纪元485年，子女甲只获赠一次《旧书》。',
    temporalScope: { label: '复兴纪元485年' }, participants: [{ name: '子女甲', entityId: 'entity:child' }], locations: [], objects: [{ name: '《旧书》' }], sourceRefs: [], stance: 'hypothesis', createdAt: 1,
  }] };
}

test('GB-10 historyRefs 只链接同版已提交且绑定有效的传记，删除/变版/跨聊天即退出', () => {
  const bio = biography(), b = branch();
  const refs = currentGenealogyHistoryReferences([bio], b);
  assert.equal(refs.length, 1);
  assert.equal(historyReferencesForPerson(refs, '同名', 'entity:child').length, 1);
  assert.equal(historyReferencesForPerson(refs, '子女甲', 'different-entity').length, 0);
  const tree = record(); tree.result.nodes[0].historyRefs = [{ biographyId: 'bio', stageId: 'stage' }, { biographyId: 'fake', stageId: 'invented' }];
  assert.match(JSON.stringify(genealogySources([tree], b, refs)), /只获赠一次/);
  assert.doesNotMatch(JSON.stringify(genealogySources([tree], b, [])), /只获赠一次|fake/);
  assert.deepEqual(currentGenealogyHistoryReferences([bio], { ...b, headRevision: 1 }), []);
  assert.deepEqual(currentGenealogyHistoryReferences([{ ...bio, status: 'validated' }], b), []);
  assert.deepEqual(currentGenealogyHistoryReferences([{ ...bio, namespace: { ...namespace, chatId: 'other' } }], b), []);
});

test('GB-11 诊断包含 node/edge 与原因，但只读不修改原始记录', () => {
  const tree = record(), before = structuredClone(tree);
  const report = inspectArtifactCanonConsumption({ biographies: [], genealogies: [tree], ruins: [], butterflies: [], branch: branch(earlyDeath()) });
  assert.ok(report.genealogyViews?.[0].units.some(u => u.reasonCodes.includes('relationship-after-death')));
  assert.deepEqual(tree, before);
});

test('GB-03 出生推迟到子女出生之后仅停用该亲子关系，不误删兄妹', () => {
  const view = buildGenealogyLocalView(record(), branch(delta(fatherBirth, fact('late-birth', 'father', 'birth_time', '复兴纪元481年'))));
  assert.ok(view.units.find(unit => unit.unitId === 'parent' && unit.unitType === 'edge')?.reasonCodes.includes('parent-born-after-child'));
  assert.equal(view.nodes.length, 4);
  assert.ok(view.edges.some(edge => edge.id === 'sibling'));
});

test('GB-10 来源传记退出后不会通过节点旧短传偷偷保留其经历', () => {
  const tree = record();
  tree.result.nodes[0].historyRefs = [{ biographyId: 'bio', stageId: 'stage' }];
  tree.result.nodes[0].profile.lifeExperience = '在某年获赠神秘书册的旧结论';
  assert.doesNotMatch(JSON.stringify(genealogySources([tree], branch(), [])), /神秘书册/);
  assert.doesNotMatch(JSON.stringify(projectGenealogyRuinReferences([genealogyNodeToRuinReference(tree, 'child', buildGenealogyLocalView(tree, branch()))!], [tree], branch())), /神秘书册/);
  assert.match(tree.result.nodes[0].profile.lifeExperience, /神秘书册/);
});

test('GB-10 集成：同版成稿附注经过共享上下文进入谱系提示词；来源删除后退出', async () => {
  const biographies = new MemoryBiographyRepository();
  const bio = biography();
  await biographies.saveValidated(bio);
  const canon = new MemoryCanonRepository(); canon.getBranch = async () => branch();
  const runtime: TavernRuntime = {
    getCurrentCharacterName: () => namespace.characterKey, getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 3, getMessageSwipeId: () => 0, getChatMessages: () => [],
    async setChatMessages() {}, setExtensionPrompt() {},
    async generate() { throw new Error('不得调用宿主生成'); }, async generateRaw() { throw new Error('不得调用宿主生成'); },
  };
  const sources: RuntimeContextSourceProvider = {
    async getCurrentWorld() { return { time: '复兴纪元488年', location: '书店' }; },
    async getWorldbookSources() { return []; },
    async getCharacterSources() { return [{ sourceId: 'mvu-character:child', title: '子女甲', content: '姓名：子女甲\n种族：人类' }]; },
    async getGenealogySources() { return []; }, async getBiographySources() { return []; }, async getButterflySources() { return []; },
  };
  const assembler = new TavernGenealogyContextAssembler(runtime, sources, new RuntimeShadowRetrievalObserver(), undefined, canon, biographies);
  const scope = { requestId: 'test', namespace, triggerMessageId: 3, directive: '子女甲与赠书的谱系' };
  const context = await assembler.assemble(scope);
  const prompt = buildGenealogyApiPrompt({ requestId: 'test', directive: scope.directive, generationInput: record().input, context, rules: { generationContract: '测试合同' } });
  assert.match(prompt, /只获赠一次《旧书》/);
  assert.equal(context.historyReferenceCandidates?.length, 1);
  await biographies.delete(bio.key);
  const after = await assembler.assemble(scope);
  assert.equal(after.historyReferenceCandidates?.length, 0);
  assert.doesNotMatch(JSON.stringify(after.continuityView), /只获赠一次/);
});
