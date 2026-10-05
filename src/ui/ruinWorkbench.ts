import type { WorkbenchStatusDetail } from '../runtime/facade.ts';
import { isTaskBusy } from '../runtime/taskStatus.ts';
import { preserveDomState, ViewRefreshGuard } from './viewRefresh.ts';
import type { RuinRuntimeSnapshot, RuinTaskSnapshot } from '../adapters/host.ts';
import {
  waveForCandidateCount,
} from '../runtime/ruinDice.ts';
import type {
  RuinCandidate,
  RuinGenerationInput,
  RuinNode,
} from '../schemas/ruin.ts';
import { KNOWN_EYON_ERAS } from '../schemas/ruin.ts';
import {
  ruinCandidateState,
  type RuinCandidateRecord,
} from '../storage/ruins.ts';
import {
  ruinCharacterReferenceIdentity,
  type RuinBiographyReference,
  type RuinSelectedCharacter,
} from '../storage/ruinReferences.ts';
import { WorkbenchUiClient } from './workbenchClient.ts';
import { selectAddedRuinReferences } from './ruinReferenceSelection.ts';
import type { RuinTaskReviewSnapshot } from '../workflows/ruinTask.ts';
import type { RuinTaskInterpretation, RuinTaskScale } from '../schemas/ruinTask.ts';
import ruinCss from './ruinWorkbench.css?raw';
import creativeCss from './creativeWorkbench.css?raw';
import { mountButterflyWorkbench } from './butterflyWorkbench.ts';
import { createReferencedRuinMaterials, defaultRuinReferences, randomRuinReferences, RUIN_STYLE_OPTIONS, ruinStyleMeaning, type RuinCreativeReferences } from '../core/creativeReferences.ts';
import type { RuinPlace } from '../core/ruinGeography.ts';
import { availableRuinPanel, canOpenRuinPanel } from '../core/ruinPanelAccess.ts';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import { installScrollPan } from './scrollPan.ts';
import {
  formatRuinNodeExactTime,
  fullRuinStageIntroduction,
} from './ruinPresentation.ts';

export const RUIN_PANELS = ['generation', 'tasks', 'butterfly'] as const;
export type RuinPanelId = typeof RUIN_PANELS[number];
export interface RuinWorkbenchHandle {
  selectPanel(panel: RuinPanelId): void;
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface RuinWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
  onPanelChange?: (panel: RuinPanelId) => void;
}

interface RuinState {
  panel: RuinPanelId;
  generationView: 'compose' | 'read';
  geography: RuinPlace[];
  geoMode: 'select' | 'search' | 'custom';
  geoSearch: string;
  records: RuinCandidateRecord[];
  characters: RuinSelectedCharacter[];
  biographies: RuinBiographyReference[];
  runtime: RuinRuntimeSnapshot;
  selectedCharacterIds: Set<string>;
  activeRecordKey: string;
  activeCandidateId: string;
  selectedNodeId: string;
  draft: RuinDraft;
  busy: boolean;
  entering: boolean;
  taskCreating: boolean;
  taskDirection: string;
  taskInterpretation: RuinTaskInterpretation;
  taskScale: RuinTaskScale;
  taskReview: RuinTaskReviewSnapshot | null;
  status: WorkbenchStatusDetail | null;
  error: string;
  disposed: boolean;
}

interface RuinDraft {
  era: RuinGenerationInput['era'];
  start: DateDraft;
  end: DateDraft;
  location: string;
  supplementaryDirection: string;
  autoGenealogy: boolean;
  candidateCount: 3 | 4 | 5;
  creativeReferences: RuinCreativeReferences;
}

interface DateDraft {
  year: string;
  month: string;
  day: string;
}

const EMPTY_DATE: DateDraft = { year: '', month: '', day: '' };
const CUSTOM_ERA_OPTION = '__custom_era__';

