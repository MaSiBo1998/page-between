import { afterEach, describe, expect, it, vi } from 'vitest';
import { readerPrefs, saveReaderPrefs } from '../src/reader-prefs';
import { paragraphAnchor, readerParagraphs } from '../src/reader-text';

afterEach(() => vi.unstubAllGlobals());

describe('紧凑阅读与旧进度兼容', () => {
  it('忽略显示空行，但保留原文缩进、字符和跨块偏移', () => {
    const text = '  第一段。\r\n\r\n　\n　　第二段。\n\n';
    const paragraphs = readerParagraphs(text, 10000);
    expect(paragraphs.map(p => p.text)).toEqual(['  第一段。', '　　第二段。']);
    for (const p of paragraphs) expect(text.slice(p.offset - 10000, p.offset - 10000 + p.text.length)).toBe(p.text);
  });
  it('旧进度落在被折叠的空行中时定位到下一段，而非回到章节开头', () => {
    const elements = readerParagraphs('第一段\n\n\n第二段').map(p => {
      const el = document.createElement('p'); el.dataset.offset = String(p.offset); el.textContent = p.text; return el;
    });
    expect(paragraphAnchor(elements, 4)).toBe(elements[1]);
    expect(paragraphAnchor(elements, 1)).toBe(elements[0]);
    expect(paragraphAnchor(elements, 999)).toBe(elements[1]);
  });
});

function storage(initial: Record<string, unknown>) {
  const data = { ...initial };
  vi.stubGlobal('chrome', { storage: { local: {
    get: vi.fn(async () => ({ ...data })),
    set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); })
  } } });
  return data;
}

describe('白底默认值迁移', () => {
  it('新用户与旧默认配色都使用不透明白底', async () => {
    storage({}); expect(await readerPrefs()).toMatchObject({ background: '#ffffff', opacity: 1 });
    storage({ readerPrefs: { background: '#f5f1e7', opacity: 0.92, size: 24 } });
    expect(await readerPrefs()).toMatchObject({ background: '#ffffff', opacity: 1, size: 24 });
  });
  it('保留自定义样式，迁移后仍允许用户重新选择旧颜色', async () => {
    storage({ readerPrefs: { background: '#101010', opacity: 0.6 } });
    expect(await readerPrefs()).toMatchObject({ background: '#101010', opacity: 0.6 });
    await saveReaderPrefs({ background: '#f5f1e7', opacity: 0.92 });
    expect(await readerPrefs()).toMatchObject({ background: '#f5f1e7', opacity: 0.92 });
  });
});
