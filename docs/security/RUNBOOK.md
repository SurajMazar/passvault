# Manual verification runbook (macOS)

Some properties need real hardware, a signed build or a person, so the harness
records them as `unverified`. This runbook is how to verify them by hand.
Record the outcome (date, macOS version, build, tester, result) in the release
notes; a step that was not performed stays unverified.

Use a **test account** and synthetic secrets only. Never use your real vault
or `~/.ssh` for these steps.

## Prerequisites

- A Developer ID-signed and notarized build (`scripts/sign-and-notarize.sh`, or a
  release built by `release.yml` with signing secrets), installed in /Applications.
- A Mac with Touch ID, and the local stack (`podman compose up -d`) or staging.
- `security` (built in) to inspect Keychain items.

## Touch ID

Verifies `native.keychain.biometric-runtime`: the stored unlock key is guarded
by the Keychain access control, not only by a UI prompt.

1. Sign in, open **Settings → Security → Unlock with Touch ID**, enable it.
2. `security find-generic-password -s io.passvault.desktop -a "pv.bio.<your user id>"`
   must **not** find it: the item lives in the data-protection keychain (not the
   legacy login keychain), where other apps and the `security` CLI cannot read it.
3. Lock PassVault, choose **Unlock with Touch ID**, cancel the prompt → the vault
   stays locked.
4. Unlock with Touch ID → vault opens.
5. Add a new fingerprint in System Settings → Touch ID, return to PassVault and
   unlock with Touch ID → must **fail** and fall back to the master password
   (`BiometryCurrentSet` invalidates the item when enrolment changes). Disable and
   re-enable Touch ID unlock afterwards.
6. On an unsigned/ad-hoc build, the Touch ID option must be shown as
   unavailable (never a fake success).

## Lock on sleep / screen lock

1. Unlock, open an SSH session (dev server: `apps/desktop/scripts/dev-ssh-server`).
2. Lock the screen (⌃⌘Q) → unlock the Mac → PassVault shows **Vault locked**, the
   terminal shows "Disconnected because the vault locked".
3. Repeat with sleep (Apple menu → Sleep).
4. With the SSH agent enabled: `SSH_AUTH_SOCK=… ssh-add -l` lists no keys while locked.

## Webview isolation (PV-SEC-002, manual spot check)

1. Start the verification harness in window mode:
   `bash apps/desktop/scripts/verify-harness.sh window`.
2. In a test item, put a link `https://example.com/?a=$(touch%20/tmp/pv-pwn)` in a
   note and open it → a confirmation dialog appears; after confirming the
   browser opens the URL and `/tmp/pv-pwn` does **not** exist.
3. `file:///etc/passwd` and `javascript:` links are refused with a message.

## Process arguments and environment

With the signed app running and unlocked:

```bash
ps -axww -o pid=,command= | grep -E 'PassVault|pv-helper'
```

No token, password or key material may appear. The harness checks this
automatically against the verification build (`desktop.runtime.process-args`).

## Desktop export permissions

Export an item (Settings → Export & privacy) to `~/Desktop/pv-export.json`, then
`ls -l ~/Desktop/pv-export.json` → `-rw-------`. Exporting over a symlink must be
refused.