export function mountRuinWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: RuinWorkbenchOptions = {},
): RuinWorkbenchHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const stopScrollPan = installScrollPan(root, '[data-timeline]', 'x');
  root.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
  });
  container.replaceChildren(host);
  const butterflyContainer = document.createElement('div');
  const butterfly = mountButterflyWorkbench(butterflyContainer, client);
  let theme = options.theme ?? 'light';
  const reads = new ViewRefreshGuard(() => client.contextRevision());
  const mutations = new ViewRefreshGuard(() => client.contextRevision());
  const runtimeReads = new ViewRefreshGuard(() => client.contextRevision());
  let configuredLoaded = client.isReady();
  let draftEdited = false;
  let composing = false, deferredRender = false, awaitingNewRecord = false;
  const generationScrollPositions = new Map<RuinState['generationView'], number>();
  const recordReads = new ViewRefreshGuard(() => client.contextRevision());
  const ownsComposition = (event: Event) => {
    const source = event.composedPath()[0];
    return source instanceof Element && source.getRootNode() === root;
  };
  root.addEventListener('compositionstart', event => { if (ownsComposition(event)) composing = true; });
  root.addEventListener('compositionend', event => {
    if (!ownsComposition(event)) return;
    composing = false;
    // 最终 input 事件先写入草稿；后台刷新不能拆下正在组字的输入框。
    setTimeout(() => { if (deferredRender) { deferredRender = false; render(); } }, 0);
  });

  const configured = client.isReady()
    ? client.facade().getSettings().ruinDraft
    : null;
  const state: RuinState = {
    panel: 'generation', generationView: 'compose', geography: [], geoMode: 'select', geoSearch: '',
    records: [],
    characters: [],
    biographies: [],
    runtime: emptyRuinRuntime(),
    selectedCharacterIds: new Set(
      configured?.selectedCharacters.map(ruinCharacterReferenceIdentity) ?? [],
    ),
    activeRecordKey: '',
    activeCandidateId: '',
    selectedNodeId: '',
    draft: configured ? inputToDraft(configured) : {
      era: '复兴纪元',
      start: { ...EMPTY_DATE },
      end: { ...EMPTY_DATE },
      location: '',
      supplementaryDirection: '',
      autoGenealogy: false,
      candidateCount: 3,
      creativeReferences: defaultRuinReferences(),
    },
    busy: false,
    entering: false,
    taskCreating: false,
    taskDirection: '',
    taskInterpretation: '原意锁定',
    taskScale: '即时互动',
    taskReview: null,
    status: null,
    error: '',
    disposed: false,
  };

  const offStatus = client.onStatus(detail => {
    if (detail.taskType && detail.taskType !== 'ruin') return;
    if (detail.phase === 'cancelled') {
      mutations.invalidate(); reads.invalidate(); recordReads.invalidate(); runtimeReads.invalidate();
      state.entering = false; state.taskCreating = false;
    }
    const changed = JSON.stringify([state.status?.status, state.status?.detail, state.status?.progress, state.busy])
      !== JSON.stringify([detail.status, detail.detail, detail.progress, isTaskBusy(detail)]);
    state.status = detail;
    state.busy = isTaskBusy(detail);
    if (detail.phase === 'error') state.error = detail.detail;
    if (changed) render();
    if (['ruin_outlines_ready', 'generating_candidate', 'candidate_ready', 'candidate_failed'].includes(detail.status)) void syncRecords(detail.recordKey);
    if (detail.status === 'ready' || detail.status === 'ruin_task_draft_restored') {
      void refresh();
    }
  });
  const offReady = client.onReady(() => void refresh());
  const offContext = client.onContextChanged(() => {
    mutations.invalidate();
    reads.invalidate(); recordReads.invalidate(); runtimeReads.invalidate();
    awaitingNewRecord = false; composing = false; deferredRender = false;
    state.records = []; state.characters = []; state.biographies = [];
    state.runtime = emptyRuinRuntime(); state.taskReview = null;
    state.activeRecordKey = ''; state.activeCandidateId = ''; state.selectedNodeId = '';
    state.selectedCharacterIds.clear(); state.busy = false; state.entering = false; state.taskCreating = false;
    state.status = null; state.error = ''; configuredLoaded = false; draftEdited = false;
    composing = false; deferredRender = false;
    generationScrollPositions.clear();
    state.panel = 'generation'; state.generationView = 'compose'; state.geography = []; state.geoSearch = ''; state.geoMode = 'select';
    options.onPanelChange?.('generation');
    state.draft = { era: '复兴纪元', start: { ...EMPTY_DATE }, end: { ...EMPTY_DATE }, location: '', supplementaryDirection: '', autoGenealogy: false, candidateCount: 3, creativeReferences: defaultRuinReferences() };
    state.taskDirection = '';
    render();
  });
  const offReferences = client.onRuinReferences(references => {
    selectAddedRuinReferences(state.characters, references, state.selectedCharacterIds);
    state.characters = references;
    persistCharacterSelection();
    render();
  });

  function persistCharacterSelection(): void {
    persistDraft();
  }
  function persistDraft(): void {
    if (!client.isReady() || !state.draft.location.trim()) return;
    const previousError = state.error;
    const input = buildInput(state);
    state.error = previousError;
    if (input) client.facade().setRuinDraft(input);
  }
  function selectPanel(panel: RuinPanelId): void {
    if (!canOpenRuinPanel(state.runtime, panel)) return;
    state.panel = panel;
    render(); options.onPanelChange?.(panel);
    if (panel === 'butterfly') void butterfly.refresh();
  }
  function generationScroller(): HTMLElement | null {
    let current: Node | null = host;
    while (current) {
      if (current instanceof HTMLElement && /auto|scroll/u.test(getComputedStyle(current).overflowY)
        && current.scrollHeight > current.clientHeight) return current;
      current = current.parentNode ?? (current instanceof ShadowRoot ? current.host : null);
    }
    return null;
  }
  function selectGenerationView(view: RuinState['generationView']): void {
    const tabs = root.querySelector<HTMLElement>('.generation-view-tabs');
    const scroller = tabs && getComputedStyle(tabs).display !== 'none' ? generationScroller() : null;
    if (scroller) generationScrollPositions.set(state.generationView, scroller.scrollTop);
    state.generationView = view;
    // 两张卡片留在原位，切页不重建输入框、不丢阅览位置。
    root.querySelector('[data-generation-workspace]')?.setAttribute('data-view', view);
    root.querySelectorAll<HTMLButtonElement>('[data-generation-view]').forEach(tab =>
      tab.setAttribute('aria-pressed', String(tab.dataset.generationView === view)));
    if (scroller) scroller.scrollTop = generationScrollPositions.get(view) ?? 0;
  }
  function selectPlace(id: string): void {
    const place = state.geography.find(item => item.id === id);
    if (id && !place) return;
    draftEdited = true; state.draft.location = place?.path ?? ''; state.geoSearch = '';
    persistDraft(); render();
  }
  function updateGeoResults(): void {
    const results = root.querySelector<HTMLElement>('[data-geo-results]');
    if (!results || composing) return;
    results.innerHTML = renderGeoResults(state);
    bindGeoResults();
  }
  function bindGeoResults(): void {
    root.querySelectorAll<HTMLButtonElement>('[data-geo-result]').forEach(button => button.addEventListener('click', () => selectPlace(button.dataset.geoResult ?? '')));
  }
  function operationIsCurrent(): () => boolean {
    const current = mutations.begin();
    return () => !state.disposed && current();
  }

  function activeRecord(): RuinCandidateRecord | null {
    return state.records.find(item => item.key === state.activeRecordKey)
      ?? state.records[0]
      ?? null;
  }

  function activeCandidate(record: RuinCandidateRecord | null): RuinCandidate | null {
    return record?.result.candidates.find(item =>
      item.id === state.activeCandidateId)
      ?? record?.result.candidates[0]
      ?? null;
  }

  function selectedNode(candidate: RuinCandidate | null): RuinNode | null {
    return candidate?.nodes.find(item => item.id === state.selectedNodeId)
      ?? null;
  }

  async function refresh(): Promise<void> {
    if (state.disposed) return;
    if (!client.isReady()) {
      state.error = '伊雍历史工作台尚未完成初始化';
      render();
      return;
    }
    const current = reads.begin();
    const recordsCurrent = recordReads.begin();
    runtimeReads.invalidate();
    if (!configuredLoaded) {
      const draft = client.facade().getSettings().ruinDraft;
      if (draft && !draftEdited) {
        state.draft = inputToDraft(draft);
        state.selectedCharacterIds = new Set(draft.selectedCharacters.map(ruinCharacterReferenceIdentity));
      }
      configuredLoaded = true;
    }
    state.error = '';
    render();
    try {
      const [records, references, biographies, runtime, taskReview, geography] = await Promise.all([
        client.facade().listRuins(),
        client.listRuinCharacterReferences(),
        client.listRuinBiographyReferences(),
        client.getRuinRuntimeSnapshot(),
        client.getRuinTaskReview(),
        client.facade().getRuinGeography(),
      ]);
      if (!current()) return;
      runtimeReads.invalidate();
      if (recordsCurrent()) state.records = [...records].sort((left, right) => right.createdAt - left.createdAt);
      state.characters = references;
      state.biographies = biographies;
      state.runtime = runtime;
      state.geography = geography;
      reconcilePanelAccess();
      if (!(state.taskReview?.phase === 'review' && taskReview?.phase === 'review' && state.taskReview.runId === taskReview.runId)) state.taskReview = taskReview;
      // 普通刷新只读取候选池，不能把玩家关闭的旧引用再次勾回。
      if (!state.records.some(item => item.key === state.activeRecordKey)) {
        state.activeRecordKey = state.records[0]?.key ?? '';
      }
      const record = activeRecord();
      if (!record?.result.candidates.some(item =>
        item.id === state.activeCandidateId)) {
        state.activeCandidateId = record?.result.candidates[0]?.id ?? '';
      }
      if (!activeCandidate(record)?.nodes.some(node => node.id === state.selectedNodeId)) state.selectedNodeId = '';
    } catch (error) {
      if (!current()) return;
      state.error = errorMessage(error);
    } finally {
      if (current()) render();
    }
  }

  async function refreshRuntime(): Promise<void> {
    if (state.disposed || !client.isReady()) return;
    const current = runtimeReads.begin();
    try {
      const [runtime, review] = await Promise.all([
        client.getRuinRuntimeSnapshot(),
        client.getRuinTaskReview(),
      ]);
      if (!current()) return;
      state.runtime = runtime; state.taskReview = review;
      reconcilePanelAccess();
      render();
    } catch {
      // 完整刷新会报告持久错误；状态事件后的轻量刷新保持安静。
    }
  }

  async function syncRecords(preferredRecordKey?: string): Promise<void> {
    if (state.disposed || !client.isReady()) return;
    const current = recordReads.begin();
    try {
      const records = await client.facade().listRuins();
      if (!current()) return;
      state.records = [...records].sort((left, right) =>
        right.createdAt - left.createdAt);
      // 增量同步只更新资料，不夺走用户当前正在阅读的旧记录。
      // 新任务完成后 generate() 会显式切到新记录；生成途中浏览选择始终归 UI 所有。
      // 玩家点击新生成后，大纲落库立即切入一次；其后增量同步不抢走手动浏览选择。
      if (awaitingNewRecord && preferredRecordKey && state.records.some(item => item.key === preferredRecordKey)) {
        state.activeRecordKey = preferredRecordKey; state.activeCandidateId = ''; state.selectedNodeId = '';
        awaitingNewRecord = false;
      }
      if (!state.records.some(item => item.key === state.activeRecordKey)) {
        state.activeRecordKey = state.records[0]?.key ?? '';
      }
      const record = activeRecord();
      if (!record?.result.candidates.some(item =>
        item.id === state.activeCandidateId)) {
        state.activeCandidateId = record?.result.candidates[0]?.id ?? '';
      }
      render();
    } catch {
      // The full refresh path reports persistent storage errors.
    }
  }

  /**
   * 新建任务：一键清空上次任务的输入草稿与重点参考人物勾选（污染源），干净开始。
   * 草稿持久化同步清空（setRuinDraft(null)），重开页面也不会再恢复旧输入。
   * 引用人物候选池（state.characters）保留——它们只是候选，不自动勾选。
   */
  function resetTask(): void {
    if (!canOpenRuinPanel(state.runtime, 'generation')) return;
    draftEdited = true;
    state.draft = {
      era: '复兴纪元',
      start: { ...EMPTY_DATE },
      end: { ...EMPTY_DATE },
      location: '',
      supplementaryDirection: '',
      autoGenealogy: false,
      candidateCount: 3,
      creativeReferences: defaultRuinReferences(),
    };
    state.selectedCharacterIds.clear();
    state.geoSearch = ''; state.geoMode = 'select';
    state.generationView = 'compose';
    state.error = '';
    state.status = null;
    if (client.isReady()) {
      client.facade().setRuinDraft(null);
    }
    render();
  }

  async function generate(): Promise<void> {
    if (!canOpenRuinPanel(state.runtime, 'generation')) return;
    if (state.busy || state.entering) return;
    state.error = '';
    const input = buildInput(state);
    if (!input) {
      render();
      return;
    }
    state.busy = true;
    selectGenerationView('read');
    awaitingNewRecord = true;
    reads.invalidate();
    const current = operationIsCurrent();
    state.status = {
      status: 'generating_candidates',
      detail: '伊雍正在编织并校订全部候选史稿',
    };
    render();
    try {
      client.facade().setRuinDraft(input);
      const record = await client.facade().generateRuin(input);
      if (!current()) return;
      reads.invalidate();
      recordReads.invalidate();
      state.records = [
        record,
        ...state.records.filter(item => item.key !== record.key),
      ];
      if (awaitingNewRecord) {
        state.activeRecordKey = record.key;
        state.activeCandidateId = record.result.candidates[0]?.id ?? '';
        state.selectedNodeId = '';
      }
      const ready = record.result.candidates.filter(candidate => ruinCandidateState(record, candidate.id).status === 'ready').length;
      state.status = { status: 'ready', detail: `候选史稿已完成 ${ready}/${record.result.candidates.length}${ready < record.result.candidates.length ? '，其余可单独重试' : '，可以比较后选择'}` };
    } catch (error) {
      if (!current()) return;
      state.error = '墟境生成未完成，技术详情已保存到设置中的错误日志。';
      state.status = { status: 'failed', detail: state.error };
    } finally {
      if (current()) { state.busy = false; awaitingNewRecord = false; render(); }
    }
  }

  async function enter(): Promise<void> {
    if (!canOpenRuinPanel(state.runtime, 'generation')) return;
    let record = activeRecord();
    let candidate = activeCandidate(record);
    let node = selectedNode(candidate);
    // 容错 1:selectedNodeId 属于非活动候选时,自动切换到所属候选
    // (候选错位会发生在异步刷新替换 records 之后,selectedNodeId 仍指向旧候选的节点)
    if (!node && state.selectedNodeId && record) {
      const owner = record.result.candidates.find(item =>
        item.nodes.some(itemNode => itemNode.id === state.selectedNodeId));
      if (owner) {
        state.activeCandidateId = owner.id;
        candidate = owner;
        node = selectedNode(candidate);
      }
    }
    // 容错 2:selectedNodeId 为空/丢失时,自动选中当前候选的第一个历史阶段。
    if (!node && candidate) {
      const fallback = candidate.nodes[0];
      if (fallback) {
        state.selectedNodeId = fallback.id;
        node = fallback;
      }
    }
    // 诊断日志:无论守卫结果如何都留下痕迹,便于定位「点击无反应」
    console.log('[Eyon History Workbench] ruin enter clicked', {
      hasRecord: Boolean(record),
      hasCandidate: Boolean(candidate),
      selectedNodeId: state.selectedNodeId,
      activeCandidateId: state.activeCandidateId,
      candidateNodeIds: candidate?.nodes.map(itemNode => itemNode.id),
      nodeKind: node?.kind,
      nodeEnterable: node?.enterable,
      busy: state.busy,
      entering: state.entering,
    });
    if (state.entering) return;
    if (state.busy) {
      state.error = '墟境任务仍在进行中，请等待完成后再进入';
      render();
      return;
    }
    if (!record || !candidate || !node) {
      state.error = state.selectedNodeId
        ? `当前节点不可进入：历史阶段不存在（${state.selectedNodeId}）`
        : '当前节点不可进入：请先在时间线上选择缘起、经过、高潮或结果';
      render();
      return;
    }
    const current = operationIsCurrent();
    state.entering = true;
    state.error = '';
    state.status = {
      status: 'entering_ruin',
      detail: '伊雍正在开启历史切口',
    };
    render();
    try {
      await client.facade().enterRuin(record.key, candidate.id, node.id);
      if (!current()) return;
      state.status = {
        status: 'ready',
        detail: '进入指令已发送，伊雍正在开启历史切口',
      };
    } catch (error) {
      if (!current()) return;
      state.error = errorMessage(error);
      state.status = { status: 'failed', detail: state.error };
    } finally {
      if (current()) { state.entering = false; render(); }
    }
  }

  async function createRuinTaskDraft(): Promise<void> {
    if (!canOpenRuinPanel(state.runtime, 'tasks')) return;
    if (state.taskCreating || state.busy || state.entering) return;
    const current = operationIsCurrent();
    const direction = state.taskDirection.trim();
    if (!direction) {
      state.error = '请先写下想做的事情';
      render();
      return;
    }
    state.taskCreating = true;
    reads.invalidate(); runtimeReads.invalidate();
    state.error = '';
    render();
    try {
      const review = await client.generateRuinTaskDraft({
        direction,
        interpretation: state.taskInterpretation,
        scale: state.taskScale,
      });
      if (current()) { reads.invalidate(); runtimeReads.invalidate(); state.taskReview = review; }
    } catch (error) {
      if (!current()) return;
      state.error = errorMessage(error);
    } finally {
      if (current()) { state.taskCreating = false; render(); }
    }
  }

  async function confirmRuinTaskDraft(): Promise<void> {
    if (!canOpenRuinPanel(state.runtime, 'tasks')) return;
    if (state.taskCreating || !state.taskReview || state.taskReview.phase !== 'review') return;
    const current = operationIsCurrent();
    reads.invalidate(); runtimeReads.invalidate();
    state.taskCreating = true;
    state.error = '';
    render();
    try {
      state.taskReview = client.updateRuinTaskDraft({
        title: state.taskReview.task.title,
        detail: state.taskReview.task.detail,
        objective: state.taskReview.task.objective,
      });
      const review = await client.confirmRuinTaskDraft();
      if (current()) { reads.invalidate(); runtimeReads.invalidate(); state.taskReview = review; }
    } catch (error) {
      if (!current()) return;
      state.error = errorMessage(error);
    } finally {
      if (current()) { state.taskCreating = false; render(); }
    }
  }

  async function retryCandidate(): Promise<void> {
    if (!canOpenRuinPanel(state.runtime, 'generation')) return;
    const record = activeRecord();
    const candidate = activeCandidate(record);
    if (!record || !candidate || state.busy || state.entering) return;
    const current = operationIsCurrent();
    reads.invalidate();
    state.busy = true;
    state.error = '';
    state.status = {
      status: 'retrying_candidate',
      detail: '伊雍正在重新整理这段史稿',
    };
    render();
    try {
      const next = await client.retryRuinCandidate(record.key, candidate.id);
      if (!current()) return;
      reads.invalidate();
      state.records = state.records.map(item => item.key === next.key ? next : item);
      state.status = { status: 'ready', detail: '这段墟境史稿已经补全' };
    } catch {
      if (!current()) return;
      state.error = '这段史稿仍未完成，技术详情已保存到错误日志。';
      state.status = { status: 'failed', detail: state.error };
      await syncRecords();
    } finally {
      if (current()) { state.busy = false; render(); }
    }
  }

  function reconcilePanelAccess(): void {
    const next = availableRuinPanel(state.runtime, state.panel);
    if (next === state.panel) return;
    state.panel = next;
    options.onPanelChange?.(next);
  }

  function render(): void {
    if (state.disposed) return;
    if (composing) { deferredRender = true; return; }
    reconcilePanelAccess();
    // 控制台自管其状态。后台刷新不能拆下同一个控制台节点，打断正在输入或拖动的手势。
    if (state.panel === 'butterfly' && root.querySelector<HTMLElement>('[data-butterfly-panel]')?.hidden === false) return;
    const restore = preserveDomState(root);
    const record = activeRecord();
    const candidate = activeCandidate(record);
    const node = selectedNode(candidate);
    const previousTimeline = root.querySelector<HTMLElement>('[data-timeline]');
    const scrollLeft = previousTimeline?.scrollLeft ?? 0;

    root.innerHTML = `
      <style>${ruinCss}\n${creativeCss}</style>
      <main class="ruin-app ${options.embedded ? 'ruin-embedded' : ''}" data-theme="${theme}">
        <nav class="ruin-subtabs ${options.embedded ? 'embedded-subtabs' : ''}" aria-label="墟境探索子模块">
          ${RUIN_PANELS.map(panel => `<button type="button" data-ruin-panel="${panel}" aria-current="${state.panel === panel ? 'page' : 'false'}" ${!canOpenRuinPanel(state.runtime, panel) ? `disabled title="${panel === 'generation' ? '遣返现世后解锁' : '进入墟境后解锁'}"` : ''}>${{ generation: '墟境生成', tasks: '墟境任务', butterfly: '蝴蝶效应' }[panel]}</button>`).join('')}
        </nav>
        <section class="ruin-subpanel" ${state.panel !== 'generation' ? 'hidden' : ''}>
        ${canOpenRuinPanel(state.runtime, 'generation')
          ? renderGenerationWorkspace(state, record, candidate, node)
          : `<div class="ruin-panel-lock" role="status"><strong>墟境生成已锁定</strong><p>当前仍在墟境内。请在蝴蝶效应工作台遣返现世，再开启新的历史。</p></div>`}
        </section>
        <section class="ruin-subpanel" ${state.panel !== 'tasks' ? 'hidden' : ''}>${renderRuinTaskModule(state)}</section>
        <section class="ruin-subpanel" data-butterfly-panel ${state.panel !== 'butterfly' ? 'hidden' : ''}></section>
      </main>`;
    root.querySelector('[data-butterfly-panel]')?.append(butterflyContainer);
    bind();
    restore();
    const timeline = root.querySelector<HTMLElement>('[data-timeline]');
    if (timeline) timeline.scrollLeft = scrollLeft;
  }

  function bind(): void {
    root.querySelectorAll<HTMLButtonElement>('[data-generation-view]').forEach(button => button.addEventListener('click', () => {
      selectGenerationView(button.dataset.generationView as RuinState['generationView']);
    }));
    root.querySelectorAll<HTMLButtonElement>('[data-ruin-panel]').forEach(button => button.addEventListener('click', () => selectPanel(button.dataset.ruinPanel as RuinPanelId)));
    root.querySelectorAll<HTMLSelectElement>('[data-ruin-style]').forEach(select => select.addEventListener('change', () => {
      const key = select.dataset.ruinStyle as 'telling' | 'pace' | 'mood';
      Object.assign(state.draft.creativeReferences, { [key]: select.value });
      const help = root.querySelector<HTMLElement>(`[data-style-help="${key}"]`);
      if (help) help.textContent = ruinStyleMeaning(key, select.value);
      persistDraft();
    }));
    root.querySelectorAll<HTMLSelectElement>('[data-period-index]').forEach(select => select.addEventListener('change', () => {
      state.draft.creativeReferences.periods[Number(select.dataset.periodIndex)] = select.value as RuinCandidate['periodType'];
      persistDraft();
    }));
    root.querySelector('[data-random-style]')?.addEventListener('click', () => {
      draftEdited = true; state.draft.creativeReferences = randomRuinReferences(state.draft.candidateCount); persistDraft(); render();
    });
    root.querySelectorAll<HTMLButtonElement>('[data-geo-mode]').forEach(button => button.addEventListener('click', () => {
      state.geoMode = button.dataset.geoMode as RuinState['geoMode']; render();
    }));
    const search = root.querySelector<HTMLInputElement>('[data-geo-search]');
    search?.addEventListener('input', () => { state.geoSearch = search.value; updateGeoResults(); });
    search?.addEventListener('compositionend', () => { state.geoSearch = search.value; setTimeout(updateGeoResults, 0); });
    root.querySelectorAll<HTMLSelectElement>('[data-geo-level]').forEach(select => select.addEventListener('change', () => selectPlace(select.value)));
    root.querySelectorAll<HTMLButtonElement>('[data-geo-ancestor]').forEach(button => button.addEventListener('click', () => selectPlace(button.dataset.geoAncestor ?? '')));
    bindGeoResults();
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[data-direction], [data-location], [data-date], [data-era], [data-custom-era], [data-auto-genealogy]')
      .forEach(input => input.addEventListener('change', () => persistDraft()));
    root.querySelectorAll('input, textarea, select').forEach(input => input.addEventListener('input', () => { draftEdited = true; }));
    root.querySelector<HTMLInputElement>('[data-auto-genealogy]')
      ?.addEventListener('change', event => {
        state.draft.autoGenealogy = (event.currentTarget as HTMLInputElement).checked;
        if (client.isReady()) {
          const draft = client.facade().getSettings().ruinDraft;
          if (draft) client.facade().setRuinDraft({ ...draft, autoGenealogy: state.draft.autoGenealogy });
        }
      });
    root.querySelector<HTMLSelectElement>('[data-era]')
      ?.addEventListener('change', event => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        state.draft.era = value === CUSTOM_ERA_OPTION ? '' : value;
        render();
      });
    root.querySelector<HTMLInputElement>('[data-custom-era]')
      ?.addEventListener('input', event => {
        state.draft.era = (event.currentTarget as HTMLInputElement).value;
      });
    root.querySelectorAll<HTMLInputElement>('[data-date]').forEach(input => {
      input.addEventListener('input', () => {
        const [side, part] = (input.dataset.date ?? '').split('.') as [
          'start' | 'end',
          keyof DateDraft,
        ];
        if (side && part) state.draft[side][part] = input.value;
      });
    });
    root.querySelector<HTMLInputElement>('[data-location]')
      ?.addEventListener('input', event => {
        const input = event.currentTarget as HTMLInputElement;
        state.draft.location = input.value;
        input.closest('.field')?.classList.remove('invalid');
      });
    root.querySelector<HTMLTextAreaElement>('[data-direction]')
      ?.addEventListener('input', event => {
        state.draft.supplementaryDirection =
          (event.currentTarget as HTMLTextAreaElement).value;
      });
    root.querySelectorAll<HTMLButtonElement>('[data-count]').forEach(button => {
      button.addEventListener('click', () => {
        state.draft.candidateCount = Number(button.dataset.count) as 3 | 4 | 5;
        while (state.draft.creativeReferences.periods.length < state.draft.candidateCount) state.draft.creativeReferences.periods.push('stable');
        persistDraft();
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-character-id]')
      .forEach(button => {
        button.addEventListener('click', () => {
          const id = button.dataset.characterId ?? '';
          if (state.selectedCharacterIds.has(id)) {
            state.selectedCharacterIds.delete(id);
          } else {
            state.selectedCharacterIds.add(id);
          }
          persistCharacterSelection();
          render();
        });
      });
    root.querySelectorAll<HTMLButtonElement>('[data-remove-character-id]')
      .forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const id = button.dataset.removeCharacterId ?? '';
          if (!id) return;
          state.characters = state.characters.filter(character =>
            ruinCharacterReferenceIdentity(character) !== id);
          state.selectedCharacterIds.delete(id);
          persistCharacterSelection();
          render();
          void client.removeRuinCharacterReference(id).catch(error => {
            state.error = errorMessage(error);
            void refresh();
          });
        });
      });
    root.querySelectorAll<HTMLButtonElement>('[data-remove-biography-reference]')
      .forEach(button => {
        button.addEventListener('click', event => {
          event.stopPropagation();
          const id = button.dataset.removeBiographyReference ?? '';
          if (!id) return;
          state.biographies = state.biographies.filter(item => item.referenceId !== id);
          render();
          void client.removeRuinBiographyReference(id).catch(error => {
            state.error = errorMessage(error);
            void refresh();
          });
        });
      });
    root.querySelector('[data-generate]')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void generate();
    });
    root.querySelector('[data-new-task]')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      resetTask();
    });
    root.querySelector('[data-refresh]')?.addEventListener('click', () => {
      void refresh();
    });
    root.querySelector<HTMLSelectElement>('[data-record-selector]')
      ?.addEventListener('change', event => {
        state.activeRecordKey = (event.currentTarget as HTMLSelectElement).value;
        const record = activeRecord();
        state.activeCandidateId = record?.result.candidates[0]?.id ?? '';
        state.selectedNodeId = '';
        render();
      });
    root.querySelectorAll<HTMLButtonElement>('[data-candidate-tab-id]')
      .forEach(button => {
        button.addEventListener('click', () => {
          state.activeCandidateId = button.dataset.candidateTabId ?? '';
          state.selectedNodeId = '';
          render();
        });
      });
    root.querySelectorAll<HTMLButtonElement>('[data-timeline-scroll]').forEach(button => {
      button.addEventListener('click', () => {
        const timeline = root.querySelector<HTMLElement>('[data-timeline]');
        timeline?.scrollBy({
          left: Number(button.dataset.timelineScroll) * timeline.clientWidth * 0.8,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-node-id]').forEach(button => {
      button.addEventListener('click', () => {
        // 同步所属候选:防止异步刷新替换 records 后 activeCandidateId 与节点错位
        const ownerCandidateId = button.dataset.candidateId;
        if (ownerCandidateId) state.activeCandidateId = ownerCandidateId;
        state.selectedNodeId = button.dataset.nodeId ?? '';
        console.log('[Eyon History Workbench] ruin node selected', {
          nodeId: state.selectedNodeId,
          candidateId: ownerCandidateId,
        });
        render();
      });
    });
    root.querySelector('[data-enter]')?.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void enter();
    });
    root.querySelector('[data-retry-candidate]')?.addEventListener('click', () => {
      void retryCandidate();
    });
    root.querySelector<HTMLTextAreaElement>('[data-ruin-task-direction]')
      ?.addEventListener('input', event => {
        state.taskDirection = (event.currentTarget as HTMLTextAreaElement).value;
      });
    root.querySelectorAll<HTMLButtonElement>('[data-task-interpretation]').forEach(button => {
      button.addEventListener('click', () => {
        state.taskInterpretation = button.dataset.taskInterpretation as RuinTaskInterpretation;
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-task-scale]').forEach(button => {
      button.addEventListener('click', () => {
        state.taskScale = button.dataset.taskScale as RuinTaskScale;
        render();
      });
    });
    bindTaskDraftField(root, '[data-task-title]', value => {
      if (state.taskReview) state.taskReview.task.title = value;
    });
    bindTaskDraftField(root, '[data-task-detail]', value => {
      if (state.taskReview) state.taskReview.task.detail = value;
    });
    bindTaskDraftField(root, '[data-task-objective]', value => {
      if (state.taskReview) state.taskReview.task.objective = value;
    });
    root.querySelector('[data-create-ruin-task]')?.addEventListener('click', () => {
      void createRuinTaskDraft();
    });
    root.querySelector('[data-confirm-ruin-task]')?.addEventListener('click', () => {
      void confirmRuinTaskDraft();
    });
  }

  render();
  void refresh();

  return {
    selectPanel,
    refresh,
    setTheme(nextTheme) {
      theme = nextTheme;
      root.querySelector<HTMLElement>('.ruin-app')
        ?.setAttribute('data-theme', nextTheme);
      butterfly.setAppearance({ mode: nextTheme, accent: 'jade', text: 'neutral' });
    },
    setAppearance(appearance) {
      theme = appearance.mode;
      applyAppearance(host, appearance);
      root.querySelector<HTMLElement>('.ruin-app')
        ?.setAttribute('data-theme', appearance.mode);
      butterfly.setAppearance(appearance);
    },
    dispose() {
      mutations.dispose();
      state.disposed = true;
      reads.dispose(); recordReads.dispose(); runtimeReads.dispose(); offContext();
      stopScrollPan();
      offStatus();
      offReady();
      offReferences();
      butterfly.dispose();
      container.replaceChildren();
    },
  };
}

