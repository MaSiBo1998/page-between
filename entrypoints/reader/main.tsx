import { createRoot } from 'react-dom/client';

const params = new URLSearchParams(location.search);
const root = document.getElementById('root')!;
function failed(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  root.textContent = '阅读器加载失败：' + message;
  if (params.has('embedded')) window.parent.postMessage({ type: 'novel-reader-failed' }, '*');
}
void import('../../src/ui/Reader').then(({ Reader }) => {
  createRoot(root, { onUncaughtError: failed }).render(<Reader bookId={params.get('book') || undefined} embedded={params.has('embedded')}/>);
}).catch(failed);
