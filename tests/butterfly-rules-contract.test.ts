import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * internal.89（趣味性回归）：rules/15 与 prompts 的创作口径防漂移。
 * rules 经 `?raw` 嵌入 dist，改文本必须重新打包；这里锁住"必须存在的要素"，
 * 防止后续编辑把最高指令、范文、误读引擎、档位规模或关键词质量误删。
 * 与 prompts/butterfly.ts 的对应段（BUTTERFLY_HISTORICAL_EVOLUTION_STYLE）成对出现。
 */
const rules = readFileSync(
  new URL('../rules/15_蝴蝶效应生成规则-API.txt', import.meta.url),
  'utf8',
);

test('rules/15 趣味性契约要素在位（最高指令/档位规模/误读/范文/文风/关键词）', () => {
  // ⑧ internal.89：最高指令置顶，惊喜与趣味优先于"像史料"
  assert.match(rules, /# 零、最高指令/u);
  assert.match(rules, /惊喜与趣味第一/u);
  assert.match(rules, /因果不必相称，越不成比例越好/u);
  assert.match(rules, /宁可荒诞、讽刺、黑色幽默、传奇/u, '反公文口径在位');
  assert.match(rules, /正例（要写成这样）/u, '正例在位');
  assert.match(rules, /反例（不要写成这样）/u, '反例在位');
  // ① 示踪样文（只学节奏与反差，禁止复用内容）+ 失败样文
  assert.match(rules, /结构示踪样文/u);
  assert.match(rules, /祈雨/u, '趣味示踪样文正文应在位');
  assert.match(rules, /【不要写成这样】/u, '失败样文（公文版）在位');
  // ⑥ 尺度自适应篇幅（与 butterflyProseContract 数值同源）
  assert.match(rules, /个人\/双人目标220至360字/u);
  assert.match(rules, /小队\/聚落\/城市目标320至520字/u);
  assert.match(rules, /省份级地区\/国家\/跨国目标450至700字/u);
  // ② 写作手法级要求：可见动作 + 至少一次世界误读
  assert.match(rules, /能被旁观者看见的具体动作/u);
  assert.match(rules, /至少一次世界的误读/u);
  // ③ 短字段具体化：落点=具体场景；证据可核查
  assert.match(rules, /能走进去、能问到人、能亲手比对/u);
  assert.match(rules, /纹章、碑文、地图或档案发生了可核对变化/u);
  // ④ 文风分层：趣味优先，最后才是"像史料"
  assert.match(rules, /第一优先级是惊喜与趣味/u);
  // ⑤ 关键词质量（专名 / 禁泛词 / 别名可并列）——§6.5.5 提示词侧
  assert.match(rules, /关键词质量（决定该条目日后能否被正确检索与触发）/u);
  assert.match(rules, /必须是能区分本条目的专名/u);
  assert.match(rules, /禁止泛词与抽象名词/u);
  assert.match(rules, /同一条目内的同义别名可并列/u);
  // internal.87（G-10③）：关键词必须写成正文会逐字出现的字面形态，禁描述句堆叠
  assert.match(rules, /必须写成本文里会真实出现的字面写法/u);
  assert.match(rules, /关键词就写「麦堆里的第三只眼」/u, '字面形态正反例应在位');
  assert.match(rules, /禁止描述句与短语堆叠/u);
  // ⑦ internal.89 范围语义：骰点只决定"结果落地规模"，不限制起因与因果比例
  assert.match(rules, /骰点决定的是\*\*结果最后长到多大\*\*/u);
  assert.match(rules, /不限制起因/u);
  assert.match(rules, /档位是你要\*\*达到\*\*的高度，不是天花板/u);
  assert.match(rules, /误读本身就是一等媒介/u);
  assert.match(rules, /把既有史料人物强行写成所有历史的中心/u, '人物边界保留为唯一一条角色禁令');
  // 玩家后代口径：既有史料人物不得加亲缘，玩家自己造成的后果不受限
  assert.match(rules, /不得凭空给既有史料人物添加亲缘/u);
  assert.match(rules, /玩家自己那次行动直接造成的后果不受此限/u);
  // 自检已瘦身（不再是 15 条工程自省）
  assert.match(rules, /世界把玩家的行为误读成了什么/u);
  assert.match(rules, /十五秒内复述/u);
  // 机制约束未被误删（锚点/创作目标/失败处理仍在；§十八 重号已修正）
  assert.match(rules, /# 四、锚点不可变/u);
  assert.match(rules, /# 六、创作目标/u);
  assert.match(rules, /# 二十、失败/u);
  assert.match(rules, /# 二十一、禁止行为（脚本契约）/u);
});

test('蝴蝶 API prompt 与 rules/15 的趣味性要点成对（范文/匿名角色/落点具体化）', async () => {
  const { buildButterflyApiPrompt } = await import('../src/prompts/butterfly.ts');
  const prompt = buildButterflyApiPrompt({
    request: {
      schema: 'eyon.butterfly.request.v1',
      requestId: 'rules-contract',
      characterKey: '伊雍',
      chatId: 'rules-contract',
      runId: 'run-rules-contract',
      trigger: { type: 'text', userMessageId: 1, returnAssistantMessageId: 2, rawCommand: '遣返' },
      anchors: {
        reality: { time: '复兴纪元488年-3月-15日-14:05', location: '金谷城-仪式大厅' },
        ruinEntry: { time: '复兴纪元184年-11月-9日-23:15', location: '旧堡-侧翼走廊' },
        ruinExit: { time: '复兴纪元184年-11月-9日-23:20', location: '旧堡-密道入口' },
      },
      dice: { roll: 68, scope: '城市' },
      ruinHistory: {
        title: '被替换的名册',
        era: '复兴纪元',
        originalTrajectory: '旧名册原本会被焚毁',
        historicalBackground: '地方宗族争夺档案',
        enteredAnomaly: '名册替换',
        locationChain: ['旧堡', '侧翼走廊', '密道入口'],
      },
      playerInterventions: [{
        sourceId: 'chat:8',
        title: 'user floor 8',
        content: '夜见哉川改变了旧档案的归属。',
      }],
      involvedEntities: [],
      currentRealityContext: [],
      relevantWorldbook: [],
      relevantChatFacts: [],
      relevantGenealogy: [],
      relevantBiographies: [],
      previousButterflyAnchors: [],
      sourceIndex: [{ sourceId: 'chat:8', title: 'user floor 8', content: '夜见哉川改变了旧档案的归属。' }],
    } as never,
    rules: {
      sharedContext: 'shared',
      retrievalContract: 'retrieval',
      validationContract: 'validation',
      generationContract: rules,
    },
  });
  assert.match(prompt, /<BUTTERFLY_HISTORICAL_EVOLUTION_STYLE>/u);
  assert.match(prompt, /不得为既有正史人物虚构新的亲缘关系/u, 'prompts 侧角色边界在位');
  assert.match(prompt, /缺少合适具名人物时使用/u, '匿名社会角色指引在位');
  assert.match(prompt, /必须是玩家能抵达或接触的具体场景/u, '落点具体化在位');
  assert.match(prompt, /【有趣｜学这个】/u, 'prompts 侧趣味示踪样文在位');
  assert.match(prompt, /【失败｜不要这样写】/u, 'prompts 侧失败样文在位');
  assert.match(prompt, /只限定\*\*结果落地时的规模\*\*/u, 'prompts 侧范围语义在位');
  assert.match(prompt, /越不成比例越有趣/u, 'prompts 侧反比例口径在位');
  assert.match(prompt, /必须写出一次\*\*误读\*\*/u, 'prompts 侧误读引擎在位');
  assert.match(prompt, /代价不是硬性要求/u, 'prompts 侧代价可选在位');
  assert.match(prompt, /继续调查、利用、保护、交易、对抗或误解/u, 'prompts 侧可玩遗留物在位');
});
