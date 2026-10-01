import type { WorkbenchStatusDetail } from '../runtime/facade.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import type { RuinBiographyReference } from '../storage/ruinReferences.ts';
import { visibleBiographyItems, type BiographyShelfItem } from './biographyView.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import { preserveDomState, ViewRefreshGuard } from './viewRefresh.ts';
import biographyCss from './biographyWorkbench.css?raw';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';

export interface BiographyWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface BiographyWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
}

interface BiographyState {
  records: BiographyRecord[];
  ruinReferences: RuinBiographyReference[];
  query: string;
  selectedKey: string;
  open: boolean;
  status: WorkbenchStatusDetail | null;
  error: string;
  contextMenu: { recordKey: string; x: number; y: number } | null;
  disposed: boolean;
}

export function mountBiographyWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: BiographyWorkbenchOptions = {},
): BiographyWorkbenchHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);
  let theme = options.theme ?? 'light';
  const reads = new ViewRefreshGuard(() => client.contextRevision());

  const state: BiographyState = {
    records: [],
    ruinReferences: [],
    query: '',
    selectedKey: '',
    open: false,
    status: null,
    error: '',
    contextMenu: null,
    disposed: false,
  };
  let revealAwaitingNarrative = false;
  const offStatus = client.onStatus(detail => {
    if (detail.taskType && detail.taskType !== 'biography') return;
    state.status = detail;
    if (detail.phase === 'error') state.error = detail.detail;
    if (
      detail.status === 'awaiting_narrative'
      || detail.status === 'committed'
      || detail.phase === 'success'
    ) {
      if (detail.status === 'awaiting_narrative') revealAwaitingNarrative = true;
      void refresh();
      return;
    }
    if (!detail.request) render();
  });
  const offReady = client.onReady(() => void refresh());
  const offContext = client.onContextChanged(() => {
    reads.invalidate(); state.records = []; state.ruinReferences = [];
    state.selectedKey = ''; state.open = false; state.query = ''; state.status = null;
    state.error = ''; state.contextMenu = null; revealAwaitingNarrative = false; render();
  });
  const offDataChanged = client.onDataChanged(detail => {
    if (detail.views.includes('biography')) void refresh();
  });

  function items(): BiographyShelfItem[] {
    return visibleBiographyItems(state.records, state.query);
  }

  function selectedItem(): BiographyShelfItem | null {
    const available = items();
    return available.find(item => item.record.key === state.selectedKey)
      ?? available[0]
      ?? null;
  }

  async function refresh(): Promise<void> {
    if (state.disposed || !client.isReady()) {
      render();
      return;
    }
    const current = reads.begin();
    try {
      const [records, references] = await Promise.all([
        client.listBiographies(),
        client.listRuinBiographyReferences(),
      ]);
      if (!current()) return;
      state.records = records; state.ruinReferences = references;
      const available = visibleBiographyItems(state.records, state.query);
      const awaitingNarrative = revealAwaitingNarrative
        ? available.find(item => item.record.status === 'validated')
        : undefined;
      revealAwaitingNarrative = false;
      if (awaitingNarrative) {
        state.selectedKey = awaitingNarrative.record.key;
        state.open = true;
      } else if (!available.some(item => item.record.key === state.selectedKey)) {
        state.selectedKey = available[0]?.record.key ?? '';
        state.open = false;
      }
      state.error = '';
    } catch (error) {
      if (!current()) return;
      state.error = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  function render(): void {
    if (state.disposed) return;
    const restore = preserveDomState(root);
    const available = items();
    const selected = selectedItem();
    root.innerHTML = `
      <style>${biographyCss}</style>
      <section class="workbench" data-theme="${theme}"
        ${options.embedded ? 'data-embedded' : ''}>
        ${options.embedded ? '' : `<header class="page-head">
          <div>
            <h1>传记书库</h1>
            <p>按当前聊天收纳传记全文，并参与谱系与墟境检索</p>
          </div>
        </header>`}
        <section class="library-shell">
          <header class="library-head">
            <div class="library-title">
              <span class="library-icon" aria-hidden="true">▣</span>
              <strong>虚嗣王庭传记书库</strong>
              <span>全文保存在当前聊天资料库</span>
            </div>
            <small>右键管理传记 · 选中后先查看封面</small>
          </header>
          <div class="library-layout">
            <aside class="shelf">
              <header class="shelf-head">
                <small>ARCHIVE SHELF · ${String(available.length).padStart(2, '0')}</small>
                <h2>藏书目录</h2>
              </header>
              <label class="search-field">
                <span aria-hidden="true">⌕</span>
                <input type="search" value="${escapeAttribute(state.query)}" placeholder="检索传记" aria-label="检索传记">
              </label>
              <div class="book-list">
                ${available.map(item => renderBookTab(
                  item,
                  item.record.key === selected?.record.key,
                  isRuinReference(item.record.key),
                )).join('')}
              </div>
              <footer class="shelf-foot">显示 ${available.length} 份档案 · 按最近更新排序</footer>
            </aside>
            <main class="codex-stage">
              ${renderGenerationOverlay(state.status)}
              ${renderCodexStage(selected, state.error, state.open)}
            </main>
          </div>
        </section>
        ${renderContextMenu(state.contextMenu, state.ruinReferences)}
      </section>
    `;
    bindEvents();
    restore();
  }

  function bindEvents(): void {
    root.querySelector<HTMLInputElement>('.search-field input')
      ?.addEventListener('input', event => {
        state.query = (event.currentTarget as HTMLInputElement).value;
        const available = items();
        if (!available.some(item => item.record.key === state.selectedKey)) {
          state.selectedKey = available[0]?.record.key ?? '';
          state.open = false;
        }
        renderLibraryContent();
      });

    bindLibraryContentEvents();
  }

  function renderLibraryContent(): void {
    const restore = preserveDomState(root);
    const available = items();
    const selected = selectedItem();
    const bookList = root.querySelector<HTMLElement>('.book-list');
    const codexStage = root.querySelector<HTMLElement>('.codex-stage');
    if (!bookList || !codexStage) return;

    bookList.innerHTML = available
      .map(item => renderBookTab(
        item,
        item.record.key === selected?.record.key,
        isRuinReference(item.record.key),
      ))
      .join('');
    codexStage.innerHTML = `${renderGenerationOverlay(state.status)}${renderCodexStage(
      selected,
      state.error,
      state.open,
    )}`;
    bindLibraryContentEvents();
    restore();
  }

  function isRuinReference(recordKey: string): boolean {
    return state.ruinReferences.some(reference => reference.recordKey === recordKey);
  }

  function bindLibraryContentEvents(): void {
    root.querySelectorAll<HTMLButtonElement>('[data-book-key]').forEach(button => {
      button.addEventListener('click', () => {
        state.selectedKey = button.dataset.bookKey ?? '';
        state.open = false;
        renderLibraryContent();
      });
      button.addEventListener('contextmenu', event => {
        event.preventDefault();
        state.contextMenu = {
          recordKey: button.dataset.bookKey ?? '',
          x: Math.min(event.clientX, Math.max(12, window.innerWidth - 226)),
          y: Math.min(event.clientY, Math.max(12, window.innerHeight - 126)),
        };
        render();
      });
    });

    root.querySelector<HTMLButtonElement>('[data-toggle-ruin-reference]')
      ?.addEventListener('click', async event => {
        event.stopPropagation();
        const recordKey = (event.currentTarget as HTMLButtonElement)
          .dataset.toggleRuinReference;
        if (!recordKey) return;
        const context = client.contextRevision();
        const current = () => !state.disposed && context === client.contextRevision();
        reads.invalidate();
        state.contextMenu = null;
        try {
          const references = await client.toggleBiographyRuinReference(recordKey);
          if (!current()) return;
          reads.invalidate();
          state.ruinReferences = references;
          state.error = '';
        } catch (error) {
          if (!current()) return;
          state.error = error instanceof Error ? error.message : String(error);
        }
        render();
      });

    root.querySelector<HTMLButtonElement>('[data-delete-biography]')
      ?.addEventListener('click', async event => {
        event.stopPropagation();
        const recordKey = (event.currentTarget as HTMLButtonElement)
          .dataset.deleteBiography;
        if (!recordKey || !window.confirm('确定从当前聊天的传记书库中删除这本传记吗？')) {
          return;
        }
        state.contextMenu = null;
        const context = client.contextRevision();
        reads.invalidate();
        await client.deleteBiography(recordKey);
        if (state.disposed || context !== client.contextRevision()) return;
        if (state.selectedKey === recordKey) state.selectedKey = '';
        await refresh();
      });

    root.querySelector<HTMLElement>('.workbench')?.addEventListener('click', event => {
      if (!state.contextMenu || (event.target as Element).closest('.biography-context-menu')) return;
      state.contextMenu = null;
      root.querySelector('.biography-context-menu')?.remove();
    });

    const cover = root.querySelector<HTMLElement>('.codex-cover');
    const openButton = root.querySelector<HTMLButtonElement>('[data-open-book]');
    const openBook = () => {
      state.open = true;
      root.querySelector<HTMLElement>('.codex-book')?.classList.add('open');
    };
    cover?.addEventListener('click', openBook);
    cover?.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openBook();
      }
    });
    openButton?.addEventListener('click', event => {
      event.stopPropagation();
      openBook();
    });

    root.querySelector<HTMLElement>('.codex-spread')?.addEventListener('click', event => {
      const target = event.target as HTMLElement;
      if (target.closest('details, summary, button, a, input, select, textarea, label')) return;
      state.open = false;
      renderLibraryContent();
    });

    const closeButton = root.querySelector<HTMLButtonElement>('[data-close-book]');
    const closeBook = () => {
      state.open = false;
      renderLibraryContent();
    };
    closeButton?.addEventListener('pointerup', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeBook();
    });
    closeButton?.addEventListener('click', event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeBook();
    });
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
      reads.dispose(); offContext();
      offStatus();
      offReady();
      offDataChanged();
      host.remove();
    },
  };
}

