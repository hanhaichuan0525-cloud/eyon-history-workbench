import assert from 'node:assert/strict';
import test from 'node:test';

import type { BiographyContextBundle } from '../src/core/context.ts';
import { parseTextCommand } from '../src/core/commands.ts';
import { buildBiographyShellInstruction } from '../src/prompts/biography.ts';
import type { Biography } from '../src/schemas/biography.ts';
import {
  biographyRecordKey,
  MemoryBiographyRepository,
} from '../src/storage/biographies.ts';
import { parseAndValidateBiography } from '../src/validators/biography.ts';
import { BiographyWorkflow } from '../src/workflows/biography.ts';
import { insertRootTrace } from '../src/workflows/messageAssembly.ts';

const directive = '对维奥莱塔进行寻根溯源,主要方向是她24岁到28岁的猎艳史';
const namespace = {
  characterKey: '命定之诗',
  chatId: '存档-传记测试',
};
const requestId = 'bio-test-001';
const sourceId = 'mvu:维奥莱塔';

function makeBiography(): Biography {
  const stages = Array.from({ length: 5 }, (_, index) => ({
    id: `stage-${index + 1}`,
    type: (index === 2 ? 'transition' : index % 2 === 0 ? 'stable' : 'turbulent') as
      'stable' | 'transition' | 'turbulent',
    title: `第${index + 1}时期`,
    span: `${24 + index}岁`,
    diceMaterial: `骰面${index + 1}`,
    content: `维奥莱塔在第${index + 1}时期留下的独特经历。`,
    transitionFromPrevious: {
      inheritance: index === 0 ? '' : '延续前期选择',
      unresolvedTension: index === 0 ? '' : '关系仍未明朗',
      newPressure: index === 0 ? '' : '帝国责任增加',
      bridge: index === 0 ? '传记由此开始' : '旧关系在新处境中改变了含义',
      transitionEvent: index === 0 ? '' : '一次宫廷会面',
      changedMeaning: index === 0 ? '' : '亲密关系成为政治判断的一部分',
    },
    people: ['维奥莱塔'],
    factions: ['奥古斯提姆帝国'],
    objects: [],
    locations: ['皇宫'],
    sourceRefs: [sourceId],
    biographyUsage: [],
    inference: true,
  }));

  const origin = {
    title: '起源',
    content: '她在二十四岁时第一次主动选择亲密关系。',
    sourceRefs: [sourceId],
    inference: true,
  };
  const status = {
    title: '现状',
    content: '这些经历最终塑造了她看待亲密与权力的方式。',
    sourceRefs: [sourceId],
    inference: true,
  };
  const summary = '这是一段关于欲望、责任与自我判断逐步成形的传记。';
  const rootTrace = [
    '[RootTrace]',
    'Title:: 《维奥莱塔猎艳史》',
    'Target:: 维奥莱塔',
    'Span:: 24岁至28岁',
    `Origin:: ${origin.title} ${origin.content}`,
    'Periods::',
    ...stages.map(stage =>
      `<details class="eybi-stage"><summary>${stage.title}</summary><div>${stage.content}</div></details>`),
    `Status:: ${status.title} ${status.content}`,
    `Summary:: ${summary}`,
    '[/RootTrace]',
  ].join('\n');

  return {
    schema: 'eyon.biography.v1',
    requestId,
    playerDirective: {
      raw: directive,
      interpretedTarget: '维奥莱塔',
      hardTimeScope: '24岁至28岁',
      primaryDirection: '猎艳史',
      secondaryInterests: ['亲密关系', '帝国责任'],
      reconciliation: '以玩家指定方向为主，世界资料用于约束事实。',
    },
    target: {
      type: 'person',
      name: '维奥莱塔',
      aliases: ['铁血女皇'],
      sourceRefs: [sourceId],
    },
    span: {
      mode: 'age',
      start: { year: null, month: null, day: null, age: 24 },
      end: { year: null, month: null, day: null, age: 28 },
      label: '24岁至28岁',
    },
    origin,
    stages,
    status,
    summary,
    indexes: {
      people: ['维奥莱塔'],
      factions: ['奥古斯提姆帝国'],
      objects: [],
      locations: ['皇宫'],
      themes: ['亲密关系', '责任'],
      potentialRuinLinks: ['第一次宫廷会面'],
    },
    rootTrace,
    qualityChecks: {
      playerDirectionFulfilled: true,
      hardTimeScopeRespected: true,
      worldbookConsistent: true,
      stageTransitionsCoherent: true,
      diceIntegratedWithoutHijacking: true,
      existingBiographiesUsedResponsibly: true,
      rootTraceMatchesStructuredData: true,
    },
  };
}

function makeContext(): BiographyContextBundle {
  const source = {
    sourceId,
    sourceType: 'mvu' as const,
    title: '维奥莱塔变量',
    content: '维奥莱塔是奥古斯提姆帝国女皇。',
    authority: 100,
  };
  return {
    schema: 'eyon.context.v1',
    taskType: 'biography',
    requestId,
    scope: {
      ...namespace,
      triggerMessageId: 42,
    },
    currentWorld: {
      time: '复兴纪元488年',
      location: '奥古斯提姆帝国',
    },
    worldbookContext: [],
    recentContext: [],
    characterContext: [source],
    genealogyContext: [],
    biographyRefs: [],
    butterflyRefs: [],
    sourceIndex: [source],
    warnings: [],
    sourceHash: 'fixture-source-hash',
  };
}

