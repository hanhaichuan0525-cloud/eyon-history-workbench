# 伊雍历史工作台 · 任务交接文档(给 Codex / 下一任主管)

> **ARCHIVED / HISTORICAL HANDOFF**：本文是旧迁移时点的交接快照，不能覆盖当前源码、测试、`../../NEXT.md` 与现行蓝图索引。

> 交接日期:2026-08-20
> 当前版本:`0.10.0-internal.46`(manifest.json 为准;package.json 的 version 字段长期未同步,勿以其为准)
> 验证基线:typecheck ✅ · **292/292 测试全绿** · Active 检索定向 **29/29** · 四模块业务 **106/106** · build/package/包体反向检查 ✅ · 已打包 `release\酒馆助手脚本-伊雍历史工作台-内测.json`
> 交接人角色说明:本文档是"参谋视角"的总交接——说明项目是什么、怎么运转、做过什么、卡在哪、下一步该做什么。所有结论来自实际代码与实测,标注了"已确认/待实测/推断"。

---

## 0. 一分钟摘要

伊雍历史工作台是一个 **SillyTavern / Tavern Helper(JS-Slash-Runner)脚本插件**,为"命定之诗"角色卡提供历史向玩法支撑:五个正式模块——**寻根溯源(传记)、墟境(历史期生成与穿越)、宗族谱系、蝴蝶效应(遣返结算)、时间线(剧情时钟)**,外加一个浮窗工作台 UI 和宿主页任务通知。所有生成走**独立 API(DeepSeek 兼容)**,契约驱动 + 脚本确定性渲染,楼层事务锁保证与酒馆正文生成的原子性。

最近一轮工作是 **Retrieval v1.2 证据优先修正**：传记、谱系、墟境与蝴蝶效应继续通过同一 Active 门，但来源只有在保留了 EvidencePassage 后才进入最终 selected。核心人物的权威来源先占来源与段落预算；可选来源超预算改记 rejected，不再整项报错。复合时代实体保留限定词，`人类帝国`不再误伤`人类`；带多层标签的瑞丝人物标题可归一为权威角色。internal.46 已打包，等待真实酒馆复测瑞丝传记和神明纪元墟境。本文 §7 的旧问题清单保留为历史记录；当前执行真源以 `NEXT.md` 为准。

### 0.1 internal.46 当前事实

- 传记、谱系、墟境、蝴蝶效应全部正式切换为 unified active；生产代码中唯一显式模式字面量为 `mode:"active"`。
- 四模块正式 `sourceIndex` 与分组上下文只消费 receipt 入选源对应的 EvidencePassage；legacy 仅用于差异观察，不混合输出、不静默 fallback。
- 蝴蝶效应额外保留玩家实际行动与冻结现实两个任务锚，它们属于请求事实而非 legacy 检索结果。
- 泛词“探索 / 墟境探索 / 其他 / 大陆 / 全境 / 神明”、纯纪元词与结构标题不再取得 catalog-direct 入场权，但仍保留在完整目录和全文索引中。
- CastManifest 只接纳人物型实体，排除建筑、机构、系统、仪式、赛事、层级说明和未知泛称；神明/圣灵章节的顶层人物定义可提供神祇身份。
- 显式纪元任务会排除其他纪元来源；无纪元锚点的旁支来源，除非直接点名或属于正式角色权威来源，否则不会进入正式证据。
- 泰珂真实 UID 回归只保留 `[世界主设定]` 与有泰珂信仰证据的 `银帆城`；交叉索引合同继续覆盖既有传记、谱系、蝴蝶效应。
- 玩家完全不填墟境日期时，脚本会先选定并持久化明确跨度，再把四个因果节点分布到完整年月日时分；不再向用户展示相对纪年或未详。
- P0 核心人物权威来源先于普通查询、关系证据与背景占用预算；最终 selected 与 sourceSnapshots 均由实际 passages 反推，四模块一致。
- `[DLC][角色][瑞丝]瑞丝(...)` 可归一为人物“瑞丝”；可选背景没有 passage 时转为 `passage-budget-exhausted`，不会触发 Active 整项失败。
- `人类帝国`的时间规则只约束帝国实体，不再把基础种族“人类”判为神明纪元尚未出现；精确晚生政权、成熟宗教与公会硬约束保留。
- internal.46 包 SHA-256：`45A8F0B0695576E0AB95A486A5C98AE2DBA6EBE2BC6D6166B92E0E03ECA12431`；internal.45 已按原 SHA-256 `F59439DBAB91266DA70C612DE8BA0E7F17206A39948E5DDF6682E300B76F14A5` 归档。

