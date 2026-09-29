# 伊雍历史工作台 · 交叉检索、人物事实与 Canon 版本蓝图

> 文档状态：**ACTIVE / PRIMARY**
> 合同版本：2.2（P1-1 与 P2-A 已通过当前可测试真机边界；**P2-B/P2-C 合并真机验收已于 2026-09-17 通过，同为「当前可测试边界」accepted**；P3 已闭合；P4-0 总合同已冻结）
> 上位设计：[01-统一史料检索总设计.md](./01-统一史料检索总设计.md)
> 当前进度：[NEXT.md](../NEXT.md)
> 当前活动阶段：P2-A/P2-B/P2-C 均已 accepted（当前可测试边界，2026-09-17）；P3-0 已冻结，P3-A/P3-B/P3-C 均已完成真机验收，P3-D 文档收口完成（2026-09-20）；P4-0 总合同已冻结（2026-09-22），P4-A 已实施、P4-B/P4-C 已真机验收，P4-C2 合同已冻结未实施，P4-D 未实施（非正式 release）

## 1. 核心目标

交叉检索不是“模块 A 多读几份模块 B 的文件”，而是统一检索内部的一层公共能力：

> 围绕本次任务，从所有开启且在当前版本有效的来源中，跨人物、地点、组织、事件、亲缘、时间和历史 revision 追踪证据，最后向四模块提供同一版本、可解释、用途明确的 EvidenceBundle。

它必须同时解决：

1. **跨实体发现**：点名人物后，能找到必要关系、地点、组织、事件和合适承接者；
2. **跨来源拼合**：人物经历散落在人物条目、世界主设定、MVU、聊天和历史产物时，仍形成一套同源事实；
3. **跨版本仲裁**：世界书原史、一次或多次玩家干涉和旧生成产物冲突时，普通生成只读当前有效版本；
4. **跨产物有效性**：历史改变只让真正依赖该事实的传记段落、谱系 node/edge、墟境节点或蝴蝶 operation 局部失效。

## 2. 统一责任边界

```text
WorldKnowledgeCatalog
  负责：高召回的实体、别名、关系候选、来源和 passage 定位；不作最终语义裁决

确定性检索纪律（internal.72 共证门）
  负责：检索开门权——实体有名（索引实体资格）、长词独证、2 字泛词必须共证；
  括号「(类别/品质)」标注不拆为别名/实体/搜索词；匹配面统一到查询片段集合

CharacterCanonFacts / PersonCanonView
  负责：人物事实、经历、亲缘、状态、生命窗口和任务相关投影

CanonBranch / CanonResolvedView
  负责：当前 revision 中哪些事实和产物片段有效

QualifiedEvidenceView
  负责：有效证据在本轮可作舞台、演员、原因、后果还是背景

模块 prompt / validator
  负责：在同一事实集和同一 revision 上生成与确定性验收
```

任何模块不得自行建立覆盖规则、版本优先级、事实账本或二次选源器。

## 3. 交叉检索三层结构

### 3.1 跨实体

从玩家直接锚出发，沿本地候选关系进行高召回有界扩展；扩展边只接受引用局部 passage、通过引用校验并符合预算的邻接（确定性纪律，不做外部语义裁决）：

```text
人物 ↔ 亲属 / 师友 / 敌手
人物 ↔ 组织 / 神系 / 家族 / 军队
人物 ↔ 地点 / 活动地 / 囚禁地 / 出生地
人物 ↔ 事件 / 时代 / 器物
地点 ↔ 上级疆域 / 下级地点 / 历史事件
组织 ↔ 成员 / 所属势力 / 管辖地 / 参与事件
事件 ↔ 前因 / 承接者 / 载体 / 后果 / 遗迹
```

每次扩展必须回答：为什么与任务相关、是否需要在场、需要哪段证据、在当前 revision 是否有效。固定关键词、名称后缀和整来源共现只能提出候选；不能因为同一条目别处出现过某人物或地点，就把它投射到当前 passage，更不能把整个神系、家族或地区全部塞进 prompt。

### 3.2 跨来源

同一实体的事实按稳定实体 ID 和 fact key 聚合，但保留来源独立性：

- 世界书提供基线；
- MVU/chat 提供当前现场；
- 传记、谱系、墟境提供带 revision 的物化视图；
- 蝴蝶提供玩家行动、delta 和当前有效历史投影。

聚合结果必须保留 `factId/sourceId/snapshotId/sourceSpan/confidence/epistemicStatus`。不能只传人名、摘要或无来源的“已知事实”。

### 3.3 跨版本与跨产物

当前真相不由文档类型排序，而由以下维度共同确定：

- `branchId`；
- `revision` 与 `commitOrder`；
- 稳定 `factKey`；
- `effectiveFrom/effectiveTo`；
- 地理、人物和事件作用域；
- `preconditions/dependsOn/supersedes`；
- 当前 operation 状态；
- 产物片段对事实的依赖。

世界书是 revision 0 的不可变 BaseCanon。有效玩家干涉可以在明确事实键和作用域内覆盖基线；不相关事实继续保留。传记、谱系、墟境和蝴蝶面板不是因为“写过”就自动成为更高真相。

### 3.4 确定性主路径与共证门（internal.71/72）

世界书常按人物、地区、组织和设定条目分散书写，而不是一篇完整历史。语义编译层（SemanticEvidenceCompiler / SemanticEvidenceView / SemanticQueryPlan / EvidenceExpansionRequest）经真实宿主证据污染后已整体撤销（internal.71）：类型与旧诊断字段仅作历史数据兼容，活动入口无引用、构建产物不含编译器。替代方案是**纯确定性检索纪律**，全部在本机完成，无向量、无 embedding、无外部语义服务、无递归补检：

```text
全部开启合格来源
  → CompactKnowledgeDirectory（馆藏目录）
  → 本地高召回 CandidatePassagePool
  → 共证门确定性资格（internal.72）
  → 顶层任务冻结证据，后续扩写不得重选来源
  → 同一 EvidenceBundle 供四模块复用
```

**共证门与同形泛词污染（真机案例：装备品质污染）**。补充方向「英雄史诗」曾把装备品质/技能规则条目召入正文，三条污染通道与对应机制（详见总设计 4.4）：

- **括号别名校验**：「月桂源生匣(物品/史诗)」「锻造匠师 (史诗)」括号内的类别/品质标注（含斜杠或 ≤2 字单档位）不再拆成别名/实体/搜索词——挡掉 `buildEventFrame` 的 `query.includes(别名)` + `catalog-direct` +520 通道（真实数据：污染从 2133 分降至 0 入选）；
- **强词独证 / 弱词共证**：≥3 字或索引实体名（实体资格：玲山、翼民、荷马史诗）可独立开门；2 字非实体泛词（史诗/品质/传说）必须与强词/正文佐证或 ≥2 弱词互证——「英雄史诗」单弱词不开门、「史诗品质装备」三弱词互证照常召回；
- **匹配面统一**：`title-exact` / `indexed-term` / `matchedEntities` 全部收敛到过滤后的查询片段集合，停用词纪律在全部路径生效；
- **实体资格 = 索引实体集合**：「品质」「装备」等字段实体保留为合理锚（需求场景「史诗品质装备」照常召回装备规则条目）。

脚本仍负责：语料守恒、快照哈希、宽召回、切片、引用存在性校验、硬生卒/明确日期/明确地理层级校验、共证门资格、预算、缓存和回执。模型负责正文创作与解释，不负责无引用造事实，也不负责 P1 的版本仲裁。

四模块采用同一顶层任务边界：检索资格确定后冻结 `EvidenceBundle / TaskCitationRegistry / sourceHash`。墟境的 3/4/5 个候选提纲、自动扩写、结构 repair 与失败重试必须复用同一 `RuinContextBundle`；候选标题、演员、地点和节点属于模型产物，禁止反向开启来源。这样既避免候选自证循环，也避免重选来源推翻第一次阅读。

骰表、基调和“史诗感”等创作材料只能影响写法，不得进入世界知识召回查询（检索查询只消费玩家指定的时代、地点、人物、事件和补充方向）。

这一层必须四模块共享。传记不能私读人物全文、墟境不能私建地点表、谱系不能私补人物、蝴蝶不能私选历史版本；它们只能在同一 EvidenceBundle 上做不同叙事投影。

## 4. 人物事实层

### 4.1 CharacterCanonFacts

统一人物事实至少覆盖：

```text
identity       姓名、别名、性别、种族、身份、职业、阵营
lifespan       明确出生、死亡、年龄、抵达与时间基准
relationships 亲属、师友、敌对、组织归属
lifeEvents     离开、抵达、分别、受赠、任职、流放、失踪等经历
currentState   当前地点、身份、装备和有效状态
constraints    明确禁止改写的关系、顺序和状态互斥
```

每条 CanonFact 必须有稳定 `factId`、主体/谓词/客体、认识状态和精确来源。普通历史年份不能误当出生年；只有明确生卒字段、出生语句或有时间基准的年龄字段可以建立生命窗口。

### 4.2 PersonCanonView

PersonCanonView 是按任务和 revision 生成的相关人物视图：

- `requiredFactIds`：任务明确要求、不得颠倒或改写；
- `relevantFactIds`：用于身份、关系、动机和经历支撑；
- `lifespan/personTimeline`；
- `lifeEvents` 的证据集合与有据 `eventRelations`（数组排列不代表 chronology）；
- `currentLocation/currentIdentity/currentEquipment`；
- 状态锚和在场方针；
- TaskAnchorAttachment。

完整人物条目可以作为有哈希的附件进入，但不能在 EvidenceBundle 外形成第二真相。传记 plan/expansion、谱系、墟境与蝴蝶必须消费同一 factId 集合。

### 4.3 事实提取纪律

