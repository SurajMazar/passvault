// Dev runner: tsc (emits decorator metadata, which esbuild/tsx cannot) in watch
// mode + `node --watch` restarting the API on every successful compile.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const tsc = 'node_modules/.bin/tsc';
const first = spawnSync(tsc, ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (first.status !== 0) process.exit(first.status ?? 1);

const nodeArgs = ['--watch', '--watch-preserve-output'];
if (existsSync('.env')) nodeArgs.push('--env-file=.env');
const children = [
  spawn(tsc, ['-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(process.execPath, [...nodeArgs, 'dist/main.js'], { stdio: 'inherit' }),
];
const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => code && code !== 0 && stop());
