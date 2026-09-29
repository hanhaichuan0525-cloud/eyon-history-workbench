/**
 * 世界书 2 字污染面普查工具（internal.72 共证门配套）。
 * 用法：node scripts/worldbook-pollution-scan.mjs <worldbook.json> [query...] [--task=<ruin|biography>]
 * 输出：
 *   1. 条目统计（总/开启非空）；
 *   2. 索引实体集合中的 2 字词（专名 vs 疑似普通词）；
 *   3. 系统设定类条目的 2 字关键词（污染源词表）；
 *   4. 可选：给定 query 的入选/被拒复现（对照共证门效果）。
 */
import { readFile } from 'node:fs/promises';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { buildRetrievalIndex } from '../src/retrieval/index.ts';
import { SOURCE_SNAPSHOT_SCHEMA } from '../src/retrieval/contracts.ts';

const [, , worldbookPath, ...args] = process.argv;
const taskFlag = args.findIndex(a => a.startsWith('--task='));
const taskType = taskFlag >= 0 ? args.splice(taskFlag, 1)[0].slice('--task='.length) : 'ruin';
const query = args.join(' ');
const raw = JSON.parse(await readFile(worldbookPath, 'utf8'));
const list = Array.isArray(raw.entries)
  ? raw.entries.filter(Boolean)
  : Object.values(raw.entries).filter(Boolean);
const active = list.filter(e => !e.disable && typeof e.content === 'string' && e.content.trim().length > 1);
console.log(`世界书总条目 ${list.length}，开启非空 ${active.length}`);

const snapshots = active.map((e, index) => {
  const keys = [...new Set([...(e.key ?? []), ...(e.keysecondary ?? [])])].filter(Boolean);
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

// ── 1. 索引实体集合的 2 字词 ──
const index = buildRetrievalIndex(snapshots);
const twoChar = [...index.entities.keys()].filter(k => /^[\u4e00-\u9fff]{2}$/u.test(k)).sort();
console.log(`\n=== 索引实体集合 2 字词（${twoChar.length}）===`);
console.log(twoChar.join('、'));

// ── 2. 系统设定类条目的 2 字关键词（污染源词表）──
const sysPattern = /品质|装备|武器|道具|材料|系统|规则|稀有度|等级|属性|数值|设定|世界设定|配方|图纸|技能|法术|铸造|炼金|商店|物价|货币|兵种|天赋|特质|职业|种族|阵营|好感|羁绊|成就|任务|称号|纹章|徽记|徽章|宝箱|掉落|附魔|强化|合成|分解|锻造|铭文|符文|御魂|灵石|丹药|秘卷|机关|建材|家具|时装|坐骑|宠物|状态|效果|生成规则|繁衍|生育|血缘|血脉/u;
const sysEntries = active.filter(e => sysPattern.test(e.comment ?? ''));
const words = new Map();
for (const e of sysEntries) {
  const title = String(e.comment ?? '').trim().slice(0, 18);
  for (const k of [...(e.key ?? []), ...(e.keysecondary ?? [])]) {
    const w = String(k).trim();
    if (w.length === 2 && /^[\u4e00-\u9fff]{2}$/u.test(w)) {
      if (!words.has(w)) words.set(w, []);
      words.get(w).push(title);
    }
  }
}
const rows = [...words.entries()].sort((a, b) => b[1].length - a[1].length);
console.log(`\n=== 系统设定类条目（${sysEntries.length}）的 2 字关键词（${rows.length}）===`);
for (const [w, titles] of rows.slice(0, 60)) {
  console.log(`${w}（${titles.length} 条）← ${[...new Set(titles)].slice(0, 3).join(' | ')}`);
}

// ── 3. 可选：query 复现 ──
if (query) {
  const engine = new UnifiedShadowRetrievalEngine(snapshots);
  const result = await engine.retrieve({
    requestId: 'pollution-scan',
    taskType,
    query,
    mode: 'active',
    baselineWorldTime: '复兴纪元488年',
  });
  console.log(`\n=== query = "${query}" 入选来源 ===`);
  for (const sel of result.bundle.receipt.selected) {
    const sn = result.bundle.sourceSnapshots.find(s => s.snapshotId === sel.snapshotId);
    console.log(`- [${sel.score}] ${sn?.title ?? sel.snapshotId}`);
  }
  const signal = result.bundle.receipt.rejected.filter(r => r.score > 0);
  console.log(`（有信号被拒 ${signal.length} 条）`);
}