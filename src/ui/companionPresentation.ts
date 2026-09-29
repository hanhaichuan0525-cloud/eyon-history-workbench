import type { WorkbenchStatusDetail } from '../runtime/facade.ts';

export type CompanionMotion =
  | 'idle'
  | 'biography'
  | 'success'
  | 'error'
  | 'genealogy'
  | 'ruin-map'
  | 'ruin-portal'
  | 'butterfly'
  | 'system'
  | 'workbench';

export interface CompanionPresentation {
  title: string;
  motion: CompanionMotion;
  state: 'idle' | 'working' | 'success' | 'error' | 'cancelled';
}

/**
 * 任务事件只携带稳定状态词；角色化文案是 UI 投影，不回写业务记录。
 * 错误标题刻意保持直接，技术详情仍由设置页错误日志承载。
 */
export function companionPresentation(
  detail: WorkbenchStatusDetail,
): CompanionPresentation {
  const task = detail.taskType ?? 'system';
  const status = detail.status;
  const text = detail.detail;

  if (detail.phase === 'error') {
    return { title: '本次处理未完成', motion: 'error', state: 'error' };
  }
  if (detail.phase === 'cancelled') {
    return { title: '本次处理已停止', motion: 'idle', state: 'cancelled' };
  }
  if (detail.phase === 'retrying' || /retry/iu.test(status)) {
    return {
      title: task === 'biography'
        ? '这一页还需要再补几笔……'
        : task === 'ruin'
        ? '这条路刚才塌了一小段……'
        : task === 'genealogy'
        ? '这根亲缘线缠住了……'
        : '我再仔细校订一次……',
      motion: taskMotion(task, status),
      state: 'working',
    };
  }

  if (detail.phase === 'success') {
    const title = task === 'biography'
      ? '成啦，这一卷已经收好了！'
      : task === 'genealogy'
      ? '好啦，一家人都站到该站的位置了！'
      : task === 'ruin' && status === 'ready' && /\u8e0f\u5165|\u5386\u53f2\u7684\u6697\u6d41|\u6240\u9009\u8282\u70b9\u5df2\u8fdb\u5165/u.test(text)
      ? '到了。这里就是那一刻的历史。'
      : task === 'ruin'
      ? '每条路都亮了，主人挑一条吧！'
      : task === 'butterfly'
      ? '听见了吗？很远的年代已经回应了。'
      : '都整理好了，随时可以打开！';
    return { title, motion: 'success', state: 'success' };
  }

  if (task === 'biography') {
    if (status === 'assembling_context') {
      return working('我去书架上找那一卷……', 'biography');
    }
    if (status === 'awaiting_narrative') {
      return working('传记已经整理好了', 'biography');
    }
    if (/\u89c4\u5212|\u6392\u9875/u.test(text)) {
      return working('先把这卷传记排好页……', 'biography');
    }
    if (/\u4ece\u5934\u8bfb|\u8fde\u7eed\u6027\u590d\u6838|\u9010\u9879\u6bd4\u5bf9/u.test(text)) {
      return working('我再从头读一遍……', 'biography');
    }
    if (/\u4e24\u4efd\u8bb0\u8f7d|\u4e8b\u4ef6\u8bb0\u8f7d|\u662f\u5426\u5c5e\u4e8e\u540c\u4e00/u.test(text)) {
      return working('两份记载正在互相争辩……', 'biography');
    }
    return working('伊雍正在整理史料', 'biography');
  }

  if (task === 'genealogy') {
    return working(
      status === 'assembling_context'
        ? '我先把族谱最旧的一页找出来……'
        : '这些亲缘线总算肯排队了……',
      'genealogy',
    );
  }

  if (task === 'ruin') {
    if (status === 'entering_ruin') {
      return working(
        /\u5df2\u7136\u6d1e\u5f00|\u53e6\u4e00\u7aef/u.test(text)
          ? '我在另一端牵着主人呢'
          : '我来替主人叩响这扇门……',
        'ruin-portal',
      );
    }
    if (status === 'assembling_context') {
      return working('我先在地图上找历史的薄处……', 'ruin-map');
    }
    if (status === 'generating_candidates') {
      return working('我在为主人展开几条历史岔路', 'ruin-map');
    }
    return working('岔路正在一条条亮起来……', 'ruin-map');
  }

  if (task === 'butterfly') {
    const title = status === 'freezing_butterfly'
      ? '先把主人留下的痕迹收好……'
      : status === 'committing_butterfly'
      ? '我把变化一条条写回现世'
      : '余波开始改变方向了……';
    return working(title, 'butterfly');
  }

  if (status === 'workbench_open') {
    return working('工作台为主人展开了', 'workbench');
  }
  return working('我在给工作台重新上弦……', 'system');
}

export function clampCompanionPosition(
  left: number,
  top: number,
  viewportWidth: number,
  viewportHeight: number,
  size = 56,
  margin = 8,
): { left: number; top: number } {
  return {
    left: Math.min(Math.max(left, margin), Math.max(margin, viewportWidth - size - margin)),
    top: Math.min(Math.max(top, margin), Math.max(margin, viewportHeight - size - margin)),
  };
}

function working(title: string, motion: CompanionMotion): CompanionPresentation {
  return { title, motion, state: 'working' };
}

function taskMotion(
  task: WorkbenchStatusDetail['taskType'],
  status: string,
): CompanionMotion {
  if (task === 'biography') return 'biography';
  if (task === 'genealogy') return 'genealogy';
  if (task === 'ruin') return status === 'entering_ruin' ? 'ruin-portal' : 'ruin-map';
  if (task === 'butterfly') return 'butterfly';
  return 'system';
}
