// Packages dist/ into passvault-extension-<version>.zip (install from the release) and
// passvault-extension-<version>-chrome-web-store.zip (store upload: no manifest key).
// Uses Info-ZIP `zip` (preinstalled on macOS and GitHub's Ubuntu runners) so the
// archive has Unix permissions and directory entries — macOS Archive Utility
// rejects bare MS-DOS-attribute archives. Fixed mtimes + sorted input + -X keep
// the output reproducible.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, rmSync, utimesSync, chmodSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

function zipDir(dir, outFile) {
  const entries = [];
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const isDir = statSync(p).isDirectory();
      chmodSync(p, isDir ? 0o755 : 0o644);
      utimesSync(p, FIXED_TIME, FIXED_TIME);
      entries.push(isDir ? `${relative(dir, p)}/` : relative(dir, p));
      if (isDir) walk(p);
    }
  };
  walk(dir);
  rmSync(outFile, { force: true });
  // TZ=UTC: zip stores local DOS time, so pin the zone for identical bytes everywhere.
  execFileSync('zip', ['-X', '-9', '-q', '-@', outFile], {
    cwd: dir,
    input: entries.join('\n'),
    env: { ...process.env, TZ: 'UTC' },
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.log(`${relative(root, outFile)} (${entries.filter((e) => !e.endsWith('/')).length} files)`);
}

// For installing from the release (unpacked): keeps the manifest key, so the extension ID is fixed.
zipDir(dist, join(root, `passvault-extension-${version}.zip`));

// For the Chrome Web Store, which assigns its own ID and refuses a manifest key.
const store = mkdtempSync(join(tmpdir(), 'pv-ext-store-'));
try {
  cpSync(dist, store, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(store, 'manifest.json'), 'utf8'));
  delete manifest.key;
  writeFileSync(join(store, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  zipDir(store, join(root, `passvault-extension-${version}-chrome-web-store.zip`));
} finally {
  rmSync(store, { recursive: true, force: true });
}
