import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerationAdapter, HostAdapter, UserTurnAdapter } from '../src/adapters/host.ts';
import { buildRuinTaskPrompt } from '../src/prompts/ruinTask.ts';
import { resolveRuinTaskEconomy } from '../src/core/ruinTaskEconomy.ts';
import {
  materializeRuinTask,
  parseRuinTaskDraft,
} from '../src/schemas/ruinTask.ts';
import type {
  RuntimeChatMessage,
  RuntimeContextSourceProvider,
  TavernRuntime,
} from '../src/runtime/contracts.ts';
import type { RuntimeWorldbookSource } from '../src/retrieval/contracts.ts';
import {
  isTerminalRuinTaskStatus,
  readRuinTasks,
} from '../src/runtime/tavernHost.ts';
import { TavernRuinTaskShellAdapter } from '../src/runtime/tavernRuinTaskShell.ts';
import {
  buildRuinTaskPanel,
  buildRuinTaskTerminalPanel,
  buildRuinTaskContract,
  ruinTaskSlot,
  RuinTaskWorkflow,
} from '../src/workflows/ruinTask.ts';

const draftJson = JSON.stringify({
  schema: 'eyon.ruin-task.v1',
  task: {
    title: '追回焚毁前的账册',
    mode: '个人',
    status: '进行中',
    attention: '高',
    progress: '已经锁定账册最后出现的库门。',
    detail: '原页正被转移，贸然强夺会惊动封锁栈桥的巡检。',
    objective: '查明持卷者；取得至少一页可核验原文；在焚毁前带离库房。',
    difficulty: 'B',
    currencyReward: '40枚外港通货',
    itemReward: '旧水门验印',
  },
});

test('墟境任务草案确定性映射到既有任务列表 schema 与 FP 档位', () => {
  const record = materializeRuinTask(parseRuinTaskDraft(draftJson), '90000Z 帝冕币');
  assert.equal(record.name, '[墟境任务·个人]追回焚毁前的账册');
  assert.deepEqual(record.value, {
    状态: '进行中',
    关注度: '高',
    进展: '已经锁定账册最后出现的库门。',
    详情: 'B级。原页正被转移，贸然强夺会惊动封锁栈桥的巡检。',
    目标: '查明持卷者；取得至少一页可核验原文；在焚毁前带离库房。',
    奖励: '900 FP；90000Z 帝冕币；旧水门验印',
  });
});

test('墟境任务奖励拒绝旧G/EXP结构与通用G占位', () => {
  const legacy = JSON.parse(draftJson) as Record<string, any>;
  delete legacy.task.currencyReward;
  delete legacy.task.itemReward;
  legacy.task.itemRewards = ['旧水门验印'];
  legacy.task.g = 40;
  legacy.task.exp = 120;
  assert.throws(() => parseRuinTaskDraft(JSON.stringify(legacy)), /不符合契约/u);

  const genericCurrency = JSON.parse(draftJson) as Record<string, any>;
  genericCurrency.task.currencyReward = '40G';
  assert.throws(() => parseRuinTaskDraft(JSON.stringify(genericCurrency)), /通用G占位/u);
});

test('MVU 任务快照只识别墟境任务，未完成锁定而终态允许下一项', () => {
  const tasks = readRuinTasks({
    任务列表: {
      '[墟境任务·个人]潮痕': {
        状态: '进行中', 关注度: '中', 进展: '一处', 详情: 'D级', 目标: '找两处', 奖励: '100 FP',
      },
      '[墟境任务·团队]旧案': {
        状态: '可结算', 关注度: '低', 进展: '完成', 详情: 'C级', 目标: '核验', 奖励: '300 FP',
      },
      '[普通任务·个人]买面包': { 状态: '进行中' },
    },
  });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].terminal, false);
  assert.equal(tasks[1].terminal, true);
  assert.equal(isTerminalRuinTaskStatus('未完成'), false);
  assert.equal(isTerminalRuinTaskStatus('已完成'), true);
  assert.equal(isTerminalRuinTaskStatus('失败'), true);
});

test('任务货币与金额每次从当前世界书指南解析', () => {
  const sources = economySources('圣羽币');
  const instant = resolveRuinTaskEconomy({
    sources,
    location: '翼民圣国梵尼亚/神迹群山/圣纹工坊',
    mode: '个人',
    difficulty: 'D',
    scale: '即时互动',
  });
  assert.equal(instant.reward, '425Z 圣羽币');
  const changed = resolveRuinTaskEconomy({
    sources: economySources('羽冠币'),
    location: '梵尼亚/神迹群山/圣纹工坊',
    mode: '个人',
    difficulty: 'D',
    scale: '即时互动',
  });
  assert.equal(changed.reward, '425Z 羽冠币', '世界书改名后不使用旧币名缓存');
});

