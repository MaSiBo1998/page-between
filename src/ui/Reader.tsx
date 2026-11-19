import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { db } from '../db';
import { importTXT } from '../books';
import { DEFAULT_READER, type Book, type ReaderPrefs, type Position } from '../types';
import { isEditing, matchesShortcut, normalizeReaderShortcut, readerPrefs, recordReaderShortcut, saveReaderPrefs } from '../reader-prefs';
import { ContinuousText, type ContinuousTextHandle } from './ContinuousText';
import { installReaderDrag } from '../reader-drag';
import { SourcePanel, type SourceView } from './SourcePanel';
import { ChapterCatalog } from './ChapterCatalog';
import { PREVIEW_BUILD } from '../build-info';
import './reader.css';
import './floating-library.css';

const READING_TABS = [{ key: 'read', label: '正文' }, { key: 'catalog', label: '目录' }, { key: 'switch', label: '换源' }] as const;
type ReadingTab = typeof READING_TABS[number]['key'];

function ShortcutSetting({ value, onChange }: { value: string; onChange: (shortcut: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const id = useId();

  function commit(raw: string) {
    const shortcut = normalizeReaderShortcut(raw);
    if (!shortcut) {
      setError('请输入有效组合键，例如 Alt+K。');
      return;
    }
    if (/^Alt\+Shift\+[1-4]$/.test(shortcut)) {
      setError('与页间默认浏览器快捷键冲突。');
      return;
    }
    setDraft(null); setError('');
    if (shortcut !== value) onChange(shortcut);
  }

  return <div className="reader-shortcut">
    <label className="reader-shortcut-row">隐藏 / 恢复<input data-shortcut-input type="text" value={draft ?? value}
      aria-invalid={!!error} aria-describedby={error ? id : undefined} autoComplete="off" spellCheck={false} maxLength={64}
      onFocus={event => event.currentTarget.select()} onChange={event => { setDraft(event.target.value); setError(''); }}
      onBlur={() => { if (draft !== null) { commit(draft); setDraft(null); } }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); setDraft(null); setError(''); return;
        }
        const shortcut = recordReaderShortcut(event.nativeEvent);
        if (!shortcut && event.key !== 'Enter') return;
        event.preventDefault(); event.stopPropagation();
        commit(shortcut ?? event.currentTarget.value);
      }}/></label>
    {error && <small id={id} role="alert">{error}</small>}
  </div>;
}

function NumberSetting({ label, value, min, max, step = 1, unit, live = false, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string; live?: boolean; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return <label>{label}<span className="reader-number"><input type="number" min={min} max={max} step={step}
    value={draft ?? value} onChange={event => {
      const field = event.currentTarget;
      setDraft(field.value);
      if (live && field.validity.valid && Number.isFinite(field.valueAsNumber) && field.valueAsNumber !== value) onCommit(field.valueAsNumber);
    }}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}
    onBlur={event => {
      const number = event.currentTarget.valueAsNumber;
      setDraft(null);
      if (!live && draft !== null && Number.isFinite(number)) {
        const rounded = Math.round(number / step) * step;
        onCommit(Number(Math.min(max, Math.max(min, rounded)).toFixed(2)));
      }
    }}/>{unit && <span aria-hidden="true">{unit}</span>}</span></label>;
}

