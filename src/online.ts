import { db } from './db';
import { CHUNK_SIZE } from './books';
import { core, parseCatalog, parseChapter } from './parser';
import type { Network } from './network';
import type { Book, RecordData, Rules, Scan } from './types';

export async function scanCatalog(root: string, rules: Rules, network: Pick<Network, 'document'>, signal: AbortSignal, snapshot?: string): Promise<Scan> {
  const seen = new Set<string>(), entries = new Map<string, { title: string; url: string }>();
  let url: string | null = root, title = '';
  while (url) {
    signal.throwIfAborted();
    if (seen.has(url) || seen.size >= 100) throw Error('目录翻页循环或超过 100 页，请检查规则。');
    seen.add(url);
    const doc: Document = url === root && snapshot ? new DOMParser().parseFromString(snapshot, 'text/html') : await network.document(url, signal);
    const parsed = parseCatalog(doc, url, rules); title ||= parsed.title;
    for (const entry of parsed.catalog) if (!entries.has(entry.url)) entries.set(entry.url, entry);
    url = parsed.next;
  }
  const catalog = [...entries.values()];
  if (!title || !catalog.length || catalog.length > 50000) throw Error('目录为空或超过 50000 项。');
  const number = (title: string) => title.match(/(?:第\s*(\d+)\s*[章节回话]|chapter\s+(\d+))/i)?.slice(1).find(Boolean);
  if (catalog.every(e => number(e.title)) && new Set(catalog.map(e => number(e.title))).size === catalog.length)
    catalog.sort((a, b) => Number(number(a.title)) - Number(number(b.title)));
  return { bookURL: root, title, catalog, catalogURLs: [...seen], rules };
}

async function resolveOnline(address: string, rules: Rules, network: Pick<Network, 'document'>, signal: AbortSignal, snapshot?: string) {
  let root = core.url(address);
  const doc = snapshot ? new DOMParser().parseFromString(snapshot, 'text/html') : await network.document(root, signal);
  let initial = snapshot || doc.documentElement.outerHTML;
  // Chapter pages often link to their complete directory. Never guess a book URL.
  const directory = [...doc.querySelectorAll<HTMLAnchorElement>('a[href]')].find(a => /^(?:返回|回到)?(?:目录|章节目录|全部章节|完整目录|小说目录|书籍目录)$/.test((a.textContent || '').replace(/\s/g, '')));
  if (directory) {
    const candidate = core.ensureOrigin(core.url(directory.getAttribute('href')!, root), root);
    if (candidate !== root) { root = candidate; initial = ''; }
  }
  const scan = await scanCatalog(root, rules, network, signal, initial || undefined);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(scan.bookURL));
  const id = 'online:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { scan, id, requestedIndex: scan.catalog.findIndex(entry => entry.url === core.url(address)) };
}

function onlineBook(id: string, scan: Scan): Book {
  return { id, title: scan.title, created: Date.now(), chars: 0, source: scan.bookURL, online: scan,
    chapters: scan.catalog.map(entry => ({ title: entry.title, chunks: 0, length: 0 })) };
}

export async function openOnline(address: string, rules: Rules, network: Pick<Network, 'document'>, signal: AbortSignal, snapshot?: string): Promise<Book> {
  const { scan, id, requestedIndex } = await resolveOnline(address, rules, network, signal, snapshot);
  const locateRequestedChapter = async () => {
    if (requestedIndex >= 0) await db.savePosition({ bookId: id, chapter: requestedIndex, offset: 0, updated: Date.now() });
  };
  const previous = await db.book(id);
  if (previous?.online && JSON.stringify(previous.online.catalog) === JSON.stringify(scan.catalog)) { await locateRequestedChapter(); return previous; }
  const book = onlineBook(id, scan);
  await db.saveBook(book, []); await locateRequestedChapter(); return book;
}

async function fetchChapterText(scan: Scan, index: number, network: Pick<Network, 'document'>, signal: AbortSignal) {
  let record: Pick<RecordData, 'next' | 'pages'> = { next: scan.catalog[index].url, pages: [] };
  for (;;) {
    signal.throwIfAborted();
    const url = record.next!;
    const page = { ...parseChapter(await network.document(url, signal), url, scan.rules), url };
    const result = core.validate(scan, index, record, page);
    record = { next: result.next, pages: [...record.pages, { url, page: result.page, total: result.total, text: page.text }] };
    if (result.done) return record.pages.map(entry => entry.text).join('\n\n');
  }
}

export async function verifyOnlineSource(address: string, rules: Rules, network: Pick<Network, 'document'>, signal: AbortSignal) {
  const resolved = await resolveOnline(address, rules, network, signal);
  const previous = await db.book(resolved.id);
  const scan = previous?.online ?? resolved.scan;
  const sampleIndex = Math.max(0, scan.catalog.findIndex(entry => entry.url === core.url(address)));
  const text = await fetchChapterText(scan, sampleIndex, network, signal);
  signal.throwIfAborted();
  const stored = await db.ensureBook(onlineBook(resolved.id, scan));
  if (stored.online?.catalog[sampleIndex]?.url !== scan.catalog[sampleIndex].url) throw Error('该来源的目录已更新，请重新验证。');
  const book = stored.chapters[sampleIndex].chunks ? stored : await db.cacheChapter(stored.id, sampleIndex, text, CHUNK_SIZE);
  return { book, sampleIndex };
}

const pending = new Map<string, Promise<Book>>();
export function loadOnlineChapter(bookId: string, index: number, network: Pick<Network, 'document'>, signal: AbortSignal): Promise<Book> {
  const key = `${bookId}:${index}`;
  const existing = pending.get(key); if (existing) return existing;
  const task = (async () => {
    const book = await db.book(bookId);
    if (!book?.online || !Number.isInteger(index) || !book.chapters[index]) throw Error('在线书籍或章节无效。');
    if (book.chapters[index].chunks) return book;
    return db.cacheChapter(bookId, index, await fetchChapterText(book.online, index, network, signal), CHUNK_SIZE);
  })().finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
