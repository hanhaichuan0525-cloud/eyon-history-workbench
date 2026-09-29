# DeepSeek Harness 迭代成果交接说明（自 Codex 迁移点起）

> **ARCHIVED / HISTORICAL HANDOFF**：本文记录 internal.46—56 的迁移差异；当前状态与下一门以 `../00-项目蓝图权威索引.md` 和 `../../NEXT.md` 为准。

> **读者**：Codex 续作者（或任何接管本项目的 AI/人类）。
> **范围**：本文档只说明「与迁移时的差异」——即 2026-08-20 从 Codex 迁移至 DeepSeek Harness 之后，internal.46 → internal.56 的全部迭代成果（不含试错过程）。
> **必读清单**（按优先级，见 §8）：《人物在场引擎与墟境缺席叙事蓝图.md》v1.4 → 《时空错位容纳蓝图.md》v1.0 → 《统一世界书智能检索-DeepSeek-Harness迁移交接与风险审计.md》→ NEXT.md。
> **项目**：伊雍历史工作台（eyon-history-workbench）——SillyTavern / Tavern Helper 角色卡「酒馆助手脚本-伊雍历史工作台-内测」：传记、谱系、墟境、蝴蝶四模块。

---

## 1. 迁移点与基线（差异的起点）

| 项 | 值 |
|---|---|
| 迁移日期 | 2026-08-20（NEXT.md「DeepSeek Harness 迁移入口」段） |
| 迁移时基线 | **internal.46**（checkpoint candidate，未达 accepted；包已归档） |
| 迁移主文档 | `docs/统一世界书智能检索-DeepSeek-Harness迁移交接与风险审计.md`（Codex 交接时生成，接管者必须先读） |
| 迁移时风险冻结（四项） | ① 四模块 Bundle 消费不对称（只有墟境完整携带 EvidenceBundle/CastManifest/TemporalEligibilityLedger 到 prompt 与 validator）；② 谱系 prompt 正式二次筛选；③ `complete=false` 未被 Active 拒绝；④ P1/recommended anchors 可被 `uncovered` 升级成硬失败 |

**红线（全程未变，任何改动不得违反）**：
- 尽可能不截断、不判错；任何模块不得因时空错位报错截断；
- AI 必须知道矛盾，并把矛盾转化为可行方针（缺席叙事 / 异界来源）；
- 不做词表黑名单补丁，只做机制级修复；先解释根因，经驾驶员确认后再改；
- 不删 legacy、不加依赖、不 Git 提交（除非单独授权）。

---

## 2. 迭代成果总表（与迁移点的差异一览）

| 迭代 | 版本 | 主题 | 全量测试 | 一句话差异 |
|---|---|---|---|---|
| 阶段1（R-01~R-04） | internal.47 | 四模块 Bundle 消费对称 | 298 | 传记/谱系/蝴蝶补全 Bundle 消费；谱系二次选源断链；complete=false 拒绝；失败分级 |
| 迭代二 | internal.48 | 截断重试留痕 + 疆域引用降级 | 301 | 重试成功补写 RECOVERED_AFTER_<code>；territorialReferences 不再 fatal |
| 迭代三 | internal.49 | Temporal v2 | 304 | 时间规则 typed fact + 置信度分级；纪元顺序单一权威年表源 |
| 迭代四 | internal.50 | 墟境史稿长度契约单一真源 | 305 | 提示词与校验器共用同一常量（380→320 下限，报错带扩写指引） |
| 迭代五 | internal.51 | 架构转向：词表黑名单 → 时代画像 | 306 | 删除全部禁令词表；buildEraProfile 时代画像 + 错位处理契约 |
| 迭代六 | internal.52 | 时空错位容纳蓝图实施 | 308 | 四态画像、统一错位契约、人物时间锚（baselineWorldTime 开局锁定）、谱系 strict 档 |
| 迭代七 | internal.53 | Plan A：时期分区 × 人物时间锚 | 324 | assessStagePerson 四态区间；STAGE_PERSON_TIMELINE / STAGE_PERSON_WINDOW 注入 |
| 迭代八 | internal.54 | 墟境时间边界：未来硬门 + 穿越者年龄锚 | 330 | NODE_IN_FUTURE/SPAN_IN_FUTURE；CHARACTER_TIME_ANCHORS 硬事实+推断线+一致性规则 |
| 迭代九 | internal.55 | 人物在场引擎（蓝图 §4/§8/§9 首批） | 337 | deriveFeasibleWindow / 点名即进入 / CHARACTER_ABSENT_WINDOW / OrderedLifeAnchors / RUIN_ABSENCE_MODE / CHARACTER_CARDS_FULL |
| 迭代十 | internal.55（覆盖包） | 墟境自动时间范围兜底根治 | 351 | 废除 470 兜底；上界=当前剧情时间；人物下限只抬高不钳制；同年月日不倒置 |
| 迭代十一 | internal.56 | 传记时间锚入口适配 | 354 | buildPersonTimeline 无目标纪元不再早退（窗口输出照常注入，state=unknown） |

