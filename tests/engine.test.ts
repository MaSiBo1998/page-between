import { describe, expect, it, vi } from 'vitest';
import { Engine, type EngineDeps } from '../src/engine';
import { core, selected, toTXT } from '../src/parser';
import { DEFAULT_SETTINGS, type ChapterData, type Job, type RecordData } from '../src/types';

function job(count = 18): Job {
  return { bookURL: 'https://example.com/book', title: '合成测试小说', catalog: Array.from({ length: count }, (_, n) => ({ title: `第${n + 1}章 测试`, url: `https://example.com/${n + 1}` })),
    catalogURLs: ['https://example.com/book'], rules: {}, id: crypto.randomUUID(), start: 0, end: count - 1,
    settings: DEFAULT_SETTINGS, status: 'running', created: Date.now(), completed: 0, pageCount: 0, chars: 0, error: '', current: '', requests: 0, rate: 0, eta: null, activeLimit: 6 };
}
function data(j: Job, index: number, extra: Partial<ChapterData> = {}): ChapterData {
  return { kind: 'chapter', url: j.catalog[index].url, rawTitle: j.catalog[index].title, title: j.catalog[index].title,
    text: '这是用于测试的合成章节正文，没有来自实际小说的内容。', next: j.catalog[index + 1]?.url || null, selector: '#content', ...extra };
}
function harness(j: Job) {
  const saved = new Map<number, RecordData>();
  const deps: EngineDeps = { fetch: async url => data(j, j.catalog.findIndex(c => c.url === url)), records: async () => saved,
    checkpoint: async (_j, r) => { saved.set(r.index, structuredClone(r)); }, saveJob: async () => {}, changed: () => {}, metrics: () => ({ requests: 0, rate: 1, activeLimit: j.settings.concurrency }) };
  return { saved, deps, engine: new Engine(j, deps) };
}
describe('章节引擎与导出', () => {
  it.each([6, 16])('%i 并发乱序完成，输出仍按目录顺序', async concurrency => {
    const j = job(); j.settings = { ...DEFAULT_SETTINGS, concurrency };
    const h = harness(j); const order: number[] = [];
    h.deps.fetch = async url => { const i = j.catalog.findIndex(c => c.url === url); await new Promise(r => setTimeout(r, (18 - i) % 6)); order.push(i); return data(j, i); };
    const result = await h.engine.run(); expect(result.status).toBe('complete'); expect(result.completed).toBe(18);
    expect(order).not.toEqual(Array.from({ length: 18 }, (_, i) => i));
    const txt = toTXT(result, h.saved); expect(txt.indexOf('第1章')).toBeLessThan(txt.indexOf('第2章'));
    expect(result.pageCount).toBe(18);
  });
  it('指定范围仅请求所选项，范围外不算缺章', async () => {
    const j = job(5); j.start = 1; j.end = 2;
    const h = harness(j), fetch = vi.fn(h.deps.fetch); h.deps.fetch = fetch;
    const result = await h.engine.run(); expect(fetch.mock.calls.map(call => call[0]).sort()).toEqual([j.catalog[1].url, j.catalog[2].url]);
    expect(result.completed).toBe(2); expect(result.status).toBe('complete');
    const txt = toTXT(result, h.saved); expect(txt).not.toContain('第1章'); expect(txt).not.toContain('未完成章节');
  });
  it('正文写入失败不增加已保存进度', async () => {
    const j = job(1), h = harness(j);
    h.deps.checkpoint = async () => { throw Error('storage full'); };
    const result = await h.engine.run(); expect(result.status).toBe('error');
    expect(result.pageCount).toBe(0); expect(result.completed).toBe(0); expect(h.saved.size).toBe(0);
  });
  it('分页检查点暂停后只抓剩余页面', async () => {
    const j = job(1), h = harness(j); let first = true;
    h.deps.fetch = async url => data(j, 0, { url, rawTitle: j.catalog[0].title + (url.includes('?') ? '(2/2)' : '(1/2)'), next: url.includes('?') ? null : url + '?page=2' });
    h.deps.checkpoint = async (_job, record) => { h.saved.set(record.index, structuredClone(record)); if (first) { first = false; h.engine.pause(); } };
    const paused = await h.engine.run(); expect(paused.status).toBe('paused'); expect(paused.pageCount).toBe(1);
    h.deps.checkpoint = async (_job, record) => { h.saved.set(record.index, structuredClone(record)); };
    const fetch = vi.fn(h.deps.fetch); h.deps.fetch = fetch;
    const resumed = await new Engine(paused, h.deps).run(); expect(resumed.status).toBe('complete');
    expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toBe(j.catalog[0].url + '?page=2');
  });
  it('逐页保存同章分页并检查跨章链接', async () => {
    const j = job(2); const h = harness(j);
    h.deps.fetch = async url => url.endsWith('?page=2') ? data(j, 0, { url, rawTitle: j.catalog[0].title + '(2/2)' })
      : url === j.catalog[0].url ? data(j, 0, { rawTitle: j.catalog[0].title + '(1/2)', next: url + '?page=2' }) : data(j, 1);
    const result = await h.engine.run(); expect(result.pageCount).toBe(3); expect(h.saved.get(0)?.pages).toHaveLength(2);
  });
  it('暂停后忽略迟到响应，恢复不重复已保存页', async () => {
    const j = job(1), h = harness(j); let release!: () => void;
    h.deps.fetch = async () => { await new Promise<void>(resolve => { release = resolve; }); return data(j, 0); };
    const result = h.engine.run(); while (!release) await new Promise(r => setTimeout(r, 0));
    h.engine.pause(); release(); expect((await result).status).toBe('paused'); expect(h.saved.size).toBe(0);
    const next = new Engine(h.engine.job, { ...h.deps, fetch: async () => data(j, 0) }); expect((await next.run()).completed).toBe(1);
  });
  it('保存失败时进度不增加', async () => {
    const h = harness(job(1)); h.deps.checkpoint = async () => { throw Error('quota exceeded'); };
    const result = await h.engine.run(); expect(result.completed).toBe(0); expect(result.status).toBe('error'); expect(result.error).toContain('quota');
  });
  it('恢复已保存的分页，不重新抓取第一页', async () => {
    const j = job(1), h = harness(j); j.pageCount = 1;
    h.saved.set(0, { jobId: j.id, index: 0, done: false, next: j.catalog[0].url + '?p=2', pages: [{ url: j.catalog[0].url, page: 1, total: 2, text: '第一页合成正文用于恢复测试。' }] });
    const fetch = vi.fn(async (url: string) => data(j, 0, { url, rawTitle: j.catalog[0].title + '(2/2)' })); h.deps.fetch = fetch;
    expect((await h.engine.run()).pageCount).toBe(2); expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][0]).toContain('?p=2');
  });
  it('序章按目录位置选择；越界范围拒绝', () => {
    const j = job(3); j.catalog[0].title = '序章'; expect(selected({ ...j, start: 0, end: 1 })).toEqual([0, 1]);
    expect(() => selected({ ...j, end: 3 })).toThrow();
  });
  it('拒绝章节跳跃、分页循环、乱码及其他站点', () => {
    const j = job(3); const record = { next: j.catalog[0].url, pages: [] };
    expect(() => core.validate(j, 0, record, data(j, 0, { next: j.catalog[2].url }))).toThrow(/跳过/);
    expect(() => core.validate(j, 0, record, data(j, 0, { text: '错误字体\ue111错误字体错误字体错误字体' }))).toThrow(/字体/);
    expect(() => core.validate(j, 0, record, data(j, 0, { next: 'https://evil.example/a' }))).toThrow(/离开/);
    expect(() => core.validate(j, 0, { ...record, pages: [{ url: j.catalog[0].url, page: 1, total: 2, text: 'test' }] }, data(j, 0))).toThrow(/循环/);
  });
});