---

## 1. 项目结构

```
eyon-history-workbench/
├── manifest.json            # 发布清单:版本/入口/各 bundle sha256/notes(发版必改)
├── package.json             # 构建脚本(version 字段已过时,勿动)
├── webpack.config.cjs       # 六入口构建:index/genealogy/ruin/biography/timeline/workbench
├── scripts/
│   └── build-tavern-test-loader.mjs  # 打包器:注入 loader 胶水,校验 sha256,生成 release JSON
├── rules/                   # 规则文本库(00-15 编号),部分随构建嵌入生成提示词
│   ├── 00_README-嵌入规则索引.txt    # 每个规则文件的消费者/用途/原则(先读这个)
│   ├── 06_墟境系统变量规则-脚本契约.txt
│   ├── 11_墟境历史期生成规则-API.txt  # 墟境生成规则(shift 已在此补充)
│   ├── 13_寻根溯源生成规则-API.txt    # 传记(断代志)生成规则
│   └── ...(01-15,见 00 索引)
├── docs/                    # 蓝图与交接(本文件所在的目录,先读:
│   ├── 进入特异点注入合流改造蓝图.md   # 穿越入口重构的完整蓝图(含 A/B 补丁执行记录)
│   ├── 穿越入口数据与通知修复蓝图.md   # P1-P5 数据/通知修复(已执行完,待实测)
│   ├── 交叉参考与时间线修订蓝图.md     # 已决策但暂缓的大蓝图(详见 §7-3)
│   ├── RUIN_MODULE_REWORK_PLAN.md     # 墟境模块历史改造记录
│   ├── BIOGRAPHY_VIGNETTE_REWORK.md   # 传记断代志改造记录
│   ├── RUNTIME.md / SYNC.md / INTERNAL_TEST_INSTALL.md / TAVERN_INTEGRATION_CHECKLIST.md
└── src/
    ├── entry.ts             # 宿主入口:组装全部依赖,发布 window.EyonHistoryWorkbench facade
    ├── index.ts             # bundle 入口(六个 bundle 的入口文件)
    ├── adapters/host.ts     # HostAdapter/UserTurnAdapter 接口(工作流对宿主的抽象)
    ├── core/                # 无依赖核心:namespace(聊天隔离)/commands(文本命令解析)/context(上下文类型)/json/slots/biographyContract
    ├── schemas/             # zod schema(每模块一份:biography/ruin/genealogy/butterfly)
    ├── validators/          # 解析+归一化+语义校验(每模块一份;ruin.ts 含时间线退化/span/shift/label 逻辑)
    ├── prompts/             # 提示词构建(每模块一份;ruin.ts 含大纲/扩写/修复契约)
    ├── workflows/           # 纯业务工作流(每模块一份 + ruinEntry.ts 穿越进入 + messageAssembly.ts 楼层组装)
    ├── renderers/           # 确定性渲染:rootTrace(传记)/ruinTrace(墟境面板)/ruinTimeLabel(时间标签)/spanLabel/butterfly
    ├── runtime/             # 宿主胶水(最重要的一层):
    │   ├── contracts.ts     # TavernRuntime 接口(宿主能力契约)
    │   ├── tavernRuntimeAdapter.ts   # TavernHelper 全局解析 + 自定义 API 直连(requestCustomChatCompletion)
    │   ├── tavernGeneration.ts       # 生成适配器:独立 API 调用/重试/截断恢复/超时/错误分类
    │   ├── tavernHost.ts    # 宿主实现:变量读写/世界书/发送玩家楼(SerializedTavernUserTurnAdapter)/快照
    │   ├── globalBindings.ts         # TavernHelper 绑定解析 + 事件桥(createGlobalEventBridge)
    │   ├── registerLifecycle.ts      # 正文生命周期:beforeGeneration/onAssistantRendered/onChatChanged
    │   ├── workbenchLifecycle.ts     # 多模块生命周期聚合(传记/蝴蝶/进入提交/聊天切换清理)
    │   ├── biographyController.ts / butterflyController.ts / ruinController.ts / genealogyController.ts
    │   ├── tavernBiographyShell.ts   # 传记注入壳(arm/clear/断言/元数据双写)——被墟境壳仿写的模板
    │   ├── tavernRuinEntryShell.ts   # 穿越进入注入壳(同款模式)
    │   ├── ruinTimeKernel.ts         # 时间内核:墟境变量归一化/白名单(RUNTIME_FIELDS 导出)/快照/命令强化
    │   ├── biographyPreSend.ts       # 宿主发送拦截(传记命令)+ 通用读框/清框(readTavernComposerText)
    │   ├── workbenchSettings.ts      # 每模块 API 设置(GenerationSettings)/迁移/重试预算
    │   ├── sourceSelection.ts        # 资料检索:constant 优先 + 关键词扫描 + persona 加成
    │   ├── ruinContext.ts / biographyContext.ts / genealogyContext.ts / butterflyContext.ts
    │   ├── storyClock.ts / biographyDice.ts / biographyDiceCore.ts / ruinDice.ts / ruinDiceCore.ts
    │   └── facade.ts         # WorkbenchFacade 接口 + WORKBENCH_GLOBAL 常量
    ├── storage/             # IndexedDB 持久化(每模块一份:biographies/genealogies/ruins/butterflies/ruinReferences)
    └── ui/                  # 工作台 UI(宿主导入的 module bundle):workbenchPage/workbenchShell/
                             #   ruinWorkbench(含进入按钮)/biographyWorkbench/genealogyWorkbench/
                             #   settingsWorkbench/timelineWorkbench/hostStatusToast(宿主页通知栈)/
                             #   workbenchClient(UI↔facade 客户端)/ruinPresentation(时间渲染,已 re-export 公共模块)
```