版本链：internal.46→47→48→49→50→51→52→53→54→55（两次包）→56；除 internal.55 覆盖包（同版本覆盖）外，全部旧包按原 SHA-256 归档于 `release/archive/0.10.0-internal.N/`。

---

## 3. 各迭代详细差异（机制与验收，不含试错）

### 3.1 阶段1（R-01~R-04，internal.47）
- **四模块 Bundle 消费对称**：传记/谱系 ContextBundle 开始完整携带 `evidenceBundle`（与墟境同构）；共用序列化器与 CastManifest 处理；活跃时间规则与 passage 元数据注入四模块 prompt（ACTIVE_CAST_AND_TIMELINE_READ_ONLY）；传记 plan/谱系/蝴蝶 validator 用同一份证据本地拦截「后世帝国/制度/角色提前出场」。
- **谱系二次选源断链**：`selectReferenceSources` 断开，按 receipt 顺序选 passage 原样投影；active 模式新增语料完整性门——存在世界书作用域而 receipt 缺失或 `complete=false` 时显式失败（禁止静默回退）。
- **失败分级**：fatal 只覆盖 required/group-required（P0）预算不足仍硬失败；普通查询锚（P1/P2）预算不足进 `receipt.warnings` / `omittedAnchors` 而非终止任务。
- 修复纪元提取前缀污染（「对神明纪元」→「神明纪元」）。

### 3.2 迭代二（internal.48）
- 截断/瞬时故障重试恢复**留痕**：重试后最终成功时补写 `RECOVERED_AFTER_<code>` 错误日志条目并发出 `phase=recovered` 任务状态（此前只有失败条目，用户看不到重试是否成功）。
- 疆域引用降级（R-05）：玩家填写的「地点范围」经 `territorialReferences` 传入共享检索门——目标纪元尚不存在的实体（如神明纪元填奥古斯提姆帝国）不再触发 temporal conflict fatal，降级为 `receipt.warnings`；prompt 新增 `TERRITORIAL_REFERENCE` 块（明确名称在目标纪元不存在、禁止作为在场势力/制度出现、允许疆域内描写与「此地日后将成为X」式时间错位锚）；validator 对疆域名称只拦截存在性表述，放行疆域与时间锚表述。

### 3.3 迭代三（Temporal v2，internal.49）
- 时间资格从「窄正则+词面匹配+一律硬失败」升级为 **typed fact + 置信度分级**：每条规则携带 eventType（created/formed/renamed/reformed/destroyed/dissolved）、confidence（high/medium/low）、status（explicit/inferred）、isAuthoritative。
- 纪元顺序只来自权威年表章节（单一来源，不再按扫描遇见顺序拼接）；否定句（尚未/不属于/未曾）不建规则；传说/不确定句（据说/相传/可能）降为 low+inferred，**永不 fatal**。
- 只有 high+explicit（权威年表直陈）触发 fatal；medium/low 只降权或警告。
- 宽泛制度词（算术/信仰/崇拜/教义/信徒）需制度化语境才拦截（「部族的宗教生活」放行、「算术组织形成」拦截）；具体实体（祭司/教会/神庙/帝国）裸词仍硬拦。
- 修复生命周期主体提取（分裂/解体/灭亡/重建/改名）；真实 v4.2 世界书验证（eraOrder 完整、帝国/圣灵信仰/公会硬约束保留、「算术生活」放行）。

