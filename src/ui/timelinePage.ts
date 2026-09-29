import { mountTimelineWorkbench } from './timelineWorkbench.ts';

function start(): void {
  const container = document.querySelector<HTMLElement>(
    '[data-eyon-timeline-workbench]',
  );
  if (!container) return;
  mountTimelineWorkbench(container, undefined, {
    theme: container.dataset.theme === 'dark' ? 'dark' : 'light',
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
