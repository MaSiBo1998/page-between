import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const label = process.env.BROWSER_LABEL || 'edge-workspace';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true }); await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions, undefined);
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
const isChrome = label.startsWith('chrome');
const context = await chromium.launchPersistentContext(path.join(root, 'profile-' + Date.now()), {
  executablePath: process.env.BROWSER_EXE, headless: !isChrome, viewport: { width: 1360, height: 920 },
  ignoreDefaultArgs: ['--disable-extensions'], args: isChrome ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${build}`, `--disable-extensions-except=${build}`]
});
const errors = [], checks = [];
try {
  let base;
  if (isChrome) {
    const session = await context.browser().newBrowserCDPSession();
    base = 'chrome-extension://' + (await session.send('Extensions.loadUnpacked', { path: build })).id;
  } else {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = worker.url().split('/background.js')[0];
  }
  const site = await context.newPage(); await site.goto('http://127.0.0.1:18765/ordinary');
  site.on('pageerror', e => errors.push(e.message));
  const control = await context.newPage(); await control.goto(base + '/popup.html');
  const rpc = op => control.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), op);
  await rpc({ op: 'cancel' });
  await control.evaluate(() => chrome.storage.local.set({ downloadSettings: { concurrency: 6, minInterval: 50, maxInterval: 80 } }));
  const tabId = await control.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:18765/ordinary' }))[0].id);
  const tabCount = () => control.evaluate(async () => (await chrome.tabs.query({})).length);
  const count = await tabCount();
  assert.equal((await rpc({ op: 'reader-toggle', tabId, view: 'download' })).ok, true);
  await site.waitForSelector('#novel-reader-extension');
  let frame; // Closed shadow root: obtain frame from browser frame inventory below.
  await site.waitForFunction(() => document.getElementById('novel-reader-extension'));
  for (let n = 0; n < 100; n++) {
    frame = site.frames().find(f => f.url().includes('/reader.html'));
    if (frame) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(frame);
  await frame.getByLabel('小说完整目录网址').fill('http://127.0.0.1:18765/book');
  await frame.getByRole('button', { name: '授权并识别目录 →', exact: true }).click();
  await frame.getByLabel('起始章节').selectOption('1'); await frame.getByLabel('结束章节').selectOption('2');
  const start = frame.getByRole('button', { name: '开始后台下载', exact: true });
  assert.equal(await start.isEnabled(), true); // Regression: no manual preview step required.
  await start.click();
  await frame.getByRole('button', { name: '切换阅读', exact: true }).click();
  await frame.getByRole('button', { name: '打开悬浮书架', exact: true }).click();
  await frame.locator('input[type=file]').first().setInputFiles({ name: '同窗测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 同窗测试\n' + '下载在后台运行，阅读和下载在同一浮窗内切换。\n'.repeat(150)) });
  await frame.getByLabel('小说正文').waitFor();
  assert.ok((await frame.getByLabel('小说正文').innerText()).includes('同一浮窗'));
  await frame.getByRole('button', { name: '切换下载', exact: true }).click();
  assert.equal(await frame.getByLabel('起始章节').inputValue(), '1');
  let job;
  for (let n = 0; n < 120; n++) {
    job = (await rpc({ op: 'status' })).data;
    if (job?.status === 'complete') break;
    if (job?.status === 'error') throw Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job?.completed, 2); assert.equal(job?.pageCount, 4);
  checks.push('floating download starts without manual preview; 2 chapters / 4 pages complete; reading switch retains range');
  await frame.getByRole('button', { name: '导出 TXT', exact: true }).waitFor();
  const session = await context.browser().newBrowserCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(root, 'downloads') });
  await frame.getByRole('button', { name: '导出 TXT', exact: true }).click();
  await frame.getByRole('status').filter({ hasText: 'TXT 已提交' }).waitFor();
  await frame.getByRole('button', { name: '加入书架并阅读', exact: true }).click();
  await frame.getByLabel('小说正文').waitFor();
  assert.ok((await frame.getByLabel('小说正文').innerText()).includes('第2章 测试'));
  checks.push('TXT export and downloaded-book reading are available inside the same overlay');
  const requestCount = async () => (await (await control.request.get('http://127.0.0.1:18765/stats')).json()).length;
  const before = await requestCount();
  const chapterRequests = async index => (await (await control.request.get('http://127.0.0.1:18765/stats')).json()).slice(before).filter(item => new URL(item.url).pathname === '/chapter/' + index).length;
  await frame.getByRole('button', { name: '打开悬浮书架', exact: true }).click();
  await frame.getByLabel('小说目录或正文网址').fill('http://127.0.0.1:18765/book');
  await frame.getByRole('button', { name: '导入网址并阅读', exact: true }).click();
  await frame.getByLabel('小说正文').locator('p[data-offset]').first().waitFor();
  assert.ok((await frame.getByLabel('小说正文').innerText()).includes('第1章 测试'));
  assert.equal(await chapterRequests(1), 2);
  await frame.getByLabel('章节目录').selectOption('1');
  await frame.locator('[data-block][data-chapter="1"] p[data-offset]').first().waitFor();
  assert.equal(await chapterRequests(1), 2); assert.equal(await chapterRequests(2), 2);
  await frame.getByLabel('章节目录').selectOption('0');
  await frame.getByLabel('小说正文').locator('p[data-offset]').first().waitFor();
  assert.equal(await chapterRequests(1), 2); assert.equal(await chapterRequests(2), 2);
  await frame.getByLabel('章节目录').selectOption('1');
  await frame.locator('[data-block][data-chapter="1"] p[data-offset]').first().waitFor();
  await frame.getByLabel('小说正文').evaluate(el => { el.scrollTop += 350; el.dispatchEvent(new Event('scroll')); });
  await frame.waitForTimeout(500);
  await site.screenshot({ path: path.join(root, 'online-reading.png') });
  assert.equal(site.url(), 'http://127.0.0.1:18765/ordinary'); assert.equal(await tabCount(), count);
  checks.push('URL import loads whole paginated chapters; chapter navigation and cached reread issue no duplicate requests for chapters 1 and 2; URL and tab count unchanged');
  await site.reload();
  assert.equal((await rpc({ op: 'reader-toggle', tabId, view: 'read' })).ok, true);
  for (let n = 0; n < 100; n++) {
    frame = site.frames().find(f => f.url().includes('/reader.html'));
    if (frame) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await frame.getByLabel('小说正文').locator('p[data-offset]').first().waitFor();
  await frame.waitForTimeout(400);
  assert.equal(await frame.getByLabel('章节目录').inputValue(), '1');
  assert.ok(await frame.getByLabel('小说正文').evaluate(el => el.scrollTop) > 100);
  assert.equal(await chapterRequests(1), 2); assert.equal(await chapterRequests(2), 2);
  checks.push('source refresh and overlay reopen restore online chapter and text offset from local cache');
  await frame.getByRole('button', { name: '切换下载', exact: true }).click();
  await site.screenshot({ path: path.join(root, 'floating-download.png') });
  assert.deepEqual(errors, []);
  const result = { label, version: context.browser().version(), checks, errors };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await context.pages()[1]?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error('PAGE ERRORS', errors, context.pages().map(p => p.url())); throw error;
} finally { await context.close(); }
