/**
 * pnpm build:xserver
 *
 * Xserver（共用・PHP 8.3 + SQLite）向けの配信物を組み立てる。
 *
 *   1. Vite で SPA をビルド（base は --base=/zekey/ か VITE_BASE_PATH。既定 /zekey/）
 *   2. deploy/xserver/site/（PHP バックエンド・.htaccess・storage/）を配信物のルートへ複製
 *   3. dist/ の中身を同じルートへ複製
 *   4. package.json のバージョンを app/version.php へ書き出す
 *
 * 出力: deploy/xserver/build/zekey/ ← この中身を public_html/zekey/ へアップロードする。
 * ルート配置（ドメイン直下）にしたい場合は --base=/ を指定する。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'vite';

const root = process.cwd();
const sourceSite = join(root, 'deploy/xserver/site');
const outDir = join(root, 'deploy/xserver/build/zekey');
const baseArg = process.argv.find((arg) => arg.startsWith('--base='));
const rawBase = baseArg === undefined ? process.env.VITE_BASE_PATH ?? '/zekey/' : baseArg.slice('--base='.length);
const base = normalizeBase(rawBase);

function normalizeBase(value) {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.endsWith('/') ? withLeading : `${withLeading}/`;
}

/** ソース中の文字列リテラルを順に取り出す（CSP の突き合わせ用）。 */
function stringLiterals(text) {
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  return [...text.matchAll(pattern)].map((match) => match[1] ?? match[2] ?? '');
}

/** .htaccess / PHP / Node の 3 か所で CSP が食い違っていないか確かめる。 */
function checkContentSecurityPolicy() {
  const htaccess = readFileSync(join(sourceSite, '.htaccess'), 'utf8');
  const htaccessMatch = /Content-Security-Policy "([^"]+)"/.exec(htaccess);
  const php = readFileSync(join(sourceSite, 'app/src/Security.php'), 'utf8');
  const phpConst = /public const CSP =([\s\S]*?);\n/.exec(php);
  if (htaccessMatch === null || phpConst === null) {
    console.warn('警告: CSP の定義を読み取れませんでした（突き合わせを省略）');
    return;
  }
  const phpCsp = stringLiterals(phpConst[1]).join('');

  const nodeSecurity = readFileSync(join(root, 'server/middleware/security.ts'), 'utf8');
  const nodeConst = /CSP_DIRECTIVES = \[([\s\S]*?)\]\.join\('; '\)/.exec(nodeSecurity);
  const nodeCsp = nodeConst === null ? null : stringLiterals(nodeConst[1]).join('; ');

  const failures = [];
  if (htaccessMatch[1] !== phpCsp) failures.push('.htaccess と Security.php');
  if (nodeCsp !== null && nodeCsp !== phpCsp) failures.push('server/middleware/security.ts と Security.php');
  if (failures.length > 0) {
    console.error(`CSP が一致しません: ${failures.join(' / ')}`);
    console.error(`  Node   : ${nodeCsp ?? '(解析できず)'}`);
    console.error(`  PHP    : ${phpCsp}`);
    console.error(`  .htaccess: ${htaccessMatch[1]}`);
    process.exit(1);
  }
  console.log('CSP は Node / PHP / .htaccess で一致しています');
}

function countFiles(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = countFiles(path);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    files += 1;
    bytes += statSync(path).size;
  }
  return { files, bytes };
}

if (!existsSync(sourceSite)) {
  console.error('deploy/xserver/site が見つかりません');
  process.exit(1);
}

checkContentSecurityPolicy();

process.env.VITE_BASE_PATH = base;
await build({ mode: 'production' });

const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html がありません（Vite のビルドに失敗した可能性）');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(sourceSite, outDir, { recursive: true });
cpSync(dist, outDir, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = typeof pkg.version === 'string' ? pkg.version : '1.0.0';
writeFileSync(
  join(outDir, 'app/version.php'),
  [
    '<?php',
    "/**",
    ' * アプリのバージョン（/api/health が返す）。build-xserver.mjs が package.json から生成する。',
    ' */',
    '',
    'declare(strict_types=1);',
    '',
    `return '${version}';`,
    '',
  ].join('\n'),
);

const total = countFiles(outDir);
console.log(`Xserver 用の配信物を ${relative(root, outDir)} に組み立てました`);
console.log(`  base=${base} / ${total.files} files / ${(total.bytes / 1024).toFixed(1)} KiB`);
console.log(`  アップロード: ${relative(root, outDir)}/ の中身を public_html${base === '/' ? '' : base.slice(0, -1)}/ へ`);
