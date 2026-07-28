import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenealogyContextBundle } from '../src/core/context.ts';
import { parseTextCommand } from '../src/core/commands.ts';
import {
  extractGenealogyFocusName,
  TavernGenealogyInputProvider,
} from '../src/runtime/genealogyInput.ts';
import {
  createGenealogyIdentityAssertion,
  GenealogyTransactionGuard,
} from '../src/runtime/genealogyController.ts';
import type {
  RuntimeChatMessage,
  RuntimeContextSourceProvider,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import {
  MemoryGenealogyRepository,
  genealogyRecordKey,
} from '../src/storage/genealogies.ts';
import { parseAndValidateGenealogy } from '../src/validators/genealogy.ts';
import { GenealogyWorkflow } from '../src/workflows/genealogy.ts';
import { fingerprintText } from '../src/runtime/transactionIdentity.ts';
import { WorkbenchLifecycle } from '../src/runtime/workbenchLifecycle.ts';

const namespace = { characterKey: '命定之诗', chatId: '存档一' };
const requestId = 'genealogy-request-1';
const input = {
  focusCharacter: {
    mvuId: '维奥莱塔·马克西姆·奥古斯塔',
    name: '维奥莱塔·马克西姆·奥古斯塔',
    aliases: ['铁血女皇'],
  },
  depth: { ancestors: 4, descendants: 3 },
};

function makeContext(): GenealogyContextBundle {
  const sources = [
    {
      sourceId: 'worldbook:核心:1',
      sourceType: 'worldbook' as const,
      title: '奥古斯塔皇室',
      content: '维奥莱塔继承奥古斯塔皇室。',
      authority: 100,
    },
    {
      sourceId: 'mvu-character:维奥莱塔·马克西姆·奥古斯塔',
      sourceType: 'mvu' as const,
      title: '维奥莱塔·马克西姆·奥古斯塔',
      content: '{"种族":"人类"}',
      authority: 95,
    },
  ];
  return {
    schema: 'eyon.context.v1',
    taskType: 'genealogy',
    requestId,
    scope: { ...namespace, triggerMessageId: 8 },
    currentWorld: { time: '复兴纪元488年', location: '帝都' },
    worldbookContext: [sources[0]],
    recentContext: [],
    characterContext: [sources[1]],
    biographyRefs: [],
    sourceIndex: sources,
    warnings: [],
    sourceHash: 'source-hash',
  };
}

function life(
  status: 'known' | 'unknown' | 'alive' | 'deceased',
  year: number | null,
  label: string,
) {
  return {
    status,
    era: year === null ? '' as const : '复兴纪元' as const,
    year,
    month: null,
    day: null,
    precision: year === null ? 'unknown' as const : 'exact' as const,
    label,
  };
}

function makeResult() {
  return {
    schema: 'eyon.genealogy.v2' as const,
    requestId,
    focusCharacterId: input.focusCharacter.mvuId,
    focusCharacterName: input.focusCharacter.name,
    depth: input.depth,
    nodes: [
      {
        id: 'focus',
        mvuId: input.focusCharacter.mvuId,
        name: input.focusCharacter.name,
        aliases: ['铁血女皇'],
        generation: 0,
        isFocus: true,
        isMvuCharacter: true,
        viewable: true as const,
        canInjectToRuin: true,
        provenance: 'explicit' as const,
        birth: life('known', 464, '复兴纪元464年'),
        death: life('alive', null, '在世'),
        race: '人类',
        identities: ['奥古斯提姆帝国女皇'],
        professions: ['统治者'],
        lifeLevel: '第六层级',
        relationToFocus: '本人',
        summary: '奥古斯提姆帝国现任女皇。',
        sourceRefs: ['mvu-character:维奥莱塔·马克西姆·奥古斯塔'],
        historyRefs: [],
      },
      {
        id: 'father',
        mvuId: '',
        name: '马克西姆三世',
        aliases: [],
        generation: -1,
        isFocus: false,
        isMvuCharacter: false,
        viewable: true as const,
        canInjectToRuin: false,
        provenance: 'inferred' as const,
        birth: life('known', 430, '约复兴纪元430年'),
        death: life('deceased', 479, '复兴纪元479年'),
        race: '人类',
        identities: ['先帝'],
        professions: ['帝国统治者'],
        lifeLevel: '',
        relationToFocus: '父亲',
        summary: '维奥莱塔的父亲与前任皇帝。',
        sourceRefs: ['worldbook:核心:1'],
        historyRefs: [],
      },
    ],
    edges: [{
      id: 'edge-parent',
      from: 'father',
      to: 'focus',
      relationType: 'parent' as const,
      label: '父女',
      sourceRefs: ['worldbook:核心:1'],
    }],
    referenceSummary: {
      familyNames: ['奥古斯塔皇室'],
      knownResidences: ['帝都'],
      knownOrganizations: ['奥古斯提姆帝国'],
      brief: '以维奥莱塔为中心的奥古斯塔皇室谱系。',
    },
    qualityChecks: {
      focusIsMvuCharacter: true,
      generatedNodesHaveProvenance: true,
      allNodesHaveLifeDates: true,
      allNodesHaveBasicProfiles: true,
      onlyMvuNodesCanInjectToRuin: true,
      noConflictNarrative: true,
    },
  };
}

class GenealogyRuntime implements TavernRuntime {
  chatId = namespace.chatId;
  lastMessageId = 8;
  messages = new Map<number, RuntimeChatMessage>([[
    8,
    {
      message_id: 8,
      role: 'user',
      message: '对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系',
      swipe_id: 0,
    },
  ]]);

  getCurrentCharacterName() { return namespace.characterKey; }
  getCurrentChatId() { return this.chatId; }
  getLastMessageId() { return this.lastMessageId; }
  getMessageSwipeId(id: number) { return this.messages.get(id)?.swipe_id ?? null; }
  getChatMessages(range: number | string) {
    if (typeof range === 'number') {
      const message = this.messages.get(range);
      return message ? [structuredClone(message)] : [];
    }
    return [...this.messages.values()].map(message => structuredClone(message));
  }
  async setChatMessages() {}
  setExtensionPrompt() {}
  async generate() { return ''; }
  async generateRaw() { return ''; }
}

test('宗族结果严格锁定MVU中心、代数、来源与连通关系', () => {
  assert.deepEqual(
    parseAndValidateGenealogy(JSON.stringify(makeResult()), {
      requestId,
      input,
      context: makeContext(),
    }),
    makeResult(),
  );

  const invalid = structuredClone(makeResult());
  invalid.nodes[1].canInjectToRuin = true;
  assert.throws(
    () => parseAndValidateGenealogy(JSON.stringify(invalid), {
      requestId,
      input,
      context: makeContext(),
    }),
    /Only MVU genealogy nodes/u,
  );
});

test('宗族生成只落当前聊天仓库，不写MVU、正文或墟境状态', async () => {
  const repository = new MemoryGenealogyRepository();
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  const workflow = new GenealogyWorkflow({
    contextAssembler: { async assemble() { return makeContext(); } },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'genealogy');
        assert.match(prompt, /EYON_GENEALOGY_REQUEST_JSON/u);
        return JSON.stringify(makeResult());
      },
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '宗族契约',
    },
    createRequestId: () => requestId,
    now: () => 1000,
    async assertCurrent() {},
  });
  const record = await workflow.generate(command, input, {
    namespace,
    triggerMessageId: 8,
    triggerTextHash: 'hash',
    triggerSwipeId: 0,
    lifecycleEpoch: 0,
  });
  assert.equal(
    (await repository.get(genealogyRecordKey(namespace, requestId)))?.requestId,
    requestId,
  );
  assert.equal(record.result.nodes.length, 2);
  assert.equal((await repository.list({ ...namespace, chatId: '另一存档' })).length, 0);
});