### 3.4 迭代四（internal.50）
- 墟境史稿长度契约收敛为单一真源 `src/core/ruinProseContract.ts`：提示词与校验器共用同一常量，消除「提示词 400-650 / 校验器 380-700」两层漂移；下限 380→320（对齐模型自然长度，349/352 字不再误伤）；低于下限报错改为可操作扩写指引（给当前字数、目标下限与补写方向）；超长报错给压缩方向。

### 3.5 迭代五（架构转向：词表黑名单 → 时代画像，internal.51）
- **删除全部禁令词表**（RELIGION_MARKERS / GENERIC_INSTITUTION_TERMS / 语境匹配），时间词汇不再由 validator 致命拦截。
- 新增 `buildEraProfile`：从权威年表生成目标纪元「已存在/尚不存在」清单，四模块 prompt 统一携带 `ERA_PROFILE` 块与错位处理契约：承认错位是历史事实 → 二选一（缺席叙事：该元素缺席时世界的状态、其到来前的空白、其遗产在当下的痕迹；异界来源：位面交汇残留/异界造物/古神遗物/穿越异常/传说误传并正文明示来源）→ 无法自洽时降级为同功能本纪元对应物（蒸汽机→魔导蒸汽机关）。
- 引擎 direct-conflict 与 cast 点名实体时间排除全部降级为 warning/required 附理由，任务永不因时间词汇截断。
- 验收：神明纪元出现蒸汽机/部族祭司/帝国皇帝/帝国疆域一律通过且 prompt 含错位契约（不再被词表误杀）；自动化 306/306。

### 3.6 迭代六（时空错位容纳蓝图，internal.52）
- **四态画像**（exists/notYet/extinct/eraFeatures）：灭绝种族在目标纪元前标记 extinct 并写入时代特征；统一错位契约覆盖全部类别（人物缺席/种族灭绝/科技未出/疆土未属/制度未建），缺席叙事（其到来前世界/遗产痕迹）或异界来源二选一。
- **人物时间锚**：catalog 提取「年龄: N岁」与显式生卒 → **年龄基准 = 开局锁定的 baselineWorldTime**（首次任务 assemble 锁定当前世界时间并持久化，不随每楼剧情漂移；玩家自定义开局时间天然成为基准；换新聊天重新锁定）→ 引擎计算 `personTimeline` 写入 Bundle，prompt 渲染 `PERSON_TIMELINE`（脚本算好给模型，不让模型心算）。
- 传记新增「时间缺席溯源」模式（对尚未存在的人物溯源 → 写其到来前的世界/组织前史，禁止虚构在场）。
- 谱系 strict 档（共通机制策略档位，非覆盖补丁）：保持生卒硬门 + `GENEALOGY_STRICT_CHRONOLOGY` 指令（禁止用缺席/异界合理化生卒冲突）。
- 验收：梅薇娜（488 年基准 88 岁 → 出生 400 年）在 310 年标记 not-born 且含缺席叙事方针；400 年基准（出生 212 年）310 年在世；古龙族灭族规则解析为 destroyed。自动化 308/308。

### 3.7 迭代七（Plan A：时期分区 × 人物时间锚，internal.53）
- `contracts.ts`：`personTimeline` 条目新增机器可读 `lifespan`（生卒/抵达窗口，纯增量）。
- `temporal.ts` 新增**区间相交** `assessStagePerson`：before-birth / alive / after-death / unknown 四态 + 段内年龄区间；段内出生/段内亡故跨接时年龄从 0 起/封顶于亡故年；界外来客带「抵达后累计」注解；段起止缺纪元时回退 contextEra → 出生纪元。配套 `personAvailabilityLine`、`buildStagePersonTimeline`。
- 规划 prompt 注入 `<STAGE_PERSON_TIMELINE>`：在场窗口 + 「段内年龄 = 段年份 − 出生（抵达）年」规则 + 窗口外段落显式缺席叙事/异界来源并在 theme 点明；人物优先级：指令点名 > 高风险（not-born/deceased）> alive > unknown，上限 12 防膨胀。
- 扩写 prompt 注入 `<STAGE_PERSON_WINDOW>`：逐段算好的在场结论，unknown 不注入避免噪音；单块按 passageId 过滤；批次降级单块路径同步透传。
- 顺手修复死线：`buildActiveEvidenceView` 无 entities 时回退消费引擎已算好的 `bundle.personTimeline`——传记 plan prompt 首次真正渲染 `<PERSON_TIMELINE>`（此前 BIOGRAPHY_TIME_ABSENCE_MODE 引用的标记从未出现）。
- 纯软约束：错位绝不硬拦（红线保持）。
- 验收：梅薇娜段 448–458 → alive 48~58 岁；段 300–310 → before-birth 含缺席方针；凡多·灰袍（479 亡故）段 485–488 → after-death 含遗产方针；段 470–490 → alive 且年龄封顶 79；跨纪元/缺纪元/纯年龄锚/界外来客各态覆盖。自动化 324/324（+16）。

