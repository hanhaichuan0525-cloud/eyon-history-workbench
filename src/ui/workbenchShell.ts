import { mountBiographyWorkbench, type BiographyWorkbenchHandle } from './biographyWorkbench.ts';
import { mountGenealogyWorkbench, type GenealogyWorkbenchHandle } from './genealogyWorkbench.ts';
import { mountRuinWorkbench, RUIN_PANELS, type RuinPanelId, type RuinWorkbenchHandle } from './ruinWorkbench.ts';
import { canOpenRuinPanel } from '../core/ruinPanelAccess.ts';
import { mountSettingsWorkbench, type SettingsWorkbenchHandle } from './settingsWorkbench.ts';
import { mountTimelineWorkbench, type TimelineWorkbenchHandle } from './timelineWorkbench.ts';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import { WORKBENCH_APPEARANCE_EVENT } from '../runtime/facade.ts';
import { WORKBENCH_VERSION, WORKBENCH_VERSION_LABEL } from '../core/version.ts';
import { companionPresentation } from './companionPresentation.ts';
import { WorkbenchUiClient, type WorkbenchUiSnapshot } from './workbenchClient.ts';
import { ViewRefreshGuard } from './viewRefresh.ts';
import {
  normalizeWorkbenchView,
  WORKBENCH_VIEWS,
  type WorkbenchViewId,
} from './workbenchNavigation.ts';
import shellCss from './workbenchShell.css?raw';

type ModuleHandle =
  TimelineWorkbenchHandle
  | GenealogyWorkbenchHandle
  | RuinWorkbenchHandle
  | BiographyWorkbenchHandle
  | SettingsWorkbenchHandle;

export interface WorkbenchShellHandle {
  open(): void;
  close(): void;
  navigate(view: WorkbenchViewId): void;
  refresh(): Promise<void>;
  dispose(): void;
}

export interface WorkbenchShellOptions {
  initialView?: WorkbenchViewId;
}

