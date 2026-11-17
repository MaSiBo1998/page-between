import { describe, expect, it } from 'vitest';
import { buildBook, CHUNK_SIZE, decodeTXT, splitTXT } from '../src/books';
import { db } from '../src/db';
import { parseCatalog, parseChapter } from '../src/parser';
import { clampFrame } from '../src/reader-prefs';
import { DEFAULT_READER, DEFAULT_SETTINGS, settings } from '../src/types';

describe('本地阅读数据', () => {
  it('UTF-8、UTF-16 BOM 和 GBK 解码', () => {
    expect(decodeTXT(new TextEncoder().encode('中文测试').buffer)).toBe('中文测试');
    expect(decodeTXT(new Uint8Array([255, 254, 45, 78, 135, 101]).buffer)).toBe('中文');
    expect(decodeTXT(new Uint8Array([254, 255, 78, 45, 101, 135]).buffer)).toBe('中文');
    expect(decodeTXT(new Uint8Array([214, 208, 206, 196]).buffer)).toBe('中文');
  });
  it('无章节标题保留正文；识别序章和中英文章节', () => {
    expect(splitTXT('一篇普通文本')[0]).toEqual({ title: '正文', text: '一篇普通文本' });
    expect(splitTXT('书名\n序章\n你好\n第一章 初见\n正文\nChapter 2 End\n结束').map(c => c.title)).toEqual(['序言', '序章', '第一章 初见', 'Chapter 2 End']);
  });
  it('大章节拆块，恶意 HTML 仍作为纯文本存储', async () => {
    const text = '<script>alert(1)</script>' + '测'.repeat(CHUNK_SIZE * 4);
    const result = buildBook(crypto.randomUUID(), '测试', [{ title: '正文', text }]);
    expect(result.chunks).toHaveLength(5); expect(result.chunks.map(c => c.text).join('')).toBe(text);
    await db.saveBook(result.book, result.chunks); expect((await db.chunk(result.book.id, 0, 0))?.text).toContain('<script>');
    await db.savePosition({ bookId: result.book.id, chapter: 0, offset: 1234, updated: Date.now() });
    expect((await db.position(result.book.id))?.offset).toBe(1234);
    await db.removeBook(result.book.id); expect(await db.book(result.book.id)).toBeUndefined(); expect(await db.chunk(result.book.id, 0, 0)).toBeUndefined(); expect(await db.position(result.book.id)).toBeUndefined();
  });
  it('小窗口中限制阅读器位置及尺寸', () => {
    const result = clampFrame({ ...DEFAULT_READER, x: 9999, y: -50 }, 320, 400);
    expect(result).toMatchObject({ x: 0, y: 0, width: 320, height: 400 });
  });
  it('配置拒绝无效范围及不合法并发', () => {
    expect(() => settings({ ...DEFAULT_SETTINGS, concurrency: 17 })).toThrow();
    expect(() => settings({ ...DEFAULT_SETTINGS, minInterval: 1000 })).toThrow();
  });
});
describe('HTML 解析回归', () => {
  const doc = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  it('识别目录、排序、去重和目录分页', () => {
    const result = parseCatalog(doc('<h1>合成小说</h1><div id="list"><a href="/2">第2章</a><a href="/1">第1章</a><a href="/1">第1章</a></div><a href="/book?p=2">下一页</a>'), 'https://example.com/book', {});
    expect(result.catalog.map(c => c.title)).toEqual(['第1章', '第2章']); expect(result.next).toBe('https://example.com/book?p=2');
  });
  it('提取正文，剔除脚本广告，识别同章下一页', () => {
    const result = parseChapter(doc('<h1>第一章(1/2)</h1><div id="content">这是合成小说的测试正文<br>下一行<script>steal()</script><div class="ads">广告</div></div><a href="/1_2">下一页</a>'), 'https://example.com/1', {});
    expect(result.text).not.toContain('steal'); expect(result.text).not.toContain('广告'); expect(result.next).toBe('https://example.com/1_2');
  });
  it('拒绝订阅、验证码和无正文页面', () => {
    expect(() => parseChapter(doc('<h1>第一章</h1><div id="content">请先登录后阅读这一章节的内容。</div>'), 'https://example.com/1', {})).toThrow(/登录/);
    expect(() => parseChapter(doc('<h1>第一章</h1><div class="vip-preview">preview</div>'), 'https://example.com/1', {})).toThrow(/试读/);
  });
});