function renderBookTab(
  item: BiographyShelfItem,
  selected: boolean,
  ruinReference: boolean,
): string {
  return `
    <button class="book-tab${selected ? ' active' : ''}${ruinReference ? ' referenced' : ''}" type="button" data-book-key="${escapeAttribute(item.record.key)}">
      <span class="book-accent" style="--book-accent:${item.accent}" aria-hidden="true"></span>
      <span class="book-tab-copy">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.record.biography.stages.length.toString())}卷${item.metadata[0] ? ` · ${escapeHtml(item.metadata[0])}` : ''}${item.record.status === 'validated' ? ' · 待正文归档' : ''}</small>
      </span>
      ${ruinReference ? '<span class="reference-badge">墟境参考</span>' : ''}
    </button>
  `;
}

function renderContextMenu(
  menu: BiographyState['contextMenu'],
  references: RuinBiographyReference[],
): string {
  if (!menu) return '';
  const selected = references.some(reference => reference.recordKey === menu.recordKey);
  return `<div class="biography-context-menu" role="menu"
      style="left:${menu.x}px;top:${menu.y}px">
    <button type="button" role="menuitem" data-toggle-ruin-reference="${escapeAttribute(menu.recordKey)}">
      ${selected ? '移出墟境参考' : '加入墟境参考'}
    </button>
    <button type="button" role="menuitem" class="danger" data-delete-biography="${escapeAttribute(menu.recordKey)}">
      删除传记
    </button>
  </div>`;
}

