/** drizzle/ を dist-server/ にコピーする（本番イメージで migrate するため）。 */

import { cpSync, mkdirSync } from 'node:fs';

mkdirSync('dist-server', { recursive: true });
cpSync('drizzle', 'dist-server/drizzle', { recursive: true });
console.log('dist-server/drizzle をコピーしました');
