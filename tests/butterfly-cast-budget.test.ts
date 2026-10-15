import assert from 'node:assert/strict';
import test from 'node:test';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';
import { RuntimeShadowRetrievalObserver, type RuntimeShadowCaptureInput } from '../src/retrieval/runtimeShadow.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import { TavernButterflyContextAssembler } from '../src/runtime/butterflyContext.ts';
import type { RuntimeChatMessage } from '../src/runtime/contracts.ts';
import { buildButterflyApiPrompt } from '../src/prompts/butterfly.ts';

const names = [...'甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥天地玄黄'].map(mark => `潮卫${mark}`);
const books: RuntimeWorldbookSource[] = names.map((name, uid) => ({
  sourceId: `worldbook:cast-budget:${uid}`, title: `[角色][神明]${name}`,
  content: JSON.stringify({ name, type: '神明', era: '神明纪元', identity: '海湾守望者',
    background: `${name}在神明纪元守护海湾。尾部事实：保留完整档案。` }),
  strategyType: 'selective', keywords: [],
  worldbook: { schema: 'eyon.retrieval.worldbook-metadata.v1', logicalId: `worldbook:cast-budget:${uid}`,
    worldbookName: 'cast-budget', uid, bindingScopes: ['character-primary'], enabled: true,
    strategy: { type: 'selective', primaryKeys: [], secondary: { logic: 'and_any', keys: [] }, scanDepth: 'same_as_global' },
    position: null, probability: null, recursion: null, effect: null, extra: {} },
}));

async function engine(sources = books) {
  return new UnifiedShadowRetrievalEngine(await Promise.all(sources.map(source => createSourceSnapshot({
    logicalId: source.sourceId, sourceType: 'worldbook', title: source.title,
    content: source.content, metadata: source.worldbook,
  }))));
}

const required = (disposition: string) => ['required', 'group-required'].includes(disposition);

test('背景提及多人仍可检索，只有实际行动对象成为必需对象，常规来源上限不膨胀', async () => {
  const result = await (await engine()).retrieve({ requestId: 'background-names', taskType: 'butterfly',
    query: `神明纪元，旧史曾提及${names.join('、')}。我护送${names[0]}离开海湾。`,
    castRequirementQuery: `我护送${names[0]}离开海湾。`, mode: 'active' });
  assert.deepEqual(result.bundle.castManifest!.entries.filter(e => required(e.disposition))
    .map(e => e.identity.canonicalName), [names[0]]);
  assert.ok(result.bundle.sourceSnapshots.length <= 16);
  assert.ok(result.bundle.sourceSnapshots.some(s => s.logicalId === books[0].sourceId));
});

test('背景中的所有神明不展开为必需群体，完整背景和明确对象仍保留', async () => {
  const query = `神明纪元，所有神明曾共同守护海湾。现在我护送${names[0]}离开海湾。`;
  const { bundle } = await (await engine()).retrieve({ requestId: 'background-group', taskType: 'butterfly',
    query, castRequirementQuery: `我护送${names[0]}离开海湾。`, mode: 'active' });
  assert.equal(bundle.query, query);
  assert.equal(bundle.castManifest!.groupCoverage.length, 0);
  assert.deepEqual(bundle.castManifest!.entries.filter(e => required(e.disposition))
    .map(e => e.identity.canonicalName), [names[0]]);
});

test('确有17份必需人物来源时按实际需要补齐，不删人物或额外扩张可选来源', async () => {
  for (const count of [16, 17]) {
    const action = `神明纪元，我护送${names.slice(0, count).join('、')}离开海湾。`;
    const { bundle } = await (await engine()).retrieve({ requestId: `actual-${count}`, taskType: 'butterfly',
      query: `${action}\n参考资料：${names.slice(count).join('、')}`, castRequirementQuery: action, mode: 'active' });
    assert.equal(bundle.sourceSnapshots.length, count);
    for (const source of books.slice(0, count)) {
      assert.ok(bundle.sourceSnapshots.some(s => s.logicalId === source.sourceId));
      assert.ok(bundle.passages.some(p => p.content === source.content));
    }
    for (const entry of bundle.castManifest!.entries.filter(e => required(e.disposition))) {
      assert.ok(entry.identity.passageIds.length > 0, entry.identity.canonicalName);
    }
    const warning = bundle.receipt.warnings.find(w => w.startsWith('required-source-budget:'));
    if (count === 17) {
      assert.match(warning ?? '', /default=16; required=17; effective=17/u);
      assert.ok(warning!.includes(names[16]));
    } else assert.equal(warning, undefined);
  }
});