function renderRuinTaskModule(state: RuinState): string {
  if (state.runtime.flowState !== 'exploring' && state.runtime.flowState !== 'anchored') {
    return '';
  }
  const tasks = state.runtime.ruinTasks ?? [];
  const active = tasks.find(task => !task.terminal) ?? null;
  const latestTerminal = [...tasks].reverse().find(task => task.terminal) ?? null;
  const task = active ?? latestTerminal;
  const review = state.taskReview;
  return `
    <section class="ruin-task-section" aria-labelledby="ruin-task-heading">
      <header class="ruin-task-header">
        <div>
          <span class="ruin-task-kicker">IN THE RUIN</span>
          <h2 id="ruin-task-heading">墟境任务</h2>
          <p>${active
            ? '当前目标已经写入任务栏；完成前不会同时建立第二项。'
            : review?.phase === 'review'
              ? '草案尚未进入正文。你可以直接改写名称、详情和目标，再决定是否封缄。'
              : review?.phase === 'staged'
                ? '确认语句已写入酒馆输入框。你可以补充本轮行动，再亲自发送；当前尚未创建楼层。'
              : review
                ? '任务已经封缄。重抽正文仍会复用同一文本；删除确认玩家楼后才会解封。'
                : '把此刻想做的事情告诉伊雍；简单玩闹也会保持简单。'}</p>
        </div>
        <span class="ruin-task-run">${escapeHtml(state.runtime.ruinTime || '时序未明')}</span>
      </header>
      <div class="ruin-task-body">
        ${active ? renderRuinTaskSummary(active, true) : review
          ? renderRuinTaskReview(review, state.taskCreating)
          : task ? renderRuinTaskSummary(task, false) : `
          <div class="ruin-task-empty">这轮墟境尚无任务。观察现场后，再决定值得介入的目标。</div>`}
        ${active || review && review.phase !== 'review' ? '' : `
          <div class="ruin-task-composer">
          <label class="ruin-task-compose">
            <span>你想做什么</span>
            <textarea data-ruin-task-direction maxlength="240"
              placeholder="例如：敲一下两人的脑袋。也可以写一项认真调查。"
              ${state.taskCreating ? 'disabled' : ''}>${escapeHtml(state.taskDirection)}</textarea>
          </label>
          ${renderTaskChoice('演绎权限', 'task-interpretation', [
            ['原意锁定', '只完成你写下的动作，不替你补目的'],
            ['情境补全', '补足现场阻碍，但不改变目标性质'],
            ['自由演绎', '允许沿已有证据加入波折'],
          ], state.taskInterpretation)}
          ${renderTaskChoice('任务规模', 'task-scale', [
            ['即时互动', '一两个当场动作即可完成'],
            ['短程目标', '当前地点或相邻场景完成'],
            ['阶段任务', '允许跨多个场景逐步推进'],
          ], state.taskScale)}
          <button type="button" class="ruin-task-create" data-create-ruin-task
            ${state.taskCreating ? 'disabled' : ''}>
            ${state.taskCreating ? '伊雍正在拟定草案…' : review ? '重新拟定' : '拟定任务草案'}
          </button>
          </div>`}
      </div>
    </section>`;
}

