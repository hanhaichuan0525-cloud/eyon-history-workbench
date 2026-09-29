# P4-D 增量缓存与 P4-E 文档收口

> 状态：**P4-D IMPLEMENTED / AUTOMATED / PACKAGED / DRIVER PENDING；P4-E CLOSED**
> 内测检查点：`0.10.0-internal.117`
> 日期：2026-09-27
> 上位合同：[05-P4跨产物连续性蓝图.md](./05-P4跨产物连续性蓝图.md)

## 1. 本次完成了什么

P4-D 只在内存中缓存两类可重算结果：

1. 传记、谱系、墟境读取的 `ContinuityView`；
2. 谱系记录按当前 Canon 分支投影出的 `GenealogyLocalView`。

缓存不保存事实、不修改产物、不写入 IndexedDB，也不参与 Canon、P2 状态或 P3 因果判断。命中缓存只是跳过同输入的重复派生；miss、损坏、容量淘汰和写入失败都回到原冷计算。

P4-E 同步完成了 P4 权威文档、进度账本、版本边界和下一道门的收口。G-08 仍是独立的普通正文消费者合同，不纳入 P4 完成分母。

## 2. 冻结实现

缓存键包含：

```text
namespace + branchId + canonRevision + queryScopeHash
+ module + subject/entity scope + time scope + location scope
+ anchorSetHash + assessmentPolicyVersion
```

- `assessmentPolicyVersion = p4-derived-cache.v1`；
- 内存容量固定为 96 个派生视图，按最近使用顺序淘汰；
- 诊断最多保存 128 条，只记录键、模块、聊天/分支/revision、anchorSetHash、事件与短错误，不保存正文、世界书或完整 prompt；
- 读取时返回结构化克隆，调用方无法修改缓存原值；
- `ContinuityView` 的 `anchorSetHash` 只覆盖查询直接命中的锚、它们的直接关系成员、相关 P2 绑定与相关 delta 状态；无关锚新增不会让当前影响窗失效；
- 谱系局部视图同时以读取方 namespace、分支、revision、谱系不可变记录与相关 delta 为键，禁止同 branchId 跨聊天复用；
- 脚本 dispose 时释放缓存；公开门面只读诊断并提供“只清 P4 派生缓存”的独立方法，不复用会删除生成档案的旧清理入口。

## 3. 权力边界

P4-D 没有改变：

- 锚、关系或谱系局部状态的生成规则；
- Canon/P2/P3 的判定权；
- 传记、谱系、墟境、蝴蝶提示词与模型调用次数；
- 任何已提交正文、世界书、MVU、IndexedDB 记录；
- P4-C2 的史料疑云叙事；
- G-08 普通正文注入。

缓存清理只删除可重算内存结果。它不能删除传记、谱系、事实锚或 Canon，也不能恢复旧 revision。

## 4. 自动化验收

| 编号 | 结果 |
|---|---|
| IC-01 | 相同键命中；命中结果与冷值深度等价，且返回隔离副本 |
| IC-02 | revision 改变必定 miss |
| IC-03 | 无关锚不进入影响窗 hash，可复用；相关锚改变必定 miss |
| IC-04 | 删除相关生产产物导致 anchorSetHash 改变并重算 |
| IC-05 | 损坏值和容量淘汰均 fail-open，不向生成链抛错 |
| IC-06 | namespace、聊天、分支隔离；清缓存不影响持久产物 |

证据：新增专项 6/6；全量 684/684；typecheck 通过；三份本地正则契约通过；生产构建通过，六份 bundle 与 manifest SHA-256 已重新核对。构建仅有既有的 `index.js`、`workbench.js` 体积建议警告，没有编译错误。内测包已完成 JSON 解析、版本、loader 身份、UTF-8、runtime/workbench 反向哈希，以及 `p4-derived-cache.v1`、`inspectContinuityCache()`、`clearContinuityCache()` 包内标记核验。未执行安装、真实酒馆调用、远程 API 或正式发布。

内测包：`release/酒馆助手脚本-伊雍历史工作台-内测.json`，1,195,579 bytes，SHA-256 `D2E6BCACA6B6A4A7B74265A5CEF81C03D3C76619419A95697433094B765DD8C7`。上一包 internal.116 已原样归档至 `release/archive/0.10.0-internal.116-v1/`，归档包 SHA-256 仍为 `FA5D4AEA8071178D600022A69EE933750B3950B45EA322F6A6B3207FF4FF76E8`。

## 5. P4 收口结论

P4-A、P4-B、P4-C、P4-C2、P4-D 的代码路径均已实现，P4-E 文档已闭合。这里的“P4 实现完成”不等于所有历史场景均被正式发行验收：

- P4-A2 的“沉睡之眼焚毁后不无据复活”定点场景已由驾驶员通过；其他 A 场景仍保留各自证据边界；
- P4-B、P4-C 已由驾驶员通过；
- P4-C2 由驾驶员选择在当前《暮潮手札》结果处停止继续修补，记为 **DRIVER CLOSED WITH KNOWN LIMITATION**，不是宣称 HM 全表严格通过；
- P4-D 自动化通过，真实酒馆缓存诊断仍待驾驶员短验收；
- G-08 不属于 P4，不因本次收口自动开工。

## 6. 下一道门

下一道门是在真实酒馆导入 `internal.117`，只做 P4-D 短验收：

1. 同一聊天、同一 revision、同一任务连续读取两次，`inspectContinuityCache()` 出现相同 branch/revision 的 `stored → hit`；
2. 新增无关传记锚后重复原任务，相关影响窗仍可命中；
3. 删除相关生产传记或切换 revision 后，原键不命中且生成正常；
4. 切聊天或分支后不出现旧 namespace 的命中；
5. 调用 `clearContinuityCache()` 后只见缓存 size 归零，传记、谱系与 Canon 数量不变。

在这道短验收完成前，状态保持 `P4-D DRIVER PENDING`，不得写成正式 release。
