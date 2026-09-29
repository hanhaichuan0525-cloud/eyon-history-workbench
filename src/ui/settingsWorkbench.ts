import type { GenerationSettings } from '../runtime/settings.ts';
import {
  normalizeCustomApiBaseUrl,
  normalizeCustomApiKey,
} from '../runtime/customApiCredentials.ts';
import type { CharacterWorldbookEntryOption } from '../runtime/tavernHost.ts';
import type {
  GenerationTaskType,
  WorkbenchSettings,
} from '../runtime/workbenchSettings.ts';
import { resolveTavernHelperFunction } from '../runtime/tavernRuntimeAdapter.ts';
import settingsCss from './settingsWorkbench.css?raw';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import {
  hydrateWorkbenchIcons,
  icon,
  type WorkbenchIconName,
} from './lucideIcons.ts';
import { WorkbenchUiClient, type WorkbenchUiSnapshot } from './workbenchClient.ts';
import { WORKBENCH_VERSION, WORKBENCH_VERSION_LABEL } from '../core/version.ts';

type CanonConsumptionInspection = Awaited<
  ReturnType<WorkbenchUiClient['inspectCurrentArtifactCanonConsumption']>
>;

/** internal.86：蝴蝶记忆注入诊断（一目了然看「注入了什么/为什么」）。 */
type CanonMemoryInspection = ReturnType<WorkbenchUiClient['inspectCanonMemory']>;
type CanonMemorySnapshotView = NonNullable<CanonMemoryInspection['snapshot']>;
type ContinuityInspection = Awaited<
  ReturnType<WorkbenchUiClient['inspectCurrentContinuityAnchors']>
>;

type SettingsTab = 'api' | 'appearance' | 'retrieval' | 'data';

export interface SettingsWorkbenchHandle {
  refresh(): Promise<void>;
  setTheme(theme: 'dark' | 'light'): void;
  setAppearance(appearance: WorkbenchAppearance): void;
  dispose(): void;
}

export interface SettingsWorkbenchOptions {
  theme?: 'dark' | 'light';
  onAppearanceChange?: (appearance: WorkbenchAppearance) => void;
}

const TABS: Array<{ id: SettingsTab; label: string; icon: WorkbenchIconName }> = [
  { id: 'api', label: 'API调用', icon: 'plug-zap' },
  { id: 'appearance', label: '外观皮肤', icon: 'palette' },
  { id: 'retrieval', label: '资料检索', icon: 'database-zap' },
  { id: 'data', label: '数据管理', icon: 'archive' },
];

const TASKS: Array<{
  id: GenerationTaskType;
  label: string;
  detail: string;
}> = [
  { id: 'genealogy', label: '宗族谱系', detail: '仅在生成或刷新当前人物族谱时调用。' },
  { id: 'ruin', label: '墟境生成', detail: '仅在界面生成候选历史与因果节点时调用。' },
  { id: 'biography', label: '寻根溯源', detail: '仅在识别明确命令并生成传记时调用。' },
  { id: 'butterfly', label: '蝴蝶效应结算', detail: '遣返后读取冻结锚点，生成现世变化并写入全局世界书。' },
];

/** 未配置模块的空白凭据：字段由玩家在设置页填写，保存时至少要求密钥非空。 */
const EMPTY_CUSTOM: GenerationSettings = {
  apiurl: '',
  key: '',
  model: '',
  source: 'openai',
  maxTokens: 60000,
  temperature: 0.8,
};

// β1：对外版本名与内部数字版本分离（更新机制要求 manifest.version 为 x.y.z）。
const CURRENT_EXTENSION_VERSION = WORKBENCH_VERSION;
const REMOTE_MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@main/manifest.json';
const EXTENSION_ID = 'eyon-history-workbench';

type UpdateState = {
  latest: string | null;
  available: boolean;
  message: string;
};

type CustomApiSettings = GenerationSettings;

const FALLBACK_SETTINGS: Pick<
  WorkbenchSettings,
  'appearance' | 'retrieval'
> = {
  appearance: {
    mode: 'light',
    accent: 'jade',
    text: 'neutral',
  },
  retrieval: {
    biographyEnabled: false,
    worldbookScope: 'eyon',
    mergeAliases: true,
    worldbookEntryExclusions: {},
  },
};

