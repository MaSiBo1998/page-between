import { clampFrame, matchesShortcut, readerPrefs, saveReaderPrefs } from '../src/reader-prefs';

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'], registration: 'runtime',
  async main() {
    if (document.getElementById('novel-reader-extension')) return;
    const host = document.createElement('div'); host.id = 'novel-reader-extension';
    // The frame owns extension storage; site scripts never receive book text or privileged messages.
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style'); style.textContent = `
      :host{all:initial;position:fixed!important;z-index:2147483647!important;display:block;isolation:isolate}
      .frame{width:100%;height:100%;position:relative}iframe{border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:normal}
      .grab,.resize{position:absolute;opacity:0;transition:opacity .15s;touch-action:none;user-select:none;background:#6c7d6a30;border:0;z-index:2}
      .frame:hover .grab,.frame:hover .resize,.grab:focus-visible,.resize:focus-visible{opacity:1}
      .grab{top:0;left:40%;width:20%;height:7px;border-radius:4px;cursor:move}.resize{bottom:0;right:0;width:13px;height:13px;cursor:nwse-resize}
    `;
    const container = document.createElement('div'); container.className = 'frame';
    const frame = document.createElement('iframe'); frame.title = '小说阅读器'; frame.setAttribute('allowtransparency', 'true');
    const grab = document.createElement('button'); grab.className = 'grab'; grab.title = '拖动阅读器'; grab.setAttribute('aria-label', '拖动阅读器');
    const resize = document.createElement('button'); resize.className = 'resize'; resize.title = '调整阅读器大小'; resize.setAttribute('aria-label', '调整阅读器大小');
    container.append(frame, grab, resize); shadow.append(style, container); document.documentElement.append(host);
    let prefs = await readerPrefs(), visible = false, dragging = false;
    function layout() {
      prefs = clampFrame(prefs, innerWidth, innerHeight);
      Object.assign(host.style, { left: prefs.x + 'px', top: prefs.y + 'px', width: prefs.width + 'px', height: prefs.height + 'px', display: visible ? 'block' : 'none' });
    }
    function show(bookId?: string, view?: string, sourceURL?: string, sourceTab?: number) {
      if (!frame.src) {
        const params = new URLSearchParams({ embedded: '1', url: sourceURL || location.href });
        if (sourceTab) params.set('tab', String(sourceTab));
        if (bookId) params.set('book', bookId);
        if (view) params.set('view', view);
        frame.src = chrome.runtime.getURL('reader.html') + '?' + params;
      } else if (bookId || view) {
        frame.contentWindow?.postMessage({ type: 'novel-reader-view', bookId, view }, chrome.runtime.getURL('').slice(0, -1));
      }
      visible = bookId || view ? true : !visible; layout();
    }
    layout();
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (sender.id === chrome.runtime.id && message?.channel === 'novel-reader-overlay') show(message.bookId, message.view, message.sourceURL, message.sourceTab);
    });
    window.addEventListener('message', event => {
      if (event.source === frame.contentWindow && event.origin === `chrome-extension://${chrome.runtime.id}` && event.data?.type === 'novel-reader-hide') { visible = false; layout(); }
    });
    window.addEventListener('keydown', event => {
      if (matchesShortcut(event, prefs.shortcut)) { event.preventDefault(); show(); }
      else if (visible && matchesShortcut(event, 'Escape')) { visible = false; layout(); }
    });
    window.addEventListener('resize', layout);
    chrome.storage.onChanged.addListener(changes => {
      if (changes.readerPrefs && !dragging) { prefs = { ...prefs, ...changes.readerPrefs.newValue }; layout(); }
    });
    for (const [handle, resizing] of [[grab, false], [resize, true]] as const) {
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault(); dragging = true; handle.setPointerCapture(event.pointerId);
        const origin = { ...prefs }, x = event.clientX, y = event.clientY;
        frame.style.pointerEvents = 'none';
        const move = (event: PointerEvent) => {
          prefs = resizing ? { ...origin, width: origin.width + event.clientX - x, height: origin.height + event.clientY - y }
            : { ...origin, x: origin.x + event.clientX - x, y: origin.y + event.clientY - y };
          layout();
        };
        const end = () => {
          dragging = false; frame.style.pointerEvents = '';
          handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
          void saveReaderPrefs({ x: prefs.x, y: prefs.y, width: prefs.width, height: prefs.height }).catch(() => {});
        };
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
      });
    }
  }
});