function renderTaskChoice(
  label: string,
  dataName: 'task-interpretation' | 'task-scale',
  choices: Array<[string, string]>,
  selected: string,
): string {
  return `
    <fieldset class="ruin-task-choice">
      <legend>${escapeHtml(label)}</legend>
      <div>
        ${choices.map(([value, hint]) => `
          <button type="button" data-${dataName}="${escapeAttribute(value)}"
            class="${value === selected ? 'selected' : ''}"
            aria-pressed="${value === selected ? 'true' : 'false'}">
            <b>${escapeHtml(value)}</b><small>${escapeHtml(hint)}</small>
          </button>`).join('')}
      </div>
    </fieldset>`;
}

function renderRuinTaskReview(review: RuinTaskReviewSnapshot, busy: boolean): string {
  const sealed = review.phase !== 'review';
  return `
    <article class="ruin-task-draft ${sealed ? 'is-sealed' : ''}">
      <div class="ruin-task-draft-head">
        <span class="ruin-task-rank">${escapeHtml(review.task.difficulty)}</span>
        <div><small>${review.phase === 'staged' ? 'AWAITING YOUR WORDS' : sealed ? 'SEALED COMMISSION' : 'COMMISSION DRAFT'}</small>
          <strong>${review.phase === 'staged' ? '等待你亲自发送' : sealed ? '已封缄' : '待你核准'}</strong></div>
        <b>${escapeHtml(review.task.mode)}</b>
      </div>
      <label><span>任务</span><input data-task-title maxlength="28"
        value="${escapeAttribute(review.task.title)}" ${sealed || busy ? 'disabled' : ''}></label>
      <label><span>委托人</span><input value="伊雍" disabled></label>
      <label><span>详情</span><textarea data-task-detail maxlength="360"
        ${sealed || busy ? 'disabled' : ''}>${escapeHtml(review.task.detail)}</textarea></label>
      <label><span>目标</span><textarea data-task-objective maxlength="280"
        ${sealed || busy ? 'disabled' : ''}>${escapeHtml(review.task.objective)}</textarea></label>
      <div class="ruin-task-reward"><span>奖励</span><p>${escapeHtml(review.task.reward)}</p></div>
      ${sealed ? `
        <p class="ruin-task-seal-note">${review.phase === 'staged'
          ? '确认语句已进入酒馆输入框，但还没有创建楼层。补充你想亲自做的事，再按发送；模型不得替你行动。'
          : '此任务已与确认玩家楼绑定。删除助手回复并重抽不会改变任务；删除确认玩家楼后才会恢复编辑。'}</p>` : `
        <button type="button" class="ruin-task-confirm" data-confirm-ruin-task ${busy ? 'disabled' : ''}>
          ${busy ? '正在写入…' : '写入输入框，待我发送'}
        </button>`}
    </article>`;
}

