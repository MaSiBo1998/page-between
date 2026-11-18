import type { Entry } from './types';

export const BING_PERMISSIONS = ['https://www.bing.com/*', 'https://cn.bing.com/*'];

export function searchPhrase(title: string, author: string) {
  return [title.trim(), author.trim(), '小说 目录'].filter(Boolean).join(' ');
}

export function extractBingResults(page = document, address = location.href): Entry[] {
  const source = new URL(address);
  const origins = ['https://www.bing.com', 'https://cn.bing.com'];
  if (!origins.includes(source.origin) || source.pathname !== '/search' || Number(source.searchParams.get('first') || 1) > 1) return [];
  const result = new Map<string, Entry>();
  for (const link of page.querySelectorAll<HTMLAnchorElement>('#b_results > li.b_algo:not(.b_ad) h2 a[href]')) {
    const title = (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!title) continue;
    try {
      let target = new URL(link.getAttribute('href')!, source);
      if (origins.includes(target.origin) && target.pathname === '/ck/a') {
        const encoded = target.searchParams.get('u');
        if (!encoded?.startsWith('a1') || !/^[\w-]+$/.test(encoded) || encoded.length > 8192) continue;
        const bytes = Uint8Array.from(atob(encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
        target = new URL(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      }
      if (!/^https?:$/.test(target.protocol) || target.username || target.password || /(?:^|\.)bing\.com$/i.test(target.hostname)) continue;
      target.hash = '';
      for (const key of [...target.searchParams.keys()]) if (/^utm_|^(?:msclkid|fbclid|gclid)$/i.test(key)) target.searchParams.delete(key);
      if (!result.has(target.href)) result.set(target.href, { title, url: target.href });
      if (result.size === 12) break;
    } catch { continue; }
  }
  return [...result.values()];
}
