import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * internal.85（蓝图 §7 内容趣味性契约）：rules/15 与 prompts 的趣味性要点防漂移。
 * rules 经 `?raw` 嵌入 dist，改文本必须重新打包；这里锁住"必须存在的要素"，
 * 防止后续编辑把范文、尺度篇幅、关键词质量或角色边界误删。
 * 与 prompts/butterfly.ts 的对应段（BUTTERFLY_HISTORICAL_EVOLUTION_STYLE）成对出现。
 */
const rules = readFileSync(
  new URL('../rules/15_蝴蝶效应生成规则-API.txt', import.meta.url),
  'utf8',
);

test('rules/15 §7 趣味性契约要素在位（范文/尺度/手法/短字段/角色边界/关键词质量/文风）', () => {
  // ① GOLD_SAMPLE 示踪样文（结构级，禁止复用内容）
  assert.match(rules, /结构示踪样文/u);
  assert.match(rules, /调粮函/u, '示踪样文正文应在位');
  // ⑥ 尺度自适应篇幅（与 butterflyProseContract 数值同源）
  assert.match(rules, /个人\/双人目标220至360字/u);
  assert.match(rules, /小队\/聚落\/城市目标320至520字/u);
  assert.match(rules, /省份级地区\/国家\/跨国目标450至700字/u);
  // ② 写作手法级要求：具体动作 + 至少一次翻转/误读/代价
  assert.match(rules, /每一段都要有具体人物的具体动作/u);
  assert.match(rules, /至少出现一次反转、误读、代价或利益重新分配/u);
  // ③ 短字段具体化：现世落点=具体场景；证据可核查
  assert.match(rules, /能走进去、能问到人、能亲手比对/u);
  assert.match(rules, /纹章、碑文、地图或档案发生了可核对变化/u);
  // ④ 文风对齐（正史腔调，非条目/非抒情）
  assert.match(rules, /与伊雍正史叙述腔调一致/u);
  // ⑤ 关键词质量（专名 / 禁泛词 / 别名可并列）——§6.5.5 提示词侧
  assert.match(rules, /关键词质量（决定该条目日后能否被正确检索与触发）/u);
  assert.match(rules, /必须是能区分本条目的专名/u);
  assert.match(rules, /禁止泛词与抽象名词/u);
  assert.match(rules, /同一条目内的同义别名可并列/u);
  // internal.87（G-10③）：关键词必须写成正文会逐字出现的字面形态，禁描述句堆叠
  assert.match(rules, /必须写成本文里会真实出现的字面写法/u);
  assert.match(rules, /关键词就写「麦堆里的第三只眼」/u, '字面形态正反例应在位');
  assert.match(rules, /禁止描述句与短语堆叠/u);
  // ⑦ 角色使用边界（不得借蝴蝶创造新的正史名人/亲属/子嗣）在 §十三 禁止项
  assert.match(rules, /把现有人物强行写成所有历史的中心/u);
  // 范围是稳定后被改写的最小社会容器，不是消息传播人数；八档各有边界。
  assert.match(rules, /哪个最小社会容器的正常状态被永久改写/u);
  assert.match(rules, /不是听闻消息、围观或短期受波及的人数/u);
  assert.match(rules, /`个人`[\s\S]*不得再出现第二条同等分量的人生改写/u);
  assert.match(rules, /`双人`[\s\S]*第三方只能作为见证者、阻力或执行者/u);
  assert.match(rules, /`小队`[\s\S]*不得扩成整个聚落/u);
  assert.match(rules, /`聚落`[\s\S]*聚落之外只保留零散回声/u);
  assert.match(rules, /`城市`[\s\S]*不得自动成为周边地区的普遍规则/u);
  assert.match(rules, /`省份级地区`[\s\S]*不能把该机制写成全国默认制度/u);
  assert.match(rules, /`国家`[\s\S]*结果核心仍应收束在该国/u);
  assert.match(rules, /`跨国`[\s\S]*不得空泛扩大为整个世界/u);
  // 趣味机制：性质变化 + 得失双方 + 可继续游玩的遗留物，且不能面板化。
  assert.match(rules, /出人意料但回看后合理的性质变化/u);
  assert.match(rules, /谁从变化中获益、谁替它付出代价/u);
  assert.match(rules, /继续调查、利用、保护、交易、对抗或误解的遗留物/u);
  assert.match(rules, /不得写成范围说明、得失清单、游戏结算报告或固定模板/u);
  // 机制约束未被误删（锚点/因果账本/失败处理仍在）
  assert.match(rules, /# 四、锚点不可变/u);
  assert.match(rules, /# 六、创作目标/u);
  assert.match(rules, /# 十九、失败/u);
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
  assert.match(prompt, /不得借蝴蝶效应创造新的正史名人或亲缘/u, 'prompts 侧角色边界在位');
  assert.match(prompt, /缺少合适具名人物时使用/u, '匿名社会角色指引在位');
  assert.match(prompt, /必须是玩家能抵达或接触的具体场景/u, '落点具体化在位');
  assert.match(prompt, /风格示踪（仅学结构，不得复用内容）/u, 'prompts 侧示踪样文在位');
  assert.match(prompt, /被永久改写的最小社会容器/u, 'prompts 侧范围语义在位');
  assert.match(prompt, /谁从变化中获益、谁替它付出代价/u, 'prompts 侧得失张力在位');
  assert.match(prompt, /继续调查、利用、保护、交易、对抗或误解/u, 'prompts 侧可玩遗留物在位');
});
