#!/usr/bin/env node
/* 把 src/part1..6.js 合并成 juicemind-ai-assistant.user.js
 *   node scripts/build.mjs             # 写入
 *   node scripts/build.mjs --check     # 只校验是否一致（CI 用），不一致退出码 1
 *   node scripts/build.mjs --bump patch # 升版本号后重建（patch / minor / major）
 *
 * --bump 会同时改三处，避免漏改导致 Tampermonkey 收不到更新：
 *   src/part1.js 的 @version、src/part1.js 的 VERSION 常量、package.json 的 version
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARTS = [1, 2, 3, 4, 5, 6].map((i) => join(ROOT, 'src', `part${i}.js`));
const OUT = join(ROOT, 'juicemind-ai-assistant.user.js');
const SRC1 = join(ROOT, 'src', 'part1.js');
const PKG = join(ROOT, 'package.json');

const args = process.argv.slice(2);
const check = args.includes('--check');
const bumpAt = args.indexOf('--bump');
const bumpKind = bumpAt >= 0 ? args[bumpAt + 1] || 'patch' : null;

function bumpVersion(cur, kind) {
  const m = String(cur).match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`版本号格式不认识：${cur}`);
  let [_, a, b, c] = m.map(Number);
  if (kind === 'major') return `${a + 1}.0.0`;
  if (kind === 'minor') return `${a}.${b + 1}.0`;
  if (kind === 'patch') return `${a}.${b}.${c + 1}`;
  throw new Error(`--bump 只接受 patch / minor / major，收到：${kind}`);
}

/* ---- 升版本号：三处同步改，然后重建 bundle ---- */
if (bumpKind) {
  const src1 = readFileSync(SRC1, 'utf8');
  const cur = (src1.match(/@version\s+([0-9.]+)/) || [])[1];
  if (!cur) throw new Error('src/part1.js 里找不到 @version');
  const next = bumpVersion(cur, bumpKind);

  const nextSrc1 = src1
    .replace(/(@version\s+)[0-9.]+/, `$1${next}`)
    .replace(/(const VERSION\s*=\s*')[^']+(')/, `$1${next}$2`);
  writeFileSync(SRC1, nextSrc1, 'utf8');

  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  pkg.version = next;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

  console.log(`[build] 版本号 ${cur} -> ${next}（@version / VERSION / package.json 已同步）`);
}

/* ---- 合并 ---- */
const bundle = PARTS.map((f) => readFileSync(f, 'utf8')).join('\n');

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
