import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Production Content-Security-Policy (dev server needs inline styles for HMR). */
function csp(apiUrl: string): Plugin {
  const api = new URL(apiUrl).origin;
  const policy = [
    "default-src 'self'",
    // libsodium is WebAssembly; 'wasm-unsafe-eval' allows compiling it without allowing JS eval.
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' ${api}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    name: 'pv-csp',
    apply: 'build',
    transformIndexHtml: (html) => html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';
  return {
    plugins: [react(), tailwindcss(), csp(apiUrl)],
    server: { port: 5173, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
  };
});
