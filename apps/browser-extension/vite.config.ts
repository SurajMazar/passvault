import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = import.meta.dirname;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string; description: string };

/** Build manifest.json with the minimal permissions and the configured API host only. */
export function buildManifest(apiUrl: string) {
  const api = new URL(apiUrl);
  if (api.protocol !== 'https:' && api.protocol !== 'http:') throw new Error('VITE_API_URL must be an http(s) URL');
  return {
    manifest_version: 3,
    name: 'PassVault',
    short_name: 'PassVault',
    version: pkg.version,
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
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } } },
  };
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
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';
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
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  };
});