test('任务货币不唯一时明确拒绝，不回退到当地通货', () => {
  assert.throws(() => resolveRuinTaskEconomy({
    sources: economySources('圣羽币'),
    location: '无归属的无名地窖',
    mode: '个人',
    difficulty: 'D',
    scale: '短程目标',
  }), /唯一确定实体货币/u);
});

test('无归属海域使用世界书明确的通用价值单位，不将Z伪装成实体币', () => {
  const sources = economySources('圣羽币');
  sources[0].content = sources[0].content.replace('货币体系:', '货币体系:\n  单位: Z — 全大陆通用抽象计价单位（非实体货币）');
  const input = { sources, location: '无尽海东部海域-碎星群岛外缘-虚海乱流漩涡区-捕雾船甲板', mode: '个人' as const, difficulty: 'D' as const, scale: '即时互动' as const };
  const fallback = resolveRuinTaskEconomy(input);
  assert.equal(fallback.reward, '425Z（通用价值结算）');
  assert.equal(fallback.guideSourceId, sources[0].sourceId);
  assert.equal(resolveRuinTaskEconomy({ ...input, location: '梵尼亚/圣纹工坊' }).reward, '425Z 圣羽币');
  const record = materializeRuinTask(parseRuinTaskDraft(draftJson), fallback.reward);
  assert.match(buildRuinTaskPanel(record), /425Z（通用价值结算）/u);
  assert.match(buildRuinTaskContract(record, '追回账册', 'run-1', 'request-fallback'), /425Z（通用价值结算）/u);
});

test('明确通用实体币实时跟随世界书改名，地域歧义也可兜底', () => {
  for (const name of ['星海币', '潮汐币']) {
    const sources = economySources('圣羽币');
    sources[0].content = sources[0].content.replace('货币体系:', `货币体系:\n  通用实体货币: ${name}`);
    const result = resolveRuinTaskEconomy({ sources, location: '未知海域', mode: '个人', difficulty: 'D', scale: '短程目标' });
    assert.equal(result.reward, `550Z ${name}`);
  }
});

test('关闭的经济条目与地点条目不参与奖励解析', () => {
  const sources = economySources('圣羽币');
  sources[0].worldbook.enabled = false;
  assert.throws(() => resolveRuinTaskEconomy({ sources, location: '梵尼亚', mode: '个人', difficulty: 'D', scale: '即时互动' }), /缺少可解析/u);
  sources[0].worldbook.enabled = true;
  sources.push(worldbookSource('无名码头', '无名码头坐落于翼民圣国梵尼亚。'));
  sources[2].worldbook.enabled = false;
  assert.throws(() => resolveRuinTaskEconomy({ sources, location: '无名码头', mode: '个人', difficulty: 'D', scale: '即时互动' }), /唯一确定实体货币/u);
});

test('任务编译提示与正文契约不把 API 结构冒充正文，并精确锁定一个 MVU 路径', () => {
  const record = materializeRuinTask(parseRuinTaskDraft(draftJson), '90000Z 帝冕币');
  const prompt = buildRuinTaskPrompt({
    direction: '追回账册',
    runId: 'run-1',
    ruinTime: '复兴纪元480年9月',
    ruinLocation: '帝国/外港/旧库房',
    entryHistory: { title: '暮潮移交' },
    recentNarrative: [{ role: 'assistant', text: '库门外传来脚步。' }],
    interpretation: '原意锁定',
    scale: '即时互动',
  });
  assert.match(prompt, /eyon\.ruin-task\.v1/u);
  assert.match(prompt, /不得输出正文、任务面板、变量更新/u);
  assert.match(prompt, /实时计算的实体货币/u);
  assert.match(prompt, /不得输出货币、G或EXP/u);
  assert.doesNotMatch(prompt, /currencyReward|少量当地通货/u);
  const contract = buildRuinTaskContract(record, '追回账册', 'run-1', 'request-1');
  assert.match(contract, /\[EYON_RUINTASK_SLOT::request-1\]/u);
  assert.doesNotMatch(contract, /eyon-ruin-quest/u);
  const panel = buildRuinTaskPanel(record);
  assert.match(panel, /<task_info>/u);
  assert.match(panel, /eyon-ruin-quest/u);
  assert.match(panel, /委托人 · 伊雍/u);
  assert.match(panel, /90000Z 帝冕币/u);
  assert.doesNotMatch(panel, /任务名称::|状态::|关注度::/u);
  assert.match(contract, /\/任务列表\/\[墟境任务·个人\]追回焚毁前的账册/u);
  assert.doesNotMatch(contract, /"schema":"eyon\.ruin-task\.v1"/u);
});

