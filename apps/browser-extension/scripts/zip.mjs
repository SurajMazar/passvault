// Packages dist/ into passvault-extension-<version>.zip (store upload / distribution).
// Uses Info-ZIP `zip` (preinstalled on macOS and GitHub's Ubuntu runners) so the
// archive has Unix permissions and directory entries — macOS Archive Utility
// rejects bare MS-DOS-attribute archives. Fixed mtimes + sorted input + -X keep
// the output reproducible.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, rmSync, utimesSync, chmodSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json not found — run `pnpm build` first.');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));

const FIXED_TIME = new Date('2020-01-01T00:00:00Z');
const entries = [];
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    const isDir = statSync(p).isDirectory();
    chmodSync(p, isDir ? 0o755 : 0o644);
    utimesSync(p, FIXED_TIME, FIXED_TIME);
    entries.push(isDir ? `${relative(dist, p)}/` : relative(dist, p));
    if (isDir) walk(p);
  }
};
walk(dist);

const outFile = join(root, `passvault-extension-${version}.zip`);
rmSync(outFile, { force: true });
// TZ=UTC: zip stores local DOS time, so pin the zone for identical bytes everywhere.
execFileSync('zip', ['-X', '-9', '-q', '-@', outFile], {
  cwd: dist,
  input: entries.join('\n'),
  env: { ...process.env, TZ: 'UTC' },
  stdio: ['pipe', 'inherit', 'inherit'],
});
console.log(`${relative(root, outFile)} (${entries.filter((e) => !e.endsWith('/')).length} files)`);
