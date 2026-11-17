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

export async function openOnline(address: string, rules: Rules, network: Pick<Network, 'document'>, signal: AbortSignal, snapshot?: string): Promise<Book> {
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
  const requestedIndex = scan.catalog.findIndex(entry => entry.url === core.url(address));
  const locateRequestedChapter = async () => {
    if (requestedIndex >= 0) await db.savePosition({ bookId: id, chapter: requestedIndex, offset: 0, updated: Date.now() });
  };
  const previous = await db.book(id);
  if (previous?.online && JSON.stringify(previous.online.catalog) === JSON.stringify(scan.catalog)) { await locateRequestedChapter(); return previous; }
  const book: Book = { id, title: scan.title, created: Date.now(), chars: 0, source: scan.bookURL, online: scan,
    chapters: scan.catalog.map(c => ({ title: c.title, chunks: 0, length: 0 })) };
  await db.saveBook(book, []); await locateRequestedChapter(); return book;
}

const pending = new Map<string, Promise<Book>>();
export function loadOnlineChapter(bookId: string, index: number, network: Pick<Network, 'document'>, signal: AbortSignal): Promise<Book> {
  const key = `${bookId}:${index}`;
  const existing = pending.get(key); if (existing) return existing;
  const task = (async () => {
    const book = await db.book(bookId);
    if (!book?.online || !Number.isInteger(index) || !book.chapters[index]) throw Error('在线书籍或章节无效。');
    if (book.chapters[index].chunks) return book;
    const scan = book.online;
    let record: RecordData = { jobId: book.id, index, done: false, next: scan.catalog[index].url, pages: [] };
    while (!record.done) {
      signal.throwIfAborted();
      const url = record.next!;
      const page = { ...parseChapter(await network.document(url, signal), url, scan.rules), url };
      const result = core.validate(scan, index, record, page);
      record = { ...record, done: result.done, next: result.next, pages: [...record.pages, { url, page: result.page, total: result.total, text: page.text }] };
    }
    return db.cacheChapter(bookId, index, record.pages.map(p => p.text).join('\n\n'), CHUNK_SIZE);
  })().finally(() => pending.delete(key));
  pending.set(key, task); return task;
}
