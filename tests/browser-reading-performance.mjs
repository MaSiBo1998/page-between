// Same browser, viewport and synthetic book for baseline/optimized build comparisons.
import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const label = process.env.BROWSER_LABEL || 'edge-reader-performance';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true });
await cp(process.env.PERF_EXTENSION || '.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*']; await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));
const isChrome = label.startsWith('chrome');
const context = await chromium.launchPersistentContext(path.join(root, 'profile-' + Date.now()), {
  executablePath: process.env.BROWSER_EXE, headless: !isChrome, viewport: { width: 1360, height: 920 },
  ignoreDefaultArgs: ['--disable-extensions'], args: isChrome ? ['--enable-unsafe-extension-debugging'] : [`--load-extension=${build}`, `--disable-extensions-except=${build}`]
});
try {
  let base;
  if (isChrome) {
    const cdp = await context.browser().newBrowserCDPSession(); base = 'chrome-extension://' + (await cdp.send('Extensions.loadUnpacked', { path: build })).id;
  } else {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = worker.url().split('/background.js')[0];
  }
  const site = await context.newPage(); await site.goto('http://127.0.0.1:18765/ordinary');
  const control = await context.newPage(); await control.goto(base + '/popup.html');
  const tabId = await control.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:18765/ordinary' }))[0].id);
  const overlay = patch => control.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), { op: 'reader-toggle', tabId, ...patch });
  await overlay({ visibility: 'show', controls: 'hide', view: 'library' }); await site.bringToFront();
  await site.waitForSelector('#novel-reader-extension');
  let frame;
  for (let i = 0; i < 100; i++) {
    frame = site.frames().find(f => f.url().includes('/reader.html')); if (frame) break;
    await site.waitForTimeout(50);
  }
  assert.ok(frame);
  const text = Array.from({ length: 1000 }, (_, chapter) => `第${chapter + 1}章 性能测试\n` +
    Array.from({ length: chapter % 17 === 0 ? 100 : 10 }, (_, line) => `这是第${chapter + 1}章第${line + 1}段的合成阅读正文，用于检查长时间前后翻读的节点和计算开销。`).join('\n')).join('\n');
  await frame.locator('input[type=file]').setInputFiles({ name: '千章性能合成.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  await frame.locator('[data-block] p').first().waitFor();
  await frame.waitForTimeout(400);
  await frame.evaluate(() => {
    window.readingMetrics = { ranges: 0, elements: 0, writes: 0 };
    const rangeRect = Range.prototype.getBoundingClientRect, elementRect = Element.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function () { window.readingMetrics.ranges++; return rangeRect.call(this); };
    Element.prototype.getBoundingClientRect = function () { window.readingMetrics.elements++; return elementRect.call(this); };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'positions') window.readingMetrics.writes++; return put.apply(this, args); };
  });
  const bursts = [];
  for (let sample = 0; sample < 3; sample++) {
    bursts.push(await frame.evaluate(async () => {
      const el = document.querySelector('.reader-scroll'); window.readingMetrics.ranges = 0; window.readingMetrics.elements = 0;
      const started = performance.now();
      for (let n = 0; n < 400; n++) el.dispatchEvent(new Event('scroll'));
      const handlerMs = performance.now() - started;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { handlerMs, ranges: window.readingMetrics.ranges, elements: window.readingMetrics.elements };
    }));
  }
  const cdp = await context.newCDPSession(frame);
  const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
  const soak = async (steps, direction) => frame.evaluate(async ({ steps, direction }) => {
    const view = document.querySelector('.reader-scroll'), samples = [];
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const started = performance.now();
    for (let n = 0; n < steps; n++) {
      view.scrollTop += direction * (view.clientHeight - parseFloat(getComputedStyle(view).lineHeight));
      view.dispatchEvent(new Event('scroll'));
      await frame(); await frame();
      for (let wait = 0; wait < 20 && view.querySelector('[role=status]'); wait++) await frame();
      const blocks = [...view.querySelectorAll('[data-block]')];
      samples.push({ blocks: blocks.length, nodes: view.querySelectorAll('*').length, chars: blocks.reduce((n, block) => n + block.textContent.length, 0) });
      if (new Set(blocks.map(block => block.dataset.chunk)).size !== blocks.length) throw Error('duplicate display block');
    }
    return { ms: performance.now() - started, maxBlocks: Math.max(...samples.map(s => s.blocks)), maxNodes: Math.max(...samples.map(s => s.nodes)), maxChars: Math.max(...samples.map(s => s.chars)), chapter: Number(document.querySelector('.continuous-reader').dataset.chapterIndex), samples };
  }, { steps, direction });
  await soak(30, 1); const warmHeap = await heap();
  const forward = await soak(240, 1); const forwardHeap = await heap();
  const backward = await soak(100, -1); const finalHeap = await heap();
  assert.ok(forward.chapter > backward.chapter, 'reverse scrolling must restore previous chapters');
  assert.ok(forward.maxBlocks < 24 && backward.maxBlocks < 24, 'display window grows beyond viewport buffer');
  assert.ok(forward.maxChars < 18000 && backward.maxChars < 18000, 'mounted text grows with pages read');
  assert.ok(finalHeap < warmHeap + 8 * 1024 * 1024, 'live JS heap grows unexpectedly after GC');
  await overlay({ visibility: 'hide' }); await site.waitForTimeout(100);
  const hidden = await frame.evaluate(async () => {
    window.readingMetrics.ranges = 0; const view = document.querySelector('.reader-scroll');
    for (let n = 0; n < 400; n++) view.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 120));
    return { ranges: window.readingMetrics.ranges, writes: window.readingMetrics.writes };
  });
  assert.equal(hidden.ranges, 0);
  const result = { label, version: context.browser().version(), bursts, warmHeap, forwardHeap, finalHeap, forward, backward, hidden };
  if (process.env.PERF_COMPARE) {
    const baseline = JSON.parse(await readFile(process.env.PERF_COMPARE, 'utf8'));
    assert.equal(result.version, baseline.version, 'compare the same browser version');
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    assert.ok(median(bursts.map(s => s.ranges)) < median(baseline.bursts.map(s => s.ranges)) / 10, 'duplicate scroll events still trigger repeated text measurements');
    assert.equal(forward.chapter, baseline.forward.chapter, 'optimization changed forward reading distance');
    assert.equal(backward.chapter, baseline.backward.chapter, 'optimization changed backward reading distance');
  }
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, forward: { ...forward, samples: undefined }, backward: { ...backward, samples: undefined } }, null, 2));
} finally { await context.close(); }
