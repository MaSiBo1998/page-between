import { clampFrame, isEditing, matchesShortcut, readerPrefs, saveReaderPrefs } from '../src/reader-prefs';
import { PREVIEW_BUILD } from '../src/build-info';

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
      .frame[data-controls=hide] .grab,.frame[data-controls=hide] .resize{visibility:hidden;pointer-events:none}
      .grab{top:0;left:40%;width:20%;height:7px;border-radius:4px;cursor:move}.resize{bottom:0;right:0;width:13px;height:13px;cursor:nwse-resize}
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
    const resize = document.createElement('button'); resize.className = 'resize'; resize.title = '调整阅读器大小'; resize.setAttribute('aria-label', '调整阅读器大小');
    container.append(frame, loading, grab, resize); shadow.append(style, container); document.documentElement.append(host);
    let prefs = await readerPrefs(), visible = false, dragging = false, editing = false;
    if (ctx.isInvalid) { host.remove(); return; }
    let ready = false;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;
    host.dataset.readerState = 'idle';
    let pendingView: { type: string; bookId?: string; view?: string; controls?: 'show' | 'hide' } | undefined;
    let endHandleDrag: (() => void) | undefined;
    let remoteDrag: { session: string; x: number; y: number; pointerId: number; origin: typeof prefs } | undefined;
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
        remoteDrag = undefined; dragging = false;
        void saveReaderPrefs({ x: prefs.x, y: prefs.y }).catch(() => {});
      }
    }
    function moveRemote(x: number, y: number) {
      if (!remoteDrag) return;
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
      Object.assign(host.style, { left: prefs.x + 'px', top: prefs.y + 'px', width: prefs.width + 'px', height: prefs.height + 'px', display: visible ? 'block' : 'none' });
    }
    function show(bookId?: string, view?: string, sourceTab?: number, visibility?: 'show' | 'hide' | 'keep', controls?: 'show' | 'hide', fromShortcut = false) {
      if (ctx.isInvalid) return;
      if (fromShortcut && (isEditing(document.activeElement) || visible && editing)) return;
      if (visibility === 'hide') { visible = false; layout(); notifyVisibility(); return; }
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
      if (event.data?.type === 'novel-reader-hide') { visible = false; layout(); notifyVisibility(); }
      if (event.data?.type === 'novel-reader-input') editing = event.data.editing === true;
      if (event.data?.type === 'novel-reader-controls' && ['auto', 'show', 'hide'].includes(event.data.controls)) container.dataset.controls = event.data.controls;
      if (event.data?.type === 'novel-reader-drag') {
        const { phase, session, x, y, pointerId } = event.data;
        if (typeof session !== 'string' || session.length > 80) return;
        if (phase === 'end') { if (session === remoteDrag?.session) stopDrag(); return; }
        if (!visible || !Number.isFinite(x) || !Number.isFinite(y)) return;
        if (phase === 'start' && !dragging && Number.isInteger(pointerId)) {
          remoteDrag = { session, x, y, pointerId, origin: { ...prefs } }; dragging = true;
        } else if (phase === 'move' && remoteDrag?.session === session) {
          moveRemote(x, y);
        }
      }
    });
    ctx.addEventListener(window, 'keydown', event => {
      if (ctx.isInvalid) return;
      if (matchesShortcut(event, prefs.shortcut)) { event.preventDefault(); show(); }
      else if (visible && matchesShortcut(event, 'Escape')) { visible = false; layout(); notifyVisibility(); }
    });
    ctx.addEventListener(window, 'resize', layout);
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
    for (const [handle, resizing] of [[grab, false], [resize, true]] as const) {
      handle.addEventListener('pointerdown', event => {
        if (ctx.isInvalid || event.button !== 0 || dragging) return;
        event.preventDefault(); dragging = true; handle.setPointerCapture(event.pointerId);
        const origin = { ...prefs }, x = event.clientX, y = event.clientY;
        frame.style.pointerEvents = 'none';
        const move = (event: PointerEvent) => {
          prefs = resizing ? { ...origin, width: origin.width + event.clientX - x, height: origin.height + event.clientY - y }
            : { ...origin, x: origin.x + event.clientX - x, y: origin.y + event.clientY - y };
          layout();
        };
        const end = (finishEvent?: Event) => {
          if (finishEvent instanceof PointerEvent && finishEvent.type === 'pointerup') move(finishEvent);
          endHandleDrag = undefined;
          dragging = false; frame.style.pointerEvents = '';
          if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
          void saveReaderPrefs({ x: prefs.x, y: prefs.y, width: prefs.width, height: prefs.height }).catch(() => {});
        };
        endHandleDrag = end;
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      });
    }
  }
});
