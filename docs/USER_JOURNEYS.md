# Main user journeys

Each journey maps to the acceptance scenarios in the product brief. Automated
coverage is listed in [STATUS.md](STATUS.md); `scripts/acceptance` runs the
API-level parts end-to-end with two users.

## 1. Register, verify, enroll MFA, unlock
1. Web → **Create account**: name, email, master password (≥12 chars, strength
   meter). Keys are generated locally (Argon2id, User Key, X25519/Ed25519, personal
   vault key).
2. The **vault recovery key** is shown once; the user must retype its last group
   and confirm they stored it.
3. Verification email contains a link only (no secrets) → `?verify=` deep link.
4. **Sign in** → server requires TOTP enrollment → QR code → 6-digit code →
   **10 one-time recovery codes** shown → vault opens (already unlocked locally).

## 2. Save a website login
New → Login: title, username, password (generator), URLs with explicit match
rule (default *exact host*), notes, tags, category, optional project/environment.

## 3. Autofill with the extension
Open the popup on the site → "On this site" lists matching logins → **Fill**
(user-initiated; top frame; origin re-checked in the page) or copy. HTTP pages
need confirmation; non-matching sites only offer copy.

## 4. Save SSH, database, and API credentials
New → Server / Database / API credential. No URL is required. Hosts, ports and
usernames are validated; SSH items reference an SSH-key item and optional jump
host.

## 5. Project with Development and Production `.env` files
Projects → New project (Development/Staging/Production + custom) → Add
environment file → paste or **Import file…** → stored verbatim; parser notes
show unsupported lines without changing them.

## 6. Edit, compare, restore, export
Variables tab → reveal/copy one value, edit a value (only that line changes),
add notes per variable → **Compare environments** (names + status, values masked)
→ **Version history** → compare/restore a revision (creates a new revision) →
**Download** (plaintext warning, typed confirmation for production, owner-only
permissions on macOS).

## 7. Install the macOS app and sync
Install the signed `.app` → sign in (MFA) → encrypted items sync; the cache
supports offline unlock.

## 8. Import an SSH key and create a server profile
SSH keys → New → paste private key (fingerprint/public key derived by the
helper) or **Generate** (Ed25519) → New server referencing the key.

## 9. Verify host fingerprint and connect
Server → **Connect** → unknown host: fingerprint dialog, explicit **Trust** →
saved into the item → embedded terminal tab (destination, user, environment,
state; Production tabs are visually distinct). Changed host keys are blocked.

## 10. External terminal with the SSH agent
Settings → SSH agent → enable for a key → Server → **Open in Terminal** →
`ssh` uses the PassVault agent socket → each signature needs approval (once or
for N minutes). Agent forwarding is refused.

## 11. Share with editing permissions
Item or project → **Share** → recipient lookup, fingerprint comparison, role
(viewer/editor/owner), optional expiry, resharing toggle, extra confirmation for
Production/private keys → recipient accepts in **Shared with me** → editors can
edit, viewers cannot (server-enforced).

## 12. Revoke and rotate
Manage access → remove member → vault key rotated and items re-encrypted →
guidance to rotate the underlying secrets; audit log entry.

## 13. Lock
Lock button / ⇧⌘L / inactivity / macOS screen lock or sleep → decrypted state
cleared, terminal sessions disconnected, agent keys removed. Externally launched
sessions keep running (documented).

## 14. Offline edit and conflict
Edit while offline → queued → another device edits the same item → reconnect →
**conflict** banner → compare → keep mine / theirs / both.
