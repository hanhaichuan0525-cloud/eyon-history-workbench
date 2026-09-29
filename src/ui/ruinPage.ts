import { mountRuinWorkbench } from './ruinWorkbench.ts';

function start(): void {
  const container = document.querySelector<HTMLElement>(
    '[data-eyon-ruin-workbench]',
  );
  if (!container) return;
  mountRuinWorkbench(container, undefined, {
    theme: container.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
