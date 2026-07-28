import type {
  WorkbenchCharacter,
  WorkbenchCharacterCatalog,
  WorkbenchCharacterGroup,
} from '../runtime/facade.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import characterViewerCss from './characterViewer.css?raw';

export interface CharacterViewerHandle {
  refresh(): Promise<void>;
  dispose(): void;
}

export interface CharacterViewerOptions {
  theme?: 'dark' | 'light';
}

export function mountCharacterViewer(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: CharacterViewerOptions = {},
): CharacterViewerHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);
  const state: ViewerState = {
    catalog: null,
    selectedCharacterId: null,
    activeGroupId: undefined,
    query: '',
    lifeLevel: '',
    contract: '',
    busy: false,
    disposed: false,
  };
  let toastTimer = 0;

  const render = () => {
    if (state.disposed) return;
    root.innerHTML = `
      <style>${characterViewerCss}</style>
      ${renderViewer(state, options.theme ?? 'dark')}
    `;
    bind();
  };

  const updateCatalog = (catalog: WorkbenchCharacterCatalog) => {
    state.catalog = catalog;
    if (!catalog.characters.some(item => item.id === state.selectedCharacterId)) {
      state.selectedCharacterId = catalog.characters[0]?.id ?? null;
    }
    if (
      state.activeGroupId !== undefined
      && state.activeGroupId !== null
      && !catalog.groups.some(group => group.id === state.activeGroupId)
    ) {
      state.activeGroupId = undefined;
    }
    render();
  };

  const run = async (
    operation: () => Promise<WorkbenchCharacterCatalog>,
    message: string,
  ) => {
    if (state.busy || state.disposed) return;
    state.busy = true;
    render();
    try {
      updateCatalog(await operation());
      showStatus(message);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : '操作未能完成');
    } finally {
      state.busy = false;
      render();
    }
  };

  const showStatus = (message: string) => {
    if (state.disposed) return;
    const status = root.querySelector<HTMLElement>('[data-status]');
    if (!status) return;
    status.textContent = message;
    status.classList.add('show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => status.classList.remove('show'), 2200);
  };

  const activateGroupFilter = (value: string | undefined) => {
    state.activeGroupId = value === 'all'
      ? undefined
      : value || null;
    if (state.activeGroupId === undefined || !state.catalog) return;
    const assigned = new Set(
      state.catalog.groups.flatMap(group => group.characterIds),
    );
    const visibleIds = state.activeGroupId === null
      ? state.catalog.characters
        .filter(character => !assigned.has(character.id))
        .map(character => character.id)
      : state.catalog.groups.find(group =>
        group.id === state.activeGroupId
      )?.characterIds ?? [];
    if (!visibleIds.includes(state.selectedCharacterId ?? '')) {
      state.selectedCharacterId = visibleIds[0] ?? null;
    }
  };

  const bind = () => {
    const search = root.querySelector<HTMLInputElement>('[data-search]');
    search?.addEventListener('input', () => {
      state.query = search.value;
      render();
      const nextSearch = root.querySelector<HTMLInputElement>('[data-search]');
      nextSearch?.focus();
      nextSearch?.setSelectionRange(state.query.length, state.query.length);
    });
    root.querySelector<HTMLSelectElement>('[data-life-level]')
      ?.addEventListener('change', event => {
        state.lifeLevel = (event.currentTarget as HTMLSelectElement).value;
        render();
      });
    root.querySelector<HTMLSelectElement>('[data-contract]')
      ?.addEventListener('change', event => {
        state.contract = (event.currentTarget as HTMLSelectElement).value;
        render();
      });
    root.querySelector('[data-sync]')?.addEventListener('click', () => {
      void run(() => client.syncCharacters(), '已重新读取当前聊天的MVU人物');
    });
    root.querySelector<HTMLFormElement>('[data-create-group]')
      ?.addEventListener('submit', event => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const input = form.elements.namedItem('group-name') as HTMLInputElement | null;
        const name = input?.value.trim() ?? '';
        if (!name) {
          showStatus('请先填写组别名称');
          return;
        }
        void run(() => client.createCharacterGroup(name), `已建立组别：${name}`);
      });
    root.querySelectorAll<HTMLElement>('[data-character-id]').forEach(element => {
      element.addEventListener('click', () => {
        state.selectedCharacterId = element.dataset.characterId ?? null;
        render();
      });
      element.addEventListener('dragstart', event => {
        event.dataTransfer?.setData(
          'application/x-eyon-character',
          element.dataset.characterId ?? '',
        );
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
    });
    root.querySelectorAll<HTMLElement>('[data-drop-group]').forEach(element => {
      element.addEventListener('dragover', event => {
        event.preventDefault();
        element.classList.add('drag-over');
      });
      element.addEventListener('dragleave', () => {
        element.classList.remove('drag-over');
      });
      element.addEventListener('drop', event => {
        event.preventDefault();
        element.classList.remove('drag-over');
        const characterId = event.dataTransfer?.getData(
          'application/x-eyon-character',
        ).trim();
        if (!characterId) return;
        const groupId = element.dataset.dropGroup || null;
        state.selectedCharacterId = characterId;
        state.activeGroupId = groupId;
        void run(
          () => client.moveCharacterToGroup(characterId, groupId),
          groupId ? '人物归类已更新' : '人物已移出自定义组',
        );
      });
    });
    root.querySelectorAll<HTMLElement>('[data-filter-group]').forEach(element => {
      element.addEventListener('click', () => {
        activateGroupFilter(element.dataset.filterGroup);
        render();
      });
    });
    root.querySelector<HTMLSelectElement>('[data-assign-selected]')
      ?.addEventListener('change', event => {
        if (!state.selectedCharacterId) return;
        const groupId = (event.currentTarget as HTMLSelectElement).value || null;
        state.activeGroupId = groupId;
        void run(
          () => client.moveCharacterToGroup(
            state.selectedCharacterId ?? '',
            groupId,
          ),
          groupId ? '人物归类已更新' : '人物已移出自定义组',
        );
      });
    root.querySelectorAll<HTMLElement>('[data-rename-group]').forEach(element => {
      element.addEventListener('click', event => {
        event.stopPropagation();
        const groupId = element.dataset.renameGroup ?? '';
        const group = state.catalog?.groups.find(item => item.id === groupId);
        const nextName = host.ownerDocument.defaultView?.prompt(
          '重命名自定义组别',
          group?.name ?? '',
        );
        if (!nextName?.trim() || nextName.trim() === group?.name) return;
        void run(
          () => client.renameCharacterGroup(groupId, nextName),
          `组别已重命名为：${nextName.trim()}`,
        );
      });
    });
    root.querySelectorAll<HTMLElement>('[data-delete-group]').forEach(element => {
      element.addEventListener('click', event => {
        event.stopPropagation();
        const groupId = element.dataset.deleteGroup ?? '';
        const group = state.catalog?.groups.find(item => item.id === groupId);
        const confirmed = host.ownerDocument.defaultView?.confirm(
          `删除组别“${group?.name ?? ''}”？组内人物不会被删除。`,
        );
        if (!confirmed) return;
        void run(() => client.deleteCharacterGroup(groupId), '组别已删除，人物仍保留');
      });
    });
    root.querySelector('[data-hide-selected]')?.addEventListener('click', () => {
      if (!state.selectedCharacterId) return;
      void run(
        () => client.hideCharacter(state.selectedCharacterId ?? ''),
        '人物已从当前界面隐藏，可通过同步恢复',
      );
    });
  };

  const refresh = async () => {
    if (state.disposed) return;
    state.busy = true;
    render();
    try {
      updateCatalog(await client.facade().getCharacterCatalog());
    } catch (error) {
      showStatus(error instanceof Error ? error.message : '人物目录读取失败');
    } finally {
      state.busy = false;
      render();
    }
  };

  render();
  void refresh();

  return {
    refresh,
    dispose() {
      state.disposed = true;
      window.clearTimeout(toastTimer);
      host.remove();
    },
  };
}

interface ViewerState {
  catalog: WorkbenchCharacterCatalog | null;
  selectedCharacterId: string | null;
  activeGroupId: string | null | undefined;
  query: string;
  lifeLevel: string;
  contract: string;
  busy: boolean;
  disposed: boolean;
}

function renderViewer(state: ViewerState, theme: 'dark' | 'light'): string {
  const catalog = state.catalog;
  const characters = catalog?.characters ?? [];
  const groups = catalog?.groups ?? [];
  const visibleCharacters = filterCharacters(characters, groups, state);
  const selected = characters.find(item => item.id === state.selectedCharacterId) ?? null;
  const lifeLevels = uniqueStrings(characters.map(item => readString(item.data, '生命层级')));
  return `
    <div class="viewer-shell">
      <section class="viewer" data-theme="${theme}" aria-label="伊雍人物查看器">
        <header class="topbar">
          <div class="heading">
            <h2>人物查看</h2>
            <p>读取当前聊天的MVU人物；隐藏与自定义组别仅保存在本地</p>
          </div>
          <button class="sync-button" data-sync ${state.busy ? 'disabled' : ''}>
            ${state.busy ? '读取中' : `同步变量${catalog?.hiddenCount ? ` · 恢复${catalog.hiddenCount}` : ''}`}
          </button>
        </header>
        <div class="filters">
          <label class="search">
            <span aria-hidden="true">⌕</span>
            <input data-search value="${escapeAttribute(state.query)}" placeholder="搜索姓名、身份、职业、种族或自定义组">
          </label>
          <select data-life-level aria-label="生命层级筛选">
            <option value="">全部生命层级</option>
            ${lifeLevels.map(value =>
              `<option value="${escapeAttribute(value)}" ${state.lifeLevel === value ? 'selected' : ''}>${escapeHtml(value)}</option>`,
            ).join('')}
          </select>
          <select data-contract aria-label="契约状态筛选">
            <option value="">全部契约状态</option>
            <option value="yes" ${state.contract === 'yes' ? 'selected' : ''}>命定契约</option>
            <option value="no" ${state.contract === 'no' ? 'selected' : ''}>未缔约</option>
          </select>
        </div>
        <div class="workbench">
          <aside class="index">
            <div class="panel-head">
              <strong>MVU人物</strong>
              <span>${visibleCharacters.length} / ${catalog?.totalCount ?? 0}</span>
            </div>
            <div class="character-list">
              ${visibleCharacters.length
                ? visibleCharacters.map(character =>
                  renderCharacterCard(character, character.id === state.selectedCharacterId),
                ).join('')
                : '<div class="empty">当前筛选下没有人物</div>'}
            </div>
          </aside>
          <article class="detail">
            ${selected ? renderCharacterDetail(selected, groups) : `
              <div class="detail-empty">
                <p>${state.busy ? '正在读取当前聊天的人物资料' : '选择一名人物查看完整MVU字段'}</p>
              </div>
            `}
          </article>
          <aside class="groups">
            <div class="panel-head">
              <strong>自定义组别</strong>
              <span>当前聊天本地保存</span>
            </div>
            <form class="group-create" data-create-group>
              <input name="group-name" maxlength="24" placeholder="新组别名称" aria-label="新组别名称">
              <button type="submit" title="新建组别" ${state.busy ? 'disabled' : ''}>＋</button>
            </form>
            <div class="group-list">
              <button class="all-group ${state.activeGroupId === undefined ? 'active' : ''}" data-filter-group="all">
                全部人物 · ${characters.length}
              </button>
              <button
                class="unassigned-group ${state.activeGroupId === null ? 'active' : ''}"
                data-filter-group=""
                data-drop-group=""
              >
                未归类 · ${countUnassigned(characters, groups)}
              </button>
              ${groups.map(group => renderGroup(group, characters, state.activeGroupId)).join('')}
            </div>
          </aside>
        </div>
      </section>
      <div class="status" data-status role="status" aria-live="polite"></div>
    </div>
  `;
}

function renderCharacterCard(
  character: WorkbenchCharacter,
  selected: boolean,
): string {
  const data = character.data;
  const summary = [
    readString(data, '种族'),
    readArray(data, '身份')[0],
    readString(data, '生命层级'),
    readNumber(data, '等级') !== null ? `Lv.${readNumber(data, '等级')}` : '',
  ].filter(Boolean).join(' · ');
  return `
    <button
      class="character-card ${selected ? 'selected' : ''}"
      data-character-id="${escapeAttribute(character.id)}"
      draggable="true"
    >
      <span class="avatar">${escapeHtml(character.name.slice(0, 1))}</span>
      <span class="character-copy">
        <strong>${escapeHtml(character.name)}</strong>
        <small>${escapeHtml(summary || 'MVU人物资料')}</small>
      </span>
      <span class="presence ${readBoolean(data, '在场') ? 'on' : ''}" title="${readBoolean(data, '在场') ? '在场' : '不在场'}"></span>
    </button>
  `;
}

function renderCharacterDetail(
  character: WorkbenchCharacter,
  groups: WorkbenchCharacterGroup[],
): string {
  const data = character.data;
  const identities = readArray(data, '身份');
  const careers = readArray(data, '职业');
  const badges = [
    readString(data, '种族'),
    ...careers,
    readString(data, '生命层级'),
    readNumber(data, '等级') !== null ? `Lv.${readNumber(data, '等级')}` : '',
    readBoolean(data, '命定契约') ? '命定契约' : '未缔约',
  ].filter(Boolean);
  const sections: Array<[string, string, boolean?]> = [
    ['性格', readString(data, '性格')],
    ['喜爱', readString(data, '喜爱')],
    ['外貌', readString(data, '外貌')],
    ['着装', readString(data, '着装')],
    ['心里话', readString(data, '心里话'), true],
    ['背景故事', readString(data, '背景故事'), true],
  ];
  const assignedGroupId = groups.find(group =>
    group.characterIds.includes(character.id)
  )?.id ?? '';
  return `
    <header class="detail-head">
      <div class="detail-avatar">${escapeHtml(character.name.slice(0, 1))}</div>
      <div class="detail-title">
        <h3>${escapeHtml(character.name)}</h3>
        <p>${escapeHtml(identities.join(' · ') || '当前MVU人物')}</p>
        <div class="badges">${badges.map(value => `<span class="badge">${escapeHtml(String(value))}</span>`).join('')}</div>
      </div>
      <div class="detail-actions">
        <label class="assignment">
          <span>所属组别</span>
          <select data-assign-selected aria-label="所属组别">
            <option value="" ${assignedGroupId ? '' : 'selected'}>未归类</option>
            ${groups.map(group => `
              <option
                value="${escapeAttribute(group.id)}"
                ${assignedGroupId === group.id ? 'selected' : ''}
              >
                ${escapeHtml(group.name)}
              </option>
            `).join('')}
          </select>
        </label>
        <button class="text-button" data-hide-selected title="仅从当前界面隐藏，不修改MVU">隐藏人物</button>
      </div>
    </header>
    <div class="detail-sections">
      ${sections.map(([title, content, wide]) => `
        <section class="detail-section ${wide ? 'wide' : ''}">
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(content || '暂无记录')}</p>
        </section>
      `).join('')}
    </div>
  `;
}

