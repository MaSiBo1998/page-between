// Synthetic books only; isolated extension copy and browser profile.
import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chapterIndex, openChapter } from './reader-browser-helpers.mjs';
const label = process.env.BROWSER_LABEL || 'edge-continuous';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true }); await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
const buildVersion = manifest.version_name ?? manifest.version;
assert.equal(manifest.host_permissions, undefined);
manifest.host_permissions = ['http://127.0.0.1/*', 'http://page-between.test/*']; await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
// Extension URLs bypass page.route in Chromium. Delay only this isolated copy's
// reader module to exercise messages sent before its listeners are installed.
const readerHTML = await readFile(path.join(build, 'reader.html'), 'utf8');
const readerModule = path.join(build, /src="([^"]+\.js)"/.exec(readerHTML)[1].replace(/^\//, ''));
await writeFile(readerModule, 'await new Promise(resolve => setTimeout(resolve, 400));\n' + await readFile(readerModule, 'utf8'));
const testBootFailure = label.includes('reader-boot');
if (testBootFailure) {
  const readerChunk = /import\(["']\.\/(Reader-[^"']+\.js)["']\)/.exec(await readFile(readerModule, 'utf8'))[1];
  const component = path.join(build, 'chunks', readerChunk);
  await writeFile(component, 'if(!sessionStorage.getItem("synthetic-reader-retried")){sessionStorage.setItem("synthetic-reader-retried","1");throw Error("Synthetic reader module failure")}\n' + await readFile(component, 'utf8'));
}
const isChrome = label.startsWith('chrome');
const context = await chromium.launchPersistentContext(path.join(root, 'profile-' + Date.now()), {
  executablePath: process.env.BROWSER_EXE, headless: !isChrome, viewport: { width: 1360, height: 920 },
  ignoreDefaultArgs: ['--disable-extensions'], args: ['--host-resolver-rules=MAP page-between.test 127.0.0.1', '--no-proxy-server', ...(isChrome ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${build}`, `--disable-extensions-except=${build}`])]
});
const checks = [], errors = [];
let failNextChapter = true;
const requests = [];
const fixture = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (req.url === '/ordinary') { res.end('<title>普通网页</title><p>测试浮窗所在的 HTTP 网页。</p>'); return; }
  if (req.url === '/book') {
    res.end('<h1>连续在线合成书</h1><div id="list">' + Array.from({ length: 8 }, (_, i) => `<a href="/chapter/${i + 1}">第${i + 1}章 在线</a>`).join('<br>') + '</div>'); return;
  }
  const url = new URL(req.url, 'http://localhost'), chapter = Number(url.pathname.split('/').at(-1));
  if (!/^\/chapter\/\d+$/.test(url.pathname)) { res.writeHead(404); res.end(); return; }
  requests.push(req.url);
  if (chapter === 2 && failNextChapter && url.searchParams.has('p')) { res.statusCode = 403; res.end('合成访问失败'); return; }
  const second = url.searchParams.has('p');
  res.end(`<h1>第${chapter}章 在线(${second ? 2 : 1}/2)</h1><div id="content">${(`这是合成在线第${chapter}章${second ? '第二' : '第一'}页，完整分页才可以缓存。\n`).repeat(5)}</div><a href="${second ? chapter === 8 ? '/book' : '/chapter/' + (chapter + 1) : url.pathname + '?p=2'}">${second ? '下一章' : '下一页'}</a>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const onlineURL = `http://127.0.0.1:${fixture.address().port}/book`;
const siteURL = `http://page-between.test:${fixture.address().port}/ordinary`;
try {
  let base;
  if (isChrome) {
    const cdp = await context.browser().newBrowserCDPSession(); base = 'chrome-extension://' + (await cdp.send('Extensions.loadUnpacked', { path: build })).id;
  } else {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = worker.url().split('/background.js')[0];
  }
  const site = await context.newPage(); await site.goto(siteURL);
  assert.equal(await site.evaluate(() => isSecureContext), false);
  site.on('pageerror', error => errors.push(error.message));
  site.on('console', message => {
    if (message.type() === 'error' && /target origin|postMessage|Extension context invalidated/i.test(message.text())) errors.push(message.text());
  });
  let control = await context.newPage(); await control.goto(base + '/popup.html');
  await control.getByText('版本：' + buildVersion, { exact: true }).waitFor();
  const rpc = operation => control.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), operation);
  const tabId = await control.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, siteURL);
  const overlay = patch => rpc({ op: 'reader-toggle', tabId, ...patch });
  // Delay the iframe navigation: it still inherits the website's origin here.
  // State changes during loading must queue rather than target about:blank.
  await site.evaluate(() => { const stale = document.createElement('div'); stale.id = 'novel-reader-extension'; stale.dataset.stale = 'true'; document.documentElement.append(stale); });
  await overlay({ visibility: 'show', controls: 'show', view: 'library' });
  await overlay({ visibility: 'hide' });
  await overlay({ visibility: 'keep', controls: 'hide' });
  await site.bringToFront();
  await site.waitForSelector('#novel-reader-extension', { state: 'attached' });
  let frame;
  for (let i = 0; i < 100; i++) {
    frame = site.frames().find(f => f.url().includes('/reader.html'));
    if (frame) break;
    await site.waitForTimeout(50);
  }
  assert.ok(frame);
  if (testBootFailure) {
    await site.waitForFunction(() => document.getElementById('novel-reader-extension').dataset.readerState === 'initialization-error');
    await overlay({ visibility: 'show' });
    await site.getByText('阅读器未能完成加载，请重试。', { exact: true }).waitFor();
    await site.getByRole('button', { name: '重新加载阅读器', exact: true }).click();
    await site.waitForFunction(() => document.getElementById('novel-reader-extension').dataset.readerState === 'ready');
    await overlay({ visibility: 'hide' }); await overlay({ visibility: 'keep', controls: 'hide' });
    checks.push('reader module failure shows parent fallback instead of an invisible frame; retry navigates the iframe and recovers the UI');
  }
  await frame.locator('.reader').waitFor({ state: 'attached' });
  assert.equal(await site.locator('#novel-reader-extension').getAttribute('data-page-between-build'), buildVersion);
  assert.equal(await frame.locator('.reader').getAttribute('data-page-between-build'), buildVersion);
  assert.equal(await site.locator('#novel-reader-extension').getAttribute('data-stale'), null);
  assert.equal(await site.locator('#novel-reader-extension').isVisible(), false);
  await frame.waitForFunction(() => document.querySelector('.reader').dataset.controls === 'hide');
  await overlay({ visibility: 'show', controls: 'show' });
  // A live overlay is reused; forced reinjection cleans up the old context/host.
  const firstFrame = frame;
  await overlay({ visibility: 'show' }); assert.equal(firstFrame.isDetached(), false);
  await control.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/overlay.js'] }), tabId);
  await overlay({ visibility: 'show', controls: 'show', view: 'library' });
  await site.waitForFunction(() => document.querySelectorAll('#novel-reader-extension').length === 1);
  for (let i = 0; i < 100; i++) {
    frame = site.frames().find(f => f.url().includes('/reader.html'));
    if (frame && frame !== firstFrame) break;
    await site.waitForTimeout(50);
  }
  assert.ok(firstFrame.isDetached());
  assert.ok(frame && frame !== firstFrame);
  await frame.locator('.reader').waitFor();
  assert.equal(await frame.locator('.floating-library input[type=url]').count(), 0);
  await overlay({ visibility: 'show', controls: 'show', view: 'online' });
  const address = frame.getByLabel('目录或正文网址');
  assert.equal(await address.inputValue(), '');
  await address.fill(onlineURL);
  await address.press('Home'); await address.press('Shift+End');
  assert.equal(await address.evaluate(field => field.selectionEnd - field.selectionStart), onlineURL.length);
  await address.clear();
  assert.equal(await address.inputValue(), '');
  assert.equal(await frame.getByLabel('小说完整目录网址').count(), 0);
  checks.push('iframe readiness queues show/hide/controls without origin errors; stale host replaced; repeated open reuses live frame; reinjection removes old context');
  const importBook = async (name, text) => {
    await overlay({ visibility: 'show', controls: 'show', view: 'library' });
    await frame.locator('input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
    await frame.locator('[data-block] p').first().waitFor();
    await frame.waitForTimeout(400);
  };
  const dbRead = store => control.evaluate(async store => {
    const database = await new Promise((resolve, reject) => { const req = indexedDB.open('novel-reader', 1); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    try { return await new Promise((resolve, reject) => { const req = database.transaction(store).objectStore(store).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
    finally { database.close(); }
  }, store);
  await importBook('连续短章.txt', Array.from({ length: 720 }, (_, i) => `第${i + 1}章 短章\n${`这是第${i + 1}章的合成正文，阅读无需点击下一章。\n`.repeat(3)}`).join('\n'));
  const article = frame.getByLabel('小说正文');
  const fontSize = () => frame.locator('.continuous-reader').evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(await fontSize(), '14px');
  await frame.waitForFunction(() => document.querySelectorAll('[data-block]').length >= 4);
  assert.equal(await frame.locator('.next-chapter').count(), 0);
  const wheel = async (delta = 80) => {
    await frame.waitForTimeout(175);
    return article.evaluate((el, delta) => {
      const before = el.scrollTop, expected = el.clientHeight - parseFloat(getComputedStyle(el).lineHeight);
      for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, bubbles: true, cancelable: true }));
      return { distance: el.scrollTop - before, expected };
    }, delta);
  };
  const firstWheel = await wheel(); assert.ok(Math.abs(firstWheel.distance - firstWheel.expected) < 2, JSON.stringify(firstWheel));
  await frame.waitForFunction(() => Number(document.querySelector('.continuous-reader')?.dataset.chapterIndex) > 0);
  const afterWheel = await chapterIndex(frame);
  assert.equal(await site.evaluate(() => scrollY), 0);
  await frame.waitForTimeout(300);
  const unique = await article.locator('[data-block]').evaluateAll(elements => new Set(elements.map(el => el.dataset.chunk)).size === elements.length);
  assert.equal(unique, true);
  await wheel(-80); await frame.waitForTimeout(300);
  assert.ok(Number(await chapterIndex(frame)) < Number(afterWheel));
  const skipped = await article.evaluate(el => {
    const before = el.scrollTop;
    const horizontal = new WheelEvent('wheel', { deltaX: 50, deltaY: 0, cancelable: true }); el.dispatchEvent(horizontal);
    const zoom = new WheelEvent('wheel', { deltaY: 50, ctrlKey: true, cancelable: true }); el.dispatchEvent(zoom);
    return !horizontal.defaultPrevented && !zoom.defaultPrevented && el.scrollTop === before;
  }); assert.equal(skipped, true);
  checks.push('short chapters join automatically; wheel burst advances one viewport minus one line; progress follows visible chapter; reverse wheel and horizontal/zoom exclusions');

  await frame.locator('.reader').evaluate(el => { el.dataset.controls = 'auto'; });
  const catalog = frame.getByRole('tab', { name: '目录' });
  const readingTab = () => frame.getByRole('tab', { name: '正文', exact: true });
  await readingTab().focus(); await readingTab().press('ArrowRight');
  assert.equal(await catalog.getAttribute('aria-selected'), 'true');
  assert.equal(await frame.locator('.chapter-list button').count(), 60);
  assert.equal(await frame.getByRole('button', { name: '下一页章节' }).count(), 0);
  await frame.locator('.chapter-list').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await frame.locator('.chapter-list button[data-chapter-index="119"]').waitFor();
  assert.equal(await frame.locator('.chapter-list button').first().getAttribute('data-chapter-index'), '0');
  const search = frame.getByRole('searchbox', { name: '搜索章节' });
  await search.fill('不存在的章节'); await frame.getByText('未找到章节').waitFor();
  await search.fill('短章'); assert.equal(await frame.locator('.chapter-list button').count(), 60);
  await frame.getByRole('button', { name: '当前章' }).click();
  assert.equal(await frame.locator('.chapter-list button[aria-current=true]').count(), 1);
  await site.locator('#novel-reader-extension').screenshot({ path: path.join(root, 'reader-catalog.png') });
  for (const index of [659, 119]) {
    await openChapter(frame, index);
    const start = article.locator(`[data-block][data-chapter="${index}"][data-start="0"]`);
    await start.waitFor();
    await frame.waitForTimeout(420);
    assert.equal(await chapterIndex(frame), String(index));
    assert.ok(Math.abs(await start.evaluate(el => el.getBoundingClientRect().top - el.closest('.reader-scroll').getBoundingClientRect().top)) < 30);
  }
  await openChapter(frame, 0);
  await article.getByText('第1章 短章', { exact: true }).waitFor();
  checks.push('URLs start blank, input text remains selectable, and the chapter list appends on scroll and jumps to the chosen chapter');

  // Real pointer input goes into the extension iframe, not a mocked parent handler.
  await overlay({ controls: 'hide', visibility: 'show' });
  await frame.evaluate(() => {
    window.dragEvents = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture', 'blur']) window.addEventListener(name, event => {
      window.dragEvents.push({ type: event.type, x: event.screenX, y: event.screenY, at: performance.now() });
    }, true);
  });
  await site.evaluate(() => {
    window.parentDragEvents = [];
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'message']) window.addEventListener(name, event => {
      if (event.type !== 'message' || event.data?.type === 'novel-reader-drag') window.parentDragEvents.push([event.type, event.screenX, event.screenY, event.data, event.target?.nodeName]);
    }, true);
  });
  const host = site.locator('#novel-reader-extension');
  let before = await host.boundingBox(), box = await article.boundingBox();
  await site.mouse.move(box.x + box.width - 40, box.y + box.height / 2); await site.mouse.down();
  await site.mouse.move(box.x + box.width + 60, box.y + box.height / 2 + 70);
  await site.waitForFunction(({ x, y }) => {
    const bounds = document.getElementById('novel-reader-extension').getBoundingClientRect();
    return Math.abs(bounds.x - x) < 2 && Math.abs(bounds.y - y) < 2;
  }, { x: before.x + 100, y: before.y + 70 }, { timeout: 2000 }).catch(async error => {
    throw Error(JSON.stringify({ before, after: await host.boundingBox(), box, frameEvents: await frame.evaluate(() => window.dragEvents), parentEvents: await site.evaluate(() => window.parentDragEvents) }), { cause: error });
  });
  await site.mouse.up();
  await site.waitForTimeout(150);
  let after = await host.boundingBox();
  assert.ok(Math.abs(after.x - before.x - 100) < 2 && Math.abs(after.y - before.y - 70) < 2, JSON.stringify({ before, after, events: await frame.evaluate(() => window.dragEvents) }));
  assert.equal(await frame.locator('html').evaluate(el => el.classList.contains('reader-dragging')), false);
  const stored = await control.evaluate(() => chrome.storage.local.get('readerPrefs'));
  assert.equal(stored.readerPrefs.x, after.x);
  const paragraphIndex = await article.evaluate(el => [...el.querySelectorAll('[data-offset]')].findIndex(p => {
    const rect = p.getBoundingClientRect(), view = el.getBoundingClientRect(); return rect.top > view.top + 30 && rect.bottom < view.bottom - 30;
  }));
  assert.ok(paragraphIndex >= 0);
  const textBox = await article.locator('[data-offset]').nth(paragraphIndex).boundingBox(); before = after;
  await site.mouse.move(textBox.x + 8, textBox.y + 10);
  await site.mouse.down(); await site.mouse.move(textBox.x - 36, textBox.y + 10); await site.mouse.up();
  after = await host.boundingBox(); assert.equal(after.x, before.x - 44); assert.equal(after.y, before.y);
  assert.equal(await frame.evaluate(() => window.getSelection().toString()), '');
  assert.equal(await frame.locator('html').evaluate(el => el.classList.contains('reader-dragging')), false);
  await overlay({ controls: 'show', visibility: 'show', view: 'library' });
  const shelf = frame.locator('.floating-library'); await shelf.waitFor();
  const shelfBox = await shelf.boundingBox(); before = await host.boundingBox();
  await site.mouse.move(shelfBox.x + 12, shelfBox.y + 90); await site.mouse.down();
  await site.mouse.move(shelfBox.x + 44, shelfBox.y + 108); await site.mouse.up();
  after = await host.boundingBox(); assert.equal(after.x, before.x + 32); assert.equal(after.y, before.y + 18);
  await readingTab().click();
  checks.push('immediate mouse drag follows the pointer before release, crosses the original frame boundary, persists position and works on bookshelf whitespace without selecting text');
  await site.bringToFront();
  await site.locator('#novel-reader-extension .frame[data-controls="show"] .grab').waitFor();
  before = await host.boundingBox();
  await site.evaluate(() => {
    const grab = document.getElementById('novel-reader-extension').shadowRoot.querySelector('.grab');
    window.handleEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture']) grab.addEventListener(type, event => window.handleEvents.push([type, event.clientX, event.clientY]));
    window.addEventListener('blur', () => window.handleEvents.push(['blur']), { once: true });
  });
  const handlePoint = { x: before.x + before.width / 2, y: before.y + 8 };
  await site.mouse.move(15, 15);
  await site.mouse.move(handlePoint.x, handlePoint.y);
  const hit = await site.evaluate(({ x, y }) => document.getElementById('novel-reader-extension').shadowRoot.elementFromPoint(x, y)?.className, handlePoint);
  await site.mouse.down(); await site.mouse.move(handlePoint.x + 20, handlePoint.y + 20); await site.mouse.up();
  after = await host.boundingBox(); assert.ok(Math.abs(after.x - before.x - 20) < 2, JSON.stringify({ before, after, hit, events: await site.evaluate(() => window.handleEvents) }));
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const west = corner.endsWith('w'), north = corner.startsWith('n');
    const fixed = box => [west ? box.x + box.width : box.x, north ? box.y + box.height : box.y];
    for (const distance of [24, -24]) {
      before = await host.boundingBox();
      const handle = await host.locator(`.resize[data-corner="${corner}"]`).boundingBox();
      const center = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      await site.mouse.move(center.x, center.y); await site.mouse.down();
      await site.mouse.move(center.x + (west ? -distance : distance), center.y + (north ? -distance : distance), { steps: 3 }); await site.mouse.up();
      after = await host.boundingBox();
      assert.deepEqual(fixed(after), fixed(before), corner);
      assert.ok(Math.abs(after.width - before.width - distance) < 2 && Math.abs(after.height - before.height - distance) < 2, JSON.stringify({ corner, before, after }));
    }
  }
  for (const edge of ['n', 's', 'w', 'e']) {
    const grip = host.locator(`.resize[data-edge="${edge}"]`);
    const handle = await grip.boundingBox(); before = await host.boundingBox();
    const vertical = edge === 'n' || edge === 's';
    const delta = edge === 'n' || edge === 'w' ? -18 : 18;
    const fixed = bounds => edge === 'n' ? bounds.y + bounds.height : edge === 'w' ? bounds.x + bounds.width : vertical ? bounds.y : bounds.x;
    const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
    await site.mouse.move(x, y); await site.mouse.down(); await site.mouse.move(x + (vertical ? 5 : delta), y + (vertical ? delta : 5)); await site.mouse.up();
    after = await host.boundingBox();
    assert.equal(fixed(after), fixed(before));
    assert.equal(after.width - before.width, vertical ? 0 : 18);
    assert.equal(after.height - before.height, vertical ? 18 : 0);
    assert.equal(await grip.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  }
  const corner = host.locator('.resize[data-corner="se"]');
  before = await host.boundingBox(); await corner.focus(); await corner.press('ArrowRight');
  after = await host.boundingBox(); assert.equal(after.width - before.width, 8);
  await site.setViewportSize({ width: 700, height: 730 });
  await site.waitForFunction(() => {
    const box = document.getElementById('novel-reader-extension').getBoundingClientRect();
    return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
  });
  after = await host.boundingBox(); assert.ok(after.x >= 0 && after.y >= 0 && after.x + after.width <= 701 && after.y + after.height <= 731);
  await site.setViewportSize({ width: 1360, height: 920 });
  checks.push('top handle drags immediately; invisible edges resize along one axis and corners resize along both; keyboard resizing and viewport clamping work');
  box = await article.boundingBox(); await site.mouse.move(box.x + 40, box.y + 120); await site.mouse.down();
  await site.mouse.move(box.x + 55, box.y + 130);
  await frame.waitForFunction(() => document.documentElement.classList.contains('reader-dragging'));
  await overlay({ visibility: 'hide' });
  await frame.waitForFunction(() => !document.documentElement.classList.contains('reader-dragging'));
  await site.mouse.up(); await overlay({ visibility: 'show' });
  checks.push('hiding while dragging releases capture');

  await importBook('大章节连续.txt', '第一章 长篇\n' + Array.from({ length: 3500 }, (_, i) => `第${i}行：长章节的合成文字，位置应在刷新和字体调整后保持。`).join('\n') + '\n第二章 HTML\n<script>window.unsafe=true</script>');
  await overlay({ controls: 'show', visibility: 'show' });
  for (let i = 0; i < 12; i++) { await wheel(); await frame.waitForTimeout(80); }
  await frame.waitForTimeout(450);
  const blocks = await article.locator('[data-block]').count(); assert.ok(blocks < 12, `unbounded DOM: ${blocks}`);
  const positions = await dbRead('positions'), books = await dbRead('books');
  const long = books.find(book => book.title === '大章节连续'); const position = positions.find(p => p.bookId === long.id);
  assert.ok(position.offset > 800, JSON.stringify(position));
  // Switch panels and resize without losing the text anchor.
  await frame.getByRole('button', { name: '搜书', exact: true }).click(); await readingTab().click();
  await frame.getByLabel('阅读设置', { exact: true }).click();
  const fontField = frame.getByRole('spinbutton', { name: '字号' });
  const settingsPanel = frame.locator('#reader-options');
  assert.equal(await fontField.inputValue(), '14');
  await fontField.fill('25');
  assert.equal(await fontField.evaluate(el => document.activeElement === el), true);
  assert.equal(await fontSize(), '25px');
  await fontField.fill('');
  assert.equal(await fontSize(), '25px');
  await article.click({ position: { x: 28, y: 24 } }); await settingsPanel.waitFor({ state: 'hidden' });
  assert.equal(await fontSize(), '25px');
  await frame.getByLabel('阅读设置', { exact: true }).click();
  assert.equal(await fontField.inputValue(), '25');
  const settingsDrag = await article.boundingBox(), beforeSettingsDrag = await host.boundingBox();
  await site.mouse.move(settingsDrag.x + 28, settingsDrag.y + 24); await site.mouse.down();
  await site.mouse.move(settingsDrag.x + 40, settingsDrag.y + 24); await site.mouse.up();
  assert.equal((await host.boundingBox()).x, beforeSettingsDrag.x + 12);
  assert.equal(await settingsPanel.isVisible(), true);
  await frame.getByRole('button', { name: '收起设置' }).click(); await frame.waitForTimeout(450);
  const changed = (await dbRead('positions')).find(p => p.bookId === long.id);
  assert.ok(Math.abs(changed.offset - position.offset) < 120, JSON.stringify({ position, changed }));
  await frame.getByLabel('阅读设置', { exact: true }).click();
  const shortcutInput = frame.getByRole('textbox', { name: '隐藏 / 恢复', exact: true });
  assert.equal(await shortcutInput.inputValue(), 'Alt+R');
  await shortcutInput.press('Alt+r');
  assert.equal(await host.isVisible(), true);
  await shortcutInput.fill('K'); await shortcutInput.press('Enter');
  await settingsPanel.getByRole('alert').filter({ hasText: '请输入有效组合键' }).waitFor();
  await shortcutInput.fill('shift + alt + 2'); await shortcutInput.press('Enter');
  await settingsPanel.getByRole('alert').filter({ hasText: '快捷键冲突' }).waitFor();
  await shortcutInput.press('Escape');
  assert.equal(await shortcutInput.inputValue(), 'Alt+R');
  assert.equal(await host.isVisible(), true);
  const waitShortcut = value => control.waitForFunction(async shortcut => (await chrome.storage.local.get('readerPrefs')).readerPrefs?.shortcut === shortcut, value);
  await shortcutInput.fill(' alt + k '); await shortcutInput.press('Enter');
  await waitShortcut('Alt+K');
  assert.equal(await shortcutInput.inputValue(), 'Alt+K');
  await shortcutInput.press('Alt+Shift+8');
  await waitShortcut('Alt+Shift+8');
  assert.equal(await shortcutInput.inputValue(), 'Alt+Shift+8');
  await settingsPanel.screenshot({ path: path.join(root, 'custom-shortcut.png') });
  await frame.getByRole('button', { name: '收起设置' }).click();
  await site.keyboard.press('Alt+Shift+8');
  await host.waitFor({ state: 'hidden' });
  await site.keyboard.press('Alt+r');
  assert.equal(await host.isVisible(), false);
  await site.keyboard.press('Alt+Shift+8');
  await host.waitFor();
  await site.reload(); await overlay({ visibility: 'show', controls: 'show' }); await site.bringToFront();
  await site.waitForSelector('#novel-reader-extension');
  for (let i = 0; i < 100; i++) { frame = site.frames().find(f => f.url().includes('/reader.html')); if (frame) break; await site.waitForTimeout(50); }
  await frame.locator('[data-block] p').first().waitFor(); await frame.waitForTimeout(500);
  assert.equal(await fontSize(), '25px');
  await frame.getByLabel('阅读设置', { exact: true }).click();
  assert.equal(await frame.getByRole('textbox', { name: '隐藏 / 恢复', exact: true }).inputValue(), 'Alt+Shift+8');
  await frame.getByRole('button', { name: '收起设置' }).click();
  const restored = (await dbRead('positions')).find(p => p.bookId === long.id);
  assert.ok(Math.abs(restored.offset - changed.offset) < 120, JSON.stringify({ changed, restored }));
  await openChapter(frame, 1); await frame.getByText('<script>window.unsafe=true</script>', { exact: true }).waitFor();
  assert.equal(await frame.evaluate(() => window.unsafe), undefined);
  checks.push('long chapter DOM bounded while scrolling; chapter/text offset survives panel switch, font resize and page reload; explicit directory jump; HTML stays inert');
  checks.push('14px default, valid font changes while focused, empty input does not change font, body click closes settings, drag keeps settings open, saved font persists after reload');
  checks.push('shortcut accepts typed text and recorded keys, rejects invalid or reserved shortcuts, Escape cancels editing, and the new combination hides/restores and persists across reload');

  // Online chapter 2 fails on page 2: current text survives and no partial chapter commits.
  const opened = await rpc({ op: 'open-online', url: onlineURL, rules: {}, settings: { concurrency: 6, minInterval: 50, maxInterval: 80 } });
  assert.equal(opened.ok, true, JSON.stringify(opened)); const online = opened.data;
  await overlay({ bookId: online.id, view: 'online', visibility: 'show', controls: 'show' });
  await site.waitForTimeout(350); assert.equal(requests.length, 0, 'search-first view must not start reading requests');
  await readingTab().click();
  const onlineArticle = frame.getByLabel('小说正文');
  await onlineArticle.getByText(/合成在线第1章第二页/).first().waitFor();
  await onlineArticle.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await frame.getByRole('button', { name: '重试加载', exact: true }).waitFor({ timeout: 8000 }).catch(async error => {
    console.error({ requests, reader: (await frame.locator('.reader').innerText()).slice(-600), errors });
    throw error;
  });
  assert.ok((await frame.getByLabel('小说正文').innerText()).includes('合成在线第1章第二页'));
  const failedBook = (await dbRead('books')).find(book => book.id === online.id);
  assert.equal(failedBook.chapters[1].chunks, 0);
  failNextChapter = false;
  await frame.getByRole('button', { name: '重试加载', exact: true }).click();
  await frame.getByText(/合成在线第2章第二页/).first().waitFor();
  assert.equal(await frame.getByRole('button', { name: '重试加载', exact: true }).count(), 0);
  const cached = (await dbRead('books')).find(book => book.id === online.id);
  assert.ok(cached.chapters[1].chunks > 0); assert.equal(cached.chapters[7].chunks, 0);
  assert.equal(await frame.locator('[data-block]').evaluateAll(elements => new Set(elements.map(el => el.dataset.chunk)).size === elements.length), true);
  await overlay({ visibility: 'hide' }); await site.waitForTimeout(200);
  const hiddenCount = requests.length;
  await frame.getByLabel('小说正文').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await site.waitForTimeout(500); assert.equal(requests.length, hiddenCount);
  await overlay({ visibility: 'show', controls: 'show' });
  await frame.getByRole('button', { name: '搜书', exact: true }).click(); await site.waitForTimeout(200);
  const searchCount = requests.length; await site.waitForTimeout(500); assert.equal(requests.length, searchCount);
  await readingTab().click();
  checks.push('online pagination commits whole chapters; failed following chapter keeps current text and retries without duplication; tail chapters stay uncached; hiding/switching panels starts no new reading requests');
  await overlay({ visibility: 'show', controls: 'show', view: 'online' });
  await control.getByRole('button', { name: '应用本地更新 · 重新加载扩展', exact: true }).click().catch(error => {
    if (!/closed|destroyed/i.test(error.message)) throw error;
  });
  await site.waitForTimeout(2100);
  await site.keyboard.press('Alt+q');
  control = await context.newPage();
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await control.goto(base + '/popup.html'); if (await control.evaluate(() => !!chrome.runtime?.id)) break; }
    catch { /* The extension is restarting. */ }
    await site.waitForTimeout(100);
  }
  assert.equal((await overlay({ visibility: 'show', controls: 'show', view: 'online' })).ok, true);
  for (let attempt = 0; attempt < 100; attempt++) {
    frame = site.frames().find(f => f.url().includes('/reader.html'));
    if (frame) break;
    await site.waitForTimeout(50);
  }
  assert.ok(frame); await frame.getByRole('region', { name: '搜书面板' }).waitFor();
  assert.equal(await control.evaluate(() => { const info = chrome.runtime.getManifest(); return info.version_name ?? info.version; }), buildVersion);
  assert.equal(await site.locator('#novel-reader-extension').getAttribute('data-page-between-build'), buildVersion);
  assert.equal(await site.locator('#novel-reader-extension').count(), 1);
  await site.waitForTimeout(2000);
  checks.push('popup build marker and apply-update button; actual extension reload with search mounted; existing website rebuilds one overlay with matching runtime/host/frame build markers');
  await readingTab().click(); await frame.getByLabel('小说正文').waitFor();
  await host.screenshot({ path: path.join(root, 'continuous-reader.png') });
  await site.setViewportSize({ width: 300, height: 620 });
  await frame.getByRole('tab', { name: '目录' }).click();
  const fits = await frame.locator('.reader-header').evaluate(header => {
    const bounds = header.getBoundingClientRect();
    return Array.from(header.querySelectorAll('button')).every(button => button.getBoundingClientRect().right <= bounds.right);
  });
  assert.ok(fits, 'compact header controls must fit at 300px');
  await host.screenshot({ path: path.join(root, 'reader-narrow.png') });
  checks.push('reading tabs and utility controls stay in bounds at 300px');
  assert.deepEqual(errors, []);
  const result = { label, version: context.browser().version(), checks, errors };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); await new Promise(resolve => fixture.close(resolve)); }
