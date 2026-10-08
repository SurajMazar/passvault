import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC, REQUIRES_REAUTH } from '../common/decorators';
import { E } from '../common/errors';
import { SessionService } from './session.service';
import type { AuthContext } from './auth.types';

export function bearerToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(h.trim());
  return m ? m[1]! : null;
}

/** Global guard: every non-@Public route needs an active session (DB lookup on each request). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
    const token = bearerToken(req);
    if (!token) throw E.unauthenticated();
    req.auth = await this.sessions.resolveActive(token);
    if (this.reflector.getAllAndOverride<boolean>(REQUIRES_REAUTH, targets)) {
      const until = req.auth.session.reauthUntil;
      if (!until || until <= new Date()) throw E.reauthRequired();
    }
    return true;
  }
}
