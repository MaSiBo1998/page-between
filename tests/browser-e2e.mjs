import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// The fixture build adds access ONLY to the synthetic localhost server, so unattended
// tests do not click native permission dialogs. Production optional permissions stay unchanged.
const executablePath = process.env.BROWSER_EXE;
if (!executablePath) throw Error('Set BROWSER_EXE to Chrome, Edge or Chrome for Testing.');
const label = process.env.BROWSER_LABEL || 'chromium';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true });
await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
const profile = path.join(root, 'profile');
const launch = () => chromium.launchPersistentContext(profile, {
  executablePath, headless: label !== 'chrome-stable', viewport: { width: 1440, height: 1000 },
  ignoreDefaultArgs: ['--disable-extensions'],
  args: label === 'chrome-stable' ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${build}`, `--load-extension=${build}`, '--enable-unsafe-extension-debugging', '--disable-features=DisableLoadExtensionCommandLineSwitch']
});
let context = await launch();
const checks = [], errors = [];
try {
  let worker = context.serviceWorkers().find(w => w.url().includes('/background.js'));
  let base;
  if (!worker && label.startsWith('chrome')) {
    const session = await context.browser().newBrowserCDPSession();
    const installed = await session.send('Extensions.loadUnpacked', { path: build });
    console.log('CDP extension install', installed); base = 'chrome-extension://' + installed.id;
    worker = context.serviceWorkers().find(w => w.url().includes('/background.js'));
  }
  if (!base) {
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    base = worker.url().split('/background.js')[0];
  }
  const source = await context.newPage(); await source.goto('http://127.0.0.1:18765/book');
  let manager = await context.newPage();
  manager.on('pageerror', error => errors.push(error.message));
  await manager.goto(base + '/manager.html');
  const sourceId = await manager.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:18765/book' }))[0].id);
  await manager.goto(base + '/manager.html?tab=' + sourceId);
  const rpc = (page, op) => page.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), op);
  const waitJob = async (page, predicate, timeout = 45000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const result = await rpc(page, { op: 'status' });
      if (!result.ok) throw Error(result.error);
      if (predicate(result.data)) return result.data;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw Error('Task did not reach expected state: ' + JSON.stringify((await rpc(page, { op: 'status' })).data));
  };
  await rpc(manager, { op: 'cancel' });
  await manager.getByRole('textbox', { name: '小说完整目录网址' }).fill('http://127.0.0.1:18765/book');
  await manager.getByRole('button', { name: '授权并识别目录 →' }).click();
  await manager.getByLabel('起始章节').waitFor();
  await manager.getByLabel('起始章节').selectOption('2'); await manager.getByLabel('结束章节').selectOption('9');
  await manager.getByRole('button', { name: '预览起始章', exact: true }).click();
  await manager.getByRole('button', { name: '开始后台下载', exact: true }).waitFor({ state: 'visible' });
  await manager.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '开始后台下载').disabled);
  await manager.getByRole('button', { name: '开始后台下载', exact: true }).click();
  await waitJob(manager, job => job?.pageCount > 0 && job.status === 'running');
  await source.close(); await manager.close();
  // No source page, popup, or management page remains open during the download.
  await new Promise(resolve => setTimeout(resolve, 7000));
  manager = await context.newPage(); await manager.goto(base + '/manager.html');
  const completed = await waitJob(manager, job => job?.status === 'complete');
  assert.equal(completed.completed, 8); assert.equal(completed.pageCount, 16); assert.equal(completed.start, 2); assert.equal(completed.end, 9);
  checks.push('range 3–10, 8 chapters / 16 pages, continues after UI and source close');
  const downloadDir = path.join(root, 'downloads'); await mkdir(downloadDir, { recursive: true });
  const browserSession = await context.browser().newBrowserCDPSession();
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  const exported = await rpc(manager, { op: 'export' }); assert.equal(exported.ok, true);
  let download;
  for (let count = 0; count < 40; count++) {
    download = await manager.evaluate(async id => (await chrome.downloads.search({ id }))[0], exported.data);
    if (download?.state === 'complete') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(download?.state, 'complete');
  const txt = await readFile(download.filename, 'utf8');
  assert.ok(txt.includes('第3章 测试')); assert.ok(txt.includes('第10章 测试')); assert.ok(!txt.includes('第2章 测试'));
  checks.push('TXT export reaches browser download list and contains only the selected range');
  const book = (await rpc(manager, { op: 'read-job' })).data;
  assert.equal(book.chapters.length, 8);
  const reader = await context.newPage(); await reader.goto(base + '/reader.html?book=' + encodeURIComponent(book.id));
  await reader.getByLabel('小说正文').waitFor();
  await reader.getByLabel('章节目录').selectOption('2');
  await reader.waitForFunction(() => document.querySelector('.reader-scroll h2')?.textContent.includes('第5章'));
  await reader.locator('.reader-scroll').evaluate(el => { el.scrollTop = 400; el.dispatchEvent(new Event('scroll')); });
  await reader.waitForTimeout(500); await reader.reload();
  await reader.waitForFunction(() => document.querySelector('.reader-scroll h2')?.textContent.includes('第5章'));
  assert.ok(await reader.locator('.reader-scroll').evaluate(el => el.scrollTop) > 100);
  checks.push('downloaded book, chapter navigation and text position survive reload');
  await reader.getByRole('button', { name: '阅读设置' }).click();
  await reader.locator('input[type=range]').first().fill('24');
  await reader.getByRole('button', { name: '隐藏阅读器' }).click();
  await reader.getByRole('button', { name: /恢复阅读/ }).click();
  checks.push('font settings and hide/restore work');
  const site = await context.newPage(); await site.goto('http://127.0.0.1:18765/ordinary');
  await manager.evaluate(async () => {
    const saved = await chrome.storage.local.get('readerPrefs');
    await chrome.storage.local.set({ readerPrefs: { ...saved.readerPrefs, x: 80, y: 80, width: 560, height: 620 } });
  });
  const tabId = await manager.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:18765/ordinary' }))[0].id);
  const overlay = await rpc(manager, { op: 'reader-toggle', bookId: book.id, tabId });
  assert.equal(overlay.ok, true); await site.waitForSelector('#novel-reader-extension');
  const frame = site.frames().find(f => f.url().includes('/reader.html'));
  assert.ok(frame); await frame.getByLabel('小说正文').waitFor();
  const before = await site.locator('#novel-reader-extension').boundingBox();
  await site.mouse.move(before.x + before.width / 2, before.y + 3); await site.mouse.down();
  await site.mouse.move(before.x + before.width / 2 + 120, before.y + 83, { steps: 8 }); await site.mouse.up();
  const after = await site.locator('#novel-reader-extension').boundingBox();
  assert.ok(after.x >= before.x + 100); assert.ok(after.y >= before.y + 60);
  await site.mouse.move(after.x + after.width - 4, after.y + after.height - 4); await site.mouse.down();
  await site.mouse.move(after.x + after.width + 46, after.y + after.height + 46, { steps: 5 }); await site.mouse.up();
  const resized = await site.locator('#novel-reader-extension').boundingBox(); assert.ok(resized.width > after.width);
  await site.locator('h1').click(); await site.keyboard.press('Alt+r');
  await site.waitForFunction(() => document.getElementById('novel-reader-extension').style.display === 'none');
  await site.keyboard.press('Alt+r'); await site.waitForSelector('#novel-reader-extension', { state: 'visible' });
  await site.screenshot({ path: path.join(root, 'overlay.png') });
  checks.push('ordinary page overlay: drag, resize, hide, restore');
  await manager.getByRole('button', { name: /本地书架/ }).click();
  const input = manager.locator('input[type=file]');
  await input.setInputFiles({ name: '合成TXT测试.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 本地导入\n' + '这是合成导入内容。\n'.repeat(100) + '\n第二章 继续\n纯文本 <script>window.unsafe=true</script>') });
  await manager.getByRole('heading', { name: '合成TXT测试', exact: true }).waitFor();
  await input.setInputFiles({ name: '重复.txt', mimeType: 'text/plain', buffer: Buffer.from('第一章 本地导入\n' + '这是合成导入内容。\n'.repeat(100) + '\n第二章 继续\n纯文本 <script>window.unsafe=true</script>') });
  await manager.waitForTimeout(400);
  assert.equal(await manager.getByRole('heading', { name: '合成TXT测试', exact: true }).count(), 1);
  checks.push('TXT import and digest deduplication');
  await manager.screenshot({ path: path.join(root, 'library.png'), fullPage: true });
  // Begin a new task and restart the browser while pages are being saved.
  const scan = { title: '重启测试', bookURL: 'http://127.0.0.1:18765/book', catalog: Array.from({ length: 24 }, (_, i) => ({ title: `第${i + 1}章 测试`, url: `http://127.0.0.1:18765/chapter/${i + 1}` })), catalogURLs: ['http://127.0.0.1:18765/book'], rules: {} };
  const started = await rpc(manager, { op: 'start', scan, start: 0, end: 23, settings: { concurrency: 6, minInterval: 200, maxInterval: 600 } }); assert.equal(started.ok, true);
  const checkpoint = await waitJob(manager, job => job?.id === started.data.id && job.pageCount >= 2);
  console.log('BEFORE RESTART', { id: checkpoint.id, pageCount: checkpoint.pageCount });
  await context.close(); context = await launch();
  if (label === 'chrome-stable') {
    const session = await context.browser().newBrowserCDPSession();
    await session.send('Extensions.loadUnpacked', { path: build });
  }
  manager = await context.newPage(); await manager.goto(base + '/manager.html');
  const restored = (await rpc(manager, { op: 'status' })).data;
  console.log('AFTER RESTART', { id: restored.id, pageCount: restored.pageCount, status: restored.status });
  assert.equal(restored.status, 'paused'); assert.ok(restored.pageCount > 0);
  assert.equal((await rpc(manager, { op: 'resume' })).ok, true);
  await waitJob(manager, job => job?.status === 'complete');
  assert.equal((await rpc(manager, { op: 'status' })).data.pageCount, 48);
  checks.push('browser restart preserves committed pages; resume finishes 24 chapters / 48 pages');
  assert.deepEqual(errors, []);
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ label, version: context.browser()?.version(), checks, errors, permissionNote: 'Localhost host permission added to test-only manifest; production optional permission prompt requires manual acceptance.' }, null, 2));
  console.log(JSON.stringify({ label, checks, errors }, null, 2));
} catch (error) {
  const page = context.pages().at(-1); if (page) { console.log((await page.locator('body').innerText()).slice(0, 3000)); await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); }
  throw error;
} finally { await context.close(); }
