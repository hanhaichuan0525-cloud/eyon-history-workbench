import type {
  GenealogyCharacterOption,
  WorkbenchStatusDetail,
} from '../runtime/facade.ts';
import type { GenealogyNode } from '../schemas/genealogy.ts';
import { genealogyDisplayDates, genealogyEdgeDescription, genealogyFamilyView, genealogyMilestone,
  genealogyRelationText, hasOriginFamily, lineageKindLabels, type GenealogyFamilyTrack } from '../core/genealogyIdentity.ts';
import { genealogyUnitLabel } from '../core/genealogyLocalView.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import {
  ruinCharacterReferenceIdentity,
  type RuinSelectedCharacter,
} from '../storage/ruinReferences.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import genealogyCss from './genealogyWorkbench.css?raw';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import { installScrollPan } from './scrollPan.ts';
import {
  createGenealogyBoardConnectors,
  createGenealogyBoardLayout,
  displayGenealogyDateLabel,
  type GenealogyBoardLayout,
} from './genealogyLayout.ts';

export interface GenealogyWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface GenealogyWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
}

interface GenealogyState {
  characters: GenealogyCharacterOption[];
  records: GenealogyRecord[];
  ruinReferences: RuinSelectedCharacter[];
  selectedMvuId: string;
  identityByCharacter: Map<string, { kind: keyof typeof lineageKindLabels; note: string }>;
  selectedNodeId: string;
  familyTracks: Map<string, GenealogyFamilyTrack>;
  contextMenu: { nodeId: string; x: number; y: number } | null;
  ancestors: number;
  descendants: number;
  maxPerGeneration: number;
  depthByCharacter: Map<string, {
    ancestors: number;
    descendants: number;
    maxPerGeneration: number;
  }>;
  zoom: number;
  busy: boolean;
  busyCharacterId: string;
  status: WorkbenchStatusDetail | null;
  error: string;
  disposed: boolean;
}

