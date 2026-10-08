/**
 * Narration for the full-feature tour. `title`/`sub` are the on-screen
 * caption; `say` is spoken by Kokoro TTS. Each chapter stays on screen at
 * least as long as its narration.
 */
export interface Chapter {
  id: string;
  title: string;
  sub?: string;
  say: string;
}

export const CHAPTERS: Chapter[] = [
  { id: 'intro', title: 'PassVault', say: 'This is PassVault, an end-to-end encrypted password and developer secrets manager, with a web dashboard, a browser extension, and a Mac app. Everything you are about to see is real software, running against a local server, with dummy data.' },

  // ---------------- account
  { id: 'register-email', title: 'Create an account', sub: 'The email is verified before anything is created', say: 'Creating an account starts with the email address. PassVault sends a six digit code, and no account exists until that code is confirmed.' },
  { id: 'register-password', title: 'Choose a master password', sub: 'It never leaves this device', say: 'Next comes the master password. It never leaves this device. A key derived from it with Argon two I D encrypts the vault locally, so the server can neither read nor reset it.' },
  { id: 'recovery-key', title: 'Vault recovery key — shown once', sub: 'The only way back in if the master password is forgotten', say: 'PassVault then shows a one time recovery key. It is the only way back into the vault if the master password is ever forgotten, so you confirm that you saved it.' },
  { id: 'mfa', title: 'Two-step verification is mandatory', sub: 'Any authenticator app works', say: 'Two step verification is mandatory. Scan the code with any authenticator app, and enter the six digit code it shows.' },
  { id: 'recovery-codes', title: 'One-time recovery codes', sub: 'Restore account access — they cannot decrypt the vault', say: 'You also get ten one time recovery codes. They restore account access if you lose your phone, but they can never decrypt the vault.' },

  // ---------------- vault basics
  { id: 'overview', title: 'The vault overview', sub: 'Counts, recent changes, invitations, sync and security insights', say: 'This is the overview: item counts, recent changes, pending invitations and sync status, plus security insights that are computed entirely on this device.' },
  { id: 'login-item', title: 'Website logins', sub: 'Masked secrets, auto-clearing clipboard, per-URL match rules', say: 'Website logins store a username, a password, and one or more web addresses, each with an explicit matching rule. Secrets stay masked until you reveal them, and copied secrets are cleared from the clipboard automatically.' },
  { id: 'create-login', title: 'Create a login', sub: 'Generator, local strength meter, exact-host matching by default', say: 'When you create a login, the built in generator fills a strong password, the strength meter rates it locally, and the address matching rule defaults to the exact host.' },
  { id: 'ssh-server', title: 'SSH servers', sub: 'Developer secrets are first-class — no website URL needed', say: 'Developer secrets are first class. An SSH server stores the host, port, username and authentication method. No website address is needed, and it can be marked as production.' },
  { id: 'ssh-key', title: 'SSH keys', sub: 'Public key, encrypted private key, passphrase, fingerprint', say: 'SSH keys keep the public key, the encrypted private key, its passphrase and its fingerprint. Server profiles can reference them.' },
  { id: 'database', title: 'Database credentials', sub: 'Engine, host, database, user, password, TLS mode', say: 'Database credentials capture the engine, host, database name, user, password and T L S mode. A full connection string is treated as a secret too.' },
  { id: 'api-credential', title: 'API credentials', sub: 'Tokens and client secrets, with expiry dates and secret custom fields', say: 'A P I credentials hold tokens or client secrets, with an optional expiry date, and secret custom fields stay masked like any other secret.' },
  { id: 'secure-note', title: 'Secure notes', sub: 'Encrypted plain text — markup is never executed', say: 'Secure notes are encrypted plain text. Any markup is always shown as text, and never executed.' },

  // ---------------- organising
  { id: 'search', title: 'Local search, filters and sorting', sub: 'Never over secret values — nothing is sent to the server', say: 'Search runs locally, over titles, usernames, hosts, tags, and even environment variable names. It never searches secret values, and nothing is sent to the server. You can also filter by category, environment or tag, and sort by name or by last change.' },
  { id: 'palette', title: '⌘K command palette', sub: 'Every item, view and action from the keyboard', say: 'The command palette, opened with command K, jumps to any item, view or action from the keyboard.' },
  { id: 'favorites', title: 'Favorites, archive and trash', sub: 'Restore in one click — permanent deletion asks first', say: 'Mark favorites for quick access, archive what you no longer use, and move items to the trash. Restoring is one click, and permanent deletion asks for confirmation and syncs everywhere.' },
  { id: 'bulk', title: 'Bulk actions', sub: 'Favorite, tag, archive or move many items at once', say: 'Select several items to favorite, tag, archive, or move them into a project in a single step.' },
  { id: 'projects', title: 'Projects and environments', sub: 'Development, Staging, Production and custom environments', say: 'Projects group secrets by environment: development, staging, production, and any custom environment you add. Production is always highlighted.' },
  { id: 'env-compare', title: 'Compare environments', sub: 'Added, removed and changed names — values stay masked', say: 'Compare environment files side by side. You see which variable names were added, removed or changed, while every value stays masked until you reveal it.' },
  { id: 'env-edit', title: 'Structured .env editing', sub: 'Only the edited line changes — notes live outside the file', say: 'Environment files are edited structurally. Change one variable, and only that line is rewritten. Comments, ordering and quoting are preserved exactly, and per variable notes live outside the file.' },
  { id: 'env-raw', title: 'Raw view and deliberate export', sub: 'Nothing is executed or interpolated', say: 'Raw mode shows the exact file. Nothing is ever executed or interpolated. Downloading a production file is a deliberate plain text export that needs typed confirmation.' },
  { id: 'history', title: 'Encrypted version history', sub: 'Compare and restore — nothing is overwritten', say: 'Every change is kept in encrypted version history. Compare any revision, and restore it as a new version. Nothing is ever silently overwritten.' },
  { id: 'generator', title: 'Password generator', sub: 'Random passwords or diceware passphrases', say: 'The generator creates random passwords or diceware passphrases, and shows their estimated strength in bits.' },

  // ---------------- teams
  { id: 'share', title: 'End-to-end encrypted sharing', sub: 'Verify the fingerprint · viewer, editor or owner · expiry · resharing', say: 'Sharing is end to end encrypted. PassVault looks up the recipient’s public keys and shows a fingerprint to compare out of band. You choose viewer, editor or owner, an optional expiry date, and whether editors may share further.' },
  { id: 'share-confirm', title: 'Extra confirmation for Production', sub: 'Recipients can copy what they can view', say: 'Production secrets need an extra typed confirmation, because recipients can copy anything they are allowed to see.' },
  { id: 'collaborate', title: 'Collaborating', sub: 'Bob accepted on his own device and edited a shared item', say: 'Bob accepted the invitation on his own device and edited a shared item. His change arrives encrypted, and is decrypted here.' },
  { id: 'conflict', title: 'Offline edits and conflicts', sub: 'Keep mine · keep theirs · keep both — never silently overwritten', say: 'Edits made offline are queued. If someone else changed the same item in the meantime, PassVault detects the conflict, and lets you keep your version, theirs, or both.' },
  { id: 'invitation', title: 'Shared with me', sub: 'Check the sender’s fingerprint before accepting', say: 'When someone shares with you, the invitation appears under shared with me, with the sender’s fingerprint, before you accept it.' },
  { id: 'revoke', title: 'Revoking access', sub: 'Key rotation + re-encryption · rotate the real secrets', say: 'Removing a member rotates the vault key and re encrypts every shared item, so keys they kept cannot read future changes. PassVault also reminds you to rotate the real passwords and tokens, because copies cannot be erased.' },

  // ---------------- settings
  { id: 'settings-security', title: 'Security insights', sub: 'Weak, reused, expiring and non-HTTPS credentials', say: 'Security and settings starts with the full insights report: weak, reused, and expiring credentials, and logins without H T T P S.' },
  { id: 'settings-account', title: 'Account security', sub: 'Master password, key rotation, recovery codes, authenticator', say: 'Account settings change the master password, rotate the account key, regenerate recovery codes, or replace the authenticator. Each one requires re authentication.' },
  { id: 'settings-sessions', title: 'Sessions and devices', sub: 'Revoke sessions, forget devices, remove trust', say: 'Sessions and devices shows where you are signed in. Revoke a session, forget a device, or remove its trusted status.' },
  { id: 'settings-sharing', title: 'Fingerprints and contacts', sub: 'A changed key blocks sharing until re-verified', say: 'Your own sharing fingerprint and your verified contacts live here. If a contact’s key changes, sharing is blocked until you verify it again.' },
  { id: 'settings-prefs', title: 'Preferences and themes', sub: 'Inactivity lock · clipboard clearing · light and dark', say: 'Preferences set the inactivity lock and how quickly copied secrets are cleared. Light and dark themes are built in.' },
  { id: 'settings-activity', title: 'Sync and activity', sub: 'Pending changes and server-observed security events', say: 'Sync status lists anything pending or failed, and the activity log shows the security events the server observed: sign ins, two step verification, sharing and revocations.' },
  { id: 'settings-export', title: 'Export and privacy', sub: 'Local decryption · plaintext warnings · what the server can see', say: 'Exports are decrypted locally, with a clear warning that the file contains plain text secrets. This page also lists exactly what the server can, and cannot, see.' },
  { id: 'lock', title: 'Lock', sub: 'Keys and decrypted data are wiped from memory', say: 'Locking wipes keys and decrypted data from memory: manually, after inactivity, or when the Mac locks. Unlocking happens locally, even offline.' },

  // ---------------- extension
  { id: 'extension', title: 'Browser extension: offer to save', sub: 'Opt-in · isolated from the page · nothing saved without your click', say: 'In the browser extension, PassVault can offer to save a password right after you sign in to a site. It is opt in, the prompt is isolated from the page, and nothing is saved without your click. The extension also fills logins, only on matching sites, and only when you ask.' },

  // ---------------- desktop
  { id: 'desktop-server', title: 'macOS app: choose a server', sub: 'Production or local development — each fully isolated', say: 'The Mac app runs the same vault, with native extras. You can switch between the production server and local development, and each keeps its own sign in and encrypted cache.' },
  { id: 'desktop-signin', title: 'New device sign-in', sub: 'Two-step verification again on a new device', say: 'Signing in on a new device asks for the authenticator code again.' },
  { id: 'desktop-ssh', title: 'Verify the server’s identity', sub: 'First connection shows the host key · a changed key is blocked', say: 'Connect opens an embedded terminal. The first connection shows the server’s host key fingerprint, so you can verify it before trusting it. A changed key is always blocked.' },
  { id: 'desktop-terminal', title: 'Embedded terminal', sub: 'Production sessions stand out · output is treated as untrusted', say: 'Production sessions are clearly marked. Terminal output is treated as untrusted: links ask before opening, and multi line pastes need confirmation, because they would run immediately.' },
  { id: 'desktop-kbd', title: 'Interactive server prompts', sub: 'Each prompt shown as-is — the stored password is never assumed', say: 'Servers that ask interactive questions, like a one time code, show each prompt as is. PassVault never assumes the stored password is the answer.' },
  { id: 'desktop-keys', title: 'SSH keys and the agent', sub: 'Generate keys natively · every signature needs approval', say: 'The Mac app generates SSH keys natively, and its built in SSH agent lets your usual terminal use vault keys. Every signature needs your approval, agent forwarding is refused, and locking the vault removes the keys.' },
  { id: 'desktop-lock', title: 'Lock closes app sessions', sub: 'Externally launched sessions are not affected', say: 'Locking the vault disconnects every session the app manages.' },

  // ---------------- recovery + outro
  { id: 'recovery', title: 'Account recovery', sub: 'Email link + authenticator + recovery key', say: 'Finally, recovery. If the master password is forgotten, an emailed link, the authenticator, and the recovery key restore the vault and set a new password. Without the recovery key, nobody can recover the data.' },
  { id: 'outro', title: 'PassVault', say: 'That is PassVault: end to end encrypted logins and developer secrets, across the web, the browser, and the Mac.' },
];
