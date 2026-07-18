/**
 * Dev runner — brings up the full stack with a single `npm run dev`:
 *   1. tsc --watch compiles the NestJS server to server/dist (CommonJS),
 *   2. node --watch runs the compiled server and restarts on recompiles,
 *   3. vite serves the frontend.
 *
 * The server must run from compiled output, not an on-the-fly transpiler:
 * Nest constructor injection needs emitDecoratorMetadata, which esbuild-based
 * loaders (tsx) do not support — under tsx every injected dependency arrives
 * as undefined at runtime.
 */
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

console.log('[dev] building server…');
const build = spawnSync('npx', ['tsc', '-p', 'server/tsconfig.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const children = [
  spawn('npx', ['tsc', '-p', 'server/tsconfig.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn('node', ['--watch', 'server/dist/main.js', ...args], { stdio: 'inherit' }),
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
