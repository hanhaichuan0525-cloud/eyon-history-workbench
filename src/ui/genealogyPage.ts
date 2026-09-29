import { mountGenealogyWorkbench } from './genealogyWorkbench.ts';

function start(): void {
  const container = document.querySelector<HTMLElement>(
    '[data-eyon-genealogy-workbench]',
  );
  if (!container) return;
  mountGenealogyWorkbench(container, undefined, {
    theme: container.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
