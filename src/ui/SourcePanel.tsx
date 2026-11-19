import { useEffect, useRef, useState } from 'react';
import { BING_PERMISSIONS, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, searchPhrase } from '../book-search';
import { db } from '../db';
import { downloadVerifiedSource, grantSite, rpc } from '../rpc';
import { linkedSources, linkSources, matchSourceChapter } from '../source-links';
import { DEFAULT_SETTINGS, settings, type Book, type Entry, type Job, type VerifiedSource } from '../types';
import './sources.css';

export type SourceView = 'search' | 'switch' | 'download';
type Candidate = Entry & { verified?: VerifiedSource; error?: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const domain = (url?: string) => url ? new URL(url).hostname : '本地 TXT';
const downloadStatus = { running: '正在下载', paused: '已暂停', complete: '下载完成', cancelled: '已取消', error: '下载中断' };
const downloadFields = [
  { key: 'concurrency', label: '并发数', min: 1, max: 16 },
  { key: 'minInterval', label: '最短间隔（毫秒）', min: 50, max: 60000 },
  { key: 'maxInterval', label: '最长间隔（毫秒）', min: 50, max: 60000 },
] as const;
const headings = { search: '搜书', switch: '换源', download: '下载' };

export function SourcePanel({ view, visible, book, chapter, onClose, onRead }: {
  view: SourceView | null; visible: boolean; book?: Book; chapter: number;
  onClose: () => void; onRead: (book: Book, index: number) => Promise<void>;
}) {
  const [title, setTitle] = useState(''), [author, setAuthor] = useState(''), [address, setAddress] = useState('');
  const [limit, setLimit] = useState(String(DEFAULT_SEARCH_LIMIT));
  const [candidates, setCandidates] = useState<Candidate[]>([]), [sources, setSources] = useState<Book[]>([]);
  const [searching, setSearching] = useState(false), [busy, setBusy] = useState('');
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [fallback, setFallback] = useState('');
  const [target, setTarget] = useState<Book>(), [choice, setChoice] = useState('');
  const [job, setJob] = useState<Job | null>(null);
  const [config, setConfig] = useState<{ concurrency: string; minInterval: string; maxInterval: string }>();
  const canDownload = view === 'search' || view === 'download';
  const jobRevision = useRef(0);
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
  useEffect(() => { cancelSearch(); }, [view, visible, book?.id]);
  useEffect(() => {
    const dispose = () => {
      if (request.current) void rpc({ op: 'cancel-book-search', requestId: request.current }).catch(() => {});
    };
    window.addEventListener('pagehide', dispose);
    return () => { dispose(); window.removeEventListener('pagehide', dispose); };
  }, []);
  useEffect(() => { setTarget(undefined); setChoice(''); setError(''); setNotice(''); }, [book?.id, view]);
  useEffect(() => {
    if (!canDownload || !visible) return;
    let disposed = false, checking = false;
    async function update() {
      if (checking) return;
      const revision = jobRevision.current;
      checking = true;
      try {
        const latest = await rpc<Job | null>({ op: 'status' });
        if (!disposed && revision === jobRevision.current) setJob(latest);
      } catch (error) {
        if (disposed || revision !== jobRevision.current) return;
        if (/Extension context invalidated/i.test(message(error))) {
          clearInterval(interval);
          setError('扩展已更新，请刷新当前网页后重新打开浮窗。');
        } else setError(message(error));
      } finally { checking = false; }
    }
    const interval = setInterval(update, 1200);
    void update();
    return () => { disposed = true; clearInterval(interval); };
  }, [canDownload, visible]);

  useEffect(() => {
    if (view !== 'download' || !visible) return;
    let disposed = false;
    setConfig(undefined);
    void chrome.storage.local.get('downloadSettings').then(({ downloadSettings }) => {
      if (disposed) return;
      let saved;
      try { saved = settings(downloadSettings ?? DEFAULT_SETTINGS); } catch { saved = DEFAULT_SETTINGS; }
      setConfig({ concurrency: String(saved.concurrency), minInterval: String(saved.minInterval), maxInterval: String(saved.maxInterval) });
    }).catch(error => { if (!disposed) setError(message(error)); });
    return () => { disposed = true; };
  }, [view, visible]);

  async function search(bookTitle: string, bookAuthor: string, count = DEFAULT_SEARCH_LIMIT) {
    if (!bookTitle.trim() || request.current) return;
    const query = searchPhrase(bookTitle, bookAuthor);
    const id = crypto.getRandomValues(new Uint32Array(4)).join('-');
    request.current = id; setSearching(true); setFallback(query); setError(''); setNotice('');
    setCandidates(items => items.filter(item => item.verified));
    try {
      if (!await chrome.permissions.request({ origins: BING_PERMISSIONS })) throw Error('未授权读取 Bing 结果。');
      if (request.current !== id) return;
      const results = await rpc<Entry[]>({ op: 'search-books', query, requestId: id, limit: count });
      if (request.current !== id) return;
      setCandidates(items => [...items, ...results.filter(result => !items.some(item => item.url === result.url))]);
      setFallback(''); setNotice(`找到 ${results.length} 个候选来源`);
    } catch (error) { if (request.current === id) setError(message(error)); }
    finally { if (request.current === id) { request.current = undefined; setSearching(false); } }
  }

  function searchCurrent() {
    if (!book) return;
    const name = book.title.slice(0, 120);
    if (canDownload) { setTitle(name); setAuthor(''); }
    void search(name, '', view === 'switch' ? Number(limit) : DEFAULT_SEARCH_LIMIT);
  }

  async function verify(raw: string, label?: string, startDownload = false) {
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
      if (startDownload) {
        try { await startVerifiedDownload(verified); }
        catch (error) { setError(message(error)); }
      }
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

  async function addToShelf(source: Book) {
    if (action.current) return;
    action.current = source.id; setBusy(source.id); setError('');
    try {
      await db.addToShelf(source.id);
      setCandidates(items => items.map(item => item.verified?.book.id === source.id
        ? { ...item, verified: { ...item.verified, book: { ...item.verified.book, onShelf: true } } } : item));
      setNotice(`《${source.title}》已加入书架`);
    } catch (error) { setError(message(error)); }
    finally { action.current = ''; setBusy(''); }
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

  async function manageDownload(key: string, operation: () => Promise<void>) {
    if (action.current) return;
    action.current = key; setBusy(key); setError(''); setNotice('');
    try { await operation(); }
    catch (error) { setError(message(error)); }
    finally { action.current = ''; setBusy(''); }
  }

  function updateJob(next: Job | null) {
    jobRevision.current++;
    setJob(next);
  }

  async function startVerifiedDownload(source: VerifiedSource) {
    updateJob(await downloadVerifiedSource(source));
    setNotice(`《${source.book.title}》已开始下载`);
  }

  async function saveConfig() {
    if (!config) return;
    const next = settings({ concurrency: Number(config.concurrency), minInterval: Number(config.minInterval), maxInterval: Number(config.maxInterval) });
    await chrome.storage.local.set({ downloadSettings: next });
    setNotice('下载配置已保存，将用于新任务。');
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
  const verified = candidates.filter(item => item.verified && (canDownload || (item.verified.book.id !== book?.id && !linked.has(item.verified.book.id))));
  const row = (item: Candidate) => <li key={item.url} className="source-row source-candidate">
    <div><strong>{item.verified?.book.title || item.title}</strong><small>{domain(item.url)}{item.verified ? ` · ${item.verified.book.chapters.length} 章` : ''}</small>
      {item.error && <p className="source-error" role="alert">{item.error}</p>}</div>
    <div className="source-actions">{item.verified ? <>
      {book && <button disabled={disabled} onClick={() => void attach(item.verified!.book)}>关联本书</button>}
      {canDownload ? <>
        <button disabled={disabled || !!item.verified.book.onShelf} onClick={() => void addToShelf(item.verified!.book)}>{item.verified.book.onShelf ? '已加入书架' : '加入书架'}</button>
        <button disabled={disabled} onClick={() => void read(item.verified!.book, item.verified!.sampleIndex)}>阅读</button>
        <button className="source-primary" disabled={disabled} onClick={() => void manageDownload(item.url, async () => {
          const source = item.verified!;
          await grantSite(source.book.online?.bookURL ?? item.url);
          await startVerifiedDownload(source);
        })}>{busy === item.url ? '正在启动…' : '下载'}</button>
      </> : <button disabled={disabled} onClick={() => switchSource(item.verified!.book)}>切换</button>}
    </> : <>
      <button disabled={disabled} onClick={() => void verify(item.url, item.title)}>{busy === item.url ? '验证中…' : '验证来源'}</button>
      {canDownload && <button className="source-primary" disabled={disabled} onClick={() => void verify(item.url, item.title, true)}>验证并下载</button>}
    </>}</div>
  </li>;

  const heading = headings[view ?? 'search'];
  return <section className="source-panel" aria-label={`${heading}面板`} hidden={!view}>
    <div className="source-heading"><h2>{heading}</h2><button onClick={onClose}>返回正文</button></div>
    {view === 'download' && <details className="source-config">
      <summary id="download-config-heading">下载配置</summary>
      <form aria-labelledby="download-config-heading" onSubmit={event => {
        event.preventDefault(); void manageDownload('config', saveConfig);
      }}>
        {config && <div className="source-config-fields">{downloadFields.map(({ key, label, min, max }) => <label key={key}>{label}<input
          type="number" min={min} max={max} step={1} required value={config[key]} onChange={event => setConfig({ ...config, [key]: event.target.value })}/></label>)}</div>}
        <button disabled={disabled || !config}>保存配置</button>
      </form>
    </details>}
    {canDownload && <>
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
      <form className="source-find" onSubmit={event => { event.preventDefault(); searchCurrent(); }}>
        <button className="source-primary" disabled={searching || !book}>搜本书其他来源</button>
        <label>搜索数量<input type="number" required min="1" max={MAX_SEARCH_LIMIT} step="1" value={limit} onChange={event => setLimit(event.target.value)}/></label>
      </form>
    </>}
    <form className="source-form source-manual" onSubmit={event => { event.preventDefault(); void verify(address); }}>
      <label>目录或正文网址<input type="url" required value={address} onChange={event => setAddress(event.target.value)} placeholder="粘贴网址"/></label>
      <button disabled={disabled || !address.trim()}>{busy && busy === address.trim() ? '验证中…' : '验证网址'}</button>
    </form>
    {searching && <div className="source-feedback"><span role="status">正在后台搜索…</span><button onClick={cancelSearch}>取消搜索</button></div>}
    {notice && <p className="source-feedback" role="status">{notice}</p>}
    {error && <p className="source-error" role="alert">{error}</p>}
    {view === 'download' && !job && <p className="source-feedback">暂无下载任务</p>}
    {canDownload && job && <section className="source-download" aria-label="下载任务">
      <div className="source-row"><strong>{job.title}</strong><small>{downloadStatus[job.status]} · {job.completed} / {job.end - job.start + 1} 章</small></div>
      <progress aria-label="下载进度" value={job.completed} max={job.end - job.start + 1}/>
      {job.error && <p className="source-error">{job.error}</p>}
      <div className="source-actions">
        {job.status === 'running' && <button disabled={disabled} onClick={() => void manageDownload('pause', async () => updateJob(await rpc<Job | null>({ op: 'pause' })))}>暂停</button>}
        {(job.status === 'paused' || job.status === 'error') && <button disabled={disabled} onClick={() => void manageDownload('resume', async () => updateJob(await rpc<Job>({ op: 'resume' })))}>继续下载</button>}
        {job.status !== 'complete' && job.status !== 'cancelled' && <button disabled={disabled} onClick={() => {
          if (confirm('取消此任务？已保存的正文仍可导出。')) void manageDownload('cancel', async () => updateJob(await rpc<Job | null>({ op: 'cancel' })));
        }}>取消任务</button>}
        <button disabled={disabled || job.status === 'running' || !job.pageCount} onClick={() => void manageDownload('export', async () => {
          await rpc({ op: 'export' }); setNotice('TXT 已提交浏览器下载列表。');
        })}>导出 TXT</button>
        <button disabled={disabled || job.status === 'running' || !job.pageCount} onClick={() => void manageDownload('read-job', async () => {
          const start = context.current;
          const loaded = await rpc<Book>({ op: 'read-job' });
          const now = context.current;
          if (now.visible && now.view === start.view && now.id === start.id) await onRead(loaded, 0);
        })}>加入书架并阅读</button>
      </div>
    </section>}
    {fallback && !searching && <button onClick={() => void rpc({ op: 'open-book-search', query: fallback }).catch(error => setError(message(error)))}>在浏览器打开搜索结果</button>}
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
