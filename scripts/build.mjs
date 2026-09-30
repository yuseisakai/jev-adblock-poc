import { mkdir, cp, readFile, rm } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
await rm(new URL('dist/', root), { recursive: true, force: true });
await mkdir(new URL('dist/', root), { recursive: true });
await cp(new URL('src/', root), new URL('dist/src/', root), { recursive: true });
await cp(new URL('manifest.json', root), new URL('dist/manifest.json', root));
const manifest = JSON.parse(await readFile(new URL('dist/manifest.json', root), 'utf8'));
if (manifest.manifest_version !== 3) throw Error('Manifest V3 required');
console.log('Built dist/ — chrome://extensions で「パッケージ化されていない拡張機能を読み込む」から選択');

for (const name of ['LICENSE', 'PRIVACY.md', 'THIRD_PARTY_NOTICES.md', 'INSTALL.md'])
  await cp(new URL(name, root), new URL(`dist/${name}`, root));
