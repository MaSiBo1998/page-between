import type { Job, RecordData, ChapterData } from './types';
import { core, selected } from './parser';

export interface EngineDeps {
  fetch(url: string, signal: AbortSignal): Promise<ChapterData>;
  records(jobId: string): Promise<Map<number, RecordData>>;
  checkpoint(job: Job, record: RecordData): Promise<void>;
  saveJob(job: Job): Promise<void>;
  changed(job: Job): void;
  metrics(): { requests: number; rate: number; activeLimit: number };
}
export class Engine {
  controller = new AbortController();
  records = new Map<number, RecordData>();
  private commits = Promise.resolve();
  constructor(public job: Job, private deps: EngineDeps) {}
  pause() { this.controller.abort(Error('已暂停')); }
  private summarize(records: Map<number, RecordData>): Job {
    const chosen = selected(this.job).map(i => records.get(i)).filter((r): r is RecordData => !!r);
    const metrics = this.deps.metrics();
    const pageCount = chosen.reduce((n, r) => n + r.pages.length, 0);
    const completed = chosen.filter(r => r.done).length;
    return { ...this.job, ...metrics, completed, pageCount,
      chars: chosen.reduce((n, r) => n + r.pages.reduce((m, p) => m + p.text.length, 0), 0),
      eta: metrics.rate && completed ? Math.ceil((this.job.end - this.job.start + 1 - completed) * pageCount / completed / metrics.rate) : null };
  }
  private async commit(record: RecordData) {
    const task = this.commits.then(async () => {
      this.controller.signal.throwIfAborted();
      const updated = new Map(this.records).set(record.index, record);
      const next = { ...this.summarize(updated), current: this.job.catalog[record.index].title };
      await this.deps.checkpoint(next, record);
      this.records = updated; this.job = next; this.deps.changed(this.job);
    });
    this.commits = task.catch(() => {});
    return task;
  }
  private async chapter(index: number) {
    const signal = this.controller.signal;
    let record = this.records.get(index) || { jobId: this.job.id, index, done: false, next: this.job.catalog[index].url, pages: [] };
    while (!record.done) {
      signal.throwIfAborted();
      const data = await this.deps.fetch(record.next!, signal);
      signal.throwIfAborted();
      const page = core.validate(this.job, index, record, data);
      record = { ...record, done: page.done, next: page.next, pages: [...record.pages, { url: data.url, page: page.page, total: page.total, text: data.text }] };
      await this.commit(record);
    }
  }
  async run(): Promise<Job> {
    this.records = await this.deps.records(this.job.id);
    for (const [index, record] of this.records) {
      if (record.index !== index || !this.job.catalog[index] || !Array.isArray(record.pages) ||
          record.pages.some((p, n) => p.page !== n + 1 || !p.url || !p.text) || (!record.done && !record.next))
        throw Error('任务正文检查点损坏，请导出已有内容后重新识别。');
    }
    const recomputed = this.summarize(this.records);
    if (recomputed.pageCount < this.job.pageCount) throw Error('任务正文记录缺失，已停止以避免错误标记完整。');
    this.job = { ...recomputed, status: 'running', error: '' };
    await this.deps.saveJob(this.job); this.deps.changed(this.job);
    const queue = selected(this.job).filter(i => !this.records.get(i)?.done);
    let cursor = 0; let failure: unknown;
    const worker = async () => {
      try {
        while (cursor < queue.length) { this.controller.signal.throwIfAborted(); await this.chapter(queue[cursor++]); }
      } catch (error) {
        if (!this.controller.signal.aborted) { failure = error; this.controller.abort(error); }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(this.job.settings.concurrency, queue.length) }, worker));
    await this.commits;
    this.job = { ...this.job, status: failure ? 'error' : this.controller.signal.aborted ? 'paused' : 'complete',
      error: failure instanceof Error ? failure.message : failure ? String(failure) : '', eta: null };
    await this.deps.saveJob(this.job); this.deps.changed(this.job);
    return this.job;
  }
}
