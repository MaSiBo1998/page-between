/** Runs in the extension iframe; the host alone owns window geometry. */
export function installReaderDrag(doc: Document, send: (message: object) => void) {
  const win = doc.defaultView!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pointer: { id: number; x: number; y: number; target: Element; session: string } | undefined;
  let active = false, suppressClick = false;
  const interactive = 'button,a,input,select,textarea,option,label,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="slider"],[data-no-drag]';
  function finish() {
    clearTimeout(timer); timer = undefined;
    const previous = pointer; pointer = undefined;
    if (active && previous) {
      send({ type: 'novel-reader-drag', phase: 'end', session: previous.session });
      if (previous.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
    }
    active = false; doc.documentElement.classList.remove('reader-dragging');
  }
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    finish(); suppressClick = false;
    if (!(event.target instanceof Element) || event.target.closest(interactive)) return;
    pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, target: event.target, session: crypto.getRandomValues(new Uint32Array(4)).join('-') };
    timer = setTimeout(() => {
      if (!pointer) return;
      try { pointer.target.setPointerCapture(pointer.id); } catch { finish(); return; }
      active = true; suppressClick = true;
      doc.getSelection()?.removeAllRanges(); doc.documentElement.classList.add('reader-dragging');
      send({ type: 'novel-reader-drag', phase: 'start', session: pointer.session, x: pointer.x, y: pointer.y, pointerId: pointer.id });
    }, 300);
  };
  const move = (event: PointerEvent) => {
    if (!pointer || event.pointerId !== pointer.id) return;
    if (!active) { if (Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) > 6) finish(); return; }
    event.preventDefault();
    send({ type: 'novel-reader-drag', phase: 'move', session: pointer.session, x: event.screenX, y: event.screenY });
  };
  const up = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    // Fast mouse movement can be coalesced; pointerup carries the final position.
    if (active && event.type === 'pointerup') send({ type: 'novel-reader-drag', phase: 'move', session: pointer.session, x: event.screenX, y: event.screenY });
    finish();
  };
  const blockSelection = (event: Event) => {
    if (event.target instanceof Element && !event.target.closest(interactive)) event.preventDefault();
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  };
  const message = (event: MessageEvent) => {
    if (event.source !== win.parent) return;
    if (event.data?.type === 'novel-reader-visibility' && !event.data.visible) finish();
    if (event.data?.type === 'novel-reader-drag-stop' && event.data.session === pointer?.session) finish();
  };
  doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointermove', move, { capture: true, passive: false });
  doc.addEventListener('pointerup', up, true); doc.addEventListener('pointercancel', up, true);
  doc.addEventListener('lostpointercapture', up, true); doc.addEventListener('click', click, true);
  doc.addEventListener('selectstart', blockSelection, true); doc.addEventListener('dragstart', blockSelection, true);
  win.addEventListener('blur', finish); win.addEventListener('pagehide', finish); win.addEventListener('message', message);
  return () => {
    finish(); doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', up, true);
    doc.removeEventListener('lostpointercapture', up, true); doc.removeEventListener('click', click, true);
    doc.removeEventListener('selectstart', blockSelection, true); doc.removeEventListener('dragstart', blockSelection, true);
    win.removeEventListener('blur', finish); win.removeEventListener('pagehide', finish); win.removeEventListener('message', message);
  };
}
