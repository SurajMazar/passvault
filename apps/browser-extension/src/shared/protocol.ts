import type { ServerProfileView } from '@passvault/ui';
import type { ServerCheck } from '@passvault/vault-core/servers';
import { z } from 'zod';
import type { ItemType, UrlMatchMode } from '@passvault/types';
import { type OFFSCREEN_TARGET } from './constants';

export { OFFSCREEN_TARGET, POPUP_PORT } from './constants';

/**
 * Typed message protocol between extension pages (popup) and the background
 * service worker. Every inbound message is validated with these schemas; the
 * background never trusts the shape of anything it receives.
 *
 * Responses are wrapped in `Result<T>`. Secret values only ever travel to the
 * popup (a trusted extension page), never to content/page contexts.
 */

const tabId = z.int().nonnegative();
const id = z.string().min(1).max(100);
const short = (max = 500) => z.string().max(max);

export const URL_MATCH_SAVE_MODES = ['host', 'base_domain', 'starts_with', 'exact'] as const;

export const requestSchema = z.discriminatedUnion('type', [
  // --- unprivileged (any page of this extension, never tabs) ---
  z.object({ type: z.literal('ping') }).strict(),

  // --- privileged: popup only ---
  z.object({ type: z.literal('state.get') }).strict(),
  z.object({ type: z.literal('auth.login'), email: z.string().min(3).max(320), password: z.string().min(1).max(1024) }).strict(),
  z
    .object({
      type: z.literal('auth.mfaVerify'),
      code: z.string().regex(/^\d{6}$/).optional(),
      recoveryCode: z.string().min(4).max(64).optional(),
      trustDevice: z.boolean(),
    })
    .strict()
    .refine((v) => !!v.code !== !!v.recoveryCode, 'provide a code or a recovery code'),
  z.object({ type: z.literal('auth.mfaEnrollStart') }).strict(),
  z.object({ type: z.literal('auth.mfaEnrollConfirm'), code: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ type: z.literal('auth.ackRecoveryCodes') }).strict(),
  z.object({ type: z.literal('auth.cancel') }).strict(),
  z.object({ type: z.literal('auth.unlock'), password: z.string().min(1).max(1024) }).strict(),
  z.object({ type: z.literal('auth.lock') }).strict(),
  z.object({ type: z.literal('auth.unlockBiometric') }).strict(),
  z.object({ type: z.literal('touchid.status') }).strict(),
  z.object({ type: z.literal('touchid.set'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('auth.logout') }).strict(),
  z.object({ type: z.literal('vault.sync') }).strict(),
  z.object({ type: z.literal('vault.list'), query: short(200).optional(), limit: z.int().min(1).max(500).optional() }).strict(),
  z.object({ type: z.literal('vault.matches'), tabId }).strict(),
  z.object({ type: z.literal('vault.meta') }).strict(),
  z.object({ type: z.literal('item.get'), id }).strict(),
  z.object({ type: z.literal('item.secret'), id, field: z.enum(['username', 'password']) }).strict(),
  z.object({ type: z.literal('autofill.fill'), tabId, itemId: id, confirmInsecure: z.boolean() }).strict(),
  z.object({ type: z.literal('autofill.capture'), tabId }).strict(),
  z
    .object({
      type: z.literal('item.saveLogin'),
      confirmed: z.literal(true),
      draft: z
        .object({
          title: z.string().min(1).max(200),
          username: short(500),
          password: z.string().max(4096),
          url: z.string().min(1).max(2048),
          match: z.enum(URL_MATCH_SAVE_MODES),
          notes: short(10_000),
          folder: short(200),
          tags: z.array(z.string().min(1).max(50)).max(20),
          projectId: id.nullable(),
        })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('item.updatePassword'), confirmed: z.literal(true), id, password: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      type: z.literal('generator.generate'),
      kind: z.enum(['password', 'passphrase']),
      length: z.int().min(8).max(128).optional(),
      symbols: z.boolean().optional(),
      digits: z.boolean().optional(),
      avoidAmbiguous: z.boolean().optional(),
      words: z.int().min(3).max(12).optional(),
      separator: z.enum(['-', '.', '_', ' ']).optional(),
      capitalize: z.boolean().optional(),
      includeNumber: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal('clipboard.scheduleClear') }).strict(),
  z.object({ type: z.literal('autosave.status') }).strict(),
  z.object({ type: z.literal('autosave.set'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('autosave.clearNever') }).strict(),
  z.object({ type: z.literal('inline.set'), enabled: z.boolean() }).strict(),
  // Server connection. The popup requests host access for an address first (Chrome
  // permission prompt). A new address is applied only after a successful
  // compatibility check; a saved server can be switched to offline (cached data).
  z.object({ type: z.literal('server.check'), url: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal('server.set'), url: z.string().min(1).max(2048) }).strict(),
  z.object({ type: z.literal('server.switch'), id: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('server.rename'), id: z.string().min(1).max(200), name: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('server.remove'), id: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('server.localDev'), on: z.boolean() }).strict(),
]);

export type Request = z.infer<typeof requestSchema>;
export type RequestType = Request['type'];

/** Message types any page of this extension may send (no secrets in their responses). */
export const UNPRIVILEGED: ReadonlySet<RequestType> = new Set<RequestType>(['ping']);

export type ErrorCode =
  | 'invalid_message'
  | 'forbidden'
  | 'locked'
  | 'not_found'
  | 'wrong_password'
  | 'network'
  | 'refused'
  | 'conflict'
  | 'bad_state'
  | 'internal';

export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };

// ----------------------------------------------------------------------------
// Response shapes

export type PopupPhase = 'initializing' | 'signed_out' | 'mfa_verify' | 'mfa_enroll' | 'recovery_codes' | 'locked' | 'unlocked';

export interface PopupState {
  phase: PopupPhase;
  email: string | null;
  name: string | null;
  /** only during MFA enrollment (popup only) */
  mfaEnroll?: { secret?: string; otpauthUri?: string };
  /** only in the recovery_codes phase (popup only) */
  recoveryCodes?: string[];
  hasSession: boolean;
  /** locked: Touch ID unlock is set up and usable */
  biometricAvailable?: boolean;
  online: boolean;
  sync: { state: string; lastSyncAt: string | null; lastError: string | null; pending: number; failed: number; conflicts: number };
  lockTimeoutMinutes: number;
  clipboardClearSeconds: number;
  /** changes whenever decrypted data changes; popups refetch lists on change */
  dataVersion: number;
  webUrl: string;
  /** the server this browser is connected to, with the built-in shortcuts */
  server?: ServerInfo;
}

export interface ServerInfo {
  /** base URL of the connected server, e.g. https://vault.example.com or https://example.com/passvault */
  url: string;
  /** explicit local-development setting (http:// allowed for loopback addresses) */
  localDev: boolean;
  /** saved servers, the connected one included (`active`) */
  profiles: ServerProfileView[];
}

/** List row. Never contains secret values. */
export interface ItemSummary {
  id: string;
  type: ItemType;
  title: string;
  subtitle: string;
  environment: string | null;
  favorite: boolean;
  shared: boolean;
  readOnly: boolean;
}

export interface LoginMatch extends ItemSummary {
  username: string;
  hasPassword: boolean;
  insecure: boolean;
  mode: UrlMatchMode;
}

export interface TabInfo {
  /** origin of the active tab, null when not an http(s) page */
  origin: string | null;
  host: string | null;
  /** fill/save is possible on this page */
  eligible: boolean;
  insecure: boolean;
  reason?: string;
}

export interface MatchesResponse {
  tab: TabInfo;
  matches: LoginMatch[];
}

export interface DetailField {
  key: string;
  label: string;
  value: string;
  secret: boolean;
  mono?: boolean;
  multiline?: boolean;
}

export interface ItemDetail extends ItemSummary {
  fields: DetailField[];
  urls: Array<{ url: string; match: UrlMatchMode }>;
  notes: string;
  folder: string;
  tags: string[];
  /** only website logins can be filled into pages */
  fillable: boolean;
}

export type FillCode = 'filled' | 'origin_mismatch' | 'no_password_field' | 'not_top_frame';

export type FillResponse =
  | { status: 'filled'; filledUsername: boolean }
  | { status: 'needs_confirmation'; reason: 'insecure'; origin: string }
  | { status: 'refused'; reason: FillRefusal; message: string };

export type FillRefusal =
  | 'no_tab'
  | 'unsupported_page'
  | 'not_login'
  | 'no_match'
  | 'trashed'
  | 'no_credentials'
  | 'origin_changed'
  | 'origin_mismatch'
  | 'no_password_field'
  | 'injection_failed';

export interface CaptureResponse {
  origin: string;
  url: string;
  host: string;
  insecure: boolean;
  suggestedTitle: string;
  username: string;
  password: string;
  foundPasswordField: boolean;
  /** existing logins for this page with the same username */
  existing: Array<{ id: string; title: string; username: string; passwordDiffers: boolean; readOnly: boolean }>;
}

export interface MetaResponse {
  folders: string[];
  tags: string[];
  projects: Array<{ id: string; name: string }>;
}

export interface GenerateResponse {
  value: string;
  entropyBits: number;
}

export interface ResponseMap {
  ping: { ok: true; version: string };
  'state.get': PopupState;
  'auth.login': PopupState;
  'auth.mfaVerify': PopupState & { remainingRecoveryCodes?: number };
  'auth.mfaEnrollStart': PopupState;
  'auth.mfaEnrollConfirm': PopupState;
  'auth.ackRecoveryCodes': PopupState;
  'auth.cancel': PopupState;
  'auth.unlock': PopupState;
  'auth.lock': PopupState;
  'auth.unlockBiometric': PopupState;
  'touchid.status': TouchIdStatus;
  'touchid.set': TouchIdStatus;
  'auth.logout': PopupState;
  'vault.sync': PopupState;
  'vault.list': { items: ItemSummary[]; total: number };
  'vault.matches': MatchesResponse;
  'vault.meta': MetaResponse;
  'item.get': ItemDetail;
  'item.secret': { value: string };
  'autofill.fill': FillResponse;
  'autofill.capture': CaptureResponse;
  'item.saveLogin': { id: string };
  'item.updatePassword': { id: string };
  'generator.generate': GenerateResponse;
  'clipboard.scheduleClear': { scheduled: boolean; seconds: number };
  'autosave.status': AutoSaveStatus;
  'autosave.set': AutoSaveStatus;
  'autosave.clearNever': AutoSaveStatus;
  'inline.set': AutoSaveStatus;
  'server.check': ServerCheck;
  'server.set': { url: string };
  'server.switch': { url: string };
  'server.rename': { ok: true };
  'server.remove': { ok: true };
  'server.localDev': { localDev: boolean };
}

/** "Offer to save passwords" setting (requires the optional all-sites host permission). */
/** Touch ID unlock through PassVault for Mac (background/touch-id.ts). */
export interface TouchIdStatus {
  /** this Mac can do it right now (host registered, Touch ID enrolled, permission granted) */
  available: boolean;
  /** turned on for this account in this browser */
  enabled: boolean;
  reason?: string;
}

export interface AutoSaveStatus {
  enabled: boolean;
  /** suggestions in login fields (inline menu) */
  inline: boolean;
  permission: boolean;
  neverCount: number;
}

export type RequestOf<T extends RequestType> = Extract<Request, { type: T }>;


export type PortMessageToPopup = { type: 'state'; state: PopupState };
export type PortMessageToBackground = { type: 'keepalive' };

export type OffscreenMessage = { target: typeof OFFSCREEN_TARGET; type: 'clipboard.clear' };
