import { afterEach, expect, it, vi } from 'vitest';
import { Network } from '../src/network';
import { Scheduler } from '../src/scheduler';
import { DEFAULT_SETTINGS } from '../src/types';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const response = (status = 200, headers = {}) => new Response('<h1>测试</h1><div>测试正文</div>', { status, headers: { 'Content-Type': 'text/html;charset=utf-8', ...headers } });
it('所有失败重试重新进入调度队列', async () => {
  vi.useFakeTimers(); const scheduler = new Scheduler(DEFAULT_SETTINGS);
  const fetch = vi.fn().mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(503)).mockResolvedValue(response());
  vi.stubGlobal('fetch', fetch);
  const network = new Network(scheduler, 'https://example.com', async () => {});
  const result = network.document('https://example.com/1', new AbortController().signal);
  await vi.runAllTimersAsync(); expect((await result).querySelector('h1')?.textContent).toBe('测试');
  expect(fetch).toHaveBeenCalledTimes(3); expect(network.requests).toBe(3); expect(scheduler.starts).toHaveLength(3);
});
it('403 立即停止；未授权和跨站地址不发网络请求', async () => {
  const fetch = vi.fn().mockResolvedValue(response(403)); vi.stubGlobal('fetch', fetch);
  const signal = new AbortController().signal;
  const network = new Network(new Scheduler(DEFAULT_SETTINGS), 'https://example.com', async () => {});
  await expect(network.document('https://example.com/1', signal)).rejects.toThrow('403'); expect(fetch).toHaveBeenCalledOnce();
  await expect(network.document('https://elsewhere.com/1', signal)).rejects.toThrow(); expect(fetch).toHaveBeenCalledOnce();
  const denied = new Network(new Scheduler(DEFAULT_SETTINGS), 'https://example.com', async () => { throw Error('denied'); });
  await expect(denied.document('https://example.com/1', signal)).rejects.toThrow('denied'); expect(fetch).toHaveBeenCalledOnce();
});
it('持续 429 在两次重试后停止并降低并发', async () => {
  vi.useFakeTimers(); const fetch = vi.fn().mockResolvedValue(response(429, { 'Retry-After': '2' })); vi.stubGlobal('fetch', fetch);
  const scheduler = new Scheduler(DEFAULT_SETTINGS); const network = new Network(scheduler, 'https://example.com', async () => {});
  const outcome = network.document('https://example.com/1', new AbortController().signal).catch(e => e);
  await vi.runAllTimersAsync(); expect((await outcome).message).toContain('429');
  expect(fetch).toHaveBeenCalledTimes(3); expect(scheduler.limit).toBe(1);
});
