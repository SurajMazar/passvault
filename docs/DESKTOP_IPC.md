# Desktop helper IPC contract

The macOS app is a Neutralinojs shell (`apps/desktop`) hosting the shared React
UI. Capabilities Neutralinojs does not provide — Keychain, Touch ID, SSH, PTY
sessions, SSH agent, owner-only file writes, system lock/sleep notifications,
external terminal launch — live in a small Go helper (`native/desktop-helper`,
binary `pv-helper`) that runs as a **Neutralinojs extension**.

## Transport and trust boundary

- Neutralinojs launches `pv-helper` (extension id `io.passvault.helper`) and
  passes `nlPort`, `nlToken`, `nlConnectToken`, `nlExtensionId` on stdin.
- The helper connects to Neutralino's loopback WebSocket using the connect
  token. Neutralino authenticates both the UI (one-time `NL_TOKEN`) and the
  extension; no other process can join without these per-launch tokens.
- UI → helper: `Neutralino.extensions.dispatch('io.passvault.helper', 'pv.request', Request)`.
- Helper → UI: `app.broadcast` with event `pv.response` (replies) or `pv.event`
  (asynchronous events).
- The helper accepts **exactly one UI session** at a time. `hello` creates a new
  session id (random 128-bit) and tears down all resources (SSH connections,
  agent keys, pending prompts) of the previous session. Every other request must
  carry the current `sessionId`; resources (connections, prompts, sign requests)
  are bound to the session that created them.
- There is **no generic command execution**. Each `op` has a fixed parameter
  schema validated by the helper (unknown ops/fields rejected, length limits,
  hostname/port/username validation identical to `packages/validation`).
- Secrets (passwords, private keys, passphrases, keychain values) are passed
  only inside IPC messages, never as process arguments or environment
  variables, and are never logged. The helper log redacts all `params`.

## Envelope

```ts
type Request  = { v: 1; id: string; sessionId?: string; op: string; params: object };
type Response = { v: 1; id: string; ok: true; result: object }
              | { v: 1; id: string; ok: false; error: { code: string; message: string } };
type Event    = { v: 1; sessionId: string; type: string; data: object };
```

Error codes: `bad_request`, `unknown_op`, `invalid_session`, `not_found`,
`unavailable`, `denied`, `host_key_unknown`, `host_key_mismatch`,
`auth_failed`, `connect_failed`, `io_error`, `internal`.

## Operations

