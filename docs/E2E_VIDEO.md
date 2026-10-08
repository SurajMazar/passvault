# End-to-end product walkthrough video

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
