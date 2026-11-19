import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SourcePanel } from '../src/ui/SourcePanel';
import { rpc } from '../src/rpc';

vi.mock('../src/rpc', () => ({ rpc: vi.fn(), grantSite: vi.fn(), downloadVerifiedSource: vi.fn() }));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; document.body.replaceChildren();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('扩展更新后旧搜书面板', () => {
  it('下载状态轮询遇到失效的扩展上下文后停止', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(rpc).mockResolvedValue(null);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(createElement(SourcePanel, { view: 'search', visible: true, chapter: 0, onClose: vi.fn(), onRead: vi.fn() })));
    expect(rpc).toHaveBeenCalledWith({ op: 'status' });
    vi.mocked(rpc).mockRejectedValue(Error('Extension context invalidated.'));
    await act(async () => { vi.advanceTimersByTime(1200); });
    expect(container.textContent).toContain('扩展已更新，请刷新当前网页后重新打开浮窗。');
    const requests = vi.mocked(rpc).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5400); });
    expect(rpc).toHaveBeenCalledTimes(requests);
  });
});
