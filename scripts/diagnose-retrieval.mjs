/**
 * 临时诊断：真实世界书 → 检索复现与实体集合纯度检查。
 * 用法：node scripts/diagnose-retrieval.mjs <worldbook.json> <query...>
 */
import { readFile } from 'node:fs/promises';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { SOURCE_SNAPSHOT_SCHEMA } from '../src/retrieval/contracts.ts';

const [, , worldbookPath, ...queryParts] = process.argv;
const query = queryParts.join(' ');
const raw = JSON.parse(await readFile(worldbookPath, 'utf8'));
const list = Array.isArray(raw.entries)
  ? raw.entries.filter(Boolean)
  : Object.values(raw.entries).filter(Boolean);
const active = list.filter(e => !e.disable && typeof e.content === 'string' && e.content.trim().length > 1);
console.log(`世界书总条目 ${list.length}，开启非空 ${active.length}，query = "${query}"`);

const snapshots = active.map((e, index) => {
  const keys = [...new Set([...(e.key ?? []), ...(e.keysecondary ?? []), ...(e.key ?? [])])].filter(Boolean);
  return {
    schema: SOURCE_SNAPSHOT_SCHEMA,
    logicalId: `worldbook:${e.uid}`,
    snapshotId: `worldbook:${e.uid}@sha256:${index}`,
    versionHash: String(index),
    sourceType: 'worldbook',
    title: String(e.comment ?? e.uid),
    content: String(e.content),
    sourceOrder: index,
    metadata: {
      sourceId: `worldbook:${e.uid}`,
      strategy: { primaryKeys: keys, secondary: { keys: [], logic: 'or' } },
    },
  };
});

const engine = new UnifiedShadowRetrievalEngine(snapshots);
// 实体集合里 2 字普通词污染检查
const entityKeys = [...engine['index'].entities.keys()];
const twoCharCommon = entityKeys.filter(k => /^[\u4e00-\u9fff]{2}$/.test(k));
const suspicious = twoCharCommon.filter(k => !/^(?:圣都|帝国|翼民|精灵|血族|巨龙|魔物|人鱼|矮人|亡灵|兽族|贵族|女皇|女王|议会|学院|城市|北境|文化|政治|地理|环境|庆典|黑市|白港|哈桑|泰珂|玲山|铃羽|澪|瑞丝|薇吉|天原|银莳|缪尔|塞壬|愿灵|花灵|诗灵|英灵|素体|龙裔|古龙|亚龙|异神|魔导|药剂|炼金|锻造|材料|技能|附魔|繁衍|生育|信仰|妖|灵|城|港|岛|湖|河|山|矿|塔|堡|营|寨|城邦)$/u)
console.log('索引实体名总数:', entityKeys.length);
console.log('2 字实体名:', twoCharCommon.length);
console.log('疑似被误收的 2 字普通词:', suspicious.length > 0 ? suspicious.join('、') : '(无)');

// 复现检索
const result = await engine.retrieve({
  requestId: 'diagnose',
  taskType: 'ruin',
  query,
  mode: 'active',
  baselineWorldTime: '复兴纪元488年',
});
console.log('\n=== 入选来源（receipt.selected）===');
for (const sel of result.bundle.receipt.selected) {
  const sn = result.bundle.sourceSnapshots.find(s => s.snapshotId === sel.snapshotId);
  console.log(`- [${sel.score}] ${sn?.title ?? sel.snapshotId}`);
}
console.log('=== 候选打分明细（score>0 前 15）===');
const diag = result['diagnostics'] ?? {};
const rankedInfo = result.bundle.receipt.selected
  .map(sel => ({ ...sel, title: result.bundle.sourceSnapshots.find(s => s.snapshotId === sel.snapshotId)?.title ?? '' }));
// 从引擎内部拿不到 ranked——改用 shadow 引擎的公开观察（无），这里打印 rejected 带理由的
for (const rej of result.bundle.receipt.rejected.filter(r => r.score > 0).slice(0, 15)) {
  const sn = result.bundle.sourceSnapshots.find(s => s.snapshotId === rej.snapshotId);
  console.log(`- [${rej.score}] ${rej.reason} ${sn?.title ?? rej.snapshotId}`);
}