---

## 2. 功能实现现状(做到什么程度)

### 2.1 五模块总览

| 模块 | 入口 | 状态 | 说明 |
|---|---|---|---|
| 寻根溯源(传记) | `biography.generate` 命令 / 面板 | ✅ 稳定 | 断代志文体(独立时期切片,弱因果);plan→批次扩写(2块/批)→组装→校验;注入壳 + 楼层锁两阶段提交 |
| 墟境生成 | `ruin.generate` / 面板 | ✅ 稳定 | 大纲(一次全候选)→ 选中后扩写;EVIDENCE_LEDGER 身份证;时间线退化检查;候选可单独重试 |
| 穿越进入(特异点) | 面板"进入此特异点" | 🟡 重构完成待实测 | **注入合流**:玩家楼=玩家原话(空输入默认语),契约进常驻注入层,渲染后提交组装 [RuinTrace] |
| 宗族谱系 | 面板 | ✅ 稳定 | MVU 人物为中心,世代追溯,只读引用 |
| 蝴蝶效应(遣返) | `ruin.return` 命令 | ✅ 稳定 | 遣返前冻结快照,结算独立 API,归档 |
| 时间线(剧情时钟) | 面板 | ✅ 稳定 | 剧情时间推进显示 |

### 2.2 穿越入口(最近工作核心,务必先理解)

