#!/usr/bin/env node
/* 把 src/part1..6.js 合并成 juicemind-ai-assistant.user.js
 *   node scripts/build.mjs          # 写入
 *   node scripts/build.mjs --check  # 只校验是否一致（CI 用），不一致退出码 1
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = [1, 2, 3, 4, 5, 6].map((i) => join(ROOT, 'src', `part${i}.js`));
const OUT = join(ROOT, 'juicemind-ai-assistant.user.js');

const bundle = PARTS.map((f) => readFileSync(f, 'utf8')).join('\n');
const check = process.argv.includes('--check');

let current = '';
try {
  current = readFileSync(OUT, 'utf8');
} catch {
  current = '';
}

if (check) {
  if (current !== bundle) {
    console.error('[build] juicemind-ai-assistant.user.js 与 src/ 不一致，请运行 node scripts/build.mjs');
    process.exit(1);
  }
  console.log('[build] bundle 与 src/ 一致 ✓');
  process.exit(0);
}

if (current === bundle) {
  console.log('[build] 无变化');
  process.exit(0);
}
writeFileSync(OUT, bundle, 'utf8');
console.log('[build] 已写入 juicemind-ai-assistant.user.js（' + Buffer.byteLength(bundle) + ' 字节）');
