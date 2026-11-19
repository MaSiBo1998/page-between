export interface Rules {
  catalog?: string; content?: string; bookTitle?: string; chapterTitle?: string;
  next?: string; catalogNext?: string; remove?: string; reverse?: boolean;
}
export interface Entry { title: string; url: string }
export interface VerifiedSource { book: Book; sampleIndex: number }
export interface Scan { bookURL: string; title: string; catalog: Entry[]; catalogURLs: string[]; rules: Rules }
export interface Settings { concurrency: number; minInterval: number; maxInterval: number }
export const DEFAULT_SETTINGS: Settings = { concurrency: 6, minInterval: 200, maxInterval: 600 };
export type JobStatus = 'running' | 'paused' | 'complete' | 'cancelled' | 'error';
export interface Job extends Scan {
  id: string; start: number; end: number; settings: Settings; status: JobStatus;
  created: number; completed: number; pageCount: number; chars: number; error: string;
  current: string; requests: number; rate: number; eta: number | null; activeLimit: number;
}
export interface Page { url: string; page: number; total: number | null; text: string }
export interface RecordData { jobId: string; index: number; done: boolean; next: string | null; pages: Page[] }
export interface ChapterData { kind: string; url: string; rawTitle: string; title: string; text: string; next: string | null; selector: string }
export interface ChapterMeta { title: string; chunks: number; length: number }
export interface Book { id: string; title: string; created: number; chars: number; chapters: ChapterMeta[]; source?: string; online?: Scan; onShelf?: boolean }
export interface Chunk { bookId: string; chapter: number; part: number; text: string }
export interface Position { bookId: string; chapter: number; offset: number; updated: number }
export interface ReaderPrefs {
  font: string; size: number; lineHeight: number; color: string; background: string; opacity: number;
  width: number; height: number; x: number; y: number; shortcut: string;
}
export const DEFAULT_READER: ReaderPrefs = {
  font: 'serif', size: 14, lineHeight: 1.9, color: '#354038', background: '#ffffff', opacity: 1,
  width: 560, height: 620, x: 80, y: 80, shortcut: 'Alt+R'
};
export type ReaderView = 'read' | 'library' | 'online' | 'download';
export type Operation =
  | { op: 'search-books'; query: string; requestId: string; limit?: number }
  | { op: 'cancel-book-search'; requestId: string }
  | { op: 'open-book-search'; query: string }
  | { op: 'verify-source'; url: string; rules: Rules; settings: Settings }
  | { op: 'scan'; url: string; rules: Rules; settings: Settings; snapshot?: string }
  | { op: 'preview'; scan: Scan; index: number; settings: Settings }
  | { op: 'start'; scan: Scan; start: number; end: number; settings: Settings }
  | { op: 'open-online'; url: string; rules: Rules; settings: Settings; snapshot?: string }
  | { op: 'online-chapter'; bookId: string; index: number }
  | { op: 'pause' | 'resume' | 'cancel' | 'status' | 'export' | 'read-job' | 'health' }
  | { op: 'reader-toggle'; bookId?: string; tabId?: number; view?: ReaderView; visibility?: 'show' | 'hide' | 'keep'; controls?: 'show' | 'hide' };
export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };
export function settings(value: Settings): Settings {
  if (!Number.isInteger(value.concurrency) || value.concurrency < 1 || value.concurrency > 16 ||
      !Number.isFinite(value.minInterval) || value.minInterval < 50 ||
      !Number.isFinite(value.maxInterval) || value.maxInterval < value.minInterval || value.maxInterval > 60000)
    throw Error('并发须为 1～16，随机间隔须为 50～60000 毫秒且下限不大于上限。');
  return { concurrency: value.concurrency, minInterval: value.minInterval, maxInterval: value.maxInterval };
}