**架构(注入合流,internal.32 起)**:
```
点击"进入此特异点" → facade.enterRuin
  → expandForEntry(确保史稿已展开)
  → readTavernComposerText(读输入框;失败→中止;空→默认语「我踏入这处历史特异点。」)
  → ruinEntry.enter(playerText):
       beforeCreate 内 arm 注入(setExtensionPrompt: in_chat/depth0/system,传记同款通道)
       → createUserMessage(玩家原话) → 校验唯一玩家楼 → triggerReply
  → 渲染事件 onAssistantRendered → commitRendered(断言紧邻楼/空内容等待/流式轮询)
  → commitLock: insertRuinTrace 组装权威 [RuinTrace] 进助手楼 → 元数据双写 → 清注入 → 释放防重
失败路径: 任何失败 → 清注入 + 丢锁 + toast(error 5s);删楼回退 → MESSAGE_DELETED 释放防重
```
**注入契约内容**(buildRuinEntryContract):「进入节点」+【历史工作台·单楼进入契约】(现实锚点/目标纪元/目标墟境时地/节点全字段)+ 权威 [RuinTrace](flat 单行,对齐美化正则)+ `<VARIABLE_UPDATE_RULES>`(11 条 JSON Patch 路径清单 + 角色卡时间/地点格式指示)。

**关键约定**:
- 面板 [RuinTrace] 格式必须与酒馆正则 `regex-伊雍-墟境输出面板美化` 严格一致(字段序 Title→Type→Span→History→Shift→NodeTime;Type 枚举 稳定期|过渡期|动荡期;`:: ` 分隔;**组装时压成单行**——markdownOnly 正则只认空格不认 `<br>`)
- 变量写入由**正文模型在回复末尾输出 JSON Patch** 完成;时间内核(ruinTimeKernel)提取/白名单校验/应用/同步世界时地/写快照;脚本不直接写 MVU
- 时间标签一律脚本确定性渲染(模型 label 一律丢弃),星期与地点层级由模型按角色卡规则补全(契约内已给示例)

### 2.3 时间内核(ruinTimeKernel.ts,桥接关键)

- 监听 MVU 事件(COMMAND_PARSED/BEFORE_MESSAGE_UPDATE/VARIABLE_UPDATE_ENDED)+ 0/90/240/520/900ms 重放兜底
- `RUNTIME_FIELDS`(23 字段白名单,已导出)= 唯一真源;`extractRuinPatchOperations` 只收含 op+path 的 JSON 数组;`isAllowedPatchPath` 白名单过滤
- `isCompleteActive` 九字段齐全才激活(flowState∈{exploring,anchored,returning} ∧ 规则锁=1 ∧ 轮次 ∧ 现实锚点 ∧ 墟境时地 ∧ 进入时地)
- 活跃时自动同步 `世界.时间/地点 = 墟境当前时间/地点`;遣返(idle 化)归档并恢复现实锚点
- `syncSnapshot` 写 `墟境系统.虚嗣指南快照` → `getRuinRuntimeSnapshot` 消费(flowState 校验进入资格)

### 2.4 通知与 UI

- 宿主页通知栈 `hostStatusToast.ts`:running 计时(已等待 X:XX)/success 1.8s 消失/error 5s 倒计时/结果条目 6 条上限;进入通知文案已入戏化(伊雍公主口吻)
- 工作台浮窗:loader 注入宿主页(伊 按钮 → overlay),UI 是独立 module bundle,经 `window.EyonHistoryWorkbench` facade 通信
- UI 进入按钮:自动容错(选中丢失时自动选第一个可进入特异点)、busy/entering 时禁用、点击输出诊断日志(`ruin enter clicked` / `ruin node selected`)

---

## 3. 开发流程与纪律(该怎么做)

