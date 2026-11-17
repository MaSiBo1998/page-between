import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryAfter, Scheduler, wait } from '../src/scheduler';
import { DEFAULT_SETTINGS } from '../src/types';

afterEach(() => vi.useRealTimers());
describe('统一请求调度', () => {
  it('6 并发启动仍错开，间隔使用随机值', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(0.5);
    const scheduler = new Scheduler(DEFAULT_SETTINGS, random), controller = new AbortController();
    const starts: number[] = []; let active = 0, peak = 0;
    const tasks = Array.from({ length: 8 }, () => scheduler.run(async () => {
      starts.push(Date.now()); peak = Math.max(peak, ++active); await wait(5000, controller.signal); active--;
    }, controller.signal));
    await vi.runAllTimersAsync(); await Promise.all(tasks);
    expect(starts.slice(0, 3)).toEqual([100000, 100200, 100800]);
    expect(peak).toBe(6);
    expect(starts.every((time, i) => !i || time - starts[i - 1] >= 200)).toBe(true);
  });
  it('16 并发不超过用户上限', async () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler({ concurrency: 16, minInterval: 50, maxInterval: 50 });
    let active = 0, peak = 0; const signal = new AbortController().signal;
    const tasks = Array.from({ length: 40 }, () => scheduler.run(async () => {
      peak = Math.max(peak, ++active); await wait(2000, signal); active--;
    }, signal));
    await vi.runAllTimersAsync(); await Promise.all(tasks); expect(peak).toBe(16);
  });
  it('取消排队请求不会再启动网络', async () => {
    vi.useFakeTimers(); const scheduler = new Scheduler(DEFAULT_SETTINGS), controller = new AbortController();
    const first = scheduler.run(async () => 1, controller.signal); await first;
    const task = vi.fn(); const queued = scheduler.run(task, controller.signal).catch(e => e);
    controller.abort(Error('cancel')); await vi.runAllTimersAsync();
    expect(await queued).toBeInstanceOf(Error); expect(task).not.toHaveBeenCalled();
  });
  it('429 减半、等待 Retry-After，20 次成功后恢复一个并发', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const scheduler = new Scheduler(DEFAULT_SETTINGS); scheduler.throttled(3000);
    expect(scheduler.limit).toBe(3);
    const task = vi.fn(async () => true); const result = scheduler.run(task, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(2999); expect(task).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); await result; expect(task).toHaveBeenCalledOnce();
    for (let i = 0; i < 19; i++) scheduler.succeeded(); expect(scheduler.limit).toBe(3);
    scheduler.succeeded(); expect(scheduler.limit).toBe(4);
    for (let i = 0; i < 100; i++) scheduler.succeeded(); expect(scheduler.limit).toBe(6);
  });
  it('解析秒数与 HTTP 日期形式的 Retry-After', () => {
    expect(retryAfter('5')).toBe(5000); expect(retryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 5000)).toBe(5000);
    expect(retryAfter('invalid')).toBe(30000);
  });
  it('取消退避等待及时返回', async () => {
    vi.useFakeTimers(); const controller = new AbortController();
    const done = wait(30000, controller.signal).catch(e => e); controller.abort(Error('stop'));
    expect((await done).message).toBe('stop'); expect(vi.getTimerCount()).toBe(0);
  });
});
