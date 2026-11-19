import { BING_PERMISSIONS, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, extractBingResults } from './book-search';
import type { Entry } from './types';

type SearchJob = { id: string; tabId?: number; cancelled: boolean };
const jobs = new Map<string, SearchJob>();

function queryText(query: string) {
  if (typeof query !== 'string' || !query.trim() || query.length > 280) throw Error('搜索词无效。');
  return query.trim();
}

async function closeTab(job: SearchJob) {
  if (job.tabId === undefined) return;
  const id = job.tabId; job.tabId = undefined;
  await chrome.tabs.remove(id).catch(() => {});
}

export async function cancelBookSearch(owner: string, id: string) {
  const job = jobs.get(owner);
  if (job?.id !== id) return;
  job.cancelled = true;
  jobs.delete(owner);
  await closeTab(job);
}

export async function openBookSearch(query: string) {
  if (!chrome.search?.query) throw Error('当前浏览器不支持扩展发起搜索，请在浏览器手动搜索。');
  await chrome.search.query({ text: queryText(query), disposition: 'NEW_TAB' });
}

export async function searchBooks(owner: string, id: string, query: string, windowId?: number, limit = DEFAULT_SEARCH_LIMIT): Promise<Entry[]> {
  const text = queryText(query);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) throw Error(`搜索数量须为 1～${MAX_SEARCH_LIMIT} 的整数。`);
  if (!chrome.search?.query) throw Error('当前浏览器不支持后台搜索。');
  if (typeof id !== 'string' || !id || id.length > 80) throw Error('无效的搜索请求。');
  if (jobs.has(owner)) throw Error('搜索正在进行，请先取消。');
  const job: SearchJob = { id, cancelled: false };
  jobs.set(owner, job);
  try {
    if (!await chrome.permissions.contains({ origins: BING_PERMISSIONS })) throw Error('需要授权读取 Bing 搜索结果。');
    if (job.cancelled) throw Error('已取消搜索。');
    const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId });
    if (tab.id === undefined) throw Error('无法创建后台搜索标签页。');
    job.tabId = tab.id;
    if (job.cancelled) throw Error('已取消搜索。');
    await chrome.search.query({ text, tabId: tab.id });
    const deadline = Date.now() + 12000;
    while (!job.cancelled && Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id).catch(() => undefined);
      if (!current) break;
      if (current.status === 'complete' && current.url && current.url !== 'about:blank') {
        const address = new URL(current.url);
        if (!BING_PERMISSIONS.includes(`${address.origin}/*`)) throw Error('暂不支持读取当前默认搜索引擎的结果。');
        if (address.pathname !== '/search') throw Error('Bing 未返回普通结果页，可能需要验证。');
        const [data] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractBingResults, args: [null, null, limit] });
        if (job.cancelled) break;
        if (!data?.result?.length) throw Error('Bing 未返回可读取的普通结果。');
        return data.result;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw Error(job.cancelled ? '已取消搜索。' : '未能读取默认搜索引擎的结果，可能不是 Bing 或加载超时。');
  } finally {
    await closeTab(job);
    if (jobs.get(owner) === job) jobs.delete(owner);
  }
}