### 3.1 构建/测试/发版(每次改动后必做)

```powershell
# 1. 类型检查
pnpm typecheck

# 2. 测试(注意:沙箱禁止 child_process 带管道;用 --experimental-test-isolation=none;
#    退出码 1 但 "pass N fail 0" 是管道噪音,以 "not ok"/"fail N" 为准)
node --test --experimental-test-isolation=none tests/*.test.ts

# 3. 构建
pnpm build                     # webpack → dist/*.js(六入口)

# 4. 更新 manifest.json:
#    version +1(当前 internal.37);重新计算变更 bundle 的 sha256
#    (Get-FileHash dist/xxx.js -Algorithm SHA256);notes 首条写本次改动

# 5. 打包(会校验 sha256,不匹配直接失败)
pnpm package:internal          # → release\酒馆助手脚本-伊雍历史工作台-内测.json

# 6. 用户导入酒馆:删旧脚本条目 → 导入新包 → 刷新页面 → 控制台验证版本
#    window.__eyonHistoryWorkbenchInternalLoader?.version
```

### 3.2 工作纪律(用户明确要求,违反会被打回)

1. **先不改文件**:分析/方案先行,用户确认蓝图后才动手;逐步推进(改小步→跑绿→下一步)
2. **越稳越好**:优先复用已验证机制(传记壳/内核/事件桥),不引入未验证通道
3. **不过度删除**:死代码可留过渡,实测通过后再清
4. **契约驱动 + 脚本确定性渲染**:模型不可信,能脚本算的绝不让模型写(label/shift 等教训)
5. **单一真源**:字段清单与内核白名单同源(测试防漂移),渲染函数在公共模块
6. 每阶段验收:typecheck + tests + build + 打包 + 用户酒馆实测
7. 测试跑法见 §3.1;禁止用 shell cat/grep 读文件(用 read/grep 工具)

---

## 4. 我们做过的工作脉络(为什么是现在这样)

| 阶段 | 内容 | 结果 |
|---|---|---|
| 起源 | 诊断酒馆 API 调用失败/传记生成失败 | 根因:follow_tavern 缺 JSON 强制 |
| 决策 1 | **彻底删除 follow_tavern 模式** | 只保留独立 API(每模块自定义 API + 应用到全部) |
| 决策 2 | 传记改**断代志**文体 | 独立时期/弱因果/寿命自适应年龄/反回声/造名/统一《名》传标题 |
| 修复 | "297<300" 长度失败 | 目标 330 + 含标点措辞 + extraGuidance 修复 |
| 修复 | 退化时间线(创世纪元1月1日/0年) | null 兜底 + TIMELINE_DEGENERATE + 相对纪年 + 禁止 0 年 |
| 重构 | 墟境模块对照传记教训 | 死代码清理/大纲 repair/身份纪律/摘要池/8192 预算 |
| 暂缓 | 交叉参考与时间线修订蓝图 | **已决策未实施**(§7-3) |
| 分析 | shujuku(数据库)双重注入机制 | 借鉴:导演块/认领时序;不学:DOM 依赖/全量拦截/任务编排 |
| 重构 | **穿越入口注入合流**(internal.32) | 玩家楼=原话,契约进注入层,删 writeTavernComposer 调用 |
| 补丁 | 变量规则脚本注入 + [RuinTrace] 面板回归(internal.32) | <VARIABLE_UPDATE_RULES> 11 路径;insertRuinTrace 组装 |
| 修复 | 进入按钮无反应/选中丢失(internal.33-35) | 诊断日志 → 容错自动选节点 |
| 修复 | 数据与通知五连修(internal.36) | label 确定性渲染/shift 硬门/删楼重进/计时通知/通知消失 |
| 修复 | 角色卡格式对齐 + 文案(internal.37) | 跨度汉字化/节点时间角色卡风格/入戏文案 |
| **当前** | 圣翼议会归属错乱 | **未解决,见 §7-1** |