- 明确字段和直接陈述可为 `explicit/structural`；
- 玩家本轮明确断言标为 `user-asserted`，不得伪装成世界书事实；
- 多来源支持的推断仍为 `inferred`；
- 修辞、暧昧关系和无时间锚状态拿不准时一律 `unknown`；
- 模型生成的新名字、亲缘或生卒不能自动晋升为 explicit。

### 4.4 P0-C · Canon 证据解释与部分顺序

人物条目通常按字段、声部和话题排列，而不是按故事时间排列。因此不得再把 `facts/sourceSpans/worldbook order` 用箭头串成“既定事件链”。共享层必须：

1. 把每桩经历保留为带 `factId`、认识状态、时间/地点域和来源 span 的事件证据；
2. 只从明确日期、明确时序词和可确定结构前提生成 `CanonEventRelation(before/after/requires)`；
3. 对未连接事件保持 `unresolved`，不由脚本猜测唯一顺序；
4. 让模型结合跨条目人物关系、地点可达性、组织/职业前提、物品来历和当前状态，提出有据解释；
5. 解释回执记录所选 hypothesis、使用的 factIds、事件用途、关键假设、置信度与替代解释。

这允许“梅薇娜赠书”既可能是玲山初到帝国时的启蒙，也可能是她进入新闻圈后形成的业内传承，只要各解释都不违反明确事实。`reported/contested` 必须保持为说法或争议；模型不得把它静默升级为唯一真相。

传记复用 eventAssignments 与 reconciliation；墟境候选使用 `canonInterpretation`，同一 Canon 事件只能在一个独立候选中发生。若多个候选专门探索同一未决事件，必须标为 `alternative-interpretation`、给出实质不同的 hypothesis 与替代解释，不能只换年份重演。谱系和蝴蝶消费同一 PERSON_CANON_VIEW；谱系修复链也不得丢失该视图。

## 5. 人物在场与缺席

### 5.1 时间窗口

`deriveFeasibleWindow` 与 `assessPresenceInWindow` 使用当前 revision 的 lifespan/personTimeline：

- 未填写时间时，可用选中人物的最晚出生/抵达下界缩小自动范围；
- 当前剧情时间和目标纪元仍提供上界；
- 界外来客的推断抵达年是解释假说，不是硬门；
- 无可靠窗口时返回 `unknown`，不猜。

### 5.2 不可逆硬门

只有以下状态构成时间硬门：

| 状态 | 处理 |
|---|---|
| `not-born` | 人物不作为在世者出现；可写其到来前的世界、氏族、传统和命运伏笔 |
| `deceased` | 人物不作为在世者出现；可写遗产、余波、纪念、后继者和留下的证物 |

候选确实让不兼容人物作为演员出现时，可走 repair：整体后移时间、换参与者或使用缺席叙事。人物没有出现时不得因为“玩家点名”再强塞进 cast。

### 5.3 可逆状态是受限在场

以下状态不是绝对退场，也不构成时间硬门：

| 状态 | 允许方式 |
|---|---|
| `missing` | 线索、最后踪迹、探明过程；回归需点明曾失踪 |
| `incapacitated` | 躯壳、沉睡、被照护或被利用；不得写成自由自主行动 |
| `imprisoned` | 可在囚禁地点出现；不得在外界自由活动 |
| `exiled` | 可在放逐地、传闻或回归事件中出现 |
| `otherworld` | 可通过异界视角、召唤或回归出现，并点明来源 |
| `erased` | 可匿名、化名或在名册之外出现，但不能假装正式身份未受影响 |

状态提取必须结合时段、语法和上下文佐证。修辞性“仿佛消失”“如同死去”不得机械编译为状态锚。

### 5.4 同岁状态互斥

只有世界书或当前 Canon 明确给出的不可同时成立状态，才能形成硬互斥，例如同一年龄同时处于两个明确冲突地点或身份。相对时序“几年才合理”交给模型排布，不由脚本猜测。

## 6. Canon 版本模型

### 6.1 CanonBranch

```text
CanonBranch（当前聊天）
  ├─ revision 0：BaseCanon
  ├─ revision 1..N：已提交 InterventionAction / InterventionDelta
  ├─ CanonResolvedView(revision=N, queryScope)
  └─ MaterializedArtifacts（绑定某 revision 的物化视图）
```

分支同时记录：

- `commitOrder/revision`：玩家后来做了哪次干涉；
- `effectiveTime`：这次干涉在世界历史中从何时起生效。

后提交行动只在相同事实键和重叠作用域上优先，不能全局覆盖所有历史。

### 6.2 InterventionAction 与 Delta

每次蝴蝶结算保存不可变行动原稿，并把机器可仲裁部分结构化为 delta：

- 原事实引用和原 factIds；
- 操作类型、当前值和旧值；
- effective time 和作用域；
- preconditions、dependsOn、supersedes；
- cascadeScope 与 preserves；
- `active/partially-active/superseded/orphaned/reverted/uncertain`；
- resolution receipt。

自然语言因果阶段可以保留为历史胶囊，但在没有精确事实键前不能静默覆盖 BaseCanon。

### 6.3 resolveCanon 是唯一入口

P1-1 必须实现：

```text
resolveCanon(branch, revision, queryScope) → CanonResolvedView
```

它负责：

1. 加载 BaseCanon 相关事实；
2. 在请求 revision 内按 revision/commitOrder 应用机器可确认的有效 delta；
3. 处理同事实键与重叠作用域覆盖；依赖缺失只做确定性跳过，不在 P1-1 重编因果；
4. 输出当前 facts、inactive 历史、冲突、unknown 和回执；
5. 投影版本化 lifespan、关系、事件和 CanonPassageView；
6. 为 EvidenceBundle、人物在场、角色编排、prompt 和 validator 固定同一 revision。

不允许 Qualified Evidence、传记、谱系或墟境再各自决定哪个版本有效。

### 6.4 P1-0 · 开工前边界合同

P1 不从新增“语义编译层”开始，而从字段权力审计开始。系统必须把信息分为四类：

1. `authoritative`：脚本可确定、可追溯、可回滚的权威结构；
2. `advisory`：模型用于先理解主题、规模、人物与材料角色的软脚手架；
3. `narrative`：模型对分散条目、历史空白与可能因果给出的自然语言解释；
4. `diagnostic`：不进入 Canon、不会直接杀死正文的观察和警告。

`TaskQueryScope` 只能扩展召回，完整玩家 `sourceText` 始终是语义主轴；`EventFrame` 与 `CastManifest` 是编排建议，不是演员白名单或唯一历史解释。模型生成的 hypothesis、taskFit、cast 理由和事件解释默认不持久化为 CanonEventRelation；只有明确日期、明确时序词或可确定结构前提能够进入权威关系。

P1-1 的 `resolveCanon` 必须遵守七条不变量：

1. `BaseCanon` 与 `SourceSnapshot` 不可原地改写；
2. 分支、聊天和 revision 相互隔离，任何读取必须显式绑定三者；
3. 修订采用追加记录，不覆盖或删除历史行动原稿；
4. 只有相同 `factKey` 且作用域重叠的后提交有效 delta 才能覆盖旧值；
5. 不相关事实和非重叠作用域必须继续有效；
6. `unknown/uncertain` 不得静默覆盖 explicit/structural 的确定事实；
7. 回滚同一 revision 后必须确定性恢复相同 CanonResolvedView，四模块必须消费同一视图。

P1-1 开工前冻结以下最小夹具，任何一项失败都不能进入下一阶段：

- 单一明确事实覆盖并回滚：世界书 470 年死亡，干涉改为 458 年；
- 两条不冲突事实同时保留；
- 同一事实只在重叠地点/时间/主体作用域内覆盖；
- 模糊或 `uncertain` delta 不覆盖明确旧事实；
- 同一 passage 同时含失效事实和仍有效事实时只做事实级遮蔽；
- 两个聊天/分支互不串线；
- 传记、谱系、墟境、蝴蝶在同一次任务中读取相同 revision 与 CanonResolvedView。

明确排除：模型自证式硬校验、`taskFit` 逐字/数量/三向考卷、语义编译器回归、用单例补丁扩展本体、让四模块自行猜版本、把 P2—P4 能力提前塞进 P1。P1-1 第一版不得调用模型；自然语言冲突协调仍留在 P3 的有界 `canon-reconcile`。

### 6.5 P1-1 · resolveCanon 最小合同（FROZEN）

唯一公开入口保持：

```text
resolveCanon(branch, revision, queryScope) → CanonResolvedView
```

**输入合同**：

- `branch` 必须是当前 `characterKey + chatId` 对应的 `CanonBranch`；禁止跨聊天借用；
- `revision` 必须是 `0..branch.headRevision` 内的明确整数；不得在缺失或非法时静默退回 head；
- `queryScope` 只限定本次需要投影的主体、时间、地点与来源范围，不创造事实、不改变 delta 优先级；
- BaseCanon、SourceSnapshot、CanonFact、InterventionAction 与 InterventionDelta 均为只读输入；resolver 不写库、不修正文、不调用模型或网络。

**最小裁决算法**：

1. 验证 branch/revision，并建立目标 revision 内 `active` 的 revision 链；`reverted/orphaned` 不生效但保留审计可见性；
2. 加载 queryScope 命中的 BaseCanon 事实，以及裁决这些事实所需的原 fact、显式依赖和来源 span；
3. 只应用 `verified=true`、状态 active、revision 不晚于目标、依赖 delta 可见且 operation 来源可追溯的 delta；其余逐项跳过并写入 receipt，不允许整视图回退 legacy；
4. 以 `factKey + 重叠作用域` 为覆盖边界：`replace/retract` 只退休其 `originalFactIds`；`assert` 不删除其他 factKey；后提交不能全局覆盖无关事实；
5. `unknown`、未验证、缺依赖、缺原 fact 或作用域不可判定的 operation 不覆盖确定事实，进入 `uncertainItems/skippedDeltaIds`；
6. 从最终 active facts 投影 lifespan、关系、事件和 `CanonPassageView`；混合 passage 只遮蔽失效 span，不能安全分割时输出当前 fact capsule 并保留原文只读历史；
7. 返回稳定、可缓存、可审计的 CanonResolvedView；相同 branch/revision/queryScope/BaseCanon 输入必须得到语义等价结果。

