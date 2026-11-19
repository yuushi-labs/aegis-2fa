/**
 * server/ を esbuild で dist-server/ にバンドルする。
 * better-sqlite3 はネイティブモジュールなので external にする。
 */

import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist-server', { recursive: true, force: true });

await build({
  entryPoints: ['server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist-server/index.js',
  sourcemap: false,
  minify: false,
  external: ['better-sqlite3'],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('dist-server/index.js を生成しました');
