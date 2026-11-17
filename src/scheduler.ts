import type { Settings } from './types';

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
  });
}
interface Ticket { signal: AbortSignal; resolve: (release: () => void) => void; reject: (reason: unknown) => void; abort: () => void }
export class Scheduler {
  private queue: Ticket[] = [];
  private active = 0;
  private nextStart = 0;
  private cooldown = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private successes = 0;
  limit: number;
  starts: number[] = [];
  constructor(public config: Settings, private random: () => number = Math.random, private now: () => number = Date.now) {
    this.limit = config.concurrency;
  }
  private pump = () => {
    clearTimeout(this.timer);
    if (!this.queue.length || this.active >= this.limit) return;
    const delay = Math.max(this.nextStart, this.cooldown) - this.now();
    if (delay > 0) { this.timer = setTimeout(this.pump, delay); return; }
    const ticket = this.queue.shift()!;
    ticket.signal.removeEventListener('abort', ticket.abort);
    if (ticket.signal.aborted) { ticket.reject(ticket.signal.reason); this.pump(); return; }
    this.active++;
    const time = this.now(); this.starts.push(time);
    this.starts = this.starts.filter(t => t >= time - 60000);
    this.nextStart = time + this.config.minInterval + this.random() * (this.config.maxInterval - this.config.minInterval);
    let released = false;
    ticket.resolve(() => { if (!released) { released = true; this.active--; this.pump(); } });
    this.pump();
  };
  private acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const ticket: Ticket = { signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter(t => t !== ticket); reject(signal.reason); this.pump();
      } };
      signal.addEventListener('abort', ticket.abort, { once: true });
      this.queue.push(ticket); this.pump();
    });
  }
  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try { signal.throwIfAborted(); return await task(); } finally { release(); }
  }
  throttled(ms: number) {
    this.limit = Math.max(1, Math.floor(this.limit / 2)); this.successes = 0;
    this.cooldown = Math.max(this.cooldown, this.now() + ms); this.pump();
  }
  succeeded() {
    if (++this.successes >= 20) { this.successes = 0; this.limit = Math.min(this.config.concurrency, this.limit + 1); this.pump(); }
  }
  rate(): number {
    const list = this.starts.filter(t => t >= this.now() - 60000);
    return list.length < 2 ? 0 : (list.length - 1) * 1000 / Math.max(1000, this.now() - list[0]);
  }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (value && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = value ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 30000;
}
