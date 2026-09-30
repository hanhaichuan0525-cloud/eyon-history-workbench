type PanAxis = 'x' | 'both';

/** Touch keeps native momentum/pinch zoom; mouse and pen can grab the same canvas. */
export function installScrollPan(
  root: ShadowRoot,
  selector: string,
  axis: PanAxis,
): () => void {
  let gesture: {
    element: HTMLElement;
    pointerId: number;
    x: number;
    y: number;
    left: number;
    top: number;
    dragging: boolean;
  } | null = null;
  let blockedClick: { element: HTMLElement; until: number } | null = null;

  function stop(blockClick = false): void {
    if (!gesture) return;
    const { element, pointerId, dragging } = gesture;
    gesture = null;
    element.removeAttribute('data-panning');
    if (blockClick && dragging) blockedClick = { element, until: Date.now() + 350 };
    if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
  }

  const down = (event: PointerEvent): void => {
    stop();
    blockedClick = null;
    if (!event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return;
    const target = event.target;
    if (!(target instanceof Element)
      || target.closest('input, textarea, select, a, [contenteditable]')) return;
    const element = target.closest<HTMLElement>(selector);
    if (!element || !root.contains(element)
      || (element.scrollWidth <= element.clientWidth
        && (axis === 'x' || element.scrollHeight <= element.clientHeight))) return;
    gesture = {
      element, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: element.scrollLeft, top: element.scrollTop, dragging: false,
    };
  };
  const move = (event: PointerEvent): void => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!root.contains(gesture.element)) { stop(); return; }
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.dragging) {
      const decision = panGestureDecision(dx, dy, axis);
      if (decision === 'yield') { stop(); return; }
      if (decision !== 'pan') return;
      gesture.dragging = true;
      gesture.element.setAttribute('data-panning', '');
      gesture.element.setPointerCapture(event.pointerId);
    }
    if (event.cancelable) event.preventDefault();
    gesture.element.scrollLeft = gesture.left - dx;
    if (axis === 'both') gesture.element.scrollTop = gesture.top - dy;
  };
  const up = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) stop(true);
  };
  const cancel = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) stop();
  };
  const click = (event: MouseEvent): void => {
    if (!blockedClick) return;
    const blocked = blockedClick;
    blockedClick = null;
    if (Date.now() > blocked.until || !(event.target instanceof Node)
      || !blocked.element.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const keydown = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(selector)) return;
    const element = event.target;
    const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    const vertical = axis === 'both'
      ? event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
      : 0;
    if (!horizontal && !vertical) return;
    event.preventDefault();
    element.scrollBy({ left: horizontal * 100, top: vertical * 100, behavior: 'auto' });
  };

  root.addEventListener('pointerdown', down as EventListener);
  root.addEventListener('pointermove', move as EventListener, { passive: false });
  root.addEventListener('pointerup', up as EventListener);
  root.addEventListener('pointercancel', cancel as EventListener);
  root.addEventListener('lostpointercapture', cancel as EventListener);
  // Capture before card buttons: dragging must never select a person/history node.
  root.addEventListener('click', click as EventListener, true);
  root.addEventListener('keydown', keydown as EventListener);
  return () => {
    stop();
    blockedClick = null;
    root.removeEventListener('pointerdown', down as EventListener);
    root.removeEventListener('pointermove', move as EventListener);
    root.removeEventListener('pointerup', up as EventListener);
    root.removeEventListener('pointercancel', cancel as EventListener);
    root.removeEventListener('lostpointercapture', cancel as EventListener);
    root.removeEventListener('click', click as EventListener, true);
    root.removeEventListener('keydown', keydown as EventListener);
  };
}

export function panGestureDecision(
  dx: number,
  dy: number,
  axis: PanAxis,
): 'pending' | 'yield' | 'pan' {
  if (Math.hypot(dx, dy) < 6) return 'pending';
  if (axis === 'x' && Math.abs(dy) > Math.abs(dx)) return 'yield';
  return 'pan';
}
