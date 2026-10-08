import { readFileSync } from 'node:fs';
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

/** Public contact address shown on /support and /privacy (override with VITE_SUPPORT_EMAIL). */
const SUPPORT_EMAIL = 'suraj.mazar@gmail.com';
const PAGES_UPDATED = '8 October 2026';

/**
 * Static information pages (/privacy, /support) required by the Chrome Web
 * Store listing. Plain HTML + one stylesheet, no scripts, emitted as
 * <name>/index.html so the server's try_files serves them at clean URLs.
 */
function infoPages(supportEmail: string): Plugin {
  if (!/^[^\s@<>"'&]+@[^\s@<>"'&]+\.[a-z]{2,}$/i.test(supportEmail)) throw new Error(`VITE_SUPPORT_EMAIL is not a valid address: ${supportEmail}`);
  const mail = `<a href="mailto:${supportEmail}">${supportEmail}</a>`;
  const vars: Record<string, string> = {
    UPDATED: PAGES_UPDATED,
    CONTACT_PRIVACY: `<p>Questions about this policy or requests to access or delete your data: ${mail}.</p>`,
    CONTACT_SUPPORT: `<p>Email ${mail} and describe what you were doing, which app (web, macOS or Chrome extension) and its version. We usually reply within a few days.</p>`,
  };
  const read = (f: string) => readFileSync(new URL(`./pages/${f}`, import.meta.url), 'utf8');
  const fill = (html: string) =>
    html.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => {
      if (!(k in vars)) throw new Error(`unknown page placeholder ${k}`);
      return vars[k]!;
    });
  return {
    name: 'pv-info-pages',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'pages.css', source: read('pages.css') });
      for (const page of ['privacy', 'support']) this.emitFile({ type: 'asset', fileName: `${page}/index.html`, source: fill(read(`${page}.html`)) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const apiUrl = env.VITE_API_URL || 'http://localhost:3000';
  return {
    plugins: [react(), tailwindcss(), csp(apiUrl), infoPages(env.VITE_SUPPORT_EMAIL || SUPPORT_EMAIL)],
    server: { port: 5173, strictPort: true },
    build: { target: 'es2022', sourcemap: false },
  };
});
