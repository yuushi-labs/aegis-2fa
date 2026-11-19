/**
 * pnpm dev: Vite dev サーバーと API サーバーを同時に起動する。
 * 片方が落ちたらもう片方も止める。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';

if (!existsSync('./data')) mkdirSync('./data', { recursive: true });

const children = [];

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: false,
  });
  child.on('exit', (code, signal) => {
    // シグナルで終了した場合も非ゼロとして扱い、相方を止める（片方が落ちたら両方止める契約）。
    if (signal !== null) {
      console.log(`[dev] ${name} killed by ${signal}`);
      shutdown(code ?? 1);
      return;
    }
    console.log(`[dev] ${name} exited with code ${code ?? 0}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  PORT: process.env.PORT ?? '3000',
  NODE_ENV: 'development',
});
run('vite', process.execPath, ['./node_modules/vite/bin/vite.js', '--port', '5173'], {});
