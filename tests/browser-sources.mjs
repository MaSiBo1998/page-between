import { chromium } from 'playwright';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chapterIndex, openChapter } from './reader-browser-helpers.mjs';

const label = process.env.BROWSER_LABEL || 'edge-sources';
const root = path.resolve('test-results', label), build = path.join(root, 'extension');
await mkdir(root, { recursive: true }); await cp('.output/chrome-mv3', build, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(build, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions, undefined);
manifest.host_permissions = ['http://source-one.test/*', 'http://source-two.test/*', 'https://www.bing.com/*', 'https://cn.bing.com/*'];
await writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest));

const hits = [];
let failTarget = true;
const fixture = createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  const alternate = url.hostname === 'source-two.test';
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (url.pathname === '/ordinary') { res.end('<title>普通网页</title><h1>普通网页</h1>'); return; }
  const chapters = alternate ? ['第1章 出发', '第二章 归来', '第4章 不同标题'] : ['第1章 出发', '第2章 归来', '第4章 决战'];
  if (url.pathname === '/book') {
    hits.push(url.href);
    res.end('<h1>两源验收小说</h1><div id="list">' + chapters.map((chapter, index) => `<a href="/chapters/${index}">${chapter}</a>`).join('') + '</div>'); return;
  }
  const match = url.pathname.match(/^\/chapters\/(\d+)$/);
  if (!match) { res.writeHead(404); res.end(); return; }
  hits.push(url.href);
  const index = Number(match[1]);
  if (alternate && index === 1 && failTarget) { res.writeHead(403); res.end('目标章节拒绝访问'); return; }
  const line = `${alternate ? '第二来源' : '第一来源'}的章节正文 ${index}，用于验证目录和阅读位置均保持独立。`;
  res.end(`<h1>${chapters[index]}</h1><div id="content">${`${line}<br>`.repeat(30)}</div>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const port = fixture.address().port;
const firstURL = `http://source-one.test:${port}/book`, secondURL = `http://source-two.test:${port}/book`;
const siteURL = `http://source-one.test:${port}/ordinary`;
const context = await chromium.launchPersistentContext(path.join(root, 'profile-' + Date.now()), {
  executablePath: process.env.BROWSER_EXE, headless: true, viewport: { width: 1000, height: 800 },
  ignoreDefaultArgs: ['--disable-extensions'], args: [`--load-extension=${build}`, `--disable-extensions-except=${build}`,
    '--no-proxy-server', '--host-resolver-rules=MAP source-one.test 127.0.0.1, MAP source-two.test 127.0.0.1']
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const base = worker.url().split('/background.js')[0];
  const control = await context.newPage(); await control.goto(base + '/popup.html');
  const rpc = operation => control.evaluate(operation => chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation }), operation);
  const site = await context.newPage(); await site.goto(siteURL); await site.bringToFront();
  const tabId = await control.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, siteURL);
  assert.equal((await rpc({ op: 'reader-toggle', tabId, view: 'online', visibility: 'show', controls: 'show' })).ok, true);
  const frame = site.frameLocator('iframe[title="小说阅读器"]');
  const panel = frame.getByRole('region', { name: '搜书面板' });
  const title = panel.getByLabel('书名', { exact: true });
  const switchPanel = frame.getByRole('region', { name: '换源面板' });
  const sourceTab = frame.getByRole('tab', { name: '换源', exact: true });
  assert.equal(await panel.getByLabel('目录或正文网址').inputValue(), '');
  await panel.getByLabel('目录或正文网址').fill(firstURL);
  await panel.getByRole('button', { name: '验证网址' }).click();
  await panel.getByRole('button', { name: '阅读', exact: true }).click();
  await openChapter(frame, 1);
  await frame.getByText(/第一来源的章节正文 1/).first().waitFor();
  await frame.getByRole('button', { name: '搜书', exact: true }).click();
  assert.equal(await title.inputValue(), '');
  const before = hits.filter(url => url === secondURL).length;
  let lookup;
  let multiple = false;
  const navigation = [];
  context.on('request', request => { if (request.isNavigationRequest()) navigation.push(request.url()); });
  let unblock;
  const release = new Promise(resolve => { unblock = resolve; });
  await context.route(/^https:\/\/(?:www|cn)\.bing\.com\/search\?/, async route => {
    lookup = route.request().url();
    await release;
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<ol id="b_results">
      <li class="b_algo"><h2><a href="${secondURL}">两源验收小说 · 第二源</a></h2></li>
      <li class="b_algo"><h2><a href="${secondURL}#part">重复链接</a></h2></li>
      <li class="b_ad"><h2><a href="https://advertising.test/">广告</a></h2></li>${multiple ? [1, 2, 3].map(index => `<li class="b_algo"><h2><a href="https://fixture.test/${index}">合成来源 ${index}</a></h2></li>`).join('') : ''}</ol>` }).catch(() => {});
  });
  await title.fill('两源验收小说');
  const browserTabs = () => control.evaluate(() => chrome.tabs.query({ currentWindow: true }));
  const baselineIds = (await browserTabs()).map(tab => tab.id).sort();
  await panel.getByRole('button', { name: '搜索', exact: true }).click();
  for (let attempt = 0; !lookup && attempt < 60; attempt++) await site.waitForTimeout(100);
  assert.ok(lookup, JSON.stringify({ navigation, panel: await panel.innerText() }));
  const searchingTabs = await browserTabs();
  assert.equal(searchingTabs.find(tab => tab.active)?.id, tabId);
  assert.equal(searchingTabs.length, baselineIds.length + 1);
  unblock();
  await panel.getByText('找到 1 个候选来源').waitFor();
  assert.deepEqual((await browserTabs()).map(tab => tab.id).sort(), baselineIds);
  assert.equal(hits.filter(url => url === secondURL).length, before);
  const verifiedSecond = panel.locator('.source-row').filter({ hasText: 'source-two.test' });
  assert.equal(await verifiedSecond.getByRole('button', { name: '下载', exact: true }).count(), 0);
  failTarget = false;
  await verifiedSecond.getByRole('button', { name: '验证并下载', exact: true }).click();
  await panel.getByRole('region', { name: '下载任务' }).getByText('下载完成 · 3 / 3 章', { exact: true }).waitFor();
  assert.equal((await rpc({ op: 'status' })).data.bookURL, secondURL);
  await site.locator('#novel-reader-extension').screenshot({ path: path.join(root, 'search-download.png') });
  failTarget = true;
  await verifiedSecond.getByRole('button', { name: '下载', exact: true }).waitFor();
  await verifiedSecond.getByRole('button', { name: '关联本书', exact: true }).waitFor();
  const shelf = frame.getByRole('button', { name: '打开悬浮书架' });
  await shelf.click();
  assert.equal(await frame.locator('.floating-book').count(), 1);
  assert.equal(await frame.locator('.floating-library input[type=url]').count(), 0);
  await frame.getByRole('button', { name: '搜书', exact: true }).click();
  await verifiedSecond.getByRole('button', { name: '加入书架', exact: true }).click();
  await panel.getByText(/已加入书架$/).first().waitFor();
  await shelf.click();
  await frame.locator('.floating-book').nth(1).waitFor();
  await frame.getByRole('button', { name: '搜书', exact: true }).click();
  assert.equal(await panel.getByText('已关联来源').count(), 0);
  await verifiedSecond.getByRole('button', { name: '关联本书', exact: true }).click();
  await panel.getByText('已关联来源').waitFor();
  await panel.getByRole('button', { name: '返回正文' }).click();
  assert.equal(await chapterIndex(frame), '1');
  await sourceTab.click();
  assert.equal(await switchPanel.getByLabel('搜索数量').inputValue(), '10');
  await switchPanel.getByLabel('搜索数量').fill('2');
  multiple = true;
  await switchPanel.getByRole('button', { name: '搜本书其他来源' }).click();
  await switchPanel.getByText('找到 2 个候选来源').waitFor();
  assert.equal(await switchPanel.getByRole('button', { name: '验证来源' }).count(), 1);
  assert.deepEqual((await browserTabs()).map(tab => tab.id).sort(), baselineIds);
  await switchPanel.getByRole('button', { name: '切换', exact: true }).click();
  await switchPanel.getByText(/未切换.*403/).waitFor();
  await switchPanel.getByRole('button', { name: '返回正文' }).click();
  await frame.getByText(/第一来源的章节正文 1/).first().waitFor();
  assert.equal(await chapterIndex(frame), '1');
  failTarget = false;
  await sourceTab.click();
  await switchPanel.getByRole('button', { name: '切换', exact: true }).click();
  await frame.getByText(/第二来源的章节正文 1/).first().waitFor();
  assert.equal(await chapterIndex(frame), '1');
  await openChapter(frame, 2);
  await frame.getByText(/第二来源的章节正文 2/).first().waitFor();
  await sourceTab.click();
  await switchPanel.getByRole('button', { name: '切换', exact: true }).click();
  await switchPanel.getByText(/未匹配到唯一章节/).waitFor();
  await switchPanel.getByRole('combobox').selectOption('0');
  await site.locator('#novel-reader-extension').screenshot({ path: path.join(root, 'source-switch.png') });
  await switchPanel.getByRole('button', { name: '切换并阅读' }).click();
  await frame.getByText(/第一来源的章节正文 0/).first().waitFor();
  await sourceTab.click();
  await switchPanel.getByText(/source-two.test/).waitFor();
  const checks = ['background search keeps active tab; closes temporary tab; result dedup and adjustable limit inside source panel', 'one click verifies and downloads a Bing result without shelving it; explicit add preserves current book and position', 'explicit relation for equal titles; selected chapter failure preserves the reading view', 'same chapter match across numbering formats; mismatched chapter uses a manual directory'];
  const result = { edge: context.browser().version(), checks, lookup };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await context.close(); await new Promise(resolve => fixture.close(resolve)); }