export function mountWorkbenchShell(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: WorkbenchShellOptions = {},
): WorkbenchShellHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);
  let active = normalizeWorkbenchView(options.initialView ?? 'timeline');
  let appearance: WorkbenchAppearance = {
    mode: 'light',
    accent: 'jade',
    text: 'neutral',
  };
  let snapshot: WorkbenchUiSnapshot | null = null;
  let ruinPanel: RuinPanelId = 'generation';
  let ruinMenuExpanded = false;
  let disposed = false;
  const reads = new ViewRefreshGuard(() => client.contextRevision());
  let statusText = '等待工作台脚本';
  let toastTimer: ReturnType<typeof setInterval> | null = null;
  let toastRemaining = 0;
  const handles = new Map<WorkbenchViewId, ModuleHandle>();
  const moduleRoots = new Map<WorkbenchViewId, HTMLElement>();

  renderShell();
  registerModuleRoots();
  ensureMounted(active);
  // Keep the shell and every nested module on one palette even before the
  // Tavern facade becomes ready; the persisted appearance replaces this
  // fallback as soon as refreshAll receives the first snapshot.
  applyWorkbenchAppearance(appearance);
  const offStatus = client.onStatus(detail => {
    if (detail.phase !== 'error') statusText = detail.detail;
    updateChrome();
    if (detail.taskType && detail.taskType !== 'system' && (detail.phase === 'success' || detail.status === 'awaiting_narrative')) {
      void refreshChangedViews(detail.taskType === 'butterfly' ? ['timeline', 'ruin', 'genealogy', 'biography'] : [detail.taskType]);
    }
    // Task notifications live in the Tavern host document so closing the orb
    // never hides an in-flight operation.
  });
  const offReady = client.onReady(() => void refreshAll());
  const offContext = client.onContextChanged(() => {
    reads.invalidate(); snapshot = null; ruinMenuExpanded = false; statusText = '正在切换聊天资料'; updateChrome();
  });
  const offDataChanged = client.onDataChanged(detail => {
    // 偏好更新不改变候选/归档计数；控制台自行读取，勿重挂整个子页。
    if (detail.reason === 'butterfly-references') return;
    void refreshChangedViews(detail.views);
  });
  void refreshAll();

  function renderShell(): void {
    root.innerHTML = `
      <style>${shellCss}</style>
      <div class="app">
        <aside class="rail">
          <div class="brand">
            <div class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 48 56" role="img">
                <path d="M11 47V21C11 11 16 5 24 5s13 6 13 16v26" />
                <path d="M16 47V22c0-6 3-10 8-10s8 4 8 10v25" />
                <path d="M8 47h32M19 47V27h10v20M22 31h4" />
                <circle cx="24" cy="20" r="2.4" />
              </svg>
            </div>
            <div>
              <strong>虚嗣王庭</strong>
              <small>ROYAL SCRIPTORIUM</small>
              <span class="brand-version" title="伊雍历史工作台 ${WORKBENCH_VERSION}">${WORKBENCH_VERSION_LABEL}</span>
            </div>
          </div>
          <span class="rail-label">见证档案院</span>
          <nav class="nav" aria-label="工作台模块">
            ${WORKBENCH_VIEWS.map(view => `
              <button class="nav-button" type="button" data-view="${view.id}" aria-current="${view.id === active ? 'page' : 'false'}" ${view.id === 'ruin' ? 'aria-expanded="false" aria-controls="ruin-nav-children"' : ''} title="${view.label}">
                <span class="nav-icon" aria-hidden="true">${view.icon}</span>
                <span class="nav-label">${view.label}${view.id === 'ruin' ? '<span class="nav-disclosure" aria-hidden="true">⌄</span>' : ''}</span>
                <span class="nav-count" data-count="${view.id}"></span>
              </button>${view.id === 'ruin' ? `<div class="ruin-nav-children" id="ruin-nav-children" data-ruin-children hidden>${RUIN_PANELS.map(panel => `<button type="button" data-ruin-child="${panel}" aria-current="${ruinPanel === panel ? 'page' : 'false'}" disabled>${{ generation: '墟境生成', tasks: '墟境任务', butterfly: '蝴蝶效应' }[panel]}</button>`).join('')}</div>` : ''}`).join('')}
          </nav>
          <div class="rail-ornament" aria-hidden="true">
            <svg viewBox="0 0 72 122" fill="none">
              <path d="M36 2v18M36 102v18M12 61h14M46 61h14" />
              <path d="M36 18c18 13 24 28 24 43S54 91 36 104C18 91 12 76 12 61s6-30 24-43Z" />
              <path d="M22 61c7-11 21-11 28 0-7 11-21 11-28 0Z" />
              <circle cx="36" cy="61" r="4" />
              <path d="M31 30c-5 5-7 11-7 18M41 92c5-5 7-11 7-18" opacity=".7" />
            </svg>
          </div>
          <div class="rail-status">
            <strong><i aria-hidden="true"></i>档案连接稳定</strong>
            <span data-status>${statusText}</span>
          </div>
        </aside>
        <main class="workspace">
          <header class="topbar">
            <div class="top-copy">
              <p>伊雍历史工作台 <span class="top-version" title="内部版本 ${WORKBENCH_VERSION}">${WORKBENCH_VERSION_LABEL}</span> <span aria-hidden="true">/</span> <b data-route></b></p>
              <h2 data-context></h2>
            </div>
            <div class="top-actions">
              <button class="icon-button" type="button" data-action="refresh" title="刷新当前模块" aria-label="刷新当前模块">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 6v5h-5"/><path d="M18.5 15.5A7 7 0 1 1 19 8l1 3"/></svg>
              </button>
              <button class="icon-button" type="button" data-action="close" title="关闭工作台" aria-label="关闭工作台">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>
              </button>
            </div>
          </header>
          <div class="content">
            <header class="module-intro">
              <div class="module-copy">
                <span data-kicker></span>
                <h1 data-title></h1>
                <p data-subtitle></p>
                <dl class="module-ledger" data-ledger aria-label="当前模块摘要">
                  <div class="ledger-cell"><dt data-ledger-label="0"></dt><dd data-ledger-value="0">—</dd></div>
                  <div class="ledger-cell"><dt data-ledger-label="1"></dt><dd data-ledger-value="1">—</dd></div>
                  <div class="ledger-cell"><dt data-ledger-label="2"></dt><dd data-ledger-value="2">—</dd></div>
                </dl>
              </div>
            </header>
            ${WORKBENCH_VIEWS.map(view => `<section class="view ${view.id === active ? 'active' : ''}" data-module="${view.id}" aria-hidden="${view.id !== active}"></section>`).join('')}
          </div>
        </main>
        <aside class="status-toast" data-status-toast hidden role="status" aria-live="polite">
          <span class="status-toast-mark" aria-hidden="true">伊</span>
          <div class="status-toast-copy">
            <strong data-toast-title></strong>
            <small data-toast-detail></small>
            <small class="status-toast-retry" data-toast-retry hidden></small>
          </div>
          <span class="status-toast-countdown" data-toast-countdown aria-label="通知剩余时间"></span>
        </aside>
      </div>`;
    root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(button => {
      button.addEventListener('click', () => {
        const view = normalizeWorkbenchView(button.dataset.view ?? '');
        if (view === 'ruin') ruinMenuExpanded = active !== 'ruin' || !ruinMenuExpanded;
        navigate(view);
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-ruin-child]').forEach(button => button.addEventListener('click', () => {
      navigate('ruin');
      (handles.get('ruin') as RuinWorkbenchHandle | undefined)?.selectPanel(button.dataset.ruinChild as RuinPanelId);
    }));
    root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.addEventListener('click', () => void refresh());
    root.querySelector<HTMLButtonElement>('[data-action="close"]')?.addEventListener('click', close);
    updateChrome();
  }

  function registerModuleRoots(): void {
    for (const view of WORKBENCH_VIEWS) {
      const target = root.querySelector<HTMLElement>(`[data-module="${view.id}"]`);
      if (!target) continue;
      moduleRoots.set(view.id, target);
    }
  }

  // 首次只挂当前页；已访问页面保留实例、草稿与逐篇进度订阅。
  function ensureMounted(viewId: WorkbenchViewId): boolean {
      if (disposed || handles.has(viewId)) return false;
      const target = moduleRoots.get(viewId);
      if (!target) return false;
      const view = { id: viewId };
      let handle: ModuleHandle;
      if (view.id === 'timeline') {
        handle = mountTimelineWorkbench(target, client, { theme: appearance.mode, embedded: true });
      } else if (view.id === 'genealogy') {
        handle = mountGenealogyWorkbench(target, client, {
          theme: appearance.mode,
          embedded: true,
        });
      } else if (view.id === 'ruin') {
        handle = mountRuinWorkbench(target, client, {
          theme: appearance.mode,
          embedded: true,
          onPanelChange: panel => { ruinPanel = panel; updateChrome(); resetWorkspaceScroll(); },
        });
      } else if (view.id === 'biography') {
        handle = mountBiographyWorkbench(target, client, { theme: appearance.mode, embedded: true });
      } else {
        handle = mountSettingsWorkbench(target, client, {
          theme: appearance.mode,
          onAppearanceChange: applyWorkbenchAppearance,
        });
      }
      handles.set(view.id, handle);
      handle.setAppearance(appearance);
      return true;
  }

  function navigate(view: WorkbenchViewId): void {
    active = normalizeWorkbenchView(view);
    const firstVisit = ensureMounted(active);
    if (active !== 'ruin') ruinMenuExpanded = false;
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('[data-view]'))) {
      button.setAttribute('aria-current', button.dataset.view === active ? 'page' : 'false');
    }
    for (const [id, target] of moduleRoots) {
      const visible = id === active;
      target.classList.toggle('active', visible);
      target.setAttribute('aria-hidden', String(!visible));
    }
    resetWorkspaceScroll();
    updateChrome();
    // 各页面首次挂载自带刷新，不重复发起同一批读取。
    if (!firstVisit) void refreshView(active);
  }

  function resetWorkspaceScroll(): void {
    const content = root.querySelector<HTMLElement>('.content');
    if (content) {
      content.scrollTop = 0;
      content.scrollLeft = 0;
    }
  }

  async function refreshView(view: WorkbenchViewId): Promise<void> {
    await refreshChangedViews([view]);
  }

  async function refreshChangedViews(views: WorkbenchViewId[]): Promise<void> {
    if (disposed || !client.isReady()) return;
    const current = reads.begin();
    try {
      // 后台页自己的进度订阅仍在；外壳不额外重读未显示的整页资料。
      if (views.includes(active)) await handles.get(active)?.refresh();
      if (!current()) return;
      const next = await client.readSnapshot();
      if (!current()) return;
      snapshot = next; updateChrome();
    } catch (cause) {
      if (current()) { statusText = cause instanceof Error ? cause.message : String(cause); updateChrome(); }
    }
  }

  function updateChrome(): void {
    const ruinChildren = root.querySelector<HTMLElement>('[data-ruin-children]');
    if (ruinChildren) ruinChildren.hidden = active !== 'ruin' || !ruinMenuExpanded;
    root.querySelector('[data-view="ruin"]')?.setAttribute('aria-expanded', String(active === 'ruin' && ruinMenuExpanded));
    root.querySelectorAll<HTMLButtonElement>('[data-ruin-child]').forEach(button => {
      button.setAttribute('aria-current', button.dataset.ruinChild === ruinPanel ? 'page' : 'false');
      button.disabled = !snapshot || !canOpenRuinPanel(snapshot.runtime, button.dataset.ruinChild as RuinPanelId);
      button.title = button.disabled ? button.dataset.ruinChild === 'generation' ? '遣返现世后解锁' : '进入墟境后解锁' : '';
    });
    const definition = WORKBENCH_VIEWS.find(view => view.id === active) ?? WORKBENCH_VIEWS[0];
    root.querySelector<HTMLElement>('.module-intro')?.setAttribute('data-intro-view', active);
    const title = root.querySelector<HTMLElement>('[data-title]');
    const subtitle = root.querySelector<HTMLElement>('[data-subtitle]');
    const route = root.querySelector<HTMLElement>('[data-route]');
    const context = root.querySelector<HTMLElement>('[data-context]');
    const kicker = root.querySelector<HTMLElement>('[data-kicker]');
    const status = root.querySelector<HTMLElement>('[data-status]');
    if (title) title.textContent = definition.title;
    if (subtitle) subtitle.textContent = definition.subtitle;
    if (route) route.textContent = definition.label;
    if (context) context.textContent = definition.context;
    if (kicker) kicker.textContent = definition.kicker;
    if (status) status.textContent = statusText;
    const counts: Record<WorkbenchViewId, string> = {
      timeline: snapshot ? String(snapshot.butterflies.length).padStart(2, '0') : '--',
      genealogy: snapshot ? String(snapshot.genealogies.length).padStart(2, '0') : '--',
      ruin: snapshot ? String(snapshot.ruins.length).padStart(2, '0') : '--',
      biography: snapshot ? String(snapshot.biographies.length).padStart(2, '0') : '--',
      settings: '',
    };
    for (const id of Object.keys(counts) as WorkbenchViewId[]) {
      const element = root.querySelector<HTMLElement>(`[data-count="${id}"]`);
      if (element) element.textContent = counts[id];
    }
    const ledger = ledgerFor(active, snapshot);
    ledger.forEach((item, index) => {
      const label = root.querySelector<HTMLElement>(`[data-ledger-label="${index}"]`);
      const value = root.querySelector<HTMLElement>(`[data-ledger-value="${index}"]`);
      if (label) label.textContent = item[0];
      if (value) value.textContent = item[1];
    });
  }

  function showStatusToast(detail: Parameters<Parameters<typeof client.onStatus>[0]>[0]): void {
    if (toastTimer) clearInterval(toastTimer);
    toastTimer = null;
    const toast = root.querySelector<HTMLElement>('[data-status-toast]');
    const title = root.querySelector<HTMLElement>('[data-toast-title]');
    const description = root.querySelector<HTMLElement>('[data-toast-detail]');
    const retry = root.querySelector<HTMLElement>('[data-toast-retry]');
    const countdown = root.querySelector<HTMLElement>('[data-toast-countdown]');
    if (!toast || !title || !description || !retry || !countdown) return;
    title.textContent = statusTitle(detail);
    description.textContent = detail.detail;
    retry.hidden = detail.phase !== 'retrying';
    retry.textContent = detail.retry
      ? `重新生成 ${detail.retry.attempt}/${detail.retry.max}`
      : '';
    toast.hidden = false;
    toast.classList.toggle('failed', detail.phase === 'error');
    countdown.hidden = detail.phase !== 'error';
    if (detail.phase === 'error') {
      toastRemaining = 5;
      updateToastCountdown();
      toastTimer = setInterval(() => {
        toastRemaining -= 1;
        updateToastCountdown();
        if (toastRemaining <= 0) hideStatusToast();
      }, 1000);
      return;
    }
    if (detail.phase === 'success' && !detail.progress) {
      globalThis.setTimeout(hideStatusToast, 1600);
    }
  }

  function updateToastCountdown(): void {
    const countdown = root.querySelector<HTMLElement>('[data-toast-countdown]');
    if (countdown) countdown.textContent = `${Math.max(0, toastRemaining)}s`;
  }

  function hideStatusToast(): void {
    if (toastTimer) clearInterval(toastTimer);
    toastTimer = null;
    root.querySelector<HTMLElement>('[data-status-toast]')?.setAttribute('hidden', '');
  }

  async function refreshAll(): Promise<void> {
    if (disposed || !client.isReady()) return;
    const current = reads.begin();
    try {
      const next = await client.readSnapshot();
      if (!current()) return;
      snapshot = next;
      appearance = snapshot.settings.appearance;
      applyWorkbenchAppearance(appearance);
      statusText = snapshot.runtime.flowState === 'exploring'
        ? `墟境探索中 · ${snapshot.runtime.runId || '当前轮次'}`
        : '现实待机 · 当前聊天资料已同步';
      await handles.get(active)?.refresh();
    } catch (cause) {
      if (!current()) return;
      statusText = cause instanceof Error ? cause.message : String(cause);
    }
    if (current()) updateChrome();
  }

  async function refresh(): Promise<void> {
    await refreshView(active);
  }

  function applyWorkbenchAppearance(next: WorkbenchAppearance): void {
    appearance = next;
    if (snapshot) snapshot = { ...snapshot, settings: { ...snapshot.settings, appearance: next } };
    updateChrome();
    host.dataset.theme = next.mode;
    applyAppearance(host, next);
    const ownerDocument = host.ownerDocument;
    const overlay = host.closest<HTMLElement>('[data-eyon-history-overlay]')
      ?? ownerDocument.querySelector<HTMLElement>('[data-eyon-history-overlay]');
    const launcher = ownerDocument.querySelector<HTMLElement>('[data-eyon-history-launcher]');
    for (const target of [overlay, launcher]) {
      if (!target) continue;
      target.dataset.theme = next.mode;
      target.dataset.accent = next.accent;
      target.dataset.text = next.text;
      applyAppearance(target, next);
    }
    ownerDocument.defaultView?.dispatchEvent(new CustomEvent(
      WORKBENCH_APPEARANCE_EVENT,
      { detail: next },
    ));
    for (const handle of handles.values()) {
      handle.setTheme(next.mode);
      handle.setAppearance(next);
    }
  }

  function open(): void {
    host.hidden = false;
    const overlay = host.closest<HTMLElement>('[data-eyon-history-overlay]')
      ?? host.ownerDocument.querySelector<HTMLElement>('[data-eyon-history-overlay]');
    if (overlay) {
      overlay.hidden = false;
      overlay.scrollTop = 0;
      overlay.scrollLeft = 0;
    }
    resetWorkspaceScroll();
    void refresh();
  }

  function close(): void {
    host.hidden = true;
    const overlay = host.closest<HTMLElement>('[data-eyon-history-overlay]')
      ?? host.ownerDocument.querySelector<HTMLElement>('[data-eyon-history-overlay]');
    if (overlay) overlay.hidden = true;
    container.dispatchEvent(new CustomEvent('eyon-history-workbench:close', {
      bubbles: true,
      detail: { view: active },
    }));
  }

  return {
    open,
    close,
    navigate,
    refresh,
    dispose() {
      disposed = true;
      reads.dispose(); offContext();
      if (toastTimer) clearInterval(toastTimer);
      offStatus();
      offReady();
      offDataChanged();
      for (const handle of handles.values()) handle.dispose();
      handles.clear();
      moduleRoots.clear();
      container.replaceChildren();
    },
  };
}

