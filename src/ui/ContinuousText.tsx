import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { CHUNK_SIZE } from '../books';
import { db } from '../db';
import { readerParagraphs } from '../reader-text';
import { rpc } from '../rpc';
import type { Book, Position } from '../types';

// Small display slices keep DOM usage bounded independently of storage chunk size.
export const DISPLAY_SIZE = 800;
type Block = { chapter: number; start: number; end: number; paragraphs: ReturnType<typeof readerParagraphs> };
type Anchor = { chapter: number; offset: number; y: number };
export type ContinuousTextHandle = { flush: () => void };
type Props = {
  book: Book; start: Position; active: boolean; layoutKey: string;
  onPosition: (position: Position) => void; onBook: (book: Book) => void;
};

function anchor(view: HTMLElement, paragraphs: HTMLElement[]): Anchor | undefined {
  const top = view.getBoundingClientRect().top;
  // Paragraphs are ordered and do not overlap: find the first visible one with
  // logarithmic geometry reads rather than walking the offscreen buffer.
  let first = 0, end = paragraphs.length;
  while (first < end) {
    const mid = Math.floor((first + end) / 2);
    if (paragraphs[mid].getBoundingClientRect().bottom <= top + 4) first = mid + 1; else end = mid;
  }
  const el = paragraphs[first];
  if (el) {
    const node = el.firstChild;
    if (!node?.textContent) return;
    const range = document.createRange();
    let low = 0, high = node.textContent.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      range.setStart(node, mid); range.setEnd(node, Math.min(mid + 1, node.textContent.length));
      if (range.getBoundingClientRect().bottom <= top + 4) low = mid + 1; else high = mid;
    }
    const at = Math.min(low, node.textContent.length - 1);
    range.setStart(node, at); range.setEnd(node, at + 1);
    return { chapter: Number(el.dataset.chapter), offset: Number(el.dataset.offset) + at, y: range.getBoundingClientRect().top - top };
  }
  const blocks = [...view.querySelectorAll<HTMLElement>('[data-block]')];
  const block = blocks.find(block => block.getBoundingClientRect().bottom > top + 4) || blocks.at(-1);
  if (block) return { chapter: Number(block.dataset.chapter), offset: Number(block.dataset.start), y: block.getBoundingClientRect().top - top };
}

// Loading indicators, progress and adjacent blocks must not reparse/reconcile
// the text already on screen. Only a newly loaded block gets new paragraphs.
const TextBlock = memo(function TextBlock({ block, title, bookEnd }: { block: Block; title: string; bookEnd: boolean }) {
  return <div data-block data-chunk={`${block.chapter}:${block.start}`} data-chapter={block.chapter} data-start={block.start} data-book-end={bookEnd || undefined}>
    {block.start === 0 && <h2>{title}</h2>}
    {block.paragraphs.map(paragraph => <p key={paragraph.offset} data-chapter={block.chapter} data-offset={paragraph.offset}>{paragraph.text}</p>)}
  </div>;
});

function restore(view: HTMLElement, saved: Anchor) {
  const align = (top: number) => {
    const desired = view.scrollTop + top - view.getBoundingClientRect().top - saved.y;
    view.scrollTop = desired;
    return desired - view.scrollTop < 2;
  };
  if (saved.offset === 0 && saved.y === 0) {
    const first = view.querySelector<HTMLElement>(`[data-block][data-chapter="${saved.chapter}"][data-start="0"]`);
    if (first) return align(first.getBoundingClientRect().top);
  }
  const paragraphs = [...view.querySelectorAll<HTMLElement>(`[data-offset][data-chapter="${saved.chapter}"]`)];
  const el = paragraphs.find(el => saved.offset < Number(el.dataset.offset) + (el.textContent?.length || 0)) || paragraphs.at(-1);
  if (el?.firstChild?.textContent) {
    const at = Math.max(0, Math.min(saved.offset - Number(el.dataset.offset), el.firstChild.textContent.length - 1));
    const range = document.createRange(); range.setStart(el.firstChild, at); range.setEnd(el.firstChild, at + 1);
    return align(range.getBoundingClientRect().top);
  }
  const block = view.querySelector<HTMLElement>(`[data-block][data-chapter="${saved.chapter}"]`);
  return !block || align(block.getBoundingClientRect().top);
}

