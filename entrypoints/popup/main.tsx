import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { rpc } from '../../src/rpc';
import type { Job, ReaderView } from '../../src/types';
import { PREVIEW_BUILD } from '../../src/build-info';
import '../../src/ui/app.css';

function Popup() {
  const [job, setJob] = useState<Job | null>(null), [error, setError] = useState('');
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    void rpc<Job | null>({ op: 'status' }).then(setJob).catch(e => setError(e.message));
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id && /^https?:/.test(tab.url || '')) return chrome.storage.session.set({ readerTab: tab.id });
    });
  }, []);
  async function open(view: ReaderView) {
    try { await rpc({ op: 'reader-toggle', view }); window.close(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  return <main className="popup">
    <span className="eyebrow">BETWEEN THE PAGES</span><h1>页间<span>下载 · 收藏 · 阅读</span></h1>
    <p className="muted">把故事留在本机，把阅读留给自己。</p>
    {job && <p className="popup-status">{job.title}<br/>{job.completed}/{job.end - job.start + 1} 章 · {job.status === 'running' ? '后台下载中' : '进度已保存'}</p>}
    <button className="primary wide" onClick={() => void open('read')}>在当前网页悬浮阅读</button>
    <button className="quiet wide" onClick={() => void open('library')}>本地书架 · 导入 TXT</button>
    <button className="quiet wide" onClick={() => void open('online')}>搜书 · 验证来源</button>
    <button className="quiet wide" onClick={() => void open('download')}>下载 · 任务与配置</button>
    {error && <p role="alert" className="error">{error}</p>}
    <small>关闭此窗口，后台下载仍会继续。</small>
    <p className="muted" data-preview-build={PREVIEW_BUILD}>版本：{PREVIEW_BUILD}</p>
    <button className="quiet wide" disabled={reloading} onClick={() => {
      setReloading(true);
      try { chrome.runtime.reload(); }
      catch (error) { setReloading(false); setError(error instanceof Error ? error.message : String(error)); }
    }}>应用本地更新 · 重新加载扩展</button>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Popup/>);
