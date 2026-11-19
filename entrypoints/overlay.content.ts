import { clampFrame, isEditing, matchesShortcut, readerPrefs, resizeFrame, saveReaderPrefs, type ResizeDirection } from '../src/reader-prefs';
import { PREVIEW_BUILD } from '../src/build-info';
import { DRAG_START_DISTANCE } from '../src/reader-drag';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'], registration: 'runtime',
  async main(ctx) {
    // A reloaded extension cannot talk to the old content-script context.
    document.getElementById('novel-reader-extension')?.remove();
    const host = document.createElement('div'); host.id = 'novel-reader-extension';
    host.dataset.pageBetweenBuild = PREVIEW_BUILD;
    // The frame owns extension storage; site scripts never receive book text or privileged messages.
    // Text and privileged APIs remain inside the cross-origin extension iframe.
    // An open shadow root makes loading/geometry inspectable in browser tools.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = `
      :host{all:initial;position:fixed!important;z-index:2147483647!important;display:block;isolation:isolate}
      .frame{width:100%;height:100%;position:relative}iframe{border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal}
      .grab,.resize{position:absolute;opacity:.45;transition:opacity .15s;touch-action:none;user-select:none;background:#6c7d6a30;border:0;z-index:2}
      .grab:hover,.resize:hover,.grab:focus-visible,.resize:focus-visible{opacity:1}
      .frame[data-controls=hide] .grab{visibility:hidden;pointer-events:none}
      .grab{top:6px;left:40%;width:20%;height:5px;border-radius:0 0 4px 4px;cursor:move}
      .resize{appearance:none;padding:0;background:transparent}
      .resize:focus-visible{outline:2px solid #658272;outline-offset:-2px}
      .resize[data-edge=n],.resize[data-edge=s]{left:12px;right:12px;height:6px;cursor:ns-resize}
      .resize[data-edge=w],.resize[data-edge=e]{top:12px;bottom:12px;width:6px;cursor:ew-resize}
      .resize[data-edge=n]{top:0}.resize[data-edge=s]{bottom:0}.resize[data-edge=w]{left:0}.resize[data-edge=e]{right:0}
      .resize[data-corner]{width:12px;height:12px}
      .resize[data-corner=nw]{top:0;left:0;cursor:nwse-resize}
      .resize[data-corner=ne]{top:0;right:0;cursor:nesw-resize}
      .resize[data-corner=sw]{bottom:0;left:0;cursor:nesw-resize}
      .resize[data-corner=se]{bottom:0;right:0;cursor:nwse-resize}
      .loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;background:white;color:#354038;font:14px/1.8 sans-serif;padding:24px;box-sizing:border-box}
      .loading[hidden]{display:none}.loading button{font:inherit;border:1px solid #ddd;border-radius:4px;background:white;color:inherit;padding:6px 14px;cursor:pointer}
    `;
    const container = document.createElement('div'); container.className = 'frame';
    const frame = document.createElement('iframe'); frame.title = '小说阅读器'; frame.setAttribute('allowtransparency', 'true');
    const loading = document.createElement('div'); loading.className = 'loading';
    const loadingText = document.createElement('span'); loadingText.textContent = '正在打开阅读器…';
    const retry = document.createElement('button'); retry.textContent = '重新加载阅读器'; retry.hidden = true;
    loading.append(loadingText, retry);
    const grab = document.createElement('button'); grab.className = 'grab'; grab.title = '拖动阅读器'; grab.setAttribute('aria-label', '拖动阅读器');
    const edges = { n: '上边', s: '下边', w: '左边', e: '右边', nw: '左上角', ne: '右上角', sw: '左下角', se: '右下角' };
    const handles = (Object.keys(edges) as ResizeDirection[]).map(corner => {
      const handle = document.createElement('button'); handle.className = 'resize'; handle.dataset[corner.length === 1 ? 'edge' : 'corner'] = corner;
      handle.setAttribute('aria-label', `调整阅读器大小：${edges[corner]}`);
      return { handle, corner };
    });
    container.append(frame, loading, grab, ...handles.map(({ handle }) => handle)); shadow.append(style, container); document.documentElement.append(host);
    let prefs = await readerPrefs(), visible = false, dragging = false, editing = false;
    if (ctx.isInvalid) { host.remove(); return; }
    let ready = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    host.dataset.readerState = 'idle';
    let pendingView: { type: string; bookId?: string; view?: string; controls?: 'show' | 'hide' } | undefined;
    let endHandleDrag: (() => void) | undefined;
    let remoteDrag: { session: string; x: number; y: number; pointerId: number; origin: typeof prefs; moved: boolean } | undefined;
    const targetOrigin = chrome.runtime.getURL('').slice(0, -1);
    function failed(state: string) {
      if (ctx.isInvalid) return;
      host.dataset.readerState = state;
      loading.hidden = false; retry.hidden = false;
      loadingText.textContent = '阅读器未能完成加载，请重试。';
    }
    function startLoading() {
      ready = false; clearTimeout(loadTimer);
      host.dataset.readerState = 'loading';
      loading.hidden = false; retry.hidden = true;
      loadingText.textContent = '正在打开阅读器…';
      loadTimer = setTimeout(() => { if (!ready) failed('timeout'); }, 10000);
    }
    retry.addEventListener('click', () => {
      const address = new URL(frame.src);
      address.searchParams.set('reload', crypto.getRandomValues(new Uint32Array(2)).join('-'));
      startLoading(); frame.src = address.href;
    });
    frame.addEventListener('error', () => failed('navigation-error'));
    function stopDrag() {
      endHandleDrag?.();
      if (remoteDrag) {
        const { moved } = remoteDrag;
        remoteDrag = undefined; dragging = false;
        if (moved) void saveReaderPrefs({ x: prefs.x, y: prefs.y }).catch(() => {});
      }
    }
    function moveRemote(x: number, y: number) {
      if (!remoteDrag) return;
      if (!remoteDrag.moved && Math.hypot(x - remoteDrag.x, y - remoteDrag.y) < DRAG_START_DISTANCE) return;
      remoteDrag.moved = true;
      prefs = { ...remoteDrag.origin, x: remoteDrag.origin.x + x - remoteDrag.x, y: remoteDrag.origin.y + y - remoteDrag.y };
      layout();
    }
    function finishRemotePointer(event: PointerEvent) {
      if (!event.isTrusted || !remoteDrag || remoteDrag.pointerId !== event.pointerId) return;
      if (event.type === 'pointerup') moveRemote(event.screenX, event.screenY);
      frame.contentWindow?.postMessage({ type: 'novel-reader-drag-stop', session: remoteDrag.session }, targetOrigin);
      stopDrag();
    }
    function notifyVisibility() {
      if (!visible) stopDrag();
      if (ready) frame.contentWindow?.postMessage({ type: 'novel-reader-visibility', visible }, targetOrigin);
    }
    function layout() {
      prefs = clampFrame(prefs, innerWidth, innerHeight);
      if (!visible && shadow.activeElement === frame) frame.blur();
      host.style.setProperty('display', visible ? 'block' : 'none', 'important');
      Object.assign(host.style, { left: prefs.x + 'px', top: prefs.y + 'px', width: prefs.width + 'px', height: prefs.height + 'px' });
    }
    function hideOverlay() {
      visible = false; layout(); notifyVisibility();
    }
    function show(bookId?: string, view?: string, sourceTab?: number, visibility?: 'show' | 'hide' | 'keep', controls?: 'show' | 'hide', fromShortcut = false) {
      if (ctx.isInvalid) return;
      if (visibility === 'hide') { hideOverlay(); return; }
      if (fromShortcut && (isEditing(document.activeElement) || visible && editing)) return;
      if (visibility === 'keep' && !frame.src) return;
      if (!frame.src) {
        const params = new URLSearchParams({ embedded: '1' });
        if (sourceTab) params.set('tab', String(sourceTab));
        if (bookId) params.set('book', bookId);
        if (view) params.set('view', view);
        if (controls) params.set('controls', controls);
        params.set('build', PREVIEW_BUILD);
        startLoading();
        frame.src = targetOrigin + '/reader.html?' + params;
      } else if (bookId || view || controls) {
        pendingView = { ...pendingView, type: 'novel-reader-view', ...(bookId ? { bookId } : {}), ...(view ? { view } : {}), ...(controls ? { controls } : {}) };
        if (ready) { frame.contentWindow?.postMessage(pendingView, targetOrigin); pendingView = undefined; }
      }
      if (controls) container.dataset.controls = controls;
      if (visibility !== 'keep') visible = visibility === 'show' || bookId || view || controls ? true : !visible;
      layout();
      notifyVisibility();
    }
    layout();
    const receive: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, sender, respond) => {
      if (sender.id !== chrome.runtime.id || ctx.isInvalid) return;
      if (message?.channel === 'novel-reader-overlay-ping') { respond({ alive: host.isConnected }); return; }
      if (message?.channel === 'novel-reader-overlay') show(message.bookId, message.view, message.sourceTab, message.visibility, message.controls, message.fromShortcut);
    };
    chrome.runtime.onMessage.addListener(receive);
    ctx.onInvalidated(() => {
      clearTimeout(loadTimer);
      stopDrag(); host.remove();
      // Chrome can invalidate extension APIs before WXT cleans up the old page.
      try { chrome.runtime.onMessage.removeListener(receive); } catch { /* Context already unloaded. */ }
      try { chrome.storage.onChanged.removeListener(storageChanged); } catch { /* Context already unloaded. */ }
    });
    ctx.addEventListener(window, 'message', event => {
      if (ctx.isInvalid || event.source !== frame.contentWindow || event.origin !== targetOrigin) return;
      if (event.data?.type === 'novel-reader-ready') {
        ready = true; clearTimeout(loadTimer);
        host.dataset.readerState = 'ready'; loading.hidden = true;
        if (pendingView) { frame.contentWindow?.postMessage(pendingView, targetOrigin); pendingView = undefined; }
        notifyVisibility();
      }
      if (event.data?.type === 'novel-reader-failed') { clearTimeout(loadTimer); failed('initialization-error'); }
      if (event.data?.type === 'novel-reader-hide') hideOverlay();
      if (event.data?.type === 'novel-reader-input') editing = event.data.editing === true;
      if (event.data?.type === 'novel-reader-controls' && ['auto', 'show', 'hide'].includes(event.data.controls)) container.dataset.controls = event.data.controls;
      if (event.data?.type === 'novel-reader-drag') {
        const { phase, session, x, y, pointerId } = event.data;
        if (typeof session !== 'string' || session.length > 80) return;
        if (phase === 'end') { if (session === remoteDrag?.session) stopDrag(); return; }
        if (!visible || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (phase === 'start' && !dragging && Number.isInteger(pointerId)) {
          remoteDrag = { session, x, y, pointerId, origin: { ...prefs }, moved: false }; dragging = true;
        } else if (phase === 'move' && remoteDrag?.session === session) {
          moveRemote(x, y);
        }
      }
    });
    ctx.addEventListener(window, 'keydown', event => {
      if (ctx.isInvalid) return;
      if (matchesShortcut(event, prefs.shortcut, true)) { event.preventDefault(); event.stopPropagation(); show(); }
      else if (visible && matchesShortcut(event, 'Escape')) hideOverlay();
    }, { capture: true });
    ctx.addEventListener(window, 'resize', () => { stopDrag(); layout(); });
    ctx.addEventListener(window, 'pointermove', event => {
      if (!event.isTrusted || !remoteDrag || remoteDrag.pointerId !== event.pointerId) return;
      if (event.buttons & 1) moveRemote(event.screenX, event.screenY); else finishRemotePointer(event);
    }, { capture: true });
    ctx.addEventListener(window, 'pointerup', finishRemotePointer, { capture: true });
    ctx.addEventListener(window, 'pointercancel', finishRemotePointer, { capture: true });
    // Parent receives blur when focus enters the iframe; only terminate handle drags here.
    ctx.addEventListener(window, 'blur', () => endHandleDrag?.());
    ctx.addEventListener(window, 'pagehide', stopDrag);
    function storageChanged(changes: { [key: string]: chrome.storage.StorageChange }) {
      if (changes.readerPrefs && !dragging) { prefs = { ...prefs, ...changes.readerPrefs.newValue }; layout(); }
    }
    chrome.storage.onChanged.addListener(storageChanged);
    function saveGeometry() {
      void saveReaderPrefs({ x: prefs.x, y: prefs.y, width: prefs.width, height: prefs.height }).catch(() => {});
    }
    for (const { handle, corner } of [{ handle: grab, corner: undefined }, ...handles]) {
      if (corner) handle.addEventListener('keydown', event => {
        if (dragging || !visible || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 8;
        const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
        const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
        prefs = resizeFrame(prefs, corner, dx, dy, innerWidth, innerHeight); layout(); saveGeometry();
      });
      handle.addEventListener('pointerdown', event => {
        if (ctx.isInvalid || !visible || event.button !== 0 || dragging) return;
        event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch { return; }
        dragging = true;
        const origin = { ...prefs }, x = event.clientX, y = event.clientY;
        frame.style.pointerEvents = 'none';
        const move = (current: PointerEvent) => {
          if (current.pointerId !== event.pointerId) return;
          const dx = current.clientX - x, dy = current.clientY - y;
          prefs = corner ? resizeFrame(origin, corner, dx, dy, innerWidth, innerHeight)
            : { ...origin, x: origin.x + dx, y: origin.y + dy };
          layout();
        };
        const end = (finishEvent?: Event) => {
          if (finishEvent instanceof PointerEvent && finishEvent.pointerId !== event.pointerId) return;
          if (finishEvent instanceof PointerEvent && finishEvent.type === 'pointerup') move(finishEvent);
          endHandleDrag = undefined;
          dragging = false; frame.style.pointerEvents = '';
          handle.removeEventListener('lostpointercapture', end);
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
          saveGeometry();
        };
        endHandleDrag = end;
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
        handle.addEventListener('lostpointercapture', end);
      });
    }
  }
});
