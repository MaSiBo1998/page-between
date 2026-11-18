import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve('test-results/edge-final');
const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
  executablePath: process.env.BROWSER_EXE, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
  args: [`--load-extension=${path.join(root, 'extension')}`, `--disable-extensions-except=${path.join(root, 'extension')}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().split('/background.js')[0];
  const manager = await context.newPage(); await manager.goto(base + '/manager.html#library');
  const text = '第一章 长正文\n' + '这是分块滚动阅读测试，每一行都有可定位的文字。\n'.repeat(4000) + '\n第二章 纯文本\n<script>window.unsafe=true</script>';
  await manager.locator('input[type=file]').setInputFiles({ name: '长正文测试.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  const article = manager.locator('article.book').filter({ has: manager.getByRole('heading', { name: '长正文测试', exact: true }) });
  await article.waitFor();
  // Direct route is only a test harness for the shared iframe component.
  // The product's default reading action injects that component into an existing web page.
  await article.getByRole('button', { name: '悬浮阅读 →' }).waitFor();
  const reader = await context.newPage();
  await reader.goto(base + '/reader.html'); await reader.getByLabel('小说正文').waitFor();
  await reader.locator('.reader-scroll').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 10; el.dispatchEvent(new Event('scroll')); });
  await reader.waitForFunction(() => Number(document.querySelector('[data-offset]')?.getAttribute('data-offset')) > 0);
  assert.ok(await reader.locator('[data-block]').count() < 12);
  await reader.locator('.reader-scroll').evaluate(el => { el.scrollTop += 500; el.dispatchEvent(new Event('scroll')); });
  await reader.waitForTimeout(500);
  await reader.reload(); await reader.waitForFunction(() => Number(document.querySelector('[data-offset]')?.getAttribute('data-offset')) > 0);
  await reader.getByLabel('章节目录').selectOption('1');
  await reader.getByText('<script>window.unsafe=true</script>', { exact: true }).waitFor();
  assert.equal(await reader.evaluate(() => window.unsafe), undefined);
  const result = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
  result.checks.push('large chapter keeps a bounded display window, restores text offset after reload, HTML remains inert text');
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log('Large chapter virtualization, restore and inert HTML: passed');
} finally { await context.close(); }
