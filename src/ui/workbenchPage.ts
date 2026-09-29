import {
  mountWorkbenchShell,
  type WorkbenchShellHandle,
} from './workbenchShell.ts';
import {
  WORKBENCH_STATUS_EVENT,
  type WorkbenchStatusDetail,
} from '../runtime/facade.ts';
import { normalizeWorkbenchView } from './workbenchNavigation.ts';

declare global {
  interface Window {
    EyonHistoryWorkbenchShell?: WorkbenchShellHandle;
  }
}

let stopStatusNavigation: (() => void) | null = null;

function mount(): void {
  const container = document.querySelector<HTMLElement>('[data-eyon-workbench-shell]');
  if (!container) return;
  window.EyonHistoryWorkbenchShell?.dispose();
  stopStatusNavigation?.();
  window.EyonHistoryWorkbenchShell = mountWorkbenchShell(container, undefined, {
    initialView: normalizeWorkbenchView(container.dataset.initialView ?? ''),
  });
  const onStatus = (event: Event): void => {
    const detail = (event as CustomEvent<WorkbenchStatusDetail>).detail;
    if (
      detail?.taskType !== 'biography'
      || detail.status !== 'awaiting_narrative'
    ) return;
    // 只在后台传记已经校验并落入待归档状态时打开一次；检索/扩写期间不抢焦点。
    // 后续正文提交不会再次发出 awaiting_narrative，因此玩家关闭或切页后不会被拉回。
    window.EyonHistoryWorkbenchShell?.open();
    window.EyonHistoryWorkbenchShell?.navigate('biography');
  };
  window.addEventListener(WORKBENCH_STATUS_EVENT, onStatus);
  stopStatusNavigation = () => window.removeEventListener(WORKBENCH_STATUS_EVENT, onStatus);
  document.querySelector<HTMLElement>('[data-eyon-workbench-reopen]')
    ?.addEventListener('click', () => window.EyonHistoryWorkbenchShell?.open());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
