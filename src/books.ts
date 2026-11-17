import { db } from './db';
import { selected } from './parser';
import type { Book, Chunk, Job, RecordData } from './types';

export const CHUNK_SIZE = 10000;
export function decodeTXT(buffer: ArrayBuffer, encoding = 'auto'): string {
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength > 32 * 1024 * 1024) throw Error('TXT 文件超过 32 MiB。');
  if (encoding !== 'auto') return new TextDecoder(encoding).decode(bytes).replace(/^\ufeff/, '');
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('gbk').decode(bytes); }
}
export function splitTXT(text: string): { title: string; text: string }[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\ufeff/, '');
  const pattern = /^(?:第\s*[\d零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]+\s*[章节回话卷][^\n]{0,100}|chapter\s+\d+[^\n]{0,100}|序章[^\n]{0,60}|番外[^\n]{0,60})\s*$/gim;
  const matches = [...normalized.matchAll(pattern)];
  if (!matches.length) return [{ title: '正文', text: normalized }];
  const chapters: { title: string; text: string }[] = [];
  const prefix = normalized.slice(0, matches[0].index).trim();
  if (prefix) chapters.push({ title: '序言', text: prefix });
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    chapters.push({ title: match[0].trim(), text: normalized.slice(match.index! + match[0].length, matches[index + 1]?.index ?? normalized.length).trim() });
  }
  return chapters;
}
export function buildBook(id: string, title: string, chapters: { title: string; text: string }[], source?: string): { book: Book; chunks: Chunk[] } {
  const chunks: Chunk[] = [];
  const metas = chapters.map((chapter, index) => {
    const count = Math.max(1, Math.ceil(chapter.text.length / CHUNK_SIZE));
    for (let part = 0; part < count; part++) chunks.push({ bookId: id, chapter: index, part, text: chapter.text.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE) });
    return { title: chapter.title, chunks: count, length: chapter.text.length };
  });
  return { book: { id, title, created: Date.now(), chapters: metas, chars: chapters.reduce((n, c) => n + c.text.length, 0), source }, chunks };
}
export async function importTXT(file: File, encoding: string): Promise<Book> {
  if (file.size > 32 * 1024 * 1024) throw Error('TXT 文件超过 32 MiB。');
  const buffer = await file.arrayBuffer();
  const text = decodeTXT(buffer, encoding);
  if (!text.trim()) throw Error('文件没有可阅读的文字。');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const id = 'txt:' + [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  const previous = await db.book(id); if (previous) return previous;
  const result = buildBook(id, file.name.replace(/\.txt$/i, ''), splitTXT(text));
  await db.saveBook(result.book, result.chunks); return result.book;
}
export async function bookFromJob(job: Job, records: Map<number, RecordData>): Promise<Book> {
  const chapters = selected(job).filter(i => records.get(i)?.pages.length).map(i => ({
    title: job.catalog[i].title + (records.get(i)?.done ? '' : '【未完整】'), text: records.get(i)!.pages.map(p => p.text).join('\n\n')
  }));
  if (!chapters.length) throw Error('还没有已保存的正文。');
  const result = buildBook('job:' + job.id, job.title, chapters, job.bookURL);
  await db.saveBook(result.book, result.chunks); return result.book;
}
