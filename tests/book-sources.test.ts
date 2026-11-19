import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractBingResults, searchPhrase } from '../src/book-search';
import { linkedSources, linkSources, matchSourceChapter } from '../src/source-links';

afterEach(() => vi.unstubAllGlobals());
const searchPage = 'https://www.bing.com/search?q=novel';
const html = (body: string) => new DOMParser().parseFromString(`<ol id="b_results">${body}</ol>`, 'text/html');

describe('搜书', () => {
  it('只取 Bing 首页自然结果、解码可读链接、按地址去重且不执行内容', () => {
    const destination = 'https://books.example/novel?id=4';
    const wrapped = '/ck/a?u=a1' + btoa(destination).replace(/=+$/, '');
    const doc = html(`<li class="b_algo"><h2><a href="${wrapped}">小说甲</a></h2></li>
      <li class="b_algo"><h2><a href="${destination}&amp;utm_source=foo#read">重复</a></h2></li>
      <li class="b_algo b_ad"><h2><a href="https://ads.example/">广告</a></h2></li>
      <li><h2><a href="https://other.example/">非自然结果</a></h2></li>
      <li class="b_algo"><h2><a href="javascript:alert(1)">脚本</a></h2></li>
      <li class="b_algo"><h2><a href="/search?q=other">站内搜索</a></h2></li>`);
    expect(extractBingResults(doc, searchPage)).toEqual([{ title: '小说甲', url: destination }]);
    expect(extractBingResults(doc, 'https://cn.bing.com/search?q=novel')).toEqual([{ title: '小说甲', url: destination }]);
    expect(extractBingResults(doc, searchPage + '&first=11')).toEqual([]);
    expect(extractBingResults(doc, 'https://other.example/search')).toEqual([]);
    expect(searchPhrase(' 书名 ', ' 作者 ')).toBe('书名 作者 小说 目录');
  });

  it('默认返回至多 10 项，指定数量也不超过首页结果', () => {
    const doc = html(Array.from({ length: 15 }, (_, index) => `<li class="b_algo"><h2><a href="https://books.example/${index}">来源 ${index}</a></h2></li>`).join(''));
    expect(extractBingResults(doc, searchPage)).toHaveLength(10);
    expect(extractBingResults(doc, searchPage, 3)).toHaveLength(3);
    expect(extractBingResults(doc, searchPage, 50)).toHaveLength(15);
  });
});

describe('换源', () => {
  it('按规范化标题和章号匹配而非目录下标', () => {
    expect(matchSourceChapter('第十二章：归来！', ['序章', '第１１章 归来', '第１２章 归来'])).toBe(2);
    expect(matchSourceChapter('第12章 归来', ['第13章 归来'])).toBeUndefined();
    expect(matchSourceChapter('第12章 归来', ['第12章 出发'])).toBeUndefined();
    expect(matchSourceChapter('第12章 归来', ['第12章 归来', '第十二回 归来'])).toBeUndefined();
    expect(matchSourceChapter('第12章 归来', ['第12章 归来', '第十二章 出发'])).toBeUndefined();
    expect(matchSourceChapter('第12章 归来', ['第12章 归来（第13章 出发）'])).toBeUndefined();
    expect(matchSourceChapter('第12-13章 归来', ['第12-13章 归来'])).toBeUndefined();
  });

  it('只返回显式确认的来源关系，未关联的同名书不加入', async () => {
    const stored: Record<string, unknown> = { sameTitle: ['unrelated', 'source-b'] };
    vi.stubGlobal('chrome', { storage: { local: { get: async () => stored, set: async (patch: object) => Object.assign(stored, patch) } } });
    expect(await linkedSources('source-a')).toEqual([]);
    await linkSources('source-a', 'source-b');
    await linkSources('source-a', 'source-c');
    expect(await linkedSources('source-b')).toEqual(['source-a', 'source-c']);
    expect(await linkedSources('unrelated')).toEqual([]);
  });
});