export function Reader({ bookId, embedded = false }: { bookId?: string; embedded?: boolean }) {
  const initialView = new URLSearchParams(location.search).get('view');
  const requestedView = useRef(initialView);
  const [activeId, setActiveId] = useState(bookId), [revision, setRevision] = useState(0);
  const [panel, setPanel] = useState<SourceView | 'catalog' | null>(initialView === 'online' ? 'search' : initialView === 'download' ? 'download' : null);
  const sourceView = panel === 'catalog' ? null : panel;
  const readTab = useRef<HTMLButtonElement>(null);
  const settingsToggle = useRef<HTMLButtonElement>(null);
  const requestedChapter = useRef<number | undefined>(undefined);
  const [libraryOpen, setLibraryOpen] = useState(initialView === 'library'), [library, setLibrary] = useState<Book[]>([]);
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
  const shelved = useRef(new Set<string>());
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
    setActiveId(selected.id); setRevision(value => value + 1); setLibraryOpen(false); setPanel(null); setError('');
  }
  function openPanel(view: SourceView | 'catalog' | null) {
    textView.current?.flush();
    setOptions(false); setLibraryOpen(false); setPanel(view);
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
      if (view || bookId) setPanel(view === 'online' ? 'search' : view === 'download' ? 'download' : null);
      if (controls === 'show' || controls === 'hide') { setControls(controls); setOptions(false); }
      if (typeof bookId === 'string') { setActiveId(bookId); setRevision(value => value + 1); setLibraryOpen(false); }
      if (view) { requestedView.current = view; setLibraryOpen(view === 'library'); setOptions(false); }
    };
    window.addEventListener('message', listener);
    // about:blank initially inherits the website origin. Wait until the extension
    // document and its message/drag listeners are installed before syncing state.
    if (embedded) window.parent.postMessage({ type: 'novel-reader-ready' }, '*');
    return () => window.removeEventListener('message', listener);
  }, [embedded]);
  useEffect(() => {
    if (libraryOpen) void db.shelf().then(setLibrary).catch(fail);
  }, [libraryOpen]);
  useEffect(() => {
    const syncPrefs: Parameters<typeof chrome.storage.local.onChanged.addListener>[0] = changes => {
      const prefs = changes.readerPrefs?.newValue;
      if (!prefs) return;
      setPrefs(value => {
        const width = typeof prefs.width === 'number' ? prefs.width : value.width;
        const shortcut = typeof prefs.shortcut === 'string' ? prefs.shortcut : value.shortcut;
        return value.width === width && value.shortcut === shortcut ? value : { ...value, width, shortcut };
      });
    };
    chrome.storage.local.onChanged.addListener(syncPrefs);
    return () => chrome.storage.local.onChanged.removeListener(syncPrefs);
  }, []);
  useEffect(() => {
    let disposed = false; const version = ++generation.current;
    setLoading(true); setError(''); setBook(undefined);
    void (async () => {
      const prefs = await readerPrefs();
      const id = activeId || (await chrome.storage.local.get('lastBook')).lastBook;
      if (!id) { if (!disposed) { setPrefs(prefs); setLoading(false); if (!requestedView.current || requestedView.current === 'read') setLibraryOpen(true); } return; }
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
    const toggle = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.hasAttribute('data-shortcut-input')) return;
      if (!matchesShortcut(event, prefs.shortcut, true)) return;
      event.preventDefault(); event.stopPropagation(); hide();
    };
    const escape = (event: KeyboardEvent) => {
      if (matchesShortcut(event, 'Escape')) { event.preventDefault(); hide(); }
    };
    window.addEventListener('keydown', toggle, true);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', toggle, true);
      window.removeEventListener('keydown', escape);
    };
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
    if (!shelved.current.has(current.bookId)) {
      shelved.current.add(current.bookId);
      void db.addToShelf(current.bookId).catch(error => { shelved.current.delete(current.bookId); fail(error); });
    }
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => { if (position.current) void db.savePosition(position.current).catch(fail); }, 350);
  }, [fail]);
  const bg = `${prefs.background}${Math.round(prefs.opacity * 255).toString(16).padStart(2, '0')}`;
  const activeTab: ReadingTab | null = libraryOpen || panel === 'search' || panel === 'download' ? null : panel ?? 'read';
  const reading = !!book && activeTab === 'read' && !options && !hidden;
  return <section className={`reader ${embedded ? 'embedded' : 'standalone'} ${reading ? 'is-reading' : ''}`} data-page-between-build={PREVIEW_BUILD} data-controls={controls} style={{ color: prefs.color, background: bg, fontFamily: prefs.font }}>
    <header className="reader-tools reader-header" style={reading && controls === 'auto' ? { backgroundColor: prefs.background } : undefined} onClickCapture={() => textView.current?.flush()}>
      <div className="reader-title-row">
        <span className="reader-name" title={book?.title}>{book?.title || '页间阅读'}</span>
        <button ref={settingsToggle} onClick={() => { if (options) setOptions(false); else { openPanel(null); setOptions(true); } }} aria-controls="reader-options" aria-expanded={options} aria-label="阅读设置" title="阅读设置">Aa</button>
        <button onClick={hide} aria-label="隐藏阅读器" title="隐藏阅读器">×</button>
      </div>
      <div className="reader-navigation">
        <div className="reader-tabs" role="tablist" aria-label="阅读导航" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          if (index < 0) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
          tabs[next].focus(); tabs[next].click();
        }}>
          {READING_TABS.map(({ key, label }) => <button key={key} ref={key === 'read' ? readTab : undefined} type="button" role="tab" id={`reader-tab-${key}`}
            aria-controls={`reader-panel-${key}`} aria-selected={activeTab === key} tabIndex={(activeTab ?? 'read') === key ? 0 : -1}
            disabled={key !== 'read' && !book} onClick={() => openPanel(key === 'read' ? null : key)}>{label}</button>)}
        </div>
        <div className="reader-actions" aria-label="其他功能">
          <button aria-pressed={sourceView === 'search'} onClick={() => openPanel('search')}>搜书</button>
          <button aria-pressed={sourceView === 'download'} onClick={() => openPanel('download')}>下载</button>
          <button aria-label="打开悬浮书架" aria-pressed={libraryOpen} title="书架 / 导入" onClick={() => { if (libraryOpen) openPanel(null); else { openPanel(null); setLibraryOpen(true); } }}>书架</button>
        </div>
      </div>
    </header>
    {options && <div className="reader-options" id="reader-options" aria-label="阅读设置面板">
      <div className="reader-options-heading"><strong>阅读设置</strong><button aria-label="收起设置" title="收起设置" onClick={() => { setOptions(false); settingsToggle.current?.focus(); }}>⌃</button></div>
      <label>字体<select value={prefs.font} onChange={e => changePrefs({ font: e.target.value })}><option value="serif">宋体 / 衬线</option><option value="sans-serif">黑体 / 无衬线</option><option value="monospace">等宽</option></select></label>
      <NumberSetting label="字号" min={12} max={40} value={prefs.size} unit="px" live onCommit={size => changePrefs({ size })}/>
      <NumberSetting label="行距" min={1.2} max={3} step={0.1} value={prefs.lineHeight} onCommit={lineHeight => changePrefs({ lineHeight })}/>
      <label>文字<input type="color" value={prefs.color} onChange={e => changePrefs({ color: e.target.value })}/></label>
      <label>背景<input type="color" value={prefs.background} onChange={e => changePrefs({ background: e.target.value })}/></label>
      <NumberSetting label="不透明度" min={0} max={100} value={Math.round(prefs.opacity * 100)} unit="%" onCommit={opacity => changePrefs({ opacity: opacity / 100 })}/>
      <NumberSetting label="宽度" min={280} max={Math.max(1200, prefs.width)} value={prefs.width} unit="px" onCommit={width => changePrefs({ width })}/>
      <ShortcutSetting value={prefs.shortcut} onChange={shortcut => changePrefs({ shortcut })}/>
      <label>控制栏<select value={controls} onChange={e => setControls(e.target.value as typeof controls)}><option value="auto">悬停显示</option><option value="show">始终显示</option><option value="hide">沉浸隐藏</option></select></label>
    </div>}
    {error && <p className="reader-error" role="alert">{error}</p>}
    <div className="reading-pane" id="reader-panel-catalog" role="tabpanel" aria-labelledby="reader-tab-catalog" hidden={panel !== 'catalog' || hidden}>
      {panel === 'catalog' && book && <ChapterCatalog key={book.id} book={book} chapter={chapter} onSelect={index => { navigate(index); setPanel(null); readTab.current?.focus(); }}/>}
    </div>
    <div className="reading-pane" id="reader-panel-switch" role={sourceView === 'switch' ? 'tabpanel' : undefined} aria-labelledby={sourceView === 'switch' ? 'reader-tab-switch' : undefined} hidden={!sourceView || hidden}>
      <SourcePanel view={hidden ? null : sourceView} visible={overlayVisible && !hidden} book={book} chapter={chapter}
        onClose={() => { setPanel(null); readTab.current?.focus(); }} onRead={selectBook}/>
    </div>
    <div className="reading-pane" id="reader-panel-read" role={libraryOpen ? undefined : 'tabpanel'} aria-labelledby={libraryOpen ? undefined : 'reader-tab-read'} hidden={!!panel && !hidden}>
    {libraryOpen && !hidden && <div className="floating-library">
      <div className="floating-library-heading"><strong>本机书架</strong><button onClick={() => setLibraryOpen(false)} disabled={!book}>返回正文 →</button></div>
      <div className="floating-import"><select aria-label="导入编码" value={encoding} onChange={e => setEncoding(e.target.value)}><option value="auto">自动识别编码</option><option value="utf-8">UTF-8</option><option value="gbk">GBK</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select><button disabled={importing} onClick={() => fileInput.current?.click()}>{importing ? '正在导入…' : '＋ 导入 TXT'}</button><input ref={fileInput} hidden type="file" accept=".txt,text/plain" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
        setImporting(true); setError('');
        void importTXT(file, encoding).then(async book => {
          await selectBook(book);
        }).catch(fail).finally(() => setImporting(false));
      }}/></div>
      {library.map(item => <div className="floating-book-row" key={item.id}><button className="floating-book" onClick={() => { void selectBook(item).catch(fail); }}><span>{item.title}</span><small>{item.online ? '在线 · ' : ''}{item.chapters.length} 章 · 继续阅读 →</small></button><button className="floating-delete" aria-label={'删除 ' + item.title} onClick={() => {
        if (confirm(`删除《${item.title}》及其缓存和阅读位置？`)) void db.removeBook(item.id).then(async () => {
          shelved.current.delete(item.id); setLibrary(await db.shelf());
          if (book?.id === item.id) { position.current = null; await chrome.storage.local.remove('lastBook'); setBook(undefined); setActiveId(undefined); }
        }).catch(fail);
      }}>删除</button></div>)}
      {!library.length && <p>书架还空着，先导入一本 TXT。</p>}
    </div>}
    {hidden ? <button className="reader-restore" onClick={() => setHidden(false)}>恢复阅读 · {prefs.shortcut}</button> : libraryOpen ? null : book ?
      <div className="continuous-reader" data-chapter-index={chapter} style={{ fontSize: prefs.size, lineHeight: prefs.lineHeight }} onClick={event => {
        if (!options || !(event.target instanceof Element) || event.target.closest('button')) return;
        textView.current?.flush(); setOptions(false);
      }}>
        <ContinuousText ref={textView} key={`${book.id}:${navigation}`} book={book} start={position.current!}
          active={!panel && !libraryOpen && !hidden && overlayVisible}
          layoutKey={`${prefs.size}:${prefs.lineHeight}:${prefs.font}`}
          onPosition={onPosition} onBook={setBook}/>
      </div>
      : <div className="reader-empty">{loading ? '正在恢复书籍…' : '尚未打开书籍'}</div>}
    </div>
  </section>;
}
