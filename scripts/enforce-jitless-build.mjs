import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const files = (await readdir(dist)).filter(name => name.endsWith('.js'));
let removed = 0;

for (const name of files) {
  const filePath = path.join(dist, name);
  const source = await readFile(filePath, 'utf8');
  const next = source.replace(/new Function\((['"])\1\)/gu, () => {
    removed += 1;
    return '(()=>{})';
  });
  if (/new\s+Function\s*\(/u.test(next)) {
    throw new Error(`${name} 仍含动态 Function 构造，拒绝发布`);
  }
  if (next !== source) await writeFile(filePath, next, 'utf8');
}

if (removed === 0) {
  throw new Error('未找到预期的 Zod 空 JIT 探针；依赖或构建格式可能已经变化，请人工复核');
}

console.info(`已移除 ${removed} 处 Zod 空 JIT 探针；运行时统一使用 jitless 校验`);
