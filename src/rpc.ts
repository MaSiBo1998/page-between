import type { Operation, Reply } from './types';
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
