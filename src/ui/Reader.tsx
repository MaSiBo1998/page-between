import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db';
import { Manager } from './Manager';
import { grantSite, rpc } from '../rpc';
import { importTXT } from '../books';
import { DEFAULT_READER, type Book, type ReaderPrefs, type Position, DEFAULT_SETTINGS } from '../types';
import { isEditing, matchesShortcut, readerPrefs, saveReaderPrefs } from '../reader-prefs';
import { ContinuousText, type ContinuousTextHandle } from './ContinuousText';
import { installReaderDrag } from '../reader-drag';
import { SourcePanel, type SourceView } from './SourcePanel';
import { PREVIEW_BUILD } from '../build-info';
import './reader.css';
import './floating-library.css';
import './floating-manager.css';

export function Reader({ bookId, embedded = false }: { bookId?: string; embedded?: boolean }) {
  const initialView = new URLSearchParams(location.search).get('view');
  const [activeId, setActiveId] = useState(bookId), [revision, setRevision] = useState(0);
  const [downloadOpen, setDownloadOpen] = useState(initialView === 'download');
  const [sourceView, setSourceView] = useState<SourceView | null>(null);
  const [onlineURL, setOnlineURL] = useState(''), [onlineBusy, setOnlineBusy] = useState(false);
  const requestedChapter = useRef<number | undefined>(undefined);
  const [libraryOpen, setLibraryOpen] = useState(initialView === 'library' || initialView === 'online'), [library, setLibrary] = useState<Book[]>([]);
  const [encoding, setEncoding] = useState('auto'), [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [book, setBook] = useState<Book>();
  const [chapter, setChapter] = useState(0), [navigation, setNavigation] = useState(0);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [prefs, setPrefs] = useState(DEFAULT_READER), [options, setOptions] = useState(false);
  const [controls, setControls] = useState<'auto' | 'show' | 'hide'>(() => {
    const value = new URLSearchParams(location.search).get('controls');
    return value === 'show' || value === 'hide' ? value : 'auto';
  });
  const [error, setError] = useState(''), [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const position = useRef<Position | null>(null);
  const textView = useRef<ContinuousTextHandle>(null);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const fail = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  async function selectBook(selected: Book, index?: number) {
    textView.current?.flush();
    if (position.current) await db.savePosition(position.current);
    requestedChapter.current = index;
    await chrome.storage.local.set({ lastBook: selected.id });
    setLoading(true);
    setActiveId(selected.id); setRevision(value => value + 1); setLibraryOpen(false); setDownloadOpen(false); setSourceView(null); setError('');
  }
  function openSources(view: SourceView) {
    textView.current?.flush();
    setOptions(false); setLibraryOpen(false); setDownloadOpen(false); setSourceView(view);
  }
  useEffect(() => { setActiveId(bookId); }, [bookId]);
  useEffect(() => embedded ? installReaderDrag(document, message => window.parent.postMessage(message, '*')) : undefined, [embedded]);
  useEffect(() => {
    if (!embedded) return;
    const report = () => window.parent.postMessage({ type: 'novel-reader-input', editing: isEditing(document.activeElement) }, '*');
    const afterBlur = () => queueMicrotask(report);
    document.addEventListener('focusin', report); document.addEventListener('focusout', afterBlur);
    report();
    return () => { document.removeEventListener('focusin', report); document.removeEventListener('focusout', afterBlur); };
  }, [embedded]);
  useEffect(() => {
    if (embedded) window.parent.postMessage({ type: 'novel-reader-controls', controls }, '*');
  }, [embedded, controls]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!embedded || event.source !== window.parent) return;
      if (event.data?.type === 'novel-reader-visibility') { setOverlayVisible(event.data.visible === true); return; }
      if (event.data?.type !== 'novel-reader-view') return;
      const { view, bookId, controls } = event.data;
      if (view || bookId) setSourceView(null);
      if (controls === 'show' || controls === 'hide') { setControls(controls); setOptions(false); }
      if (typeof bookId === 'string') { setActiveId(bookId); setRevision(value => value + 1); setLibraryOpen(false); }
      if (view) { setDownloadOpen(view === 'download'); setLibraryOpen(view === 'library' || view === 'online'); }
      else if (bookId) setDownloadOpen(false);
    };
    window.addEventListener('message', listener);
    // about:blank initially inherits the website origin. Wait until the extension
    // document and its message/drag listeners are installed before syncing state.
    if (embedded) window.parent.postMessage({ type: 'novel-reader-ready' }, '*');
    return () => window.removeEventListener('message', listener);
  }, [embedded]);
  useEffect(() => {
    if (libraryOpen) void db.books().then(setLibrary).catch(fail);
  }, [libraryOpen]);
  useEffect(() => {
    let disposed = false; const version = ++generation.current;
    setLoading(true); setError(''); setBook(undefined);
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
      setPrefs(prefs); setChapter(index); setNavigation(value => value + 1); setBook(book);
      await chrome.storage.local.set({ lastBook: id });
    })().catch(error => { if (!disposed) { fail(error); setLoading(false); } });
    return () => { disposed = true; clearTimeout(scrollTimer.current); if (position.current) void db.savePosition(position.current).catch(() => {}); };
  }, [activeId, revision]);
  const hide = useCallback(() => {
    textView.current?.flush();
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
    const save = () => { textView.current?.flush(); if (position.current) void db.savePosition(position.current).catch(() => {}); };
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', save);
    return () => { window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, []);
  const changePrefs = (patch: Partial<ReaderPrefs>) => {
    textView.current?.flush();
    setPrefs(p => ({ ...p, ...patch })); void saveReaderPrefs(patch).catch(fail);
  };
  const navigate = (index: number, offset = 0) => {
    if (!book || index < 0 || index >= book.chapters.length) return;
    textView.current?.flush();
    position.current = { bookId: book.id, chapter: index, offset, updated: Date.now() };
    setChapter(index); setNavigation(value => value + 1);
    void db.savePosition(position.current).catch(fail);
  };
  const onPosition = useCallback((current: Position) => {
    position.current = current; setChapter(current.chapter); setLoading(false);
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { if (position.current) void db.savePosition(position.current).catch(fail); }, 350);
  }, [fail]);
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
  const chapterOptions = useMemo(() => book?.chapters.map((c, i) => <option key={i} value={i}>{i + 1}. {c.title}</option>), [book?.chapters]);
  const reading = !!book && !sourceView && !downloadOpen && !libraryOpen && !options && !hidden;
  return <section className={`reader ${embedded ? 'embedded' : 'standalone'} ${reading ? 'is-reading' : ''}`} data-page-between-build={PREVIEW_BUILD} data-controls={controls} style={{ color: prefs.color, background: bg, fontFamily: prefs.font }}>
    <header className={`reader-tools ${options ? 'pinned' : ''}`} style={{ background: bg }} onClickCapture={() => textView.current?.flush()}>
      <span className="reader-name">{book?.title || '页间阅读'}</span>
      <button aria-label="切换阅读" aria-pressed={!downloadOpen && !libraryOpen && !sourceView} onClick={event => { setDownloadOpen(false); setLibraryOpen(false); setOptions(false); setSourceView(null); if (event.detail) event.currentTarget.blur(); }}>阅读</button>
      <button aria-pressed={sourceView === 'search'} onClick={() => openSources('search')}>搜书</button>
      <button aria-label="切换下载" aria-pressed={downloadOpen} onClick={() => { setDownloadOpen(value => !value); setOptions(false); setSourceView(null); }}>下载</button>
      <button onClick={() => { setSourceView(null); setOptions(!options); }} aria-label="阅读设置">Aa</button>
      <button onClick={() => { setLibraryOpen(value => !value); setDownloadOpen(false); setOptions(false); setSourceView(null); }} aria-label="打开悬浮书架">书架 / 导入</button>
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
      <label>控制栏<select value={controls} onChange={e => setControls(e.target.value as typeof controls)}><option value="auto">边缘悬停显示</option><option value="show">始终显示</option><option value="hide">隐藏</option></select></label>
      <p className="reader-shortcuts">Alt+Shift+1 显示阅读器 · Alt+Shift+2 隐藏<br/>Alt+Shift+3 显示控制栏 · Alt+Shift+4 隐藏控制栏<br/>可在浏览器「扩展程序 → 键盘快捷键」中修改。输入时不触发隐藏。</p>
    </div>}
    {error && <p className="reader-error" role="alert">{error}</p>}
    <div className="download-pane" hidden={!downloadOpen || hidden}><Manager embedded onRead={selectBook}/></div>
    <SourcePanel view={hidden ? null : sourceView} visible={overlayVisible && !hidden} book={book} chapter={chapter}
      onClose={() => setSourceView(null)} onFind={() => openSources('search')} onRead={selectBook}/>
    <div className="reading-pane" hidden={downloadOpen || (!!sourceView && !hidden)}>
    {libraryOpen && !hidden && <div className="floating-library">
      <div className="floating-library-heading"><strong>本机书架</strong><button onClick={() => setLibraryOpen(false)} disabled={!book}>返回正文 →</button></div>
      <form className="online-import" onSubmit={event => { event.preventDefault(); void importOnline(); }}>
        <label>小说目录或正文网址<input type="url" required value={onlineURL} disabled={onlineBusy} onChange={e => setOnlineURL(e.target.value)} placeholder="粘贴小说目录或正文网址"/></label>
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
      <div className="continuous-reader" style={{ fontSize: prefs.size, lineHeight: prefs.lineHeight }}>
        <ContinuousText ref={textView} key={`${book.id}:${navigation}`} book={book} start={position.current!}
          active={!sourceView && !downloadOpen && !libraryOpen && !hidden && overlayVisible}
          layoutKey={`${prefs.size}:${prefs.lineHeight}:${prefs.font}`}
          onPosition={onPosition} onBook={setBook}/>
      </div>
      <footer className="reader-tools reader-bottom" style={{ background: bg }}>
        <button aria-label="上一章" onClick={() => navigate(chapter - 1)} disabled={chapter === 0}>←</button>
        <label className="reader-catalog">目录<select aria-label="章节目录" value={chapter} onChange={event => navigate(+event.target.value)}>{chapterOptions}</select></label>
        <span>{chapter + 1}/{book.chapters.length}</span><button aria-label="下一章" onClick={() => navigate(chapter + 1)} disabled={chapter + 1 === book.chapters.length}>→</button>
        <button onClick={() => openSources('switch')}>换源</button>
      </footer>
    </> : <div className="reader-empty">{loading ? '正在恢复书籍…' : '先到书架导入 TXT，或阅读已下载的小说。'}</div>}
    </div>
  </section>;
}
