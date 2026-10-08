import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import sodium from 'libsodium-wrappers-sumo';
import { randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../config/config';

/**
 * Server-side Argon2id (libsodium crypto_pwhash_str) for the client-derived
 * `authKey` and `recoveryAuthKey`. Parameters come from AUTH_HASH_OPSLIMIT /
 * AUTH_HASH_MEMLIMIT (production minimum: OPSLIMIT/MEMLIMIT_INTERACTIVE).
 */
@Injectable()
export class PasswordHasher implements OnModuleInit {
  private dummyHash = '';

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  async onModuleInit(): Promise<void> {
    await sodium.ready;
    // Used to spend comparable time when the account does not exist.
    this.dummyHash = this.hash(randomBytes(32).toString('base64url'));
  }

  hash(secret: string): string {
    return sodium.crypto_pwhash_str(secret, this.cfg.AUTH_HASH_OPSLIMIT, this.cfg.AUTH_HASH_MEMLIMIT);
  }

  verify(hash: string, secret: string): boolean {
    try {
      return sodium.crypto_pwhash_str_verify(hash, secret);
    } catch {
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return sodium.crypto_pwhash_str_needs_rehash(hash, this.cfg.AUTH_HASH_OPSLIMIT, this.cfg.AUTH_HASH_MEMLIMIT);
    } catch {
      return true;
    }
  }

  /** Burn the same CPU/memory as a real verification; always false. */
  verifyDummy(secret: string): false {
    this.verify(this.dummyHash, secret);
    return false;
  }
}