**最小输出合同**：

```text
CanonResolvedView
  schema / branchId / requestedRevision / resolvedRevision / queryScopeHash
  activeFacts[]
  inactiveFacts[] { fact, retiredByDeltaId, reason }
  uncertainItems[]
  eventRelations[] / personViews[] / passageViews[]
  resolutionReceipt
```

`activeFacts` 是四模块唯一可用于“当前真相”的事实集合；`inactiveFacts` 只供历史、诊断和回滚，不得进入普通正文供模型自由二选一。输出不包含模型 hypothesis、`taskFit`、文风、骰表或正文评价。

**失败与降级**：非法 branch/revision、BaseCanon 读取失败属于硬失败，禁止静默读取旧镜像；单个坏 delta/operation 属于局部跳过并诊断；没有有效 delta 时正常返回 revision 0 等价视图；P1-1 不产生 `partially-active/orphaned` 的新语义重基线结论，这属于 P3。

### 6.6 连续状态、玩家意图与软硬边界（FROZEN ADDENDUM）

本节冻结跨模块消费 `CanonResolvedView` 时的共同原则，不扩张 P1-1：`resolveCanon` 仍是纯确定性、无模型、无网络、只读的事实解析器；玩家自然语言的理解和具体历史创作发生在模块投影层，永久 Canon 变更仍须经过干涉、回归或蝴蝶链路形成可审计 delta。

**核心宗旨**：结构负责事实边界，模型负责语义理解与创作；结构不得替模型理解玩家，模型不得越过结构抹除已经确定的前史。

系统必须区分三层，不得把它们压成一个布尔状态：

1. **发生事实**：例如“某人曾被监禁”。一旦成为当前 revision 的有效事实，后续越狱、获释或刑满只会改变其后续状态，不会让监禁从历史上消失；
2. **持续状态/区间**：例如监禁从某时开始，在越狱、释放、死亡或 revision 终点结束。查询时点落在区间内，才投影“正在服刑”；落在区间后，投影“曾被监禁”及后果；
3. **状态转移**：例如越狱、获释、改判、再度收监。新转移可以结束或改变持续状态，但不能默认撤销它所依赖的发生事实。只有玩家明确要求“从未被监禁”一类前史撤销，并经正式 delta 的 `replace/retract` 裁决，才能让原事件退出当前 Canon。

这套规则不局限于死亡或监禁，也适用于失踪、失能、流放、通缉、任职、组织归属、婚姻与亲缘、盟敌关系、伤病与诅咒、治愈、迁徙、领地、物件持有、身份与声誉等开放状态。不得为这些状态建立封闭枚举或按固定关键词拆解玩家句子；新增领域应扩展通用事实/事件/区间/转移表达，而不是追加人物、地点或动词特例。

| 层 | 可以约束什么 | 不得承担什么 |
|---|---|---|
| 结构化 Canon | `branch/revision/entityId/factKey`、时间与地点作用域、来源与依赖、事实是否发生、状态区间、转移前后、active/inactive/uncertain | 不猜玩家真正想写什么，不规定唯一剧情机制，不把可逆状态自动等同死亡或绝对缺席 |
| 玩家原句与任务意图 | 明确本轮要延续、挑战、改变或撤销什么；原句必须完整保留给模型 | 不因分词、关键词或字段缺失被脚本改写成另一项任务 |
| 模型推理与创作 | 结合当前 Canon 理解玩家意图，选择可成立的动机、过程、代价、参与者和历史空白解释 | 不得把 inactive 事实当当前真相，不得跨分支借事实，不得无声否认已经发生的前置事件 |
| 确定性校验 | 拦截非法 branch/revision、错误实体绑定、明确时空冲突、inactive 冒充 active、无授权撤销前史、机器协议错误 | 不审判剧情是否“够合理”，不做关键词考卷，不要求模型输出封闭的语义自评 |

模块消费时遵守以下决策顺序：

1. 用稳定 `entityId + branch + revision + queryScope` 重新解析当前状态，不能直接继承旧产物正文中的人物状态；
2. 若玩家未提出改变，当前状态及已发生前史是连续性前提：监禁中人物默认受限在场，监禁结束后仍保留坐过牢的经历与后果；
3. 若玩家明确提出改变，将原句理解为**建立在当前 Canon 之上的候选状态转移**：例如“在服刑期间越狱”应允许策划越狱，同时保留被捕、入狱和服刑这一前史；
4. 若玩家明确要求撤销前史，先把它识别为 retcon 意图，进入正式干涉与 delta 流程；普通传记、谱系或墟境创作不能顺手完成永久撤销；
5. 模型可以对材料未定之处提出多种可成立解释，但不能改变结构已确定的版本、作用域和前置事实；脚本不得为了追求“正确”而把这些合理空白冻结成唯一答案。

状态转移分阶段生效：墟境候选或普通生成中的变化只属于任务局部 hypothesis；玩家选中目标并进入后可成为分支草案/干涉目标；只有遣返、蝴蝶结算或其他明确提交链产生并验证 delta 后，才成为未来四模块共同读取的 active Canon。候选被拒绝、任务失败或未提交时，不得污染后续任务。

冻结句：**玩家明确要求的变化，应被解释为建立在当前 Canon 连续性之上的新状态转移；除非玩家明确要求撤销前史，否则不得为了实现新变化而否认其前置事件曾经发生。**

## 7. 世界书事实级遮蔽

SourceSnapshot 永远保留原文。若某段同时包含失效事实和仍有效事实：

- 保留仍有效的地点、组织、人物或制度 span；
- 只遮蔽被 delta 改写的事实 span；
- 原事实仍存在于带 inactive 标签的历史视图；
- 无法安全分割时，给模型当前事实的 `fact-capsule`；
- 不把整段矛盾原文交给模型自由选择；
- 回滚对应 revision 后，原 span 自动恢复资格。

这取代旧 `applyTimelineRevisions` 的整来源打补丁方案。

## 8. 跨产物依赖与局部失效

P2 起，产物不能只绑定整篇 revision；必须细到：

| 产物 | 最小绑定单位 |
|---|---|
| 传记 | origin/stage/status 段落与事实锚 |
| 谱系 | node、edge、亲缘和生卒事实 |
| 墟境 | candidate、node、history span 和任务锚 |
| 蝴蝶 | action、delta operation、panel 片段 |

每个单位先由 `ArtifactCanonBinding` 保存 branch、revision、稳定 entityIds 与实际采用的 factIds/operations；P2-B/P2-C 再据此派生状态、失效原因和恢复条件，不把这些可变结论写回不可变绑定。用户从旧谱系、传记或墟境中选择某人物时，选择动作只携带稳定实体身份与本轮任务意图；不得把旧产物正文、旧 revision 状态或“必须肉身在场”一并强塞给新任务。

### 8.1 P2-A · ArtifactCanonBinding 最小合同（FROZEN / IMPLEMENTED / ACCEPTED）

P2-A 只回答一个问题：**某个已经通过校验并提交的产物单位，在生成时实际依赖了当前 Canon 视图中的哪些稳定实体、事实和已应用 operation。** 它只建立可审计依赖，不判断产物是否失效，不改变检索、正文、工作台展示或聊天注入。

```ts
interface ArtifactCanonBinding {
  schema: 'eyon.canon.artifact-binding.v1';
  bindingId: string;
  branchId: string;
  artifactType: 'biography' | 'genealogy' | 'ruin' | 'butterfly';
  artifactId: string;
  unitType: string;
  unitId: string;
  boundView: {
    viewId: string;
    resolvedRevision: number;
    queryScopeHash: string;
  };
  entityIds: string[];
  factIds: string[];
  operationRefs: Array<{ deltaId: string; factKey: string }>;
  sourceRefs: string[];
  createdAt: number;
}
```

字段权力固定如下：

- `artifactId + unitType + unitId` 指向不可变的产物局部单位；同一产物重建产生新记录，不原位篡改旧绑定；
- `boundView` 必须逐字来自该任务实际消费的 `CanonResolvedView`，不得在提交后重新查询另一个 revision；
- `entityIds` 只登记该单位结构化结果中实际使用的稳定实体；人物仅被本轮目录看见但未进入该单位，不得形成依赖；
- `factIds` 只登记经 Citation Contract v2 解析、事件账本、谱系证据名册或当前视图结构字段确认被该单位实际采用的 active fact；不得从成稿自然语言做关键词反推；
- `operationRefs` 只登记 `resolutionReceipt.appliedDeltaIds` 中、且能由该单位实际采用事实追到的 `deltaId + factKey`；不得把整条 revision 的全部 operation 批量绑定给所有产物；
- `sourceRefs` 仅供来源审计和旧记录兼容，不能代替 fact 依赖，也不能因为共享同一世界书条目就让整篇产物一起失效；
- 数组排序、去重和 `bindingId` 生成必须确定性；相同输入重复执行得到语义等价绑定；
- P2-A 不持久化 `current/stale/orphaned/uncertain` 等派生状态。状态计算、失效原因、检索过滤和回滚恢复属于 P2-B/P2-C。

### 8.2 各模块最小绑定单位

| 模块 | P2-A 必须记录 | P2-A 不得做 |
|---|---|---|
| 传记 | `origin`、每个 `stage.id`、`status` 分别绑定；沿用已解析 eventId/factId、实际人物实体与来源 | 不因全篇提过某事实而把所有时期绑定到它；不解析正文猜依赖 |
| 谱系 | `node.id` 与 `edge.id` 分开绑定；亲缘、生卒与身份事实只进入实际使用它的节点或边 | 不因一个节点变化让整棵谱系自动失效；不推断未知受孕或亲缘时间 |
| 墟境 | `candidate.id` 的任务锚、`candidate:history` 与每个 `node.id` 分开绑定；只使用提纲/扩写已解析的事实句柄 | 不把共享 EvidenceBundle 中所有可见事实绑定给每个候选；不改变候选正文 |
| 蝴蝶 | `actionId`、每条 `deltaId + factKey` operation 与 panel 片段可建立本地绑定 | 不要求或伪装已经存在普通聊天注入链；不以面板文案替代 operation 真相 |

