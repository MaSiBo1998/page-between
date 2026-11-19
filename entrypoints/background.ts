import { db } from '../src/db';
import type { Operation, ReaderView, Reply } from '../src/types';

export default defineBackground(() => {
  let creating: Promise<void> | undefined;
  async function hasOffscreen() {
    return (await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [chrome.runtime.getURL('offscreen.html')] })).length > 0;
  }
  async function ensureOffscreen() {
    if (creating) return creating;
    if (!await hasOffscreen()) {
      if (!creating) creating = chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: [chrome.offscreen.Reason.DOM_PARSER, chrome.offscreen.Reason.BLOBS], justification: '解析小说 HTML、按章节保存正文并生成本地 TXT 文件。' }).finally(() => { creating = undefined; });
    }
    await creating;
    // createDocument resolves before module listeners are guaranteed to be installed.
    // Probe readiness without replaying a mutating operation.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const response = await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'offscreen', operation: { op: 'health' } });
        if (response?.ok) return;
      } catch { /* The document is still loading its bundled modules. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('后台解析器启动超时，请重新打开扩展。');
  }
  async function toggleReader(bookId?: string, tabId?: number, view?: ReaderView, visibility?: 'show' | 'hide' | 'keep', controls?: 'show' | 'hide', fromShortcut = false) {
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    const saved = (await chrome.storage.session.get('readerTab')).readerTab;
    const targetId = tabId || (/^https?:/.test(active?.url || '') ? active.id : active?.url?.startsWith(chrome.runtime.getURL('')) ? saved : undefined);
    const tab = targetId ? await chrome.tabs.get(targetId).catch(() => undefined) : undefined;
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw Error('请切换到要阅读的普通网页，再点击工具栏里的“页间”打开悬浮阅读器。');
    }
    try {
      if (visibility === 'hide' || visibility === 'keep') {
        await chrome.tabs.sendMessage(tab.id, { channel: 'novel-reader-overlay', visibility, controls, fromShortcut }).catch(() => {});
        return;
      }
      const overlay = await chrome.tabs.sendMessage(tab.id, { channel: 'novel-reader-overlay-ping' }).catch(() => undefined);
      if (!overlay?.alive) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-scripts/overlay.js'] });
      await chrome.tabs.sendMessage(tab.id, { channel: 'novel-reader-overlay', bookId, view, sourceTab: tab.id, visibility, controls, fromShortcut });
      await chrome.storage.session.set({ readerTab: tab.id });
      await chrome.tabs.update(tab.id, { active: true });
    } catch {
      throw Error('该网页目前不允许注入。请切到普通网页，点击扩展按钮后重试；不会另开阅读页面。');
    }
  }
  async function handle(message: { operation?: Operation; authorize?: string; event?: string; url?: string; filename?: string; bookId?: string }, sender: chrome.runtime.MessageSender) {
    if (message.authorize) {
      const url = new URL(message.authorize);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || !await chrome.permissions.contains({ origins: [url.origin + '/*'] }))
        throw Error('需要授权访问：' + url.origin + '。请在下载页点击“授权并识别”。');
      return null;
    }
    if (message.event === 'download' && message.url) {
      if (!message.url.startsWith('blob:' + chrome.runtime.getURL(''))) throw Error('无效的本地导出地址。');
      return chrome.downloads.download({ url: message.url, filename: message.filename, saveAs: true });
    }
    if (message.event === 'book' && message.bookId) { await chrome.storage.local.set({ lastBook: message.bookId }); return null; }
    if (!message.operation) throw Error('未知操作。');
    const operation = message.operation;
    const owner = sender.documentId || `${sender.tab?.id}:${sender.frameId}:${sender.url}`;
    if (operation.op === 'search-books') return searchBooks(owner, operation.requestId, operation.query, sender.tab?.windowId, operation.limit);
    if (operation.op === 'cancel-book-search') return cancelBookSearch(owner, operation.requestId);
    if (operation.op === 'open-book-search') return openBookSearch(operation.query);
    if (message.operation.op === 'reader-toggle') return toggleReader(message.operation.bookId, message.operation.tabId, message.operation.view, message.operation.visibility, message.operation.controls);
    await ensureOffscreen();
    const response: Reply = await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'offscreen', operation: message.operation });
    if (!response?.ok) throw Error(response && 'error' in response ? response.error : '后台解析器没有响应。');
    return response.data;
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.channel !== 'novel-reader' || message.target !== 'background' || sender.id !== chrome.runtime.id ||
        !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
    handle(message, sender).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
  chrome.commands.onCommand.addListener(async command => {
    const shortcuts = {
      'show-reader': { visibility: 'show' as const },
      'hide-reader': { visibility: 'hide' as const },
      'show-controls': { visibility: 'show' as const, controls: 'show' as const },
      'hide-controls': { visibility: 'keep' as const, controls: 'hide' as const }
    };
    const action = shortcuts[command as keyof typeof shortcuts];
    if (!action) return;
    try { await toggleReader(undefined, undefined, undefined, action.visibility, 'controls' in action ? action.controls : undefined, true); }
    catch (error) { await chrome.action.setTitle({ title: error instanceof Error ? error.message : String(error) }); }
  });
  async function recover() {
    const job = await db.job();
    if (job?.status === 'running' && !await hasOffscreen()) {
      job.status = 'paused'; job.error = '后台已结束，正文检查点已保留，点击继续下载。'; await db.saveJob(job);
    }
  }
  chrome.runtime.onStartup.addListener(() => { void recover(); });
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'novel-reader-recovery') void recover(); });
  void chrome.alarms.create('novel-reader-recovery', { periodInMinutes: 1 });
  chrome.permissions.onRemoved.addListener(() => {
    void hasOffscreen().then(exists => exists && chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'offscreen', operation: { op: 'pause' } }));
  });
});
import { cancelBookSearch, openBookSearch, searchBooks } from '../src/browser-book-search';