type LedgerItem = readonly [label: string, value: string];

function ledgerFor(
  view: WorkbenchViewId,
  snapshot: WorkbenchUiSnapshot | null,
): readonly [LedgerItem, LedgerItem, LedgerItem] {
  if (!snapshot) {
    return [
      ['档案状态', '等待同步'],
      ['保存边界', '当前聊天'],
      ['界面来源', '生产组件'],
    ];
  }
  if (view === 'timeline') {
    return [
      ['流程状态', snapshot.runtime.flowState === 'exploring' ? '探索中' : '现实待机'],
      ['墟境档案', `${snapshot.ruins.length} 份`],
      ['蝴蝶档案', `${snapshot.butterflies.length} 份`],
    ];
  }
  if (view === 'genealogy') {
    const latest = snapshot.genealogies.at(0);
    return [
      ['谱系档案', `${snapshot.genealogies.length} 份`],
      ['当前人物', latest ? `${latest.result.nodes.length} 人` : '尚未生成'],
      ['展开代数', `祖辈 ${snapshot.settings.genealogyDepth.ancestors} · 后代 ${snapshot.settings.genealogyDepth.descendants}`],
    ];
  }
  if (view === 'ruin') {
    const latest = snapshot.ruins.at(0);
    return [
      ['候选史稿', latest ? `${latest.result.candidates.length} 份` : '尚未生成'],
      ['探查档案', `${snapshot.ruins.length} 组`],
      ['进入阶段', snapshot.runtime.flowState === 'exploring' ? '已选定' : '尚未进入'],
    ];
  }
  if (view === 'biography') {
    const committed = snapshot.biographies.filter(record => record.status === 'committed').length;
    return [
      ['收录典籍', `${String(snapshot.biographies.length).padStart(2, '0')} 册`],
      ['保存位置', '当前聊天'],
      ['已归档', `${String(committed).padStart(2, '0')} 册`],
    ];
  }
  return [
    ['生成模块', '04 项'],
    ['外观模式', snapshot.settings.appearance.mode === 'dark' ? '王庭夜色' : '雾紫纸页'],
    ['工作台版本', snapshot.version],
  ];
}

function statusTitle(detail: Parameters<Parameters<WorkbenchUiClient['onStatus']>[0]>[0]): string {
  return companionPresentation(detail).title;
}