### 3.8 迭代八（未来硬门 + 穿越者年龄锚，internal.54）
- **未来硬门** `assertRuinNotInFuture`：任何节点/跨度不得晚于当前剧情时间（currentWorld.time 解析；纪元未知/解析失败不拦避免误伤），大纲与扩写两端都校验，报 NODE_IN_FUTURE / SPAN_IN_FUTURE 带中文指引走既有 repair（脚本不篡改历史日期）；玩家显式填未来范围同样受上限约束。
- **自动范围收窄**：`resolveAutomaticRuinRange` 纪元窗口对当前剧情时间取 min（剧情 300 年开局不再落到 470 年）。
- **穿越者年龄锚** `<CHARACTER_TIME_ANCHORS>`：普通人物给「出生年（来源标注）+ 事件年龄 = 事件年份 − 出生年 + 未出生/已故禁止在场」；界外来客（arrivalBased）拆成「硬事实（基准年时 N 岁）+ 推断线（线性外推抵达年，标注抵达时 0 岁假说）+ 一致性规则（穿越时间未记载；正文明示更晚抵达且抵达时年龄自洽是允许的，但禁止同一人物混用互相矛盾的抵达线）」。
- 背景：用户真实反馈「448-450 年史稿写梅薇娜『年近五十』正确，但 452-455 年写『初来乍到』」——根因是梅薇娜为界外来客，世界书只有「88 岁」（基准 488），穿越时间未规定；线性外推 400 年是推断锚而非硬事实。修复后模型知道「硬事实 vs 推断线」，可自选自洽抵达线但不许混用。
- 自动化 330/330（+6）。

### 3.9 迭代九（人物在场引擎，internal.55）——核心迭代
蓝图《人物在场引擎与墟境缺席叙事蓝图》v1.2 §4 引擎层 + §8 墟境接入 1-7 + §9 传记接入 1-4：
- **可行时间带** `deriveFeasibleWindow`（temporal.ts）：下界 = 全体选中人物出生/抵达最晚者，上界 = 当前剧情时间；`resolveAutomaticRuinRange` 接入——未写时间时自动范围不再落到人物出生前（场景 A：玲山 27 岁 → 出生 461 → 范围 ≥461）。
- **区间在场判定公用入口** `assessPresenceInWindow`（复用四态区间逻辑）。
- **有序事件链锚** `OrderedLifeAnchors`：catalog 从人物「背景口述」保守提取既定事件（「我离开X的时候」「官方说…被…选中去…做…」「后来我到X」等句式；提取不到不注入、不猜），随 personTimeline 进 bundle；墟境 CHARACTER_TIME_ANCHORS 与传记 STAGE_PERSON_TIMELINE 渲染「既定事件链：… → …（按此顺序排布，不得颠倒/压缩）」。
- **寿命兼容判定接引擎换算**：`selectedCharacterFitsCandidates` 对「27岁」年龄格式用 personTimeline 窗口兜底（出生年 = 基准年 − 年龄）——258-269 候选 vs 玲山（born 461）判不兼容。
- **人物在场硬校验** `assertIncompatibleCharactersAbsent`（CHARACTER_ABSENT_WINDOW）：不兼容人物出现在 cast/节点参与者 → repair（三路指引：后移时间带/换人/缺席叙事）；不出现则放行——缺席退路（notApplicable 天然成立，场景 B：214 年玲山不出场即通过）。
- **墟境缺席叙事模式** `<RUIN_ABSENCE_MODE>`：人物未出生/已故/失踪/失能时禁止在场，写「其到来之前/其影响之后」的世界 + 命运伏笔。
- **中心人物整条注入** `<CHARACTER_CARDS_FULL>`：`RuinContextBundle.characterCards`（原始全文，24k 上限，不参与检索）——背景口述/声部/装备完整到达模型（EJS 保留）。
- **防误判 #1-#4**：death 只在 dates.length>=2 时取 at(-1)（单日期=出生年不被当死亡年）；生卒字符串倒写按绝对年排序纠正；「活跃于400年-410年」是活动范围非生卒；「461年 - 至今」识别为在世。
- **UI/运行时**：工作台「新建任务」按钮一键清空（草稿+选中人物+引用）；引用列表只做候选池（移除「引用全选」自动勾选）；设置页新增「时间锚诊断」（最近 20 条墟境生成的自动范围/人物锚命中/锚文本，`getRuinPresenceDiagnostics`）。
- **Token 预算**：`initialCustomTokenBudget`——`deepseekStructured=true` → 8192（DeepSeek 官方硬上限防 400）；false → 60000（Gemini 等大输出模型）。截断重试：currentMaxTokens<8192 翻倍，否则原样重试 1 次；compact 恢复 2048。
- 验收：场景 A/A2/B + prompt 三块 + lifeAnchors 提取 + deriveFeasibleWindow 四态。自动化 337/337（+7）。

