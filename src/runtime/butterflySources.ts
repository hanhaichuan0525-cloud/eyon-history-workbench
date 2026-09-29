/**
 * internal.87 · 蓝图 §6 步 B：蝴蝶检索源从「世界书镜像」迁到「本地记录 + 唯一当前视图投影」。
 *
 * 迁移前（镜像时代）：`getButterflySources()` 只从**已挂载世界书**里捞
 * `extra.source === 'eyon_butterfly_anchor'` 且 `chat_id` 匹配的条目——它把
 * 「条目是否启用」当有效性，已回滚的档案照样当史料候选（§5.5 明确禁止）。
 *
 * 迁移后：源 = 本地 `ButterflyRecord`，但**先经 `resolveCanon(branch, headRevision, scope)`
 * 投影**为当前有效片段（§6.2：不得直接把记录原稿当正文候选池）：
 * - 记录须 `committed` 且带 `deltaRef`；
 * - delta 必须在唯一当前视图里被应用（未验证／已 reverted/orphaned/superseded／
 *   依赖断裂者一律不进候选池）；
 * - 作用域用「本聊天全部分支 delta 的 cascadeScope 并集」构造：每个 delta 用自己的
 *   实体/地点/名称自证在界内，只让版本与依赖决定去留——避免用任务侧 scope 提前筛掉史料。
 */

import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { CanonRepository } from '../storage/canon.ts';
import type { ButterflyRecord, ButterflyRepository } from '../storage/butterflies.ts';
import { resolveCanon } from '../retrieval/canonResolver.ts';
import type {
  CanonBranch,
  CanonQueryScope,
  CanonResolutionBranch,
} from '../retrieval/contracts.ts';

export interface ButterflyRetrievalSource {
  sourceId: string;
  title: string;
  content: string;
}

/** 记录标题：优先档案标题（`### 标题`），其次面板标题，最后 runId。 */
export function butterflyRecordTitle(record: ButterflyRecord): string {
  const fromArchive = record.archiveEntry.match(/^###\s+(.+)$/mu)?.[1]?.trim();
  const fromPanel = record.panel.match(/\[标题\|([^\]]+)\]/u)?.[1]?.trim();
  return fromArchive || fromPanel || record.runId;
}

/** 只用版本与依赖判断去留，因此基数用空 Canon 视图（不引世界书正文副本）。 */
function emptyBaseCanon(): CanonResolutionBranch['baseCanon'] {
  return {
    facts: [],
    eventRelations: [],
    personViews: [],
    passages: [],
    sourceSnapshots: [],
  };
}

/** 作用域并集：每个 delta 用自己的实体/地点/名称自证在界内。 */
export function buildButterflySourceScope(branch: CanonBranch): CanonQueryScope {
  const subjectEntityIds = new Set<string>();
  const spatialScopes = new Set<string>();
  const names = new Set<string>();
  for (const delta of branch.deltas) {
    for (const id of delta.cascadeScope.entityIds ?? []) subjectEntityIds.add(id);
    for (const location of delta.cascadeScope.locations ?? []) spatialScopes.add(location);
    for (const name of delta.cascadeScope.subjectNames ?? []) names.add(name);
  }
  return {
    subjectEntityIds: [...subjectEntityIds],
    // 时间闸留空：投递窗口由任务侧检索决定，这里只回答"哪个版本仍有效"。
    temporalScopes: [],
    spatialScopes: [...spatialScopes],
    sourceIds: [],
    names: [...names],
  };
}

/**
 * 当前有效的蝴蝶档案源（步 B 后为**唯一**蝴蝶史料入口）。
 * 无记录／无分支／投影失败 → 返回空（宁缺勿错，不退回镜像）。
 */
export async function loadCurrentButterflySources(input: {
  butterflies: ButterflyRepository;
  canon: CanonRepository;
  namespace: WorkbenchNamespace;
}): Promise<ButterflyRetrievalSource[]> {
  const records = await input.butterflies.list(input.namespace);
  const candidates = records.filter(record =>
    record.status === 'committed' && Boolean(record.deltaRef));
  // 无候选时连分支都不必读（新聊天/全为未归档记录：宁缺勿错，不退回镜像）。
  const branch = candidates.length > 0
    ? await input.canon.getBranch(input.namespace)
    : null;
  let sources: ButterflyRetrievalSource[] = [];
  if (branch && branch.revisions.length > 0) {
    const view = resolveCanon(
      { ...branch, baseCanon: emptyBaseCanon() },
      branch.headRevision,
      buildButterflySourceScope(branch),
    );
    const applied = new Set(view.resolutionReceipt.appliedDeltaIds);
    sources = candidates
      .filter(record => applied.has(record.deltaRef!))
      .sort((left, right) => (right.canonRevision ?? 0) - (left.canonRevision ?? 0))
      .map(record => ({
        sourceId: `butterfly:${record.runId}`,
        title: butterflyRecordTitle(record),
        content: record.archiveEntry,
      }));
  }
  // 真机复验用（internal.88）：一次看清蝴蝶史料供料是否成立——
  // records=本地档案数 / committed=可候选数 / effective=当前分支仍有效数。
  console.info(
    '[Eyon History Workbench] butterfly sources: '
    + `records=${records.length} committed=${candidates.length} `
    + `effective=${sources.length} revision=${branch?.headRevision ?? 0}`,
  );
  return sources;
}
