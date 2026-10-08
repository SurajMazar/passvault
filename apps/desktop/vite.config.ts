import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = dirname(fileURLToPath(import.meta.url));
const nlConfig = JSON.parse(readFileSync(resolve(root, 'neutralino.config.json'), 'utf8')) as { port: number };
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

/**
 * Content-Security-Policy for the bundled UI. Only same-origin scripts (the
 * Vite bundle and Neutralino's /__neutralino_globals.js); WebAssembly for
 * libsodium; WebSocket only to the local Neutralino server; HTTPS to the
 * PassVault server the user chose, plain HTTP only to this computer.
 * No frames, plugins or remote content.
 */
export function cspPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    // The user chooses the PassVault server (Settings → Server connection), so any https:// server
    // may be contacted; plain http only on this computer (local development). Never http: in general.
    `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port} https: http://localhost:* http://127.0.0.1:*`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
}

function csp(): Plugin {
  const policy = cspPolicy(nlConfig.port);
  return {
    name: 'pv-desktop-csp',
    transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  return {
    root,
    base: '/',
    plugins: [react(), tailwindcss(), csp()],
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
