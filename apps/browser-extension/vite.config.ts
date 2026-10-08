import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string; description: string };

/**
 * Public half of the extension's signing key. It pins the extension ID
 * (hpnpkdckiinjkfjolbfkhbekeknhmdff) for installs from the release zip, so the
 * macOS app can name it in the Touch ID native-messaging host's allowed_origins.
 * The private half is not needed (and not kept): Chrome only checks the ID.
 * Chrome Web Store uploads must not carry it (scripts/zip.mjs makes a store zip).
 */
export const EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlP/dfeE6MM1S1jNThiIsJI8tUjQFCQn5slEb8x44L5R7ziCrYLPTtV+XmHbBkotOmvehcmWLubnH+/tdwhoSgd8hijx5yqNAs8xPzjdcgyCf6EWXeoRRmoneEIgK94jy64AI3Hf4H70G0hUjYJcVkXGLr3CiRnEROAzJqYN2ApvMkrTJNqlwGBAuCAzEBzYZoHKwzirzBohCXEojIrZfJP3JxarO3chCL084zQ05k27YFWDAPnr1sXzN1CzLhQ1Kb8Cks5KzV0SA6gSme/xeiMQbZXUA/YdZVhv7gwUz7TNTIxS2xkjhkBIKMQ0FoyQ5eyDCq5IuZvVyLvj/iwRsrwIDAQAB';

/**
 * Build manifest.json with minimal permissions. The only host granted at install
 * is the default server (the built-in production server, else local development);
 * other servers the user enters in the popup are granted through Chrome's
 * permission prompt (optional_host_permissions).
 */
export function buildManifest(apiUrl: string) {
  const api = new URL(apiUrl);
  if (api.protocol !== 'https:' && api.protocol !== 'http:') throw new Error('VITE_API_URL must be an http(s) URL');
  return {
    manifest_version: 3,
    name: 'PassVault',
    short_name: 'PassVault',
    version: pkg.version,
    key: EXTENSION_PUBLIC_KEY,
    description: 'End-to-end encrypted password and developer-secrets manager.',
    minimum_chrome_version: '116',
    action: {
      default_title: 'PassVault',
      default_popup: 'popup.html',
      default_icon: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    },
    icons: { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: ['storage', 'alarms', 'activeTab', 'scripting', 'offscreen', 'clipboardWrite'],
    host_permissions: [`${api.origin}/*`],
    // Requested at runtime only: all sites when the user enables "Offer to save passwords",
    // or one origin when the user switches to another server.
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // Requested when the user turns on Touch ID unlock: talks only to PassVault's
    // own macOS host (io.passvault.touchid), registered by the PassVault app.
    optional_permissions: ['nativeMessaging'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } } },
  };
}

/** Same rule as src/background/servers.ts productionUrlFrom (config files cannot import workspace TS). */
function productionOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return null;
    return u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

function manifestPlugin(apiUrl: string): Plugin {
  return {
    name: 'pv-manifest',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify(buildManifest(apiUrl), null, 2)}\n` });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiUrl = productionOrigin(env.VITE_PRODUCTION_URL || env.VITE_API_URL) ?? 'http://localhost:3000';
  return {
    root,
    base: '/',
    plugins: [react(), tailwindcss(), manifestPlugin(apiUrl)],
    build: {
      target: 'es2022',
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: mode === 'development',
      minify: mode !== 'development',
      // No modulepreload polyfill/helpers: the service worker must not contain document code or dynamic imports.
      modulePreload: false,
      // background.js embeds libsodium (WASM inlined): large by design, loaded once per worker start.
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        input: {
          popup: resolve(root, 'popup.html'),
          offscreen: resolve(root, 'offscreen.html'),
          background: resolve(root, 'src/background/index.ts'),
          'save-prompt': resolve(root, 'src/content/save-prompt.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : chunk.name === 'save-prompt' ? 'save-prompt.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
