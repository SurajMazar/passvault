import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = dirname(fileURLToPath(import.meta.url));
const nlConfig = JSON.parse(readFileSync(resolve(root, 'neutralino.config.json'), 'utf8')) as { port: number };
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/**
 * Content-Security-Policy for the bundled UI. Only same-origin scripts (the
 * Vite bundle and Neutralino's /__neutralino_globals.js); WebAssembly for
 * libsodium; WebSocket only to the local Neutralino server; HTTP(S) only to
 * the production PassVault server and the local development API.
 * No frames, plugins or remote content.
 */
export function cspPolicy(apiUrl: string, port: number, productionUrl?: string): string {
  const api = new URL(apiUrl).origin;
  const origins = [api, productionUrl ? new URL(productionUrl).origin : null, 'http://localhost:3000'].filter(Boolean) as string[];
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The user can switch between the production server and local development only.
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port} ${[...new Set(origins)].join(' ')}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function csp(apiUrl: string, productionUrl?: string): Plugin {
  const policy = cspPolicy(apiUrl, nlConfig.port, productionUrl);
  return {
    name: 'pv-desktop-csp',
    transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'VITE_');
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';
  return {
    root,
    base: '/',
    plugins: [react(), tailwindcss(), csp(apiUrl, env.VITE_PRODUCTION_URL || (mode === 'production' ? env.VITE_API_URL : undefined))],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      outDir: resolve(root, 'resources/app'),
      emptyOutDir: true,
      target: 'safari16',
      // No data: URIs for fonts/scripts (CSP); every asset is a same-origin file.
      assetsInlineLimit: 0,
      sourcemap: mode === 'development',
      minify: mode !== 'development',
      chunkSizeWarningLimit: 4000,
    },
  };
});