function renderGroup(
  group: WorkbenchCharacterGroup,
  characters: WorkbenchCharacter[],
  activeGroupId: string | null | undefined,
): string {
  const members = group.characterIds
    .map(id => characters.find(character => character.id === id))
    .filter((item): item is WorkbenchCharacter => Boolean(item));
  return `
    <section
      class="group ${activeGroupId === group.id ? 'active' : ''}"
      data-drop-group="${escapeAttribute(group.id)}"
    >
      <div class="group-head">
        <button data-filter-group="${escapeAttribute(group.id)}" title="筛选此组">${escapeHtml(group.name)}</button>
        <span>${members.length}人</span>
        <button class="group-tool" data-rename-group="${escapeAttribute(group.id)}" title="重命名组别">✎</button>
        <button class="group-tool" data-delete-group="${escapeAttribute(group.id)}" title="删除组别">×</button>
      </div>
      <div class="group-members">
        ${members.length
          ? members.map(member => `
            <button class="member" data-character-id="${escapeAttribute(member.id)}" draggable="true">
              ${escapeHtml(member.name)}
            </button>
          `).join('')
          : '<span class="group-empty">拖入人物建立分类</span>'}
      </div>
    </section>
  `;
}

function filterCharacters(
  characters: WorkbenchCharacter[],
  groups: WorkbenchCharacterGroup[],
  state: ViewerState,
): WorkbenchCharacter[] {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const assigned = new Set(groups.flatMap(group => group.characterIds));
  const activeIds = state.activeGroupId === undefined
    ? null
    : state.activeGroupId === null
      ? new Set(characters.filter(item => !assigned.has(item.id)).map(item => item.id))
      : new Set(groups.find(group => group.id === state.activeGroupId)?.characterIds ?? []);
  return characters.filter(character => {
    if (activeIds && !activeIds.has(character.id)) return false;
    if (
      state.lifeLevel
      && readString(character.data, '生命层级') !== state.lifeLevel
    ) return false;
    if (
      state.contract
      && readBoolean(character.data, '命定契约') !== (state.contract === 'yes')
    ) return false;
    if (!query) return true;
    const haystack = [
      character.name,
      readString(character.data, '种族'),
      ...readArray(character.data, '身份'),
      ...readArray(character.data, '职业'),
      ...groups
        .filter(group => group.characterIds.includes(character.id))
        .map(group => group.name),
    ].join('\n').toLocaleLowerCase('zh-CN');
    return haystack.includes(query);
  });
}

function countUnassigned(
  characters: WorkbenchCharacter[],
  groups: WorkbenchCharacterGroup[],
): number {
  const assigned = new Set(groups.flatMap(group => group.characterIds));
  return characters.filter(character => !assigned.has(character.id)).length;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function readString(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readArray(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : [];
}

function readNumber(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(data: Record<string, unknown>, key: string): boolean {
  return data[key] === true;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