test('已有未结束墟境任务时在 API 调用前拒绝建立第二项', async () => {
  let generated = false;
  const host = mockHost([{ name: '[墟境任务·个人]旧任务', mode: '个人', status: '进行中', attention: '高', progress: '', detail: '', objective: '', reward: '', terminal: false }]);
  const workflow = new RuinTaskWorkflow({
    host,
    generator: { async generate() { generated = true; return draftJson; } },
    userTurns: { async sendUserTurn() { throw new Error('should not send'); } },
    runtime: mockRuntime([]),
    sources: mockSources(),
    shell: new TavernRuinTaskShellAdapter(mockRuntime([])),
  });
  await assert.rejects(() => workflow.generateDraft({
    direction: '继续追查', interpretation: '原意锁定', scale: '即时互动',
  }), /尚未结束/u);
  assert.equal(generated, false);
});

test('任务先生成可编辑草案，写入输入框时不创建玩家楼，玩家亲自发送后才封缄', async () => {
  const messages: RuntimeChatMessage[] = [{ message_id: 0, role: 'assistant', message: '库门外传来脚步。' }];
  const runtime = mockRuntime(messages);
  let purpose = '';
  let sentText = '';
  const generator: GenerationAdapter = {
    async generate(_type, _prompt, options) {
      purpose = options?.purpose ?? '';
      return draftJson;
    },
  };
  const userTurns: UserTurnAdapter = {
    async sendUserTurn(text, options) {
      sentText = text;
      await options?.beforeCreate?.(1);
      messages.push({ message_id: 1, role: 'user', message: text, swipe_id: 0 });
      await options?.afterCreate?.(1);
      return { messageId: 1 };
    },
  };
  const workflow = new RuinTaskWorkflow({
    host: mockHost([], messages),
    generator,
    userTurns,
    runtime,
    sources: mockSources(),
    shell: new TavernRuinTaskShellAdapter(runtime),
  });
  const review = await workflow.generateDraft({
    direction: '追回账册', interpretation: '原意锁定', scale: '即时互动',
  });
  assert.equal(purpose, 'ruin-task');
  assert.equal(sentText, '');
  assert.equal(review.phase, 'review');
  assert.equal(messages.length, 1);
  workflow.updateDraft({ objective: '取回账册。' });
  const staged = workflow.stageDraftForComposer();
  assert.equal(staged.phase, 'staged');
  assert.equal(messages.length, 1, '写入输入框阶段不得抢先创建玩家楼');
  const fullPlayerText = '我先检查门边的脚印。\n\n确认墟境任务：追回焚毁前的账册';
  assert.equal(workflow.shouldInterceptComposer(fullPlayerText), true);
  const result = await workflow.confirmStagedDraft(fullPlayerText);
  assert.equal(sentText, fullPlayerText);
  assert.equal(result.task.name, '[墟境任务·个人]追回焚毁前的账册');
  assert.equal(result.task.value.目标, '取回账册。');
  assert.equal(messages.length, 2);
});

test('原生发送已建立玩家楼后只封缄任务，不再代发或重复建楼', async () => {
  const confirmation = '我先走到门边。\n\n确认墟境任务：追回焚毁前的账册';
  const messages: RuntimeChatMessage[] = [
    { message_id: 0, role: 'assistant', message: '库门外传来脚步。' },
  ];
  const runtime = mockRuntime(messages);
  let scriptedSends = 0;
  const workflow = new RuinTaskWorkflow({
    host: mockHost([], messages),
    generator: { async generate() { return draftJson; } },
    userTurns: {
      async sendUserTurn() {
        scriptedSends += 1;
        throw new Error('原生发送链不应再调用脚本代发');
      },
    },
    runtime,
    sources: mockSources(),
    shell: new TavernRuinTaskShellAdapter(runtime),
  });
  await workflow.generateDraft({
    direction: '追回账册', interpretation: '原意锁定', scale: '即时互动',
  });
  workflow.stageDraftForComposer();
  // 模拟酒馆原生发送：宿主先创建且只创建这一个玩家楼。
  messages.push({ message_id: 1, role: 'user', message: confirmation, swipe_id: 0 });
  assert.equal(await workflow.preparePlayerFloor(confirmation, 1), true);
  assert.equal(scriptedSends, 0);
  assert.equal(messages.length, 2);
  assert.equal(await workflow.prepareGeneration(1), true);
  assert.equal((await workflow.readReview())?.phase, 'approved');
});

