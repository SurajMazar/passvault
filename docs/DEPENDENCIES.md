# Dependencies and licenses

All production dependencies use permissive licenses (MIT, ISC, Apache-2.0,
BSD-2/3-Clause, 0BSD, MIT-0; OFL-1.1 for the bundled fonts). The full npm list
is generated in [licenses-npm.md](licenses-npm.md) (202 packages). Regenerate it
and run `pnpm audit --prod` and `govulncheck ./...` before every release.

## Key decisions

| Area | Choice (pinned) | License | Why |
|---|---|---|---|
| Client cryptography | `libsodium-wrappers-sumo` 0.8.4 | ISC | Reviewed, constant-time primitives (Argon2id, XChaCha20-Poly1305, X25519 sealed boxes, Ed25519, BLAKE2b) as WebAssembly; the same code runs in browsers, the MV3 service worker, Node, and the desktop webview. The sumo build is required for Argon2id. |
| Server password hashing | `libsodium-wrappers-sumo` 0.8.4 (`crypto_pwhash_str`) | ISC | Same reviewed Argon2id implementation, no native build step |
| TOTP | `otpauth` 9.5.2 | MIT | Maintained RFC 6238 implementation |
| Validation | `zod` 4.6.5 | MIT | One schema set shared by clients and server |
| Backend | `@nestjs/*` 11.2.x (maintained `legacy` line), `@prisma/client`/`prisma` 6.19.3, PostgreSQL 16 | MIT / Apache-2.0 / PostgreSQL | Stable majors with known decorator/CJS behaviour; Nest 12 and Prisma 7/8 are newer majors with breaking changes and were not needed |
| Logging | `pino` / `nestjs-pino` | MIT | Structured logs with path redaction |
| Email | `nodemailer` | MIT-0 | SMTP with STARTTLS/implicit TLS |
| Rate limiting / jobs | `@nestjs/throttler` 6, `@nestjs/schedule` | MIT | |
| Language | TypeScript 5.9.3 | Apache-2.0 | TypeScript 7 (native port) was not adopted yet because Nest relies on `emitDecoratorMetadata` |
| UI | React 19.3, Tailwind CSS 4.3, Zustand 5, lucide-react 1.52, qrcode 1.5 | MIT / ISC | |
| Fonts | `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono` 5.3.0 | OFL-1.1 | Bundled locally so the strict CSP works in every client |
| Password strength | `@zxcvbn-ts/core` 4.2 (+ language packs) | MIT | Local strength estimation; nothing leaves the device |
| Public suffix list | `tldts` 7.4 | MIT | Correct base-domain matching incl. private suffixes (e.g. `github.io`) |
| Local cache | `idb` 8.0 | ISC | Small IndexedDB wrapper |
| Build | Vite 7.3, `@vitejs/plugin-react` 5.2, vitest 3.2, tsx 4.20 | MIT | Vite 8 (Rolldown) was not needed |
| Terminal | `@xterm/xterm` 6, `@xterm/addon-fit`, `@xterm/addon-web-links` | MIT | Maintained terminal renderer; no clipboard (OSC 52) addon loaded |
| Desktop shell | Neutralinojs (server + `@neutralinojs/lib` 6.x, `neu` CLI 11) | MIT | Required by the brief; small, no Node runtime in the app |
| Desktop helper (Go 1.25) | `golang.org/x/crypto` v0.55.0 (`ssh`, `ssh/agent`), `golang.org/x/sys` v0.47.0, `github.com/coder/websocket` v1.8.14 | BSD-3-Clause / BSD-3-Clause / ISC | Established SSH client + agent protocol; x/crypto pinned at v0.55 because later releases require Go 1.26 |
| Edge proxy | Caddy 2.10 (container image) | Apache-2.0 | Automatic TLS and simple header configuration |
| Containers | Podman (compose via `podman compose`/`podman-compose`) | Apache-2.0 | Requested runtime; Docker also works |
| EFF large wordlist (passphrases) | embedded data | CC BY 3.0 | Attribution in `packages/crypto/src/wordlist.ts` |
| Video tooling (dev only, `tests/e2e-video`) | `playwright` 1.64, `kokoro-js` 1.2.1 (Kokoro-82M ONNX model), ffmpeg (system) | Apache-2.0 / Apache-2.0 / LGPL/GPL (not redistributed) | Generates the product videos; never part of any shipped client |

## Supply-chain practices

- Exact versions are pinned in `package.json` files and `pnpm-lock.yaml`;
  `go.sum` pins Go modules. CI installs with `--frozen-lockfile`.
- `pnpm.onlyBuiltDependencies` limits which packages may run install scripts.
- Clients load no third-party scripts at runtime; fonts and WASM are bundled.
- Remaining work (see SECURITY_REVIEW.md): pin GitHub Actions by commit SHA,
  generate an SBOM (e.g. `syft`) per release, sign container images (cosign).
