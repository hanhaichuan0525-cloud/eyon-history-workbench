# 伊雍历史工作台内测安装（历史记录）

> 本文保留旧内测包的复验步骤，不是当前稳定版安装入口。0.10.0 用户请阅读 [`INSTALL.md`](INSTALL.md)。

## 导入

当前候选包信息：`0.10.0-internal.127`；1,440,650 bytes；SHA-256 `AB3E0664650FE8479970A6819689AAB6005837FD4F9F8FEA7AD9C14879798ADA`。本轮把旧“伊”圆球与独立悬浮框替换为伊雍像素伴生体和依附气泡，并把人物本体作为可拖动区域；同时更新传记、谱系、墟境、蝴蝶效应与系统任务的阶段文案。像素图集原文件约 159 KiB，已随脚本内嵌，不需要额外联网加载。生成合同、Canon、检索、schema、存储与模型调用数均未改变；真实酒馆中的拖动、动效节奏和窄屏气泡仍待本轮测试。

1. 在酒馆助手脚本管理中先关闭旧版伊雍墟境系统脚本与旧虚嗣指南悬浮球；本轮只需禁用，不要删除。
2. 导入 `release/酒馆助手脚本-伊雍历史工作台-内测.json`。
3. 确认只启用一个名为“伊雍历史工作台 内测 0.10.0-internal.127”的脚本。
4. 重新载入当前聊天；页面右下角应只出现一个伊雍像素小人，不再出现“伊”字圆球。单击小人打开工作台；关闭工作台后小人仍留在原位。

内测包同时包含后台运行时、墟境时间内核和正式五栏工作台，不需要再单独加载 `dist/workbench.js`。

## internal.127 最短视觉与拖动复验

1. 在伊雍身体中央按住并拖到左上、右上、左下、右下各一次；松手时不应误开工作台，人物与气泡都随之移动，且不会被拖出屏幕。
2. 把伊雍停在任意非默认位置后刷新聊天；她应恢复到上次位置。随后缩窄窗口，人物应自动回到可见范围，气泡应按剩余空间自动换边。
3. 不拖动时单击伊雍；工作台应正常打开，并且页面中始终只有一个伊雍入口。
4. 生成一篇传记：气泡应先说明查找史料、安排全篇，再显示“正在写第 X–Y/N 段”及当前阶段标题；首次模型请求不应显示“第 1 次尝试”。同一写作阶段只更新文字，不应反复重播整套入场动作。
5. 各运行一次谱系、墟境生成、进入墟境与蝴蝶效应：应依次看到族谱、地图、传送门和命运线动作；成功后短暂显示完成状态，再回到安静待机。
6. 如遇真实报错，确认气泡直接显示可读错误，设置页仍保存技术详情；如主动取消，确认任务停止且气泡退回待机。
7. 若系统开启“减少动态效果”，刷新后动作应停在稳定帧，不出现快速闪动。

## 首轮测试

使用一个新的聊天，依次完成：

1. 打开工作台并读取当前变量。
2. 生成一个候选墟境，选择可进入特异点。
3. 检查酒馆输入框出现一条完整“进入节点”指令，且没有自动发送或产生空白玩家楼；手动确认发送。
4. 在主变量模式下推进两楼，检查墟境时地推进、现实锚点不变。
5. 明确输入“遣返”，检查恢复现实、活动字段清空和蝴蝶效应面板。
6. 分别用手动额外变量和自动额外变量，在新聊天中重复第 2 至第 5 步。

详细检查项见 `docs/TAVERN_INTEGRATION_CHECKLIST.md`。

## Retrieval v1.2 四模块 Active 真实测试

本轮传记、谱系、墟境与蝴蝶效应全部正式使用 `v1.2-catalog-cast` Active。四模块共用统一目录、角色编排、跨实体检索、时代资格账本与 EvidencePassage；核心人物或明确时间事实冲突仍会终止，但可选来源因 passage 预算落选只会进入 rejected，不再杀死整项。不会混入 legacy 或静默回退；旧检索只保留差异诊断与回滚依据，不再生成任何模块的正式上下文。

