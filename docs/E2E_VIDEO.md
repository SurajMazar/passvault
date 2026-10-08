# Product videos

| Video | Length | What it covers |
|---|---|---|
| [`passvault-feature-tour.mp4`](media/passvault-feature-tour.mp4) | 9 min, narrated | **Every feature**, with a Kokoro TTS voice-over: web dashboard, browser-extension save prompt, and the macOS app (server switching, SSH host-key trust, embedded terminal, interactive prompts, SSH keys + agent approval, lock), ending with account recovery |
| [`passvault-walkthrough.mp4`](media/passvault-walkthrough.mp4) | ≈2 min, captions only | Quick end-to-end walkthrough of the web dashboard |

Both are generated, not hand-recorded: Playwright drives the real software
against a real API, and ffmpeg encodes the result. All accounts and values are
dummy data.

## Full-feature tour (narrated)

Source: [`tests/e2e-video/src/tour/`](../tests/e2e-video/src/tour/) —
`narration.ts` (48 chapters: caption + spoken text), `tts.ts` (Kokoro),
`record.ts` (Playwright + ffmpeg).

- **Voice-over:** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)
  (Apache-2.0) via `kokoro-js` (ONNX, runs locally on CPU; the model is
  downloaded from Hugging Face on first use). Voice `af_heart`; override with
  `PV_TTS_VOICE`. Audio is cached per chapter by a hash of the text.
- **Timing:** every chapter is held on screen for at least its narration
  length; `record.ts` logs each chapter's start time and ffmpeg places each
  narration clip there (`adelay` + `amix`, then `loudnorm` to −16 LUFS).
- **Desktop app:** the real Neutralino UI bundle and Go helper run in
  window-less mode (`apps/desktop/scripts/verify-harness.sh cloud`) and are
  driven in the same browser page, against the local test SSH server
  (`apps/desktop/scripts/dev-ssh-server`, 127.0.0.1 only, fake shell).
- **Extension:** the built `save-prompt.js` content script runs on a demo login
  page with Playwright's trusted input, bridged to the real background
  `SavePromptManager`.

### Regenerate the tour

```bash
API_PORT=3000 podman compose up -d
```

```bash
cd apps/web && VITE_API_URL=http://localhost:3000 npx vite build --outDir /tmp/pv-web && npx vite preview --outDir /tmp/pv-web --port 5173
```

```bash
cd apps/desktop/scripts/dev-ssh-server && GOTOOLCHAIN=local go run . -port 2222
```

```bash
cd apps/desktop && VITE_API_URL=https://vault.example.com pnpm build && bash scripts/verify-harness.sh cloud
```

```bash
pnpm --filter @passvault/browser-extension build
```

```bash
ssh-keygen -q -t ed25519 -N '' -C deploy@example.com -f tests/e2e-video/.raw/demo_key
```

```bash
pnpm --filter @passvault/e2e-video tour:tts && pnpm --filter @passvault/e2e-video tour:record
```

The desktop harness uses a one-time Neutralino token, so restart it before each
recording. Wait a minute between back-to-back runs (API auth rate limit).
The recording signs out of the desktop app at the end so its Keychain session
item is removed. If a run fails partway through the desktop chapters, open the
harness once, choose **Sign out**, and delete `pvg_server.neustorage` from
`~/Library/Application Support/io.passvault.desktop.verify/.storage/` so the
next run starts from the server picker.

## Short walkthrough

[`docs/media/passvault-walkthrough.mp4`](media/passvault-walkthrough.mp4) (≈2 min,
1280×800, H.264) is generated — not hand-recorded — by
[`tests/e2e-video/src/record.ts`](../tests/e2e-video/src/record.ts): Playwright
drives the real web dashboard against a real API (Podman stack with Mailpit),
records the browser, and ffmpeg encodes the result. A second user (Bob) runs
headlessly through the same `VaultSession` the clients use, so the sharing
chapter shows a genuine end-to-end-encrypted round trip.

Chapters (captions are rendered in the page):

1. Create an account — email verified with a 6-digit code before anything exists; master password; one-time recovery key
2. Mandatory two-step verification (TOTP) and one-time recovery codes
3. The vault overview and locally computed security insights (demo data)
4. Website logins — reveal on demand, copy with auto-clear
5. Developer secrets — a Production SSH server without any website URL
6. Projects and environments — compare `.env` files with values masked
7. Structured `.env` editing, raw view, encrypted version history and diff
8. ⌘K command palette (local search, never secret values)
9. Sharing a project with a verified recipient (extra confirmation for Production); the recipient accepts and edits
10. Security & settings — sessions/devices, light and dark themes
11. Lock (keys wiped) and local unlock

All accounts and values are dummy data (`example.com` addresses, generated secrets).

## Regenerate

```bash
podman compose up -d
```

```bash
VITE_API_URL=http://localhost:3100 pnpm --filter @passvault/web dev
```

```bash
npx --prefix tests/e2e-video playwright install chromium
```

```bash
WEB_URL=http://localhost:5173 API_URL=http://localhost:3100 MAILPIT_URL=http://localhost:8025 pnpm --filter @passvault/e2e-video record
```

Requires ffmpeg (with libx264) on `PATH`. The API's auth rate limit is 20
requests/minute per IP; wait a minute between back-to-back recordings.

Recording the video also served as an extra end-to-end test: it surfaced two UI
bugs that were then fixed (MFA enrollment could start twice under React
StrictMode and show a stale QR secret; the theme toggle label lagged one render).
