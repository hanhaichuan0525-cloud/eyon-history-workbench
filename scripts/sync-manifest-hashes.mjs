import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

const artifacts = [
  ['sha256', 'entry'],
  ['genealogySha256', 'genealogyEntry'],
  ['ruinSha256', 'ruinEntry'],
  ['biographySha256', 'biographyEntry'],
  ['timelineSha256', 'timelineEntry'],
  ['workbenchSha256', 'workbenchEntry'],
];

for (const [hashKey, entryKey] of artifacts) {
  const relativePath = manifest[entryKey];
  if (typeof relativePath !== 'string' || !relativePath) {
    throw new Error(`manifest.json 缺少 ${entryKey}`);
  }
  const bytes = await readFile(path.join(root, relativePath));
  manifest[hashKey] = createHash('sha256').update(bytes).digest('hex');
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.info('已同步 manifest.json 的六份生产 bundle 哈希');
