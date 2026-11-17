import { describe, expect, it, vi } from 'vitest';
import { openOnline, loadOnlineChapter } from '../src/online';
import { db } from '../src/db';

const html = (source: string) => new DOMParser().parseFromString(source, 'text/html');
function fixture() {
  const root = `https://example.com/${crypto.randomUUID()}/`;
  const catalog = '<h1>合成在线书籍</h1><div id="list">' + [1, 2, 3].map(n => `<a href="${root}${n}">第${n}章 测试</a>`).join('') + '</div>';
  const network = { document: vi.fn(async (url: string) => {
    if (url === root) return html(catalog);
    const index = Number(new URL(url).pathname.split('/').at(-1));
    const second = url.endsWith('?p=2');
    return html(`<h1>第${index}章 测试(${second ? 2 : 1}/2)</h1><div id="content">${second ? '第二页' : '第一页'}${'合成在线正文。'.repeat(30)}</div><a href="${second ? index === 3 ? root : root + (index + 1) : url + '?p=2'}">${second ? '下一章' : '下一页'}</a>`);
  }) };
  return { root, network, signal: new AbortController().signal };
}
describe('按需在线阅读', () => {
  it('只导入目录；当前章分页完整落盘后缓存，再次阅读不请求', async () => {
    const { root, network, signal } = fixture();
    const book = await openOnline(root, {}, network, signal);
    expect(network.document).toHaveBeenCalledTimes(1);
    expect(book.chapters.map(c => c.chunks)).toEqual([0, 0, 0]);
    const [a, b] = await Promise.all([loadOnlineChapter(book.id, 0, network, signal), loadOnlineChapter(book.id, 0, network, signal)]);
    expect(a.id).toBe(b.id); expect(network.document).toHaveBeenCalledTimes(3);
    expect((await db.chunk(book.id, 0, 0))?.text).toContain('第二页');
    await loadOnlineChapter(book.id, 0, network, signal);
    expect(network.document).toHaveBeenCalledTimes(3);
    expect((await db.book(book.id))?.chapters[1].chunks).toBe(0);
    await db.savePosition({ bookId: book.id, chapter: 0, offset: 20, updated: 1 });
    const duplicate = await openOnline(root, {}, network, signal);
    expect(duplicate.chapters[0].chunks).toBe(1); expect((await db.position(book.id))?.offset).toBe(20);
  });
  it('并行缓存不同章不会覆盖已有章节或字符统计', async () => {
    const { root, network, signal } = fixture();
    const book = await openOnline(root, {}, network, signal);
    await Promise.all([loadOnlineChapter(book.id, 0, network, signal), loadOnlineChapter(book.id, 1, network, signal)]);
    const saved = (await db.book(book.id))!;
    expect(saved.chapters.map(c => c.chunks)).toEqual([1, 1, 0]);
    expect(saved.chars).toBe(saved.chapters[0].length + saved.chapters[1].length);
  });
  it('第二页失败不会将试读或半章缓存为完整章，允许重试', async () => {
    const { root, network, signal } = fixture();
    const book = await openOnline(root, {}, network, signal);
    const original = network.document.getMockImplementation()!;
    network.document.mockImplementation(async url => { if (url.endsWith('?p=2')) throw Error('网络中断'); return original(url); });
    await expect(loadOnlineChapter(book.id, 0, network, signal)).rejects.toThrow('网络中断');
    expect((await db.book(book.id))?.chapters[0].chunks).toBe(0); expect(await db.chunk(book.id, 0, 0)).toBeUndefined();
    network.document.mockImplementation(original);
    expect((await loadOnlineChapter(book.id, 0, network, signal)).chapters[0].chunks).toBe(1);
  });
  it('正文网址通过实际目录链接导入，拒绝跨站目录', async () => {
    const { root, network, signal } = fixture();
    const chapter = '<h1>第1章 测试</h1><a href="' + root + '">返回目录</a>';
    const book = await openOnline(root + '2', {}, network, signal, chapter);
    expect(book.online?.bookURL).toBe(root); expect((await db.position(book.id))?.chapter).toBe(1);
    await expect(openOnline(root + '1', {}, network, signal, '<a href="https://evil.test/">目录</a>')).rejects.toThrow('离开当前网站');
  });
});