---

## 5. 值得参考的源代码仓库

| 仓库 | 路径 | 借鉴点 | 不学点 |
|---|---|---|---|
| 数据库(shujuku) | `我的核心及美化项目\数据库源码仓库\shujuku-main` | ① 剧情推进的导演块组装(buildFinalPlotInjectionMessage)② hash+roundId 认领、延迟 flush 状态机 ③ 双策略编排(service/presentation 分层干净)④ 任务级独立 API 预设 | ① `#send_textarea`/`#send_but` DOM 读写与 capture 钩子 ② TavernHelper.generate 全量拦截的竞态补丁链 ③ 策略 2 覆盖输入框 ④ 完整任务编排框架(plotTasks/预设/聊天级快照) |
| 构画(ST-SevenDaysCal) | `我的核心及美化项目\构画源码仓库\ST-SevenDaysCal-master` | 提示词模板/makeLast 事件注册模式(CHAT_COMPLETION_SETTINGS_READY) | 其具体机制未深研,按需查阅 |
| 工作流助手模板 | `我的核心及美化项目\工作流源码仓库\tavern_helper_template-main-master` | 项目骨架/规则体系(00-15 编号嵌入)/构建发布流程的源头 | — |

**规则文件体系是本项目的"宪法"**:`rules/00_README-嵌入规则索引.txt` 定义每个文件的消费者与原则;修改生成规则时,提示词契约(src/prompts/)与规则文件(rules/)要同步(如 shift 的两次修改)。

---

## 6. 关键技术机制速查(改代码前先读)

