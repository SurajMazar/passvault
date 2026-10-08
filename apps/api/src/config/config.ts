import { z } from 'zod';

/**
 * Startup configuration. Validated once at boot; the process refuses to start
 * with missing or weak secrets. There are deliberately NO default secrets.
 */

const OPSLIMIT_INTERACTIVE = 2;
const MEMLIMIT_INTERACTIVE = 64 * 1024 * 1024;
const MIN_SECRET_BYTES = 32;

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(def);

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const WEAK_MARKERS = ['change', 'example', 'placeholder', 'replace', 'secret', 'password'];

function decodeKeyMaterial(value: string): Buffer | null {
  const v = value.trim();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) || /^[A-Za-z0-9_-]+$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length > 0) return b;
  }
  return null;
}

function strongSecret(name: string) {
  return z
    .string({ error: `${name} is required` })
    .min(1, `${name} is required`)
    .superRefine((v, ctx) => {
      const lower = v.toLowerCase();
      if (Buffer.byteLength(v, 'utf8') < MIN_SECRET_BYTES) {
        ctx.addIssue({ code: 'custom', message: `${name} must be at least ${MIN_SECRET_BYTES} bytes (use: openssl rand -base64 32)` });
      }
      if (WEAK_MARKERS.some((m) => lower.includes(m)) || new Set(v).size < 12) {
        ctx.addIssue({ code: 'custom', message: `${name} looks like a placeholder or low-entropy value; generate a random one` });
      }
    });
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: int(3000, 1, 65535),
    DATABASE_URL: z
      .string({ error: 'DATABASE_URL is required' })
      .regex(/^postgres(ql)?:\/\//, 'DATABASE_URL must be a postgresql:// URL'),
    MFA_ENCRYPTION_KEY: strongSecret('MFA_ENCRYPTION_KEY').superRefine((v, ctx) => {
      const b = decodeKeyMaterial(v);
      if (!b || b.length !== 32) ctx.addIssue({ code: 'custom', message: 'MFA_ENCRYPTION_KEY must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)' });
    }),
    RECOVERY_CODE_PEPPER: strongSecret('RECOVERY_CODE_PEPPER'),
    PRELOGIN_SECRET: strongSecret('PRELOGIN_SECRET'),
    WEB_APP_URL: z.url({ protocol: /^https?$/ }).transform((u) => u.replace(/\/+$/, '')),
    MAIL_TRANSPORT: z.enum(['smtp', 'console', 'memory'], { error: 'MAIL_TRANSPORT must be smtp, console or memory' }),
    /** "false" closes sign-up on this server (existing accounts are unaffected). */
    REGISTRATION_OPEN: z
      .enum(['true', 'false'], { error: 'REGISTRATION_OPEN must be true or false' })
      .default('true')
      .transform((v) => v === 'true'),
    MAIL_FROM: z.string().min(3).default('PassVault <no-reply@passvault.invalid>'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: int(587, 1, 65535),
    SMTP_SECURE: bool(false),
    SMTP_REQUIRE_TLS: bool(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    TRUST_PROXY: z.string().default('false'),
    SESSION_TTL_HOURS: int(720, 1, 24 * 365),
    SESSION_IDLE_MINUTES: int(10080, 5, 60 * 24 * 365),
    RECORD_HISTORY_LIMIT: int(50, 0, 1000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    AUTH_HASH_OPSLIMIT: int(OPSLIMIT_INTERACTIVE, 1, 10),
    AUTH_HASH_MEMLIMIT: int(MEMLIMIT_INTERACTIVE, 8192, 1024 * 1024 * 1024),
    RATE_LIMIT_GLOBAL_PER_MINUTE: int(300, 1),
    RATE_LIMIT_AUTH_PER_MINUTE: int(20, 1),
    RATE_LIMIT_EMAIL_PER_15_MINUTES: int(10, 1),
    LOGIN_LOCKOUT_THRESHOLD: int(10, 3, 1000),
    LOGIN_LOCKOUT_MINUTES: int(15, 1, 24 * 60),
    JOBS_ENABLED: bool(true),
    BODY_LIMIT: z.string().default('3mb'),
  })
  .superRefine((c, ctx) => {
    const isTest = c.NODE_ENV === 'test';
    if (!isTest && c.AUTH_HASH_OPSLIMIT < OPSLIMIT_INTERACTIVE) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_HASH_OPSLIMIT'], message: `must be >= ${OPSLIMIT_INTERACTIVE} outside NODE_ENV=test` });
    }
    if (!isTest && c.AUTH_HASH_MEMLIMIT < MEMLIMIT_INTERACTIVE) {
      ctx.addIssue({ code: 'custom', path: ['AUTH_HASH_MEMLIMIT'], message: `must be >= ${MEMLIMIT_INTERACTIVE} outside NODE_ENV=test` });
    }
    if (c.NODE_ENV === 'production') {
      if (c.MAIL_TRANSPORT !== 'smtp') {
        ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'only smtp is allowed in production' });
      }
      if (!c.WEB_APP_URL.startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: ['WEB_APP_URL'], message: 'must be https:// in production' });
      }
    }
    if (c.MAIL_TRANSPORT === 'memory' && !isTest) {
      ctx.addIssue({ code: 'custom', path: ['MAIL_TRANSPORT'], message: 'memory transport is only for NODE_ENV=test' });
    }
    if (c.MAIL_TRANSPORT === 'smtp' && !c.SMTP_HOST) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_HOST'], message: 'SMTP_HOST is required for MAIL_TRANSPORT=smtp' });
    }
    for (const o of c.CORS_ORIGINS) {
      if (o === '*' || !/^(https?|chrome-extension|moz-extension|safari-web-extension):\/\/[^/\s]+$/.test(o)) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: `invalid origin "${o}" (exact origins only, no wildcards or paths)` });
      }
    }
    const secrets = [c.MFA_ENCRYPTION_KEY, c.RECOVERY_CODE_PEPPER, c.PRELOGIN_SECRET];
    if (new Set(secrets).size !== secrets.length) {
      ctx.addIssue({ code: 'custom', message: 'MFA_ENCRYPTION_KEY, RECOVERY_CODE_PEPPER and PRELOGIN_SECRET must be distinct values' });
    }
  });

export type RawConfig = z.infer<typeof schema>;

export interface AppConfig extends RawConfig {
  mfaKey: Buffer;
  trustProxy: boolean | number | string;
  version: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function parseTrustProxy(v: string): boolean | number | string {
  const t = v.trim().toLowerCase();
  if (t === 'false' || t === '0' || t === '') return false;
  if (t === 'true') return true;
  if (/^\d+$/.test(t)) return Number(t);
  return v.trim();
}

function readVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('../../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) {
    // Never echo values: only variable names and rule messages.
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.') || '(config)'}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const c = r.data;
  return {
    ...c,
    mfaKey: decodeKeyMaterial(c.MFA_ENCRYPTION_KEY)!,
    trustProxy: parseTrustProxy(c.TRUST_PROXY),
    version: readVersion(),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