export function mountSettingsWorkbench(
  container: HTMLElement,
  client = new WorkbenchUiClient(),
  options: SettingsWorkbenchOptions = {},
): SettingsWorkbenchHandle {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.replaceChildren(host);

  let tab: SettingsTab = 'api';
  let task: GenerationTaskType = 'ruin';
  let snapshot: WorkbenchUiSnapshot | null = null;
  let worldbookEntries: CharacterWorldbookEntryOption[] = [];
  let canonConsumption: CanonConsumptionInspection | null = null;
  let canonMemory: CanonMemoryInspection | null = null;
  let continuityInspection: ContinuityInspection | null = null;
  let appearance: WorkbenchAppearance = {
    ...FALLBACK_SETTINGS.appearance,
    mode: options.theme ?? FALLBACK_SETTINGS.appearance.mode,
  };
  let updateState: UpdateState = {
    latest: null,
    available: false,
    message: `当前版本 ${WORKBENCH_VERSION_LABEL}（内部版本 ${WORKBENCH_VERSION}）；点击检查更新以读取远端稳定版。`,
  };
  let busy = false;
  let status = '';
  let error = '';
  const fetchedModels = new Map<GenerationTaskType, string[]>();
  const customDrafts = new Map<GenerationTaskType, CustomApiSettings>();
  const dirtyCustomDrafts = new Set<GenerationTaskType>();
  let disposed = false;

  async function refresh(): Promise<void> {
    if (disposed || !client.isReady()) {
      render();
      return;
    }
    try {
      [snapshot, worldbookEntries] = await Promise.all([
        client.readSnapshot(),
        client.listCharacterWorldbookEntries(),
      ]);
      appearance = snapshot.settings.appearance;
      syncCustomDrafts(snapshot.settings);
      error = '';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    render();
  }

  function settings(): WorkbenchSettings | null {
    return snapshot?.settings ?? (client.isReady() ? client.facade().getSettings() : null);
  }

  function render(): void {
    const current = settings();
    appearance = current?.appearance ?? appearance;
    host.dataset.theme = appearance.mode;
    // internal.86：每次渲染同步读取最近一次蝴蝶记忆注入快照（只读、无副作用）。
    try {
      canonMemory = client.inspectCanonMemory();
    } catch {
      canonMemory = null;
    }
    root.innerHTML = `
      <style>${settingsCss}</style>
      <div class="settings">
        ${renderVersionBar()}
        <nav class="settings-nav" aria-label="设置分类">
          ${TABS.map(item => tabButton(item)).join('')}
        </nav>
        <div class="panel">
          ${tab === 'api' ? renderApi(current) : ''}
          ${tab === 'appearance' ? renderAppearance(appearance) : ''}
          ${tab === 'retrieval' ? renderRetrieval(current) : ''}
          ${tab === 'data' ? renderData(snapshot) : ''}
          <div class="status ${error ? 'error' : ''}" role="status">${escapeHtml(error || status)}</div>
        </div>
      </div>`;
    applyAppearance(host, appearance);
    hydrateWorkbenchIcons(root);
    bind();
  }

  function tabButton(item: typeof TABS[number]): string {
    return `
      <button class="settings-tab" type="button" data-tab="${item.id}"
        aria-label="${item.label}" title="${item.label}"
        aria-selected="${tab === item.id}">
        ${icon(item.icon)}<span>${item.label}</span>
      </button>`;
  }

  function renderVersionBar(): string {
    const updateButton = updateState.available
      ? `<button class="primary-button" type="button" data-action="update-extension" ${busy ? 'disabled' : ''}>${icon('download')}更新到 ${escapeHtml(updateState.latest ?? '')}</button>`
      : `<button class="quiet-button" type="button" data-action="check-update" ${busy ? 'disabled' : ''}>${icon('refresh-cw')}检查更新</button>`;
    // β1：启动开关与"魔术棒入口"说明一并退役——工作台由角色卡悬浮球打开，版本号常驻
    // 工作台左上角，这里只保留更新检查与版本说明。
    return `
      <section class="launcher-banner" aria-label="伊雍历史工作台版本与更新">
        <div class="launcher-copy">
          <div class="launcher-kicker">EYON HISTORY WORKBENCH · CONTROL</div>
          <h1>伊雍历史工作台 <span class="launcher-version">${WORKBENCH_VERSION_LABEL}</span></h1>
          <p>当前版本 ${WORKBENCH_VERSION_LABEL}（内部版本 ${WORKBENCH_VERSION}）。工作台由角色卡悬浮球打开，更新只在你点击按钮后执行，不会自动联网。</p>
          <small class="launcher-update-status">${escapeHtml(updateState.message)}</small>
        </div>
        <div class="launcher-actions">
          ${updateButton}
        </div>
      </section>`;
  }

  function renderApi(current: WorkbenchSettings | null): string {
    const custom = customDraftFor(task, current?.generation[task]);
    const selectedTask = TASKS.find(item => item.id === task) ?? TASKS[0];

    return `
      <section class="section">
        ${sectionHeader('plug-zap', '生成模块 API', '四项历史生成能力统一在此配置')}
        <div class="api-stack">
          <section class="api-root-card">
            ${settingRow(
              '剧情时刻',
              '最近一次传记正文产出的剧情时间（文首 → 文尾）。时间跟着剧情走，寻根溯源与蝴蝶效应的时效判定以此为准。',
              `<span class="story-clock">${current?.storyClock
                ? `${escapeHtml(current.storyClock.start)} → ${escapeHtml(current.storyClock.end)}`
                : '尚未产出（完成一次寻根溯源后自动记录）'}</span>`,
            )}
            ${settingRow(
              '请求超时（秒）',
              '单个生成请求最多等待时长，0 表示不限制。慢中转上游正常成功可达 5 分钟以上，过短会把「慢但会成功」判死；官方 DeepSeek 建议 180~300。',
              `<input id="api-timeout" type="number" min="0" max="900" step="30"
                value="${Math.round((current?.customApiTimeoutMs ?? 600_000) / 1000)}"
                aria-label="独立 API 请求超时秒数">`,
            )}
          </section>
          <section class="api-group">
            <div class="api-group-title">${icon('blocks')}<span>模块选择</span></div>
            <div class="api-module-grid">
              ${TASKS.map(item => `
                  <article class="api-module-card ${task === item.id ? 'active' : ''}">
                    <button class="module-select" type="button" data-task="${item.id}">
                      <strong>${item.label}</strong><p>${item.detail}</p>
                    </button>
                    <label class="retry-control">
                      <span>失败重试</span>
                      <select data-retry-task="${item.id}" aria-label="${item.label}失败重试次数">
                        ${[0, 1, 2, 3, 4, 5].map(value =>
                          `<option value="${value}" ${(current?.retries[item.id] ?? 2) === value ? 'selected' : ''}>${value} 次</option>`).join('')}
                      </select>
                    </label>
                  </article>`).join('')}
            </div>
          </section>
          <section class="api-credentials">
            <div class="api-group-title">
              <span>${escapeHtml(selectedTask.label)} · 独立 API 凭据</span>
              <small>每个模块可单独配置，也可一键应用到全部模块</small>
            </div>
            ${settingRow('接口地址', '支持 OpenAI 兼容的聊天补全接口。', `<input id="api-url" value="${escapeAttr(custom.apiurl)}">`)}
            ${settingRow('API 密钥', '不会写入世界书、聊天或导出资料；重新导入为新脚本时需要重新填写。', `<input id="api-key" type="password" autocomplete="off" value="${escapeAttr(custom.key)}">`)}
            ${settingRow('可调用模型', '填写地址和密钥后拉取列表，再从中选择。', `
              <div class="model-picker">
                <select id="api-model">
                  ${renderModelOptions(fetchedModels.get(task) ?? [], custom.model)}
                </select>
                <button class="quiet-button" type="button" data-action="fetch-models">
                  ${icon('refresh-cw')}拉取列表
                </button>
              </div>`)}
            ${settingRow('已选择模型', '保存后，该模块将固定调用此模型。', `
              <output class="selected-model" id="api-selected-model" aria-live="polite">
                ${escapeHtml(custom.model || '尚未选择')}
              </output>`)}
            <div class="api-actions">
              <button class="primary-button" type="button" data-action="save-api" ${busy ? 'disabled' : ''}>${icon('save')}保存当前模块</button>
              <button class="quiet-button" type="button" data-action="apply-all" ${busy ? 'disabled' : ''}>${icon('radio')}应用到全部模块</button>
            </div>
          </section>
        </div>
      </section>`;
  }

  function renderAppearance(current: WorkbenchAppearance): string {
    return `
      <section class="section">
        ${sectionHeader('palette', '外观皮肤', '分别设置明暗模式、界面强调色与正文字色')}
        <div class="section-body appearance-stack">
          <div class="appearance-block">
            ${appearanceHeading('明暗模式', '日间使用雾紫纸面，夜间使用明度克制的深紫灰档案底色。')}
            <div class="mode-grid">
              ${appearanceChoice('mode', 'dark', current.mode, 'moon-star', '夜间模式', '深紫灰 · 柔和暗读')}
              ${appearanceChoice('mode', 'light', current.mode, 'sun', '日间模式', '雾紫纸 · 清晰长读')}
            </div>
          </div>
          <div class="appearance-block">
            ${appearanceHeading('UI 强调色', '用于按钮、选中状态、连接线和交互反馈，不改变史料语义色。')}
            <div class="palette-grid">
              ${paletteChoice('accent', 'jade', current.accent, 'waves', '#52b8ad', '影蛇青', '默认')}
              ${paletteChoice('accent', 'gold', current.accent, 'crown', '#c39a43', '王庭金', '典藏')}
              ${paletteChoice('accent', 'blue', current.accent, 'moon-star', '#669fc7', '月辉蓝', '冷静')}
              ${paletteChoice('accent', 'crimson', current.accent, 'flame', '#b65f67', '绛红', '醒目')}
            </div>
          </div>
          <div class="appearance-block">
            ${appearanceHeading('字体色调', '按当前日间或夜间模式自动调整明度，始终保证正文对比度。')}
            <div class="palette-grid text-grid">
              ${paletteChoice('text', 'neutral', current.text, 'circle', '#aeb7b2', '中性霜白', '标准阅读')}
              ${paletteChoice('text', 'warm', current.text, 'sun-medium', '#c99a68', '暖纸色', '柔和长读')}
              ${paletteChoice('text', 'cool', current.text, 'snowflake', '#8fb5c8', '冷银色', '清晰理性')}
            </div>
          </div>
        </div>
      </section>`;
  }

  function renderRetrieval(current: WorkbenchSettings | null): string {
    const retrieval = current?.retrieval ?? FALLBACK_SETTINGS.retrieval;
    return `
      <section class="section">
        ${sectionHeader('database-zap', '资料检索', '控制独立生成模块在当前聊天中读取哪些史料')}
        ${settingRow(
          '人物别名合并',
          '同名或别名冲突时仍要求玩家确认。',
          `<label class="toggle"><input id="merge-aliases" type="checkbox" ${retrieval.mergeAliases ? 'checked' : ''}><span></span></label>`,
        )}
        ${renderWorldbookSelection()}
      </section>`;
  }

  function renderWorldbookSelection(): string {
    const enabledEntries = worldbookEntries.filter(entry => entry.enabledInTavern);
    const allSelected = enabledEntries.length > 0
      && enabledEntries.every(entry => entry.selectedForWorkbench);
    return `
      <div class="worldbook-selection">
        <header class="worldbook-selection-head">
          <div>
            <strong>世界书资料清单</strong>
            <p>按角色卡与全局世界书选择独立 API 会收到的条目，不改变酒馆正文注入。</p>
          </div>
          <label class="worldbook-all">
            <input type="checkbox" data-worldbook-all ${allSelected ? 'checked' : ''}
              ${enabledEntries.length === 0 ? 'disabled' : ''}>
            <span>全选 / 全不选</span>
          </label>
        </header>
        ${renderWorldbookScope('character', '角色卡世界书')}
        ${renderWorldbookScope('global', '全局世界书')}
      </div>`;
  }

  function renderWorldbookScope(
    scope: CharacterWorldbookEntryOption['scope'],
    label: string,
  ): string {
    const entriesInScope = worldbookEntries.filter(entry => entry.scope === scope);
    const grouped = new Map<string, CharacterWorldbookEntryOption[]>();
    for (const entry of entriesInScope) {
      const entries = grouped.get(entry.worldbookName) ?? [];
      entries.push(entry);
      grouped.set(entry.worldbookName, entries);
    }
    return `
      <details class="worldbook-scope" open>
        <summary>
          <span>${label}</span>
          <small>${entriesInScope.length} 条</small>
        </summary>
        ${entriesInScope.length === 0
          ? `<div class="worldbook-empty">当前没有${label}。</div>`
          : [...grouped.entries()].map(([worldbookName, entries]) => `
              <details class="worldbook-group">
                <summary>
                  <span>${escapeHtml(worldbookName)}</span>
                  <small>${entries.length} 条</small>
                </summary>
                <div class="worldbook-entry-list">
                  ${entries.map(entry => `
                    <label class="worldbook-entry ${entry.enabledInTavern ? '' : 'disabled'}">
                      <input type="checkbox" data-worldbook-key="${escapeAttr(entry.key)}"
                        ${entry.selectedForWorkbench ? 'checked' : ''}
                        ${entry.enabledInTavern ? '' : 'disabled'}>
                      <span>
                        <strong>${escapeHtml(entry.name)}</strong>
                        <small>${escapeHtml(entry.preview || '空条目')}</small>
                      </span>
                      ${entry.enabledInTavern ? '' : '<em>酒馆已禁用</em>'}
                    </label>`).join('')}
                </div>
              </details>`).join('')}
      </details>`;
  }

  function renderData(current: WorkbenchUiSnapshot | null): string {
    const runtimeLabel = current?.runtime.flowState === 'exploring' ? '墟境探索中' : '现实待机';
    const localCount = (current?.biographies.length ?? 0)
      + (current?.genealogies.length ?? 0)
      + (current?.ruins.length ?? 0)
      + (current?.butterflies.length ?? 0);
    const logs = current?.settings.errorLog ?? [];
    return `
      <section class="section">
        ${sectionHeader('archive', '数据管理', '当前聊天资料隔离、缓存与备份')}
        ${settingRow('聊天存档隔离', '传记、谱系、墟境方案均以当前聊天 ID 为一级索引。', '<span class="scope-badge">已按聊天隔离</span>')}
        ${settingRow('世界书注入镜像', '已退役：蝴蝶原稿只存本地，正文可见性走「蝴蝶记忆注入」通道；此处仅清理旧版自动挂载的镜像世界书。', `<button class="quiet-button" type="button" data-action="retire-mirrors">${icon('trash')}清理镜像</button>`)}
        ${settingRow('当前运行状态', '不在设置页直接改写墟境状态。', `<span class="scope-badge">${runtimeLabel}</span>`)}
        ${settingRow('本地资料库', `${localCount} 条资料；工作台版本 ${current?.version ?? '等待脚本'}。`, `<button class="quiet-button" type="button" data-action="check-data">${icon('shield-check')}检查资料库</button>`)}
        ${settingRow('导出备份', 'API 密钥不会包含在备份中。', `<button class="quiet-button" type="button" data-action="export-data">${icon('download')}导出全部资料</button>`)}
        ${settingRow('清理生成缓存', '删除当前聊天生成的谱系、候选墟境、草稿、临时重点参考人物与未归档的蝴蝶效应结算快照；传记和已归档的蝴蝶效应不受影响。', `<button class="danger-button" type="button" data-action="clear-cache">${icon('trash')}清理缓存</button>`)}
        <section class="error-log">
          <header>
            <div>
              <strong>时间锚诊断</strong>
              <p>最近 20 次墟境生成的自动时间范围、选中人物时间锚命中情况与注入文本（排查「人物时间锚未生效」用）。</p>
            </div>
            <button class="quiet-button" type="button" data-action="refresh-diagnostics">${icon('refresh-cw')}刷新诊断</button>
          </header>
          <div data-diagnostics class="error-log-empty">点击「刷新诊断」查看最近墟境生成的人物时间锚。</div>
        </section>
        <section class="error-log">
          <header>
            <div>
              <strong>Canon 局部状态</strong>
              <p>只读查看当前 revision、蝴蝶效应变更与各产物局部单位是否仍可自动复用；不会改写或删除原稿。</p>
            </div>
            <div>
              <button class="quiet-button" type="button" data-action="refresh-canon">${icon('refresh-cw')}刷新状态</button>
              <button class="quiet-button" type="button" data-action="export-canon" ${canonConsumption ? '' : 'disabled'}>${icon('download')}导出状态</button>
            </div>
          </header>
          ${renderCanonConsumption(canonConsumption)}
        </section>
        <section class="error-log">
          <header>
            <div>
              <strong>低权连续性关系</strong>
              <p>只读查看同 revision 传记事实锚之间的并存视角与来源冲突；不会裁定胜者，也不会改写 Canon。</p>
            </div>
            <div>
              <button class="quiet-button" type="button" data-action="refresh-continuity">${icon('refresh-cw')}刷新关系</button>
              <button class="quiet-button" type="button" data-action="export-continuity" ${continuityInspection ? '' : 'disabled'}>${icon('download')}导出诊断</button>
            </div>
          </header>
          ${renderContinuityInspection(continuityInspection)}
        </section>
        <section class="error-log">
          <header>
            <div>
              <strong>蝴蝶记忆注入</strong>
              <p>正文生成前会把这些「仍有效的改写历史」注入模型（常驻最近变化，更早的按关键词触发；失效片段不注入）。这里可核对是否注入、注入了什么、为什么。</p>
            </div>
            <div>
              <button class="quiet-button" type="button" data-action="refresh-canon-memory">${icon('refresh-cw')}重新计算</button>
              <button class="quiet-button" type="button" data-action="export-canon-memory" ${canonMemory?.snapshot ? '' : 'disabled'}>${icon('download')}导出诊断</button>
            </div>
          </header>
          ${renderCanonMemory(canonMemory)}
        </section>
        <section class="error-log">
          <header>
            <div>
              <strong>错误日志</strong>
              <p>只记录独立生成任务的技术详情，不会显示在其他模块内容区。</p>
            </div>
            <button class="quiet-button" type="button" data-action="clear-errors"
              ${logs.length === 0 ? 'disabled' : ''}>${icon('trash')}清空日志</button>
          </header>
          ${logs.length === 0
            ? '<div class="error-log-empty">当前没有生成错误。</div>'
            : `<div class="error-log-list">${logs.map(item => `
                <article>
                  <div><strong>${escapeHtml(taskName(item.taskType))}</strong>${item.code ? `<em class="error-code">${escapeHtml(item.code)}</em>` : ''}<time>${escapeHtml(formatLogTime(item.occurredAt))}</time></div>
                  <p>${escapeHtml(item.message)}</p>
                </article>`).join('')}</div>`}
        </section>
      </section>`;
  }

  function bind(): void {
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
      button.addEventListener('click', () => {
        tab = button.dataset.tab as SettingsTab;
        status = '';
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>('[data-task]').forEach(button => {
      button.addEventListener('click', () => {
        task = button.dataset.task as GenerationTaskType;
        status = '';
        render();
      });
    });
    root.querySelectorAll<HTMLSelectElement>('[data-retry-task]').forEach(select => {
      select.addEventListener('change', async () => {
        const selectedTask = select.dataset.retryTask as GenerationTaskType;
        const current = settings();
        if (!current) return;
        await persist(
          async () => client.updateSettings({
            retries: {
              ...current.retries,
              [selectedTask]: Number(select.value),
            },
          }),
          `${taskName(selectedTask)}失败重试次数已保存`,
        );
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="apply-all"]')?.addEventListener('click', async () => {
      const next = normalizeCustomSettings(readGenerationForm());
      if (!next.key) {
        error = '请先为当前模块填写独立 API 密钥，再应用到全部模块。';
        status = '';
        render();
        return;
      }
      await persist(
        async () => client.applyGenerationToAll(next),
        '当前模块的独立 API 已应用到四个生成模块',
      );
      TASKS.forEach(item => {
        customDrafts.set(item.id, cloneCustomDraft(next));
        dirtyCustomDrafts.delete(item.id);
      });
    });
    root.querySelector<HTMLInputElement>('#api-timeout')?.addEventListener('change', async event => {
      const seconds = Number((event.currentTarget as HTMLInputElement).value);
      const clamped = Number.isFinite(seconds) ? Math.max(0, Math.min(900, Math.floor(seconds))) : 600;
      (event.currentTarget as HTMLInputElement).value = String(clamped);
      await persist(
        async () => client.updateSettings({ customApiTimeoutMs: clamped * 1000 }),
        '请求超时已保存',
      );
    });
    root.querySelector<HTMLButtonElement>('[data-action="save-api"]')?.addEventListener('click', async () => {
      await saveGeneration(readGenerationForm());
    });
    root.querySelector<HTMLButtonElement>('[data-action="fetch-models"]')?.addEventListener('click', async () => {
      updateCustomDraftFromForm();
      const requestedTask = task;
      const apiurl = root.querySelector<HTMLInputElement>('#api-url')?.value.trim() ?? '';
      const key = root.querySelector<HTMLInputElement>('#api-key')?.value ?? '';
      busy = true;
      error = '';
      status = '正在从接口拉取模型列表';
      render();
      try {
        const models = await client.fetchCustomApiModels(apiurl, key);
        fetchedModels.set(requestedTask, models);
        const draft = customDraftFor(requestedTask);
        customDrafts.set(requestedTask, {
          ...draft,
          model: models.includes(draft.model) ? draft.model : (models[0] ?? draft.model),
        });
        status = `已读取 ${models.length} 个可用模型`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        status = '';
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelector<HTMLInputElement>('#api-url')?.addEventListener('input', updateCustomDraftFromForm);
    root.querySelector<HTMLInputElement>('#api-key')?.addEventListener('input', updateCustomDraftFromForm);
    root.querySelector<HTMLSelectElement>('#api-model')?.addEventListener('change', () => {
      updateCustomDraftFromForm();
      const selected = customDraftFor(task).model || '尚未选择';
      const output = root.querySelector<HTMLOutputElement>('#api-selected-model');
      if (output) output.value = selected;
    });
    root.querySelectorAll<HTMLButtonElement>('[data-appearance]').forEach(button => {
      button.addEventListener('click', async () => {
        const current = settings()?.appearance ?? appearance;
        const name = button.dataset.appearance as keyof WorkbenchAppearance;
        const next = { ...current, [name]: button.dataset.value } as WorkbenchAppearance;
        appearance = next;
        await persist(async () => client.updateSettings({ appearance: next }), '外观设置已保存');
        options.onAppearanceChange?.(next);
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="check-update"]')?.addEventListener('click', async () => {
      await checkForUpdate();
    });
    root.querySelector<HTMLButtonElement>('[data-action="update-extension"]')?.addEventListener('click', async () => {
      await updateExtension();
    });
    root.querySelector<HTMLInputElement>('#merge-aliases')?.addEventListener('change', async event => {
      const current = settings()?.retrieval ?? FALLBACK_SETTINGS.retrieval;
      await saveRetrieval({
        ...current,
        mergeAliases: (event.currentTarget as HTMLInputElement).checked,
      });
    });
    root.querySelector<HTMLInputElement>('[data-worldbook-all]')?.addEventListener('change', async event => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      const selectable = worldbookEntries.filter(entry => entry.enabledInTavern);
      await updateWorldbookSelection(async () => {
        worldbookEntries = await client.setCharacterWorldbookEntriesEnabled(
          selectable.map(entry => entry.key),
          enabled,
        );
      });
    });
    root.querySelectorAll<HTMLInputElement>('[data-worldbook-key]').forEach(input => {
      input.addEventListener('change', async () => {
        const key = input.dataset.worldbookKey;
        if (!key) return;
        await updateWorldbookSelection(async () => {
          worldbookEntries = await client.setCharacterWorldbookEntryEnabled(
            key,
            input.checked,
          );
        });
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="check-data"]')?.addEventListener('click', async () => {
      await runDataAction(async () => {
        const report = await client.inspectCurrentData();
        const total = Object.values(report.counts).reduce((sum, value) => sum + value, 0);
        return report.healthy
          ? `资料库完整：已核验当前聊天${total}条记录`
          : `发现${report.issues.length}项问题：${report.issues.join('；')}`;
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="export-data"]')?.addEventListener('click', async () => {
      await runDataAction(async () => {
        const backup = await client.exportCurrentData();
        downloadJson(
          `eyon-history-${safeFilePart(backup.namespace.chatId)}-${dateStamp()}.json`,
          backup,
        );
        return '当前聊天资料已导出，API 密钥未包含在备份中';
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="clear-cache"]')?.addEventListener('click', async () => {
      if (!globalThis.confirm('将删除当前聊天生成的谱系、候选墟境、草稿、临时重点参考人物与未归档的蝴蝶效应结算快照（失败/残留记录一并清除）。传记和已归档的蝴蝶效应会保留，继续吗？')) {
        return;
      }
      await runDataAction(async () => {
        const result = await client.clearGenerationCache();
        return `生成缓存已清理：删除${result.genealogiesCleared}份谱系、${result.ruinsCleared}组候选墟境、${result.ruinReferencesCleared}名临时重点参考人物与${result.butterflyPendingCleared ?? 0}条蝴蝶待结算`;
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="retire-mirrors"]')?.addEventListener('click', async () => {
      if (!globalThis.confirm('将把旧版自动挂载的蝴蝶镜像世界书从全局绑定里摘掉，并删除其中的镜像条目（脚本自建副本）。\n\n不会删除世界书文件本身，也不会动本地档案与 Canon；继续吗？')) {
        return;
      }
      await runDataAction(async () => {
        const result = await client.retireButterflyMirrors();
        return `镜像已退役：处理 ${result.worldbooks.length} 本世界书、删除 ${result.removedEntries} 条镜像条目；全局世界书剩 ${result.globals.length} 本`;
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="clear-errors"]')?.addEventListener('click', async () => {
      await runDataAction(async () => {
        client.clearErrorLog();
        return '错误日志已清空';
      });
    });
    root.querySelector<HTMLButtonElement>('[data-action="refresh-diagnostics"]')?.addEventListener('click', async () => {
      const list = client.getRuinPresenceDiagnostics();
      const container = root.querySelector<HTMLElement>('[data-diagnostics]');
      if (!container) return;
      if (list.length === 0) {
        container.className = 'error-log-empty';
        container.textContent = '尚无墟境生成诊断（生成一次墟境后再来查看）。';
        return;
      }
      container.className = 'error-log-list';
      container.innerHTML = list.map(entry => {
        const rangeText = entry.range
          ? `${escapeHtml(entry.range.start)} — ${escapeHtml(entry.range.end)}${entry.automatic ? '（自动）' : '（玩家指定）'}`
          : '（无范围）';
        const characters = entry.characters.length === 0
          ? '<p>未选择参与人物。</p>'
          : `<ul>${entry.characters.map(item => `
              <li>${escapeHtml(item.name)}：${item.matched
                ? item.window
                  ? escapeHtml(item.window)
                  : '<em>命中但无生卒信息</em>'
                : '<em>未命中（人物时间锚缺失）</em>'}
              </li>`).join('')}</ul>`;
        return `<article>
          <div><strong>墟境生成</strong><time>${escapeHtml(formatLogTime(entry.occurredAt))}</time><em class="error-code">${escapeHtml(entry.requestId)}</em></div>
          <p>时间范围：${rangeText}</p>
          <p>选中人物时间锚：</p>
          ${characters}
          ${entry.anchorText
            ? `<details><summary>注入的 CHARACTER_TIME_ANCHORS 文本</summary><pre>${escapeHtml(entry.anchorText)}</pre></details>`
            : '<p>（无注入锚文本：未选择人物或人物无窗口）</p>'}
        </article>`;
      }).join('');
    });
    root.querySelector<HTMLButtonElement>('[data-action="refresh-canon"]')?.addEventListener('click', async () => {
      busy = true;
      error = '';
      render();
      try {
        canonConsumption = await client.inspectCurrentArtifactCanonConsumption();
        status = `Canon 状态已刷新：revision ${canonConsumption.branch.headRevision}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelector<HTMLButtonElement>('[data-action="export-canon"]')?.addEventListener('click', () => {
      if (!canonConsumption) return;
      downloadJson(
        `eyon-canon-status-r${canonConsumption.branch.headRevision}-${dateStamp()}.json`,
        canonConsumption,
      );
      showLocalStatus('Canon 局部状态已导出');
    });
    root.querySelector<HTMLButtonElement>('[data-action="refresh-continuity"]')?.addEventListener('click', async () => {
      busy = true;
      error = '';
      render();
      try {
        continuityInspection = await client.inspectCurrentContinuityAnchors();
        status = `连续性关系已刷新：当前 ${continuityInspection.counts.currentRelations} 条`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelector<HTMLButtonElement>('[data-action="export-continuity"]')?.addEventListener('click', () => {
      if (!continuityInspection) return;
      downloadJson(
        `eyon-continuity-relations-r${continuityInspection.canonRevision}-${dateStamp()}.json`,
        continuityInspection,
      );
      showLocalStatus('低权连续性关系诊断已导出');
    });
    root.querySelector<HTMLButtonElement>('[data-action="refresh-canon-memory"]')?.addEventListener('click', async () => {
      busy = true;
      error = '';
      render();
      try {
        const snapshot = await client.refreshCanonMemory();
        canonMemory = { snapshot, failure: '' };
        status = `蝴蝶记忆已重算：常驻 ${snapshot.counts.resident} · 触发 ${snapshot.counts.triggered} · 未命中 ${snapshot.counts.unmatched} · 失效 ${snapshot.counts.filtered}`;
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      } finally {
        busy = false;
        render();
      }
    });
    root.querySelector<HTMLButtonElement>('[data-action="export-canon-memory"]')?.addEventListener('click', () => {
      if (!canonMemory?.snapshot) return;
      downloadJson(
        `eyon-canon-memory-r${canonMemory.snapshot.headRevision}-${dateStamp()}.json`,
        canonMemory.snapshot,
      );
      showLocalStatus('蝴蝶记忆诊断已导出');
    });
  }

  function readGenerationForm(): GenerationSettings {
    updateCustomDraftFromForm();
    const existing = settings()?.generation[task];
    return cloneCustomDraft(customDrafts.get(task) ?? existing ?? EMPTY_CUSTOM);
  }

  async function saveGeneration(next: GenerationSettings): Promise<void> {
    const normalized = normalizeCustomSettings(next);
    if (!normalized.key) {
      error = '独立 API 密钥不能为空。请填写密钥后再保存。';
      status = '';
      render();
      return;
    }
    const saved = await persist(
      async () => client.setGeneration(task, normalized),
      `${TASKS.find(item => item.id === task)?.label ?? '模块'}设置已保存`,
    );
    if (saved) {
      customDrafts.set(task, cloneCustomDraft(normalized));
      dirtyCustomDrafts.delete(task);
    }
  }

  function normalizeCustomSettings(custom: CustomApiSettings): CustomApiSettings {
    return {
      ...custom,
      apiurl: normalizeCustomApiBaseUrl(custom.apiurl),
      key: normalizeCustomApiKey(custom.key),
      model: custom.model.trim(),
    };
  }

  async function saveRetrieval(
    next: WorkbenchSettings['retrieval'],
  ): Promise<void> {
    await persist(
      async () => client.updateSettings({ retrieval: next }),
      '资料检索设置已保存',
    );
  }

  function showLocalStatus(message: string): void {
    error = '';
    status = message;
    render();
  }

  async function runDataAction(action: () => Promise<string>): Promise<void> {
    busy = true;
    error = '';
    render();
    try {
      status = await action();
      snapshot = await client.readSnapshot();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      render();
    }
  }

  async function checkForUpdate(): Promise<void> {
    busy = true;
    error = '';
    updateState = {
      ...updateState,
      message: '正在读取远端稳定版信息…',
    };
    render();
    try {
      const remoteManifestUrl = `${REMOTE_MANIFEST_URL}?workbench=${encodeURIComponent(CURRENT_EXTENSION_VERSION)}&t=${Date.now()}`;
      const response = await fetch(remoteManifestUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error(`远程清单请求失败（HTTP ${response.status}）`);
      const manifest = await response.json() as { version?: unknown };
      const latest = typeof manifest.version === 'string' ? manifest.version.trim() : '';
      if (!latest) throw new Error('远程清单没有可识别的版本号');
      const available = compareVersions(latest, CURRENT_EXTENSION_VERSION) > 0;
      updateState = {
        latest,
        available,
        message: available
          ? `发现新版本 ${latest}（当前 ${WORKBENCH_VERSION_LABEL}／${CURRENT_EXTENSION_VERSION}），可点击右侧按钮更新。`
          : `当前已是最新稳定版（${WORKBENCH_VERSION_LABEL}／${CURRENT_EXTENSION_VERSION}）。`,
      };
    } catch (cause) {
      updateState = {
        ...updateState,
        message: `检查更新失败：${cause instanceof Error ? cause.message : String(cause)}`,
      };
      error = updateState.message;
    } finally {
      busy = false;
      render();
    }
  }

  async function updateExtension(): Promise<void> {
    if (!updateState.available || !updateState.latest) return;
    busy = true;
    error = '';
    updateState = { ...updateState, message: `正在请求酒馆更新到 ${updateState.latest}…` };
    render();
    try {
      const globalObject = globalThis as Record<string, unknown>;
      // Tavern Helper 的扩展管理 API 属于宿主桥，标准入口是
      // TavernHelper.updateExtension；脚本可能运行在消息 iframe 或工作台
      // 影子根所在窗口，因此通过统一解析器同时检查父/顶层宿主。
      const directUpdater = globalObject.updateExtension;
      const updater = typeof directUpdater === 'function'
        ? directUpdater as (extensionId: string) => Promise<Response>
        : resolveTavernHelperFunction<
            (extensionId: string) => Promise<Response>
          >(globalObject, 'updateExtension');
      if (typeof updater !== 'function') {
        throw new Error('当前酒馆未暴露 updateExtension 接口，请在扩展管理器中手动更新');
      }
      const response = await (updater as (extensionId: string) => Promise<Response>)(EXTENSION_ID);
      if (!response?.ok) {
        throw new Error(`酒馆更新请求失败${response?.status ? `（HTTP ${response.status}）` : ''}`);
      }
      updateState = {
        ...updateState,
        available: false,
        message: `已请求酒馆更新到 ${updateState.latest}；刷新页面后生效。`,
      };
      status = '更新请求已提交，请刷新酒馆使新版本生效。';
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      updateState = { ...updateState, message: error };
    } finally {
      busy = false;
      render();
    }
  }

  async function persist(action: () => Promise<unknown> | unknown, message: string): Promise<boolean> {
    busy = true;
    error = '';
    try {
      const result = await action();
      status = message;
      if (isWorkbenchSettings(result) && snapshot) {
        snapshot = { ...snapshot, settings: result };
      } else if (isLauncherPatch(result)) {
        // β1：启动开关已退役。旧版留下的 workbenchEnabled 只有 schema 兼容意义，
        // 不再驱动任何可见状态，也不再阻断工作流（避免历史 false 把工作台锁死）。
      } else if (client.isReady()) {
        snapshot = await client.readSnapshot();
      } else {
        // Settings writes are still accepted while the runtime is waiting for
        // Tavern Helper/MVU; do not turn a valid write into a false
        // "runtime failed" message.
        return true;
      }
      if (snapshot) {
        appearance = snapshot.settings.appearance;
        syncCustomDrafts(snapshot.settings);
      }
      return true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      return false;
    } finally {
      busy = false;
      render();
    }
  }

  function customDraftFor(
    selectedTask: GenerationTaskType,
    fallback?: CustomApiSettings,
  ): CustomApiSettings {
    const existing = customDrafts.get(selectedTask);
    if (existing) return existing;
    const draft = cloneCustomDraft(fallback ?? EMPTY_CUSTOM);
    customDrafts.set(selectedTask, draft);
    return draft;
  }

  function updateCustomDraftFromForm(): void {
    const existing = customDraftFor(task);
    customDrafts.set(task, {
      ...existing,
      apiurl: root.querySelector<HTMLInputElement>('#api-url')?.value.trim() ?? existing.apiurl,
      key: root.querySelector<HTMLInputElement>('#api-key')?.value ?? existing.key,
      model: root.querySelector<HTMLSelectElement>('#api-model')?.value.trim() ?? existing.model,
    });
    dirtyCustomDrafts.add(task);
  }

  function syncCustomDrafts(current: WorkbenchSettings): void {
    TASKS.forEach(item => {
      if (!dirtyCustomDrafts.has(item.id)) {
        customDrafts.set(item.id, cloneCustomDraft(current.generation[item.id]));
      }
    });
  }

  async function updateWorldbookSelection(action: () => Promise<void>): Promise<void> {
    busy = true;
    error = '';
    render();
    try {
      await action();
      status = '工作台世界书资料范围已保存';
      snapshot = await client.readSnapshot();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      render();
    }
  }

  render();
  void refresh();

  return {
    refresh,
    setTheme(theme) {
      appearance = { ...appearance, mode: theme };
      host.dataset.theme = theme;
      applyAppearance(host, appearance);
    },
    setAppearance(nextAppearance) {
      appearance = nextAppearance;
      host.dataset.theme = nextAppearance.mode;
      applyAppearance(host, nextAppearance);
    },
    dispose() {
      disposed = true;
      container.replaceChildren();
    },
  };
}

function renderContinuityInspection(report: ContinuityInspection | null): string {
  if (!report) {
    return '<div class="error-log-empty">点击「刷新关系」读取当前 revision 的低权连续性关系。</div>';
  }
  const claims = new Map(report.anchors.map(anchor => [anchor.anchorId, anchor.claim]));
  const rows = report.relations.length === 0
    ? '<p>当前没有可用的并存视角或来源冲突。</p>'
    : report.relations.map(relation => {
      const kind = relation.kind === 'parallelView' ? '并存视角' : '来源冲突';
      const members = relation.memberAnchorIds.map(anchorId => claims.get(anchorId) ?? '对应事实锚当前不可见');
      return `<article>
        <div><strong>${escapeHtml(kind)}</strong><em class="error-code">${escapeHtml(relation.dimension)}</em></div>
        <p>视角一：${escapeHtml(members[0] ?? '')}</p>
        <p>视角二：${escapeHtml(members[1] ?? '')}</p>
        <p>来源数：${relation.sourceRefs.length}；当前仅作低权提示，不自动裁定胜者。</p>
      </article>`;
    }).join('');
  const diagnosticCounts = new Map<string, number>();
  for (const item of report.relationDiagnostics) {
    diagnosticCounts.set(item.code, (diagnosticCounts.get(item.code) ?? 0) + 1);
  }
  const diagnostics = diagnosticCounts.size === 0
    ? '暂无关系诊断。'
    : [...diagnosticCounts.entries()].map(([code, count]) => `${code} × ${count}`).join('；');
  return `<div class="canon-summary">
    <p>revision ${report.canonRevision} · 当前事实锚 ${report.counts.currentAnchors} · 当前关系 ${report.counts.currentRelations}</p>
    <p>并存视角 ${report.counts.parallelViews} · 来源冲突 ${report.counts.sourceConflicts} · 已存但当前不可用 ${Math.max(0, report.counts.storedRelations - report.counts.currentRelations)}</p>
    <p>${escapeHtml(diagnostics)}</p>
  </div><div class="error-log-list">${rows}</div>`;
}

function renderCanonMemory(inspection: CanonMemoryInspection | null): string {
  if (!inspection?.snapshot) {
    return '<div class="error-log-empty">尚无注入快照：点击「重新计算」，或在正文生成/切聊天/遣返结算后自动刷新。'
      + (inspection?.failure ? ` 最近一次失败：${escapeHtml(inspection.failure)}` : '')
      + '</div>';
  }
  const snapshot: CanonMemorySnapshotView = inspection.snapshot;
  const statusBadge = snapshot.injectedText
    ? `<span class="scope-badge">注入中 · 正史 ${snapshot.counts.resident + snapshot.counts.triggered} 条 · 传记 ${snapshot.continuity.anchorCount} 条</span>`
    : '<span class="scope-badge">未注入（无有效条目命中）</span>';
  const rows = snapshot.entries.length === 0
    ? '<div class="error-log-empty">当前聊天还没有已归档的蝴蝶效应档案。</div>'
    : `<div class="error-log-list">${snapshot.entries.map(entry => {
      const label = entry.status === 'resident'
        ? '常驻'
        : entry.status === 'triggered'
          ? `触发（分 ${entry.score}）`
          : entry.status === 'unmatched'
            ? '未命中'
            : '已失效·不注入';
      return `
        <article>
          <header>
            <strong>R${entry.revision}｜${escapeHtml(entry.title)}</strong>
            <span class="scope-badge">${label}</span>
          </header>
          <p>硬词：${entry.hardKeywords.length ? escapeHtml(entry.hardKeywords.slice(0, 8).join('、')) : '（无）'}${entry.softKeywords.length ? `；软词：${escapeHtml(entry.softKeywords.slice(0, 6).join('、'))}` : ''}</p>
          ${entry.hits.length ? `<p>命中：${escapeHtml(entry.hits.join('、'))}</p>` : ''}
          <p class="error-log-meta">${escapeHtml(entry.reasons.join(' · '))}</p>
        </article>`;
    }).join('')}</div>`;
  return `
    <div class="error-log-list">
      <article>
        <header>
          <strong>当前注入状态</strong>
          ${statusBadge}
        </header>
        <p>revision ${snapshot.headRevision} · 最近刷新：${escapeHtml(snapshot.trigger)} · ${new Date(snapshot.computedAt).toLocaleString()}</p>
        <p>档案合计 ${snapshot.counts.total}：常驻 ${snapshot.counts.resident} · 触发 ${snapshot.counts.triggered} · 未命中 ${snapshot.counts.unmatched} · 已失效 ${snapshot.counts.filtered}</p>
        <p>源 A 紧凑残片 ${snapshot.tombstoneCount} 条；源 B 传记锚 ${snapshot.continuity.anchorCount} · 未决关系 ${snapshot.continuity.relationCount} · 预算省略 ${snapshot.continuity.omittedCount}</p>
        ${snapshot.continuity.warnings.length ? `<p class="error-log-meta">源 B 降级：${escapeHtml(snapshot.continuity.warnings.join('；'))}</p>` : ''}
        ${inspection.failure ? `<p class="error-log-meta">最近一次注入失败：${escapeHtml(inspection.failure)}</p>` : ''}
        ${snapshot.injectedText
          ? `<details><summary>查看实际注入正文（${snapshot.injectedText.length} 字符）</summary><pre>${escapeHtml(snapshot.injectedText)}</pre></details>`
          : ''}
      </article>
    </div>
    <p class="error-log-meta">逐条判定（常驻=最近有效变化必注入；触发=关键词命中；未命中=有效但与本轮话题无关；已失效=reverted/orphaned/superseded，普通正文永不注入）：</p>
    ${rows}`;
}

function renderCanonConsumption(report: CanonConsumptionInspection | null): string {
  if (!report) {
    return '<div class="error-log-empty">点击「刷新状态」读取当前聊天的 Canon 变化与局部产物状态。</div>';
  }
  const summary = [
    `revision ${report.branch.headRevision}`,
    `${report.branch.active} 项活动变更`,
    `${report.counts.excluded} 个明确失效单位`,
    `${report.counts.manualReview} 个待判断单位`,
  ].join(' · ');
  const changes = report.changes.length === 0
    ? '<p>当前聊天尚无蝴蝶效应 Canon 变更。</p>'
    : `<details open><summary>变更日志（${report.changes.length}/${report.branch.revisions}）</summary>
        <ul>${report.changes.map(change => `
          <li><strong>R${change.revision} · ${escapeHtml(canonRevisionStatus(change.status))}</strong>
            ${escapeHtml(change.actionRecord || change.rawCommand || change.deltaId)}
            <em>${change.operations.length} 项事实操作</em></li>`).join('')}</ul>
      </details>`;
  const decisions = report.decisions.length === 0
    ? '<p>当前资料尚无可评估的 Canon 绑定。</p>'
    : `<details><summary>局部产物状态（${report.decisions.length}）</summary>
        <ul>${report.decisions.map(item => `
          <li><strong>${escapeHtml(artifactTypeLabel(item.artifactType))} · ${escapeHtml(item.unitType)}</strong>
            ${escapeHtml(item.unitId)}
            <em>${escapeHtml(canonDispositionLabel(item.disposition))}</em></li>`).join('')}</ul>
      </details>`;
  const causal = report.causalPreview.status === 'no-conflict'
    ? `<details><summary>因果冲突只读预演 · 未发现明确冲突</summary>
        <p>已记录 ${report.causalPreview.counts.recordedBases} 个因果基点、${report.causalPreview.counts.supportUnits} 条支撑；旧记录或无法安全归并的 ${report.causalPreview.counts.opaqueOperations} 项保持不透明。</p>
      </details>`
    : `<details open><summary>因果冲突只读预演 · ${escapeHtml(causalPreviewStatusLabel(report.causalPreview.status))}</summary>
        <p><strong>这只是预演，不会让任何历史自动失效，也不会改写正文。</strong></p>
        <p>明确冲突根 ${report.causalPreview.counts.conflictRoots} · 可能受影响 ${report.causalPreview.counts.affectedOperations} · 支撑断裂 ${report.causalPreview.counts.brokenSupports} · 支撑仍存 ${report.causalPreview.counts.survivingSupports}</p>
        ${report.causalPreview.conflictRoots.length === 0 ? '' : `<ul>${report.causalPreview.conflictRoots.map(root => `
          <li><strong>${escapeHtml(causalConflictReasonLabel(root.reason))}</strong>
            ${escapeHtml(root.changedBy.factKey)} → ${escapeHtml(causalRefLabel(root.affectedRef))}</li>`).join('')}</ul>`}
        ${report.causalPreview.affectedOperations.length === 0 ? '' : `<ul>${report.causalPreview.affectedOperations.map(item => `
          <li>${escapeHtml(item.operationRef.factKey)} <em>${escapeHtml(causalOperationStateLabel(item.state))}</em></li>`).join('')}</ul>`}
        ${report.causalPreview.warnings.length === 0 ? '' : `<p class="error-log-meta">边界提示：${escapeHtml(report.causalPreview.warnings.join('；'))}</p>`}
      </details>`;
  const rebaseCounts = new Map<string, number>();
  for (const item of report.causalRebase.operationStates) {
    rebaseCounts.set(item.state, (rebaseCounts.get(item.state) ?? 0) + 1);
  }
  const rebase = `<details open><summary>确定性局部重基线 · ${report.causalRebase.status === 'projected' ? '已生效' : '已在安全边界停止'}</summary>
      <p><strong>这是当前分支实际采用的 operation 状态；全程零模型调用。</strong></p>
      <p>活动 ${rebaseCounts.get('active') ?? 0} · 被取代 ${rebaseCounts.get('superseded') ?? 0} · 失去支撑 ${rebaseCounts.get('orphaned') ?? 0} · 不确定 ${rebaseCounts.get('uncertain') ?? 0} · 已回滚 ${rebaseCounts.get('reverted') ?? 0}</p>
      ${report.causalRebase.operationStates.every(item => item.state === 'active') ? '' : `<ul>${report.causalRebase.operationStates
        .filter(item => item.state !== 'active')
        .map(item => `<li>${escapeHtml(item.operationRef.factKey)} <em>${escapeHtml(causalRebaseStateLabel(item.state))}</em></li>`).join('')}</ul>`}
      ${report.causalRebase.warnings.length === 0 ? '' : `<p class="error-log-meta">边界提示：${escapeHtml(report.causalRebase.warnings.join('；'))}</p>`}
    </details>`;
  const reconciles = report.causalReconciles ?? [];
  const reconcile = reconciles.length === 0
    ? '<details><summary>局部因果协调 · 本分支未调用模型</summary><p>确定性路径保持零模型调用。</p></details>'
    : `<details open><summary>局部因果协调 · ${reconciles.length} 次</summary>
        <ul>${reconciles.map(item => `<li><strong>R${item.canonRevision} · ${escapeHtml(item.status)}</strong>
          模型 ${item.modelCalls} 次 · 结构修复 ${item.repairCalls} 次 · 接受 ${item.acceptedProposalCount} · 丢弃 ${item.droppedProposalCount}
          ${item.failureCode ? `<em>${escapeHtml(item.failureCode)}</em>` : ''}</li>`).join('')}</ul>
      </details>`;
  return `<div class="error-log-list">
    <article>
      <div><strong>${escapeHtml(summary)}</strong></div>
      <p>部分失效只警告；只有 stale/orphaned 会阻止自动复用，不确定项不会被脚本擅自判废。</p>
       ${changes}
       ${rebase}
       ${reconcile}
       ${causal}
       ${decisions}
    </article>
  </div>`;
}

function causalRebaseStateLabel(
  state: 'active' | 'superseded' | 'orphaned' | 'uncertain' | 'reverted',
): string {
  return {
    active: '继续有效',
    superseded: '已被明确取代',
    orphaned: '已失去全部确定支撑',
    uncertain: '不确定，停止传播',
    reverted: '所属版本已回滚',
  }[state];
}

function causalPreviewStatusLabel(status: 'no-conflict' | 'conflict-preview' | 'bounded-overflow'): string {
  return {
    'no-conflict': '未发现明确冲突',
    'conflict-preview': '发现可能断裂的因果链',
    'bounded-overflow': '超过安全预演边界',
  }[status];
}

function causalConflictReasonLabel(
  reason: 'operation-replaced' | 'delta-superseded' | 'support-fact-replaced',
): string {
  return {
    'operation-replaced': '既有事实被明确替换',
    'delta-superseded': '既有干涉被明确取代',
    'support-fact-replaced': '支撑事实被明确替换',
  }[reason];
}

function causalOperationStateLabel(
  state: 'would-remain-active' | 'would-be-superseded' | 'would-be-orphaned' | 'uncertain' | 'opaque',
): string {
  return {
    'would-remain-active': '仍有支撑·不会断裂',
    'would-be-superseded': '冲突根·可能被取代',
    'would-be-orphaned': '全部支撑断裂',
    uncertain: '证据不足·停止推演',
    opaque: '旧记录/不透明·停止推演',
  }[state];
}

function causalRefLabel(reference: {
  kind: 'fact'; factId: string;
} | {
  kind: 'operation'; operationRef: { deltaId: string; factKey: string };
} | {
  kind: 'action'; actionId: string;
}): string {
  if (reference.kind === 'fact') return reference.factId;
  if (reference.kind === 'action') return reference.actionId;
  return reference.operationRef.factKey;
}

function canonRevisionStatus(status: 'active' | 'reverted' | 'orphaned'): string {
  return { active: '当前有效', reverted: '已回滚', orphaned: '已孤立' }[status];
}

function artifactTypeLabel(type: 'biography' | 'genealogy' | 'ruin' | 'butterfly'): string {
  return {
    biography: '传记', genealogy: '宗族谱系', ruin: '墟境', butterfly: '蝴蝶效应',
  }[type];
}

function canonDispositionLabel(
  disposition: 'available' | 'available-with-warning' | 'excluded' | 'manual-review',
): string {
  return {
    available: '可用',
    'available-with-warning': '部分变化·保留',
    excluded: '明确失效·停止自动复用',
    'manual-review': '待人工判断·不自动判废',
  }[disposition];
}

function sectionHeader(
  iconName: WorkbenchIconName,
  title: string,
  detail = '',
): string {
  return `
    <header class="section-header">
      <div class="section-title">
        ${icon(iconName)}
        <div><h2>${title}</h2>${detail ? `<p>${detail}</p>` : ''}</div>
      </div>
    </header>`;
}

function settingRow(title: string, detail: string, control: string): string {
  return `
    <div class="setting-row">
      <div class="setting-copy"><strong>${title}</strong><p>${detail}</p></div>
      <div class="setting-control">${control}</div>
    </div>`;
}

function appearanceHeading(title: string, detail: string): string {
  return `<div class="appearance-heading"><strong>${title}</strong><p>${detail}</p></div>`;
}

function taskName(taskType: GenerationTaskType): string {
  return TASKS.find(item => item.id === taskType)?.label ?? taskType;
}

function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function appearanceChoice(
  name: keyof WorkbenchAppearance,
  value: string,
  selected: string,
  iconName: WorkbenchIconName,
  label: string,
  detail: string,
): string {
  return `
    <button class="appearance-choice" type="button" data-appearance="${name}" data-value="${value}"
      aria-pressed="${selected === value}">
      ${icon(iconName)}<span><strong>${label}</strong><small>${detail}</small></span>
    </button>`;
}

function paletteChoice(
  name: keyof WorkbenchAppearance,
  value: string,
  selected: string,
  iconName: WorkbenchIconName,
  sample: string,
  label: string,
  detail: string,
): string {
  return `
    <button class="palette-choice" type="button" data-appearance="${name}" data-value="${value}"
      aria-pressed="${selected === value}">
      <span class="palette-icon" style="--sample:${sample}">${icon(iconName)}</span>
      <span class="choice-copy"><strong>${label}</strong><small>${detail}</small></span>
    </button>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function renderModelOptions(models: string[], selected: string): string {
  const values = [...new Set([
    ...(selected.trim() ? [selected.trim()] : []),
    ...models,
  ])];
  if (!values.length) {
    return '<option value="">请先拉取模型列表</option>';
  }
  return values.map(model => `
    <option value="${escapeAttr(model)}" ${model === selected ? 'selected' : ''}>
      ${escapeHtml(model)}
    </option>`).join('');
}

function cloneCustomDraft(value: CustomApiSettings): CustomApiSettings {
  return { ...value };
}

function isWorkbenchSettings(value: unknown): value is WorkbenchSettings {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WorkbenchSettings>;
  return Boolean(candidate.generation && candidate.appearance && candidate.retrieval);
}

function isLauncherPatch(
  value: unknown,
): value is Pick<WorkbenchSettings, 'workbenchEnabled'> {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as { workbenchEnabled?: unknown }).workbenchEnabled === 'boolean',
  );
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value
    .replace(/^v/iu, '')
    .split(/[.-]/u)
    .map(part => Number.parseInt(part, 10))
    .map(value => Number.isFinite(value) ? value : 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeFilePart(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_');
  return normalized || 'chat';
}

function dateStamp(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