1. 导入并重载后，确认工作台能正常打开，控制台没有新增的伊雍加载错误。
2. 先原样复测“神明纪元 / 阿斯塔利亚大陆全境 / 狡黠的女神泰珂对其他神明所作的恶作剧”，确认正式来源不再被全境、其他、大陆、神明等泛词扩散，也不再召回其他纪元或无纪元锚点的旁支条目；再按 `docs/01-统一史料检索总设计.md` 的完成定义和 `docs/02-交叉检索、人物事实与Canon版本蓝图.md` 的验收场景测试人物—地点、组织、历史事件和无关键词/opaque 条目。
3. 每项任务完成后，在 DevTools Console 执行：`const o = EyonHistoryWorkbench.listRetrievalShadowObservations().at(-1); const byId = Object.fromEntries((o?.sourceMappings ?? []).map(x => [x.snapshotId, x])); const wb = o?.receipt?.worldbookCorpus; copy(JSON.stringify({ status: o?.status, requestId: o?.requestId, taskType: o?.taskType, strategyVersion: o?.receipt?.strategyVersion, corpus: wb && { complete: wb.complete, bindings: wb.bindings, counts: wb.counts }, catalog: o?.receipt?.catalog, cast: o?.receipt?.cast, selected: (o?.receipt?.selected ?? []).map(x => ({ ...x, source: byId[x.snapshotId] })), selectedPassages: o?.receipt?.selectedPassages, comparison: o?.comparison, diagnostics: o?.diagnostics, error: o?.error }, null, 2));`
4. 四模块的成功回执都应为 `mode: "active"`、`strategyVersion: "v1.2-catalog-cast"`，且 `worldbookCorpus.complete` 为 `true`；`taskType` 应分别对应 `ruin`、`biography`、`genealogy`、`butterfly`。若不是，连同控制台错误原样回报。
5. 每个用例同时记录原始输入、三条候选摘要、最终史稿、生成耗时，以及“该出现/实际出现/不该出现却出现”的角色名单。
6. 墟境通过后，依次测试传记、谱系、蝴蝶效应各一例；任一用例失败时保留该次回执与失败正文，不要删除旧路径或继续发布。
7. 传记优先复测“瑞丝”：不得再出现 `selected source without evidence passage`；回执中每个 `receipt.selected[].snapshotId` 都必须能在 `selectedPassages[].snapshotId` 中找到。墟境复测神明纪元的人类：允许人类出现，但仍不得提前出现奥古斯提姆帝国、成熟教会或公会。

## 确定性主路径 + 共证门测试（internal.71/72）

语义编译层已整体撤销（internal.71）：本轮不使用 embedding、向量库、语义编译器或新 API。检索资格由 internal.72 共证门纯确定性纪律承担——括号「(类别/品质)」标注不拆别名/实体/搜索词；强词（≥3 字或索引实体名）独证开门、2 字非实体泛词必须与强词/正文佐证或 ≥2 弱词互证；`title-exact`/`indexed-term`/`matchedEntities` 匹配面统一到过滤后的查询片段集合。无论选择 3、4 或 5 个墟境候选，提纲、全部自动扩写、repair 与失败候选重试都复用同一份冻结证据。

墟境的时代、地点、人物、事件和玩家补充方向进入检索；骰表、基调、文风与内部流程指令只进入创作提示。诊断中应看到确定性收录/拒绝原因（如 `indexed-weak`、`catalog-direct`、`no-retrieval-signal`），不再有任何语义提示次数；污染面普查可用仓库脚本：`node scripts/worldbook-pollution-scan.mjs <世界书.json> "<查询>"`。

Citation Contract v2 已同时覆盖传记、谱系、墟境和蝴蝶：若本轮没有人物 CanonFact，`allowedFactRefs` 应为 `[]`，模型即使误写 `F1` 也不得再让整项报错；墟境应保留正文，并在 `inferenceNotes` 留下 `citation-ref-dropped:fact:F1`。提纲与扩写使用同一任务编号，新阶段只追加，不得把旧 `P/F/E/S` 重新编号。

建议先复测两组已知样本：

1. 墟境：英雄纪元 / 奥古斯提姆帝国 / 第二次位面入侵时帝国军方的英雄群像。补充方向可写「英雄史诗」——检查装备品质/技能规则条目不再被召入（历史污染案例：曾因「史诗」档位词 2133 分污染、现为 0 入选）。
2. 墟境：复兴纪元 / 伯伦斯法环-雾晶港 / 补充方向「探查一件流失的史诗品质装备的下落」——检查装备/锻造/品质规则条目照常到达（需求场景保全）。
3. 传记或墟境：玲山·哈姆斯沃思。检查铃羽、离开梵尼亚、抵达帝国、梅薇娜赠书等分散经历是否被发现，同时没有把资料排列强行当成年表。

每个任务完成后，在 Chrome DevTools Console 粘贴以下整块代码。代码兼容异步 facade 以及数组/对象两种历史返回形态，不依赖 DevTools 的 `copy()`；它会打印结果、尝试写入系统剪贴板，并自动下载一份诊断 JSON：

