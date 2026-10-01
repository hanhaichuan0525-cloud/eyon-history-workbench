import type { WorkbenchStatusDetail } from './facade.ts';

export function isTaskBusy(detail: WorkbenchStatusDetail | null): boolean {
  return Boolean(detail && ['running', 'retrying', 'recovered'].includes(detail.phase ?? ''));
}

/** 请求心跳只能补充等待信息，不能覆盖工作流的史稿计数或任务起点。 */
export class TaskStatusProjection {
  private readonly tasks = new Map<string, WorkbenchStatusDetail>();

  clear(): void { this.tasks.clear(); }

  project(next: WorkbenchStatusDetail, now = Date.now()): WorkbenchStatusDetail {
    const key = next.taskType ?? 'system';
    const previous = this.tasks.get(key);
    const starting = ['assembling_context', 'retrying_candidate', 'generating_ruin_task_draft'].includes(next.status);
    const active = starting ? undefined : previous;
    const requestEvent = next.status === 'generating' || next.status === 'retrying_generation';
    const busy = isTaskBusy(next);
    const result: WorkbenchStatusDetail = {
      ...next,
      startedAt: busy ? active?.startedAt ?? next.progress?.startedAt ?? now : undefined,
      progress: requestEvent ? active?.progress : next.progress ?? (busy ? active?.progress : undefined),
      retry: requestEvent ? next.retry ?? active?.retry : next.retry,
      request: busy ? next.request : undefined,
    };
    if (requestEvent && active && !starting) {
      // 当前请求拥有阶段文案，流程只拥有总起点与完成计数；不把同义阶段拼成两遍。
      result.detail = next.request?.label || next.detail || active.detail;
    }
    if (!requestEvent || !active) this.tasks.set(key, result);
    else this.tasks.set(key, { ...active, startedAt: result.startedAt, retry: result.retry });
    if (!busy) this.tasks.delete(key);
    return result;
  }
}
