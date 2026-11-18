import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.output');
const source = path.join(output, 'chrome-mv3');
const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.name, '页间 · 小说下载与阅读');
const target = path.join(output, `page-between-${pkg.version}-chromium`);
const existing = await readFile(path.join(target, 'manifest.json'), 'utf8').catch(error => {
  if (error.code === 'ENOENT') return undefined;
  throw error;
});
if (existing) assert.equal(JSON.parse(existing).name, manifest.name, '目标目录不是页间扩展');
async function files(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    assert.ok(!entry.isSymbolicLink(), `拒绝处理符号链接：${relative}`);
    if (entry.isDirectory()) result.push(...await files(directory, relative));
    else result.push(relative);
  }
  return result;
}
const expected = new Set(await files(source));
// Windows preserves an old spelling during a case-only rename. Compare paths
// using filesystem semantics so stale cleanup never removes a newly copied file.
const pathKey = relative => process.platform === 'win32' ? relative.toLowerCase() : relative;
const expectedPaths = new Set([...expected].map(pathKey));
let backup;
const stale = existing ? (await files(target)).filter(relative =>
  !expectedPaths.has(pathKey(relative)) && /^(chunks|assets)[/\\][^/\\]+\.(js|css)$/.test(relative)) : [];
if (existing) {
  backup = path.join(output, 'preview-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(path.dirname(backup), { recursive: true });
  await cp(target, backup, { recursive: true, errorOnExist: true, force: false });
}
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
for (const relative of stale) {
  const resolved = path.resolve(target, relative);
  assert.ok(resolved.startsWith(target + path.sep), '清理目标必须在安装目录内');
  await rm(resolved); // Only obsolete generated files; recoverable from backup.
}
for (const relative of expected) {
  assert.deepEqual(await readFile(path.join(target, relative)), await readFile(path.join(source, relative)), relative);
}
const result = { build: manifest.version_name || manifest.version, target, files: expected.size, removedGeneratedFiles: stale.length, backup,
  browserReloaded: false, next: '在页间弹窗中确认本地修复版标记，点击应用本地更新；回到普通网页重新打开浮窗。' };
await writeFile(path.join(output, 'preview-status.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
