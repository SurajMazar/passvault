/**
 * Decrypted vault record payloads. These shapes exist only on clients after
 * decryption; the server stores them as opaque ciphertext.
 */

export const ITEM_TYPES = [
  'login',
  'ssh_connection',
  'ssh_key',
  'database',
  'api_credential',
  'env_file',
  'secure_note',
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  login: 'Login',
  ssh_connection: 'Server',
  ssh_key: 'SSH key',
  database: 'Database',
  api_credential: 'API credential',
  env_file: 'Environment file',
  secure_note: 'Secure note',
};

export const STANDARD_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type StandardEnvironment = (typeof STANDARD_ENVIRONMENTS)[number];

export function isProductionEnvironment(env: string | null | undefined): boolean {
  if (!env) return false;
  const e = env.trim().toLowerCase();
  return e === 'production' || e === 'prod';
}

export const CUSTOM_FIELD_TYPES = ['text', 'secret', 'url', 'email', 'number', 'date', 'boolean', 'multiline'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomField {
  id: string;
  label: string;
  type: CustomFieldType;
  value: string;
}

/** URL matching modes for website logins. Default is `host`. */
export const URL_MATCH_MODES = ['base_domain', 'host', 'starts_with', 'exact', 'never'] as const;
export type UrlMatchMode = (typeof URL_MATCH_MODES)[number];

export const URL_MATCH_LABELS: Record<UrlMatchMode, string> = {
  base_domain: 'Base domain (example.com and its subdomains)',
  host: 'Exact host (and port)',
  starts_with: 'URL starts with',
  exact: 'Exact URL',
  never: 'Never match (disable autofill)',
};

export interface LoginUrl {
  url: string;
  match: UrlMatchMode;
}

export interface LoginFields {
  username: string;
  password: string;
  urls: LoginUrl[];
  passwordUpdatedAt?: string;
}

export const SSH_AUTH_METHODS = ['password', 'key', 'agent', 'keyboard_interactive'] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

export interface TrustedHostKey {
  /** e.g. ssh-ed25519 */
  keyType: string;
  /** base64 wire-format public key as in known_hosts */
  publicKey: string;
  /** SHA256:… fingerprint as printed by OpenSSH */
  fingerprint: string;
  trustedAt: string;
  /** host:port the key was observed for */
  hostPort: string;
}

export interface SshConnectionFields {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  /** id of an `ssh_key` item */
  sshKeyItemId?: string;
  /** id of another `ssh_connection` item used as a jump host */
  jumpHostItemId?: string;
  hostKeys: TrustedHostKey[];
}

export const SSH_KEY_ALGORITHMS = ['ed25519', 'ecdsa-p256', 'ecdsa-p384', 'ecdsa-p521', 'rsa'] as const;
export type SshKeyAlgorithm = (typeof SSH_KEY_ALGORITHMS)[number];

export interface SshKeyFields {
  /** OpenSSH authorized_keys format */
  publicKey: string;
  /** OpenSSH or PEM private key text */
  privateKey: string;
  passphrase?: string;
  /** SHA256:… */
  fingerprint: string;
  algorithm: SshKeyAlgorithm | string;
  comment?: string;
}

export const DATABASE_ENGINES = ['postgresql', 'mysql', 'mariadb', 'sqlserver', 'oracle', 'mongodb', 'redis', 'sqlite', 'other'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

export const DATABASE_DEFAULT_PORTS: Partial<Record<DatabaseEngine, number>> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  oracle: 1521,
  mongodb: 27017,
  redis: 6379,
};

export const TLS_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type TlsMode = (typeof TLS_MODES)[number];

export interface DatabaseFields {
  engine: DatabaseEngine;
  host: string;
  port?: number;
  database: string;
  username: string;
  password: string;
  tlsMode: TlsMode;
  caCertificate?: string;
  /** treated as a secret: may embed credentials */
  connectionString?: string;
}

export const API_CREDENTIAL_KINDS = ['token', 'api_key', 'client_credentials', 'basic'] as const;
export type ApiCredentialKind = (typeof API_CREDENTIAL_KINDS)[number];

export interface ApiCredentialFields {
  service: string;
  endpoint?: string;
  kind: ApiCredentialKind;
  token?: string;
  apiKey?: string;
  clientId?: string;
  clientSecret?: string;
  username?: string;
  password?: string;
  /** ISO date (YYYY-MM-DD) */
  expiresAt?: string;
}

export interface EnvFileFields {
  filename: string;
  /** Raw file contents. Always authoritative. */
  content: string;
  /** Per-variable notes, kept outside the file text. */
  variableNotes: Record<string, string>;
}

export interface SecureNoteFields {
  /** Plain text. Rendered as text only, never as HTML. */
  content: string;
}

export interface ItemFieldsByType {
  login: LoginFields;
  ssh_connection: SshConnectionFields;
  ssh_key: SshKeyFields;
  database: DatabaseFields;
  api_credential: ApiCredentialFields;
  env_file: EnvFileFields;
  secure_note: SecureNoteFields;
}

export interface ItemCommon {
  v: 1;
  title: string;
  description: string;
  notes: string;
  /** Free-form category/folder, e.g. "Work/Infra" */
  folder: string;
  tags: string[];
  projectId?: string | null;
  /** development | staging | production | custom name */
  environment?: string | null;
  favorite: boolean;
  archived: boolean;
  /** ISO timestamp when moved to trash; null when active */
  trashedAt: string | null;
  customFields: CustomField[];
}

export type ItemPayload<T extends ItemType = ItemType> = T extends ItemType
  ? ItemCommon & { type: T; fields: ItemFieldsByType[T] }
  : never;

export type LoginItemPayload = ItemPayload<'login'>;

export const ENVIRONMENT_KINDS = ['development', 'staging', 'production', 'custom'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface ProjectEnvironment {
  id: string;
  name: string;
  kind: EnvironmentKind;
}

export interface ProjectPayload {
  v: 1;
  name: string;
  description: string;
  tags: string[];
  favorite: boolean;
  environments: ProjectEnvironment[];
  trashedAt: string | null;
}

/** Per-user encrypted settings (stored under the User Key). */
export interface UserSettingsPayload {
  v: 1;
  /** Pinned public-key fingerprints of other users (TOFU + manual verification). */
  contacts: Record<string, { email: string; fingerprint: string; publicSigningKey: string; verified: boolean; pinnedAt: string }>;
  /** Favorites for items in shared vaults (personal favorites live in the item). */
  sharedFavorites: string[];
  lockTimeoutMinutes: number;
  clipboardClearSeconds: number;
}

export const DEFAULT_USER_SETTINGS: UserSettingsPayload = {
  v: 1,
  contacts: {},
  sharedFavorites: [],
  lockTimeoutMinutes: 15,
  clipboardClearSeconds: 30,
};

/** Which fields of each type are secret (masked by default, never logged). */
export const SECRET_FIELDS: { [K in ItemType]: Array<keyof ItemFieldsByType[K]> } = {
  login: ['password'],
  ssh_connection: ['password'],
  ssh_key: ['privateKey', 'passphrase'],
  database: ['password', 'connectionString'],
  api_credential: ['token', 'apiKey', 'clientSecret', 'password'],
  env_file: ['content'],
  secure_note: ['content'],
};
