import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Manager } from '../src/ui/Manager';
import { rpc } from '../src/rpc';

vi.mock('../src/rpc', () => ({ rpc: vi.fn(), grantSite: vi.fn() }));
vi.mock('../src/db', () => ({ db: { books: vi.fn(async () => []) } }));
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined; document.body.replaceChildren();
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('扩展更新后旧下载面板', () => {
  it('轮询触发重渲染不会再调用失效的 getManifest，并停止轮询', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let valid = true;
    const getManifest = vi.fn(() => {
      if (!valid) throw Error('Extension context invalidated.');
      return { version: '0.1.2' };
    });
    vi.stubGlobal('chrome', { runtime: { id: 'test', getManifest }, storage: { local: { get: vi.fn(async () => ({})) } } });
    vi.mocked(rpc).mockResolvedValue(null);
    const container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(createElement(Manager)));
    expect(container.textContent).toContain('v0.1.2');
    valid = false;
    vi.mocked(rpc).mockRejectedValue(Error('Extension context invalidated.'));
    await act(async () => { vi.advanceTimersByTime(1800); });
    expect(container.textContent).toContain('扩展已更新，请刷新当前网页后重新打开浮窗。');
    expect(container.textContent).toContain('v0.1.2');
    expect(getManifest).toHaveBeenCalledTimes(1);
    const requests = vi.mocked(rpc).mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(5400); });
    expect(rpc).toHaveBeenCalledTimes(requests);
  });
});
