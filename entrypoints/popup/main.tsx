import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc } from '../../src/rpc';
import type { Job } from '../../src/types';
import '../../src/ui/app.css';

function Popup() {
  const [job, setJob] = useState<Job | null>(null), [error, setError] = useState('');
  useEffect(() => {
    void rpc<Job | null>({ op: 'status' }).then(setJob).catch(e => setError(e.message));
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id && /^https?:/.test(tab.url || '')) return chrome.storage.session.set({ readerTab: tab.id });
    });
  }, []);
  async function open(view: 'read' | 'download' | 'library' | 'online') {
    try { await rpc({ op: 'reader-toggle', view }); window.close(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <main className="popup">
    <span className="eyebrow">BETWEEN THE PAGES</span><h1>页间<span>下载 · 收藏 · 阅读</span></h1>
    <p className="muted">把故事留在本机，把阅读留给自己。</p>
    {job && <p className="popup-status">{job.title}<br/>{job.completed}/{job.end - job.start + 1} 章 · {job.status === 'running' ? '后台下载中' : '进度已保存'}</p>}
    <button className="primary wide" onClick={() => void open('read')}>在当前网页悬浮阅读</button>
    <button className="wide" onClick={() => void open('download')}>悬浮下载 · 后台任务</button>
    <button className="quiet wide" onClick={() => void open('library')}>本地书架 · 导入 TXT</button>
    <button className="quiet wide" onClick={() => void open('online')}>导入网址 · 在线阅读</button>
    {error && <p role="alert" className="error">{error}</p>}
    <small>关闭此窗口，后台下载仍会继续。</small>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Popup/>);
