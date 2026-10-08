/**
 * Wire types for the pv-helper IPC (docs/DESKTOP_IPC.md + the contract
 * deviations listed in docs/DESKTOP_HELPER.md).
 */

export const HELPER_EXTENSION_ID = 'io.passvault.helper';
export const REQUEST_EVENT = 'pv.request';
export const RESPONSE_EVENT = 'pv.response';
export const EVENT_EVENT = 'pv.event';

export type HelperErrorCode =
  | 'bad_request'
  | 'unknown_op'
  | 'invalid_session'
  | 'not_found'
  | 'unavailable'
  | 'denied'
  | 'host_key_unknown'
  | 'host_key_mismatch'
  | 'auth_failed'
  | 'connect_failed'
  | 'io_error'
  | 'internal'
  // client-side codes
  | 'timeout'
  | 'helper_unavailable';

export interface RequestEnvelope {
  v: 1;
  id: string;
  sessionId?: string;
  op: string;
  params: object;
}

export type ResponseEnvelope =
  | { v: 1; id: string; ok: true; result: unknown }
  | { v: 1; id: string; ok: false; error: { code: string; message: string } };

export interface EventEnvelope {
  v: 1;
  sessionId: string;
  type: string;
  data: unknown;
}

export interface HostKey {
  keyType: string;
  /** base64 of the SSH wire encoding */
  publicKey: string;
}

export interface HopPublic {
  host: string;
  port: number;
  username: string;
}

export type HopAuthMethod = 'password' | 'key' | 'agent' | 'keyboard_interactive';

export interface Hop extends HopPublic {
  auth: { method: HopAuthMethod; password?: string; privateKey?: string; passphrase?: string };
  trustedHostKeys: HostKey[];
}

export interface HelloResult {
  sessionId: string;
  helperVersion: string;
  capabilities: {
    keychain: boolean;
    biometrics: { available: boolean; reason: string };
    agent: boolean;
    terminal: boolean;
    links?: boolean;
    /** net.inspectTls: certificate diagnosis for the server connection test */
    tlsInspect?: boolean;
    systemEvents: boolean;
  };
}

export interface AgentKeyInfo {
  keyId: string;
  name: string;
  fingerprint: string;
}

export interface AgentStatus {
  running: boolean;
  socketPath: string;
  locked: boolean;
  keys: AgentKeyInfo[] | null;
}

export type SshStateName = 'connecting' | 'verifying_host' | 'authenticating' | 'connected' | 'closed' | 'error';

export interface SshStateEvent {
  connId: string;
  state: SshStateName;
  message?: string;
  code?: string;
}

export interface HostKeyEvent {
  connId?: string;
  hop: 'jump' | 'target';
  hostPort: string;
  keyType: string;
  publicKey: string;
  fingerprint: string;
  status: 'unknown' | 'mismatch';
  trusted: string[] | null;
}

export interface PromptEvent {
  connId: string;
  promptId: string;
  hop: 'jump' | 'target';
  name: string;
  instruction: string;
  questions: Array<{ text: string; echo: boolean }>;
}

export interface DataEvent {
  connId: string;
  dataB64: string;
}

export interface ExitEvent {
  connId: string;
  exitStatus?: number;
  signal?: string;
}

export interface SignRequestEvent {
  requestId: string;
  keyId: string;
  keyName: string;
  fingerprint: string;
  client: { pid?: number; processName?: string; processPath?: string };
  destination: { verified: boolean; hostKeyFingerprint?: string; note: string };
  forwarded: boolean;
}

export interface SystemEvent {
  type: 'screen_locked' | 'screen_unlocked' | 'will_sleep' | 'did_wake';
}

export interface SshTestResult {
  ok: boolean;
  stage: 'connect' | 'host_key' | 'auth' | 'done';
  message: string;
  hostKey?: HostKeyEvent;
}

export interface HelperEventMap {
  'ssh.state': SshStateEvent;
  'ssh.hostKey': HostKeyEvent;
  'ssh.prompt': PromptEvent;
  'ssh.data': DataEvent;
  'ssh.exit': ExitEvent;
  'agent.signRequest': SignRequestEvent;
  'agent.state': { running: boolean; locked: boolean };
  'system.event': SystemEvent;
  'helper.error': { message: string };
}

export type HelperEventType = keyof HelperEventMap;
