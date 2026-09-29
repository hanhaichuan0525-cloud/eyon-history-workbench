/**
 * internal.87 · G-12：蝴蝶记录 `canonStatus` 与当前分支状态对账。
 *
 * 真机病历（2026-09-17，`eyon-canon-memory-r0-20260917.json`）：删楼回退后 head 12→0、
 * 记忆通道正确过滤，但导出中 `reasons` 是 `delta-status:reverted` 而非
 * `record-canon-status:reverted` ⇒ 记录的 `canonStatus` 字段没被标记（仍是 `committed`）。
 *
 * 根因：F-03 的孤儿清扫（`reconcileCanonOrphans`，X/Y 双入口）只回滚 canon、不标记记录；
 * 而 `messageDeleted` 处理器里的标记被 `if (!rollback) return;` 保护——一旦本次回滚不是
 * 它执行的（清扫先跑，或删除发生在脚本未加载时由 Y 入口补清），就整段跳过标记。
 *
 * 影响：`workflows/butterfly.ts` 与 `runtime/butterflyController.ts` 都用
 * `canonStatus !== 'reverted'` 作为「该轮已被回滚，必须重新生成而非复用旧文本」的判据
 * （internal.81 v21）。字段停在旧值 ⇒ 闸误判 ⇒ 复用旧文本、不重新请求模型，
 * 回到「档案永远指向已被回滚的 Canon」的死结。
 *
 * 修法：不依赖"本次 receipt"，而是**按当前分支状态重算**每条记录的 delta 状态——
 * 幂等、自愈，任何来源的回滚都能被记录跟上。
 */

import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { CanonBranch, CanonResolutionReceipt } from '../retrieval/contracts.ts';
import type { ButterflyRepository } from '../storage/butterflies.ts';

export interface CanonStatusSyncResult {
  /** 当前聊天的蝴蝶记录总数。 */
  checked: number;
  /** 实际被改写状态的记录数。 */
  synced: number;
  /** 被改写的 runId（供诊断日志）。 */
  runIds: string[];
}

/**
 * 记录级对账：把每条蝴蝶记录的 `canonStatus` 拉回其 delta 的当前状态。
 *
 * - 记录缺 `deltaRef`（镜像时代旧档案）→ 跳过（与 `assessRecordEffectiveness` 的保守口径一致）；
 * - `deltaRef` 在当前分支里找不到对应 delta → 跳过（宁漏勿错，不臆断状态）；
 * - 状态已一致 → 不写库（幂等，避免无意义 revision 增长）；
 * - 传入 `receipt` 时，顺带把回执写进受影响记录（保留既有审计信息，判据仍是 receiptId 去重）。
 */
export async function syncButterflyCanonStatuses(input: {
  repository: ButterflyRepository;
  namespace: WorkbenchNamespace;
  branch: CanonBranch;
  now: number;
  receipt?: CanonResolutionReceipt;
}): Promise<CanonStatusSyncResult> {
  const records = await input.repository.list(input.namespace);
  const deltasById = new Map(input.branch.deltas.map(delta => [delta.deltaId, delta]));
  const result: CanonStatusSyncResult = {
    checked: records.length,
    synced: 0,
    runIds: [],
  };
  for (const record of records) {
    if (!record.deltaRef) continue;
    const delta = deltasById.get(record.deltaRef);
    if (!delta) continue;
    const receiptApplies = Boolean(input.receipt && record.deltaRef && (
      input.receipt.revertedDeltaIds.includes(record.deltaRef)
      || input.receipt.orphanedDeltaIds.includes(record.deltaRef)
    ));
    const needsReceipt = receiptApplies
      && record.canonReceipt?.receiptId !== input.receipt?.receiptId;
    if (record.canonStatus === delta.status && !needsReceipt) continue;
    await input.repository.updateRecord({
      ...record,
      canonStatus: delta.status,
      ...(needsReceipt && input.receipt ? { canonReceipt: input.receipt } : {}),
      revision: record.revision + 1,
      updatedAt: input.now,
    });
    result.synced += 1;
    result.runIds.push(record.runId);
  }
  if (result.synced > 0) {
    console.info(
      '[Eyon History Workbench] canon record status synced: '
      + `ids=[${result.runIds.join(',')}] checked=${result.checked}`,
    );
  }
  return result;
}