1. **注入壳模式**(tavernBiographyShell → tavernRuinEntryShell):`arm`(setExtensionPrompt in_chat=1/depth0/system,key 带 requestId)→ `assertRenderedFloor`(触发楼身份 hash+swipe、助手楼紧邻)→ `attachRequestMetadata`(**必须带 message 字段作分支触发器**,否则宿主 no-op)→ `clear`
2. **发送玩家楼**(SerializedTavernUserTurnAdapter.sendUserTurn):串行化;beforeCreate(expectedMessageId) 可武装;建楼后校验唯一;afterCreate 确认;triggerReply
3. **提交状态机**(biographyController.commitRendered 为模板):断言失败保留锁 / 空内容等待 / `isGenerating===true` 流式等待 + 500ms×120 settle 轮询
4. **事件桥**(createGlobalEventBridge):GENERATION_AFTER_COMMANDS / CHARACTER_MESSAGE_RENDERED / CHAT_CHANGED / MESSAGE_DELETED(可选);新增事件要同步扩展 names 与 entry.ts 注册
5. **确定性渲染**:`renderers/ruinTimeLabel.ts`(dateLabel/formatRuinSpanLabel/formatRuinNodeExactTime/formatRuinNodeTimeCard)+ `renderers/ruinTrace.ts` + `renderers/rootTrace.ts`(escapeHtml 换行转 &#10;)
6. **命令解析**(core/commands.ts):`parseTextCommand` 是 contains 匹配"寻根溯源"(自然语言也可能命中——玩家楼决议要防);`createButtonCommand` 供面板
7. **防重与释放**:RuinEntryWorkflow.submitted(发送成功登记,commit 或删楼释放)+ inFlight(并发去重)+ flowState==='idle'(进入资格)

---

## 7. 当前问题清单(按优先级)

### 7-1 🔴 圣翼议会归属错乱(最新,未解决,先修这个)

**现象**:生成的史稿中"圣翼议会"被写成翡翠之心的,实际属于梵尼亚。AI 未理解世界书中的组织-势力归属关系。

**排查方向**(推断,需验证):
1. 生成时 REFERENCE_DATA/EVIDENCE_LEDGER 里是否真的包含"圣翼议会"条目(来源权威)— 若没有,模型无从知晓,是**资料检索/选择问题**(sourceSelection.ts 关键词命中、constant 优先级、上下文预算截断)
2. 若有条目但模型仍写错:大纲/扩写契约对**组织归属**的约束是否够硬——目前 PERIOD_ANCHORING/借名纪律主要约束"具名人物"(同名同人/借名即查证),组织(议会/教会/家族)可能没有同等的"归属即查证"条款;对照 `rules/11` 与 `src/prompts/ruin.ts` 的 EVIDENCE_LEDGER 说明
3. 世界书扫描策略:`getWorldbookSources`(tavernHost)与 `selectRuinReferenceSources`(prompts/ruin.ts,9k 字符/8 条上限)是否截断了相关条目
4. 模型把"圣翼议会"当作常识发明:检查候选 generationContract(rules/11 §二)是否有"未知组织不得发明,必须来自史料"的硬约束

**验证手段**:复现一次生成,抓取该请求的 REFERENCE_DATA(可在 prompts 构建处加日志或查 EVIDENCE_LEDGER 测试),确认条目在不在、契约措辞是否覆盖组织归属。

### 7-2 🟡 待酒馆实测(穿越入口,internal.36/37 改动)

- [ ] 面板:时期跨度显示"创世纪元240年1月15日 —— 250年12月31日"式汉字格式;节点时间无 "(N)" 后缀
- [ ] 变量:模型按契约补全**星期**与**地点层级**(创世纪元247年-7月-7日-星期五-19:30 / 大陆中西部-河谷聚落-工坊区-镇中心喷泉)— 若模型不照做,需强化契约措辞
- [ ] 转变方向显示真实演变(需重新生成墟境,旧数据 shift 仍是同值);shift 硬门 repair 频率是否可接受(频繁则降级为提示+面板容错,见蓝图风险表)
- [ ] 删楼回退后同节点可重进;进入计时通知文案与消失时机;通知不叠加
- [ ] [RuinTrace] 面板在穿越楼正常美化渲染(flat 单行)

### 7-3 🟡 已决策未实施:交叉参考与时间线修订(见 docs/交叉参考与时间线修订蓝图.md)

- 依赖图缺口:谱系未引用蝴蝶效应;墟境候选无下游引用
- 方案已定:有效正史 = 世界书 ⊕ 蝴蝶补丁(delta store,append-only,装配时应用);范围=生卒·存在·亲缘·关键事件;diff-only 呈现
- 用户明确"先做其他事",等穿越入口收尾后再议

### 7-4 🟢 技术债(不阻塞,实测通过后清理)

- `src/entry.ts` 的 `writeTavernComposer`/`findBestTavernComposer` 死代码(注入合流后无调用,保留过渡)
- `RuinEntryWorkflow.prepareText` 兼容路径(旧 composer 路径用)
- 进入不做 regenerate/reuse 复用(传记有 reuse 语义;若实测需要再按传记升级)
- 通知类型复用 'ruin'(进入与生成共用;并发场景需拆分,暂不做)
- package.json version 与 manifest 不同步(已知,勿动)

---

## 8. 给下一任主管的开工建议

1. **先读**:本文档 → `docs/进入特异点注入合流改造蓝图.md` → `docs/穿越入口数据与通知修复蓝图.md` → `rules/00_README-嵌入规则索引.txt` → `src/entry.ts`(组装视图)
2. **第一件事**:§7-1 圣翼议会问题——按排查方向取证(抓一次生成的资料清单,确认条目在不在;对照契约对组织的约束),形成结论后给用户方案(先不改文件,用户确认再动手)
3. **第二件事**:催用户跑 §7-2 实测清单(或指导用户测),按结果修
4. 之后按 §3.1 流程发版;一切改动保持"蓝图先行 + 逐步跑绿"的节奏
5. 用户偏好中文沟通;用户对"越稳越好/不过度删除/诚实报告"非常在意(包括"这个方案不值得做"也要直说)
