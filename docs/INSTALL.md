# Installing the PassVault apps

Every release on GitHub (Releases → `PassVault vX.Y.Z`) contains:

| File | What it is |
|---|---|
| `PassVault-X.Y.Z-macos-universal.dmg` (or `…-UNSIGNED.dmg`) | macOS app (macOS 14 Sonoma or later; Apple silicon and Intel) |
| `passvault-extension-X.Y.Z.zip` | Chrome / Chromium extension (Manifest V3) |
| `SHA256SUMS.txt` | SHA-256 checksums of every file |

Both apps are built for the production server configured in the repository
(variable `PV_PRODUCTION_URL`) and also offer local development
(`http://localhost:3000`). The browser extension additionally accepts any
https server address (Chrome asks for permission to reach it).

Create your account in the **web dashboard** first (it needs your email for a
verification code and sets up mandatory two-step verification); then sign in
to the apps with the same email and master password.

## 1. Verify the download

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

Every file you downloaded must report `OK`.

## 2. macOS app

1. Open the `.dmg` and drag **PassVault** into **Applications**.
2. Start PassVault from Applications.
   - **Signed releases** (no `UNSIGNED` in the name) are notarized by Apple and open normally.
   - **UNSIGNED releases** are blocked by Gatekeeper the first time. Try to open the
     app once, then go to **System Settings → Privacy & Security**, scroll to
     *"PassVault" was blocked…* and click **Open Anyway** (enter your password). Only do
     this after the checksum matched. Touch ID unlock is unavailable in unsigned builds.
3. The sign-in screen shows **Server · Production**. Use **Change** to switch to local
   development. Sign in with your email, master password and authenticator code.
4. Optional: Settings → Security → *Unlock with Touch ID* (signed builds), Settings →
   SSH agent.

Updating: quit PassVault, replace the app in Applications with the new version. Your
vault stays on the server and in the encrypted local cache.

Uninstalling: delete the app, then optionally `~/Library/Application Support/io.passvault.desktop`.
Keychain items are under "io.passvault.desktop" in Keychain Access.

## 3. Chrome extension

Works in Chrome, Edge, Brave and other Chromium browsers (version 116+).

1. Unzip `passvault-extension-X.Y.Z.zip` into a folder you will keep (for example
   `~/Applications/PassVault Extension`). Chrome loads the extension from that folder;
   do not delete it.
2. Open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**
   (top right), click **Load unpacked** and choose the folder.
3. Pin PassVault (puzzle icon → pin) and click it. The sign-in screen shows the server;
   **Change** lets you pick production, local development, or another https server
   (Chrome then asks for permission to reach that server).
4. Sign in with your email, master password and authenticator code.
5. Optional: Settings → **Offer to save passwords** (Chrome asks for access to all sites;
   only then can PassVault offer to save logins after you sign in to a website).

Updating: unzip the new version over the same folder, then click the **reload** icon on
the PassVault card in `chrome://extensions`.

When the extension is published in the Chrome Web Store, install it from there instead
(updates are then automatic).

## 4. Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach the server" | Check the server address under **Change**, and that `https://<server>/api/v1/health` answers `{"status":"ok"…}` in a browser. |
| No verification email | The server's mail settings (SMTP secrets) are not configured yet — see DEPLOYMENT.md. |
| macOS: "PassVault is damaged and can't be opened" | The download is incomplete or modified: download again and verify the checksum. |
| Extension shows "PassVault is not allowed to connect to …" | Click **Connect** again and accept Chrome's permission prompt. |