test('文本入口必须给出当前MVU人物，不能靠模糊关系词猜中心', async () => {
  assert.equal(
    extractGenealogyFocusName('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系'),
    '维奥莱塔·马克西姆·奥古斯塔',
  );
  const sources: RuntimeContextSourceProvider = {
    async getCurrentWorld() { return { time: '', location: '' }; },
    async getWorldbookSources() { return []; },
    async getCharacterSources() {
      return [{
        sourceId: `mvu-character:${input.focusCharacter.mvuId}`,
        title: input.focusCharacter.name,
        content: '{}',
      }];
    },
    async getGenealogySources() { return []; },
    async getBiographySources() { return []; },
    async getButterflySources() { return []; },
  };
  const provider = new TavernGenealogyInputProvider(
    sources,
    { getGenealogyDepth: () => input.depth },
  );
  const command = parseTextCommand('对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系');
  assert.ok(command);
  assert.deepEqual(await provider.getInput(command), {
    ...input,
    focusCharacter: { ...input.focusCharacter, aliases: [] },
  });
  const missing = parseTextCommand('对不存在的人生成宗族谱系');
  assert.ok(missing);
  await assert.rejects(() => provider.getInput(missing), /没有找到人物/u);
});

test('聊天、楼层、swipe或生命周期变化后宗族事务拒绝提交', async () => {
  const mutations: Array<(
    runtime: GenealogyRuntime,
    guard: GenealogyTransactionGuard,
  ) => void> = [
    runtime => { runtime.chatId = '另一存档'; },
    runtime => { runtime.messages.get(8)!.message = '编辑后的命令'; },
    runtime => { runtime.messages.get(8)!.swipe_id = 1; },
    runtime => { runtime.lastMessageId = 9; },
    (_runtime, guard) => { guard.cancelAll(); },
  ];
  for (const mutate of mutations) {
    const runtime = new GenealogyRuntime();
    const guard = new GenealogyTransactionGuard();
    const identity = {
      namespace,
      triggerMessageId: 8,
      triggerTextHash: fingerprintText(runtime.messages.get(8)!.message),
      triggerSwipeId: 0,
      lifecycleEpoch: guard.currentEpoch(),
    };
    mutate(runtime, guard);
    await assert.rejects(
      () => createGenealogyIdentityAssertion(runtime, guard)(identity),
    );
  }
});

test('严格宗族命令只路由宗族工作流，不触发传记或墟境', async () => {
  const runtime = new GenealogyRuntime();
  const calls: string[] = [];
  const lifecycle = new WorkbenchLifecycle({
    runtime,
    biography: {
      async prepareText() {
        calls.push('biography');
        return {};
      },
      async commitRendered() { return null; },
      async cancelPending() {},
    },
    ruin: {
      async generateFromText() {
        calls.push('ruin');
        return {};
      },
      cancelPending() {},
    },
    ruinInputProvider: {
      async getInput() {
        throw new Error('ruin input should not be requested');
      },
    },
    genealogy: {
      async generateFromText(text, receivedInput) {
        calls.push(`genealogy:${text}`);
        assert.deepEqual(receivedInput, input);
        return {};
      },
      cancelPending() {},
    },
    genealogyInputProvider: {
      async getInput(command) {
        calls.push(`input:${command.type}`);
        return input;
      },
    },
  });
  assert.equal(await lifecycle.beforeGeneration('normal'), true);
  assert.deepEqual(calls, [
    'input:genealogy.generate',
    'genealogy:对维奥莱塔·马克西姆·奥古斯塔生成宗族谱系',
  ]);
});