function renderRuinTaskSummary(task: RuinTaskSnapshot, active: boolean): string {
  return `
    <article class="ruin-task-card ${active ? 'is-active' : 'is-terminal'}">
      <div class="ruin-task-card-title">
        <span>${escapeHtml(task.mode)}</span>
        <h3>${escapeHtml(task.name.replace(/^\[墟境任务[·・](?:个人|团队)\]/u, ''))}</h3>
        <b>${escapeHtml(task.status || (active ? '进行中' : '已结束'))}</b>
      </div>
      <p class="ruin-task-progress">${escapeHtml(task.progress || '等待现场推进')}</p>
      <dl>
        <div><dt>目标</dt><dd>${escapeHtml(task.objective || '尚未写明')}</dd></div>
        <div><dt>详情</dt><dd>${escapeHtml(task.detail || '尚未写明')}</dd></div>
        <div><dt>奖励</dt><dd>${escapeHtml(task.reward || '尚未写明')}</dd></div>
      </dl>
    </article>`;
}

function bindTaskDraftField(
  root: ShadowRoot,
  selector: string,
  assign: (value: string) => void,
): void {
  root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
    ?.addEventListener('input', event => {
      assign((event.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
    });
}

function emptyRuinRuntime(): RuinRuntimeSnapshot {
  return {
    flowState: 'idle',
    runId: '',
    realityTime: '',
    realityLocation: '',
    ruinTime: '',
    ruinLocation: '',
    ruinTasks: [],
  };
}

function renderRecordSelector(records: RuinCandidateRecord[], activeKey: string): string {
  if (records.length === 0) return '';
  return `
    <label class="history-selector">
      <span>历史任务</span>
      <select data-record-selector aria-label="切换已生成的墟境任务">
        ${records.map(record => `
          <option value="${escapeAttribute(record.key)}"
            ${record.key === activeKey ? 'selected' : ''}>
            ${escapeHtml(recordLabel(record))}
          </option>`).join('')}
      </select>
    </label>`;
}

function recordLabel(record: RuinCandidateRecord): string {
  const created = new Date(record.createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const subject = record.input.location.trim()
    || record.input.supplementaryDirection.trim()
    || record.result.era;
  const compact = subject.length > 24 ? `${subject.slice(0, 24)}…` : subject;
  const generating = record.result.candidates.some(candidate =>
    ruinCandidateState(record, candidate.id).status === 'generating');
  return `${generating ? '生成中 · ' : ''}${created} · ${compact}`;
}

function renderGenerationWorkspace(
  state: RuinState,
  record: RuinCandidateRecord | null,
  candidate: RuinCandidate | null,
  node: RuinNode | null,
): string {
  return `<div class="generation-workspace" data-generation-workspace data-view="${state.generationView}">
    <nav class="generation-view-tabs" aria-label="编排与阅览">
      <button type="button" data-generation-view="compose" aria-pressed="${state.generationView === 'compose'}" aria-controls="ruin-compose-card">编排历史</button>
      <button type="button" data-generation-view="read" aria-pressed="${state.generationView === 'read'}" aria-controls="ruin-read-card">阅览史稿</button>
    </nav>
    <div class="generator-layout">
      ${renderForm(state)}
      <section class="timeline-panel generation-reader" id="ruin-read-card" aria-label="阅览史稿">
        <header class="generation-card-heading"><span>READ</span><h2>阅览史稿</h2><small>${record ? `${record.result.candidates.filter(item => ruinCandidateState(record, item.id).status === 'ready').length}/${record.result.candidates.length} 篇就绪` : '等待编织'}</small></header>
        <div data-generation-status aria-live="polite">${renderWorkingState(state)}</div>
        <div class="history-canvas-tools">
          ${renderRecordSelector(state.records, state.activeRecordKey)}
          <button type="button" class="icon-button" data-refresh title="重新读取当前资料" aria-label="刷新史稿">↻</button>
        </div>
        ${record && candidate ? renderCandidates(record, candidate, node, state) : renderEmptyState(state.busy)}
      </section>
    </div>
  </div>`;
}

function renderForm(state: RuinState): string {
  return `
    <section class="section form-section ruin-composer" id="ruin-compose-card" aria-label="编排一段历史">
      <header class="generation-card-heading"><span>COMPOSE</span><h2>编排历史</h2></header>
      <div class="section-body composer-grid">
        <section class="composer-card scope-card">
        <header class="composer-heading"><span>01</span><h3>历史舞台</h3></header>
        <div class="scope-fields">
        <label class="field">
          <strong>所属纪元</strong>
          <select data-era ${state.busy ? 'disabled' : ''}>
            ${KNOWN_EYON_ERAS
              .map(era => `<option ${era === state.draft.era ? 'selected' : ''}>${era}</option>`)
              .join('')}
            <option value="${CUSTOM_ERA_OPTION}" ${isCustomEra(state.draft.era) ? 'selected' : ''}>自定义…</option>
          </select>
        </label>
        ${isCustomEra(state.draft.era)
          ? `<label class="field custom-era-field">
              <strong>纪年名称</strong>
              <input data-custom-era value="${escapeAttribute(state.draft.era)}"
                placeholder="例如：星辉历"
                ${state.busy ? 'disabled' : ''}>
              <span class="field-note">使用世界书中的纪年名称。</span>
            </label>`
          : ''}
        <div class="field geography-field ${state.error === '必须填写地点，才能生成墟境' ? 'invalid' : ''}">
          <strong>地点范围（必填）</strong>
          ${renderGeographyPicker(state)}
          ${state.geoMode === 'custom' || !state.geography.length ? `<input data-location value="${escapeAttribute(state.draft.location)}"
            aria-label="地点范围，可自由修改"
            placeholder="输入区域、城市、建筑或前文出现的小地点"
            ${state.busy ? 'disabled' : ''}>` : state.geoMode === 'select' && state.draft.location ? '' : `<p class="geo-current-path">${state.draft.location ? escapeHtml(state.draft.location.split('-').join(' › ')) : '尚未选择地点'}</p>`}
          <span class="field-note">可停在任意地点层级。</span>
          <span class="field-error">必须填写地点，才能检索并生成墟境。</span>
        </div>
        <div class="composer-dates">
          <div class="date-range-heading"><strong>时间范围（可选）</strong><span>留空由史料确定</span></div>
          <div class="date-range-grid">
            ${renderDateGroup('start', '起始', state.draft.start, state.busy)}
            ${renderDateGroup('end', '结束', state.draft.end, state.busy)}
          </div>
        </div>
        </div></section>
        <section class="composer-card direction-card">
          <header class="composer-heading"><span>02</span><h3>探索对象</h3></header>
          <label class="field"><strong>参考方向（可选）</strong>
            <textarea data-direction ${state.busy ? 'disabled' : ''}
              placeholder="例如：女皇在卧室阅读《勇者丝特拉》时的趣闻">${escapeHtml(state.draft.supplementaryDirection)}</textarea>
          </label>
          <div class="reference-columns">
        <div class="field">
          <div class="reference-field-heading">
            <strong>重点参考人物（可选）</strong>
            <label class="genealogy-policy-toggle" title="自动关联宗族人物；默认关闭，仅关联有当地活动依据的人物">
              <input type="checkbox" role="switch" aria-label="自动关联宗族人物"
                data-auto-genealogy ${state.draft.autoGenealogy ? 'checked' : ''}
                ${state.busy ? 'disabled' : ''}>
              <span class="genealogy-policy-track" aria-hidden="true"></span>
              <span>关联宗族</span>
            </label>
          </div>
          <div class="token-row">
            ${state.characters.length
              ? state.characters.map(character => {
                const id = ruinCharacterReferenceIdentity(character);
                const active = state.selectedCharacterIds.has(id);
                return `
                  <span class="participant-token ${active ? 'active' : ''}">
                     <button type="button" class="token" data-character-id="${escapeAttribute(id)}"
                      aria-pressed="${active}" ${state.busy ? 'disabled' : ''}>
                      ${escapeHtml(character.name)}
                    </button>
                     <button type="button" class="participant-remove" data-remove-character-id="${escapeAttribute(id)}"
                      aria-label="移除 ${escapeAttribute(character.name)}" title="从本次墟境参考中移除"
                      ${state.busy ? 'disabled' : ''}>×</button>
                  </span>`;
              }).join('')
              : '<span class="field-note">未添加人物</span>'}
          </div>
        </div>
        <div class="field">
          <strong>重点参考传记（可选）</strong>
          <div class="token-row">
            ${state.biographies.length
              ? state.biographies.map(biography => `
                  <span class="participant-token active">
                    <span class="token biography-token" title="${escapeAttribute(biography.summary)}">
                      ${escapeHtml(biography.title)}
                    </span>
                    <button type="button" class="participant-remove"
                      data-remove-biography-reference="${escapeAttribute(biography.referenceId)}"
                      aria-label="移除 ${escapeAttribute(biography.title)}" title="从本次墟境参考中移除"
                      ${state.busy ? 'disabled' : ''}>×</button>
                  </span>`).join('')
              : '<span class="field-note">在传记书库中右键加入</span>'}
          </div>
        </div>
          </div>
        </section>
        <section class="composer-card style-card">
          <header class="composer-heading"><span>03</span><h3>讲述气质</h3><button type="button" class="quiet-button" data-random-style ${state.busy ? 'disabled' : ''} aria-label="随机替换时期与文风">⚄ 换一组</button></header>
          ${renderCreativeForm(state)}
        </section>
        <div class="composer-actions">
        <div class="field count-field">
          <strong>候选数量</strong>
          <div class="candidate-count" role="group" aria-label="候选数量">
            ${([3, 4, 5] as const).map(count => `
               <button type="button" class="${count === state.draft.candidateCount ? 'active' : ''}"
                data-count="${count}" aria-pressed="${count === state.draft.candidateCount}"
                ${state.busy ? 'disabled' : ''}>${count}</button>`).join('')}
          </div>
        </div>
        <button type="button" class="primary-button generate-button" data-generate
          ${state.busy || state.entering ? 'disabled' : ''}>
          <span aria-hidden="true">✦</span>
          ${state.busy ? '正在生成候选' : '编织候选史稿'}
        </button>
        <button type="button" class="quiet-button new-task-button" data-new-task
          ${state.busy || state.entering ? 'disabled' : ''} title="清空上次任务的输入草稿与重点参考人物勾选，干净开始新任务">
          <span aria-hidden="true">＋</span>重置设定
        </button>
        </div>
        ${state.error ? `<p class="error-message" role="alert">${escapeHtml(state.error)}</p>` : ''}
      </div>
    </section>`;
}

export function ruinPanelsUnlocked(runtime: RuinRuntimeSnapshot): boolean {
  return canOpenRuinPanel(runtime, 'tasks');
}

function renderCreativeForm(state: RuinState): string {
  const refs = state.draft.creativeReferences;
  return `<div class="field creative-form">
    <div class="period-choice">${Array.from({ length: state.draft.candidateCount }, (_, index) => `<label>候选 ${index + 1}<select data-period-index="${index}" ${state.busy ? 'disabled' : ''}>${(['stable', 'transition', 'turbulent'] as const).map(period => `<option value="${period}" ${refs.periods[index] === period ? 'selected' : ''}>${periodLabel(period)}</option>`).join('')}</select></label>`).join('')}</div>
    <div class="style-selects">${(['telling', 'pace', 'mood'] as const).map(key => `<label class="creative-field"><span>${{ telling: '讲述方式', pace: '叙事节奏', mood: '情绪色彩' }[key]}</span><select data-ruin-style="${key}" ${state.busy ? 'disabled' : ''}>${RUIN_STYLE_OPTIONS[key].map(value => `<option ${refs[key] === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`).join('')}</div>
    <details class="style-guide" data-style-guide><summary>当前文风说明</summary>${(['telling', 'pace', 'mood'] as const).map(key => `<p><strong>${{ telling: '讲述方式', pace: '叙事节奏', mood: '情绪色彩' }[key]}</strong><span data-style-help="${key}">${escapeHtml(ruinStyleMeaning(key, refs[key]))}</span></p>`).join('')}</details>
  </div>`;
}

function renderGeographyPicker(state: RuinState): string {
  const places = state.geography;
  const selected = places.find(place => place.path === state.draft.location);
  const chain: RuinPlace[] = [];
  let cursor = selected;
  while (cursor && chain.length < places.length) {
    chain.unshift(cursor); cursor = places.find(place => place.id === cursor?.parent);
  }
  const children = places.filter(place => place.parent === selected?.id);
  const disabled = state.busy ? 'disabled' : '';
  return `<div class="geo-modes" role="group" aria-label="地点输入方式">${(['select', 'search', 'custom'] as const).map(mode => `<button type="button" data-geo-mode="${mode}" aria-pressed="${state.geoMode === mode}" ${disabled}>${{ select: '逐级选择', search: '搜索地名', custom: '自定义' }[mode]}</button>`).join('')}</div>
    ${state.geoMode === 'select' ? places.length ? `<nav class="geo-breadcrumbs" aria-label="已选地点层级"><button type="button" data-geo-ancestor="" ${disabled}>全部地点</button>${chain.map(place => `<span aria-hidden="true">›</span><button type="button" data-geo-ancestor="${escapeAttribute(place.id)}" ${disabled}>${escapeHtml(place.name)}</button>`).join('')}</nav>
      ${children.length ? `<select data-geo-level="${chain.length}" aria-label="${selected ? '选择下一级地点' : '选择起始地区'}" ${disabled}><option value="">${selected ? `继续选择${escapeHtml(selected.name)}下的地点…` : '选择起始地区…'}</option>${children.map(place => `<option value="${escapeAttribute(place.id)}">${escapeHtml(place.name)}</option>`).join('')}</select>` : '<small class="field-note">已到当前最细层级，也可自定义更具体的地点。</small>'}` : '<small class="field-note">未加载地点索引，请使用自定义。</small>' : ''}
    ${state.geoMode === 'search' ? `<input data-geo-search type="search" autocomplete="off" aria-label="搜索地点" placeholder="输入中文地名，支持空格组合" value="${escapeAttribute(state.geoSearch)}" ${disabled}><div data-geo-results class="geo-search-results" aria-live="polite">${renderGeoResults(state)}</div>` : ''}`;
}

function renderGeoResults(state: RuinState): string {
  const query = state.geoSearch.trim().toLocaleLowerCase();
  if (!query) return '<small class="field-note">搜索城市、地区或地标，也可组合上级地区缩小范围。</small>';
  const terms = query.split(/\s+/u);
  const matches = state.geography.filter(place => terms.every(term => place.path.toLocaleLowerCase().includes(term)))
    .sort((a, b) => Number(b.name.toLocaleLowerCase() === query) - Number(a.name.toLocaleLowerCase() === query) || a.path.length - b.path.length).slice(0, 20);
  return matches.map(place => `<button type="button" data-geo-result="${escapeAttribute(place.id)}" ${state.busy ? 'disabled' : ''}><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.path.split('-').join(' › '))}</small></button>`).join('') || '<small class="field-note">没有匹配地点，可切换“自定义”。</small>';
}

function renderDateGroup(
  side: 'start' | 'end',
  title: string,
  date: DateDraft,
  disabled: boolean,
): string {
  return `
    <div class="field date-group">
      <strong>${title}</strong>
      <div class="date-parts">
        ${(['year', 'month', 'day'] as const).map(part => `
          <label class="date-part">
            <span>${{ year: '年', month: '月', day: '日' }[part]}</span>
            <input inputmode="numeric" data-date="${side}.${part}"
              value="${escapeAttribute(date[part])}"
              placeholder="${{ year: '145', month: '5', day: '20' }[part]}"
              ${disabled ? 'disabled' : ''}>
          </label>`).join('')}
      </div>
    </div>`;
}

function renderCandidates(
  record: RuinCandidateRecord,
  candidate: RuinCandidate,
  selected: RuinNode | null,
  state: RuinState,
): string {
  const selectedState = ruinCandidateState(record, candidate.id);
  const expanded = selectedState.status === 'ready';
  return `
    <div class="candidate-tabs" style="--candidate-count:${record.result.candidates.length}">
      ${record.result.candidates.map((item, index) => {
        const itemState = ruinCandidateState(record, item.id);
        const ready = itemState.status === 'ready';
        const generating = itemState.status === 'generating';
        const failed = itemState.status === 'failed';
        return `
        <button type="button" class="candidate-tab ${periodClass(item.periodType)}
          ${item.id === candidate.id ? 'active' : ''} ${ready ? 'ready' : generating ? 'generating' : failed ? 'failed' : 'pending'}"
          data-candidate-tab-id="${escapeAttribute(item.id)}">
          <span class="candidate-no">${String(index + 1).padStart(2, '0')}</span>
          <span class="candidate-meta">
            <span class="period-tag">${periodLabel(item.periodType)}</span>
            <strong>${escapeHtml(item.title)}</strong>
            <small>${ready
              ? escapeHtml(item.span.label)
              : generating
              ? '<span class="candidate-spinner" aria-hidden="true"></span>正在自动扩写'
              : failed
              ? '史稿未完成 · 可重试'
              : '等待自动扩写'}</small>
          </span>
        </button>`;
      }).join('')}
    </div>
    ${expanded ? `<article class="ruin-dossier history-sheet">
      <div class="history-story">
        <header>
          <div>
            <span class="period-badge">${periodLabel(candidate.periodType)}</span>
            <h2>${escapeHtml(candidate.title)}</h2>
            <span class="history-span">${escapeHtml(candidate.span.label)}</span>
          </div>
          <span class="edition-mark">候选 ${String(record.result.candidates.findIndex(item => item.id === candidate.id) + 1).padStart(2, '0')} / ${String(record.result.candidates.length).padStart(2, '0')}</span>
        </header>
        <p class="history-prose">${escapeHtml(candidate.historyProse)}</p>
      </div>
      <aside class="dossier-notes">
        <h3>编辑边注</h3>
        <dl>
          <div><dt>演变</dt><dd>${escapeHtml(candidate.summary)}</dd></div>
          <div><dt>转向</dt><dd>${escapeHtml(`${periodLabel(candidate.shift.from)} → ${periodLabel(candidate.shift.to)}`)}</dd></div>
          <div><dt>长期演变</dt><dd>${escapeHtml(candidate.fusion.historicalResult)}</dd></div>
          <div><dt>材料边界</dt><dd>${candidate.sourceRefs.length} 条明确引文；其余时代细节为历史推演。</dd></div>
        </dl>
      </aside>
    </article>
    ${renderChronology(record.result.era, candidate, selected)}
    ${renderInspector(record.result.era, record, candidate, selected, state)}`
      : selectedState.status === 'failed' ? `
      <article class="ruin-dossier pending-dossier failed-dossier" aria-live="polite">
        <span class="failed-mark" aria-hidden="true">伊</span>
        <strong>这段史稿尚未完成</strong>
        <p>其他候选已经保留。你可以只重新生成当前墟境，不会改动已经完成的内容。</p>
        <button type="button" class="primary-button retry-candidate-button"
          data-retry-candidate ${state.busy || state.entering ? 'disabled' : ''}>重新生成此墟境</button>
      </article>` : `
      <article class="ruin-dossier pending-dossier" role="status" aria-live="polite" aria-busy="true">
        ${selectedState.status === 'generating'
          ? '<span class="dossier-spinner" aria-hidden="true"></span>'
          : '<span class="queued-mark" aria-hidden="true">· · ·</span>'}
        <strong>${selectedState.status === 'generating' ? '正在自动扩写这份墟境史稿' : '这份候选正在等待自动扩写'}</strong>
        <p>${renderCandidateProgress(record, candidate.id)}</p>
      </article>
      ${renderChronology(record.result.era, candidate, selected)}
      ${renderInspector(record.result.era, record, candidate, selected, state)}`}
  `;
}

function renderCandidateProgress(
  record: RuinCandidateRecord,
  candidateId: string,
): string {
  const index = record.result.candidates.findIndex(item => item.id === candidateId) + 1;
  const total = record.result.candidates.length;
  const completed = record.result.candidates.filter(item =>
    ruinCandidateState(record, item.id).status === 'ready').length;
  return escapeHtml(
    `大纲已经完成，系统会依次扩写全部候选，无需逐项点击。当前第${index}/${total}项，已完成${completed}/${total}项。`,
  );
}

function renderChronology(
  era: string,
  candidate: RuinCandidate,
  selected: RuinNode | null,
): string {
  return `
    <div class="chronology">
      <header class="chronology-toolbar">
        <div class="scale-state">
          <strong>因果节点</strong>
          <span>${escapeHtml(candidate.span.label)}</span>
        </div>
        <div class="chronology-scroll-tools">
          <span class="period-tag">${candidate.nodes.length}个节点</span>
          <button type="button" data-timeline-scroll="-1" aria-label="向左查看历史节点">‹</button>
          <button type="button" data-timeline-scroll="1" aria-label="向右查看历史节点">›</button>
        </div>
      </header>
      <div class="chronology-viewport" data-timeline tabindex="0" role="region"
        aria-label="历史节点，左右滑动或使用方向键查看">
        <div class="chronology-track" style="--node-count:${candidate.nodes.length}">
          ${candidate.nodes.map(node => `
              <div class="timeline-event ${selected?.id === node.id ? 'selected' : ''}"
                style="--lane-top:88px;--stem-height:34px">
                <button type="button" class="history-node ${selected?.id === node.id ? 'selected' : ''}"
                  data-node-id="${escapeAttribute(node.id)}"
                  data-candidate-id="${escapeAttribute(candidate.id)}"
                  aria-pressed="${selected?.id === node.id}">
                   <span class="event-kind">${nodeKind(node.kind)}</span>
                   <small>${escapeHtml(formatRuinNodeExactTime(era, node.time))}</small>
                   <strong>${escapeHtml(node.title)}</strong>
                 </button>
              </div>`).join('')}
        </div>
      </div>
      <p class="chronology-pan-hint">左右滑动查看 · 点击卡片选择阶段</p>
      <div class="timeline-summary">
        <strong>长期演变</strong>
        <span>${escapeHtml(candidate.fusion.historicalResult)}</span>
      </div>
    </div>`;
}

function renderInspector(
  era: string,
  record: RuinCandidateRecord,
  candidate: RuinCandidate,
  node: RuinNode | null,
  state: RuinState,
): string {
  const candidateReady = ruinCandidateState(record, candidate.id).status === 'ready';
  const enterable = candidateReady && Boolean(node);
  const busyLabel = state.busy ? '墟境任务进行中' : state.entering ? '正在进入…' : '';
  return `
    <div class="node-inspector visible">
      <div>
        <strong>${escapeHtml(node?.title || '选择一个历史节点')}</strong>
        ${node ? `
          <span class="node-inspector-meta">${escapeHtml(`${formatRuinNodeExactTime(era, node.time)} · ${node.location}`)}</span>
          <p class="node-inspector-stage">${escapeHtml(fullRuinStageIntroduction(node))}</p>
          <p class="node-inspector-trace"><b>可感知痕迹</b>${escapeHtml(node.visibleTrace)}</p>
        ` : '<p class="node-inspector-stage">查看因果节点；缘起、经过、高潮与结果都可以进入。</p>'}
      </div>
      <button type="button" class="primary-button" data-enter
        ${!enterable || state.busy || state.entering ? 'disabled' : ''}
        data-record-key="${escapeAttribute(record.key)}"
        data-candidate-id="${escapeAttribute(candidate.id)}">
        <span aria-hidden="true">↪</span>
        ${busyLabel || (enterable
          ? `进入${node ? nodeKind(node.kind) : '此阶段'}`
          : candidateReady ? '请选择历史阶段' : '史稿完成后可进入')}
      </button>
    </div>`;
}

function renderWorkingState(state: RuinState): string {
  if (!state.busy && !state.entering && state.status?.status !== 'failed') return '';
  const active = state.busy || state.entering;
  return `
    <aside class="working-state ${active ? 'active' : 'failed'}" role="status">
      <span class="working-mark" aria-hidden="true">伊</span>
      <div>
        <strong>${active ? '伊雍正在校订史料' : '候选墟境生成未完成'}</strong>
        <p>${escapeHtml(state.status?.detail || state.error)}</p>
        ${state.status?.progress ? `<span class="working-progress">史稿已完成 ${state.status.progress.current}/${state.status.progress.total}${state.status.progress.item ? `，正在撰写第 ${state.status.progress.item} 份` : ''}</span>` : ''}
      </div>
    </aside>`;
}

function renderEmptyState(busy: boolean): string {
  return `
    <div class="empty-state">
      <span aria-hidden="true">${busy ? '◌' : '⑂'}</span>
      <strong>${busy ? '正在检索历史坐标' : '尚未生成候选墟境'}</strong>
      <p>${busy
        ? '伊雍正在比对世界书、正文、谱系与可选传记。'
        : '在上方选定历史舞台与探索方向，再编织候选。候选不会直接修改墟境状态。'}</p>
    </div>`;
}

function buildInput(state: RuinState): RuinGenerationInput | null {
  const location = state.draft.location.trim();
  if (!location) {
    state.error = '必须填写地点，才能生成墟境';
    return null;
  }
  try {
    const era = state.draft.era.normalize('NFKC').trim();
    if (!era) throw new Error('请输入自定义纪年名称');
    const candidateCount = state.draft.candidateCount;
    return {
      era,
      start: parseDate(state.draft.start, '起始时间'),
      end: parseDate(state.draft.end, '结束时间'),
      location,
      supplementaryDirection: state.draft.supplementaryDirection.trim(),
      autoGenealogy: state.draft.autoGenealogy,
      selectedCharacters: state.characters.filter(character =>
        state.selectedCharacterIds.has(ruinCharacterReferenceIdentity(character))),
      wave: waveForCandidateCount(candidateCount),
      creativeReferences: { ...state.draft.creativeReferences, periods: state.draft.creativeReferences.periods.slice(0, candidateCount) },
      materials: createReferencedRuinMaterials(candidateCount, state.draft.creativeReferences),
    };
  } catch (error) {
    state.error = errorMessage(error);
    return null;
  }
}

function isCustomEra(era: string): boolean {
  return !KNOWN_EYON_ERAS.includes(era as typeof KNOWN_EYON_ERAS[number]);
}

function parseDate(value: DateDraft, label: string): RuinGenerationInput['start'] {
  if (!value.year.trim() && !value.month.trim() && !value.day.trim()) return null;
  const year = parseInteger(value.year, `${label}年份`);
  const month = value.month.trim() ? parseInteger(value.month, `${label}月份`) : null;
  const day = value.day.trim() ? parseInteger(value.day, `${label}日期`) : null;
  if (month !== null && (month < 1 || month > 12)) {
    throw new Error(`${label}月份必须在1至12之间`);
  }
  if (day !== null && (day < 1 || day > 31)) {
    throw new Error(`${label}日期必须在1至31之间`);
  }
  return { year, month, day };
}

function parseInteger(value: string, label: string): number {
  const normalized = value.trim();
  if (!/^-?\d+$/u.test(normalized)) throw new Error(`${label}必须是整数`);
  return Number(normalized);
}

function inputToDraft(input: RuinGenerationInput): RuinDraft {
  const refs = input.creativeReferences ?? defaultRuinReferences(input.materials.map(material => material.periodType));
  return {
    era: input.era,
    start: dateToDraft(input.start),
    end: dateToDraft(input.end),
    location: input.location,
    supplementaryDirection: input.supplementaryDirection,
    autoGenealogy: input.autoGenealogy === true,
    candidateCount: input.wave.candidateCount as 3 | 4 | 5,
    creativeReferences: { ...refs, periods: Array.from({ length: input.wave.candidateCount }, (_, index) => refs.periods[index % refs.periods.length]) },
  };
}

function dateToDraft(value: RuinGenerationInput['start']): DateDraft {
  return value
    ? {
      year: String(value.year),
      month: value.month === null ? '' : String(value.month),
      day: value.day === null ? '' : String(value.day),
    }
    : { ...EMPTY_DATE };
}

function periodLabel(value: RuinCandidate['periodType']): string {
  return {
    stable: '稳定期',
    transition: '过渡期',
    turbulent: '动荡期',
  }[value];
}

function periodClass(value: RuinCandidate['periodType']): string {
  return value === 'transition'
    ? 'transition'
    : value === 'turbulent'
    ? 'turmoil'
    : '';
}

function nodeKind(value: RuinNode['kind']): string {
  return {
    origin: '缘起',
    process: '经过',
    anomaly: '高潮',
    result: '结果',
  }[value];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
