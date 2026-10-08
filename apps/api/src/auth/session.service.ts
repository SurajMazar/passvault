import { Inject, Injectable } from '@nestjs/common';
import type { Device, Session, SessionState, User } from '@prisma/client';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { PrismaService, type Tx } from '../prisma/prisma.service';
import { addMinutes, ipPrefix, randomToken, sha256Hex, truncate } from '../common/util';
import { E } from '../common/errors';
import type { AuthContext, RequestMeta } from './auth.types';

export const PENDING_TTL_MINUTES = 10;
export const MAX_MFA_ATTEMPTS = 5;
export const REAUTH_WINDOW_MINUTES = 5;
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Opaque bearer sessions: 32 random bytes (base64url); only SHA-256(token) is
 * stored. Every request looks the session up in the database, so revocation is
 * immediate.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  hashToken(token: string): string {
    return sha256Hex(token);
  }

  async create(
    tx: Tx | PrismaService,
    p: { userId: string; deviceId: string; state: SessionState; meta: RequestMeta },
  ): Promise<{ token: string; session: Session }> {
    const now = new Date();
    const token = randomToken(32);
    let expiresAt: Date;
    let idleExpiresAt: Date;
    if (p.state === 'active') {
      expiresAt = addMinutes(now, this.cfg.SESSION_TTL_HOURS * 60);
      idleExpiresAt = new Date(Math.min(expiresAt.getTime(), addMinutes(now, this.cfg.SESSION_IDLE_MINUTES).getTime()));
    } else {
      expiresAt = idleExpiresAt = addMinutes(now, PENDING_TTL_MINUTES);
    }
    const session = await tx.session.create({
      data: {
        userId: p.userId,
        deviceId: p.deviceId,
        tokenHash: this.hashToken(token),
        state: p.state,
        createdAt: now,
        lastSeenAt: now,
        expiresAt,
        idleExpiresAt,
        ipPrefix: ipPrefix(p.meta.ip),
        userAgent: truncate(p.meta.userAgent, 200),
      },
    });
    return { token, session };
  }

  private isLive(s: Session, now: Date): boolean {
    return !s.revokedAt && s.expiresAt > now && s.idleExpiresAt > now;
  }

  /** Bearer token -> active session (or 401). Slides the idle timeout. */
  async resolveActive(token: string): Promise<AuthContext> {
    const now = new Date();
    const s = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true, device: true },
    });
    if (!s || s.state !== 'active' || !this.isLive(s, now)) throw E.unauthenticated('Session is invalid or expired');
    if (now.getTime() - s.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      const idleExpiresAt = new Date(Math.min(s.expiresAt.getTime(), addMinutes(now, this.cfg.SESSION_IDLE_MINUTES).getTime()));
      await this.prisma.$transaction([
        this.prisma.session.updateMany({ where: { id: s.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } }),
        this.prisma.device.update({ where: { id: s.deviceId }, data: { lastSeenAt: now } }),
      ]);
      s.lastSeenAt = now;
      s.idleExpiresAt = idleExpiresAt;
    }
    const { user, device, ...session } = s;
    return { session, user, device };
  }

  /** mfaToken -> pending session of the given state (or 401). */
  async resolvePending(token: string, state: 'pending_mfa' | 'pending_enrollment'): Promise<Session & { user: User; device: Device }> {
    const s = await this.prisma.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      include: { user: true, device: true },
    });
    if (!s || s.state !== state || !this.isLive(s, new Date())) {
      throw E.unauthenticated('The sign-in attempt expired; please sign in again');
    }
    if (s.mfaAttempts >= MAX_MFA_ATTEMPTS) {
      await this.revoke({ id: s.id }, 'mfa_attempts_exceeded');
      throw E.unauthenticated('Too many attempts; please sign in again');
    }
    return s;
  }

  /** Count a failed MFA attempt on a pending token; revokes it at the limit. */
  async failPendingAttempt(sessionId: string): Promise<number> {
    const s = await this.prisma.session.update({ where: { id: sessionId }, data: { mfaAttempts: { increment: 1 } } });
    if (s.mfaAttempts >= MAX_MFA_ATTEMPTS) await this.revoke({ id: sessionId }, 'mfa_attempts_exceeded');
    return MAX_MFA_ATTEMPTS - s.mfaAttempts;
  }

  async revoke(where: { id?: string; userId?: string; deviceId?: string; NOT?: { id: string } }, reason: string, tx?: Tx): Promise<number> {
    const r = await (tx ?? this.prisma).session.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: reason },
    });
    return r.count;
  }

  async setReauth(sessionId: string): Promise<Date> {
    const until = addMinutes(new Date(), REAUTH_WINDOW_MINUTES);
    await this.prisma.session.update({ where: { id: sessionId }, data: { reauthUntil: until } });
    return until;
  }
}
