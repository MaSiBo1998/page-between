import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let browser: ReturnType<typeof mockBrowser>;
let command: (name: string) => Promise<void>;
function mockBrowser() {
  const listener = () => ({ addListener: vi.fn() });
  return {
    runtime: { getURL: (path: string) => 'chrome-extension://reader-test/' + path, onMessage: listener(), onStartup: listener() },
    tabs: { query: vi.fn(async () => [{ id: 12, url: 'https://ordinary.example/article' }]), get: vi.fn(async (id: number) => ({ id, url: 'https://ordinary.example/article' })), sendMessage: vi.fn(async () => undefined), update: vi.fn(async () => undefined) },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: { session: { get: vi.fn(async () => ({ readerTab: 99 })), set: vi.fn(async () => undefined) } },
    alarms: { onAlarm: listener(), create: vi.fn(async () => undefined) },
    permissions: { onRemoved: listener() },
    commands: { onCommand: listener() },
    action: { setTitle: vi.fn(async () => undefined) }
  };
}
beforeEach(async () => {
  vi.resetModules(); browser = mockBrowser();
  vi.stubGlobal('chrome', browser);
  vi.stubGlobal('defineBackground', (start: () => void) => start());
  await import('../entrypoints/background');
  command = browser.commands.onCommand.addListener.mock.calls[0][0];
});
afterEach(() => vi.unstubAllGlobals());

describe('浏览器级阅读快捷键', () => {
  it('在当前非小说网页注入，不依赖旧标签页或网站抓取授权', async () => {
    await command('show-reader');
    expect(browser.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 12 }, files: ['content-scripts/overlay.js'] });
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ visibility: 'show', fromShortcut: true }));
    expect(browser.action.setTitle).not.toHaveBeenCalled();
  });
  it('直接隐藏不会注入新浮窗，也不关闭标签页或影响后台任务', async () => {
    await command('hide-reader');
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenCalledWith(12, expect.objectContaining({ visibility: 'hide', fromShortcut: true }));
  });
  it('控制栏可独立显示和隐藏，隐藏控制栏不会重新打开隐藏的阅读器', async () => {
    await command('show-controls');
    expect(browser.tabs.sendMessage).toHaveBeenLastCalledWith(12, expect.objectContaining({ controls: 'show', visibility: 'show' }));
    browser.scripting.executeScript.mockClear();
    await command('hide-controls');
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(browser.tabs.sendMessage).toHaveBeenLastCalledWith(12, expect.objectContaining({ controls: 'hide', visibility: 'keep' }));
  });
  it('在浏览器内部页不跳回上次网页，保留禁止注入边界', async () => {
    browser.tabs.query.mockResolvedValue([{ id: 5, url: 'chrome://settings/' }]);
    await command('show-reader');
    expect(browser.scripting.executeScript).not.toHaveBeenCalled();
    expect(browser.tabs.get).not.toHaveBeenCalled();
    expect(browser.action.setTitle).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('普通网页') }));
  });
});
