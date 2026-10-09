import { z } from 'zod';
import {
  API_CREDENTIAL_KINDS,
  CUSTOM_FIELD_TYPES,
  DATABASE_ENGINES,
  ENVIRONMENT_KINDS,
  SSH_AUTH_METHODS,
  TLS_MODES,
  URL_MATCH_MODES,
  type ItemPayload,
  type ProjectPayload,
  type UserSettingsPayload,
} from '@passvault/types';

// ---------- Connection-parameter validators (shared by UI, desktop helper bridge, external terminal) ----------

const HOST_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Accepts compressed IPv6 forms; brackets are not part of the stored value.
const IPV6 = /^(([0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(([0-9A-Fa-f]{1,4}:){0,7}[0-9A-Fa-f]{0,4})?::(([0-9A-Fa-f]{1,4}:){0,7}[0-9A-Fa-f]{0,4})?)$/;

/** Hostname, IPv4, or IPv6. Never begins with '-' (prevents option injection in external tools). */
export function isValidHost(host: string): boolean {
  if (!host || host.length > 253 || host.startsWith('-')) return false;
  if (IPV4.test(host)) return true;
  if (host.includes(':')) return IPV6.test(host);
  const trimmed = host.endsWith('.') ? host.slice(0, -1) : host;
  return trimmed.split('.').every((l) => HOST_LABEL.test(l));
}

/** POSIX-ish account names, plus '@' and '\\'-free domain forms such as user@corp. */
export const USERNAME_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.@+-]{0,99}$/;
export function isValidSshUsername(u: string): boolean {
  return USERNAME_RE.test(u);
}

export function isValidPort(p: unknown): p is number {
  return typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535;
}

export const hostSchema = z.string().trim().refine(isValidHost, 'enter a valid hostname or IP address');
export const portSchema = z.int().min(1).max(65535);
export const sshUsernameSchema = z.string().trim().regex(USERNAME_RE, 'usernames may contain letters, digits, . _ - + @ and must not start with -');

// ---------- Payload schemas ----------
//
// Encrypted payloads are read by every installed version of every client. They are
// loose objects: a field added by a newer client is accepted and kept (and, because
// editors start from the decrypted payload, saved back unchanged), instead of making
// the whole item unreadable in an older app. Known fields are still fully validated.
// Requests to the API (api.ts) stay strict.

const str = (max: number) => z.string().max(max);
const secret = (max = 100_000) => z.string().max(max);

const customField = z.looseObject({
  id: z.string().min(1).max(64),
  label: str(200),
  type: z.enum(CUSTOM_FIELD_TYPES),
  value: secret(),
});

const common = {
  v: z.literal(1),
  title: z.string().trim().min(1, 'title is required').max(300),
  description: str(2000),
  notes: str(100_000),
  folder: str(200),
  tags: z.array(z.string().trim().min(1).max(64)).max(50),
  projectId: z.string().max(64).nullable().optional(),
  environment: z.string().trim().max(64).nullable().optional(),
  favorite: z.boolean(),
  archived: z.boolean(),
  trashedAt: z.string().nullable(),
  customFields: z.array(customField).max(100),
};

const loginUrl = z.looseObject({
  url: z.string().trim().min(1).max(2048),
  match: z.enum(URL_MATCH_MODES),
});

const hostKey = z.looseObject({
  keyType: str(64),
  publicKey: str(4096),
  fingerprint: str(128),
  trustedAt: z.string(),
  hostPort: str(300),
});

export const itemPayloadSchema = z.discriminatedUnion('type', [
  z.looseObject({
    ...common,
    type: z.literal('login'),
    fields: z.looseObject({
      username: str(500),
      password: secret(10_000),
      urls: z.array(loginUrl).max(50),
      passwordUpdatedAt: z.string().optional(),
      passkeys: z
        .array(
          z.looseObject({
            credentialId: z.string().regex(/^[A-Za-z0-9_-]{16,1366}$/),
            rpId: z.string().min(1).max(253),
            rpName: str(200),
            userHandle: z.string().regex(/^[A-Za-z0-9_-]{0,86}$/),
            userName: str(500),
            userDisplayName: str(500),
            alg: z.literal(-7),
            privateKey: z.string().regex(/^[A-Za-z0-9_-]{60,400}$/),
            createdAt: z.string().max(40),
          }),
        )
        .max(20)
        .optional(),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('ssh_connection'),
    fields: z.looseObject({
      host: hostSchema,
      port: portSchema,
      username: sshUsernameSchema,
      authMethod: z.enum(SSH_AUTH_METHODS),
      password: secret(10_000).optional(),
      sshKeyItemId: z.string().max(64).optional(),
      jumpHostItemId: z.string().max(64).optional(),
      hostKeys: z.array(hostKey).max(20),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('ssh_key'),
    fields: z.looseObject({
      publicKey: str(16_384),
      privateKey: secret(32_768),
      passphrase: secret(1024).optional(),
      fingerprint: str(128),
      algorithm: str(64),
      comment: str(500).optional(),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('database'),
    fields: z.looseObject({
      engine: z.enum(DATABASE_ENGINES),
      host: z.string().trim().max(253),
      port: portSchema.optional(),
      database: str(300),
      username: str(300),
      password: secret(10_000),
      tlsMode: z.enum(TLS_MODES),
      caCertificate: str(65_536).optional(),
      connectionString: secret(10_000).optional(),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('api_credential'),
    fields: z.looseObject({
      service: z.string().trim().max(200),
      endpoint: str(2048).optional(),
      kind: z.enum(API_CREDENTIAL_KINDS),
      token: secret(65_536).optional(),
      apiKey: secret(65_536).optional(),
      clientId: str(1000).optional(),
      clientSecret: secret(65_536).optional(),
      username: str(500).optional(),
      password: secret(10_000).optional(),
      expiresAt: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('env_file'),
    fields: z.looseObject({
      filename: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .refine((f) => !f.includes('/') && !f.includes('\\') && f !== '.' && f !== '..', 'filename must not contain path separators'),
      content: secret(1_500_000),
      variableNotes: z.record(z.string().max(256), z.string().max(5000)),
    }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('secure_note'),
    fields: z.looseObject({ content: secret(1_000_000) }),
  }),
  z.looseObject({
    ...common,
    type: z.literal('payment_card'),
    fields: z.looseObject({
      cardholder: str(200),
      number: z.string().regex(/^\d{0,19}$/, 'card number must be up to 19 digits'),
      expMonth: z.string().regex(/^(|0[1-9]|1[0-2])$/, 'expiry month must be 01-12'),
      expYear: z.string().regex(/^(|\d{4})$/, 'expiry year must be four digits'),
      cvv: z.string().regex(/^\d{0,4}$/, 'security code must be 3 or 4 digits'),
      pin: secret(32),
    }),
  }),
]) satisfies z.ZodType<ItemPayload>;

export const projectPayloadSchema = z.looseObject({
  v: z.literal(1),
  name: z.string().trim().min(1).max(200),
  description: str(2000),
  tags: z.array(z.string().trim().min(1).max(64)).max(50),
  favorite: z.boolean(),
  environments: z
    .array(
      z.looseObject({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(64),
        kind: z.enum(ENVIRONMENT_KINDS),
      }),
    )
    .max(50),
  trashedAt: z.string().nullable(),
}) satisfies z.ZodType<ProjectPayload>;

export const userSettingsSchema = z.looseObject({
  v: z.literal(1),
  contacts: z.record(
    z.string(),
    z.looseObject({ email: z.string(), fingerprint: z.string(), publicSigningKey: z.string(), verified: z.boolean(), pinnedAt: z.string() }),
  ),
  sharedFavorites: z.array(z.string()).max(10_000),
  lockTimeoutMinutes: z.int().min(0).max(24 * 60),
  clipboardClearSeconds: z.int().min(0).max(600),
}) satisfies z.ZodType<UserSettingsPayload>;

export function formatZodError(e: z.ZodError): Array<{ path: string; message: string }> {
  return e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}