### 3.10 迭代十（自动时间范围兜底根治，internal.55 覆盖包）
- 根因（用户真机：伊莲娜 16 岁 → 出生 472，仍被 470 拦截；诊断显示「470-10-20 → 470-1-3」同年倒置）：旧实现 `maximum = min(470, capYear)` 且 `minimumEffective = max(minimum, min(personFloor, maximum))`——出生年晚于 470 的人物下界被钳回 470 == maximum → 窗口压成同一年，月日两个独立哈希生成导致倒置。**倒置是钳制的次生现象**。
- **废除纪元硬编码上界（470 兜底整体移除）**：自动范围上界 = 当前剧情时间（capYear）；剧情时间解析失败时不再回落 470，只受下界与有限跨度（≤24 年）约束——与未来硬门（同样依赖剧情时间解析）语义一致。
- **人物下限只抬高不钳制**：`minimumEffective = max(minimum, personFloor)`——伊莲娜（472）与出生仅数年的婴儿（487）的窗口必须可达。
- **防御**：窗口被上界压到同一年时月/日不倒置（start ≤ end 硬不变量）。
- 验收：伊莲娜（自动范围 ≥472 且 ≤488）；婴儿 487（窗口覆盖出生年）；剧情时间解析失败（无 470 兜底，472 仍可达且窗口可复现）。自动化 351/351（+3）。

### 3.11 迭代十一（传记时间锚入口适配，internal.56）
- **根因**：`buildPersonTimeline` 第一行 `if (!requestedEra) return []`——目标纪元只从检索 query 正则提取「X纪元」；墟境表单必填纪元故正常，**传记指令是自由文本（寻根溯源通常不含纪元名）** → 人物时间锚整链为空 → STAGE_PERSON_TIMELINE/STAGE_PERSON_WINDOW 不渲染 → 模型自由编年表（真实案例：玲山传记把放逐/剥离圣纹写在出生前 41 年，起源 420 年 = born 461 前）。
- **修复（解耦，驾驶员选 1 并写死边界）**：无目标纪元不再早退——窗口输出（lifespan/lifeAnchors）与目标纪元无关照常注入；各段在场与年龄由扩写阶段区间相交（assessStagePerson）按段起止年份判定；state 无法判定 → unknown；narrative 用中性文案「当前指令未限定纪元，不做整篇在场判定，各段在场与年龄按该段具体年份另行判定」。
- **红线写死**：绝不把 baselineWorldTime 纪元冒充目标纪元判状态（会输出错误纪元）；检索选源不变（未把当前纪元并入 query——选 2 已否决：会触发 temporal 源门 `temporal-scope-incompatible` 误伤跨纪元溯源）。
- 验收：无纪元 query → personTimeline 非空、state=unknown、无空洞「目标纪元（）」、lifeAnchors 带出；personAvailabilityLine 消费 unknown 条目；传记 plan prompt 真实渲染出生年锚行。自动化 354/354（+3）。
- **用户真机效果**：传记起源从 420（出生前 41 年）修正为 461（出生年），各段年龄大体正确。

