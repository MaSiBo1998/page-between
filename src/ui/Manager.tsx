import { useEffect, useRef, useState } from 'react';
import { importTXT } from '../books';
import { db } from '../db';
import { core, sites } from '../parser';
import { grantSite, rpc } from '../rpc';
import { DEFAULT_SETTINGS, settings, type Book, type Job, type Rules, type Scan } from '../types';

const statusNames = { running: '正在下载', paused: '已暂停', complete: '选定范围已完成', cancelled: '已取消 · 正文保留', error: '已停止，请检查' };
const fieldNames: [keyof Omit<Rules, 'reverse'>, string, string][] = [
  ['catalog', '目录链接', '#list a[href]'], ['content', '正文', '#content'], ['bookTitle', '书名', 'h1'],
  ['chapterTitle', '章节标题', 'h1'], ['next', '下一页 / 章', 'a.next'], ['catalogNext', '目录下一页', '.pager a.next'], ['remove', '清理正文节点', '.ads, .recommend']
];
function time(seconds: number | null) { return seconds === null ? '估算中' : seconds < 60 ? `${seconds} 秒` : `${Math.ceil(seconds / 60)} 分钟`; }
export function Manager({ embedded = false, onRead }: { embedded?: boolean; onRead?: (book: Book, index?: number) => Promise<void> }) {
  const params = new URLSearchParams(location.search), sourceTab = Number(params.get('tab')) || undefined;
  const [section, setSection] = useState(location.hash === '#library' ? 'library' : 'download');
  const [url, setURL] = useState(params.get('url') || ''), [rules, setRules] = useState<Rules>({});
  const [config, setConfig] = useState(DEFAULT_SETTINGS), [scan, setScan] = useState<Scan>();
  const [start, setStart] = useState(0), [end, setEnd] = useState(0);
  const [preview, setPreview] = useState<{ title: string; text: string; selector: string }>();
  const [job, setJob] = useState<Job | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [books, setBooks] = useState<Book[]>([]), [encoding, setEncoding] = useState('auto');
  const files = useRef<HTMLInputElement>(null);
  const running = job?.status === 'running';
  const loadBooks = async () => setBooks(await db.books());
  useEffect(() => {
    let disposed = false;
    const update = () => { void rpc<Job | null>({ op: 'status' }).then(job => { if (!disposed) setJob(job); }).catch(e => { if (!disposed) setError(e.message); }); };
    update(); const interval = setInterval(update, 1800);
    void loadBooks().catch(e => setError(e.message));
    void chrome.storage.local.get(['downloadSettings']).then(saved => { if (saved.downloadSettings) setConfig(saved.downloadSettings); });
    return () => { disposed = true; clearInterval(interval); };
  }, []);
  useEffect(() => {
    let disposed = false;
    try {
      const host = new URL(url).hostname;
      void chrome.storage.local.get('rules:' + host).then(saved => { if (!disposed) setRules(saved['rules:' + host] || {}); });
    } catch { /* URL input can be incomplete while typing. */ }
    return () => { disposed = true; };
  }, [url]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function changeURL(value: string) { setURL(value); setScan(undefined); setPreview(undefined); }
  function changeRule(key: keyof Rules, value: string | boolean) { setRules(rules => ({ ...rules, [key]: value })); setScan(undefined); setPreview(undefined); }
  async function identify() {
    // Permission request is invoked directly from the user's click, before any await.
    const permission = grantSite(url);
    await action(async () => {
      await permission; const valid = settings(config); const address = core.url(url);
      await chrome.storage.local.set({ ['rules:' + new URL(address).hostname]: rules, downloadSettings: valid });
      let snapshot: string | undefined;
      if (sourceTab) {
        try {
          const result = await chrome.scripting.executeScript({ target: { tabId: sourceTab }, func: () => ({ url: location.href, html: document.documentElement.outerHTML }) });
          if (result[0]?.result && core.url(result[0].result.url) === address) snapshot = result[0].result.html;
        } catch { /* A closed source tab is handled by fetching the catalog in the background. */ }
      }
      const result = await rpc<Scan>({ op: 'scan', url: address, rules, settings: valid, snapshot });
      setScan(result); setPreview(undefined); setStart(0); setEnd(result.catalog.length - 1);
      setNotice(`已识别 ${result.catalog.length} 个目录项。可直接开始下载，程序会自动检查起始章。`);
    });
  }
  async function read(book: Book, index?: number) {
    if (onRead) { await onRead(book, index); return; }
    await chrome.storage.local.set({ lastBook: book.id });
    await rpc({ op: 'reader-toggle', bookId: book.id, tabId: sourceTab });
  }
  return <div className={`app-shell ${embedded ? 'floating-manager' : ''}`}>
    <aside className="sidebar">
      <div className="brand-mark">间</div><span className="eyebrow">BETWEEN THE PAGES</span><h1>页间</h1><p>故事，随身带走。</p>
      <nav aria-label="主导航">{[['download', '01', '下载工作台'], ['library', '02', '本地书架'], ['sites', '03', '网站适配']].map(([key, num, label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => { setSection(key); if (!embedded) location.hash = key; if (key === 'library') void loadBooks(); }}><span>{num}</span>{label}</button>)}</nav>
      <div className="sidebar-note">LOCAL FIRST<br/>书籍和阅读位置仅保存在本机。<br/>v0.1.1 · Chrome / Edge</div>
    </aside>
    <main className="workspace">
      <header className="page-heading"><div><span className="eyebrow">YOUR PERSONAL READING SPACE</span><h2>{section === 'download' ? '把下一段故事，留在本机。' : section === 'library' ? '你的书，翻到上一次。' : '让更多网站，说同一种语言。'}</h2></div><span className="local-badge">● 本地保存</span></header>
      {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
      {section === 'download' && <div className="download-grid">
        <section className="card setup-card"><div className="section-head"><span className="step">01</span><h3>目录与下载范围</h3></div>
          <label>小说完整目录网址<input type="url" value={url} disabled={busy || running} onChange={e => changeURL(e.target.value)} placeholder="https://www.3fu.net/423986/"/></label>
          <details className="rules"><summary>站点规则 · 自动识别不准时设置</summary><p className="muted">留空使用自动识别与已有站点规则。保存范围为当前域名。</p><div className="rules-grid">{fieldNames.map(([key, label, placeholder]) => <label key={key}>{label}<input value={rules[key] || ''} placeholder={placeholder} disabled={busy || running} onChange={e => changeRule(key, e.target.value)}/></label>)}</div><label className="check"><input type="checkbox" checked={!!rules.reverse} disabled={busy || running} onChange={e => changeRule('reverse', e.target.checked)}/>目录为倒序</label></details>
          <button className="primary" disabled={busy || running || !url} onClick={() => void identify()}>{busy ? '正在处理…' : '授权并识别目录 →'}</button>
          {scan && <div className="range-box"><p><strong>{scan.title}</strong><span className="muted"> · 共 {scan.catalog.length} 项</span></p><div className="range-grid">
            <label>从<select aria-label="起始章节" disabled={busy || running} value={start} onChange={e => { setStart(+e.target.value); if (+e.target.value > end) setEnd(+e.target.value); setPreview(undefined); }}>{scan.catalog.map((c, i) => <option key={i} value={i}>{i + 1}. {c.title}</option>)}</select></label>
            <label>到<select aria-label="结束章节" disabled={busy || running} value={end} onChange={e => { setEnd(+e.target.value); setPreview(undefined); }}>{scan.catalog.map((c, i) => i >= start && <option key={i} value={i}>{i + 1}. {c.title}</option>)}</select></label>
          </div><p className="muted">包含起止章节，共 {end - start + 1} 章；编号为目录位置。</p><div className="actions">
            <button disabled={busy || running} onClick={() => void action(async () => { setPreview(await rpc({ op: 'preview', scan, index: start, settings: settings(config) })); })}>预览起始章</button>
            <button className="primary" disabled={busy || running} onClick={() => void action(async () => { const valid = settings(config);
              if (!preview) { setNotice('正在检查起始章正文…'); setPreview(await rpc({ op: 'preview', scan, index: start, settings: valid })); }
              await chrome.storage.local.set({ downloadSettings: valid });
              setJob(await rpc({ op: 'start', scan, start, end, settings: valid })); setNotice('后台下载已开始，可切换到阅读。'); })}>开始后台下载</button>
            <button disabled={busy || running} onClick={() => void action(async () => {
              const book = await rpc<Book>({ op: 'open-online', url: scan.bookURL, rules: scan.rules, settings: settings(config) });
              if (!onRead) await db.savePosition({ bookId: book.id, chapter: start, offset: 0, updated: Date.now() }); await read(book, start);
            })}>在线阅读所选章</button>
          </div></div>}
          {preview && <div className="preview"><span className="eyebrow">正文预览 · {preview.selector}</span><h4>{preview.title}</h4><pre>{preview.text}</pre></div>}
        </section>
        <div className="right-column"><section className="card"><div className="section-head"><span className="step">02</span><h3>速度与节奏</h3></div><div className="speed-fields">
          <label>并发请求<input type="number" min="1" max="16" value={config.concurrency} disabled={busy || running} onChange={e => setConfig({ ...config, concurrency: +e.target.value })}/></label>
          <label>随机下限 · ms<input type="number" min="50" max="60000" value={config.minInterval} disabled={busy || running} onChange={e => setConfig({ ...config, minInterval: +e.target.value })}/></label>
          <label>随机上限 · ms<input type="number" min="50" max="60000" value={config.maxInterval} disabled={busy || running} onChange={e => setConfig({ ...config, maxInterval: +e.target.value })}/></label>
        </div><p className="muted">所有请求统一错开启动；遇到限流自动降速，恢复后逐步提高并发。</p></section>
        <section className="card job-card"><div className="section-head"><span className="step">03</span><h3>后台任务</h3><span className={running ? 'status-dot running' : 'status-dot'}/></div>
          {job ? <><h4>{job.title}</h4><span className="muted">{statusNames[job.status]} · 目录第 {job.start + 1}～{job.end + 1} 项</span><div className="big-number">{job.completed}<small> / {job.end - job.start + 1}<span>章</span></small></div><progress max={job.end - job.start + 1} value={job.completed}/><div className="metrics"><span>{job.pageCount} 页 · {job.chars.toLocaleString()} 字符</span><span>{job.rate.toFixed(1)} 请求/秒</span><span>预计剩余 {time(job.eta)}</span><span>当前并发上限 {job.activeLimit}</span></div><p className="muted current-chapter">{job.current}</p>{job.error && <p className="error">{job.error}</p>}<div className="actions">
            <button disabled={busy || !running} onClick={() => void action(async () => { setJob(await rpc({ op: 'pause' })); })}>暂停</button>
            <button disabled={busy || running || ['complete', 'cancelled'].includes(job.status)} onClick={() => void action(async () => { setJob(await rpc({ op: 'resume' })); })}>继续下载</button>
            <button disabled={busy || running || !job.pageCount} onClick={() => void action(async () => { await rpc({ op: 'export' }); setNotice('TXT 已提交浏览器下载列表。'); })}>导出 TXT</button>
            <button disabled={busy || running || !job.pageCount} onClick={() => void action(async () => { const book = await rpc<Book>({ op: 'read-job' }); await loadBooks(); await read(book); })}>加入书架并阅读</button>
            <button className="quiet" disabled={busy || ['complete', 'cancelled'].includes(job.status)} onClick={() => { if (confirm('取消此任务？已保存的正文仍可导出。')) void action(async () => { setJob(await rpc({ op: 'cancel' })); }); }}>取消任务</button>
          </div></> : <div className="empty-state">尚无下载任务。<br/>从目录识别开始，网页无需逐章跳转。</div>}
          <small>可关闭工作台和来源网页。退出浏览器后，下次点击继续下载。</small>
        </section></div>
      </div>}
      {section === 'library' && <section className="library"><div className="library-heading"><p className="muted">导入 TXT，或把已下载的正文加入书架。阅读位置自动保存。</p><div className="actions"><select aria-label="TXT 编码" value={encoding} onChange={e => setEncoding(e.target.value)}><option value="auto">自动识别编码</option><option value="utf-8">UTF-8</option><option value="gbk">GBK / GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select><button className="primary" disabled={busy} onClick={() => files.current?.click()}>＋ 导入 TXT</button><input ref={files} hidden type="file" accept=".txt,text/plain" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void action(async () => { const book = await importTXT(file, encoding); await loadBooks(); await chrome.storage.local.set({ lastBook: book.id }); setNotice(`《${book.title}》已在本地书架，可开始阅读。`); }); }}/></div></div>
        {books.length ? <div className="book-grid">{books.map((book, index) => <article className="book" key={book.id}><div className={`book-cover tone-${index % 3}`}><span>LOCAL LIBRARY</span><h3>{book.title}</h3><span>{book.chapters.length} 个章节 · {Math.ceil(book.chars / 1000)} 千字</span></div><div className="book-actions"><button onClick={() => void action(() => read(book))}>悬浮阅读 →</button><button className="quiet" aria-label={'删除 ' + book.title} onClick={() => { if (confirm(`删除《${book.title}》及阅读进度？`)) void action(async () => { await db.removeBook(book.id); await loadBooks(); }); }}>删除</button></div></article>)}</div> : <div className="card empty-state">书架还空着。导入第一本 TXT，开始阅读。</div>}
      </section>}
      {section === 'sites' && <section className="card"><h3>多站点适配，不等于全部可下载</h3><p className="muted">通用解析覆盖常见目录和正文结构。动态正文、订阅限制或特殊字体，需要专用适配；详细证据见项目 docs/sites.md。</p><div className="sites-grid">{sites.map(site => <a key={site.domain} href={site.url} target="_blank" rel="noreferrer"><strong>{site.name}</strong><small>{site.domain}</small></a>)}</div></section>}
      <footer className="workspace-footer">页间 · BETWEEN THE PAGES <span>本机书库，不上传正文</span></footer>
    </main>
  </div>;
}
