import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const label = process.env.BROWSER_LABEL || 'edge-overlay';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true }); await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
const chrome = label.startsWith('chrome');
const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
  executablePath: process.env.BROWSER_EXE, headless: !chrome, viewport: { width: 1360, height: 920 },
  ignoreDefaultArgs: ['--disable-extensions'], args: chrome ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${build}`, `--disable-extensions-except=${build}`]
});
try {
  let base;
  if (chrome) {
    const session = await context.browser().newBrowserCDPSession();
    base = 'chrome-extension://' + (await session.send('Extensions.loadUnpacked', { path: build })).id;
  } else {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = worker.url().split('/background.js')[0];
  }
  const site = await context.newPage(); await site.goto('http://127.0.0.1:18765/ordinary');
  const control = await context.newPage(); await control.goto(base + '/popup.html');
  const tabId = await control.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:18765/ordinary' }))[0].id);
  const tabsBefore = context.pages().length;
  const result = await control.evaluate(tabId => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation: { op: 'reader-toggle', tabId } }), tabId);
  assert.equal(result.ok, true);
  await site.waitForSelector('#novel-reader-extension');
  const frame = site.frames().find(f => f.url().includes('/reader.html')); assert.ok(frame);
  await frame.locator('.floating-library, .reader-scroll').first().waitFor();
  if (!await frame.getByRole('button', { name: '＋ 导入 TXT', exact: true }).isVisible()) {
    await frame.getByRole('button', { name: '打开悬浮书架' }).click();
  }
  await frame.getByRole('button', { name: '＋ 导入 TXT', exact: true }).waitFor();
  await frame.locator('input[type=file]').setInputFiles({ name: '网页悬浮测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 无需新开页面\n' + '这是直接在其他网页悬浮阅读的合成测试正文。\n'.repeat(200) + '\n第二章 继续阅读\n测试正文。') });
  await frame.getByLabel('小说正文').waitFor();
  assert.equal(context.pages().length, tabsBefore);
  assert.equal(site.url(), 'http://127.0.0.1:18765/ordinary');
  assert.ok((await frame.locator('.reader-scroll').innerText()).includes('这是直接在其他网页悬浮阅读'));
  await frame.getByRole('button', { name: '打开悬浮书架' }).click();
  await frame.locator('.floating-book').filter({ hasText: '网页悬浮测试' }).click();
  await frame.getByLabel('小说正文').waitFor();
  await site.locator('input').evaluate(el => { Object.assign(el.style, { position: 'fixed', right: '20px', bottom: '20px' }); });
  await site.locator('input').click(); await site.keyboard.press('Alt+r');
  assert.ok(await site.locator('#novel-reader-extension').isVisible());
  await site.locator('h1').click(); await site.keyboard.press('Alt+r');
  await site.waitForFunction(() => document.getElementById('novel-reader-extension').style.display === 'none');
  await site.keyboard.press('Alt+r'); await site.waitForSelector('#novel-reader-extension', { state: 'visible' });
  await site.screenshot({ path: path.join(root, 'floating-reader.png') });
  const manager = await context.newPage(); await manager.goto(base + '/manager.html#library');
  const beforeBookClick = context.pages().length;
  await manager.getByRole('button', { name: '悬浮阅读 →', exact: true }).click();
  await site.waitForSelector('#novel-reader-extension', { state: 'visible' });
  assert.equal(context.pages().length, beforeBookClick);
  const output = { label, version: context.browser().version(), checks: ['TXT imported directly inside a floating reader on an ordinary website', 'floating book picker selects books without opening a tab', 'source URL unchanged and tab count unchanged', 'input fields do not trigger hide shortcuts', 'hide and restore with Alt+R', 'library default action returns to website overlay, no standalone reading tab'] };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
} finally { await context.close(); }