---

## 4. 蓝图演进（迁移后的文档资产）

| 蓝图 | 版本 | 状态 |
|---|---|---|
| `docs/时空错位容纳蓝图.md` | v1.0 | 冻结（2026-08-21）→ internal.52 实施 |
| `docs/人物在场引擎与墟境缺席叙事蓝图.md` | v1.2 → v1.3 → **v1.4** | 主蓝图，分批实施中 |
| `docs/统一世界书智能检索-DeepSeek-Harness迁移交接与风险审计.md` | — | 迁移审计，冻结 |
| NEXT.md | — | 完整迭代记录（含本说明未展开的细节） |

**v1.2 内容**：人物在场引擎（§4）、硬时间门 vs 受限在场（§4.6：只有未出生/已故是不可逆硬门；囚禁/失踪/失能/放逐/异界/除名 = 受限在场软方针，validator 不拦）、真相版本管理（§5，P0-P3）、蝴蝶面板记忆注入通道（§6）、内容趣味性契约（§7）、退出门（§13）、红线（§14）。

**v1.3（谱系适配清单 §10，方向已确认未实施）**：每代默认填满 maxPerGeneration + reducedGenerationReasons 存在性核对（warning 不 repair）；父系母系双侧填充；既有亲属名单注入 EXISTING_RELATIVES（铃羽不得改名）；命名守卫 warning；谱系 personTimeline 权威生卒注入；characterCards 全文接入 GenealogyContextBundle；lifeAnchors 接入谱系；谱系诊断输出；identity fidelity（CANONICAL_CHARACTER_IDENTITY_CHANGED 误判修复方向：source==='genealogy' 跳过硬校验 或 identities 从 catalog 取）。

**v1.4（三处真机反馈补丁，2026-08-21）**：
- §4.3：**装备现状锚提取规则**——增补现状装备句式（「戴着/佩戴着/身上有/随身携带/压制着」+ 现状语义）→ `currentEquipment` 状态锚；形态扩为 `{ currentLocation, currentIdentity, currentEquipment }`（案例：圣纹压制环=现状装备，规则缺失时模型写成「出生即扣」「熔铸成钢笔发簪」）；
- §9 第 7 条：**事件链年份参考**——事件链锚带既定年份（来自既有史稿/世界书明确记载）时传记 span 直接引用（跨模块时间对齐；无年份不猜自由排布）；§5.4 事实锚共享（P3）的前置形态；
- §10.3：**亲属身份摘要注入**——注入既有亲属时连同既定身份与命运摘要（案例：铃羽被改名「希羽」且被改成「体弱受宠公主」，无尽地城命运整条消失）。

---

## 5. 用户真机验收状态

- **internal.55 验收通过**：伊莲娜（born 472）自动范围正常、年龄/节点正常；「新建任务」一键清空正常；玲山 477-478 史稿（深夜剥离圣纹→戴环→出梵尼亚西城门→到帝国）时间/年龄全对——人物在场机制端到端验证通过。
- **internal.56 部分验收**：传记年龄正确（起源 461 = 出生年）；内容层面仍有问题（妹妹铃羽被改名希羽并改写设定、圣纹压制环语义错乱、梅薇娜/赠书环节缺失、既定事件链被压缩）——**已全部归入蓝图 v1.4 待办**，不是新 bug。
- 已知良性行为：事件链锚不带年份，模型在链约束内自由排布时间（引擎不猜合理性数字）；墟境史稿被删除后传记无时间参考属正常。

---

## 6. 未实施待办（蓝图内，按优先级）