### 8.3 写入、兼容与失败降级

1. 绑定只在产物通过现有 schema/来源/时空校验、即将或已经提交本地仓库时生成；不得让模型新增 `ArtifactCanonBinding` 输出字段。
2. 第一版不得新增模型调用、网络、向量、embedding、检索提示词或 repair 路径；输入仅来自现有 `CanonResolvedView`、Citation v2 解析结果和各模块已验证结构字段。
3. 旧产物没有绑定时状态为 `unbound`，继续可读、可搜索、可引用；P2-A 不后台扫描旧正文、不自动回填、不把 `unbound` 冒充 `current`。
4. 单条绑定无法建立时，产物原稿仍可提交并留下有界 `binding-missing` 诊断；不得新增面向模型的硬错误或让整次生成重跑。进入 P2-C 前，任何 `unbound/binding-missing` 单位都不得参与自动失效裁决。
5. 绑定记录不得复制世界书正文、prompt、传记全文或蝴蝶面板全文；只保存稳定 ID、视图身份和必要来源引用。
6. 删除产物时可删除其绑定索引；删除/回滚 Canon revision 不改写绑定原稿，后续阶段按保存的 `boundView` 和当前视图重新评估。

### 8.4 P2-A 明确不包含

- 自动标记 `partially-stale/stale/orphaned/uncertain`；
- 普通检索排除失效片段；
- 工作台失效角标、比较模式或一键修复；
- `canon-reconcile`、跨干涉重基线或玩家自然语言 retcon 仲裁；
- 普通聊天中的蝴蝶效应/传记记忆注入；当前没有该注入链，因此本阶段不得把“聊天中看见蝴蝶变化”列为可验收项；
- 世界书镜像退役或历史产物物理删除。

### 8.5 P2-B · 局部状态评估最小合同（FROZEN / IMPLEMENTED / AUTOMATED）

P2-B 只回答一个问题：**将某条不可变 `ArtifactCanonBinding` 与同一分支的目标 `CanonResolvedView` 比较后，该产物局部单位所依赖的事实和 operation 是否仍然成立。** 它产生可重算的派生判断，不修改绑定、产物原稿、Canon、检索结果或工作台展示。

```ts
interface ArtifactCanonAssessment {
  schema: 'eyon.canon.artifact-assessment.v1';
  assessmentId: string;
  bindingId?: string;
  artifactType: 'biography' | 'genealogy' | 'ruin' | 'butterfly';
  artifactId: string;
  unitType: string;
  unitId: string;
  comparedView: {
    branchId: string;
    viewId: string;
    resolvedRevision: number;
  };
  eligibility: 'assessable' | 'unbound' | 'binding-missing';
  status?: 'current' | 'partially-stale' | 'stale' | 'orphaned' | 'uncertain';
  activeFactIds: string[];
  inactiveFactIds: string[];
  unresolvedFactIds: string[];
  activeOperationRefs: Array<{ deltaId: string; factKey: string }>;
  inactiveOperationRefs: Array<{ deltaId: string; factKey: string }>;
  reasons: Array<{
    code: string;
    factId?: string;
    deltaId?: string;
    factKey?: string;
  }>;
}
```

字段权力与输入边界固定如下：

- 评估输入只来自 P2-A 绑定、同一 `branchId` 的明确目标 `CanonResolvedView`，以及该视图已有的 resolution receipt/只读 operation 状态；不得调用模型、网络或正文解析器；
- 比较范围必须覆盖绑定中实际记录的 `factIds/operationRefs`。普通任务的窄 `queryScope` 若不足以覆盖全部依赖，只能得到 `uncertain`，不得把“本次没查到”误判为失效；
- `sourceRefs` 只用于审计，不参与状态裁决；世界书条目、传记或聊天来源仍存在或消失，不能单独令一个单位 stale；
- `entityIds` 只用于稳定身份和范围校验；实体仍然存在不代表其旧状态仍有效，实体未被本次目录召回也不代表失效；
- `assessmentId`、数组排序、去重和 reason 顺序必须确定性；同一 binding 与同一目标视图重复评估得到语义等价结果；
- assessment 是派生结果。第一版按需计算，可做有界缓存，但不得写回不可变 `ArtifactCanonBinding`，也不得把旧 assessment 当作下一次判断的真相。
- `eligibility='assessable'` 时必须存在 `bindingId` 与 `status`；`unbound/binding-missing` 只保留产物单位身份与原因，可省略 `bindingId/status`，不得伪造一条可评估绑定。

### 8.6 P2-B 状态裁决

状态只描述**依赖有效性**，不是文章质量、历史合理性或是否值得保留：

1. `current`：所有已记录事实仍在 `activeFacts`，所有已记录 operation 仍为当前有效；没有 fact/operation 依赖的合法绑定也保持 current。目标 revision 比生成 revision 更新，本身不构成 stale。
2. `partially-stale`：至少一项依赖仍有效、至少一项已被确定性退休或撤销；只影响该局部单位，不向兄弟段落、节点、边或候选扩散。
3. `stale`：该单位所有可裁决的事实/operation 依赖均已被确定性退休、替换、撤销或不再应用，且没有依赖缺失造成的不确定性。
4. `orphaned`：绑定依赖的 operation 仍可识别，但其明确前提或上游 delta 已在当前分支中成为 orphaned；不得仅因事实变化“看起来像断链”就推断 orphaned。
5. `uncertain`：依赖无法在完整比较范围内归入 active/inactive，operation 状态不可判定，或输入视图/分支身份不完整。`uncertain` 不得静默降成 stale，也不得进入自动删除、过滤或 repair。

优先级固定为：输入不具备评估资格时保留 `unbound/binding-missing`；可评估但存在明确 orphaned 依赖时为 `orphaned`；存在无法裁决依赖时为 `uncertain`；其余再按有效/失效依赖的全量或混合情况得到 `current/partially-stale/stale`。回滚到依赖重新有效的 revision 后必须重新得到 `current`，不能靠手工清除旧状态恢复。

### 8.7 P2-B 写入、降级与明确排除

- P2-B 第一版只新增纯评估函数、必要的只读聚合与诊断；不得修改四模块 prompt、模型调用、Citation Contract、检索排序、生成正文或现有产物 schema；
- `unbound` 与 `binding-missing` 继续可读、可搜索、可手动引用，只是不具备自动失效裁决资格；
- 单条 assessment 失败只留下有界诊断，其他单位继续评估；不得让传记、谱系、墟境、蝴蝶生成失败或重跑；
- 不把一个单位的状态传播给整篇产物；产物级汇总若提供，只能是局部 assessment 的确定性只读汇总，不能产生新的失效理由；
- 不自动过滤普通检索、不注入普通聊天、不显示工作台角标、不提供比较/修复按钮、不改变候选能否进入；这些属于 P2-C 或后续交互阶段；
- 不进行自然语言 retcon 仲裁、跨干涉重基线或 `canon-reconcile`；这些仍属于 P3；
- 不后台改写、删除或重新生成任何旧产物，也不退役世界书镜像。

### 8.8 P2-C · 局部失效消费与展示最小合同（FROZEN / IMPLEMENTED / AUTOMATED）

P2-C 第一版只把 P2-B 的判断变成**当前可见、可导出、可由消费者安全采用的结论**。它直接以当前 `CanonBranch.headRevision`、不可变 binding 与 append-only delta 链重建紧凑目标，不等待下一次传记/墟境生成刷新缓存，也不解析旧正文猜依赖。

消费规则固定为：

1. `current → available`：正常可用；revision 变新本身不构成失效。
2. `partially-stale → available-with-warning`：原单位继续保留，只显示局部变化警告；不得因为一项事实变化封杀整段。
3. `stale/orphaned → excluded`：只阻止该局部单位的自动复用；原稿、binding、旧 assessment 和审计链全部保留可读。
4. `uncertain/unbound/binding-missing → manual-review`：不自动过滤、不隐藏、不修复、不推断为 stale。

设置页“数据管理 → Canon 局部状态”是第一版正式消费者：展示当前 head、active/reverted/orphaned revision，显示 actionRecord、delta operation 数量与局部消费结论，并允许导出无 API 密钥的 JSON 报告。报告有界：变更最多 128 条、assessment/decision 最多 512 条。它不新增模型或网络请求。

第一版明确不做：把蝴蝶或传记记忆注入普通聊天、修改四模块 prompt、自然语言 retcon 仲裁、自动 repair、删除/重写旧产物、跨干涉重基线、世界书镜像退役。普通生成源的细粒度物理裁剪必须等真实宿主确认局部单位身份映射后另开小门，不能把 `manual-review` 当成过滤依据。

历史改变后：

- 只让依赖失效事实的单位变为 `partially-stale/stale/orphaned/uncertain`；
- 无关部分继续 `current`；
- 普通检索排除失效片段；
- 比较模式可显示旧版本及原因；
- 回滚恢复事实后，对应片段可确定性恢复；
- 不后台删除或改写玩家看到的原稿；
- 新任务按当前 branch/revision 重解析被选实体：旧稿仍作为历史档案可读，但其中失效状态不得冒充当前事实。

## 9. 交叉干涉重基线

