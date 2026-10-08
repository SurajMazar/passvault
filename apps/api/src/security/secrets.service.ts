import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { hmacSha256 } from '../common/util';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const RECOVERY_CODE_COUNT = 10;
export const TOTP_PERIOD = 30;

/**
 * Server-side secrets that are NOT end-to-end encrypted by design:
 *  - TOTP secrets, encrypted at rest with AES-256-GCM (MFA_ENCRYPTION_KEY);
 *  - MFA recovery codes, stored as HMAC-SHA256(RECOVERY_CODE_PEPPER, code);
 *  - prelogin fake KDF params, derived from HMAC(PRELOGIN_SECRET, email).
 */
@Injectable()
export class SecretsService {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  // ---------- TOTP ----------

  newTotpSecret(): string {
    return new OTPAuth.Secret({ size: 20 }).base32;
  }

  otpauthUri(secretB32: string, email: string): string {
    return this.totp(secretB32, email).toString();
  }

  private totp(secretB32: string, label = 'PassVault'): OTPAuth.TOTP {
    return new OTPAuth.TOTP({
      issuer: 'PassVault',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: TOTP_PERIOD,
      secret: OTPAuth.Secret.fromBase32(secretB32),
    });
  }

  /** Returns the matched time step (window ±1) or null. Replay checks are the caller's job. */
  matchTotp(secretB32: string, code: string, now = Date.now()): bigint | null {
    const delta = this.totp(secretB32).validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) return null;
    return BigInt(Math.floor(now / 1000 / TOTP_PERIOD) + delta);
  }

  encryptMfaSecret(userId: string, secretB32: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.cfg.mfaKey, iv);
    c.setAAD(Buffer.from(`pv:mfa-secret:v1:${userId}`));
    const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
    return `v1.${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
  }

  decryptMfaSecret(userId: string, stored: string): string {
    if (!stored.startsWith('v1.')) throw new Error('unsupported MFA secret format');
    const raw = Buffer.from(stored.slice(3), 'base64url');
    const d = createDecipheriv('aes-256-gcm', this.cfg.mfaKey, raw.subarray(0, 12));
    d.setAAD(Buffer.from(`pv:mfa-secret:v1:${userId}`));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  // ---------- recovery codes ----------

  newRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let n = 0; n < RECOVERY_CODE_COUNT; n++) {
      let s = '';
      for (let i = 0; i < 20; i++) s += B32[randomInt(32)];
      codes.push(s.match(/.{5}/g)!.join('-'));
    }
    return codes;
  }

  static normalizeRecoveryCode(code: string): string {
    return code.trim().toUpperCase().replace(/[-\s]/g, '');
  }

  recoveryCodeHash(code: string): string {
    return hmacSha256(this.cfg.RECOVERY_CODE_PEPPER, `pv:recovery-code:v1:${SecretsService.normalizeRecoveryCode(code)}`).toString('hex');
  }

  // ---------- registration codes ----------

  /** 6-digit numeric code from the CSPRNG (uniform). */
  newRegistrationCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  registrationCodeHash(email: string, code: string): string {
    return hmacSha256(this.cfg.RECOVERY_CODE_PEPPER, `pv:registration-code:v1:${email}:${code}`).toString('hex');
  }

  // ---------- prelogin ----------

  fakeSalt(email: string): string {
    return hmacSha256(this.cfg.PRELOGIN_SECRET, `pv:prelogin:v1:${email}`).subarray(0, 16).toString('base64url');
  }
}
