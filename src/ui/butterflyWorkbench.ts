import { WorkbenchUiClient } from './workbenchClient.ts';
import { applyAppearance, type WorkbenchAppearance } from './appearance.ts';
import { preserveDomState, ViewRefreshGuard } from './viewRefresh.ts';
import {
  BUTTERFLY_OPTIONS, BUTTERFLY_PRESETS, DEFAULT_BUTTERFLY_REFERENCES,
  randomButterflyReferences,
} from '../core/creativeReferences.ts';
import {
  BUTTERFLY_FIELD_LABELS, BUTTERFLY_PRESET_LABELS,
  butterflyOptionCopy, butterflyAbsurdityCopy, butterflyStylePreview,
} from './butterflyReferencePresentation.ts';
import ruinCss from './ruinWorkbench.css?raw';
import creativeCss from './creativeWorkbench.css?raw';

export function mountButterflyWorkbench(container: HTMLElement, client: WorkbenchUiClient) {
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  container.append(host);
  const reads = new ViewRefreshGuard(() => client.contextRevision());
  let refs = { ...DEFAULT_BUTTERFLY_REFERENCES };
  let runId = '';
  let confirmed = false;
  let locked = true;
  let theme: 'light' | 'dark' = 'light';
  let error = '';
  let saving = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let returning = false;
  let pendingRun = '';
  let saveEpoch = 0;
  let referenceRevision = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let editing = false;
  let composing = false;
  let deferredRender = false;
  root.addEventListener('compositionstart', () => {
    composing = true; editing = true;
    if (debounce) clearTimeout(debounce); debounce = null;
  });
  root.addEventListener('compositionend', () => {
    composing = false;
    const epoch = saveEpoch;
    // 最终 input 先落到本地草稿，不能把拼音预编辑文本写入保存队列。
    setTimeout(() => {
      if (disposed || epoch !== saveEpoch) return;
      markEdited();
      if (deferredRender) { deferredRender = false; render(); }
    }, 0);
  });
  const offContext = client.onContextChanged(() => {
    saveEpoch++; queue = Promise.resolve(); saving = 0; returning = false; editing = false;
    composing = false; deferredRender = false;
    if (debounce) clearTimeout(debounce); debounce = null;
    reads.invalidate(); runId = ''; pendingRun = ''; locked = true; confirmed = false; refs = { ...DEFAULT_BUTTERFLY_REFERENCES }; error = ''; render();
  });
  const offData = client.onDataChanged(detail => { if (detail.views.includes('ruin')) void refresh(); });
  const offStatus = client.onStatus(detail => {
    if (detail.taskType === 'butterfly' && !detail.request && !saving) void refresh();
  });

  async function refresh(): Promise<void> {
    if (disposed || !client.isReady()) return;
    const current = reads.begin();
    const capturedReferenceRevision = referenceRevision;
    try {
      const [runtime, saved, pending] = await Promise.all([
        client.facade().getRuinRuntimeSnapshot(), client.facade().getButterflyReferences(),
        client.facade().listButterflyPending(),
      ]);
      if (!current()) return;
      const previousRun = runId, previousLocked = locked;
      locked = !saved || !['exploring', 'anchored'].includes(runtime.flowState);
      if (saved && ((!saving && !editing && capturedReferenceRevision === referenceRevision) || runId !== saved.runId)) {
        refs = { ...saved.references }; runId = saved.runId; confirmed = saved.confirmed;
      }
      pendingRun = pending.find(item => item.failure)?.runId ?? '';
      if (!saved) { runId = ''; confirmed = false; }
      render(previousRun !== runId || previousLocked !== locked);
    } catch (cause) {
      if (current()) { error = message(cause); render(); }
    }
  }

  function save(confirm: boolean): Promise<unknown> {
    if (composing) return Promise.resolve();
    if (debounce) clearTimeout(debounce); debounce = null; editing = false;
    const capturedRun = runId;
    const capturedRefs = { ...refs };
    const capturedReferenceRevision = ++referenceRevision;
    const revision = client.contextRevision();
    const epoch = saveEpoch;
    confirmed = false; saving++;
    queue = queue.catch(() => undefined).then(async () => {
      if (disposed || epoch !== saveEpoch || client.contextRevision() !== revision || runId !== capturedRun) return;
      await client.facade().setButterflyReferences(capturedRun, capturedRefs, confirm);
      if (!disposed && client.contextRevision() === revision && runId === capturedRun && confirm
        && referenceRevision === capturedReferenceRevision && !editing) confirmed = true;
    }).catch(cause => {
      if (!disposed && client.contextRevision() === revision && runId === capturedRun) { error = message(cause); confirmed = false; }
    }).finally(() => { if (epoch === saveEpoch) { saving--; if (!disposed) updateControls(); } });
    return queue;
  }
  function markEdited(): void {
    referenceRevision++;
    if (confirmed && !composing) void save(false);
    editing = true; confirmed = false;
    root.querySelector('[data-return]')?.setAttribute('disabled', '');
    const badge = root.querySelector('.confirmation-state');
    if (badge) badge.textContent = '本轮方案待确认';
    if (debounce) clearTimeout(debounce);
    if (!composing) debounce = setTimeout(() => void save(false), 500);
    updateControls();
  }

  function updateControls(): void {
    const badge = root.querySelector('.confirmation-state');
    if (badge) badge.textContent = locked ? '进入墟境后解锁' : confirmed ? '本轮方案已确认' : saving ? '正在保存…' : '本轮方案待确认';
    const confirmButton = root.querySelector<HTMLButtonElement>('[data-confirm]');
    if (confirmButton) { confirmButton.disabled = locked || returning || Boolean(saving); confirmButton.textContent = confirmed ? '方案已确认' : '确认本轮参考方案'; }
    const returnButton = root.querySelector<HTMLButtonElement>('[data-return]');
    if (returnButton) returnButton.disabled = locked || !confirmed || Boolean(saving) || returning;
    const feedback = root.querySelector<HTMLElement>('[data-console-error]');
    if (feedback) { feedback.textContent = error; feedback.hidden = !error; }
    const preview = root.querySelector('[data-style-preview]');
    if (preview && !composing) preview.textContent = butterflyStylePreview(refs);
  }

  function render(force = false): void {
    if (disposed) return;
    if (composing) { deferredRender = true; return; }
    // 保存/资料通知只刷新状态，不替换玩家仍在编辑或拖动的节点。
    if (!force && !locked && !returning && root.activeElement?.matches('[data-focus], [data-absurdity]')) { updateControls(); return; }
    const restore = preserveDomState(root);
    const disabled = locked || returning;
    root.innerHTML = `<style>${ruinCss}\n${creativeCss}</style>
      <main class="ruin-app butterfly-console" data-theme="${theme}">
        <header class="creative-heading"><div><span class="ruin-eyebrow">THE SHAPE OF A RIPPLE</span>
          <h2>蝴蝶效应控制台</h2><p>调整故事倾向，不预定结局。</p></div>
          <span class="confirmation-state">${locked ? '进入墟境后解锁' : confirmed ? '本轮方案已确认' : saving ? '正在保存…' : '本轮方案待确认'}</span></header>
        ${locked ? '<div class="empty-state"><strong>先走进一段历史</strong><p>进入墟境后设置本轮偏好；其他轮次的方案不会带进来。</p></div>' : `
        <section class="reference-presets" aria-label="默认参考方案">
          ${BUTTERFLY_PRESETS.map((preset, i) => `<button type="button" class="quiet-button" data-preset="${i}" ${disabled ? 'disabled' : ''}>${escape(BUTTERFLY_PRESET_LABELS[preset.name] ?? preset.name)}</button>`).join('')}
          <button type="button" class="quiet-button" data-random ${disabled ? 'disabled' : ''}>⚄ 随机一组</button>
        </section>
        <div class="butterfly-reference-grid">
          <section class="reference-group reference-group--focus" aria-label="影响重点"><header><span aria-hidden="true">01</span><h3>影响重点</h3></header>
            ${select('scope')}
            <label class="field"><strong>重点看谁</strong><input data-focus value="${escape(refs.focus)}" placeholder="人物、地方或事业；可留空" ${disabled ? 'disabled' : ''}></label>
            ${select('domain')}
          </section>
          <section class="reference-group reference-group--history" aria-label="历史发展"><header><span aria-hidden="true">02</span><h3>历史发展</h3></header>
            ${select('intensity')}
            <label class="field"><strong>离奇程度 <output data-absurdity-label>${refs.absurdity}　${butterflyAbsurdityCopy(refs.absurdity)[0]}</output></strong>
              <input type="range" aria-label="离奇程度" min="0" max="100" step="1" data-absurdity value="${refs.absurdity}" ${disabled ? 'disabled' : ''}></label>
            ${select('evolution')}
          </section>
          <section class="reference-group reference-group--experience" aria-label="阅读体验"><header><span aria-hidden="true">03</span><h3>阅读体验</h3></header>
            ${select('legend')}${select('mood')}${select('manifestation')}
          </section>
        </div>
        <footer class="creative-actions">
          <button type="button" class="primary-button" data-confirm ${disabled || saving ? 'disabled' : ''}>${confirmed ? '方案已确认' : '确认本轮参考方案'}</button>
          <button type="button" class="quiet-button" data-return ${!confirmed || saving || returning ? 'disabled' : ''}>${returning ? '正在准备归返…' : '遣返现世'}</button>
        </footer><p class="field-note">确认方案后才能遣返；重点对象可留空。</p>`}
        ${pendingRun ? `<button type="button" class="quiet-button" data-retry ${returning ? 'disabled' : ''}>重试已冻结的蝴蝶效应</button>` : ''}
        <p class="error-message" data-console-error role="alert" ${error ? '' : 'hidden'}>${escape(error)}</p>
        ${locked ? '' : `<section class="butterfly-style-preview" aria-label="当前组合风格提示">
          <h3>这组可能写出…</h3><p data-style-preview role="status" aria-live="polite"></p>
          <small>仅提示风格；实际行动与史实优先，不预定结局。</small>
        </section>`}
      </main>`;
    root.querySelectorAll<HTMLSelectElement>('[data-reference]').forEach(element => element.addEventListener('change', () => {
      refs = { ...refs, [element.dataset.reference!]: element.value }; error = ''; void save(false); render();
    }));
    root.querySelector<HTMLInputElement>('[data-focus]')?.addEventListener('input', event => {
      refs.focus = (event.currentTarget as HTMLInputElement).value; markEdited();
    });
    root.querySelector<HTMLInputElement>('[data-absurdity]')?.addEventListener('input', event => {
      refs.absurdity = Number((event.currentTarget as HTMLInputElement).value);
      const output = root.querySelector('[data-absurdity-label]');
      if (output) output.textContent = `${refs.absurdity}　${butterflyAbsurdityCopy(refs.absurdity)[0]}`;
      markEdited();
    });
    root.querySelector('[data-absurdity]')?.addEventListener('change', () => void save(false));
    root.querySelector('[data-focus]')?.addEventListener('change', () => void save(false));
    root.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach(button => button.addEventListener('click', () => {
      refs = { ...BUTTERFLY_PRESETS[Number(button.dataset.preset)].references }; void save(false); render();
    }));
    root.querySelector('[data-random]')?.addEventListener('click', () => {
      refs = { ...randomButterflyReferences(), focus: refs.focus }; void save(false); render();
    });
    root.querySelector('[data-confirm]')?.addEventListener('click', () => { error = ''; void save(true); render(); });
    root.querySelector('[data-return]')?.addEventListener('click', () => void act(() => client.facade().returnRuin()));
    root.querySelector('[data-retry]')?.addEventListener('click', () => void act(() => client.facade().retryButterfly(pendingRun)));
    updateControls();
    restore();
  }
  function select(key: keyof typeof BUTTERFLY_OPTIONS): string {
    return `<label class="field"><strong>${BUTTERFLY_FIELD_LABELS[key]}</strong><select data-reference="${key}" ${locked || returning ? 'disabled' : ''}>
      ${BUTTERFLY_OPTIONS[key].map(value => `<option value="${escape(value)}" ${refs[key] === value ? 'selected' : ''}>${escape(butterflyOptionCopy(key, value)[0])}</option>`).join('')}</select></label>`;
  }
  async function act(work: () => Promise<unknown>): Promise<void> {
    if (returning) return;
    const revision = client.contextRevision();
    returning = true; error = ''; render();
    try { await work(); } catch (cause) { if (revision === client.contextRevision()) error = message(cause); }
    finally { if (!disposed && revision === client.contextRevision()) { returning = false; await refresh(); } }
  }
  render();
  return {
    refresh,
    setAppearance(appearance: WorkbenchAppearance) { theme = appearance.mode; applyAppearance(host, appearance); root.querySelector('main')?.setAttribute('data-theme', theme); },
    dispose() { disposed = true; saveEpoch++; if (debounce) clearTimeout(debounce); reads.dispose(); offContext(); offData(); offStatus(); host.remove(); },
  };
}
function escape(value: string): string { return value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!)); }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
