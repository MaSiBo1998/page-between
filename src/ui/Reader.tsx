import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { db } from '../db';
import { Manager } from './Manager';
import { grantSite, rpc } from '../rpc';
import { CHUNK_SIZE, importTXT } from '../books';
import { DEFAULT_READER, type Book, type ReaderPrefs, type Position, DEFAULT_SETTINGS } from '../types';
import { matchesShortcut, readerPrefs, saveReaderPrefs } from '../reader-prefs';
import './reader.css';
import './floating-library.css';
import './floating-manager.css';

function currentOffset(view: HTMLElement): number {
  const top = view.getBoundingClientRect().top + 4;
  for (const el of view.querySelectorAll<HTMLElement>('[data-offset]')) {
    if (el.getBoundingClientRect().bottom <= top) continue;
    const base = Number(el.dataset.offset), node = el.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return base;
    let low = 0, high = node.textContent?.length || 0;
    const range = document.createRange();
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      range.setStart(node, middle); range.setEnd(node, Math.min(middle + 1, node.textContent!.length));
      if (range.getBoundingClientRect().bottom <= top) low = middle + 1; else high = middle;
    }
    return base + low;
  }
  return 0;
}
export function Reader({ bookId, embedded = false }: { bookId?: string; embedded?: boolean }) {
  const initialView = new URLSearchParams(location.search).get('view');
  const [activeId, setActiveId] = useState(bookId), [revision, setRevision] = useState(0);
  const [downloadOpen, setDownloadOpen] = useState(initialView === 'download');
  const [onlineURL, setOnlineURL] = useState(new URLSearchParams(location.search).get('url') || ''), [onlineBusy, setOnlineBusy] = useState(false);
  const requestedChapter = useRef<number | undefined>(undefined);
  const [libraryOpen, setLibraryOpen] = useState(initialView === 'library' || initialView === 'online'), [library, setLibrary] = useState<Book[]>([]);
  const [encoding, setEncoding] = useState('auto'), [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [book, setBook] = useState<Book>();
  const [chapter, setChapter] = useState(0), [part, setPart] = useState(0);
  const [texts, setTexts] = useState<{ part: number; text: string }[]>([]);
  const [prefs, setPrefs] = useState(DEFAULT_READER), [options, setOptions] = useState(false);
  const [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const viewport = useRef<HTMLDivElement>(null), position = useRef<Position | null>(null);
  const restore = useRef<number | null>(0), scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0), loadingRef = useRef(true);
  const fail = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  async function selectBook(selected: Book, index?: number) {
    if (position.current) await db.savePosition(position.current);
    requestedChapter.current = index;
    await chrome.storage.local.set({ lastBook: selected.id });
    setLoading(true); setTexts([]);
    setActiveId(selected.id); setRevision(value => value + 1); setLibraryOpen(false); setDownloadOpen(false); setError('');
  }
  useEffect(() => { setActiveId(bookId); }, [bookId]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!embedded || event.source !== window.parent || event.data?.type !== 'novel-reader-view') return;
      const { view, bookId } = event.data;
      if (typeof bookId === 'string') { setActiveId(bookId); setRevision(value => value + 1); setLibraryOpen(false); }
      if (view) { setDownloadOpen(view === 'download'); setLibraryOpen(view === 'library' || view === 'online'); }
      else if (bookId) setDownloadOpen(false);
    };
    window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
  }, [embedded]);
  useEffect(() => {
    if (libraryOpen) void db.books().then(setLibrary).catch(fail);
  }, [libraryOpen]);
  useEffect(() => {
    let disposed = false; const version = ++generation.current;
    setLoading(true); setTexts([]); setError(''); setBook(undefined);
    void (async () => {
      const prefs = await readerPrefs();
      const id = activeId || (await chrome.storage.local.get('lastBook')).lastBook;
      if (!id) { if (!disposed) { setPrefs(prefs); setLoading(false); setLibraryOpen(true); } return; }
      const book = await db.book(id); if (!book) throw Error('书籍不存在，请先在书架导入 TXT。');
      const saved = await db.position(id);
      const forced = requestedChapter.current; requestedChapter.current = undefined;
      const index = Math.max(0, Math.min(forced ?? saved?.chapter ?? 0, book.chapters.length - 1));
      const offset = Math.max(0, Math.min(forced === undefined ? saved?.offset || 0 : 0, book.chapters[index].length));
      if (disposed || version !== generation.current) return;
      position.current = { bookId: id, chapter: index, offset, updated: Date.now() };
      restore.current = offset; setPrefs(prefs); setChapter(index); setPart(Math.max(0, Math.floor(offset / CHUNK_SIZE) - 1)); setBook(book);
      await chrome.storage.local.set({ lastBook: id });
    })().catch(error => { if (!disposed) { fail(error); setLoading(false); } });
    return () => { disposed = true; clearTimeout(scrollTimer.current); if (position.current) void db.savePosition(position.current).catch(() => {}); };
  }, [activeId, revision]);
  useEffect(() => {
    if (!book) return;
    let disposed = false; loadingRef.current = true; setLoading(true);
    if (book.online && !book.chapters[chapter].chunks) {
      setTexts([]); setError('');
      void rpc<Book>({ op: 'online-chapter', bookId: book.id, index: chapter }).then(updated => {
        if (!disposed) setBook(updated);
      }).catch(error => { if (!disposed) { fail(error); setLoading(false); } });
      return () => { disposed = true; };
    }
    void Promise.all(Array.from({ length: Math.min(3, book.chapters[chapter].chunks - part) }, async (_, n) => {
      const chunk = await db.chunk(book.id, chapter, part + n);
      if (!chunk) throw Error('本地正文块缺失，请重新导入文件。');
      return { part: part + n, text: chunk.text };
    })).then(chunks => { if (!disposed) { setTexts(chunks); setLoading(false); } }).catch(error => { if (!disposed) { fail(error); setLoading(false); } });
    return () => { disposed = true; };
  }, [book, chapter, part]);
  useLayoutEffect(() => {
    const view = viewport.current;
    if (loading || downloadOpen || libraryOpen || !view || restore.current === null) return;
    const offset = restore.current;
    const el = [...view.querySelectorAll<HTMLElement>('[data-offset]')].find(el => {
      const base = Number(el.dataset.offset); return base <= offset && offset <= base + (el.textContent?.length || 0);
    });
    if (el?.firstChild) {
      const range = document.createRange(), at = Math.min(offset - Number(el.dataset.offset), el.firstChild.textContent?.length || 0);
      range.setStart(el.firstChild, at); range.setEnd(el.firstChild, Math.min(at + 1, el.firstChild.textContent?.length || 0));
      view.scrollTop += range.getBoundingClientRect().top - view.getBoundingClientRect().top;
    } else view.scrollTop = 0;
    restore.current = null; loadingRef.current = false;
  }, [texts, loading, prefs, downloadOpen, libraryOpen]);
  const hide = useCallback(() => {
    if (position.current) void db.savePosition(position.current).catch(fail);
    if (embedded) window.parent.postMessage({ type: 'novel-reader-hide' }, '*'); else setHidden(value => !value);
  }, [embedded]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (matchesShortcut(event, prefs.shortcut) || matchesShortcut(event, 'Escape')) {
        event.preventDefault(); hide();
      }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [prefs.shortcut, hide]);
  useEffect(() => {
    const save = () => { if (position.current) void db.savePosition(position.current).catch(() => {}); };
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', save);
    return () => { window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, []);
  const changePrefs = (patch: Partial<ReaderPrefs>) => {
    if (viewport.current) restore.current = currentOffset(viewport.current);
    setPrefs(p => ({ ...p, ...patch })); void saveReaderPrefs(patch).catch(fail);
  };
  const navigate = (index: number, offset = 0) => {
    if (!book || index < 0 || index >= book.chapters.length) return;
    setLoading(true); setTexts([]);
    restore.current = offset; loadingRef.current = true;
    position.current = { bookId: book.id, chapter: index, offset, updated: Date.now() };
    setChapter(index); setPart(Math.max(0, Math.floor(offset / CHUNK_SIZE) - 1));
    void db.savePosition(position.current).catch(fail);
    if (viewport.current) viewport.current.scrollTop = 0;
  };
  const onScroll = () => {
    if (!book || !viewport.current || loadingRef.current) return;
    const view = viewport.current, offset = currentOffset(view);
    position.current = { bookId: book.id, chapter, offset, updated: Date.now() };
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { if (position.current) void db.savePosition(position.current).catch(fail); }, 350);
    // Keep three chunks mounted; retain a text anchor while replacing an offscreen chunk.
    if (view.scrollTop + view.clientHeight > view.scrollHeight - 250 && part + 3 < book.chapters[chapter].chunks) {
      restore.current = offset; loadingRef.current = true; setPart(p => p + 1);
    } else if (view.scrollTop < 120 && part > 0) {
      restore.current = offset; loadingRef.current = true; setPart(p => p - 1);
    }
  };
  async function importOnline() {
    const permission = grantSite(onlineURL);
    setOnlineBusy(true); setError('');
    try {
      await permission;
      const saved = await chrome.storage.local.get(['downloadSettings', 'rules:' + new URL(onlineURL).hostname]);
      const result = await rpc<Book>({ op: 'open-online', url: onlineURL, rules: saved['rules:' + new URL(onlineURL).hostname] || {}, settings: saved.downloadSettings || DEFAULT_SETTINGS });
      const requested = result.online?.catalog.findIndex(entry => entry.url === new URL(onlineURL).href.split('#')[0]);
      await selectBook(result, requested !== undefined && requested >= 0 ? requested : undefined);
    } catch (error) { fail(error); }
    finally { setOnlineBusy(false); }
  }
  const bg = `${prefs.background}${Math.round(prefs.opacity * 255).toString(16).padStart(2, '0')}`;
  return <section className={`reader ${embedded ? 'embedded' : 'standalone'}`} style={{ color: prefs.color, background: bg, fontFamily: prefs.font }}>
    <header className={`reader-tools ${options ? 'pinned' : ''}`}>
      <span className="reader-name">{book?.title || '页间阅读'}</span>
      <button aria-label="切换阅读" aria-pressed={!downloadOpen && !libraryOpen} onClick={() => { setDownloadOpen(false); setLibraryOpen(false); }}>阅读</button>
      <button aria-label="切换下载" aria-pressed={downloadOpen} onClick={() => { if (viewport.current && !downloadOpen && !libraryOpen) restore.current = currentOffset(viewport.current); setDownloadOpen(value => !value); setOptions(false); }}>下载</button>
      <button onClick={() => setOptions(!options)} aria-label="阅读设置">Aa</button>
      <button onClick={() => { if (viewport.current && !libraryOpen && !downloadOpen) restore.current = currentOffset(viewport.current); setLibraryOpen(value => !value); setDownloadOpen(false); setOptions(false); }} aria-label="打开悬浮书架">书架 / 导入</button>
      <button onClick={hide} aria-label="隐藏阅读器">×</button>
    </header>
    {options && !downloadOpen && <div className="reader-options">
      <label>字体<select value={prefs.font} onChange={e => changePrefs({ font: e.target.value })}><option value="serif">宋体 / 衬线</option><option value="sans-serif">黑体 / 无衬线</option><option value="monospace">等宽</option></select></label>
      <label>字号<input type="range" min="12" max="40" value={prefs.size} onChange={e => changePrefs({ size: +e.target.value })}/></label>
      <label>行距<input type="range" min="1.2" max="3" step="0.1" value={prefs.lineHeight} onChange={e => changePrefs({ lineHeight: +e.target.value })}/></label>
      <label>文字<input type="color" value={prefs.color} onChange={e => changePrefs({ color: e.target.value })}/></label>
      <label>背景<input type="color" value={prefs.background} onChange={e => changePrefs({ background: e.target.value })}/></label>
      <label>不透明度<input type="range" min="0" max="1" step="0.05" value={prefs.opacity} onChange={e => changePrefs({ opacity: +e.target.value })}/></label>
      <label>宽度<input type="range" min="280" max="1200" step="10" value={prefs.width} onChange={e => changePrefs({ width: +e.target.value })}/></label>
      <label>隐藏 / 恢复<select value={prefs.shortcut} onChange={e => changePrefs({ shortcut: e.target.value })}><option>Alt+R</option><option>Alt+Q</option><option>Ctrl+Shift+R</option></select></label>
    </div>}
    {error && <p className="reader-error" role="alert">{error}{book?.online && <button onClick={() => { setError(''); setBook({ ...book }); }}>重试当前章</button>}</p>}
    <div className="download-pane" hidden={!downloadOpen || hidden}><Manager embedded onRead={selectBook}/></div>
    <div className="reading-pane" hidden={downloadOpen}>
    {libraryOpen && !hidden && <div className="floating-library">
      <div className="floating-library-heading"><strong>本机书架</strong><button onClick={() => setLibraryOpen(false)} disabled={!book}>返回正文 →</button></div>
      <form className="online-import" onSubmit={event => { event.preventDefault(); void importOnline(); }}>
        <label>小说目录或正文网址<input type="url" required value={onlineURL} disabled={onlineBusy} onChange={e => setOnlineURL(e.target.value)} placeholder="粘贴小说目录网址"/></label>
        <button type="submit" disabled={onlineBusy || !onlineURL}>{onlineBusy ? '正在导入目录…' : '导入网址并阅读'}</button>
        <small>按需加载当前章及其分页，自动保存已读内容和位置。</small>
      </form>
      <div className="floating-import"><select aria-label="导入编码" value={encoding} onChange={e => setEncoding(e.target.value)}><option value="auto">自动识别编码</option><option value="utf-8">UTF-8</option><option value="gbk">GBK</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select><button disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? '正在导入…' : '＋ 导入 TXT'}</button><input ref={fileInput} hidden type="file" accept=".txt,text/plain" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        setImporting(true); setError('');
        void importTXT(file, encoding).then(async book => {
          await selectBook(book);
        }).catch(fail).finally(() => setImporting(false));
      }}/></div>
      <p>直接在当前网页选书或导入，无需打开阅读页面。</p>
      {library.map(item => <div className="floating-book-row" key={item.id}><button className="floating-book" onClick={() => { void selectBook(item).catch(fail); }}><span>{item.title}</span><small>{item.online ? '在线 · ' : ''}{item.chapters.length} 章 · 继续阅读 →</small></button><button className="floating-delete" aria-label={'删除 ' + item.title} onClick={() => {
        if (confirm(`删除《${item.title}》及其缓存和阅读位置？`)) void db.removeBook(item.id).then(async () => {
          setLibrary(await db.books());
          if (book?.id === item.id) { position.current = null; await chrome.storage.local.remove('lastBook'); setBook(undefined); setActiveId(undefined); }
        }).catch(fail);
      }}>删除</button></div>)}
      {!library.length && <p>书架还空着，先导入一本 TXT。</p>}
    </div>}
    {hidden ? <button className="reader-restore" onClick={() => setHidden(false)}>恢复阅读 · {prefs.shortcut}</button> : libraryOpen ? null : book ? <>
      <div className="reader-scroll" ref={viewport} onScroll={onScroll} tabIndex={0} aria-label="小说正文" style={{ fontSize: prefs.size, lineHeight: prefs.lineHeight }}>
        {part === 0 && <h2>{book.chapters[chapter].title}</h2>}
        {loading && <p role="status">{book.online ? '正在加载本章正文与分页…' : '正在恢复正文…'}</p>}
        {!loading && texts.map(chunk => <p key={`${chapter}:${chunk.part}`} data-offset={chunk.part * CHUNK_SIZE}>{chunk.text || ' '}</p>)}
        {part + texts.length >= book.chapters[chapter].chunks && <button className="next-chapter" disabled={chapter + 1 >= book.chapters.length} onClick={() => navigate(chapter + 1)}>下一章 →</button>}
      </div>
      <footer className="reader-tools reader-bottom">
        <button onClick={() => navigate(chapter - 1)} disabled={chapter === 0}>←</button>
        <select aria-label="章节目录" value={chapter} onChange={e => navigate(+e.target.value)}>{book.chapters.map((c, i) => <option key={i} value={i}>{i + 1}. {c.title}</option>)}</select>
        <span>{chapter + 1}/{book.chapters.length}</span><button onClick={() => navigate(chapter + 1)} disabled={chapter + 1 === book.chapters.length}>→</button>
      </footer>
    </> : <div className="reader-empty">{loading ? '正在恢复书籍…' : '先到书架导入 TXT，或阅读已下载的小说。'}</div>}
    </div>
  </section>;
}
