import { mountCharacterViewer } from './characterViewer.ts';

function start(): void {
  const container = document.querySelector<HTMLElement>(
    '[data-eyon-character-viewer]',
  );
  if (!container) return;
  mountCharacterViewer(container, undefined, {
    theme: container.dataset.theme === 'light' ? 'light' : 'dark',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