test('传记结果只接受单个严格 JSON，并核对来源与 RootTrace', () => {
  const biography = makeBiography();
  const context = makeContext();
  assert.deepEqual(
    parseAndValidateBiography(JSON.stringify(biography), { requestId, directive, context }),
    biography,
  );
  assert.deepEqual(
    parseAndValidateBiography(
      `\`\`\`json\n${JSON.stringify(biography)}\n\`\`\``,
      { requestId, directive, context },
    ),
    biography,
  );

  const wrongSource = structuredClone(biography);
  wrongSource.origin.sourceRefs = ['worldbook:不存在'];
  assert.throws(
    () => parseAndValidateBiography(
      JSON.stringify(wrongSource),
      { requestId, directive, context },
    ),
    /Unknown source reference/u,
  );
});

test('传记插槽替换不改写正文模型自然生成的伊雍对话', () => {
  const biography = makeBiography();
  const slot = '[EYON_ROOTTRACE_SLOT::bio-test-001]';
  const dialogue = [
    '<eyon name="伊雍" mood="bright">「让我替你翻开这段旧史。」</eyon>',
    '<eyon_court/>',
  ].join('\n');
  const assembled = insertRootTrace(`${dialogue}\n${slot}`, slot, biography.rootTrace);

  assert.match(assembled.content, /让我替你翻开这段旧史/u);
  assert.equal(assembled.content.includes(slot), false);
  assert.equal(assembled.content.split('[RootTrace]').length - 1, 1);
  assert.equal(assembled.warning, 'none');
});

test('正文协作提示只要求自然开场和插槽，不向脚本索取固定台词', () => {
  const biography = makeBiography();
  const instruction = buildBiographyShellInstruction(
    biography,
    '[EYON_ROOTTRACE_SLOT::bio-test-001]',
  );
  assert.match(instruction, /生成伊雍对此次传记的简短开场/u);
  assert.match(instruction, /禁止自行生成、复述、概括、改写或评论传记正文/u);
  assert.doesNotMatch(instruction, /必须说/u);
});

test('寻根溯源事务校验后落库，再注入同一条正文消息', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  let assistantMessage = '';
  let generatedPrompt = '';
  const command = parseTextCommand(directive);
  assert.ok(command);

  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate(taskType, prompt) {
        assert.equal(taskType, 'biography');
        generatedPrompt = prompt;
        return JSON.stringify(biography);
      },
    },
    shell: {
      async generateShell({ slot }) {
        assistantMessage = [
          '<eyon name="伊雍" mood="bright">「旧纸页上的墨迹已经醒来。」</eyon>',
          '<eyon_court/>',
          slot,
        ].join('\n');
        return { messageId: 77 };
      },
      async readAssistantMessage() {
        return assistantMessage;
      },
      async writeAssistantMessage(_messageId, content) {
        assistantMessage = content;
      },
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '共享上下文',
      retrievalContract: '检索契约',
      validationContract: '校验契约',
      generationContract: '传记生成契约',
    },
    async getScope() {
      return {
        namespace,
        triggerMessageId: 42,
      };
    },
    createRequestId() {
      return requestId;
    },
    now() {
      return 1000;
    },
  });

  const result = await workflow.run(command);
  const record = await repository.get(
    biographyRecordKey(namespace, result.biographyId),
  );
  assert.equal(record?.status, 'committed');
  assert.equal(record?.assistantMessageId, 77);
  assert.match(generatedPrompt, /"taskType":"biography"/u);
  assert.match(assistantMessage, /旧纸页上的墨迹已经醒来/u);
  assert.match(assistantMessage, /\[RootTrace\]/u);
});

test('生成期间切换聊天时停止事务，不写入任何存档', async () => {
  const biography = makeBiography();
  const context = makeContext();
  const repository = new MemoryBiographyRepository();
  const command = parseTextCommand(directive);
  assert.ok(command);
  let scopeReadCount = 0;
  let shellCalled = false;

  const workflow = new BiographyWorkflow({
    contextAssembler: {
      async assemble() {
        return context;
      },
    },
    generator: {
      async generate() {
        return JSON.stringify(biography);
      },
    },
    shell: {
      async generateShell() {
        shellCalled = true;
        return { messageId: 1 };
      },
      async readAssistantMessage() {
        return '';
      },
      async writeAssistantMessage() {},
      async refreshAssistantMessage() {},
    },
    repository,
    rules: {
      sharedContext: '',
      retrievalContract: '',
      validationContract: '',
      generationContract: '',
    },
    async getScope() {
      scopeReadCount += 1;
      return {
        namespace: scopeReadCount === 1
          ? namespace
          : { ...namespace, chatId: '另一个存档' },
        triggerMessageId: 42,
      };
    },
    createRequestId() {
      return requestId;
    },
    now() {
      return 1000;
    },
  });

  await assert.rejects(() => workflow.run(command), /Chat changed/u);
  assert.equal(shellCalled, false);
  assert.deepEqual(await repository.list(namespace), []);
});
