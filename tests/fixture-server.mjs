// Synthetic HTML only. Run: node tests/fixture-server.mjs
import { createServer } from 'node:http';
const requests = [];
let catalogRequests = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:18765');
  if (url.pathname === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(url.searchParams.has('catalog') ? catalogRequests : requests)); return; }
  res.setHeader('Content-Type', 'text/html;charset=utf-8');
  if (url.pathname === '/book') {
    catalogRequests++;
    res.end('<!doctype html><title>合成测试小说</title><h1>合成测试小说</h1><div id="list">' + Array.from({ length: 24 }, (_, i) => `<a href="/chapter/${i + 1}">第${i + 1}章 测试</a>`).join('<br>') + '</div>'); return;
  }
  const match = url.pathname.match(/^\/chapter\/(\d+)$/);
  if (match) {
    requests.push({ url: url.href, time: Date.now() });
    await new Promise(resolve => setTimeout(resolve, 200 + Math.random() * 200));
    const index = Number(match[1]), second = url.searchParams.has('page');
    const next = !second ? `/chapter/${index}?page=2` : index < 24 ? `/chapter/${index + 1}` : '/book';
    res.end(`<h1>第${index}章 测试(${second ? 2 : 1}/2)</h1><div id="content">${('这是合成测试正文，用于验证扩展下载、分页和本地阅读。\n').repeat(20)}</div><a href="${next}">${second ? '下一章' : '下一页'}</a>`); return;
  }
  res.end('<h1>用于验证阅读浮层的普通网页</h1><p>正文不应因扩展注入而发生布局改变。</p><input placeholder="输入时不触发快捷键">');
});
server.listen(18765, '127.0.0.1', () => console.log('Synthetic novel fixtures: http://127.0.0.1:18765/book'));
