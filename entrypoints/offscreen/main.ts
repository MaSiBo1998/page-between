import { db } from '../../src/db';
import { Engine } from '../../src/engine';
import { core, parseChapter, selected, toTXT, validateRules } from '../../src/parser';
import { Network } from '../../src/network';
import { Scheduler } from '../../src/scheduler';
import { authorize } from '../../src/rpc';
import { bookFromJob } from '../../src/books';
import { loadOnlineChapter, openOnline, scanCatalog } from '../../src/online';
import { DEFAULT_SETTINGS as settingsDefault, settings, type Job, type Operation, type Scan } from '../../src/types';

let engine: Engine | null = null;
let running: Promise<unknown> | null = null;
let scanning: AbortController | null = null;
let commandBusy = false;
const ready = (async () => {
  const job = await db.job();
  if (job?.status === 'running') { job.status = 'paused'; job.error = '后台重新启动，点击继续从检查点恢复。'; await db.saveJob(job); }
})();
const emit = (job: Job) => { void chrome.runtime.sendMessage({ channel: 'novel-reader-update', job }).catch(() => {}); };
const schedulers = new Map<string, Scheduler>();
function makeNetwork(root: string, config: ReturnType<typeof settings>) {
  const key = new URL(root).origin + JSON.stringify(config);
  let scheduler = schedulers.get(key);
  if (!scheduler) { scheduler = new Scheduler(config); schedulers.set(key, scheduler); }
  return new Network(scheduler, root, authorize);
}
function validateScan(scan: Scan): Scan {
  core.url(scan.bookURL);
  if (!scan.title || !Array.isArray(scan.catalog) || !scan.catalog.length || scan.catalog.length > 50000) throw Error('目录为空或超过 50000 项。');
  const seen = new Set<string>();
  for (const entry of scan.catalog) {
    entry.url = core.ensureOrigin(entry.url, scan.bookURL);
    if (!entry.title || seen.has(entry.url)) throw Error('目录标题缺失或地址重复。');
    seen.add(entry.url);
  }
  for (const url of scan.catalogURLs) core.ensureOrigin(url, scan.bookURL);
  scan.rules = validateRules(scan.rules); return scan;
}
async function execute(job: Job) {
  const network = makeNetwork(job.bookURL, settings(job.settings));
  engine = new Engine(job, { records: db.records, checkpoint: db.checkpoint, saveJob: db.saveJob, changed: emit,
    metrics: () => ({ requests: network.requests, rate: network.scheduler.rate(), activeLimit: network.scheduler.limit }),
    fetch: async (url, signal) => ({ ...parseChapter(await network.document(url, signal), url, job.rules), url }) });
  const current = engine;
  running = current.run().catch(async error => {
    const latest = await db.job();
    if (latest?.id === job.id) { latest.status = 'error'; latest.error = error instanceof Error ? error.message : String(error); await db.saveJob(latest); emit(latest); }
  }).finally(() => { engine = null; running = null; });
}
async function handle(op: Operation): Promise<unknown> {
  await ready;
  if (op.op === 'health') return { running: !!engine, scanning: !!scanning };
  if (op.op === 'status') return db.job();
  if (op.op === 'pause' || op.op === 'cancel') {
    scanning?.abort(Error('识别已取消')); engine?.pause(); await running;
    const job = await db.job();
    if (job && op.op === 'cancel') { job.status = 'cancelled'; await db.saveJob(job); emit(job); }
    return job;
  }
  if (op.op === 'online-chapter') {
    const book = await db.book(op.bookId);
    if (!book?.online) throw Error('在线书籍不存在。');
    return loadOnlineChapter(op.bookId, op.index, makeNetwork(book.online.bookURL, settings(engine?.job.settings || settingsDefault)), new AbortController().signal);
  }
  if (commandBusy || scanning || (engine && op.op !== 'open-online')) throw Error('已有下载或识别操作，请先暂停。');
  commandBusy = true;
  try {
    if (op.op === 'open-online') {
      const root = core.url(op.url), rules = validateRules(op.rules);
      scanning = new AbortController();
      try { return await openOnline(root, rules, makeNetwork(root, settings(engine?.job.settings || op.settings)), scanning.signal, op.snapshot); }
      finally { scanning = null; }
    }
    if (op.op === 'scan') {
      const root = core.url(op.url), rules = validateRules(op.rules), network = makeNetwork(root, settings(op.settings));
      scanning = new AbortController(); const signal = scanning.signal;
      try { return validateScan(await scanCatalog(root, rules, network, signal, op.snapshot));
      } finally { scanning = null; }
    }
    if (op.op === 'preview') {
      const scan = validateScan(op.scan);
      if (!Number.isInteger(op.index) || !scan.catalog[op.index]) throw Error('请选择有效的章节。');
      const url = scan.catalog[op.index].url;
      const network = makeNetwork(scan.bookURL, settings(op.settings));
      scanning = new AbortController();
      try {
        const page = { ...parseChapter(await network.document(url, scanning.signal), url, scan.rules), url };
        core.validate(scan, op.index, { next: url, pages: [] }, page);
        return { title: page.title, text: page.text.slice(0, 1200), selector: page.selector };
      } finally { scanning = null; }
    }
    if (op.op === 'start') {
      const scan = validateScan(op.scan), config = settings(op.settings);
      selected({ ...scan, start: op.start, end: op.end });
      const old = await db.job();
      if (old && !['complete', 'cancelled'].includes(old.status)) throw Error('旧任务尚未完成，请先导出或取消旧任务。');
      const job: Job = { ...scan, id: crypto.randomUUID(), start: op.start, end: op.end, settings: config,
        status: 'running', created: Date.now(), completed: 0, pageCount: 0, chars: 0, error: '', current: '', requests: 0, rate: 0, eta: null, activeLimit: config.concurrency };
      await db.saveJob(job); await execute(job); return job;
    }
    const job = await db.job(); if (!job) throw Error('没有已保存的任务。');
    if (op.op === 'resume') {
      if (job.status === 'complete' || job.status === 'cancelled') throw Error('该任务已完成或取消，请新建任务。');
      await execute(job); return job;
    }
    if (op.op === 'export') {
      const text = toTXT(job, await db.records(job.id));
      if (!job.pageCount) throw Error('还没有已保存的正文。');
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
      const filename = [...job.title].map(c => c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c) ? '_' : c).join('').slice(0, 90) + (job.status === 'complete' ? '' : '_部分') + '.txt';
      try {
        const result = await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', event: 'download', url, filename });
        if (!result?.ok) throw Error(result?.error || '导出失败。');
        return result.data;
      } finally { setTimeout(() => URL.revokeObjectURL(url), 300000); }
    }
    if (op.op === 'read-job') {
      const book = await bookFromJob(job, await db.records(job.id));
      await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', event: 'book', bookId: book.id }); return book;
    }
    throw Error('未知操作。');
  } finally { commandBusy = false; }
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel !== 'novel-reader' || message.target !== 'offscreen' || sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(''))) return;
  handle(message.operation).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});
