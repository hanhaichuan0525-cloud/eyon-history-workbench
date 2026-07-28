# 运行时与楼层事务

## 原则

历史工作台不自行创建助手楼，不代写伊雍对白，也不解析或覆盖 MVU。

独立 API 只生成结构化史料。伊雍对白、`mood`、`<eyon_court/>` 与正文流式输出仍由当前角色卡世界书、酒馆预设和正文模型自然生成。

## 两阶段提交

### 生成前准备

`manifest.generate_interceptor` 指向 `eyon_history_generateInterceptor`。酒馆在正常生成、重 Roll 或 swipe 前等待该函数完成。

拦截器只读取当前聊天中最新的可见玩家楼。若该楼是严格的寻根溯源命令：

1. 记录角色卡标识、聊天 ID、玩家楼号、文本指纹与 swipe。
2. 装配世界书、MVU 人物、最近正文、族谱、既有传记和蝴蝶效应资料。
3. 调用独立 API，并校验唯一 JSON 与来源引用。
4. 将已校验传记保存为 `validated`。
5. 通过独立的 `setExtensionPrompt` 槽注入本轮正文协作指令。
6. 返回控制权，让酒馆正常生成并流式显示伊雍正文。

脚本不会在此阶段调用 `createChatMessages`。

若该楼是严格的“墟境探索”命令，统一生命周期会从界面状态读取一份完整 `RuinGenerationInput`，然后：

1. 锁定角色卡标识、聊天 ID、玩家楼号、文本指纹、swipe 与生命周期代际。
2. 只读装配世界书、最近正文、MVU人物摘要、族谱、传记和蝴蝶效应摘要。
3. 调用独立 API，并严格核对候选数量、骰表素材映射、来源 ID、时间单调性和可进入特异点。
4. 按 `角色卡标识 + 聊天 ID` 保存候选结果。
5. 不创建助手楼，不修改 `/世界`、`/墟境系统` 或任何 MVU 字段，也不把“生成候选”视作“进入节点”。

玩家在界面选中可进入特异点后，`RuinEntryWorkflow` 会重新读取点击时现实锚点，并核对当前聊天、候选记录、节点可进入性和 `idle` 状态。全部成立时，`buildRuinEntryText` 才把以下内容合并为唯一玩家楼：

- 明确的“进入节点”指令。
- 点击时现实时间和地点。
- 目标墟境时地、因果机制、参与人物、物质条件和介入分支。
- 玩家补充方向与稳定资料标识。
- 保持现有美化字段顺序的唯一 `RuinTrace`。

正文模型在紧邻助手楼中承接上一楼剧情，自然描写穿越，并依据现有世界书和MVU规则完成 `exploring`、现实锚点、世界时地及墟境时地更新。工作台不会提前写状态，也不会创建候选确认楼。

宿主必须以一个原子 `UserTurnAdapter.sendUserTurn` 实现“写入玩家输入并启动一次正常生成”，返回真实玩家楼ID。不得先创建玩家楼再另行发送第二条进入命令。

### 正文楼提交

收到 `CHARACTER_MESSAGE_RENDERED` 后，脚本重新核验：

- 角色卡标识和聊天 ID 没有变化。
- 玩家楼仍是同一楼，正文指纹和 swipe 没有变化。
- 新助手楼紧邻该玩家楼，并且仍是当前最新楼。
- 请求 ID、来源哈希与待提交记录一致。

全部成立时，脚本只替换唯一 RootTrace 插槽，并把事务标记写入 `message.extra`。`message.data` 留给 MVU 和其他楼层变量框架。

任一条件不成立时拒绝提交，不向别的楼层补写。

## 生命周期清理

`CHAT_CHANGED`、脚本卸载、准备失败和提交结束都会清空本次扩展提示槽与内存中的待提交事务。传记正文和候选墟境都按 `角色卡标识 + 聊天 ID` 隔离，换存档后不会沿用上一存档的资料。

候选墟境还使用 `RuinTransactionGuard` 记录生命周期代际。宿主组装时必须把同一个 guard 实例同时传给 `RuinController` 与 `createRuinIdentityAssertion`：

```ts
const guard = new RuinTransactionGuard();
const assertCurrent = createRuinIdentityAssertion(runtime, guard);
const workflow = new RuinWorkflow({ ...dependencies, assertCurrent });
const controller = new RuinController(workflow, runtime, hooks, guard);
```

这样即使请求期间切走聊天后又迅速切回，旧响应也不能落库。重复点击同一楼层、同一 swipe、同一输入时只复用一笔在途请求；新代际不会被旧请求的清理回调误删。

## 生成类型

寻根溯源和墟境探索只处理：

- 正常生成
- 重新生成
- swipe

续写、quiet 和 impersonate 不触发后台传记生成，以免把同一命令误当成新请求。

## 当前接入边界

本模块已经提供统一命令路由、上下文装配、传记两阶段工作流、候选墟境单阶段事务、楼层锁和事件注册器。正式宿主入口仍需提供：

- 酒馆助手 API 到 `TavernRuntime` 的薄适配。
- 当前启用世界书与 MVU 人物的只读来源适配。
- 设置页到 `GenerationSettingsProvider` 的读取。
- IndexedDB 传记与候选墟境仓库实例。
- 设置/面板状态到 `RuinGenerationInputProvider` 的只读转换。

这些适配不得读写记忆插件私有数据库，也不得修改现有墟境时间控制模块。

## 人物查看器

人物目录只读获取当前聊天的 `stat_data.关系列表`。界面中的“删除人物”只是把人物标识加入当前角色卡、当前聊天的本地隐藏清单：

- 不删除或修改 MVU 人物对象。
- 不改变人物在传记、族谱、墟境和蝴蝶效应资料装配中的可用性。
- 隐藏清单不会跨角色卡或聊天存档复用。
- 操作期间若聊天发生切换，本次修改会被拒绝。

“同步变量”会清空当前聊天的隐藏清单，并重新读取 `stat_data.关系列表`。仍存在于 MVU 中的人物会重新显示，已经从 MVU 中真正删除的人物不会被伪造回来。
