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

  if (status === 'workbench_opening') {
    return working('正在为主人展开工作台……', 'workbench');
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

export interface CompanionViewportRect {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface HostFrameLike {
  parent?: HostFrameLike | null;
  frames?: ArrayLike<HostFrameLike>;
}

/**
 * 收集「自己 + 祖先窗口 + 后代 frame」（去重、防环、跨域安全）。
 *
 * β1.3 真机病历：手机上工作台打不开。悬浮球挂在**最顶层窗口**（`resolveHostDocument`
 * 一路上溯），而脚本加载器只上溯**一层**（`window.parent`）——桌面这两者是同一个窗口，
 * 手机上酒馆助手脚本 iframe 嵌得更深时就分家：球把 `:open` 事件派发在顶层，
 * 加载器的监听器在中间层，谁也收不到。这里让球能沿着 frame 树找到真正的宿主层。
 *
 * 访问跨域 frame 的任何属性都会抛错，因此逐项 try/catch：拿不到就跳过。
 */
export function collectHostFrames(root: HostFrameLike | null | undefined): HostFrameLike[] {
  const seen = new Set<HostFrameLike>();
  const out: HostFrameLike[] = [];
  const push = (frame: HostFrameLike | null | undefined): void => {
    if (!frame || seen.has(frame)) return;
    seen.add(frame);
    out.push(frame);
  };

  push(root);
  // ① 祖先链（自己 → parent → … → top），最多 8 层防病态嵌套。
  let current: HostFrameLike | null | undefined = root;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    let parent: HostFrameLike | null | undefined;
    try {
      parent = current.parent;
    } catch {
      parent = null;
    }
    if (!parent || parent === current) break;
    push(parent);
    current = parent;
  }
  // ② 后代 frame（BFS；数组长度在循环中增长，因此祖先的 frame 也会被展开）。
  for (let index = 0; index < out.length; index += 1) {
    let frames: ArrayLike<HostFrameLike> | undefined;
    try {
      frames = out[index].frames ?? undefined;
    } catch {
      frames = undefined;
    }
    if (!frames) continue;
    for (let i = 0; i < frames.length; i += 1) {
      try {
        push(frames[i]);
      } catch {
        // 跨域 frame：跳过。
      }
    }
  }
  return out;
}

/** 只有正有限数才算可用视口尺寸。 */
function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 悬浮球必须按**可视视口**定位（β1.2 真机病历）。
 *
 * 手机的可视视口比布局视口小（地址栏 / 动态工具栏 / 双指缩放），
 * 用 `innerWidth/innerHeight` 夹取的坐标会把球钉到看不见的地方；而
 * `position: fixed` 的坐标一旦被 JS 写成像素，就再也不会跟随视口。
 * 参考真王核心的 `paperWindowRect`：优先 `visualViewport`，含 `offsetLeft/offsetTop`；
 * 数值非法时返回 null，调用方**保持原位不动**，绝不写入坏坐标。
 */
export function companionViewportRect(hostWindow: {
  visualViewport?: {
    width?: number;
    height?: number;
    offsetLeft?: number;
    offsetTop?: number;
  } | null;
  innerWidth?: number;
  innerHeight?: number;
} | null | undefined): CompanionViewportRect | null {
  if (!hostWindow) return null;
  const visual = hostWindow.visualViewport ?? null;
  const width = positiveNumber(visual?.width) ? visual.width : hostWindow.innerWidth;
  const height = positiveNumber(visual?.height) ? visual.height : hostWindow.innerHeight;
  if (!positiveNumber(width) || !positiveNumber(height)) return null;
  return {
    width,
    height,
    left: finiteNumber(visual?.offsetLeft) ? visual.offsetLeft : 0,
    top: finiteNumber(visual?.offsetTop) ? visual.offsetTop : 0,
  };
}

/** 只把实际挂载、未隐藏且与可视视口相交的工作台算作打开成功。 */
export function isWorkbenchVisible(hostWindow: Window | null): boolean {
  try {
    if (!hostWindow) return false;
    const shell = hostWindow.document.querySelector('[data-eyon-workbench-shell]');
    const host = shell?.firstElementChild;
    const app = host?.shadowRoot?.querySelector('.app');
    const viewport = companionViewportRect(hostWindow);
    if (!shell || !host || !app || !viewport) return false;
    const overlay = shell.closest('[data-eyon-history-overlay]');
    for (const element of [overlay, shell, host, app]) {
      if (!element) continue;
      if (!element.isConnected || element.hasAttribute('hidden')) return false;
      const style = hostWindow.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden'
        || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      if (!(rect.width > 0 && rect.height > 0)
        || rect.right <= viewport.left || rect.bottom <= viewport.top
        || rect.left >= viewport.left + viewport.width
        || rect.top >= viewport.top + viewport.height) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 在可视视口内夹取坐标：margin 随视口自适应（视口比球还小时按 space/2 收缩，
 * 而不是把球推出边界），并计入 `visualViewport` 的偏移（缩放/平移时）。
 */
export function clampCompanionInViewport(
  left: number,
  top: number,
  viewport: CompanionViewportRect,
  size = 56,
  margin = 8,
): { left: number; top: number } {
  const spaceX = Math.max(0, viewport.width - size);
  const spaceY = Math.max(0, viewport.height - size);
  const marginX = Math.min(margin, spaceX / 2);
  const marginY = Math.min(margin, spaceY / 2);
  return {
    left: Math.min(viewport.left + spaceX - marginX, Math.max(viewport.left + marginX, left)),
    top: Math.min(viewport.top + spaceY - marginY, Math.max(viewport.top + marginY, top)),
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