test('实际行动明确要求全体26人时完整展开群体，不在旧24人边界截掉成员', async () => {
  const action = '神明纪元，我将所有神明从海湾灾难中救走。';
  const { bundle } = await (await engine()).retrieve({ requestId: 'actual-group', taskType: 'butterfly',
    query: action, castRequirementQuery: action, mode: 'active' });
  assert.equal(bundle.castManifest!.groupCoverage[0].complete, true);
  assert.equal(bundle.castManifest!.groupCoverage[0].omittedEntityIds.length, 0);
  assert.equal(bundle.castManifest!.groupCoverage[0].selectedEntityIds.length, names.length);
  assert.equal(bundle.sourceSnapshots.length, names.length);
  assert.ok(bundle.castManifest!.entries.filter(e => required(e.disposition)).every(e => e.identity.passageIds.length));
});

test('未提供独立行动文本的旧调用仍完整保留真实必需对象', async () => {
  const { bundle } = await (await engine()).retrieve({ requestId: 'legacy-caller', taskType: 'butterfly',
    query: `神明纪元，我救走${names.slice(0, 17).join('、')}。`, mode: 'active' });
  assert.equal(bundle.sourceSnapshots.length, 17);
  assert.equal(bundle.castManifest!.entries.filter(e => required(e.disposition)).length, 17);
});

test('17份长文跨越旧来源与字符预算时逐字保留全文，不截中段、尾部或证据引用', async () => {
  const longBooks = books.slice(0, 17).map((source, index) => ({ ...source,
    content: `姓名: ${names[index]}\n身份: 海湾守望者\n背景故事: 神明纪元守护海湾。\n`
      + '旧港的船工、旅人与守卫共同见证这段历史。'.repeat(520)
      + `\n独立尾部事实${index}：这句完整保留，不能截断。`,
  }));
  const { bundle } = await (await engine(longBooks)).retrieve({ requestId: 'long-required-fallback',
    taskType: 'butterfly', query: `神明纪元，我救走${names.slice(0, 17).join('、')}。`, mode: 'active' });
  assert.equal(bundle.sourceSnapshots.length, 17);
  assert.ok(bundle.receipt.passageBudget!.usedChars > 48_000);
  for (const source of longBooks) {
    assert.equal(bundle.sourceSnapshots.find(s => s.logicalId === source.sourceId)?.content, source.content);
    assert.equal(bundle.passages.find(p => p.content === source.content)?.content, source.content);
  }
  for (const entry of bundle.castManifest!.entries.filter(e => required(e.disposition))) {
    assert.ok(entry.identity.passageIds.length > 0);
    assert.ok(entry.identity.passageIds.every(id => bundle.passages.some(p => p.passageId === id)));
  }
  assert.ok(!bundle.receipt.rejected.some(r => r.reason === 'passage-budget-exhausted'));
});

test('同样背景而实际行动对象不同，检索回执具有不同身份', async () => {
  const retrieval = await engine();
  const query = `神明纪元，${names[0]}与${names[1]}曾守护海湾。`;
  const receipts = await Promise.all(names.slice(0, 2).map(name => retrieval.retrieve({
    requestId: name, taskType: 'butterfly', query, castRequirementQuery: `我救走${name}。`, mode: 'active',
  })));
  assert.notEqual(receipts[0].bundle.receipt.queryHash, receipts[1].bundle.receipt.queryHash);
});

test('墟境、传记与宗族原有候选预算不因本次遣返修复改变', async () => {
  const retrieval = await engine();
  for (const taskType of ['ruin', 'biography', 'genealogy'] as const) {
    await assert.rejects(retrieval.retrieve({ requestId: taskType, taskType,
      query: `神明纪元，${names.join('、')}共同守护海湾。`, mode: 'active' }), /required cast exceeds source candidate budget/u);
  }
});

