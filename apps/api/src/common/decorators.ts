import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext, RequestMeta } from '../auth/auth.types';

export const IS_PUBLIC = 'pv:public';
export const REQUIRES_REAUTH = 'pv:reauth';
export const STRICT_RATE_LIMIT = 'pv:strict-rate-limit';

/** No session required (the handler performs its own checks if any). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Active session with `reauthUntil > now` required. */
export const Reauth = () => SetMetadata(REQUIRES_REAUTH, true);
/** Stricter per-IP throttling (auth, recovery, lookup endpoints). */
export const StrictRateLimit = () => SetMetadata(STRICT_RATE_LIMIT, true);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
  return req.auth!;
});

export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request & { auth?: AuthContext }>();
  return requestMeta(req);
});

export function requestMeta(req: Request & { auth?: AuthContext }): RequestMeta {
  const ua = req.headers['user-agent'];
  return {
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: typeof ua === 'string' ? ua.slice(0, 200) : null,
    deviceId: req.auth?.device.clientDeviceId ?? null,
  };
}
