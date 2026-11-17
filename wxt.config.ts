import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  hooks: {
    'build:manifestGenerated'(_wxt, manifest) {
      // Runtime-only overlay uses activeTab or explicitly granted origins.
      // WXT otherwise adds its match patterns as permanent host permissions.
      delete manifest.host_permissions;
      if (!manifest.content_scripts?.length) delete manifest.content_scripts;
    }
  },
  manifest: {
    name: '页间 · 小说下载与阅读',
    description: '多网站章节下载、随机并发调度与本地 TXT 阅读器。',
    minimum_chrome_version: '116',
    permissions: ['activeTab', 'scripting', 'storage', 'offscreen', 'alarms', 'downloads'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    web_accessible_resources: [{ resources: ['reader.html', 'assets/*', 'chunks/*'], matches: ['http://*/*', 'https://*/*'] }],
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; frame-ancestors 'self' http: https:" },
    icons: { 16: 'icon/16.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    action: { default_title: '页间 · 下载与阅读' }
  }
});
