import type { WorkbenchNamespace } from '../core/namespace.ts';
import type {
  CanonBranch,
  CanonResolutionReceipt,
  CanonRevisionRecord,
  InterventionAction,
  InterventionDelta,
  InterventionDeltaStatus,
} from '../retrieval/contracts.ts';
import { canonBranchId } from '../storage/canon.ts';

export interface CanonBranchInspection {
  schema: 'eyon.canon.inspection.v1';
  namespace: WorkbenchNamespace;
  checkedAt: string;
  branch: Omit<CanonBranch, 'revisions' | 'actions' | 'deltas' | 'receipts'>;
  revisions: CanonRevisionRecord[];
  actions: InterventionAction[];
  deltas: InterventionDelta[];
  receipts: CanonResolutionReceipt[];
  counts: {
    revisions: number;
    actions: number;
    deltas: number;
    receipts: number;
  };
  revisionStatuses: Record<CanonRevisionRecord['status'], number>;
  deltaStatuses: Record<InterventionDeltaStatus, number>;
  issues: string[];
  healthy: boolean;
}

/**
 * 创建当前聊天 Canon 分支的只读诊断副本。
 * 返回值不持有仓库对象引用，也不包含设置或 API 密钥。
 */
export function inspectCanonBranch(
  namespace: WorkbenchNamespace,
  source: CanonBranch,
): CanonBranchInspection {
  const branch = structuredClone(source);
  const issues: string[] = [];
  const expectedBranchId = canonBranchId(namespace);
  const actionById = new Map(branch.actions.map(action => [action.actionId, action]));
  const deltaById = new Map(branch.deltas.map(delta => [delta.deltaId, delta]));
  const receiptById = new Map(branch.receipts.map(receipt => [receipt.receiptId, receipt]));

  if (branch.branchId !== expectedBranchId) issues.push('分支标识与当前聊天命名空间不一致');
  if (branch.characterKey !== namespace.characterKey || branch.chatId !== namespace.chatId) {
    issues.push('Canon 分支包含其他角色或聊天的数据');
  }

  inspectUnique('revision', branch.revisions.map(item => String(item.revision)), issues);
  inspectUnique('action', branch.actions.map(item => item.actionId), issues);
  inspectUnique('delta', branch.deltas.map(item => item.deltaId), issues);
  inspectUnique('receipt', branch.receipts.map(item => item.receiptId), issues);

  const activeHead = Math.max(
    0,
    ...branch.revisions
      .filter(item => item.status === 'active')
      .map(item => item.revision),
  );
  if (branch.headRevision !== activeHead) {
    issues.push(`headRevision=${branch.headRevision}，但活动 revision 头为 ${activeHead}`);
  }

  for (const revision of branch.revisions) {
    const action = actionById.get(revision.actionId);
    const delta = deltaById.get(revision.deltaId);
    const receipt = receiptById.get(revision.receiptId);
    if (!action) issues.push(`revision ${revision.revision} 引用的 action 不存在`);
    if (!delta) issues.push(`revision ${revision.revision} 引用的 delta 不存在`);
    if (!receipt) issues.push(`revision ${revision.revision} 引用的 receipt 不存在`);
    if (revision.parentRevision >= revision.revision) {
      issues.push(`revision ${revision.revision} 的父版本不是更早版本`);
    }
    if (action && action.branchId !== branch.branchId) {
      issues.push(`revision ${revision.revision} 的 action 属于其他分支`);
    }
    if (delta) {
      if (delta.branchId !== branch.branchId) {
        issues.push(`revision ${revision.revision} 的 delta 属于其他分支`);
      }
      if (delta.revision !== revision.revision || delta.parentRevision !== revision.parentRevision) {
        issues.push(`revision ${revision.revision} 与 delta 的版本链不一致`);
      }
      if (delta.actionRef !== revision.actionId) {
        issues.push(`revision ${revision.revision} 与 delta 的 actionRef 不一致`);
      }
      if (revision.status === 'reverted' && delta.status !== 'reverted') {
        issues.push(`revision ${revision.revision} 已回滚，但 delta 状态未同步`);
      }
      if (revision.status === 'orphaned' && delta.status !== 'orphaned') {
        issues.push(`revision ${revision.revision} 已孤立，但 delta 状态未同步`);
      }
      if (revision.status === 'active' && delta.status === 'reverted') {
        issues.push(`revision ${revision.revision} 仍活动，但 delta 已标记为 reverted`);
      }
    }
    if (receipt) {
      if (receipt.branchId !== branch.branchId) {
        issues.push(`revision ${revision.revision} 的 receipt 属于其他分支`);
      }
      if (!receipt.appliedDeltaIds.includes(revision.deltaId)) {
        issues.push(`revision ${revision.revision} 的提交 receipt 未记录其 delta`);
      }
    }
  }

  for (const action of branch.actions) {
    if (action.branchId !== branch.branchId) issues.push(`action ${action.actionId} 属于其他分支`);
  }
  for (const delta of branch.deltas) {
    if (delta.branchId !== branch.branchId) issues.push(`delta ${delta.deltaId} 属于其他分支`);
  }
  for (const receipt of branch.receipts) {
    if (receipt.branchId !== branch.branchId) issues.push(`receipt ${receipt.receiptId} 属于其他分支`);
  }

  const { revisions, actions, deltas, receipts, ...branchSummary } = branch;
  return {
    schema: 'eyon.canon.inspection.v1',
    namespace: structuredClone(namespace),
    checkedAt: new Date().toISOString(),
    branch: branchSummary,
    revisions,
    actions,
    deltas,
    receipts,
    counts: {
      revisions: revisions.length,
      actions: actions.length,
      deltas: deltas.length,
      receipts: receipts.length,
    },
    revisionStatuses: countStatuses(revisions.map(item => item.status), [
      'active', 'reverted', 'orphaned',
    ]),
    deltaStatuses: countStatuses(deltas.map(item => item.status), [
      'active', 'partially-active', 'superseded', 'orphaned', 'reverted',
    ]),
    issues,
    healthy: issues.length === 0,
  };
}

function inspectUnique(label: string, values: string[], issues: string[]): void {
  const duplicates = values.length - new Set(values).size;
  if (duplicates > 0) issues.push(`${label} 中发现 ${duplicates} 个重复标识`);
}

function countStatuses<T extends string>(values: T[], statuses: readonly T[]): Record<T, number> {
  return Object.fromEntries(statuses.map(status => [
    status,
    values.filter(value => value === status).length,
  ])) as Record<T, number>;
}