| 优先级 | 事项 | 蓝图位置 |
|---|---|---|
| P0 | 蝴蝶效应 InterventionDelta 结构化（引擎只消费） | §5.1 |
| P1 | canonOverrides + 版本化 lifespan + CANON_INTERVENTIONS（场景 C） | §5.3 |
| P2 | 版本仲裁 + 谱系版本化生卒 + 来源标注 | §5 / §11 |
| P3 | 传记事实锚共享 + 防污染 + cascadeScope | §5.4 |
| — | **谱系适配清单 9 项**（§10.1-10.9，方向已确认） | §10 |
| — | 蝴蝶面板记忆注入通道 + 趣味性契约（场景 D） | §6 / §7 |
| — | v1.4 三处补丁实施（装备现状锚 / 事件链年份参考 / 亲属身份摘要） | §4.3 / §9 / §10.3 |
| — | 卡名泄漏修复（「命定之诗/黄昏之歌」= 角色卡名进入墟境正文） | 蓝图待办 |
| — | 谱系 identity fidelity（CANONICAL_CHARACTER_IDENTITY_CHANGED 误判） | §10.9 |

---

## 7. 工程约定（续作者须知）

- **测试**：`node --test --experimental-test-isolation=none tests/<file>.test.ts`（Windows 沙箱下 spawn 管道受限，必须用该参数）；全量回归 = per-file 循环，CRLF 容忍正则 `(?m)^ℹ pass (\d+)\r?$`；PowerShell 会因 stderr 输出误报 exit 1，以 `$LASTEXITCODE` 为准。
- **打包**：`pnpm build` → 用 node 更新 manifest.json 的 `sha256`（dist/index.js）与 `workbenchSha256`（dist/workbench.js）（勿用 PowerShell ConvertFrom-Json，大文件会失败）→ `pnpm package:internal`（打包脚本内置 dist↔manifest 哈希校验，不一致会 throw）→ 反向验证 markers。
- **版本规则**：用户验收前同版本覆盖；验收后顺延 `internal.N+1` 并把旧包按原 SHA-256 归档到 `release/archive/0.10.0-internal.N/`；manifest notes 每次迭代追加一条（新在前）。
- **关键文件**：`src/runtime/ruinAutomaticRange.ts`（自动范围）、`src/retrieval/temporal.ts`（人物在场引擎）、`src/retrieval/shadowEngine.ts`（buildPersonTimeline）、`src/retrieval/catalog.ts`（lifespan/lifeAnchors 提取）、`src/validators/ruin.ts` / `biography.ts`、`src/prompts/ruin.ts` / `biography.ts` / `activeEvidence.ts`、`src/runtime/presenceDiagnostics.ts`（时间锚诊断）、`src/runtime/tavernGeneration.ts`（token 预算）。
- **红线**（§1 不变）：不截断不判错；错位容纳；谱系 strict 是策略档位非补丁；硬门只对不可逆（not-born/deceased）；状态锚 = 受限在场软方针；引擎不猜合理性数字；不引入词表/补丁；不删 legacy；不加依赖；不 Git 提交（除非单独授权）。

---

## 8. Codex 必读文档清单（按阅读顺序）

1. **`docs/人物在场引擎与墟境缺席叙事蓝图.md`（v1.4）** —— 当前主蓝图。§1 问题定义（玲山根因链）、§2 验收场景（A/B/C/D 写死）、§4 引擎层设计（含 v1.4 装备现状锚）、§8 墟境接入、§9 传记接入（含第 7 条事件链年份参考）、§10 谱系适配清单、§11 策略档位汇总、§13 退出门、§14 红线。
2. **`docs/时空错位容纳蓝图.md`（v1.0 冻结）** —— 时代画像 / 统一错位契约 / 年龄基准（baselineWorldTime）的架构基础，internal.52 已实施。
3. **`docs/统一世界书智能检索-DeepSeek-Harness迁移交接与风险审计.md`** —— 迁移审计：四项风险冻结、源码审计结论、旧交接文档与历史蓝图的关系。
4. **`NEXT.md`** —— 完整迭代记录（迁移入口段 + 迭代五~十一段），含每迭代的版本链、验收数字、下一道门。
5. **`manifest.json` 的 notes** —— 用户可见的更新日志（按迭代编号，新在前）。

> 若续作者接到新任务，先读 1+3+4，再按蓝图 §13 退出门核对当前是否满足，最后才动代码；任何改动先解释根因、经驾驶员确认。
