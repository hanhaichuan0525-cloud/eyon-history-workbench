import type { RuinRuntimeSnapshot } from '../adapters/host.ts';
import type { ButterflyRecord } from '../storage/butterflies.ts';

export interface ButterflyArchiveItem {
  record: ButterflyRecord;
  title: string;
  summary: string;
  statusLabel: string;
  retryable: boolean;
  /** 提交失败原因（internal.81 v17：来自待结算快照的 failure；用于详情展示与重试引导）。 */
  failureReason?: string;
}

export function runtimeStateLabel(
  state: RuinRuntimeSnapshot['flowState'],
): string {
  const labels: Record<RuinRuntimeSnapshot['flowState'], string> = {
    idle: '现实待命',
    exploring: '墟境探索中',
    anchored: '历史锚定中',
    returning: '遣返结算中',
  };
  return labels[state];
}

/**
 * internal.81 v17：除「已写正文/已归档」外，把「预结算成功但提交失败」的记录
 * （record 停在 validated，pending 带 failure）也显示为可重试条目——此前它们被
 * 过滤掉，用户既看不到失败、也没有「重新归档」按钮。
 * failedRunReasons: runId → 失败原因（来自 pending.failure）。
 */
export function visibleButterflyArchives(
  records: ButterflyRecord[],
  failedRunReasons?: ReadonlyMap<string, string>,
): ButterflyArchiveItem[] {
  return records
    .filter(record =>
      record.status === 'committed'
      || record.status === 'mirror_pending'
      || record.status === 'message_committed'
      || (record.status === 'validated'
        && !!failedRunReasons?.get(record.runId)))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((record, index, all) => {
      const ordinal = all.length - index;
      const failed = failedRunReasons?.get(record.runId);
      return {
        record,
        title: extractArchiveTitle(record.archiveEntry)
          || `《蝴蝶效应锚定日志${ordinal}》`,
        summary: `${record.result.effect.scope} · ${record.result.effect.presentLanding}`,
        statusLabel: record.status === 'committed'
          ? '已归档'
          : record.status === 'validated'
            ? '待重试'
            : '待归档',
        retryable: record.status !== 'committed',
        ...(failed ? { failureReason: failed } : {}),
      };
    });
}

function extractArchiveTitle(value: string): string {
  const match = value.match(/《蝴蝶效应锚定日志[^》]*》/u);
  return match?.[0] ?? '';
}
