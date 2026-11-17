// Optional real-site smoke test: only the first TWO chapters; never a whole book.
// No copyrighted HTML/text fixtures or exports are written by this script.
import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sites } from '../src/legacy/sites.js';

if (!process.env.LIVE_BOOK_URL || !process.env.BROWSER_EXE) throw Error('Set LIVE_BOOK_URL and BROWSER_EXE explicitly.');
const url = new URL(process.env.LIVE_BOOK_URL);
if (!/^https?:$/.test(url.protocol)) throw Error('HTTP(S) required.');
const root = path.resolve('test-results', 'live-' + Date.now()), build = path.join(root, 'extension');
await mkdir(root, { recursive: true }); await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
const site = sites.find(site => url.hostname === site.domain || url.hostname.endsWith('.' + site.domain));
manifest.host_permissions = [site ? url.protocol + '//*.' + site.domain + '/*' : url.origin + '/*'];
await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
  executablePath: process.env.BROWSER_EXE, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${build}`, `--disable-extensions-except=${build}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().split('/background.js')[0];
  const page = await context.newPage(); await page.goto(base + '/manager.html');
  const rpc = op => page.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), op);
  await page.getByLabel('小说完整目录网址').fill(url.href);
  await page.getByRole('button', { name: '授权并识别目录 →', exact: true }).click();
  await page.getByLabel('起始章节').waitFor({ timeout: 60000 });
  const catalogCount = await page.getByLabel('起始章节').locator('option').count();
  await page.getByLabel('结束章节').selectOption('1');
  assert.equal(await page.getByRole('button', { name: '开始后台下载', exact: true }).isEnabled(), true);
  await page.getByRole('button', { name: '开始后台下载', exact: true }).click();
  let job;
  for (let n = 0; n < 300; n++) {
    job = (await rpc({ op: 'status' })).data;
    if (job?.status === 'complete') break;
    const errors = await page.getByRole('alert').allTextContents();
    if (job?.status === 'error' || errors.length) throw Error(job?.error || errors.join(';'));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.equal(job?.status, 'complete'); assert.equal(job?.completed, 2); assert.ok(job.chars > 100);
  const opened = await rpc({ op: 'open-online', url: url.href, rules: {}, settings: job.settings });
  assert.equal(opened.ok, true, opened.error);
  const chapter = await rpc({ op: 'online-chapter', bookId: opened.data.id, index: 0 });
  assert.equal(chapter.ok, true, chapter.error); assert.ok(chapter.data.chapters[0].length > 100);
  const result = { url: url.href, version: context.browser().version(), catalogCount, downloadedChapters: job.completed, savedPages: job.pageCount, savedCharacters: job.chars,
    onlineChapterCharacters: chapter.data.chapters[0].length, wholeBook: false, permissionDialogTested: false };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(await context.pages().at(-1)?.locator('body').innerText()); throw error; } finally { await context.close(); }
