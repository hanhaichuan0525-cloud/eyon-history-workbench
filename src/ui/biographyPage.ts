import { mountBiographyWorkbench } from './biographyWorkbench.ts';

function start(): void {
  const container = document.querySelector<HTMLElement>(
    '[data-eyon-biography-workbench]',
  );
  if (!container) return;
  mountBiographyWorkbench(container, undefined, {
    theme: container.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
