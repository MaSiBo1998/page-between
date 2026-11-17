import * as legacyCore from './legacy/core.js';
import * as legacyParser from './legacy/parser.js';
import * as legacySites from './legacy/sites.js';
import type { ChapterData, Entry, Job, RecordData, Rules, Scan } from './types';

export const core = legacyCore as unknown as {
  url(value: string, base?: string): string;
  allowed(value: string, base: string): boolean;
  ensureOrigin(value: string, origin: string): string;
  validate(job: Scan, index: number, record: Pick<RecordData, 'next' | 'pages'>, data: ChapterData): { done: boolean; next: string | null; page: number; total: number | null };
};
const parser = legacyParser as unknown as {
  catalog(doc: Document, base: string, rules: Rules): { title: string; catalog: Entry[]; next: string | null };
  chapter(doc: Document, base: string, rules: Rules): ChapterData;
  decode(buffer: ArrayBuffer, headers: string): Document;
};
export const sites = legacySites.sites as { name: string; domain: string; url: string; hints: Rules }[];
export function effective(doc: Document, base: string, rules: Rules): Rules {
  const profile = sites.find(s => new URL(base).hostname === s.domain || new URL(base).hostname.endsWith('.' + s.domain));
  const result = { ...rules };
  for (const [key, selector] of Object.entries(profile?.hints || {})) {
    if (typeof selector === 'string' && !rules[key as keyof Rules] && doc.querySelector(selector))
      Object.assign(result, { [key]: selector });
  }
  return result;
}
export const decodeHTML = parser.decode;
export function parseCatalog(doc: Document, base: string, rules: Rules) {
  return parser.catalog(doc, base, effective(doc, base, rules));
}
export function parseChapter(doc: Document, base: string, rules: Rules) {
  return parser.chapter(doc, base, effective(doc, base, rules));
}
export function validateRules(rules: Rules): Rules {
  const output: Rules = {};
  for (const key of ['catalog', 'content', 'bookTitle', 'chapterTitle', 'next', 'catalogNext', 'remove'] as const) {
    const selector = rules[key];
    if (selector) { document.createDocumentFragment().querySelector(selector); output[key] = selector; }
  }
  output.reverse = !!rules.reverse;
  return output;
}
export function selected(job: Pick<Job, 'start' | 'end' | 'catalog'>): number[] {
  if (!Number.isInteger(job.start) || !Number.isInteger(job.end) || job.start < 0 || job.end < job.start || job.end >= job.catalog.length)
    throw Error('章节范围无效，请重新选择起止章节。');
  return Array.from({ length: job.end - job.start + 1 }, (_, n) => n + job.start);
}
export function toTXT(job: Job, records: Map<number, RecordData>): string {
  const missing: string[] = [];
  const chunks = [job.title, `来源：${job.bookURL}`, `范围：目录第 ${job.start + 1}～${job.end + 1} 项`,
    `已保存 ${job.completed}/${job.end - job.start + 1} 章，${job.pageCount} 页`,
    job.status === 'complete' ? '状态：选定范围已完成' : '状态：部分内容', ''];
  for (const index of selected(job)) {
    const record = records.get(index);
    if (!record?.done) missing.push(job.catalog[index].title);
    if (!record?.pages.length) continue;
    chunks.push('', job.catalog[index].title, record.done ? '' : '【本章未完整】', '', ...record.pages.map(p => p.text));
  }
  if (missing.length) chunks.push('', '【未完成章节】', ...missing);
  return '\ufeff' + chunks.join('\r\n');
}