> P3-0 详细合同见 [04-P3确定因果冲突与局部重基线蓝图.md](./04-P3确定因果冲突与局部重基线蓝图.md)。该文档已冻结；P3-A、P3-B、P3-C 均已实现并通过真机验收，P3-D 已完成文档收口。P3-C 第一版只在确定性重基线留下的最小 unresolved 前沿进行一次有界协调，逐项校验后与当前 intervention 原子提交；其余路径零调用，失败局部 uncertain 且不截断遣返。R5—R7 真机证据确认：确定性路径零调用、本轮新生断链结果可进入协调、坏提案局部丢弃、direct 根与无关事实受保护、删除遣返楼后父版本与旧支撑自动恢复。主边界仍固定为：无明确冲突即 no-op、无明确依赖不传播、背景事实走正常检索、direct 根不可被结果反推、uncertain 停止扩散。P4 未授权。

P3 处理后一次干涉改变前一次干涉前提的情况：

```text
resolve
  → invalidate affected operations
  → rebase surviving dependencies
  → bounded canon-reconcile（仅无法确定的局部）
  → verify
  → publish CanonResolvedView
```

要求：

- 前提明确失效时，旧 operation 不得继续伪装 active；
- 不相交 delta 保持有效；
- 无法机械证明的级联标为 `uncertain`，不能让模型永久编造新正史；
- `canon-reconcile` 最多一次、有界、结构化输出、必须通过隔离校验；
- 删除后一次干涉楼层时，先前 revision 和依赖产物可以恢复。

## 10. 四模块投影

### 10.1 传记

- 使用人物完整事实、亲缘身份、经历链、当前装备和当前 revision 生卒；
- plan 与全部 expansion 使用同一 PersonCanonView；
- 既定事件有有效年份时对齐，不另造冲突年份；
- 人物缺席时可做时间缺席溯源；
- P4 起共享同 revision、带来源且通过校验的生成事实锚，但不提升为高权正史。

### 10.2 墟境

- 先按时代、地理、事件和 Canon 资格编排舞台与 cast；
- 应出现者有权威人物事实和 passage，不应出现者走缺席或受限在场；
- 地点只能作为舞台、范围内地点或外部参照，不能因相关性偷换舞台；
- 候选、计划、扩写和 validator 固定同一 revision；
- 未选择候选是分支草稿；正式提交或进入后的产物仍需版本绑定，不能用“墟境永远最低权威”概括所有状态。

### 10.3 谱系

- 只接纳有来源的 explicit/structural/user-asserted 人物和亲缘；
- `maxPerGeneration` 是软目标和硬上限，证据不足允许只生成中心人物；
- 不用旧传记或旧谱系的无上游生成名字证明其存在；
- strict 只校验当前 revision 内明确生卒和亲缘一致性；
- ageBased、arrivalBased、推断出生不能作为硬事实；
- P2 起 node/edge 分开绑定和失效。

### 10.4 蝴蝶效应

- 负责生成干涉行动和 delta 候选，不负责独立仲裁整个世界；
- 历史演变必须有分歧瞬间、第一承接者、传播载体、阻力/误读/利益转移或代价、现世证物；
- 既有具名人物只有在年代和资料支持时承担职责，否则使用匿名社会角色；
- 不借蝴蝶效应创造新正史名人、亲属或子嗣；
- operation 状态和当前有效投影由 CanonResolvedView 决定。

## 11. 蝴蝶记忆与世界书镜像退役

目标是让当前分支仍有效的改变后历史进入正文，同时避免全局世界书残留。顺序固定：

1. 完成 P1 当前版本过滤；
2. 本地 ButterflyRecord 保存不可变 action/panel 原稿；
3. 工作台档案从本地记录读取，并显示 branch/revision/operation 状态；
4. 当前有效的近期变化通过私密 `CANON_MEMORY` 注入正文；
5. 更早有效变化按实体、地点、事件和同义词相关性触发；
6. superseded/orphaned/reverted 片段不进入普通正文；
7. 验证切聊天、删楼回滚和档案查看；
8. 最后才删除 `mirrorButterflyRecord`、`eyon_butterfly_anchor` 筛选和镜像可见性链路。

不得在替代记忆通道和本地档案验收前直接删镜像。

> **状态（internal.86 / 2026-09-17）**：第 1—4 步与第 7 步的机制侧已就位——当前版本过滤（P1-1）、本地 ButterflyRecord 原稿、工作台档案读本地、`CANON_MEMORY` 私密注入、按实体/地点/事件/关键词触发更早有效变化、失效片段隔离、切聊天与删楼刷新均已实现；**第 8 步（删除 `mirrorButterflyRecord`、`eyon_butterfly_anchor` 筛选与镜像可见性链路）于 internal.88 执行完毕**（见下），第 3 步的"工作台档案列表读本地（含视图投影）"亦随步 B 收口。

> **internal.88 收口（2026-09-17）**：第 8 步完成——镜像写入／可见性切换／`archiveTitle`／`butterflyArchiveKeywords`／`activateCurrentNamespace` 已删，`ArchiveAdapter` 缩为 `retireLegacyMirrors`（摘全局绑定 + 删脚本自建条目，**不删世界书文件**），工作台设置行改为"已退役 + 清理镜像"；**蝴蝶检索源改由 `runtime/butterflySources.ts` 从本地记录 + `resolveCanon` 投影供给**（修正旧行为：镜像时代以"条目启用"当有效性，已回滚档案仍进候选池）。删除镜像链路前已获得准入证据：在镜像取消挂载的窗口内，`CANON_MEMORY` 独立承担正文可见性（真机命中注入独有词「兄弟会」「铁律」）；internal.90 累计真机验收进一步确认清理、遣返、检索与正文可见性无回归。

## 12. 实施阶段

### P0-A · 人物事实收口 — IMPLEMENTED / 待真机

- CharacterCanonFacts、PersonCanonView、TaskAnchorAttachment；
- 来源 span 和任务 fact 筛选；
- 生卒与普通历史年份分离；
- 长人物条目经历读取；
- 四模块共享人物事实。

### P0-B · 版本骨架 — IMPLEMENTED / 待真机

- CanonBranch、Revision、Action、Delta、Receipt；
- chat-scoped IndexedDB；
- append-only；
- 删除最新 revision 回父版本；
- 删除早期 revision 后继效果降为 orphaned；
- 尚不提供普通检索当前真相。

### P0-C · 证据解释与部分顺序 — IMPLEMENTED / 待真机

- CanonFact 扩充 reported/contested、时间域和地点域；
- CanonEventRelation 只编码有据先后与前提，来源/数组顺序不再当作 chronology；
- 四模块共享 PERSON_CANON_VIEW，谱系 repair 也保持同源；
- 传记规划显式选择有据解释并记录 reconciliation；
- 墟境输出 canonInterpretation，阻止同一既定事件在独立候选中换年份重演；
- 对语焉不详事件允许多个有证据、可审计的替代解释。

### P0-D · 确定性主路径 + 共证门 — IMPLEMENTED（internal.71/72）/ 待真机

语义编译层已撤销（internal.71）；以下为取代它的确定性主路径与共证门（internal.72）：

- CompactKnowledgeDirectory：向模型展示全部开启合格来源的可读目录，不注入整本正文；
- CandidatePassagePool：本地规则只做宽召回，不作最终实体类型与关系裁决；
- **括号别名校验**（catalog.ts / index.ts 同款）：括号「(类别/品质)」标注（含斜杠或 ≤2 字单档位）不拆成别名/实体/搜索词；
- **共证门**（rankDirect）：强词（≥3 字或索引实体名）独证开门；2 字非实体弱词必须与强词/正文佐证或 ≥2 弱词互证，弱词命中 strongSearchTerms 不再直接开门；
- **匹配面统一**：`title-exact` / `indexed-term` / `matchedEntities` 收敛到过滤后的查询片段集合；
- **实体资格 = 索引实体集合**：「品质」「装备」字段实体保留为合理锚（「史诗品质装备」需求场景照常召回）；
- Citation Contract v2 / TaskCitationRegistry：EvidenceBundle 统一拥有 P/F/E/S 短句柄到内部 passage/person fact/world event/source 主键的映射；四模块模型边界与解析器已统一迁移，旧 snapshot/source/passage 别名补丁已删除；
- 四模块共享同一冻结检索视图；墟境的提纲、全部候选扩写、repair 和重试持久化复用同一 `RuinContextBundle`；
- 创作基调与骰表不进入检索查询；
- 全程不使用 embedding、向量库或外部语义服务。

### P1-0 · 字段权力与开工边界 — FROZEN / DOC-ONLY

- 四类字段权力等级；
- 七条 Canon 不变量；
- 七个最小验收夹具；
- 语义编译与自证式硬门排除项。

### P1-1 · 唯一当前视图 — ACCEPTED（当前可测试边界）

- `resolveCanon`；
- 版本化 lifespan/关系/事件；
- `<CANON_CURRENT_VIEW>`；
- CanonPassageView；
- 四模块同 revision；
- Qualified Evidence 改为消费 Canon 结论。

实施边界：`resolveCanon` 是纯确定性只读函数，无模型、无网络；四模块在统一 Active Retrieval 完成后、模型正文投影前读取同一聊天分支和 head revision。当前实现不会进行 P2 产物失效、P3 自然语言重基线或镜像物理退役。RC-01—RC-07 已通过自动化；驾驶员已在真实酒馆完成档案替换、回滚、混合事实遮蔽和分支隔离的当前可测试场景。严格的蝴蝶 action/delta→普通聊天注入链尚不存在，不能伪装为 RC-02/RC-07 的完整正文可见性验收，也不阻塞只记录依赖的 P2-A。

### P2-A · 依赖记录 — ACCEPTED（当前可测试边界）

- `ArtifactCanonBinding` 最小合同；
- 四模块局部单位映射；
- 确定性采集、旧产物 `unbound` 兼容与 `binding-missing` 降级；
- 只读诊断所需最小信息。

第一版已经完成类型、本地产物内嵌存储、四模块校验后采集、确定性绑定、旧产物 `unbound` 兼容、单单位 `binding-missing` 降级和只读诊断入口。AB-01—AB-08、typecheck、全量回归与构建已通过；驾驶员在真实酒馆生成新传记与新墟境并确认正文未被绑定层截断，导出的只读诊断为 2 个新产物全部 `bound`、45 条局部绑定、`bindingMissing=0`、`failures=[]`。旧产物兼容无现成真机样本，保留为自动化覆盖边界，不阻止本阶段接受。

