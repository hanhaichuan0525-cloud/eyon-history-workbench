import type { RuinRuntimeSnapshot } from '../adapters/host.ts';
import type { ButterflyRecord } from '../storage/butterflies.ts';
import {
  runtimeStateLabel,
  visibleButterflyArchives,
  type ButterflyArchiveItem,
} from './timelineView.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import timelineCss from './timelineWorkbench.css?raw';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';

export interface TimelineWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface TimelineWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
}

interface TimelineState {
  runtime: RuinRuntimeSnapshot | null;
  butterflies: ButterflyRecord[];
  /** runId → 提交失败原因（internal.81 v17：来自待结算快照 failure）。 */
  failedRunReasons: ReadonlyMap<string, string>;
  selectedRunId: string;
  busy: boolean;
  status: string;
  error: string;
  disposed: boolean;
}

export function mountTimelineWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: TimelineWorkbenchOptions = {},
): TimelineWorkbenchHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);
  let theme = options.theme ?? 'light';
  const state: TimelineState = {
    runtime: null,
    butterflies: [],
    failedRunReasons: new Map(),
    selectedRunId: '',
    busy: false,
    status: '',
    error: '',
    disposed: false,
  };

  const offStatus = client.onStatus(detail => {
    // 进入新的墟境时，清掉上一轮遣返遗留的提示；否则上一轮
    // 「遣返完成/待重试」会继续显示在本轮探索页面里。
    if (
      detail.taskType === 'ruin'
      && (detail.status === 'entering_ruin' || detail.detail.includes('踏入'))
    ) {
      state.status = detail.detail;
      state.error = '';
      render();
      return;
    }
    if (
      detail.taskType
      && detail.taskType !== 'butterfly'
      && detail.taskType !== 'system'
    ) return;
    state.status = detail.detail;
    if (detail.phase === 'error' && detail.taskType === 'butterfly') {
      state.error = detail.detail;
    }
    render();
    if (
      detail.taskType === 'butterfly'
      && (
        detail.status === 'generating_butterfly'
        || detail.status === 'butterfly_ready'
        || detail.status === 'butterfly_pending'
      )
    ) void refresh();
  });
  const offReady = client.onReady(() => void refresh());
  const offDataChanged = client.onDataChanged(detail => {
    if (detail.views.includes('timeline')) void refresh();
  });

  async function refresh(): Promise<void> {
    if (state.disposed || !client.isReady()) {
      render();
      return;
    }
    try {
      const [runtime, butterflies, pending] = await Promise.all([
        client.getRuinRuntimeSnapshot(),
        client.listButterflies(),
        client.listButterflyPending(),
      ]);
      state.runtime = runtime;
      state.butterflies = butterflies;
      state.failedRunReasons = new Map(
        pending
          .filter(item => item.failure?.message)
          .map(item => [item.runId, item.failure!.message] as const),
      );
      const archives = visibleButterflyArchives(butterflies, state.failedRunReasons);
      if (!archives.some(item => item.record.runId === state.selectedRunId)) {
        state.selectedRunId = archives[0]?.record.runId ?? '';
      }
      state.error = '';
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  async function returnRuin(): Promise<void> {
    if (!state.runtime || state.runtime.flowState === 'idle' || state.busy) return;
    state.busy = true;
    state.error = '';
    render();
    try {
      await client.returnRuin();
      state.status = '遣返指令已发送，伊雍正在冻结本轮历史锚点';
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function retryButterfly(runId: string): Promise<void> {
    if (!runId || state.busy) return;
    state.busy = true;
    state.error = '';
    render();
    try {
      await client.retryButterfly(runId);
      state.status = '伊雍正在重新校核这份历史回响';
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  async function deleteButterfly(runId: string): Promise<void> {
    if (!runId || state.busy) return;
    const confirmed = globalThis.confirm(
      '删除这份可见蝴蝶效应档案？\n\n已写入正文和正史的内容不会因此回滚。若该干涉仍然有效，系统只保留一份不可浏览的紧凑因果摘要，供正文维持来龙去脉。',
    );
    if (!confirmed) return;
    state.busy = true;
    state.error = '';
    render();
    try {
      const deleted = await client.deleteButterfly(runId);
      state.status = deleted
        ? '可见档案已删除；已生效的正史没有回滚，活动干涉的紧凑因果摘要仍会保留'
        : '这份档案已经不存在';
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.busy = false;
      render();
    }
  }

  function render(): void {
    const runtime = state.runtime ?? emptyRuntime();
    const archives = visibleButterflyArchives(state.butterflies, state.failedRunReasons);
    const selected = archives.find(item =>
      item.record.runId === state.selectedRunId) ?? archives[0] ?? null;
    const active = runtime.flowState !== 'idle';
    root.innerHTML = `
      <style>${timelineCss}</style>
      <section class="workbench" data-theme="${theme}"
        ${options.embedded ? 'data-embedded' : ''}>
        ${options.embedded ? '' : `<header class="page-head">
          <div>
            <h1>墟境时空</h1>
            <p>现实锚点、墟境进程与明确的状态操作</p>
          </div>
          <button class="refresh-button" type="button" data-refresh ${state.busy ? 'disabled' : ''}>
            <span aria-hidden="true">↻</span>读取当前变量
          </button>
        </header>
        <div class="ornament" aria-hidden="true"></div>`}
        ${state.error ? `<div class="notice error">${escapeHtml(state.error)}</div>` : ''}
        ${state.status ? `<div class="notice">${escapeHtml(state.status)}</div>` : ''}
        <section class="time-overview">
          ${renderTimePlane('Reality Anchor', '现实锚点', runtime.realityTime, runtime.realityLocation, false)}
          ${renderTimePlane(
            'Historical Ruin',
            '墟境时空',
            active ? runtime.ruinTime : '',
            active ? runtime.ruinLocation : '',
            true,
          )}
        </section>
        <section class="panel runtime-panel">
          <header class="panel-head">
            <div>
              <span class="panel-icon" aria-hidden="true">⌁</span>
              <h2>运行状态</h2>
              <p>只允许时间内核写入MVU</p>
            </div>
          </header>
          <div class="panel-body">
            <div class="runtime-table">
              <div class="runtime-cell">
                <span>流程状态</span>
                <strong class="teal">${escapeHtml(runtimeStateLabel(runtime.flowState))}</strong>
              </div>
              <div class="runtime-cell">
                <span>墟境轮次</span>
                <strong>${escapeHtml(runtime.runId || '未开始')}</strong>
              </div>
              <div class="runtime-cell">
                <span>现实锚点</span>
                <strong>${active ? '已锁定' : '随世界时地更新'}</strong>
              </div>
              <div class="runtime-cell">
                <span>历史档案</span>
                <strong>${archives.length} 份</strong>
              </div>
            </div>
            <div class="command-bar">
              <button class="return-button" type="button" data-return
                ${!active || state.busy ? 'disabled' : ''}>
                ${state.busy ? '正在处理' : '遣返'}
              </button>
            </div>
          </div>
        </section>
        <section class="panel archive-panel">
          <header class="panel-head">
            <div>
              <span class="panel-icon" aria-hidden="true">◈</span>
              <h2>蝴蝶效应档案</h2>
              <p>当前聊天已提交的现世变化</p>
            </div>
          </header>
          <div class="archive-layout">
            <div class="archive-list">
              ${archives.length
                ? renderArchiveCollection(
                    archives,
                    selected?.record.runId ?? '',
                    value => client.resolveDisplayText(displayPlayerName(value)),
                  )
                : '<div class="empty-state">当前聊天尚无蝴蝶效应档案</div>'}
            </div>
            <div class="archive-detail">
              ${selected
                ? renderArchiveDetail(
                    selected,
                    value => client.resolveDisplayText(displayPlayerName(value)),
                  )
                : '<div class="empty-state">完成一次遣返后，锚定日志会收录在这里。</div>'}
            </div>
          </div>
        </section>
      </section>
    `;
    bindEvents();
  }

  function bindEvents(): void {
    root.querySelector<HTMLButtonElement>('[data-refresh]')
      ?.addEventListener('click', () => void refresh());
    root.querySelector<HTMLButtonElement>('[data-return]')
      ?.addEventListener('click', () => void returnRuin());
    root.querySelectorAll<HTMLButtonElement>('[data-run-id]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedRunId = button.dataset.runId ?? '';
        render();
      });
    });
    root.querySelector<HTMLButtonElement>('[data-retry-run]')
      ?.addEventListener('click', () =>
        void retryButterfly(
          root.querySelector<HTMLButtonElement>('[data-retry-run]')
            ?.dataset.retryRun ?? '',
        ));
    root.querySelector<HTMLButtonElement>('[data-delete-run]')
      ?.addEventListener('click', event =>
        void deleteButterfly(
          (event.currentTarget as HTMLButtonElement).dataset.deleteRun ?? '',
        ));
  }

  render();
  void refresh();

  return {
    refresh,
    setTheme(nextTheme) {
      theme = nextTheme;
      root.querySelector<HTMLElement>('.workbench')
        ?.setAttribute('data-theme', nextTheme);
    },
    setAppearance(appearance) {
      theme = appearance.mode;
      applyAppearance(host, appearance);
      root.querySelector<HTMLElement>('.workbench')
        ?.setAttribute('data-theme', appearance.mode);
    },
    dispose() {
      state.disposed = true;
      offStatus();
      offReady();
      offDataChanged();
      host.remove();
    },
  };
}

function renderTimePlane(
  eyebrow: string,
  title: string,
  time: string,
  location: string,
  ruin: boolean,
): string {
  return `
    <article class="time-plane${ruin ? ' ruin' : ''}">
      <div class="plane-label">${escapeHtml(eyebrow)}</div>
      <h2>${escapeHtml(title)}</h2>
      <div class="datum"><span>时间</span><strong>${escapeHtml(time || '未进入墟境')}</strong></div>
      <div class="datum"><span>地点</span><strong>${escapeHtml(location || '未进入墟境')}</strong></div>
    </article>
  `;
}

function renderArchiveRow(
  item: ButterflyArchiveItem,
  selected: boolean,
  resolveDisplayText: (value: string) => string,
): string {
  return `
    <button class="archive-row${selected ? ' active' : ''}" type="button"
      data-run-id="${escapeAttribute(item.record.runId)}">
      <span class="archive-mark" aria-hidden="true">◉</span>
      <span>
        <strong>${escapeHtml(resolveDisplayText(item.title))}</strong>
        <small>${escapeHtml(resolveDisplayText(item.summary))}</small>
      </span>
      <i>${escapeHtml(item.statusLabel)}</i>
    </button>
  `;
}

function renderArchiveCollection(
  items: ButterflyArchiveItem[],
  selectedRunId: string,
  resolveDisplayText: (value: string) => string,
): string {
  const current = items.filter(item => !item.retryable);
  const pending = items.filter(item => item.retryable);
  return [
    renderArchiveGroup('当前有效', current, selectedRunId, resolveDisplayText),
    renderArchiveGroup('待完成归档', pending, selectedRunId, resolveDisplayText),
  ].filter(Boolean).join('');
}

function renderArchiveGroup(
  label: string,
  items: ButterflyArchiveItem[],
  selectedRunId: string,
  resolveDisplayText: (value: string) => string,
): string {
  if (!items.length) return '';
  return `
    <section class="archive-group" aria-label="${escapeAttribute(label)}">
      <header><span>${escapeHtml(label)}</span><i>${items.length}</i></header>
      ${items.map(item => renderArchiveRow(
        item,
        item.record.runId === selectedRunId,
        resolveDisplayText,
      )).join('')}
    </section>`;
}

function renderArchiveDetail(
  item: ButterflyArchiveItem,
  resolveDisplayText: (value: string) => string,
): string {
  const { effect } = item.record.result;
  const anchors = item.record.request?.anchors;
  const pathNodes = [
    ['现实锚点', anchors ? `${anchors.reality.time} · ${anchors.reality.location}` : '旧档案未记录'],
    ['墟境进入', anchors ? `${anchors.ruinEntry.time} · ${anchors.ruinEntry.location}` : '旧档案未记录'],
    ['墟境离开', anchors ? `${anchors.ruinExit.time} · ${anchors.ruinExit.location}` : '旧档案未记录'],
    ['改写后现世', item.retryable ? '等待重新归档' : effect.presentLanding],
  ] as const;
  return `
    <article class="causal-dossier${item.retryable ? ' pending' : ''}">
      <header class="dossier-head">
        <div class="dossier-badges">
          <span>${escapeHtml(effect.scope)}</span>
          <span>${escapeHtml(item.statusLabel)}</span>
        </div>
        <h3>${escapeHtml(resolveDisplayText(item.title))}</h3>
        <p>因果卷宗 · 依照亲历顺序保存</p>
      </header>
      ${item.failureReason
        ? `<p class="notice" role="note"><strong>归档尚未完成，可点下方「重新归档」重试。</strong><br>原因：${escapeHtml(item.failureReason)}</p>`
        : ''}
      <section class="causal-route" aria-label="穿越路径">
        ${pathNodes.map(([label, value], index) => `
          <div class="causal-node${item.retryable && index === pathNodes.length - 1 ? ' unresolved' : ''}">
            <span>${index + 1}</span>
            <div><small>${escapeHtml(label)}</small><strong>${escapeHtml(resolveDisplayText(value))}</strong></div>
          </div>`).join('')}
      </section>
      <section class="dossier-evidence-grid">
        <article>
          <span>墟境行动</span>
          <p>${escapeHtml(resolveDisplayText(effect.ruinActionRecord))}</p>
        </article>
        <article class="evidence-card">
          <span>可感知证据</span>
          ${item.retryable
            ? '<p class="pending-copy">等待重新归档后核定</p>'
            : `<ul>${effect.perceptibleEvidence.map(value => `<li>${escapeHtml(resolveDisplayText(value))}</li>`).join('')}</ul>`}
        </article>
      </section>
      <section class="dossier-conclusion">
        <span>历史演变</span>
        <p>${item.retryable
          ? '因果链已经冻结，结论将在重新归档成功后落定。'
          : escapeHtml(resolveDisplayText(effect.historicalEvolution))}</p>
      </section>
      <div class="archive-actions">
        ${item.retryable
          ? `<button class="retry-button" type="button" data-retry-run="${escapeAttribute(item.record.runId)}">重新归档</button>`
          : ''}
        <button class="delete-button" type="button"
          data-delete-run="${escapeAttribute(item.record.runId)}">删除档案</button>
      </div>
    </article>
  `;
}

function displayPlayerName(value: string): string {
  return value.replace(/玩家/gu, '<user>');
}

function emptyRuntime(): RuinRuntimeSnapshot {
  return {
    flowState: 'idle',
    runId: '',
    realityTime: '',
    realityLocation: '',
    ruinTime: '',
    ruinLocation: '',
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