| op | params | result | notes |
|---|---|---|---|
| `hello` | `{ clientVersion }` | `{ sessionId, helperVersion, capabilities: { keychain, biometrics: {available, reason}, agent, terminal, systemEvents } }` | starts a session |
| `ping` | `{}` | `{ now }` | |
| `vault.locked` | `{}` | `{ closedConnections, agentKeysRemoved }` | disconnects app-managed SSH sessions, clears agent keys, cancels prompts |
| `keychain.set` | `{ account, secretB64, biometric }` | `{}` | service fixed to `io.passvault.desktop`; `account` matches `^pv\.[a-z0-9._-]{1,64}$`. `biometric: true` uses `kSecAccessControlBiometryCurrentSet` in the data-protection keychain (requires signed build + entitlement) |
| `keychain.get` | `{ account, reason }` | `{ secretB64 }` | biometric items trigger the system Touch ID prompt; denial → `denied` |
| `keychain.delete` | `{ account }` | `{}` | |
| `biometric.status` | `{}` | `{ available, reason }` | |
| `ssh.connect` | `{ connId, label, target: Hop, jump?: Hop, cols, rows }` | `{ connId }` | async: progress via events |
| `ssh.hostKeyDecision` | `{ connId, hop, trust }` | `{}` | answer to `ssh.hostKey` event (only for `status: unknown`) |
| `ssh.promptResponse` | `{ connId, promptId, answers?: string[], cancel?: boolean }` | `{}` | answer to keyboard-interactive prompt |
| `ssh.write` | `{ connId, dataB64 }` | `{}` | |
| `ssh.resize` | `{ connId, cols, rows }` | `{}` | sends `window-change` |
| `ssh.disconnect` | `{ connId }` | `{}` | |
| `ssh.test` | `{ target: Hop, jump?: Hop }` | `{ ok, stage, message, hostKey? }` | connection validation without a shell; host-key rules identical |
| `ssh.keygen` | `{ algorithm: 'ed25519'\|'ecdsa-p256'\|'rsa-3072'\|'rsa-4096', comment, passphrase? }` | `{ publicKey, privateKey, fingerprint, algorithm }` | uses Go `crypto/*` + `x/crypto/ssh` marshalling |
| `ssh.inspectKey` | `{ privateKey?, publicKey?, passphrase? }` | `{ publicKey, fingerprint, algorithm, encrypted, comment }` | validates imports |
| `agent.status` | `{}` | `{ running, socketPath, locked, keys: [{keyId, name, fingerprint}] }` | |
| `agent.start` / `agent.stop` | `{}` | `{ socketPath }` / `{}` | socket in `~/Library/Application Support/PassVault/agent/agent.sock`, dir 0700, socket 0600 |
| `agent.addKey` | `{ keyId, name, privateKey, passphrase? }` | `{ fingerprint }` | key held in helper memory only |
| `agent.removeKey` | `{ keyId }` | `{}` | |
| `agent.signDecision` | `{ requestId, decision: 'deny'\|'once'\|'timed', minutes? }` | `{}` | `timed` ≤ 60 minutes, per key |
| `term.openExternal` | `{ app: 'terminal'\|'iterm', target: HopPublic, jump?: HopPublic, trustedHostKeys: HostKey[], useAgent }` | `{}` | writes a 0700 `.command` script containing only validated, shell-quoted, non-secret arguments and a per-connection `known_hosts` file; never passwords |
| `fs.writeExport` | `{ path, contentB64, overwrite }` | `{ path, mode: '0600' }` | absolute path, regular file, `O_NOFOLLOW`; refuses to replace unless `overwrite` |
| `fs.readImport` | `{ path, maxBytes }` | `{ contentB64, size }` | regular files ≤ 5 MiB |

```ts
type HostKey = { keyType: string; publicKey: string /* base64 wire */ };
type HopPublic = { host: string; port: number; username: string };
type Hop = HopPublic & {
  auth: { method: 'password' | 'key' | 'agent' | 'keyboard_interactive';
          password?: string; privateKey?: string; passphrase?: string };
  trustedHostKeys: HostKey[];
};
```

## Events

| type | data |
|---|---|
| `ssh.state` | `{ connId, state: 'connecting'\|'verifying_host'\|'authenticating'\|'connected'\|'closed'\|'error', message? }` |
| `ssh.hostKey` | `{ connId, hop: 'jump'\|'target', hostPort, keyType, publicKey, fingerprint, status: 'unknown'\|'mismatch', trusted: HostKey fingerprints[] }` — `mismatch` is terminal: the connection is closed and cannot be overridden from the prompt |
| `ssh.prompt` | `{ connId, promptId, hop, name, instruction, questions: [{ text, echo }] }` |
| `ssh.data` | `{ connId, dataB64 }` |
| `ssh.exit` | `{ connId, exitStatus?, signal? }` |
| `agent.signRequest` | `{ requestId, keyId, keyName, fingerprint, client: { pid?, processName? }, destination: { verified: false, note } \| { verified: true, hostKeyFingerprint }, forwarded }` |
| `agent.state` | `{ running, locked }` |
| `system.event` | `{ type: 'screen_locked'\|'screen_unlocked'\|'will_sleep'\|'did_wake' }` |
| `helper.error` | `{ message }` |

## Lifecycle and cleanup

- On `vault.locked`, `hello` (new session), Neutralino `windowClose`, or loss of
  the WebSocket, the helper closes all SSH sessions, zeroes in-memory key
  material it controls, removes agent keys, and (on exit) removes the agent
  socket. It exits when its parent connection closes so it cannot be orphaned.
- Each SSH session runs remote commands only via an interactive shell request
  (`pty-req` + `shell`). Saved commands are never executed automatically.
- The helper never disables host-key verification. Unknown keys require an
  explicit `ssh.hostKeyDecision`; changed keys abort the connection.