export function mountGenealogyWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: GenealogyWorkbenchOptions = {},
): GenealogyWorkbenchHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const stopScrollPan = installScrollPan(root, '[data-board-scroll]', 'both');
  container.replaceChildren(host);
  let theme = options.theme ?? 'light';

  const configuredDepth = client.isReady()
    ? client.facade().getSettings().genealogyDepth
    : { ancestors: 4, descendants: 3, maxPerGeneration: 4 };
  const state: GenealogyState = {
    characters: [],
    records: [],
    ruinReferences: [],
    selectedMvuId: '',
    identityByCharacter: new Map(),
    selectedNodeId: '',
    familyTracks: new Map(),
    contextMenu: null,
    ancestors: configuredDepth.ancestors,
    descendants: configuredDepth.descendants,
    maxPerGeneration: configuredDepth.maxPerGeneration,
    depthByCharacter: new Map(),
    zoom: 1,
    busy: false,
    busyCharacterId: '',
    status: null,
    error: '',
    disposed: false,
  };
  const offStatus = client.onStatus(detail => {
    if (detail.taskType === 'butterfly' && detail.phase === 'success') void refresh();
    if (detail.taskType !== 'genealogy') return;
    if (
      state.busyCharacterId
      && state.busyCharacterId !== state.selectedMvuId
    ) return;
    state.status = detail;
    if (detail.phase === 'error') state.error = detail.detail;
    render();
  });
  const offReady = client.onReady(() => void refresh());
  const offDataChanged = options.embedded ? () => {} : client.onDataChanged(detail => {
    if (detail.views.includes('genealogy')) void refresh();
  });
  let refreshEpoch = 0;
  const changeDepth = (button: HTMLButtonElement): void => {
    if (button.disabled) return;
    const key = button.dataset.stepper as
      | 'ancestors'
      | 'descendants'
      | 'maxPerGeneration';
    const delta = Number(button.dataset.delta);
    const limits = key === 'ancestors'
      ? { min: 1, max: 8 }
      : key === 'descendants'
        ? { min: 0, max: 6 }
        : { min: 1, max: 7 };
    if (!Number.isFinite(delta)) return;

    state[key] = clamp(state[key] + delta, limits.min, limits.max);
    const character = selectedCharacter();
    if (character) {
      state.depthByCharacter.set(character.mvuId, {
        ancestors: state.ancestors,
        descendants: state.descendants,
        maxPerGeneration: state.maxPerGeneration,
      });
    }
    if (client.isReady()) {
      client.setGenealogyDepth(
        state.ancestors,
        state.descendants,
        state.maxPerGeneration,
      );
    }
    render();
  };
  const onPersistentClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('[data-stepper]');
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    changeDepth(button);
  };
  root.addEventListener('click', onPersistentClick);

  function selectedCharacter(): GenealogyCharacterOption | null {
    return state.characters.find(item => item.mvuId === state.selectedMvuId)
      ?? state.characters[0]
      ?? null;
  }

  function selectedRecord(): GenealogyRecord | null {
    const character = selectedCharacter();
    if (!character) return null;
    return newestRecordForCharacter(state.records, character);
  }

  function restoreDepthForCharacter(
    character: GenealogyCharacterOption | null,
  ): void {
    if (!character) return;
    const identityRecord = newestRecordForCharacter(state.records, character);
    if (!state.identityByCharacter.has(character.mvuId) && identityRecord) {
      state.identityByCharacter.set(character.mvuId, {
        kind: identityRecord.input.lineageKind ?? 'auto', note: identityRecord.input.identityNote ?? '',
      });
    }
    const saved = state.depthByCharacter.get(character.mvuId);
    if (saved) {
      state.ancestors = saved.ancestors;
      state.descendants = saved.descendants;
      state.maxPerGeneration = saved.maxPerGeneration;
      return;
    }
    const record = newestRecordForCharacter(state.records, character);
    const depth = record?.result.depth ?? configuredDepth;
    state.ancestors = depth.ancestors;
    state.descendants = depth.descendants;
    state.maxPerGeneration = depth.maxPerGeneration;
    state.depthByCharacter.set(character.mvuId, { ...depth });
  }

  function selectedNode(record: GenealogyRecord | null): GenealogyNode | null {
    if (!record) return null;
    return record.result.nodes.find(node => node.id === state.selectedNodeId)
      ?? record.result.nodes.find(node => node.isFocus)
      ?? record.result.nodes[0]
      ?? null;
  }

  async function refresh(): Promise<void> {
    if (state.disposed) return;
    if (!client.isReady()) {
      state.error = '伊雍历史工作台尚未完成初始化';
      render();
      return;
    }
    const epoch = ++refreshEpoch;
    const selectedBeforeRefresh = state.selectedMvuId;
    state.error = '';
    try {
      const [characters, records, ruinReferences] = await Promise.all([
        client.listGenealogyCharacters(),
        client.listGenealogies(),
        client.listRuinCharacterReferences(),
      ]);
      if (state.disposed || epoch !== refreshEpoch) return;
      state.characters = characters;
      state.records = records;
      state.ruinReferences = ruinReferences;
      if (characters.some(item => item.mvuId === selectedBeforeRefresh)) {
        state.selectedMvuId = selectedBeforeRefresh;
      } else if (!characters.some(item => item.mvuId === state.selectedMvuId)) {
        state.selectedMvuId = characters[0]?.mvuId ?? '';
      }
      restoreDepthForCharacter(selectedCharacter());
      const record = selectedRecord();
      state.selectedNodeId = record?.result.nodes.find(node => node.isFocus)?.id
        ?? record?.result.nodes[0]?.id
        ?? '';
    } catch (error) {
      if (epoch !== refreshEpoch) return;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!state.disposed && epoch === refreshEpoch) render();
    }
  }

  async function toggleRuinReference(
    record: GenealogyRecord,
    nodeId: string,
  ): Promise<void> {
    state.contextMenu = null;
    state.error = '';
    render();
    try {
      state.ruinReferences = await client.toggleGenealogyNodeRuinReference(
        record.key,
        nodeId,
      );
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  async function generate(): Promise<void> {
    const character = selectedCharacter();
    if (!character || state.busy) return;
    const generationCharacterId = character.mvuId;
    const generationDepth = {
      ancestors: state.ancestors,
      descendants: state.descendants,
      maxPerGeneration: state.maxPerGeneration,
    };
    state.busy = true;
    state.busyCharacterId = generationCharacterId;
    state.error = '';
    state.status = {
      status: 'generating_genealogy',
      detail: '伊雍正在梳理宗脉',
    };
    render();
    try {
      client.setGenealogyDepth(
        generationDepth.ancestors,
        generationDepth.descendants,
        generationDepth.maxPerGeneration,
      );
      const record = await client.generateGenealogy({
        focusCharacter: {
          mvuId: character.mvuId,
          name: character.name,
          aliases: character.aliases,
        },
        depth: generationDepth,
        lineageKind: state.identityByCharacter.get(character.mvuId)?.kind ?? 'auto',
        identityNote: state.identityByCharacter.get(character.mvuId)?.note ?? '',
      });
      state.records = [
        ...state.records.filter(item => item.key !== record.key),
        record,
      ];
      state.ruinReferences = await client.listRuinCharacterReferences();
      if (state.selectedMvuId === generationCharacterId) {
        state.selectedNodeId = record.result.nodes.find(node => node.isFocus)?.id
          ?? record.result.nodes[0]?.id
          ?? '';
      }
      state.status = { status: 'ready', detail: '宗族谱系已经完成' };
    } catch (error) {
      state.error = '谱系生成未完成，技术详情已保存到设置中的错误日志。';
      state.status = { status: 'failed', detail: state.error };
    } finally {
      state.busy = false;
      state.busyCharacterId = '';
      render();
    }
  }

  function render(): void {
    if (state.disposed) return;
    const previousScroll = root.querySelector<HTMLElement>('[data-board-scroll]');
    const scrollLeft = previousScroll?.scrollLeft ?? 0;
    const scrollTop = previousScroll?.scrollTop ?? 0;
    const character = selectedCharacter();
    const record = selectedRecord();
    const track = record ? state.familyTracks.get(record.requestId) ?? 'body' : 'body';
    const viewRecord = record ? { ...record, result: genealogyFamilyView(record.result, track) } : null;
    const node = selectedNode(viewRecord);
    const dates = node ? genealogyDisplayDates(node, track) : null;
    const milestone = node ? genealogyMilestone(node) : null;
    const isCreation = record?.result.nodes.find(item => item.isFocus)?.identity?.lineageKind === 'creation';
    const layout = viewRecord ? createGenealogyBoardLayout(viewRecord.result) : null;
    root.innerHTML = `
      <style>${genealogyCss}</style>
      <main class="genealogy-app" data-theme="${theme}">
        ${options.embedded ? '' : renderWorkingState(state)}
        <div class="genealogy-layout">
          <aside class="focus-person">
            <div class="focus-heading">
              <div class="large-avatar">${escapeHtml(initial(character?.name))}</div>
              <div>
                <span>谱系中心人物</span>
                <h2>${escapeHtml(character?.name || '尚未选择')}</h2>
              </div>
            </div>
            <label class="field">
              <strong>选择 MVU 已有角色</strong>
              <select data-character>
                ${state.characters.length
                  ? state.characters.map(item => `
                    <option value="${escapeAttribute(item.mvuId)}"
                      ${item.mvuId === character?.mvuId ? 'selected' : ''}>
                      ${escapeHtml(item.name)}
                    </option>`).join('')
                  : '<option value="">当前聊天没有可用的 MVU 人物</option>'}
              </select>
            </label>
            <label class="field">
              <strong>身份与谱系方式</strong>
              <select data-identity-kind ${state.busy ? 'disabled' : ''}>
                ${Object.entries(lineageKindLabels).map(([kind, label]) => `<option value="${kind}" ${kind === (state.identityByCharacter.get(character?.mvuId ?? '')?.kind ?? 'auto') ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>
            <details class="identity-supplement">
              <summary>身份补充（可选）</summary>
            <label class="field">
              <textarea data-identity-note maxlength="240" rows="2" ${state.busy ? 'disabled' : ''}
                placeholder="如：灵魂来自异界，保留宿主血缘；启动时间不是出生">${escapeHtml(state.identityByCharacter.get(character?.mvuId ?? '')?.note ?? '')}</textarea>
              <small>只约束本次谱系，不修改世界书或 MVU；来源不详时保留待考。</small>
            </label>
            </details>
            <div class="character-brief">
              <dl>
                <dt>种族</dt><dd>${escapeHtml(character?.race || '未记录')}</dd>
                <dt>身份</dt><dd>${escapeHtml(joinSummary(character?.identities))}</dd>
                <dt>职业</dt><dd>${escapeHtml(joinSummary(character?.professions))}</dd>
                <dt>层级</dt><dd>${escapeHtml(character?.lifeLevel || '未记录')}</dd>
              </dl>
            </div>
            <div class="field">
              <strong>${isCreation ? '源流追溯' : '祖辈追溯'}</strong>
              ${renderStepper('ancestors', state.ancestors, 1, 8, false)}
            </div>
            <div class="field">
              <strong>${isCreation ? '传承追溯' : '后代追溯'}</strong>
              ${renderStepper('descendants', state.descendants, 0, 6, false)}
            </div>
            <div class="field">
              <strong>每代最多人物</strong>
              ${renderStepper(
                'maxPerGeneration',
                state.maxPerGeneration,
                1,
                7,
                false,
              )}
            </div>
            <button class="primary-button" data-generate
              ${!character || state.busy ? 'disabled' : ''}>
              <span aria-hidden="true">⑂</span>
              ${record ? '重新构建谱系' : '构建宗族谱系'}
            </button>
            <section class="focus-detail" aria-live="polite">
              <span>选中人物</span>
              <strong>${escapeHtml(node?.name || '尚无谱系记录')}</strong>
              <dl>
                <dt>关系</dt><dd>${escapeHtml(node && record ? genealogyRelationText(record.result, node, track) : '等待生成')}</dd>
                <dt>${dates?.title ?? '生卒'}</dt><dd>${escapeHtml(node ? lifeSpan(node, node.isFocus ? character : null, track) : '等待生成')}</dd>
                ${node?.identities.length ? `<dt>身份</dt><dd>${escapeHtml(joinSummary(node.identities))}</dd>` : ''}
                ${node?.isFocus && track === 'soul' && node.identity?.soul?.name ? `<dt>曾用名</dt><dd>${escapeHtml(node.identity.soul.name)}</dd>` : ''}
                ${milestone && track !== 'soul' ? `<dt>${milestone.title}</dt><dd>${escapeHtml(displayGenealogyDateLabel(milestone.label))}</dd>` : ''}
                <dt>职业</dt><dd>${escapeHtml(node ? joinSummary(node.professions) : '等待生成')}</dd>
                <dt>性格</dt><dd>${escapeHtml(node?.profile.personality || '等待生成')}</dd>
                <dt>经历</dt><dd>${escapeHtml(node?.profile.lifeExperience || '等待生成')}</dd>
              </dl>
            </section>
            ${state.error ? `<p class="error-message">${escapeHtml(state.error)}</p>` : ''}
          </aside>
          <section class="kinship-shell" aria-label="宗族谱系图">
            <header class="kinship-toolbar">
              <div>
                <strong>谱系人物</strong>
                <span>${viewRecord ? `${viewRecord.result.nodes.length} 人` : '尚未构建'}</span>
              </div>
              ${record && hasOriginFamily(record.result) ? `<div class="family-switch" role="group" aria-label="选择家族">
                <button type="button" data-family-track="body" aria-pressed="${track === 'body'}">肉身家族</button>
                <button type="button" data-family-track="soul" aria-pressed="${track === 'soul'}">原身份家族</button>
              </div>` : ''}
              <div class="toolbar">
                <button class="icon-button" data-zoom="-0.1" title="缩小谱系"
                  ${!record ? 'disabled' : ''}>−</button>
                <button class="icon-button" data-center title="居中当前人物"
                  ${!record ? 'disabled' : ''}>◎</button>
                <button class="icon-button" data-zoom="0.1" title="放大谱系"
                  ${!record ? 'disabled' : ''}>＋</button>
                <button class="icon-button" data-refresh title="重新读取当前变量">↻</button>
              </div>
            </header>
            ${record ? '<p class="board-pan-hint">拖动画布查看谱系 · 点击人物查看详情 · ◎ 回到本人</p>' : ''}
            ${viewRecord && layout
              ? renderBoard(
                viewRecord,
                layout,
                state.zoom,
                state.selectedNodeId,
                new Set(state.ruinReferences.map(ruinCharacterReferenceIdentity)),
                character,
                track,
              )
              : renderEmptyState(state.characters.length > 0)}
          </section>
        </div>
        ${record ? renderContextMenu(record, state) : ''}
      </main>
    `;
    bind(layout);
    const nextScroll = root.querySelector<HTMLElement>('[data-board-scroll]');
    if (nextScroll) {
      nextScroll.scrollLeft = scrollLeft;
      nextScroll.scrollTop = scrollTop;
    }
  }

  function bind(layout: GenealogyBoardLayout | null): void {
    root.querySelectorAll<HTMLButtonElement>('[data-family-track]').forEach(button => {
      button.addEventListener('click', () => {
        const record = selectedRecord();
        const track = button.dataset.familyTrack;
        if (!record || (track !== 'body' && track !== 'soul')) return;
        state.familyTracks.set(record.requestId, track);
        state.selectedNodeId = record.result.nodes.find(node => node.isFocus)?.id ?? '';
        state.contextMenu = null;
        render();
        root.querySelector<HTMLButtonElement>(`[data-family-track="${track}"]`)?.focus();
        root.querySelector<HTMLButtonElement>('[data-center]')?.click();
      });
    });
    const updateIdentityDraft = (): void => {
      if (!state.selectedMvuId) return;
      const kind = root.querySelector<HTMLSelectElement>('[data-identity-kind]')?.value as keyof typeof lineageKindLabels;
      if (!Object.hasOwn(lineageKindLabels, kind)) return;
      state.identityByCharacter.set(state.selectedMvuId, {
        kind, note: root.querySelector<HTMLTextAreaElement>('[data-identity-note]')?.value.slice(0, 240) ?? '',
      });
    };
    root.querySelector('[data-identity-kind]')?.addEventListener('change', updateIdentityDraft);
    root.querySelector('[data-identity-note]')?.addEventListener('input', updateIdentityDraft);
    root.querySelector<HTMLSelectElement>('[data-character]')
      ?.addEventListener('change', event => {
        state.selectedMvuId = (event.currentTarget as HTMLSelectElement).value;
        state.contextMenu = null;
        restoreDepthForCharacter(selectedCharacter());
        const record = selectedRecord();
        state.selectedNodeId = record?.result.nodes.find(node => node.isFocus)?.id
          ?? record?.result.nodes[0]?.id
          ?? '';
        render();
      });
    root.querySelector('[data-generate]')?.addEventListener('click', () => {
      void generate();
    });
    root.querySelector('[data-refresh]')?.addEventListener('click', () => {
      void refresh();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-node-id]').forEach(button => {
      button.addEventListener('click', () => {
        state.contextMenu = null;
        state.selectedNodeId = button.dataset.nodeId ?? '';
        render();
      });
      button.addEventListener('contextmenu', event => {
        const record = selectedRecord();
        const nodeId = button.dataset.nodeId ?? '';
        const node = record?.result.nodes.find(item => item.id === nodeId);
        if (!record || !node) return;
        event.preventDefault();
        state.selectedNodeId = nodeId;
        state.contextMenu = {
          nodeId,
          x: Math.min(event.clientX, window.innerWidth - 250),
          y: Math.min(event.clientY, window.innerHeight - 80),
        };
        render();
      });
    });
    root.querySelector<HTMLButtonElement>('[data-toggle-ruin-reference]')
      ?.addEventListener('click', () => {
        const record = selectedRecord();
        const nodeId = state.contextMenu?.nodeId;
        if (record && nodeId) void toggleRuinReference(record, nodeId);
      });
    root.querySelector('[data-close-context-menu]')?.addEventListener('click', () => {
      state.contextMenu = null;
      render();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(button => {
      button.addEventListener('click', () => {
        state.zoom = clamp(state.zoom + Number(button.dataset.zoom), 0.7, 1.3);
        render();
      });
    });
    root.querySelector('[data-center]')?.addEventListener('click', () => {
      if (!layout) return;
      const scroll = root.querySelector<HTMLElement>('[data-board-scroll]');
      const record = selectedRecord();
      const focus = record?.result.nodes.find(node => node.isFocus);
      const position = layout.positions.find(item => item.node.id === focus?.id);
      if (!scroll || !position) return;
      scroll.scrollTo({
        left: Math.max(0, position.x * state.zoom - scroll.clientWidth / 2),
        top: Math.max(0, position.y * state.zoom - scroll.clientHeight / 2),
        behavior: 'smooth',
      });
    });
  }

  render();
  void refresh();

  return {
    refresh,
    setTheme(nextTheme) {
      theme = nextTheme;
      root.querySelector<HTMLElement>('.genealogy-app')
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
      stopScrollPan();
      offStatus();
      offReady();
      offDataChanged();
      root.removeEventListener('click', onPersistentClick);
      container.replaceChildren();
    },
  };
}

function renderWorkingState(state: GenealogyState): string {
  if (!state.busy && state.status?.status !== 'failed') return '';
  const detail = state.status?.detail
    || (state.busy ? '伊雍正在梳理宗脉' : state.error);
  return `
    <aside class="working-state ${state.busy ? 'active' : 'failed'}" role="status">
      <span class="working-mark" aria-hidden="true">伊</span>
      <div><strong>${state.busy ? '王庭档案处理中' : '谱系生成未完成'}</strong>
      <p>${escapeHtml(detail)}</p></div>
    </aside>
  `;
}

function renderStepper(
  key: 'ancestors' | 'descendants' | 'maxPerGeneration',
  value: number,
  min: number,
  max: number,
  disabled: boolean,
): string {
  return `
    <div class="stepper">
      <button type="button" data-stepper="${key}" data-delta="-1"
        ${disabled || value <= min ? 'disabled' : ''} aria-label="减少">−</button>
      <strong>${value} ${key === 'maxPerGeneration' ? '人' : '代'}</strong>
      <button type="button" data-stepper="${key}" data-delta="1"
        ${disabled || value >= max ? 'disabled' : ''} aria-label="增加">＋</button>
    </div>
  `;
}

function renderEmptyState(hasCharacters: boolean): string {
  return `
    <div class="empty-state">
      <span aria-hidden="true">⑂</span>
      <strong>${hasCharacters ? '尚未建立这位人物的宗族谱系' : '当前聊天没有可用的 MVU 人物'}</strong>
      <p>${hasCharacters
        ? '设定追溯代数后构建谱系；生成结果只保存在当前聊天。'
        : '请先让 MVU 关系列表记录人物，再重新读取当前变量。'}</p>
    </div>
  `;
}

function renderBoard(
  record: GenealogyRecord,
  layout: GenealogyBoardLayout,
  zoom: number,
  selectedNodeId: string,
  ruinReferenceIds: Set<string>,
  focusCharacter: GenealogyCharacterOption | null,
  track: GenealogyFamilyTrack,
): string {
  const edgesById = new Map(record.result.edges.map(edge => [edge.id, edge]));
  const edges = createGenealogyBoardConnectors(record.result, layout).map(connector => {
    const edgeRecords = connector.edgeIds.flatMap(edgeId => {
      const edge = edgesById.get(edgeId);
      return edge ? [edge] : [];
    });
    const units = connector.edgeIds.map(edgeId =>
      record.localView?.units.find(item => item.unitType === 'edge' && item.unitId === edgeId));
    const title = edgeRecords.map((edge, index) =>
      `${genealogyEdgeDescription(edge)}：${genealogyUnitLabel(units[index])}`).join('；');
    return `<path class="kin-edge-${connector.kind}" d="${connector.path}"><title>${escapeHtml(title)}</title></path>`;
  }).join('');
  return `
    <div class="kinship-scroll" data-board-scroll tabindex="0" role="region"
      aria-label="宗族谱系画布，可上下左右滑动或使用方向键查看">
      <div class="kinship-stage"
        style="width:${layout.width * zoom}px;height:${layout.height * zoom}px">
        <div class="kinship-board"
          style="width:${layout.width}px;height:${layout.height}px;transform:scale(${zoom})">
          ${layout.generationLabels.map(mark => `
            <span class="generation-mark" style="top:${mark.y}px">
              ${escapeHtml(mark.label)}
            </span>`).join('')}
          <svg viewBox="0 0 ${layout.width} ${layout.height}"
            preserveAspectRatio="none" aria-hidden="true">${edges}</svg>
          ${layout.positions.map(({ node, x, y, branch }) => `
            <button class="kin-node ${node.id === selectedNodeId ? 'active' : ''}
              ${branch === 'collateral' ? 'collateral' : ''}
              ${nodeIsReferenced(record, node, ruinReferenceIds) ? 'ruin-reference' : ''}"
              style="left:${x}px;top:${y}px"
              data-node-id="${escapeAttribute(node.id)}"
              aria-pressed="${nodeIsReferenced(record, node, ruinReferenceIds)}"
              title="${escapeAttribute(genealogyUnitLabel(record.localView?.units.find(unit => unit.unitType === 'node' && unit.unitId === node.id)))}；右键选择墟境参考">
              <small>${escapeHtml(genealogyRelationText(record.result, node, track))}</small>
              <strong>${escapeHtml(node.name)}</strong>
              <em>${escapeHtml(lifeSpan(node, node.isFocus ? focusCharacter : null, track))}</em>
              ${nodeIsReferenced(record, node, ruinReferenceIds)
                ? '<i class="ruin-reference-mark">墟境参考</i>'
                : ''}
            </button>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderContextMenu(
  record: GenealogyRecord,
  state: GenealogyState,
): string {
  if (!state.contextMenu) return '';
  const node = record.result.nodes.find(item =>
    item.id === state.contextMenu?.nodeId);
  if (!node) return '';
  const referenceId = genealogyNodeReferenceId(record, node.id);
  const included = state.ruinReferences.some(item =>
    ruinCharacterReferenceIdentity(item) === referenceId
    || (!item.referenceId && item.mvuId === node.mvuId));
  const usable = record.localView?.nodes.some(item => item.id === node.id) ?? false;
  return `
    <div class="context-menu-shade" data-close-context-menu></div>
    <div class="genealogy-context-menu" role="menu"
      style="left:${state.contextMenu.x}px;top:${state.contextMenu.y}px">
      <small>${escapeHtml(node.name)}</small>
      <button type="button" role="menuitem" data-toggle-ruin-reference ${usable ? '' : 'disabled'}>
        ${included ? '从墟境重点参考移除' : '加入墟境重点参考'}
      </button>
      ${!usable ? '<small>不属于当前历史版本；原档案仍保留。</small>' : ''}
    </div>
  `;
}

function genealogyNodeReferenceId(
  record: GenealogyRecord,
  nodeId: string,
): string {
  return `genealogy:${record.requestId}:${nodeId}`;
}

function nodeIsReferenced(
  record: GenealogyRecord,
  node: GenealogyNode,
  referenceIds: Set<string>,
): boolean {
  return referenceIds.has(genealogyNodeReferenceId(record, node.id))
    || (!!node.mvuId && referenceIds.has(node.mvuId));
}

function lifeSpan(
  node: GenealogyNode,
  focusCharacter: GenealogyCharacterOption | null = null,
  track: GenealogyFamilyTrack = 'body',
): string {
  if (node.identity) return displayGenealogyDateLabel(genealogyDisplayDates(node, track).label);
  const birth = displayGenealogyDateLabel(node.birth.label);
  const death = node.death.status === 'alive' ? '在世' : displayGenealogyDateLabel(node.death.label);
  if (node.birth.status === 'unknown' && node.isFocus) {
    const age = normalizedAge(focusCharacter?.age);
    if (age) return `现年${age}—${death || '生卒未详'}`;
  }
  if (!birth) return death || '生卒未详';
  return `${birth}—${death || '未详'}`;
}

function normalizedAge(value: string | undefined): string {
  if (!value?.trim()) return '';
  const normalized = value.trim();
  return /岁$/u.test(normalized) ? normalized : `${normalized}岁`;
}

function joinSummary(values: string[] | undefined): string {
  return values?.length ? values.slice(0, 3).join('、') : '未记录';
}

function newestRecordForCharacter(
  records: GenealogyRecord[],
  character: GenealogyCharacterOption,
): GenealogyRecord | null {
  const exact = records.filter(record =>
    record.result.focusCharacterId === character.mvuId);
  const legacy = exact.length
    ? []
    : records.filter(record =>
      !record.result.focusCharacterId
      && normalize(record.result.focusCharacterName) === normalize(character.name));
  return [...exact, ...legacy].reduce<GenealogyRecord | null>(
    (latest, record) => !latest || record.createdAt >= latest.createdAt
      ? record
      : latest,
    null,
  );
}

function initial(value: string | undefined): string {
  return value?.trim().slice(0, 1) || '谱';
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(value.toFixed(2))));
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