async function freezeRound(background: string, draft: string) {
  const namespace = { characterKey: 'cast-budget-fixture', chatId: 'return-round' };
  const messages: RuntimeChatMessage[] = [
    { message_id: 1, role: 'assistant', message: `神明纪元740年，旧史背景：${background}`,
      extra: { eyonHistoryRuinEntryRequest: { ruinHistory: {
        title: '海湾旧史', era: '神明纪元', originalTrajectory: background,
        historicalBackground: background, enteredAnomaly: '海湾门前', locationChain: ['海湾'],
      } } } },
    { message_id: 2, role: 'user', message: `我扶起${names[0]}，带她走到海湾门前。` },
    { message_id: 3, role: 'assistant', message: `${names[0]}扶住门框，${names[1]}替她包扎了伤口。` },
  ];
  let captured!: RuntimeShadowCaptureInput;
  const observer = new RuntimeShadowRetrievalObserver();
  const assembler = new TavernButterflyContextAssembler({
    getCurrentCharacterName: () => namespace.characterKey, getCurrentChatId: () => namespace.chatId,
    getLastMessageId: () => 3, getChatMessages: () => messages,
  } as never, {
    async getWorldbookCorpus() { return { sources: books, receipt: {
      schema: 'eyon.retrieval.worldbook-corpus.v1', complete: true,
      bindings: [{ worldbookName: 'cast-budget', scopes: ['character-primary'] }],
      entries: books.map(source => ({ logicalId: source.sourceId, sourceId: source.sourceId,
        worldbookName: 'cast-budget', uid: source.worldbook.uid, title: source.title,
        bindingScopes: ['character-primary'], enabled: true, status: 'retrievable' })),
      counts: { total: books.length, enabled: books.length, retrievable: books.length,
        disabled: 0, empty: 0, 'user-excluded': 0, 'routed-generated': 0 },
    } }; },
    async getCharacterSources() { return []; }, async getGenealogySources() { return []; },
    async getBiographySources() { return []; }, async getButterflySources() { return []; },
  } as never, {
    async getButterflyFreezeSnapshot() { return { runId: 'budget-round',
      reality: { time: '复兴纪元488年', location: '现世书肆' },
      ruinEntry: { time: '神明纪元740年', location: '海湾' },
      ruinExit: { time: '神明纪元740年', location: '海湾门前' } }; },
  } as never, { async capture(input) { captured = input; return observer.capture(input); } });
  const frozen = await assembler.freeze({ namespace, requestId: 'freeze-budget', userMessageId: 4,
    rawCommand: draft, triggerType: 'button', roll: 1 });
  return { frozen, captured, messages };
}

test('完整冻结区分原历史背景与入场后行动，AI确认的伤者和输入框末次行动不丢失', async () => {
  for (const background of [names.join('、') + '曾守护此地。', '所有神明曾共同守护此地。']) {
    const draft = `我把${names[2]}留下的药包放在门边\n\n遣返`;
    const { frozen, captured, messages } = await freezeRound(background, draft);
    assert.ok(captured.query.includes(background));
    assert.ok(!captured.castRequirementQuery!.includes(background));
    for (const name of names.slice(0, 3)) assert.ok(captured.castRequirementQuery!.includes(name));
    assert.ok(captured.castRequirementQuery!.includes(draft));
    assert.equal(frozen.request.ruinHistory.originalTrajectory, background);
    for (const message of messages) assert.equal(
      frozen.request.sourceIndex.find(s => s.sourceId === `chat:${message.message_id}`)?.content, message.message);
    assert.equal(frozen.request.playerInterventions.find(s => s.sourceId === 'chat:4')?.content, draft);
    const must = frozen.activeEvidence!.castManifest!.filter(e => required(e.disposition));
    assert.deepEqual(new Set(must.map(e => e.canonicalName)), new Set(names.slice(0, 3)));
    const prompt = buildButterflyApiPrompt({ request: frozen.request, activeEvidence: frozen.activeEvidence,
      rules: { sharedContext: '', retrievalContract: '', validationContract: '', generationContract: '' } });
    assert.ok(prompt.includes(background));
    assert.ok(prompt.includes(names[1]));
    assert.ok(prompt.includes('留下的药包放在门边'));
  }
});
