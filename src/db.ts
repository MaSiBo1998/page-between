import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Book, Chunk, Job, Position, RecordData } from './types';

interface LibraryDB extends DBSchema {
  jobs: { key: string; value: Job };
  records: { key: [string, number]; value: RecordData; indexes: { jobId: string } };
  books: { key: string; value: Book };
  chunks: { key: [string, number, number]; value: Chunk; indexes: { bookId: string } };
  positions: { key: string; value: Position };
}
let connection: Promise<IDBPDatabase<LibraryDB>> | undefined;
const database = () => connection ||= openDB<LibraryDB>('novel-reader', 1, {
  upgrade(db) {
    db.createObjectStore('jobs', { keyPath: 'id' });
    db.createObjectStore('records', { keyPath: ['jobId', 'index'] }).createIndex('jobId', 'jobId');
    db.createObjectStore('books', { keyPath: 'id' });
    db.createObjectStore('chunks', { keyPath: ['bookId', 'chapter', 'part'] }).createIndex('bookId', 'bookId');
    db.createObjectStore('positions', { keyPath: 'bookId' });
  }
});
export const db = {
  async job() { const jobs = await (await database()).getAll('jobs'); return jobs.sort((a, b) => b.created - a.created)[0] ?? null; },
  async saveJob(job: Job) {
    const tx = (await database()).transaction('jobs', 'readwrite', { durability: 'strict' });
    await tx.store.put(structuredClone(job)); await tx.done;
  },
  async records(jobId: string) { return new Map((await (await database()).getAllFromIndex('records', 'jobId', jobId)).map(r => [r.index, r])); },
  // Commit the page and progress in the same transaction. A failed write cannot advance the checkpoint.
  async checkpoint(job: Job, record: RecordData) {
    const tx = (await database()).transaction(['jobs', 'records'], 'readwrite', { durability: 'strict' });
    await Promise.all([tx.objectStore('jobs').put(structuredClone(job)), tx.objectStore('records').put(structuredClone(record))]);
    await tx.done;
  },
  async shelf() {
    const tx = (await database()).transaction(['books', 'positions']);
    const [books, positions] = await Promise.all([tx.objectStore('books').getAll(), tx.objectStore('positions').getAllKeys()]);
    const previouslyRead = new Set(positions);
    return books.filter(book => book.onShelf ?? (book.id.startsWith('txt:') || previouslyRead.has(book.id))).sort((a, b) => b.created - a.created);
  },
  async addToShelf(id: string) {
    const tx = (await database()).transaction('books', 'readwrite');
    const book = await tx.store.get(id);
    if (book && !book.onShelf) await tx.store.put({ ...book, onShelf: true });
    await tx.done;
    if (!book) throw Error('书籍不存在，请重新验证来源。');
  },
  async book(id: string) { return (await database()).get('books', id); },
  async ensureBook(book: Book) {
    const tx = (await database()).transaction('books', 'readwrite');
    const existing = await tx.store.get(book.id);
    if (!existing) await tx.store.add(book);
    await tx.done;
    return existing ?? book;
  },
  async saveBook(book: Book, chunks: Chunk[]) {
    const tx = (await database()).transaction(['books', 'chunks'], 'readwrite', { durability: 'strict' });
    const store = tx.objectStore('chunks');
    let cursor = await store.index('bookId').openCursor(book.id);
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    for (const chunk of chunks) await store.put(chunk);
    const books = tx.objectStore('books');
    const previous = await books.get(book.id);
    await books.put({ ...book, onShelf: previous?.onShelf ?? book.onShelf });
    await tx.done;
  },
  async removeBook(id: string) {
    const tx = (await database()).transaction(['books', 'chunks', 'positions'], 'readwrite', { durability: 'strict' });
    await tx.objectStore('books').delete(id); await tx.objectStore('positions').delete(id);
    let cursor = await tx.objectStore('chunks').index('bookId').openCursor(id);
    while (cursor) { await cursor.delete(); cursor = await cursor.continue(); }
    await tx.done;
  },
  async cacheChapter(id: string, chapter: number, text: string, chunkSize: number) {
    const tx = (await database()).transaction(['books', 'chunks'], 'readwrite', { durability: 'strict' });
    const book = await tx.objectStore('books').get(id);
    if (!book?.online || !book.chapters[chapter]) { await tx.done; throw Error('在线书籍不存在或章节无效。'); }
    const previous = book.chapters[chapter];
    const count = Math.max(1, Math.ceil(text.length / chunkSize));
    for (let part = 0; part < count; part++) await tx.objectStore('chunks').put({ bookId: id, chapter, part, text: text.slice(part * chunkSize, (part + 1) * chunkSize) });
    book.chapters[chapter] = { ...previous, chunks: count, length: text.length };
    book.chars += text.length - previous.length;
    await tx.objectStore('books').put(book); await tx.done;
    return book;
  },
  async chunk(bookId: string, chapter: number, part: number) { return (await database()).get('chunks', [bookId, chapter, part]); },
  async position(bookId: string) { return (await database()).get('positions', bookId); },
  async savePosition(position: Position) {
    const tx = (await database()).transaction('positions', 'readwrite', { durability: 'strict' });
    await tx.store.put(position); await tx.done;
  }
};
