import { parseTextCommand } from '../core/commands.ts';

const COMPOSER_SELECTORS = [
  '#send_textarea',
  'textarea[data-testid="send-textarea"]',
  'textarea[placeholder*="发送"]',
  '[contenteditable="true"][data-testid*="composer"]',
].join(',');

const SEND_BUTTON_SELECTORS = [
  '#send_but',
  'button[data-testid="send-button"]',
  'button[aria-label*="发送"]',
  'button[title*="发送"]',
].join(',');

export interface BiographyPreSendHandle {
  cancel(): void;
  dispose(): void;
}

export interface BiographyPreSendOptions {
  globalObject?: Record<string, unknown>;
  shouldIntercept?(text: string): boolean;
  submit(text: string, signal?: AbortSignal): Promise<void>;
}

interface ActiveSubmission {
  id: number;
  editor: HTMLElement;
  text: string;
  controller: AbortController;
  cancelled: boolean;
}

export function installBiographyPreSendInterceptor(
  options: BiographyPreSendOptions,
): BiographyPreSendHandle {
  const root = options.globalObject ?? globalThis as Record<string, unknown>;
  const documents = collectSameOriginDocuments(root);
  const cleanups: Array<() => void> = [];
  let active: ActiveSubmission | null = null;
  let nextId = 1;

  const intercept = (event: Event, editor: HTMLElement): void => {
    if (active) {
      stopHostSubmission(event);
      return;
    }
    const text = readComposer(editor).trim();
    const shouldIntercept = options.shouldIntercept
      ?? shouldInterceptBiographySubmission;
    if (!shouldIntercept(text)) return;

    stopHostSubmission(event);
    const submission: ActiveSubmission = {
      id: nextId,
      editor,
      text,
      controller: new AbortController(),
      cancelled: false,
    };
    nextId += 1;
    active = submission;
    void options.submit(text, submission.controller.signal).then(() => {
      if (
        !submission.cancelled
        && normalizeComposerText(readComposer(editor)) === normalizeComposerText(submission.text)
      ) {
        setComposer(editor, '');
      }
      if (active?.id === submission.id) active = null;
    }).catch(error => {
      if (active?.id === submission.id) active = null;
      if (!submission.cancelled) {
        console.error('[Eyon History Workbench] biography pre-send failed', error);
      }
    });
  };

  for (const document of documents) {
    const onClick = (event: Event): void => {
      const target = event.composedPath()[0];
      if (!(target instanceof document.defaultView!.Element)) return;
      const button = target.closest(SEND_BUTTON_SELECTORS);
      if (!button) return;
      const editor = findComposer(document);
      if (editor) intercept(event, editor);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Enter'
        || event.shiftKey
        || event.ctrlKey
        || event.altKey
        || event.metaKey
        || event.isComposing
      ) return;
      const target = event.composedPath()[0];
      if (!(target instanceof document.defaultView!.Element)) return;
      const editor = target.closest(COMPOSER_SELECTORS);
      if (editor instanceof document.defaultView!.HTMLElement) {
        intercept(event, editor);
      }
    };
    const onSubmit = (event: Event): void => {
      const target = event.target;
      const view = document.defaultView;
      if (!view || !(target instanceof view.HTMLFormElement)) return;
      const editor = target.querySelector<HTMLElement>(COMPOSER_SELECTORS);
      if (editor) intercept(event, editor);
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('submit', onSubmit, true);
    cleanups.push(() => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('submit', onSubmit, true);
    });
  }

  return {
    cancel() {
      const submission = active;
      if (!submission) return;
      submission.cancelled = true;
      submission.controller.abort(new Error('generation was cancelled'));
      submission.editor.focus();
      active = null;
    },
    dispose() {
      for (const cleanup of cleanups) cleanup();
      active = null;
    },
  };
}

function stopHostSubmission(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function normalizeComposerText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

export function shouldInterceptBiographySubmission(text: string): boolean {
  return parseTextCommand(text)?.type === 'biography.generate';
}

/**
 * 读取宿主发送框文本(全局搜索同源文档):
 * 返回 null = 找不到可用输入框(调用方应中止流程);
 * 返回 '' = 输入框为空(调用方按空输入策略处理)。
 */
export function readTavernComposerText(
  globalObject?: Record<string, unknown>,
): string | null {
  const root = globalObject ?? globalThis as Record<string, unknown>;
  for (const document of collectSameOriginDocuments(root)) {
    const composer = findComposer(document);
    if (composer) return readComposer(composer);
  }
  return null;
}

/**
 * 清空宿主发送框——仅当输入框当前内容仍等于传入文本时执行
 * (防止覆盖用户在中途新输入的内容)。返回是否真的清空了。
 */
export function clearTavernComposerText(
  text: string,
  globalObject?: Record<string, unknown>,
): boolean {
  const root = globalObject ?? globalThis as Record<string, unknown>;
  const normalized = normalizeComposerText(text);
  for (const document of collectSameOriginDocuments(root)) {
    const composer = findComposer(document);
    if (!composer) continue;
    if (normalizeComposerText(readComposer(composer)) !== normalized) return false;
    setComposer(composer, '');
    return true;
  }
  return false;
}

function findComposer(document: Document): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_SELECTORS));
  return candidates.find(candidate => isUsable(candidate)) ?? null;
}

function isUsable(element: HTMLElement): boolean {
  if (element.matches(':disabled, [aria-disabled="true"]')) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function readComposer(editor: HTMLElement): string {
  if (editor instanceof editor.ownerDocument.defaultView!.HTMLTextAreaElement) {
    return editor.value;
  }
  if (editor instanceof editor.ownerDocument.defaultView!.HTMLInputElement) {
    return editor.value;
  }
  return editor.textContent ?? '';
}

function setComposer(editor: HTMLElement, value: string): void {
  const view = editor.ownerDocument.defaultView;
  if (!view) return;
  if (editor instanceof view.HTMLTextAreaElement || editor instanceof view.HTMLInputElement) {
    const descriptor = Object.getOwnPropertyDescriptor(
      editor instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : view.HTMLInputElement.prototype,
      'value',
    );
    descriptor?.set?.call(editor, value);
  } else {
    editor.textContent = value;
  }
  editor.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }));
  editor.dispatchEvent(new view.Event('change', { bubbles: true, composed: true }));
}

function collectSameOriginDocuments(root: Record<string, unknown>): Document[] {
  const documents: Document[] = [];
  const addWindow = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    try {
      const document = (value as Window).document;
      if (document && !documents.includes(document)) documents.push(document);
      for (const frame of Array.from(document.querySelectorAll('iframe'))) {
        if (frame.contentDocument && !documents.includes(frame.contentDocument)) {
          documents.push(frame.contentDocument);
        }
      }
    } catch {
      // Cross-origin documents cannot host the Tavern composer we control.
    }
  };
  addWindow(globalThis);
  addWindow(root.window);
  addWindow(root.parent);
  addWindow(root.top);
  return documents;
}
