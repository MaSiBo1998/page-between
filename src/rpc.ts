import { DEFAULT_SETTINGS, settings, type Job, type Operation, type Reply, type VerifiedSource } from './types';
import { sites } from './parser';

export async function rpc<T>(operation: Operation): Promise<T> {
  const reply: Reply<T> = await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', operation });
  if (!reply?.ok) throw Error(reply && 'error' in reply ? reply.error : '扩展后台没有响应，请重新打开扩展。');
  return reply.data;
}
export async function authorize(url: string): Promise<void> {
  const reply: Reply = await chrome.runtime.sendMessage({ channel: 'novel-reader', target: 'background', authorize: url });
  if (!reply?.ok) throw Error(reply && 'error' in reply ? reply.error : '没有网站访问权限。');
}
export async function grantSite(address: string): Promise<void> {
  const u = new URL(address);
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw Error('请输入普通 HTTP/HTTPS 网页地址。');
  const site = sites.find(site => u.hostname === site.domain || u.hostname.endsWith('.' + site.domain));
  const patterns = site ? [u.protocol + '//*.' + site.domain + '/*'] : [u.origin + '/*'];
  const granted = await chrome.permissions.request({ origins: patterns });
  if (!granted) throw Error('未取得该网站访问权限。');
}

export async function downloadVerifiedSource(source: VerifiedSource): Promise<Job> {
  const scan = source.book.online;
  if (!scan) throw Error('请先验证在线来源。');
  const { downloadSettings } = await chrome.storage.local.get('downloadSettings');
  return rpc<Job>({ op: 'start', scan, start: 0, end: scan.catalog.length - 1, settings: settings(downloadSettings ?? DEFAULT_SETTINGS) });
}
