/**
 * Dev runner — starts the NestJS server (via tsx) and the Vite frontend in
 * parallel so a single `npm run dev` brings up the full stack.
 *
 * tsx transpiles the TypeScript source on-the-fly without a separate build
 * step. server/tsconfig.json is passed explicitly so the server compiles as
 * CommonJS (required by NestJS decorators) rather than inheriting the root
 * tsconfig, which targets ESM for the Vite frontend.
 */
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

const children = [
  spawn(
    'npx',
    ['tsx', 'watch', '--tsconfig', 'server/tsconfig.json', 'server/src/main.ts', ...args],
    { stdio: 'inherit' },
  ),
  spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit' }),
];

const shutdown = (code = 0) => {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
};

for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
