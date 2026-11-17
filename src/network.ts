import { core, decodeHTML } from './parser';
import { retryAfter, Scheduler, wait } from './scheduler';

export type Authorize = (url: string) => Promise<void>;
export class Network {
  requests = 0;
  constructor(public scheduler: Scheduler, private root: string, private authorize: Authorize) {}
  async document(address: string, signal: AbortSignal): Promise<Document> {
    core.ensureOrigin(address, this.root);
    await this.authorize(address);
    for (let attempt = 0; ; attempt++) {
      let retry = false;
      try {
        const result = await this.scheduler.run(async () => {
          this.requests++;
          const controller = new AbortController();
          const abort = () => controller.abort(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          const timeout = setTimeout(() => controller.abort(Error('网页请求超时')), 25000);
          try {
            const response = await fetch(address, { signal: controller.signal, credentials: 'include', redirect: 'error', cache: 'no-store' });
            if (response.status === 429) {
              this.scheduler.throttled(retryAfter(response.headers.get('Retry-After')));
              retry = true; throw Error('网站限流（429），已降速；持续限流后将暂停。');
            }
            if (response.status === 403) throw Error('网站拒绝访问（403），请在网页完成正常访问后再继续。');
            if (!response.ok) { retry = response.status >= 500; throw Error('HTTP ' + response.status); }
            const type = response.headers.get('content-type') || '';
            if (type && !/html|text\/plain/i.test(type)) throw Error('响应不是可识别的 HTML 页面。');
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength > 12 * 1024 * 1024) throw Error('单页响应过大，已停止。');
            signal.throwIfAborted();
            this.scheduler.succeeded();
            return decodeHTML(buffer, 'content-type: ' + type);
          } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
        }, signal);
        return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof TypeError || (error instanceof Error && /超时/.test(error.message))) retry = true;
        if (!retry || attempt >= 2) throw error;
        await wait((1500 + Math.random() * 1500) * 2 ** attempt, signal);
      }
    }
  }
}