### P2-B · 局部状态评估 — ACCEPTED（当前可测试边界，2026-09-17）

- 基于 ArtifactCanonBinding 与同分支当前 CanonResolvedView 的纯确定性派生评估；
- 局部单位 `current/partially-stale/stale/orphaned/uncertain`；
- `unbound/binding-missing` 保持不可自动裁决；
- 只读诊断与回滚后的确定性恢复；
- 不改正文、prompt、检索或工作台展示。

第一版已完成纯评估函数、同分支 Canon 目标投影、有界只读诊断与公开门面。AS-01—AS-10 共 11 项专项测试通过，typecheck、生产构建与 477 项全量回归通过。真实宿主目前既无法向驾驶员展示可核验的蝴蝶 Canon 变化日志，也没有把变化送入后续正文的消费链，因此“无关 revision、局部事实替换、回滚恢复”三场真机验收延期；不得标记 accepted，也不得用构造数据冒充真机证据。

### P2-C · 局部失效消费与展示 — ACCEPTED（当前可测试边界，2026-09-17）

- 当前 head 的 revision/action/delta/operation 与局部 assessment 可见、可导出；
- `available/available-with-warning/excluded/manual-review` 消费合同已冻结；
- 回滚后按当前分支即时重算，不等待下一次生成；
- 仍不后台删除或改写原稿，不把不确定项判废。

P2-C 第一版源码与自动化门已于 2026-09-01 完成：PC-01—PC-10、typecheck、生产构建与 487 项全量回归通过。**合并真机验收已于 2026-09-17 通过**（场景 1 无关 revision 不误伤；场景 2 生成侧经 internal.82 F-01/F-02/v5 修复后完整体现干涉；场景 3 删楼回滚恢复、场景 4 导出对账与确定性、场景 5 全程约束均由驾驶员报告通过）；评估侧「部分失效」（AS-03/PC-03）按边界收口 2A——真机模型不输出同事实 replace/retract，该态自然玩法不可触发，以自动化证据 + 生成侧真机已验收口，机制补齐列 P3-0 候选。自动 repair、自然语言 retcon 仲裁和跨干涉重基线仍未进入；普通聊天正文注入、世界书镜像退役与直接变化入 Canon 已由 internal.86—90 累计真机验收。

### §6 步 A · 蝴蝶记忆注入通道 — ACCEPTED（当前可测试边界，internal.90 累计验收）

- 目标：当前分支仍有效的改变后历史**直接进入普通正文**，不再只存在于生成任务内的 `<CANON_CURRENT_VIEW>`；
- 有效性判定与 P2-B 评估同源（记录级 + delta 级确定性子集，不依赖检索 Bundle）；
- 分层注入：常驻（当前有效序列最近 1~2 条）+ 触发式（更早仍有效者按关键词匹配），总预算 2400 字、单条摘要 320 字；
- 关键词：硬词（有效 operation/cascadeScope 专名，命中 ≥1 即触发）+ 软词（模型 `historicalKeywords`，≥2 或 1 稀有词才触发），泛词停用表兜底；
- 注入：ST `setExtensionPrompt`（key `eyon_canon_memory`、in_chat、depth 0、system），块体 `<CANON_MEMORY branch revision>`；刷新于生成前 / 切聊天 / AI 楼渲染后 / 删楼 / 手动，注入空串即清除；
- 诊断：工作台「数据管理 → 蝴蝶记忆注入」——状态徽章、revision 与触发时机、计数、失败行、注入全文、逐条判定（硬软关键词/命中词/入选原因）、重新计算与导出 JSON；
- 不做（步 A 范围）：传记 digest 双源（§6.5 源 B）、向量/语义匹配；世界书镜像退役已由 **internal.88（步 B）** 执行，见 §11 状态块。
- **源 B 现行合同（2026-09-27，未实施）**：见 [G-08普通正文传记冲突感知合同.md](./G-08普通正文传记冲突感知合同.md)。源 B 必须按相关性成簇消费 P4-C 两侧视图，不能压平成单一结论；Canon 源 A 永远优先，人物只在自身认知范围内怀疑、求证或误解。合同不固定冲突解释或人物反应类型，模型须把已有成因或有界推断自然融入正文。
- 真机首份证据（2026-09-17）：通道跑通，常驻层正确，digest 形态与预算合规，`runId` 与 internal.84 墟境轮次同源，模型关键词零泛词。
- 真机暴露待改项（见 NEXT §3 G-09/G-10）：①硬词池混入 `carrier` 长句与 `locationChain` 整链（应只留专名；地点链复用 `territorialFragments`）；②模型 `historicalKeywords` 被并入硬词池、偏离"硬词仅从 delta 提取"的 §6.5.1 口径；③关键词是概括短语而非字面形态（"麦堆禁忌" vs 正文"麦堆里的第三只眼"）⇒ 逐字匹配欠召回，属 §6.5.3 未做；④档案删除不回滚正史 ⇒ 仍 active 的干涉在记忆通道无简报（设计边界，待定处置）。
- 口径修正：`RESIDENT_LIMIT=2` 使最近 1~2 条恒为常驻注入，"零注入"只能理解为"旧档案不因无关话题被拉入"。
- **真机复验结果（2026-09-17，三项 PASS，现已 ACCEPTED）**：①正文自然体现改写后历史——**在镜像世界书取消挂载的窗口内**，后续楼命中注入独有词「兄弟会」「铁律」（遣返楼／前两楼正文／面板保留行均无此二词）⇒ 归因成立；②档案失效隔离——`eyon-canon-memory-r0-20260917.json` 显示删楼回退后记录 `status:filtered`、`reasons: delta-status:reverted`；③删楼回退同步收缩——同份导出的 `injectedText` 为空、`counts` 常驻/触发归零、head 12→0。"旧史不越界"（需 ≥3 条有效档案）记为当前不可测边界。
- 复验产出待修项：G-10（关键词口径三处）与 G-12（F-03 清扫路径不标记蝴蝶记录 `canonStatus`，令 v21"reverted 重新生成"闸在清扫路径下失效）——见 NEXT §3。
- **internal.87 已修（2026-09-17）**：①G-10① 硬词池只留专名形态（载体描述句剔除、地点按层级拆分，拆分下沉 `core/placeFragments.ts`）；②G-10② 模型 `historicalKeywords` 退回软词池（恢复"硬词仅来自 delta"）；③G-10③ rules/15 §十四 要求关键词为正文可逐字命中的字面形态、禁描述句堆叠（脚本侧别名扩展仍属 §6.5.3 未做）；④G-11 注入框定句加强（因果以简报为准＋非行动指令）；⑤G-12 新增 `runtime/canonRecordStatus.ts` 记录状态对账并接入 `messageDeleted`／孤儿清扫两入口。全量 552/552、typecheck/构建通过；internal.86 归档 86-v1，internal.87 包 1,044,887 bytes。



- delta preconditions/dependsOn；
- partially-active/orphaned/uncertain；
- 一次有界 canon-reconcile；
- 多次穿越交叉场景。

### P4 · 跨产物连续性 — P4-0 FROZEN / A+B+C IMPLEMENTED / C2 CONTRACT FROZEN

> P4-0 详细合同见 [05-P4跨产物连续性蓝图.md](./05-P4跨产物连续性蓝图.md)。该文档是 P4 的现行施工权威；本节只保留总边界，不复制实现细节。

P4 只处理“当前分支、当前 revision 下，已经提交并通过校验的生成产物，如何向后续相关生成提供低权、可撤销、可解释的连续性”。它不重新决定正史、不替代 P2 的产物有效性、不替代 P3 的因果重基线，也不把模型原创自动升级为 Canon。

冻结的实施顺序为：

1. **P4-A**：只从新 committed biography 的既有主事件槽派生同 revision 连续性锚，供后续传记与墟境读取；不扫描正文、不增加模型必填字段、不增加模型调用；
2. **P4-B**：在既有 binding/assessment 上做谱系 node/edge 局部版本视图，不因单个冲突整谱系报废；
3. **P4-C**：区分证据相容的 `parallelView` 与有来源支撑的 `sourceConflict`，不自动选赢家；
4. **P4-C2**：把相关未决关系转译成墟境内可感知、可追查的史料疑云；不固定解释类型，不自动裁定正史，完整合同见 [P4-C2史料疑云与冲突成因叙事合同.md](./P4-C2史料疑云与冲突成因叙事合同.md)；
5. **P4-D**：只缓存派生的连续性/谱系视图；缓存失败必须冷计算，绝不参与真相判断。

所有 P4 失败都必须 fail-open：缺锚、坏锚、旧存档、歧义和缓存故障只减少连续性参考或留下有界诊断，不得截断传记、谱系、墟境或遣返。每级必须独立通过自动化、typecheck、生产构建、真实酒馆和驾驶员门，不能一次重写跨级宣称完成。当前下一道门仅是驾驶员明确授权 P4-C2；不得顺带实施独立的 G-08 或 P4-D。

## 13. 验收场景

### A · 长人物条目与自动时间

玲山任务未写时间时，自动范围不早于其可靠出生/抵达下界；检索能读到铃羽、离开梵尼亚、抵达帝国、梅薇娜赠书和圣纹压制环现状；不把暧昧关系升级为明确姐妹事实。

### B · 出生前缺席

目标落在玲山出生前时，本人不作为在世者进入 cast；史稿可写氏族、梵尼亚传统、幻梦体系、无尽地城制度前史和命运伏笔。

若玩家点名使检索层同时把玲山列入 required CastManifest，人物时间轴坐实的出生前/死亡后硬缺席在本轮墟境中优先：她不得进入 sharedCast、候选 cast 或节点参与者，CastManifest 只豁免本轮到场要求，不改变人物身份、世界书与 Canon。正常年代的 required 约束保持原样。

