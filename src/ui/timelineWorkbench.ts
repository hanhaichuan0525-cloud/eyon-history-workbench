import type { RuinRuntimeSnapshot } from '../adapters/host.ts';
import type { ButterflyRecord } from '../storage/butterflies.ts';
import { runtimeStateLabel, visibleButterflyArchives, timelineJourney, timelineDisplayTitle, type ButterflyArchiveItem } from './timelineView.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import { preserveDomState, ViewRefreshGuard } from './viewRefresh.ts';
import timelineCss from './timelineWorkbench.css?raw';
import { applyAppearance, courtModuleCss, type WorkbenchAppearance } from './appearance.ts';
import { COURT_FONT_OPTIONS, courtReadingSize } from './courtTypography.ts';

export interface TimelineWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  closeReader(): void;
  dispose(): void;
}
export interface TimelineWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
  onAppearanceChange?: (appearance: WorkbenchAppearance) => void;
}

export function mountTimelineWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: TimelineWorkbenchOptions = {},
): TimelineWorkbenchHandle {
  const host = container.ownerDocument.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);
  let appearance: WorkbenchAppearance = {
    mode: options.theme ?? 'light', accent: 'jade', text: 'neutral', proseFont: 'zhenkai', readingSize: 14, readingSizeVersion: 1,
  };
  const reads = new ViewRefreshGuard(() => client.contextRevision());
  const mutations = new ViewRefreshGuard(() => client.contextRevision());
  const state = {
    runtime: null as RuinRuntimeSnapshot | null,
    butterflies: [] as ButterflyRecord[],
    failedRunReasons: new Map<string, string>(),
    selectedRunId: '', timeView: 'reality' as 'reality' | 'ruin',
    busy: false, status: '', error: '', disposed: false,
  };
  // Keep the top-layer element stable through refreshes; only its trusted template changes.
  root.innerHTML = `<style>${courtModuleCss}\n${timelineCss}</style><section class="workbench" ${options.embedded ? 'data-embedded' : ''}></section>
    <dialog class="archive-reader" aria-labelledby="eyon-dossier-title"></dialog>`;
  const main = root.querySelector<HTMLElement>('.workbench')!;
  const reader = root.querySelector<HTMLDialogElement>('.archive-reader')!;
  let readerMarkup = '';
  let readerShown = false;
  let focusArchiveAfterRender = false;
  reader.addEventListener('cancel', event => { event.preventDefault(); closeReader(); });
  reader.addEventListener('close', () => { if (readerShown && !reader.open) closeReader(); });
  reader.addEventListener('click', event => { if (event.target === reader) {
    const rect = reader.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeReader();
  } });
  reader.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeReader(); }
    if (event.key !== 'Tab') return;
    const controls = Array.from(reader.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), summary'))
      .filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus(); }
  });

  const offStatus = client.onStatus(detail => {
    if (detail.taskType === 'ruin' && (detail.status === 'entering_ruin' || detail.detail.includes('踏入'))) {
      state.status = detail.detail; state.error = ''; render();
      if (detail.phase === 'success') void refresh();
      return;
    }
    if (detail.taskType && detail.taskType !== 'butterfly' && detail.taskType !== 'system') return;
    if (detail.phase === 'cancelled') { mutations.invalidate(); reads.invalidate(); state.busy = false; }
    state.status = detail.detail;
    if (detail.phase === 'error' && detail.taskType === 'butterfly') state.error = detail.detail;
    if (!detail.request) render();
    if (detail.taskType === 'butterfly' && ['generating_butterfly', 'butterfly_ready', 'butterfly_pending'].includes(detail.status ?? '')) void refresh();
  });
  const offReady = client.onReady(() => void refresh());
  const offContext = client.onContextChanged(() => {
    mutations.invalidate(); reads.invalidate(); closeReader(false);
    state.runtime = null; state.butterflies = []; state.failedRunReasons = new Map();
    state.timeView = 'reality'; state.busy = false; state.status = ''; state.error = ''; render();
  });
  const offDataChanged = client.onDataChanged(detail => { if (detail.views.includes('timeline')) void refresh(); });

  async function refresh(): Promise<void> {
    if (state.disposed || !client.isReady()) { render(); return; }
    const current = reads.begin();
    try {
      const [runtime, butterflies, pending] = await Promise.all([
        client.getRuinRuntimeSnapshot(), client.listButterflies(), client.listButterflyPending(),
      ]);
      if (!current()) return;
      const wasActive = !!state.runtime && state.runtime.flowState !== 'idle';
      const active = runtime.flowState !== 'idle';
      if (!active) state.timeView = 'reality';
      else if (!wasActive || runtime.runId !== state.runtime?.runId) state.timeView = 'ruin';
      state.runtime = runtime; state.butterflies = butterflies;
      state.failedRunReasons = new Map(pending.filter(item => item.failure?.message).map(item => [item.runId, item.failure!.message]));
      if (state.selectedRunId && !archives().some(item => item.record.runId === state.selectedRunId)) {
        closeReader(false); focusArchiveAfterRender = true;
      }
      state.error = '';
      setAppearance(client.facade().getSettings().appearance);
    } catch (error) {
      if (!current()) return;
      state.error = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  function archives(): ButterflyArchiveItem[] { return visibleButterflyArchives(state.butterflies, state.failedRunReasons); }
  function operationIsCurrent(): () => boolean {
    const current = mutations.begin();
    return () => !state.disposed && current();
  }
  async function retryButterfly(runId: string): Promise<void> {
    if (!runId || state.busy) return;
    const current = operationIsCurrent(); reads.invalidate(); state.busy = true; state.error = ''; render();
    try {
      await client.retryButterfly(runId);
      if (!current()) return;
      reads.invalidate(); state.status = '伊雍正在重新校核这份历史回响'; await refresh();
    } catch (error) {
      if (!current()) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally { if (current()) { state.busy = false; render(); } }
  }
  async function deleteButterfly(runId: string): Promise<void> {
    if (!runId || state.busy) return;
    const current = operationIsCurrent();
    const confirmed = host.ownerDocument.defaultView?.confirm('删除这份可见蝴蝶效应档案？\n\n已写入正文和正史的内容不会因此回滚。若该干涉仍然有效，系统只保留一份不可浏览的紧凑因果摘要，供正文维持来龙去脉。');
    if (!confirmed || !current()) return;
    reads.invalidate(); state.busy = true; state.error = ''; render();
    try {
      const deleted = await client.deleteButterfly(runId);
      if (!current()) return;
      reads.invalidate();
      state.status = deleted ? '可见档案已删除；已生效的正史没有回滚，活动干涉的紧凑因果摘要仍会保留' : '这份档案已经不存在';
      await refresh();
    } catch (error) {
      if (!current()) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally { if (current()) { state.busy = false; render(); } }
  }

  function resolve(value: string): string {
    return client.isReady() ? client.resolveDisplayText(value.replace(/玩家/gu, '<user>')) : value;
  }
  function text(value: unknown): string { return escapeHtml(resolve(typeof value === 'string' ? value : '')); }
  function render(): void {
    if (state.disposed) return;
    const restore = preserveDomState(root);
    const runtime = state.runtime ?? emptyRuntime(), items = archives(), active = runtime.flowState !== 'idle';
    main.dataset.theme = appearance.mode;
    main.innerHTML = `${options.embedded ? '' : '<header class="page-head"><h1>历史长河</h1></header>'}
      ${state.error ? `<p class="notice error" role="alert">${text(state.error)}</p>` : ''}
      ${state.status ? `<p class="notice" role="status">${text(state.status)}</p>` : ''}
      <section class="time-overview panel">
        <header class="panel-head"><h2>时空阅览牌</h2><div class="plane-actions">
          <button type="button" class="refresh-button" data-refresh aria-label="刷新当前时空与档案" ${state.busy ? 'disabled' : ''}>↻ <span>刷新</span></button>
          <button type="button" data-time-switch aria-controls="eyon-time-planes" ${active ? '' : 'disabled'}>${active ? state.timeView === 'ruin' ? '查看现实锚点' : '查看墟境' : '墟境未进入'}</button>
        </div></header>
        <div class="time-stack" id="eyon-time-planes" data-time-view="${state.timeView}">
          ${renderTimePlane('reality', '现实锚点', runtime.realityTime, runtime.realityLocation, active ? '归返锚点 · 已锁定' : '当前所在')}
          ${renderTimePlane('ruin', '墟境时空', active ? runtime.ruinTime : '', active ? runtime.ruinLocation : '', '当前所在')}
        </div>
        <div class="runtime-summary"><strong>${text(runtimeStateLabel(runtime.flowState))}</strong><span>${active ? '现实锚点已锁定' : '现实锚点随时地更新'}</span>
          ${runtime.runId ? `<details><summary>本轮信息</summary><p>墟境轮次：${text(runtime.runId)}</p></details>` : ''}</div>
        <span class="sr-only" aria-live="polite" data-time-announcement>正在查阅${state.timeView === 'ruin' ? '墟境时空' : '现实锚点'}</span>
      </section>
      <section class="panel archive-panel"><header class="panel-head"><h2 tabindex="-1" data-archive-heading>蝴蝶效应档案</h2><span>${items.length} 份</span></header>
        <div class="archive-list">${items.length ? renderArchiveCollection(items) : '<p class="empty-state">当前聊天尚无蝴蝶效应档案</p>'}</div>
      </section>`;
    updateReader(); restore();
    if (focusArchiveAfterRender) {
      focusArchiveAfterRender = false;
      root.querySelector<HTMLElement>('[data-archive-heading]')?.focus({ preventScroll: true });
    }
  }
  function renderTimePlane(id: 'reality' | 'ruin', title: string, time: string, location: string, note: string): string {
    const front = state.timeView === id;
    return `<article class="time-plane ${id}" data-plane="${id}" aria-hidden="${!front}" ${front ? '' : 'inert'}>
      <header><h3>${title}</h3><span>${note}</span></header>
      <div class="datum"><span>时间</span><strong>${text(time || (id === 'ruin' ? '未进入墟境' : '时刻未记录'))}</strong></div>
      <div class="datum"><span>地点</span><strong>${text(location || (id === 'ruin' ? '进入历史后可查阅' : '地点未记录'))}</strong></div></article>`;
  }
  function renderArchiveCollection(items: ButterflyArchiveItem[]): string {
    return [renderArchiveGroup('当前有效', items.filter(item => !item.retryable)), renderArchiveGroup('待完成归档', items.filter(item => item.retryable))].join('');
  }
  function renderArchiveGroup(label: string, items: ButterflyArchiveItem[]): string {
    if (!items.length) return '';
    return `<section class="archive-group" aria-label="${label}">${items.some(item => item.retryable) ? `<h3>${label}</h3>` : ''}
      ${items.map(item => `<button class="archive-row" type="button" data-run-id="${escapeHtml(item.record.runId)}" aria-haspopup="dialog">
        <span class="archive-mark" aria-hidden="true">${bookIcon}</span><span class="archive-copy"><strong>${text(timelineDisplayTitle(item.title))}</strong>
        <span class="archive-meta"><span>${text(item.record.result.effect.scope)}</span><span class="archive-status">${text(item.statusLabel)}</span>
        <span class="archive-date">${text(item.record.request?.anchors?.ruinEntry?.time || '时刻未记录')}</span></span></span>
        <span class="archive-read">查阅 <span aria-hidden="true">→</span></span></button>`).join('')}</section>`;
  }
  function updateReader(): void {
    const item = archives().find(value => value.record.runId === state.selectedRunId);
    if (!item) { if (readerShown) closeReader(); return; }
    reader.dataset.theme = appearance.mode;
    const markup = renderArchiveDetail(item);
    if (markup !== readerMarkup) {
      const restore = preserveDomState(root), scroll = reader.scrollTop;
      reader.innerHTML = markup; readerMarkup = markup; restore(); reader.scrollTop = scroll;
    }
    if (!readerShown) {
      readerShown = true;
      if (typeof reader.showModal === 'function') reader.showModal();
      else { reader.setAttribute('open', ''); reader.setAttribute('role', 'dialog'); reader.setAttribute('aria-modal', 'true'); }
      reader.scrollTop = 0; reader.querySelector<HTMLButtonElement>('[data-reader-close]')?.focus();
    }
  }
  function renderArchiveDetail(item: ButterflyArchiveItem): string {
    const effect = item.record.result.effect;
    return `<article class="causal-dossier"><header class="dossier-head"><div><span class="reader-kind">蝴蝶效应</span>
      <h2 id="eyon-dossier-title">${text(timelineDisplayTitle(item.title))}</h2><p class="dossier-badges">${text(effect.scope)} <span aria-hidden="true">·</span> ${text(item.statusLabel)}</p></div>
      <button type="button" class="reader-close" data-reader-close aria-label="关闭档案">×</button></header>
      <details class="reading-settings" data-reading-settings><summary>阅读设置</summary><div class="court-font-controls">
        <label>正文字体<select data-reading-font>${COURT_FONT_OPTIONS.map(([id, label]) => `<option value="${id}" ${id === (appearance.proseFont ?? 'zhenkai') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>正文字号<select data-reading-size>${[14, 16, 18, 20].map(size => `<option value="${size}" ${size === courtReadingSize(appearance) ? 'selected' : ''}>${size} px</option>`).join('')}</select></label></div></details>
      ${state.error ? `<p class="notice error" role="alert">${text(state.error)}</p>` : ''}
      ${item.failureReason ? `<p class="notice" role="note">归档尚未完成，可点「重新归档」重试<br>原因：${text(item.failureReason)}</p>` : ''}
      <section class="journey"><h3>本次穿越</h3><ol class="causal-route">${timelineJourney(item.record).map((node, index) => `<li class="causal-node">
        <div class="node-head"><span class="node-num" aria-hidden="true">0${index + 1}</span><strong>${node.label}</strong></div>
        <p class="stage-time">${text(node.time)}</p><p class="stage-location">${text(node.location)}</p>
        ${index < 2 ? `<span class="route-connector" aria-hidden="true"><span>${index ? '探索' : '穿越'}</span><span class="route-arrow">→</span></span>` : ''}</li>`).join('')}</ol></section>
      <section class="dossier-evidence-grid"><article><h3>墟境行动记录</h3><p>${text(effect.ruinActionRecord)}</p></article>
        <article><h3>可感知证据</h3>${item.retryable ? '<p>等待重新归档后核定</p>' : `<ul>${effect.perceptibleEvidence.map(value => `<li>${text(value)}</li>`).join('')}</ul>`}</article></section>
      <section class="dossier-conclusion"><h3>历史演变</h3><p>${item.retryable ? '因果链已经冻结，结论将在重新归档成功后落定。' : text(effect.historicalEvolution)}</p></section>
      <div class="archive-actions">${item.retryable ? `<button type="button" class="retry-button" data-retry-run="${escapeHtml(item.record.runId)}" ${state.busy ? 'disabled' : ''}>重新归档</button>` : ''}
        <button type="button" class="delete-button" data-delete-run="${escapeHtml(item.record.runId)}" ${state.busy ? 'disabled' : ''}>删除档案</button></div></article>`;
  }
  function closeReader(restoreFocus = true): void {
    const previous = state.selectedRunId; state.selectedRunId = ''; readerShown = false;
    if (reader.open) { if (typeof reader.close === 'function') reader.close(); else reader.removeAttribute('open'); }
    if (restoreFocus) (Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]')).find(element => element.dataset.runId === previous)
      ?? root.querySelector<HTMLElement>('[data-archive-heading]'))?.focus({ preventScroll: true });
  }
  function setAppearance(next: WorkbenchAppearance): void {
    appearance = next; applyAppearance(host, next); main.dataset.theme = next.mode; reader.dataset.theme = next.mode;
  }
  root.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-refresh')) void refresh();
    else if (button.hasAttribute('data-time-switch')) {
      state.timeView = state.timeView === 'reality' ? 'ruin' : 'reality';
      // Keep both prepared cards and their dimensions; no data write and no rerender.
      root.querySelector('.time-stack')?.setAttribute('data-time-view', state.timeView);
      root.querySelectorAll<HTMLElement>('[data-plane]').forEach(plane => { const hidden = plane.dataset.plane !== state.timeView; plane.inert = hidden; plane.setAttribute('aria-hidden', String(hidden)); });
      button.textContent = state.timeView === 'ruin' ? '查看现实锚点' : '查看墟境';
      root.querySelector('[data-time-announcement]')!.textContent = `正在查阅${state.timeView === 'ruin' ? '墟境时空' : '现实锚点'}`;
    } else if (button.hasAttribute('data-run-id')) { state.selectedRunId = button.dataset.runId ?? ''; updateReader(); }
    else if (button.hasAttribute('data-reader-close')) closeReader();
    else if (button.hasAttribute('data-delete-run')) void deleteButterfly(button.dataset.deleteRun ?? '');
    else if (button.hasAttribute('data-retry-run')) void retryButterfly(button.dataset.retryRun ?? '');
  });
  root.addEventListener('change', event => {
    const select = event.target as HTMLSelectElement;
    if (!select.matches('[data-reading-font], [data-reading-size]')) return;
    try {
      const current = client.facade().getSettings().appearance;
      const next: WorkbenchAppearance = select.hasAttribute('data-reading-font')
        ? { ...current, proseFont: select.value as WorkbenchAppearance['proseFont'] }
        : { ...current, readingSize: Number(select.value) as WorkbenchAppearance['readingSize'], readingSizeVersion: 1 };
      client.updateSettings({ appearance: next });
      const saved = client.facade().getSettings().appearance;
      setAppearance(saved); options.onAppearanceChange?.(saved); state.error = ''; render();
    } catch (error) { state.error = error instanceof Error ? error.message : String(error); render(); }
  });
  setAppearance(appearance); render(); void refresh();
  return {
    refresh, closeReader,
    setTheme(mode) { setAppearance({ ...appearance, mode }); },
    setAppearance,
    dispose() {
      closeReader(false); state.disposed = true; mutations.dispose(); reads.dispose();
      offContext(); offStatus(); offReady(); offDataChanged(); host.remove();
    },
  };
}

const bookIcon = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5c-3-2-6-2-10-1v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Zm0 0v16"/></svg>';
function emptyRuntime(): RuinRuntimeSnapshot {
  return { flowState: 'idle', runId: '', realityTime: '', realityLocation: '', ruinTime: '', ruinLocation: '' };
}
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
