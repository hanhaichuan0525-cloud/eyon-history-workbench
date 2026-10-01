import type { WorkbenchStatusDetail } from '../runtime/facade.ts';
import { isTaskBusy } from '../runtime/taskStatus.ts';
import { preserveDomState, ViewRefreshGuard } from './viewRefresh.ts';
import type { RuinRuntimeSnapshot, RuinTaskSnapshot } from '../adapters/host.ts';
import {
  createRuinMaterials,
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
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import { installScrollPan } from './scrollPan.ts';
import {
  formatRuinNodeExactTime,
  fullRuinStageIntroduction,
} from './ruinPresentation.ts';

export interface RuinWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface RuinWorkbenchOptions {
  theme?: 'dark' | 'light';
  embedded?: boolean;
}

interface RuinState {
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
  let theme = options.theme ?? 'light';
  const reads = new ViewRefreshGuard(() => client.contextRevision());
  const mutations = new ViewRefreshGuard(() => client.contextRevision());
  const runtimeReads = new ViewRefreshGuard(() => client.contextRevision());
  let configuredLoaded = client.isReady();
  let draftEdited = false;

  const configured = client.isReady()
    ? client.facade().getSettings().ruinDraft
    : null;
  const state: RuinState = {
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
      mutations.invalidate(); reads.invalidate(); runtimeReads.invalidate();
      state.entering = false; state.taskCreating = false;
    }
    state.status = detail;
    state.busy = isTaskBusy(detail);
    if (detail.phase === 'error') state.error = detail.detail;
    if (!detail.request) render();
    if (detail.status === 'candidate_ready' || detail.status === 'candidate_failed') void syncRecords();
    if (detail.status === 'ready' || detail.status === 'ruin_task_draft_restored') {
      void refresh();
    }
  });
  const offReady = client.onReady(() => void refresh());
  const offContext = client.onContextChanged(() => {
    mutations.invalidate();
    reads.invalidate(); runtimeReads.invalidate();
    state.records = []; state.characters = []; state.biographies = [];
    state.runtime = emptyRuinRuntime(); state.taskReview = null;
    state.activeRecordKey = ''; state.activeCandidateId = ''; state.selectedNodeId = '';
    state.selectedCharacterIds.clear(); state.busy = false; state.entering = false; state.taskCreating = false;
    state.status = null; state.error = ''; configuredLoaded = true; draftEdited = false;
    state.draft = { era: '复兴纪元', start: { ...EMPTY_DATE }, end: { ...EMPTY_DATE }, location: '', supplementaryDirection: '', autoGenealogy: false, candidateCount: 3 };
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
    if (!client.isReady()) return;
    const draft = client.facade().getSettings().ruinDraft;
    if (draft) client.facade().setRuinDraft({
      ...draft,
      selectedCharacters: state.characters.filter(character =>
        state.selectedCharacterIds.has(ruinCharacterReferenceIdentity(character))),
    });
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
      const [records, references, biographies, runtime, taskReview] = await Promise.all([
        client.facade().listRuins(),
        client.listRuinCharacterReferences(),
        client.listRuinBiographyReferences(),
        client.getRuinRuntimeSnapshot(),
        client.getRuinTaskReview(),
      ]);
      if (!current()) return;
      runtimeReads.invalidate();
      state.records = [...records].sort((left, right) =>
        right.createdAt - left.createdAt);
      state.characters = references;
      state.biographies = biographies;
      state.runtime = runtime;
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
      render();
    } catch {
      // 完整刷新会报告持久错误；状态事件后的轻量刷新保持安静。
    }
  }

  async function syncRecords(): Promise<void> {
    if (state.disposed || !client.isReady()) return;
    const current = reads.begin();
    try {
      const records = await client.facade().listRuins();
      if (!current()) return;
      state.records = [...records].sort((left, right) =>
        right.createdAt - left.createdAt);
      // 增量同步只更新资料，不夺走用户当前正在阅读的旧记录。
      // 新任务完成后 generate() 会显式切到新记录；生成途中浏览选择始终归 UI 所有。
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
    draftEdited = true;
    state.draft = {
      era: '复兴纪元',
      start: { ...EMPTY_DATE },
      end: { ...EMPTY_DATE },
      location: '',
      supplementaryDirection: '',
      autoGenealogy: false,
      candidateCount: 3,
    };
    state.selectedCharacterIds.clear();
    state.error = '';
    state.status = null;
    if (client.isReady()) {
      client.facade().setRuinDraft(null);
    }
    render();
  }

  async function generate(): Promise<void> {
    if (state.busy || state.entering) return;
    state.error = '';
    const input = buildInput(state);
    if (!input) {
      render();
      return;
    }
    state.busy = true;
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
      state.records = [
        record,
        ...state.records.filter(item => item.key !== record.key),
      ];
      state.activeRecordKey = record.key;
      state.activeCandidateId = record.result.candidates[0]?.id ?? '';
      state.selectedNodeId = '';
      const ready = record.result.candidates.filter(candidate => ruinCandidateState(record, candidate.id).status === 'ready').length;
      state.status = { status: 'ready', detail: `候选史稿已完成 ${ready}/${record.result.candidates.length}${ready < record.result.candidates.length ? '，其余可单独重试' : '，可以比较后选择'}` };
    } catch (error) {
      if (!current()) return;
      state.error = '墟境生成未完成，技术详情已保存到设置中的错误日志。';
      state.status = { status: 'failed', detail: state.error };
    } finally {
      if (current()) { state.busy = false; render(); }
    }
  }

  async function enter(): Promise<void> {
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

  function render(): void {
    if (state.disposed) return;
    const restore = preserveDomState(root);
    const record = activeRecord();
    const candidate = activeCandidate(record);
    const node = selectedNode(candidate);
    const previousTimeline = root.querySelector<HTMLElement>('[data-timeline]');
    const scrollLeft = previousTimeline?.scrollLeft ?? 0;

    root.innerHTML = `
      <style>${ruinCss}</style>
      <main class="ruin-app" data-theme="${theme}">
        ${options.embedded ? '' : renderWorkingState(state)}
        <header class="ruin-page-head">
          <div class="ruin-page-copy">
            <p class="ruin-eyebrow">RUIN CARTOGRAPHY · 07</p>
            <h1>墟境候选与四阶段入口</h1>
            <p>先定史料边界，再审阅候选因果。界面只保留一个主任务：选择值得进入的历史节点。</p>
          </div>
          <div class="ruin-stepper" aria-label="墟境生成流程">
            ${renderRuinSteps(record, node)}
          </div>
        </header>
        <div class="generator-layout">
          ${renderForm(state)}
          <section class="timeline-panel">
            <div class="history-canvas-tools">
              ${renderRecordSelector(state.records, state.activeRecordKey)}
              <button type="button" class="icon-button" data-refresh title="重新读取当前资料">↻</button>
            </div>
            ${record && candidate
              ? renderCandidates(record, candidate, node, state)
              : renderEmptyState(state.busy)}
          </section>
        </div>
        ${renderRuinTaskModule(state)}
      </main>`;
    bind();
    restore();
    const timeline = root.querySelector<HTMLElement>('[data-timeline]');
    if (timeline) timeline.scrollLeft = scrollLeft;
  }

  function renderRuinSteps(record: RuinCandidateRecord | null, node: RuinNode | null): string {
    const steps = [
      ['01', '范围设定', '纪元、地点与跨度', Boolean(state.draft.location.trim())],
      ['02', '史料锚点', '人物与传记参照', state.characters.length > 0 || state.biographies.length > 0],
      ['03', '候选审阅', '因果与正文核验', Boolean(record)],
      ['04', '节点进入', '选择具体时刻', Boolean(node)],
    ] as const;
    const activeIndex = node ? 3 : record ? 2 : state.draft.location.trim() ? 1 : 0;
    return steps.map(([number, title, detail, completed], index) => `
      <div class="ruin-step ${index === activeIndex ? 'is-active' : ''} ${completed ? 'is-complete' : ''}">
        <span class="ruin-step-number">${number}</span>
        <strong>${title}</strong>
        <span>${detail}</span>
      </div>`).join('');
  }

  function bind(): void {
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
    refresh,
    setTheme(nextTheme) {
      theme = nextTheme;
      root.querySelector<HTMLElement>('.ruin-app')
        ?.setAttribute('data-theme', nextTheme);
    },
    setAppearance(appearance) {
      theme = appearance.mode;
      applyAppearance(host, appearance);
      root.querySelector<HTMLElement>('.workbench')
        ?.setAttribute('data-theme', appearance.mode);
    },
    dispose() {
      mutations.dispose();
      state.disposed = true;
      reads.dispose(); runtimeReads.dispose(); offContext();
      stopScrollPan();
      offStatus();
      offReady();
      offReferences();
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

function renderForm(state: RuinState): string {
  return `
    <section class="section form-section">
      <header class="parameter-heading"><span>勘录条件</span></header>
      <div class="section-body form-stack">
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
              <span class="field-note">必须与当前角色卡世界书中的纪年名称完全一致；系统会精确检索并锁定对应条目。</span>
            </label>`
          : ''}
        <div class="date-range-grid">
          ${renderDateGroup('start', '起始时间（均可选）', state.draft.start, state.busy)}
          ${renderDateGroup('end', '结束时间（均可选）', state.draft.end, state.busy)}
        </div>
        <label class="field ${state.error === '必须填写地点，才能生成墟境' ? 'invalid' : ''}">
          <strong>地点范围（必填）</strong>
          <input data-location value="${escapeAttribute(state.draft.location)}"
            placeholder="输入区域、城市、建筑或前文出现的小地点"
            ${state.busy ? 'disabled' : ''}>
          <span class="field-note">优先检索世界书；未收录时读取可见正文中的地点资料，也允许手动补充。</span>
          <span class="field-error">必须填写地点，才能检索并生成墟境。</span>
        </label>
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
              : '<span class="field-note">尚未加入重点参考人物；此项可以留空。</span>'}
          </div>
          <span class="field-note">关联宗族默认关闭，仅关联有本地活动依据的人物。手动加入的人物默认启用，可点击取消；方向指定不受影响。</span>
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
              : '<span class="field-note">可在传记书库中右键选择“加入墟境参考”。</span>'}
          </div>
        </div>
        <label class="field">
          <strong>补充方向</strong>
          <textarea data-direction ${state.busy ? 'disabled' : ''}
            placeholder="填写真正关心的人物、矛盾、地点细节或探索方向">${escapeHtml(state.draft.supplementaryDirection)}</textarea>
          <span class="field-note">历史题材由伊雍骰表分配；这里用于约束本次创作的重点与自由度。</span>
        </label>
        <div class="field">
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
          ${state.busy ? '正在生成候选' : '按历史波动生成候选'}
        </button>
        <button type="button" class="quiet-button new-task-button" data-new-task
          ${state.busy || state.entering ? 'disabled' : ''} title="清空上次任务的输入草稿与重点参考人物勾选，干净开始新任务">
          <span aria-hidden="true">＋</span>新建任务（清空输入）
        </button>
        ${state.error ? `<p class="error-message">${escapeHtml(state.error)}</p>` : ''}
      </div>
    </section>`;
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
        : '填写左侧地点与探索方向后生成；候选不会直接修改墟境状态。'}</p>
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
      materials: createRuinMaterials(candidateCount),
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
  return {
    era: input.era,
    start: dateToDraft(input.start),
    end: dateToDraft(input.end),
    location: input.location,
    supplementaryDirection: input.supplementaryDirection,
    autoGenealogy: input.autoGenealogy === true,
    candidateCount: input.wave.candidateCount as 3 | 4 | 5,
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