test('封缄任务在助手楼重抽时逐字复用，只有删除确认玩家楼才恢复编辑', async () => {
  const messages: RuntimeChatMessage[] = [
    { message_id: 0, role: 'assistant', message: '两兄弟站在石灶旁。' },
  ];
  const runtime = mockRuntime(messages);
  const prompts = (runtime as TavernRuntime & { promptWrites: string[] }).promptWrites;
  let calls = 0;
  const workflow = new RuinTaskWorkflow({
    host: mockHost([], messages),
    generator: { async generate() { calls += 1; return draftJson; } },
    userTurns: {
      async sendUserTurn(text, options) {
        await options?.beforeCreate?.(1);
        messages.push({ message_id: 1, role: 'user', message: text, swipe_id: 0 });
        await options?.afterCreate?.(1);
        return { messageId: 1 };
      },
    },
    runtime,
    sources: mockSources(),
    shell: new TavernRuinTaskShellAdapter(runtime),
  });
  await workflow.generateDraft({
    direction: '敲一下两人的脑袋', interpretation: '原意锁定', scale: '即时互动',
  });
  workflow.stageDraftForComposer();
  const approved = await workflow.confirmStagedDraft('确认墟境任务：追回焚毁前的账册');
  const firstContract = [...prompts].reverse().find(Boolean) ?? '';
  assert.match(firstContract, new RegExp(ruinTaskSlot(approved.requestId).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.equal(calls, 1);
  assert.throws(() => workflow.updateDraft({ objective: '偷换目标' }), /已经封缄/u);

  messages.push({
    message_id: 2,
    role: 'assistant',
    message: `第一版正文。\n${ruinTaskSlot(approved.requestId)}`,
    swipe_id: 0,
  });
  await workflow.commitRendered(2);
  assert.match(messages.at(-1)?.message ?? '', /<task_info>[\s\S]*eyon-ruin-quest/u);
  messages.pop();
  assert.equal(await workflow.prepareGeneration(1), true);
  const replayContract = [...prompts].reverse().find(Boolean) ?? '';
  assert.equal(replayContract, firstContract);
  assert.equal(calls, 1);
  assert.equal((await workflow.readReview())?.approvedTaskHash, approved.approvedTaskHash);

  messages.pop();
  await workflow.onMessageDeleted(1);
  assert.equal((await workflow.readReview())?.phase, 'review');
  assert.equal(workflow.updateDraft({ objective: '分别轻敲两人一下。' }).task.objective, '分别轻敲两人一下。');
});

test('任务从进行中转为终态时在对应助手楼追加同风格结果卡且保持幂等', async () => {
  const tasks = [{
    name: '[墟境任务·个人]追回焚毁前的账册',
    mode: '个人' as const,
    status: '进行中',
    attention: '高',
    progress: '已经锁定库门。',
    detail: 'B级。原页正被转移。',
    objective: '取回账册。',
    reward: '900 FP；90000Z 帝冕币；旧水门验印',
    terminal: false,
  }];
  const messages: RuntimeChatMessage[] = [
    { message_id: 0, role: 'assistant', message: '库门就在前方。' },
    { message_id: 1, role: 'user', message: '我取回账册，任务完成。', swipe_id: 0 },
  ];
  const runtime = mockRuntime(messages);
  const workflow = new RuinTaskWorkflow({
    host: mockHost(tasks, messages),
    generator: { async generate() { return draftJson; } },
    userTurns: { async sendUserTurn() { throw new Error('should not send'); } },
    runtime,
    sources: mockSources(),
    shell: new TavernRuinTaskShellAdapter(runtime),
  });
  assert.equal(await workflow.prepareGeneration(1), false);
  tasks[0] = { ...tasks[0], status: '已完成', progress: '账册已安全带离库房。', terminal: true };
  messages.push({
    message_id: 2,
    role: 'assistant',
    message: '尘埃落定。\n<UpdateVariable>{}</UpdateVariable>',
    swipe_id: 0,
  });
  await workflow.commitRendered(2);
  assert.match(messages[2].message, /<task_result>[\s\S]*COMMISSION RESULT/u);
  assert.match(messages[2].message, /委托人 · 伊雍/u);
  assert.ok(messages[2].message.indexOf('<task_result>') < messages[2].message.indexOf('<UpdateVariable>'));
  const once = messages[2].message;
  await workflow.commitRendered(2);
  assert.equal(messages[2].message, once);

  const failedPanel = buildRuinTaskTerminalPanel({ ...tasks[0], status: '失败' });
  assert.match(failedPanel, /is-failed/u);
});

function mockHost(
  ruinTasks: NonNullable<Awaited<ReturnType<HostAdapter['getRuinRuntimeSnapshot']>>['ruinTasks']>,
  messages: RuntimeChatMessage[] = [],
): HostAdapter {
  return {
    async getNamespace() { return { characterKey: 'character', chatId: 'chat' }; },
    async getRuinRuntimeSnapshot() {
      return {
        flowState: 'exploring' as const,
        runId: 'run-1',
        realityTime: '现实',
        realityLocation: '现实地点',
        ruinTime: '复兴纪元480年9月',
        ruinLocation: '奥古斯提姆帝国/外港/旧库房',
        ruinTasks,
      };
    },
    async getLatestUserText() { return ''; },
    async replaceAssistantSlot(messageId, slot, content) {
      const message = messages.find(item => item.message_id === messageId);
      if (!message?.message.includes(slot)) throw new Error('测试楼缺少任务占位符');
      message.message = message.message.replace(slot, content);
    },
  };
}

function economySources(currencyName = '帝冕币'): RuntimeWorldbookSource[] {
  return [
    worldbookSource('经济价格指南', `<经济价格指南>
货币体系:
  各势力货币对照(输出时替换"当地货币名"):
    - 奥古斯提姆帝国: 帝冕币
    - 翼民圣国梵尼亚: ${currencyName}
价格矩阵:
  冒险委托奖励: 单人D:300-800 | C:2000-5000 | B:5万-15万 | A:100万-300万 | S:5000万-1亿 ; 团队D:1500-4000 | C:8000-1.5万 | B:20万-60万 | A:500万-1000万 | S:3亿-8亿
</经济价格指南>`),
    worldbookSource('圣纹工坊', '圣纹工坊坐落于翼民圣国梵尼亚的神迹群山。'),
  ];
}

function worldbookSource(title: string, content: string): RuntimeWorldbookSource {
  const sourceId = `worldbook:角色主书:${title}`;
  return {
    sourceId,
    title,
    content,
    strategyType: 'constant',
    keywords: [],
    worldbook: {
      schema: 'eyon.retrieval.worldbook-metadata.v1',
      logicalId: sourceId,
      worldbookName: '角色主书',
      uid: title.length,
      bindingScopes: ['character-primary'],
      enabled: true,
      strategy: { type: 'constant', primaryKeys: [], secondary: { logic: 'and_any', keys: [] }, scanDepth: 'same_as_global' },
      position: null,
      probability: null,
      recursion: null,
      effect: null,
      extra: {},
    },
  };
}

function mockSources(): RuntimeContextSourceProvider {
  return {
    async getCurrentWorld() { return { time: '', location: '' }; },
    async getWorldbookSources() { return economySources(); },
    async getCharacterSources() { return []; },
    async getGenealogySources() { return []; },
    async getBiographySources() { return []; },
    async getButterflySources() { return []; },
  };
}

function mockRuntime(messages: RuntimeChatMessage[]): TavernRuntime {
  const promptWrites: string[] = [];
  return {
    getCurrentCharacterName: () => 'character',
    getCurrentChatId: () => 'chat',
    getLastMessageId: () => messages.at(-1)?.message_id ?? 0,
    getMessageSwipeId: id => messages.find(message => message.message_id === id)?.swipe_id ?? null,
    getChatMessages: () => messages,
    async setChatMessages(updates) {
      for (const update of updates) {
        const message = messages.find(item => item.message_id === update.message_id);
        if (!message) continue;
        if (update.message !== undefined) message.message = update.message;
        if (update.data !== undefined) message.data = update.data;
        if (update.extra !== undefined) message.extra = update.extra;
      }
    },
    async setExtensionPrompt(_key, value) { promptWrites.push(value); },
    async injectOncePrompts() { return true; },
    async generate() { return ''; },
    async generateRaw() { return ''; },
    promptWrites,
  } as TavernRuntime & { promptWrites: string[] };
}
