/**
 * F-03（internal.83）· Canon 孤儿清扫：
 * 宿主批量删除/截断聊天时只对部分消息派发 messageDeleted（真机病历：删到第 47 楼后
 * 绑 52/58 的 revision 收不到删除事件），revision 的绑定楼与宿主消息生命周期脱节，
 * 留下「删不掉」的孤儿 active（永远作为当前正史投递）。
 *
 * 方案：脚本不再干等删除事件——在确定的触发点（收到任意删楼事件后 / 工作台就绪时）
 * 主动核对所有 active revision 的绑定楼是否仍存在；宿主明确不存在者，
 * 复用 rollbackByMessageId（与手动删楼同语义、同审计）。
 *
 * 纪律（宁漏勿错）：
 * - 只有宿主查询成功且明确返回「不存在」才判孤儿；
 * - 查询抛错一律跳过该 id（下个触发点再试）；
 * - 绑定楼健在的 revision 一个不碰（正常流程零误杀）。
 */

import type { WorkbenchNamespace } from '../core/namespace.ts';
import type { CanonBranch } from '../retrieval/contracts.ts';
import type {
  CanonRepository,
  CanonRollbackResult,
} from '../storage/canon.ts';

/** 宿主消息存在性探测：返回 true=存在，false=明确不存在。 */
export type MessageExistenceProbe = (messageId: number) => boolean | Promise<boolean>;

/** 孤儿判定：active revision 的绑定楼宿主明确不存在（去重、升序）。 */
export async function findOrphanedActiveMessageIds(
  branch: CanonBranch,
  probe: MessageExistenceProbe,
): Promise<number[]> {
  const activeMessageIds = [...new Set(
    branch.revisions
      .filter(item =>
        item.status === 'active'
        && Number.isInteger(item.assistantMessageId)
        && item.assistantMessageId > 0)
      .map(item => item.assistantMessageId as number),
  )].sort((left, right) => left - right);
  const orphans: number[] = [];
  for (const messageId of activeMessageIds) {
    let exists: boolean;
    try {
      exists = await probe(messageId);
    } catch {
      continue; // 查询异常 → 跳过（宁漏勿错）
    }
    if (exists === false) orphans.push(messageId);
  }
  return orphans;
}

/**
 * 清扫执行：对每个孤儿楼号调用 rollbackByMessageId（v22 同款：同楼跨 run 全量回滚、
 * 后继孤儿化、receipt 留痕）。二次清扫天然幂等（孤儿已 reverted，rollback 返回 null）。
 */
export async function reconcileCanonOrphans(
  repository: CanonRepository,
  namespace: WorkbenchNamespace,
  probe: MessageExistenceProbe,
  now: number,
): Promise<{ orphanedMessageIds: number[]; receipts: CanonRollbackResult[] }> {
  const branch = await repository.getBranch(namespace);
  const orphanedMessageIds = await findOrphanedActiveMessageIds(branch, probe);
  const receipts: CanonRollbackResult[] = [];
  // 降序处理（先清高楼）：v22 applyRollback 会把「比被删 revision 更新」的 active
  // 后继孤儿化——若按升序先清低楼，尚存的同批孤儿会被误判成孤儿化而非干净回滚；
  // 降序时每条孤儿都直接 reverted，只剩真正的「楼健在的上游断裂」后继才孤儿化。
  for (const messageId of [...orphanedMessageIds].reverse()) {
    const result = await repository.rollbackByMessageId(namespace, messageId, now);
    if (result) receipts.push(result);
  }
  if (orphanedMessageIds.length > 0) {
    console.info(
      '[Eyon History Workbench] canon orphans reconciled: '
      + `ids=[${orphanedMessageIds.join(',')}] receipts=${receipts.length}`,
    );
  }
  return { orphanedMessageIds, receipts };
}

/** 便捷构造：基于 TavernRuntime 风格的消息查询适配层（查询失败视为存在，防误杀）。 */
export function runtimeMessageExistenceProbe(
  queryMessage: (messageId: number) => Array<{ message_id: number }> | undefined,
): MessageExistenceProbe {
  return (messageId: number): boolean => {
    const list = queryMessage(messageId);
    if (!list) return true; // 宿主不提供 → 视为存在
    return list.some(message => Number(message.message_id) === messageId);
  };
}
