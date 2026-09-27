import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const failures = [];
async function check(root) {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name).replaceAll('\\', '/');
    if (item.isDirectory()) { await check(path); continue; }
    if (!/\.[cm]?[jt]sx?$/.test(item.name)) continue;
    const source = await readFile(path, 'utf8');
    const imports = [...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(match => match[1]);
    for (const dependency of imports) {
      if (path.startsWith('apps/web/') && /apps\/server|better-sqlite3|node:/.test(dependency)) failures.push(`${path}: server dependency ${dependency}`);
      if (path.startsWith('apps/web/src/ui/') && /platform\/|capacitor|\bidb\b/.test(dependency)) failures.push(`${path}: UI bypasses ClientPlatform via ${dependency}`);
      if (path.startsWith('packages/client/') && /react|capacitor|\bidb\b|apps\//.test(dependency)) failures.push(`${path}: platform-dependent client port ${dependency}`);
      if (path.startsWith('packages/contracts/') && /react|capacitor|apps\/|packages\/client/.test(dependency)) failures.push(`${path}: application dependency in wire contracts ${dependency}`);
    }
  }
}
for (const root of ['apps/web/src', 'packages/client/src', 'packages/contracts/src']) await check(root);
if (failures.length) throw new Error(failures.join('\n'));
console.log('PASS: contracts, client ports and UI preserve package/platform boundaries.');