export const ContinuousText = forwardRef<ContinuousTextHandle, Props>(function ContinuousText(props, ref) {
  const view = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [busy, setBusy] = useState(true), [failure, setFailure] = useState('');
  const items = useRef<Block[]>([]), disposed = useRef(false), working = useRef(false);
  const pending = useRef<Anchor | undefined>(undefined), saved = useRef<Anchor | undefined>(undefined);
  const resumeAnchor = useRef<Anchor | undefined>(undefined);
  const failed = useRef(false), raf = useRef(0), cache = useRef(new Map<string, string>());
  const paragraphNodes = useRef<HTMLElement[]>([]), reported = useRef<Anchor | undefined>(undefined);
  const tick = useRef<() => void>(() => {});

  async function read(chapter: number, offset: number): Promise<Block> {
    let book = latest.current.book;
    if (book.online && !book.chapters[chapter].chunks) {
      book = await rpc<Book>({ op: 'online-chapter', bookId: book.id, index: chapter });
      if (disposed.current) throw Error('已停止阅读');
      latest.current = { ...latest.current, book }; props.onBook(book);
    }
    const meta = book.chapters[chapter];
    const at = Math.max(0, Math.min(offset, Math.max(0, meta.length - 1)));
    const part = Math.floor(at / CHUNK_SIZE), key = `${chapter}:${part}`;
    let text = cache.current.get(key);
    if (text === undefined) {
      const chunk = await db.chunk(book.id, chapter, part);
      if (disposed.current) throw Error('已停止阅读');
      if (!chunk) throw Error('本地正文块缺失，请重新导入文件或重新下载。');
      text = chunk.text; cache.current.set(key, text);
      if (cache.current.size > 6) cache.current.delete(cache.current.keys().next().value!);
    } else {
      // Retain recently revisited chunks when alternating scroll direction.
      cache.current.delete(key); cache.current.set(key, text);
    }
    const local = Math.floor((at % CHUNK_SIZE) / DISPLAY_SIZE) * DISPLAY_SIZE;
    const content = text.slice(local, local + DISPLAY_SIZE), start = part * CHUNK_SIZE + local;
    return { chapter, start, end: start + content.length, paragraphs: readerParagraphs(content, start) };
  }
  function schedule() {
    if (disposed.current || !latest.current.active || document.hidden || raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (disposed.current || !latest.current.active || document.hidden) return;
      if (!pending.current) report();
      tick.current();
    });
  }
  function report() {
    if (!view.current || !latest.current.active || !view.current.clientHeight || resumeAnchor.current) return;
    const current = anchor(view.current, paragraphNodes.current);
    if (current) {
      saved.current = current;
      if (current.chapter !== reported.current?.chapter || current.offset !== reported.current?.offset) {
        reported.current = current;
        latest.current.onPosition({ bookId: latest.current.book.id, chapter: current.chapter, offset: current.offset, updated: Date.now() });
      }
    }
  }
  // Explicit actions flush the last frame before saving or unmounting the view.
  useImperativeHandle(ref, () => ({ flush: report }));
  useLayoutEffect(() => () => report(), []);
  function replace(next: Block[], keep = view.current ? anchor(view.current, paragraphNodes.current) : undefined) {
    pending.current = resumeAnchor.current ?? keep; items.current = next; setBlocks(next);
  }
  function restorePending(view: HTMLElement) {
    if (!pending.current) return;
    const tail = items.current.at(-1)!, chapters = latest.current.book.chapters;
    const hasMore = tail.chapter < chapters.length - 1 || tail.end < chapters[tail.chapter].length;
    if (restore(view, pending.current) || !hasMore) resumeAnchor.current = undefined;
    saved.current = pending.current; pending.current = undefined;
  }
  tick.current = () => {
    const el = view.current;
    if (!el || !latest.current.active || document.hidden || working.current || failed.current || pending.current || !items.current.length) return;
    const rect = el.getBoundingClientRect(), nodes = [...el.querySelectorAll<HTMLElement>('[data-block]')];
    // Retain the viewport and one viewport on each side, rounded to display blocks.
    let first = 0, last = nodes.length - 1;
    while (first < last && nodes[first].getBoundingClientRect().bottom < rect.top - el.clientHeight - 80) first++;
    while (last > first && nodes[last].getBoundingClientRect().top > rect.bottom + el.clientHeight + 80) last--;
    if (first || last < nodes.length - 1) { replace(items.current.slice(first, last + 1), saved.current); return; }
    const head = items.current[0], tail = items.current.at(-1)!, book = latest.current.book;
    const needBefore = nodes[0].getBoundingClientRect().top > rect.top - el.clientHeight + 80 && (head.start > 0 || head.chapter > 0);
    const needAfter = (resumeAnchor.current || nodes.at(-1)!.getBoundingClientRect().bottom < rect.bottom + el.clientHeight - 80) && (tail.end < book.chapters[tail.chapter].length || tail.chapter + 1 < book.chapters.length);
    if (!needBefore && !needAfter) return;
    const fillShortChapter = needAfter && saved.current?.offset === 0 && el.scrollHeight <= el.clientHeight;
    const prepend = needBefore && !fillShortChapter && !resumeAnchor.current;
    const chapter = prepend ? (head.start > 0 ? head.chapter : head.chapter - 1) : (tail.end < book.chapters[tail.chapter].length ? tail.chapter : tail.chapter + 1);
    const offset = prepend ? (head.start > 0 ? head.start - 1 : Number.MAX_SAFE_INTEGER) : (chapter === tail.chapter ? tail.end : 0);
    working.current = true; setBusy(true);
    void read(chapter, offset).then(block => {
      if (disposed.current || !latest.current.active) return;
      replace(prepend ? [block, ...items.current] : [...items.current, block]);
    }).catch(error => {
      if (!disposed.current) { resumeAnchor.current = undefined; failed.current = true; setFailure(error instanceof Error ? error.message : String(error)); }
    }).finally(() => { working.current = false; if (!disposed.current) { setBusy(false); schedule(); } });
  };
  function loadInitial() {
    if (working.current || disposed.current) return;
    working.current = true; setBusy(true);
    const start = latest.current.start;
    pending.current = { chapter: start.chapter, offset: start.offset, y: 0 };
    if (start.offset > 0) resumeAnchor.current = pending.current;
    void read(start.chapter, start.offset).then(block => {
      if (!disposed.current) { items.current = [block]; setBlocks([block]); }
    }).catch(error => { if (!disposed.current) { failed.current = true; setFailure(String(error)); } })
      .finally(() => { working.current = false; if (!disposed.current) { setBusy(false); schedule(); } });
  }
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true; cancelAnimationFrame(raf.current); raf.current = 0;
      cache.current.clear(); paragraphNodes.current = [];
    };
  }, []);
  useEffect(() => {
    if (props.active && !items.current.length && !failed.current) loadInitial();
    // A new book or explicit navigation remounts this component via its key.
  }, [props.active]);
  useLayoutEffect(() => {
    if (view.current) paragraphNodes.current = [...view.current.querySelectorAll<HTMLElement>('[data-offset]')];
    if (!view.current?.clientHeight || !props.active || !blocks.length) return;
    restorePending(view.current);
    schedule();
  }, [blocks]);
  useEffect(() => {
    const el = view.current; if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!el.clientHeight || !latest.current.active) return;
      if (saved.current && items.current.length) restore(el, saved.current);
      schedule();
    });
    observer.observe(el);
    const visibility = () => {
      if (document.hidden) { cancelAnimationFrame(raf.current); raf.current = 0; }
      else schedule();
    };
    document.addEventListener('visibilitychange', visibility);
    let last = -Infinity;
    const wheel = (event: WheelEvent) => {
      if (!latest.current.active || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY) || !event.deltaY) return;
      event.preventDefault();
      const now = performance.now(), fresh = now - last >= 160; last = now;
      if (!fresh) return;
      const style = getComputedStyle(el), line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.8;
      el.scrollTop += Math.sign(event.deltaY) * Math.max(1, el.clientHeight - line);
      schedule();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); el.removeEventListener('wheel', wheel); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useLayoutEffect(() => {
    if (props.active && view.current?.clientHeight && items.current.length) {
      if (pending.current) restorePending(view.current);
      else if (saved.current) restore(view.current, saved.current);
    }
    if (props.active) schedule(); else { cancelAnimationFrame(raf.current); raf.current = 0; }
  }, [props.active]);
  useLayoutEffect(() => {
    if (saved.current && view.current && items.current.length) restore(view.current, saved.current);
    schedule();
  }, [props.layoutKey]);
  return <div className="reader-scroll" ref={view} onScroll={schedule} tabIndex={0} aria-label="小说正文">
    {blocks.map(block => <TextBlock key={`${block.chapter}:${block.start}`} block={block} title={props.book.chapters[block.chapter].title}
      bookEnd={block.chapter === props.book.chapters.length - 1 && block.end >= props.book.chapters[block.chapter].length}/>)}
    {busy && <p role="status">正在加载正文…</p>}
    {failure && <p className="reader-load-error" role="alert">{failure}<button onClick={() => {
      failed.current = false; setFailure('');
      if (!items.current.length) loadInitial(); else schedule();
    }}>重试加载</button></p>}
  </div>;
});