```js
(async () => {
  const host = window.parent || window;
  const api = host.EyonHistoryWorkbench || window.EyonHistoryWorkbench;
  if (!api) throw new Error('EyonHistoryWorkbench 未加载');

  const asArray = (value, keys = []) => {
    if (Array.isArray(value)) return value;
    for (const key of keys) {
      if (Array.isArray(value?.[key])) return value[key];
    }
    if (value && typeof value === 'object') return Object.values(value);
    return [];
  };
  const safeCall = async (name, keys = []) => {
    try {
      const fn = api[name];
      if (typeof fn !== 'function') return [];
      return asArray(await Promise.resolve(fn.call(api)), keys);
    } catch (error) {
      console.warn(`${name} 读取失败`, error);
      return [];
    }
  };

  const [observations, prompts, ruins] = await Promise.all([
    safeCall('listRetrievalShadowObservations', ['items', 'observations']),
    safeCall('listPromptDiagnostics', ['items', 'diagnostics']),
    safeCall('listRuins', ['items', 'records', 'ruins']),
  ]);
  const latestRuin = [...ruins].reverse().find(item => item?.requestId) ?? null;
  const latestRuinObservation = [...observations].reverse().find(
    item => item?.taskType === 'ruin' && item?.status === 'success',
  ) ?? [...observations].reverse().find(item => item?.taskType === 'ruin') ?? null;
  const requestId = latestRuin?.requestId ?? latestRuinObservation?.requestId ?? '';
  const relevantObservations = observations.filter(item =>
    item?.taskType === 'ruin'
    && (!requestId || String(item?.requestId ?? '').startsWith(requestId)),
  );
  const relevantPrompts = prompts.filter(item =>
    item?.taskType === 'ruin'
    && (!requestId || String(item?.requestId ?? '').startsWith(requestId)),
  );
  const semanticPrompts = relevantPrompts.filter(item => item?.stage === 'semantic-evidence');
  const candidates = asArray(
    latestRuin?.result?.candidates ?? latestRuin?.candidates,
    ['items', 'candidates'],
  );
  const semanticReceipts = relevantObservations
    .map(item => item?.receipt?.semanticEvidence)
    .filter(Boolean);
  const unique = values => [...new Set(values.filter(value => value != null))];
  const payload = {
    capturedAt: Date.now(),
    loaderVersion: host.__eyonHistoryWorkbenchInternalLoader?.version
      ?? host.document?.querySelector?.('style[data-eyon-history-workbench-loader]')
        ?.dataset?.eyonHistoryWorkbenchLoader
      ?? null,
    runtimeVersion: api.version ?? null,
    requestId,
    summary: {
      compilerVersions: unique(semanticReceipts.map(item => item.compilerVersion)),
      modes: unique(semanticReceipts.map(item => item.mode)),
      callCount: semanticReceipts.reduce((sum, item) => sum + Number(item.callCount ?? 0), 0),
      cacheHits: semanticReceipts.reduce((sum, item) => sum + Number(item.cacheHits ?? 0), 0),
      expansionUsed: semanticReceipts.some(item => item.expansionUsed === true),
      compilerRoles: unique(semanticReceipts.map(item => item.compilerRole)),
      localExpansionPassageCount: semanticReceipts.reduce(
        (sum, item) => sum + Number(item.localExpansionPassageCount ?? 0), 0,
      ),
      fallbackWarnings: relevantObservations.flatMap(item => [
        ...(item?.receipt?.semanticEvidence?.warnings ?? []),
        ...(item?.receipt?.warnings ?? []),
      ]).filter(text => /fallback|parse|invalid|array|semantic compiler/iu.test(String(text))),
      semanticPromptCount: semanticPrompts.length,
      semanticPromptChars: semanticPrompts.map(item => item.promptChars),
      maxSemanticPromptChars: Math.max(0, ...semanticPrompts.map(item => Number(item.promptChars ?? 0))),
      retrievalMs: relevantObservations.map(item => item?.diagnostics?.retrievalMs).filter(Number.isFinite),
      totalDurationMs: relevantObservations.map(item => item?.diagnostics?.totalDurationMs).filter(Number.isFinite),
    },
    latestRuin: latestRuin ? {
      requestId: latestRuin.requestId,
      status: latestRuin.status,
      updatedAt: latestRuin.updatedAt,
      candidates: candidates.map(candidate => ({
        id: candidate?.id,
        title: candidate?.title,
        span: candidate?.span,
        evolution: candidate?.evolution,
        transition: candidate?.transition,
        historyProse: candidate?.historyProse,
        canonInterpretation: candidate?.canonInterpretation,
        sourceRefs: candidate?.sourceRefs,
      })),
    } : null,
    retrievalObservations: relevantObservations,
    promptDiagnostics: relevantPrompts.slice(-16),
  };
  const text = JSON.stringify(payload, null, 2);
  console.log(payload);
  console.log(text);
  let clipboardCopied = false;
  try {
    await navigator.clipboard.writeText(text);
    clipboardCopied = true;
  } catch (error) {
    console.info('剪贴板权限不可用，仍会自动下载诊断 JSON', error);
  }
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = host.document.createElement('a');
  link.href = url;
  link.download = `eyon-internal70-diagnostic-${Date.now()}.json`;
  link.style.display = 'none';
  host.document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  console.info(`P0-D 诊断已下载；剪贴板写入：${clipboardCopied ? '成功' : '未授权'}`);
  return payload;
})()
```

回传时请附上：原始任务输入、完整生成正文、上述诊断 JSON、生成耗时，以及“该出现却没出现 / 不该出现却出现 / 地点或事件被误判”的人工观察。若任务报错，再附上完整错误文本与控制台红色错误。

## 重新打包

```bash
npm run build
npm run package:internal
```

打包器会核对 `dist/index.js`、`dist/workbench.js` 与 `manifest.json` 的 SHA-256。清单过期时会拒绝生成，避免把错误构建交给测试者。

## 私有仓库限制

当前仓库为私有仓库，浏览器中的酒馆脚本不能匿名访问 GitHub Raw 或 jsDelivr，因此本轮使用内嵌构建的导入包。将来若提供公开发布仓库或独立静态发布地址，再切换为只包含远程网址的轻量加载器。
