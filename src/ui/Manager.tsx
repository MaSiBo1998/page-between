import { useEffect, useRef, useState } from 'react';
import { importTXT } from '../books';
import { db } from '../db';
import { sites } from '../parser';
import { rpc } from '../rpc';
import type { Book } from '../types';

export function Manager() {
  const [version] = useState(() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } });
  const [section, setSection] = useState(location.hash === '#sites' ? 'sites' : 'library');
  const [books, setBooks] = useState<Book[]>([]), [encoding, setEncoding] = useState('auto');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const files = useRef<HTMLInputElement>(null);
  const sourceTab = Number(new URLSearchParams(location.search).get('tab')) || undefined;
  const loadBooks = async () => setBooks(await db.shelf());
  useEffect(() => { void loadBooks().catch(error => setError(error.message)); }, []);

  async function action(operation: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function read(book: Book) {
    await chrome.storage.local.set({ lastBook: book.id });
    await rpc({ op: 'reader-toggle', bookId: book.id, tabId: sourceTab });
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand-mark">间</div><span className="eyebrow">BETWEEN THE PAGES</span><h1>页间</h1><p>故事，随身带走。</p>
      <nav aria-label="主导航">{[['library', '01', '本地书架'], ['sites', '02', '网站适配']].map(([key, num, label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => { setSection(key); location.hash = key; if (key === 'library') void loadBooks().catch(error => setError(error.message)); }}><span>{num}</span>{label}</button>)}</nav>
      <div className="sidebar-note">LOCAL FIRST<br/>书籍和阅读位置仅保存在本机。<br/>v{version} · Chrome / Edge</div>
    </aside>
    <main className="workspace">
      <header className="page-heading"><div><span className="eyebrow">YOUR PERSONAL READING SPACE</span><h2>{section === 'library' ? '你的书，翻到上一次。' : '让更多网站，说同一种语言。'}</h2></div><span className="local-badge">● 本地保存</span></header>
      {error && <div className="message error" role="alert">{error}</div>}{notice && <div className="message" role="status">{notice}</div>}
      {section === 'library' && <section className="library"><div className="library-heading"><p className="muted">导入 TXT，或把已下载的正文加入书架。阅读位置自动保存。</p><div className="actions"><select aria-label="TXT 编码" value={encoding} onChange={event => setEncoding(event.target.value)}><option value="auto">自动识别编码</option><option value="utf-8">UTF-8</option><option value="gbk">GBK / GB18030</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select><button className="primary" disabled={busy} onClick={() => files.current?.click()}>＋ 导入 TXT</button><input ref={files} hidden type="file" accept=".txt,text/plain" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(async () => { const book = await importTXT(file, encoding); await loadBooks(); await chrome.storage.local.set({ lastBook: book.id }); setNotice(`《${book.title}》已在本地书架，可开始阅读。`); }); }}/></div></div>
        {books.length ? <div className="book-grid">{books.map((book, index) => <article className="book" key={book.id}><div className={`book-cover tone-${index % 3}`}><span>LOCAL LIBRARY</span><h3>{book.title}</h3><span>{book.chapters.length} 个章节 · {Math.ceil(book.chars / 1000)} 千字</span></div><div className="book-actions"><button onClick={() => void action(() => read(book))}>悬浮阅读 →</button><button className="quiet" aria-label={'删除 ' + book.title} onClick={() => { if (confirm(`删除《${book.title}》及阅读进度？`)) void action(async () => { await db.removeBook(book.id); await loadBooks(); }); }}>删除</button></div></article>)}</div> : <div className="card empty-state">书架还空着。导入第一本 TXT，开始阅读。</div>}
      </section>}
      {section === 'sites' && <section className="card"><h3>多站点适配，不等于全部可下载</h3><p className="muted">通用解析覆盖常见目录和正文结构。动态正文、订阅限制或特殊字体，需要专用适配；详细证据见项目 docs/sites.md。</p><div className="sites-grid">{sites.map(site => <a key={site.domain} href={site.url} target="_blank" rel="noreferrer"><strong>{site.name}</strong><small>{site.domain}</small></a>)}</div></section>}
      <footer className="workspace-footer">页间 · BETWEEN THE PAGES <span>本机书库，不上传正文</span></footer>
    </main>
  </div>;
}
