#!/usr/bin/env node
/* CI 守卫：bundle 变了但 @version 没变 → 失败。
 *
 * 为什么需要：Tampermonkey 只认 @version。版本号不变，学生端根本不会收到
 * 这次更新，脚本会一直停在旧版本，而仓库里看起来"已经发布了"。
 * 这个坑在本地调试时最容易踩——build.mjs 只做合并，不会自动改版本号。
 *
 * 用法：node scripts/check-version-bump.mjs <base-sha>
 *   base-sha 通常是 ${{ github.event.before }}
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = 'juicemind-ai-assistant.user.js';
const ZERO = '0'.repeat(40);

function versionOf(text) {
  const m = text.match(/@version\s+([0-9.]+)/);
  return m ? m[1] : null;
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

const base = (process.argv[2] || '').trim();

if (!base || base === ZERO) {
  console.log('[check-version] 没有基准提交（首次推送？），跳过');
  process.exit(0);
}

let oldText;
try {
  oldText = git(['show', `${base}:${BUNDLE}`]);
} catch {
  console.log(`[check-version] 基准 ${base.slice(0, 7)} 里没有 ${BUNDLE}，跳过`);
  process.exit(0);
}

const newText = readFileSync(join(ROOT, BUNDLE), 'utf8');

if (oldText === newText) {
  console.log('[check-version] bundle 没变，跳过版本号检查 ✓');
  process.exit(0);
}

const oldV = versionOf(oldText);
const newV = versionOf(newText);

if (!oldV || !newV) {
  console.error('[check-version] 读不到 @version，header 坏了？');
  process.exit(1);
}

if (oldV === newV) {
  console.error(
    `[check-version] bundle 变了但 @version 还是 ${newV} —— Tampermonkey 不会把这个更新推给用户。\n` +
      `             用 node scripts/build.mjs --bump patch 升一次版本号再提交。`
  );
  process.exit(1);
}

console.log(`[check-version] @version ${oldV} -> ${newV} ✓`);
