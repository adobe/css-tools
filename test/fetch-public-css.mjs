import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const directory = new URL('../.compatibility-css/', import.meta.url);
const files = [
  'normalize.css@8.0.1/normalize.css',
  'bootstrap@5.3.3/dist/css/bootstrap.css',
  'bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'bulma@1.0.2/css/bulma.css',
  'animate.css@4.1.1/animate.css',
  'purecss@3.0.0/build/pure.css',
  'tachyons@4.12.0/css/tachyons.css',
  'milligram@1.4.1/dist/milligram.css',
  'water.css@2.1.1/out/water.css',
  'modern-normalize@2.0.0/modern-normalize.css',
];
const hashes = new Map([
  [
    'normalize.css@8.0.1/normalize.css',
    '580818700724d42d7fcc4979b0197971fca1c6d2e0286769237a0ac897df5512',
  ],
  [
    'bootstrap@5.3.3/dist/css/bootstrap.css',
    '18a105d7cb38e01e5ed0ca255c092992a2e211b39594a7fa57262bfc6fc4ea9c',
  ],
  [
    'bootstrap@5.3.3/dist/css/bootstrap.min.css',
    '3c8f27e6009ccfd710a905e6dcf12d0ee3c6f2ac7da05b0572d3e0d12e736fc8',
  ],
  [
    'bulma@1.0.2/css/bulma.css',
    '113149035b8b7543113ca93d6f8c75a7ff4a73a1c0877d5e50c710aa1fe5f404',
  ],
  [
    'animate.css@4.1.1/animate.css',
    'c1b6f9ed1effff87233740ce612ed3cd3fbd3cb34c0863373d820fde1b2c8d8f',
  ],
  [
    'purecss@3.0.0/build/pure.css',
    '61642839d5e0d04641fceb5a4dcfc479a6ea17510c57c489314c3a662dcc7c9b',
  ],
  [
    'tachyons@4.12.0/css/tachyons.css',
    'e24dd3551dab4c568876e42c086a4b0a960d22a4446bd4c0a5fd47cda142e021',
  ],
  [
    'milligram@1.4.1/dist/milligram.css',
    '0e79dc73372d7747b20efa42310eed3f4b9826ead1d998175ec374a51d363bab',
  ],
  [
    'water.css@2.1.1/out/water.css',
    '47073611dda0977c57c95d5bbda291084a589e5c7af197fa4d09822657249a0e',
  ],
  [
    'modern-normalize@2.0.0/modern-normalize.css',
    'e7ac1d317608989e22143074fbe95fb77027f230e8540c566f5d596616721308',
  ],
]);

// Sample without replacement, using a fixed seed for reproducible coverage.
let seed = 0x405000;
for (let index = files.length - 1; index > 0; index--) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const other = Math.floor((seed / 0x100000000) * (index + 1));
  [files[index], files[other]] = [files[other], files[index]];
}

await mkdir(directory, { recursive: true });
const manifest = await Promise.all(
  files.slice(0, 8).map(async (file) => {
    const url = `https://cdn.jsdelivr.net/npm/${file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) {
      throw new Error(`Unable to fetch ${url}: HTTP ${response.status}`);
    }
    const css = await response.text();
    const sha256 = createHash('sha256').update(css).digest('hex');
    if (sha256 !== hashes.get(file)) {
      throw new Error(`Checksum mismatch for ${url}: ${sha256}`);
    }
    const name = file.replaceAll('/', '__');
    await writeFile(new URL(name, directory), css);
    return {
      name,
      url,
      bytes: Buffer.byteLength(css),
      sha256,
    };
  }),
);
await writeFile(
  new URL('manifest.json', directory),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
for (const file of manifest) {
  console.log(`${file.name}: ${file.bytes} bytes, SHA-256 ${file.sha256}`);
}
