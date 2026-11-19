import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Book } from '../types';

const BATCH_SIZE = 60;
const chapterKey = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

export function ChapterCatalog({ book, chapter, onSelect }: { book: Book; chapter: number; onSelect: (index: number) => void }) {
  const [query, setQuery] = useState('');
  const currentLimit = (Math.floor(chapter / BATCH_SIZE) + 1) * BATCH_SIZE;
  const [limit, setLimit] = useState(currentLimit);
  const [jump, setJump] = useState(0);
  const list = useRef<HTMLOListElement>(null);
  const current = useRef<HTMLButtonElement>(null);
  const entries = useMemo(() => book.chapters.map(({ title }, index) => ({ title, index, searchKey: chapterKey(title) })), [book.chapters]);
  const term = chapterKey(query);
  const results = useMemo(() => !term ? entries : /^\d+$/.test(term)
    ? entries.filter(entry => entry.index + 1 === Number(term))
    : entries.filter(entry => entry.searchKey.includes(term)), [entries, term]);
  useLayoutEffect(() => {
    if (!list.current) return;
    list.current.scrollTop = !term && current.current ? Math.max(0, current.current.offsetTop - list.current.clientHeight / 2) : 0;
  }, [jump, term]);

  return <div className="chapter-catalog">
    <div className="chapter-catalog-tools">
      <input aria-label="搜索章节" type="search" value={query} placeholder="搜索章节名或序号" onChange={event => { const value = event.target.value; setQuery(value); setLimit(chapterKey(value) ? BATCH_SIZE : currentLimit); }}/>
      <button onClick={() => { setQuery(''); setLimit(value => term ? currentLimit : Math.max(value, currentLimit)); setJump(value => value + 1); }}>当前章</button>
    </div>
    <ol ref={list} className="chapter-list" aria-label="章节列表" onScroll={event => {
      const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
      if (limit < results.length && scrollHeight - scrollTop - clientHeight < 180) setLimit(limit + BATCH_SIZE);
    }}>
      {results.slice(0, limit).map(({ title, index }) => <li key={index}>
        <button type="button" data-chapter-index={index} ref={index === chapter ? current : undefined} aria-current={index === chapter ? 'true' : undefined} onClick={() => onSelect(index)}>
          <span className="chapter-number">{index + 1}</span><span>{title}</span>
        </button>
      </li>)}
      {!results.length && <li className="chapter-no-results">未找到章节</li>}
    </ol>
  </div>;
}