function renderCodexStage(
  selected: BiographyShelfItem | null,
  error: string,
  open: boolean,
): string {
  if (error) return `<div class="empty-state error">${escapeHtml(error)}</div>`;
  if (selected) return renderCodex(selected, open);
  return '<div class="empty-state"><strong>尚无传记</strong><span>对正文中的人物、地点或器物进行寻根溯源后，典籍会收录于此。</span></div>';
}

function renderCodex(item: BiographyShelfItem, open: boolean): string {
  const biography = item.record.biography;
  return `
    <article class="codex-book${open ? ' open' : ''}">
      <section class="codex-cover" role="button" tabindex="0" aria-label="展开${escapeAttribute(item.title)}">
        <div class="cover-content">
          <small>ROOT TRACE · SERPENT BIOGRAPHY</small>
          <h2>${escapeHtml(item.title)}</h2>
          <p>${escapeHtml(item.subtitle)}</p>
          <div class="cover-tags">
            ${item.metadata.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}
          </div>
          <button type="button" data-open-book><span aria-hidden="true">▤</span> 展开王庭典籍</button>
        </div>
      </section>
      <button class="codex-close" type="button" data-close-book aria-label="返回传记封面">×</button>
      <section class="codex-spread" aria-label="${escapeAttribute(item.title)}正文，点击空白处返回封面">
        <div class="codex-page">
          <div class="codex-page-inner">
            <section class="opening">
              <span>ORIGIN · 起源</span>
              <h2>${escapeHtml(biography.origin.title)}</h2>
              <p>${escapeHtml(biography.origin.content)}</p>
            </section>
            <div class="chapters">
              ${biography.stages.map((stage, index) => `
                <details class="chapter" data-chapter-key="${escapeHtml(`${item.record.key}:${index}`)}">
                  <summary>
                    <span>${escapeHtml(stage.title)} · ${escapeHtml(stageTypeLabel(stage.type))}</span>
                    <small>${escapeHtml(stage.span)}</small>
                    <i aria-hidden="true"></i>
                  </summary>
                  <div class="chapter-body">
                    <p>${escapeHtml(stage.content)}</p>
                  </div>
                </details>
              `).join('')}
            </div>
            <div class="present-divider"><span>PRESENT · 现世续章</span></div>
            <section class="present">
              <span>STATUS · 现状</span>
              <h2>${escapeHtml(biography.status.title)}</h2>
              <p>${escapeHtml(biography.status.content)}</p>
            </section>
            <section class="biography-summary">
              <h3>传记总结</h3>
              <p>${escapeHtml(biography.summary)}</p>
            </section>
            <p class="return-hint">点击书页空白处返回封面</p>
          </div>
        </div>
      </section>
    </article>
  `;
}

function stageTypeLabel(type: 'stable' | 'transition' | 'turbulent'): string {
  if (type === 'stable') return '稳定期';
  if (type === 'transition') return '过渡期';
  return '动荡期';
}

function renderGenerationOverlay(status: WorkbenchStatusDetail | null): string {
  if (!isBiographyGenerating(status)) return '';
  return `
    <div class="biography-generation-overlay" role="status" aria-live="polite">
      <span class="biography-generation-spinner" aria-hidden="true"></span>
      <div>
        <strong class="eyon-voice">伊雍正在整理史料</strong>
        <small>${escapeHtml(status?.detail || '正在检索正文、世界书与既有典藏')}</small>
      </div>
    </div>`;
}

function isBiographyGenerating(status: WorkbenchStatusDetail | null): boolean {
  if (!status || status.taskType !== 'biography') return false;
  return status.phase === 'running' || status.phase === 'retrying'
    ? status.status !== 'awaiting_narrative'
    : false;
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