### C · 单次历史改写

世界书 A 于 470 年死亡，玩家改为 458 年；465 年普通生成只使用 458 当前值并进入遗产叙事，470 只在 inactive 历史视图可见。删除干涉楼层后恢复 470。

### D · 当前历史正文记忆

有效蝴蝶变化在正文中可见；近期变化常驻，更早变化按相关性触发；失效 operation 不注入；工作台本地档案可查；镜像替代完成后新档零世界书残留。

### E · 多次穿越交叉

D1 令 A 于 458 年死亡，D2 在更早时间破坏 D1 前提并令 A 存活至 466；系统局部取代 D1，旧传记只让依赖死亡的段落失效，无关段落和不相交 delta 保持有效；删除 D2 后恢复 D1 及其依赖。

### F · 语焉不详的经历解释

玲山条目只明确“离开梵尼亚”“抵达帝国”“梅薇娜赠书”和当前报业身份，而没有给赠书日期。系统不得按条目顺序强行排年；传记或墟境可以选择“初到帝国即受启蒙”或“进入新闻圈后受业内传承”等证据相容解释，并留下 hypothesis、factIds、假设与替代方案。同一“赠书”事实不得在三个独立候选里换年份重复发生。

### G · 确定性跨实体召回与共证门

用至少五组异构条目复测确定性检索与共证门：

1. 地点名称没有“大陆/帝国/圣都”等固定后缀，但地区条目与城市条目能证明包含关系；
2. 人物关系只写在背景口述或他者声部，不写在结构化关系列表；
3. 同一历史事件在军队、地点和纪年条目中使用不同称呼；
4. 组织职责分散在成员条目和制度条目；
5. 某实体只在来源其他段落出现，当前 passage 不得被错误绑定；
6. **同形泛词污染**：“英雄史诗”方向不召入装备品质/技能规则条目（单弱词无佐证不开门；括号品质标注不拆别名）；“史诗品质装备”方向照常召回装备规则（多弱词互证/字段实体）；4 字专名“荷马史诗”与 2 字专名“翼民”“玲山·哈姆斯沃思”照常独证召回。

验收要求：四模块获得同一 EvidenceBundle；所有强结论能回指 passage；弱解释保留替代方案；共证门拦截同形泛词且不误伤专名与真实需求；没有向量、无语义编译服务仍能完成；不相关材料不因整来源共现进入舞台或 cast。真实世界书基线：343 条「英雄史诗」0 入选、「史诗品质装备」装备规则照常入选。

### H · P1-1 resolveCanon 最小验收矩阵

| 编号 | 场景 | 必须结果 |
|---|---|---|
| RC-01 | revision 0，无 delta | activeFacts 与 queryScope 内 BaseCanon 等价；无模型/网络调用；重复运行结果等价 |
| RC-02 | 世界书 A 470 年死亡，revision 1 verified replace 为 458 年 | revision 1 只返回 458 为当前值，470 进入 inactive；回滚后恢复 470，视图哈希恢复 |
| RC-03 | 同一人物另有身份、亲缘、地点等非冲突事实 | 改死亡年份不得删除或改写这些无关 factKey |
| RC-04 | 同 factKey 的 delta 只覆盖某地点/时段 | 重叠 scope 使用新值；非重叠地点、时段和其他主体继续使用原值 |
| RC-05 | unverified、缺依赖、缺 originalFactIds 或 scope 不可判定 | operation 被局部跳过并进入 receipt；明确旧事实继续有效；不得整视图 fallback |
| RC-06 | 一个 passage 同时含已改写死亡事实与仍有效身份事实 | 只遮蔽死亡 span；身份 span 继续可用；无法安全切分时使用 fact capsule，不把冲突原文交给模型二选一 |
| RC-07 | 两个聊天分支 + 四模块并发读取 | 分支互不串线；同一任务的传记、谱系、墟境、蝴蝶获得相同 branchId、revision、queryScopeHash 与 CanonResolvedView 身份 |

RC-01—RC-07 必须全部通过纯函数/仓储自动化、typecheck 和构建；RC-02、RC-06、RC-07 还必须在真实酒馆完成可视诊断与驾驶员确认。任何自动化不得把该确认写成 accepted。

### H2 · P2-A ArtifactCanonBinding 最小验收矩阵

| 编号 | 场景 | 必须结果 |
|---|---|---|
| AB-01 | 一篇传记的两个时期只分别使用事实 F1、F2 | 两个 stage 形成独立绑定；F1 不得自动扩散到第二段，origin/status 未使用时不绑定 |
| AB-02 | 一份谱系含人物节点 N1/N2 与亲缘边 E1，亲缘事实只支撑 E1 | node 与 edge 分开记录；亲缘 fact 只进入 E1，不把整棵谱系绑定到该事实 |
| AB-03 | 同次墟境三个候选共享 EvidenceBundle，但各自只采用不同事实 | 共享“可见”不等于共享“依赖”；candidate/history/node 只保存其实际解析采用的 factIds，排序确定 |
| AB-04 | 蝴蝶已有 action/delta/operation 本地记录，但没有普通聊天注入链 | 可为 action/operation 建立绑定和只读诊断；不得宣称正文注入已验收，也不得因缺少注入而使 P2-A 失败 |
| AB-05 | 两个聊天分支生成同名产物，revision/queryScope 不同 | 绑定携带各自 branchId、viewId、resolvedRevision、queryScopeHash；互不串线、bindingId 不冲突 |
| AB-06 | 旧传记/谱系/墟境没有 ArtifactCanonBinding | 原稿继续可读、搜索与手动引用，诊断显示 `unbound`；不扫描正文猜依赖，不自动判为 current 或 stale |
| AB-07 | 某个已验证单位的事实句柄无效或绑定存储失败 | 只留下 `binding-missing` 有界诊断；不破坏原稿、不触发模型 repair、不重跑整次生成；该单位不能进入后续自动失效裁决 |
| AB-08 | 相同已验证产物、CanonResolvedView 与解析结果重复执行 | 绑定内容与顺序语义等价；无模型、网络、prompt 或检索行为变化；不复制正文与 prompt |

P2-A 源码实施的退出条件固定为：AB-01—AB-08 自动化全部通过、typecheck 与全量回归通过、四模块只读绑定诊断在真实酒馆可见，并由驾驶员确认未改变现有生成内容。它完成后必须停在 P2-A 驾驶员门，不能自动进入 P2-B/P2-C。

P2-A 已于 2026-09-01 通过当前可测试真机边界：新传记与新墟境均形成局部绑定，诊断无 `binding-missing` 或 failure，驾驶员确认内容与生成链未被破坏。未存在可供复测的旧产物时，AB-06 只保留自动化证据，不伪造真机样本。

### H3 · P2-B 局部状态评估最小验收矩阵

| 编号 | 场景 | 必须结果 |
|---|---|---|
| AS-01 | binding 与同一生成 revision 的 CanonResolvedView 比较 | 所有依赖 active，单位为 `current`；重复评估结果语义等价，无模型/网络调用 |
| AS-02 | head revision 前进，但新增 delta 与该单位 factKey/scope 无关 | 单位仍为 `current`；不得把“版本更旧”直接等同 stale |
| AS-03 | 一个单位绑定 F1、F2，当前仅 F1 被 verified replace/retract | 该单位为 `partially-stale`；同产物未绑定 F1 的兄弟单位保持 `current` |
| AS-04 | 一个单位的全部 fact/operation 依赖均被确定性退休或撤销 | 该单位为 `stale`；原稿仍可读，不触发 repair、重跑、删除或检索过滤 |
| AS-05 | operation 可识别，但其明确前提/上游 delta 已 orphaned | 仅依赖该 operation 的单位为 `orphaned`；不把普通事实替换误判为 orphaned |
| AS-06 | 某 factId 不在完整比较视图的 active/inactive 中，或 operation 状态不可判定 | 单位为 `uncertain` 并列出有界 reason；不得猜 stale/current |
| AS-07 | 旧产物 `unbound` 或单位 `binding-missing` | eligibility 原样保留，不产生五态 assessment，不影响阅读、搜索、引用或其他单位评估 |
| AS-08 | 两个聊天分支有同名产物，或用另一分支 view 请求评估 | 分支互不串线；跨分支输入被拒绝或诊断为不可评估，不能借另一分支事实给状态 |
| AS-09 | 回滚到依赖重新有效的 revision | 先前 stale/partially-stale/orphaned 单位重新计算为 `current`；绑定原稿和旧 assessment 均不被改写 |
| AS-10 | 只有 sourceRefs 变化，或一个合法绑定没有 factIds/operationRefs | sourceRefs 不参与失效裁决；空依赖绑定在身份与视图合法时为 `current` |

P2-B 源码实施的退出条件固定为：AS-01—AS-10 全部通过纯函数/仓储自动化、typecheck 与全量回归；提供有界只读 assessment 诊断；在真实酒馆用“无关 revision、局部事实替换、回滚恢复”各验证一次，并由驾驶员确认旧正文未改写、生成链无新增模型请求。完成后必须停在 P2-B 驾驶员门，不得自动进入 P2-C。

P2-B 源码与自动化门已于 2026-09-01 完成：AS-01—AS-10、typecheck、生产构建与 477 项全量回归全部通过。上述三场真实酒馆验收因蝴蝶 Canon 变化缺少驾驶员可观察链而延期；待 P2-C 提供冻结范围内的只读消费与观察出口后补验，不能用自动化替代。

### H4 · P2-C 局部消费与展示最小验收矩阵

