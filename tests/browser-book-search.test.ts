import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelBookSearch, searchBooks } from '../src/browser-book-search';
import { grantSite } from '../src/rpc';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function browser(granted = true) {
  const tabs = {
    create: vi.fn(async () => ({ id: 27 })),
    get: vi.fn(async () => ({ status: 'loading' })),
    remove: vi.fn(async () => {}),
  };
  const search = { query: vi.fn(async () => {}) };
  const scripting = { executeScript: vi.fn() };
  const permissions = { contains: vi.fn(async () => granted), request: vi.fn(async () => granted) };
  vi.stubGlobal('chrome', { tabs, search, scripting, permissions });
  return { tabs, search, scripting, permissions };
}

describe('后台搜书', () => {
  it('Bing 或书源拒绝授权后不发起后续操作', async () => {
    const { tabs, search, permissions } = browser(false);
    await expect(searchBooks('denied', 'request', '测试')).rejects.toThrow('需要授权');
    await expect(grantSite('https://books.example/catalog')).rejects.toThrow('未取得');
    expect(permissions.request).toHaveBeenCalledWith({ origins: ['https://books.example/*'] });
    expect(tabs.create).not.toHaveBeenCalled();
    expect(search.query).not.toHaveBeenCalled();
  });

  it('取消时移除临时页，不提取结果', async () => {
    vi.useFakeTimers();
    const { tabs, scripting } = browser();
    const result = expect(searchBooks('cancelled', 'request', '测试', 18)).rejects.toThrow('已取消');
    await vi.advanceTimersByTimeAsync(0);
    expect(tabs.create).toHaveBeenCalledWith({ url: 'about:blank', active: false, windowId: 18 });
    await cancelBookSearch('cancelled', 'request');
    await vi.runAllTimersAsync();
    await result;
    expect(tabs.remove).toHaveBeenCalledExactlyOnceWith(27);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it('超时清理临时页且不重复搜索', async () => {
    vi.useFakeTimers();
    const { tabs, search, scripting } = browser();
    const result = expect(searchBooks('timeout', 'request', '测试')).rejects.toThrow('加载超时');
    await vi.advanceTimersByTimeAsync(12000);
    await result;
    expect(tabs.remove).toHaveBeenCalledExactlyOnceWith(27);
    expect(search.query).toHaveBeenCalledTimes(1);
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });
});
