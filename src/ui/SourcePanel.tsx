import { useEffect, useRef, useState } from 'react';
import { BING_PERMISSIONS, searchPhrase } from '../book-search';
import { db } from '../db';
import { grantSite, rpc } from '../rpc';
import { linkedSources, linkSources, matchSourceChapter } from '../source-links';
import { DEFAULT_SETTINGS, type Book, type Entry, type VerifiedSource } from '../types';
import './sources.css';

export type SourceView = 'search' | 'switch';
type Candidate = Entry & { verified?: VerifiedSource; error?: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const domain = (url?: string) => url ? new URL(url).hostname : '本地 TXT';

export function SourcePanel({ view, visible, book, chapter, onClose, onFind, onRead }: {
  view: SourceView | null; visible: boolean; book?: Book; chapter: number;
  onClose: () => void; onFind: () => void; onRead: (book: Book, index: number) => Promise<void>;
}) {
  const [title, setTitle] = useState(''), [author, setAuthor] = useState(''), [address, setAddress] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]), [sources, setSources] = useState<Book[]>([]);
  const [searching, setSearching] = useState(false), [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [fallback, setFallback] = useState('');
  const [target, setTarget] = useState<Book>(), [choice, setChoice] = useState('');
  const request = useRef<string | undefined>(undefined), action = useRef('');
  const context = useRef({ view, visible, id: book?.id }); context.current = { view, visible, id: book?.id };

  useEffect(() => {
    if (!book?.id || !view) { setSources([]); return; }
    let disposed = false;
    void linkedSources(book.id).then(ids => Promise.all(ids.map(id => db.book(id)))).then(rows => {
      if (!disposed) setSources(rows.filter((row): row is Book => !!row?.online));
    }).catch(error => { if (!disposed) setError(message(error)); });
    return () => { disposed = true; };
  }, [book?.id, view]);

  function cancelSearch() {
    const id = request.current;
    if (!id) return;
    request.current = undefined; setSearching(false);
    void rpc({ op: 'cancel-book-search', requestId: id }).catch(() => {});
  }
  useEffect(() => { if (!visible || view !== 'search') cancelSearch(); }, [view, visible]);
  useEffect(() => {
    const dispose = () => {
      if (request.current) void rpc({ op: 'cancel-book-search', requestId: request.current }).catch(() => {});
    };
    window.addEventListener('pagehide', dispose);
    return () => { dispose(); window.removeEventListener('pagehide', dispose); };
  }, []);
  useEffect(() => { setTarget(undefined); setChoice(''); setError(''); setNotice(''); }, [book?.id, view]);

  async function search(bookTitle: string, bookAuthor: string) {
    if (!bookTitle.trim() || request.current) return;
    const query = searchPhrase(bookTitle, bookAuthor);
    const id = crypto.getRandomValues(new Uint32Array(4)).join('-');
    request.current = id; setSearching(true); setFallback(query); setError(''); setNotice('');
    setCandidates(items => items.filter(item => item.verified));
    try {
      if (!await chrome.permissions.request({ origins: BING_PERMISSIONS })) throw Error('未授权读取 Bing 结果。');
      if (request.current !== id) return;
      const results = await rpc<Entry[]>({ op: 'search-books', query, requestId: id });
      if (request.current !== id) return;
      setCandidates(items => [...items, ...results.filter(result => !items.some(item => item.url === result.url))]);
      setFallback(''); setNotice(`找到 ${results.length} 个候选来源`);
    } catch (error) { if (request.current === id) setError(message(error)); }
    finally { if (request.current === id) { request.current = undefined; setSearching(false); } }
  }

  function searchCurrent() {
    if (!book) return;
    const name = book.title.slice(0, 120);
    setTitle(name); setAuthor('');
    if (view !== 'search') onFind();
    void search(name, '');
  }

  async function verify(raw: string, label?: string) {
    if (action.current) return;
    let url: string;
    try { const parsed = new URL(raw.trim()); parsed.hash = ''; url = parsed.href; }
    catch { setError('请输入有效的小说目录或正文网址。'); return; }
    action.current = url; setBusy(url); setError(''); setNotice('');
    try {
      await grantSite(url);
      const key = 'rules:' + new URL(url).hostname;
      const saved = await chrome.storage.local.get([key, 'downloadSettings']);
      const verified = await rpc<VerifiedSource>({ op: 'verify-source', url, rules: saved[key] || {}, settings: saved.downloadSettings || DEFAULT_SETTINGS });
      setCandidates(items => [{ title: label || verified.book.title, url, verified }, ...items.filter(item => item.url !== url && item.verified?.book.id !== verified.book.id)]);
      if (!label) setAddress('');
    } catch (error) {
      const detail = message(error);
      setCandidates(items => items.map(item => item.url === url ? { ...item, error: detail } : item));
      if (!label) setError(detail);
    } finally { action.current = ''; setBusy(''); }
  }

  async function attach(source: Book) {
    if (!book || action.current) return;
    try {
      await linkSources(book.id, source.id);
      if (context.current.id !== book.id) return;
      setSources(items => items.some(item => item.id === source.id) ? items : [...items, source]);
      setNotice(`已关联到《${book.title}》`);
    } catch (error) { setError(message(error)); }
  }

  async function read(source: Book, index: number) {
    if (action.current) return;
    const start = context.current;
    action.current = source.id; setBusy(source.id); setError(''); setNotice('');
    try {
      const loaded = await rpc<Book>({ op: 'online-chapter', bookId: source.id, index });
      const now = context.current;
      if (now.visible && now.view === start.view && now.id === start.id) await onRead(loaded, index);
    } catch (error) { setError(`未切换：${message(error)}`); }
    finally { action.current = ''; setBusy(''); }
  }

  function switchSource(source: Book) {
    const current = book?.chapters[chapter]?.title;
    const match = current ? matchSourceChapter(current, source.chapters.map(item => item.title)) : undefined;
    setTarget(source); setChoice(match === undefined ? '' : String(match)); setError('');
    if (match !== undefined) void read(source, match);
  }

  const linked = new Set(sources.map(source => source.id));
  const disabled = !!busy;
  const pending = candidates.filter(item => !item.verified);
  const verified = candidates.filter(item => item.verified && item.verified.book.id !== book?.id && !linked.has(item.verified.book.id));
  const row = (item: Candidate) => <li key={item.url} className="source-row">
    <div><strong>{item.verified?.book.title || item.title}</strong><small>{domain(item.url)}{item.verified ? ` · ${item.verified.book.chapters.length} 章` : ''}</small>
      {item.error && <p className="source-error" role="alert">{item.error}</p>}</div>
    <div className="source-actions">{item.verified ? <>
      {book && <button disabled={disabled} onClick={() => void attach(item.verified!.book)}>关联本书</button>}
      <button disabled={disabled} onClick={() => void read(item.verified!.book, item.verified!.sampleIndex)}>阅读</button>
    </> : <button disabled={disabled} onClick={() => void verify(item.url, item.title)}>{busy === item.url ? '验证中…' : '验证来源'}</button>}</div>
  </li>;

  return <section className="source-panel" aria-label={view === 'switch' ? '换源面板' : '搜书面板'} hidden={!view}>
    <div className="source-heading"><h2>{view === 'switch' ? '换源' : '搜书'}</h2><button onClick={onClose}>返回正文</button></div>
    {view === 'search' && <>
      <form className="source-form" onSubmit={event => { event.preventDefault(); void search(title, author); }}>
        <label>书名<input required maxLength={120} value={title} onChange={event => setTitle(event.target.value)}/></label>
        <label>作者 <small>选填</small><input maxLength={60} value={author} onChange={event => setAuthor(event.target.value)}/></label>
        <button className="source-primary" disabled={searching || !title.trim()}>搜索</button>
      </form>
      {book && <button disabled={searching} onClick={searchCurrent}>搜本书其他来源</button>}
    </>}
    {view === 'switch' && <>
      <h3>当前来源</h3>
      <div className="source-current"><strong>{book?.title}</strong><small>{domain(book?.source)}{book ? ` · ${book.chapters.length} 章` : ''}</small></div>
      <button disabled={searching} onClick={searchCurrent}>搜本书其他来源</button>
    </>}
    <form className="source-form source-manual" onSubmit={event => { event.preventDefault(); void verify(address); }}>
      <label>目录或正文网址<input type="url" required value={address} onChange={event => setAddress(event.target.value)} placeholder="粘贴网址"/></label>
      <button disabled={disabled || !address.trim()}>{busy && busy === address.trim() ? '验证中…' : '验证网址'}</button>
    </form>
    {searching && <div className="source-feedback"><span role="status">正在后台搜索…</span><button onClick={cancelSearch}>取消搜索</button></div>}
    {notice && <p className="source-feedback" role="status">{notice}</p>}
    {error && <p className="source-error" role="alert">{error}</p>}
    {fallback && !searching && view === 'search' && <button onClick={() => void rpc({ op: 'open-book-search', query: fallback }).catch(error => setError(message(error)))}>在浏览器打开搜索结果</button>}
    {view === 'switch' && target && <form className="source-form source-manual" aria-label="选择目标章节" onSubmit={event => { event.preventDefault(); if (choice) void read(target, Number(choice)); }}>
      <label>{target.title} · {choice === '' ? '未匹配到唯一章节' : '目标章节'}<select required value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="">请选择章节</option>{target.chapters.map((item, index) => <option key={index} value={index}>{item.title}</option>)}
      </select></label>
      <button className="source-primary" disabled={disabled || choice === ''}>{busy === target.id ? '加载目标章…' : '切换并阅读'}</button>
    </form>}
    {book && sources.length > 0 && <><h3>已关联来源</h3><ul>{sources.map(source => <li key={source.id} className="source-row">
      <div><strong>{source.title}</strong><small>{domain(source.source)} · {source.chapters.length} 章</small></div>
      {view === 'switch' && <button disabled={disabled} onClick={() => switchSource(source)}>切换</button>}
    </li>)}</ul></>}
    {verified.length > 0 && <><h3>已验证来源</h3><ul>{verified.map(row)}</ul></>}
    {pending.length > 0 && <><h3>待验证候选</h3><ul>{pending.map(row)}</ul></>}
    {view === 'switch' && !sources.length && !verified.length && !pending.length && <p className="source-feedback">暂无其他来源</p>}
  </section>;
}