| 编号 | 场景 | 必须结果 |
|---|---|---|
| PC-01 | 蝴蝶提交 verified replace，尚未再次生成任何内容 | 设置页刷新立即读取当前 head，旧 fact inactive、新 fact active；不依赖生成缓存 |
| PC-02 | head 前进但 delta 与单位无关 | 单位保持 `available` |
| PC-03 | 同单位部分依赖失效 | `available-with-warning`，不封杀整段 |
| PC-04 | 同单位全部依赖确定失效 | 仅该单位 `excluded`，兄弟单位仍可用，原稿不变 |
| PC-05 | operation 明确 orphaned | 该单位 `excluded`，binding 与审计链不变 |
| PC-06 | 事实/operation 无法裁决 | `manual-review`，不得自动过滤 |
| PC-07 | 旧产物 unbound 或 binding-missing | `manual-review`，仍可查看与手动引用 |
| PC-08 | 回滚使原事实恢复 | 刷新后立即恢复 `available`，无需清缓存或重生成 |
| PC-09 | 工作台读取当前状态 | 同一报告可见 revision/action/delta/operation 与局部 decision，并可导出 |
| PC-10 | 相同 branch + bindings 重复刷新 | 投影、assessment、decision 与排序确定性等价；无模型、网络或正文改写 |

P2-C 自动化退出条件已满足；真实退出条件仍是上述三场宿主因果链与驾驶员确认。通过前不得进入 P3。

### I · 跨模块连续状态与玩家意图（P2/P3 接续验收）

| 编号 | 场景 | 必须结果 |
|---|---|---|
| CS-01 | 当前 Canon：人物正在服刑；玩家未要求越狱 | 传记、谱系、墟境、蝴蝶均以“正在服刑”或其受限影响为前提；不得让人物无解释地自由行动，也不得把人物绝对删除 |
| CS-02 | 当前 Canon：人物正在服刑；玩家明确输入“在服刑期间越狱” | 模型可以设计不同但可成立的越狱过程；输出保留被捕、入狱和服刑前史，并提出结束监禁区间的新转移；不得因为要越狱就写成从未坐牢 |
| CS-03 | 玩家明确输入“改写为从未被监禁” | 识别为 retcon，必须走正式干涉/delta 裁决；在提交前仅为任务局部 proposal，不能污染其他模块 |
| CS-04 | 谱系页面中的人物状态已被后续 Canon 改变，玩家仍选择该节点作为墟境参考 | 选择传递稳定 entityId；新任务按当前 branch/revision 重解析。旧谱系正文保留可读，失效状态不进入普通生成 |
| CS-05 | 人物先被监禁，后越狱，再被赦免；查询分别落在三个时段 | 各时段得到不同当前状态，但三项发生事实均按时间保留；没有整人物、整来源或整产物覆盖 |
| CS-06 | 同类变化发生在任职、婚姻、伤病、迁徙、物件持有或组织归属 | 使用同一“发生事实 + 状态区间 + 状态转移”原则，不新增关键词特例或封闭状态机 |
| CS-07 | 回滚产生越狱的 revision | 监禁区间及依赖它的产物资格确定性恢复；无关事实、片段和其他分支不受影响 |

CS-01—CS-07 不是 P1-1 第一版的模型验收，也不得倒逼 `resolveCanon` 调用模型。P1-1 只需提供足以投影这些场景的当前事实、区间、转移和来源；玩家意图理解、任务局部 hypothesis 与产物失效分别在 P2/P3 接续实现。

## 14. 当前已知合同缺口

### G-01A · 可逆状态被误判为绝对缺席 — **internal.119 已修 / 待真机验收**

internal.119 已把模型提示合同拆清：只有 CHARACTER_TIME_ANCHORS 能确定的未出生/已故属于绝对缺席；失踪、失能、监禁、放逐、身处异界、除名等自然语言状态属于受限在场，模型结合当前有效 Canon 与证据原句表现具体限制。玩家明确要求越狱、获释、回归、复职、治愈、迁徙等变化时，可以在候选内提出局部转移，但必须保留既有前史，候选本身不自动成为 Canon。实现没有新增封闭状态枚举、关键词语义编译、validator 硬门、存储或模型调用。

### G-01B · 连续状态跨时段投影 — 待办

后续仍应以 6.6 和 CS-01—CS-07 为合同，先由 P1-1 提供确定性当前视图，再由 P2/P3 做跨产物绑定和玩家意图投影。internal.119 不实现状态区间推导、跨时段查询或 CS-05—CS-07；不得重写人物在场引擎，不得新增封闭状态机或语义编译层。

### G-02 · Qualified Evidence 的版本判断是过渡实现

P1 前生成产物统一标 `unresolved` 可以防污染；P1 后必须删除其独立版本猜测，让 qualification 只消费 CanonResolvedView。

### G-03 · 世界书镜像退役 — **internal.88 已完成 / internal.90 累计真机验收通过**

镜像曾承担历史可见性。**internal.86（步 A）提供了不依赖镜像的正文可见性通道（`CANON_MEMORY` + 工作台诊断面板），internal.88（步 B）据此完成退役**：删除镜像写入与可见性切换、`ArchiveAdapter` 缩为存量清理、工作台设置行改为"已退役 + 清理镜像"、检索源改为本地记录 + `resolveCanon` 投影。internal.90 累计真机验收确认清理、遣返、Canon 写入、记忆注入与后续正文消费均无错误，该缺口关闭。

### G-04 · 固定词法资格会污染局部 passage

此前地理、人物、组织和事件资格会依赖名称后缀、固定正则、整来源实体集合与共现。真实宿主曾出现“来源中包含梵尼亚，局部 passage 就被当作梵尼亚证据”的同类风险；人物、事件、组织和时代也具有同一根因。

internal.71/72 后该缺口由两条确定性纪律闭合：① 语义编译层撤销，资格不再依赖外部语义裁决；② 共证门把检索开门权统一为「实体有名、长词独证、2 字泛词共证」，括号「(类别/品质)」标注不再拆成别名/实体/搜索词——同形泛词污染（装备品质案例：2133 分 → 0 入选）在检索资格层被拦截。实体硬资格仍必须落在 passage-local 绑定；真实宿主复测前不能标记闭合。

### G-05 · 模型回显内部证据主键导致混合 ID

旧墟境合同同时向模型暴露 `passageId / snapshotId / sourceId / factId / start/end/hash`，又要求模型逐字回填内部主键。真实宿主先后出现 passage 冒充 fact、snapshot 冒充 passage、source 与 `#chars` 拼接等错误；继续增加 alias 只会扩大不可预测输入空间。

当前根修已冻结并实施 `Citation Contract v2`：四模块共享 EvidenceBundle 的 P/F/E/S 任务表、统一合同渲染器和脚本解析器；模型边界不再暴露内部 passage/snapshot/source/fact/event 主键。合同显式声明四类 allowed 列表，空事实表不会再暗示 F1；墟境 outline 与 expansion 冻结同一编号，新证据只追加不重排。未知或错类型的墟境句柄在解析边界被丢弃并留下诊断，不进入 Canon，也不再触发整批史稿重写。传记、谱系和蝴蝶的来源引用已经迁移到同一 S 表，传记 CanonFact 事件使用 F 表，旧存档内部 ID 仅由只读兼容解析器接受，不形成新的模型别名。

### G-06 · 输出脆弱性与自动时间窗过窄

模型输出属于不可信边界：多余描述字段、近义枚举或单个坏子项不得使全部有效 passage 回退。当前采用“受控归一化 → 逐项保全 → 严格内部校验”，并按 `enabled snapshot set + branch/revision + TaskQueryScope + queryHash` 隔离旧缓存；不建立第二语义层，也不放宽引用身份。

玩家不填日期且点名普通短生涯人物时，人物出生至当前剧情时间仅表示可行包络，不表示故事必须从出生开始。模型应在包络内依据事件前提、已知经历与社会关系选择具体时段，并在同一候选中保持一致；没有人物锚时仍使用短而可复现的 3—12 年窗口。

## 15. Parking Lot

以下需求保留，但不进入 P0-D 或 P1 当前完成分母：

- `lineageKind`：原生、同世界穿越、跨世界穿越、夺舍、转生、收养、造物；
- 穿越者原生年龄/现世界年龄双轨；
- 夺舍者灵魂/肉身双轨；
- 构装体启用纪年；
- embedding、向量索引或外部向量库：只有确定性主路径在真实宿主中留下可重复漏召回，并证明问题发生在候选召回而非资格、Canon 或 prompt 时，才进入独立 Growth Track；向量只能替换 CandidatePassagePool 的召回方式，不能替代共证门资格或 CanonResolvedView。

这些内容不得以新账本或私有检索器形式提前实现；应扩展 CanonFact 与模块投影。

## 16. 红线

- 不建立独立“真相版本系统”；版本是统一 catalog/retrieval 的事实有效性维度。
- 不恢复 CharacterFactLedger、TimelineRevisionStore 或整来源打补丁。
- 不用固定模块权威顺序处理历史改写。
- 不整篇删除或后台重写旧传记、谱系、墟境或蝴蝶面板。
- 不让模型无回执地生成永久 Canon。
- 不因不确定级联而静默选择一份看似完整的历史。
- 不把世界书、source span 或 fact 数组的排列当作历史先后。
- 不把 reported/contested 静默升级为客观真相，也不把合理空白冻结为唯一解释。
- 不为单一角色、纪元、地点追加特例补丁。
- 不让固定关键词、名称后缀、整来源共现或模型无引用猜测直接成为 passage 级硬事实。
- **不恢复语义编译层**（SemanticEvidenceCompiler/View 不再回活动链路）；检索资格纯确定性：实体有名、长词独证、2 字泛词共证，括号「(类别/品质)」标注永不拆为别名/实体/搜索词，不用过严 validator 扼杀普通叙事想象力；硬门只限可确定事实。
- 不把玩家自然语言拆成封闭关键词状态机；结构只锁版本、身份、作用域、来源和连续性，模型在这些边界内理解变化并填充历史空白。
- 不把后续状态转移误写成前置事件从未发生；除非存在明确 retcon 意图与已验证 delta，否则已发生前史必须保留。
- 不在 P1 之前声称自动纠错完成，不在 P3 之前声称多次穿越交叉已解决。
