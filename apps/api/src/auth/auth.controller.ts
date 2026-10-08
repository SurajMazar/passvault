import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { CurrentAuth, Meta, Public, Reauth, StrictRateLimit, requestMeta } from '../common/decorators';
import { ZodPipe, parseOrThrow } from '../common/zod';
import { E } from '../common/errors';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import { bearerToken } from './auth.guard';
import type { AuthContext, RequestMeta } from './auth.types';
import { z } from 'zod';

const emptyBody = z.strictObject({});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @StrictRateLimit()
  @Post('prelogin')
  @HttpCode(200)
  prelogin(@Body(new ZodPipe(V.preloginRequest)) body: z.output<typeof V.preloginRequest>): Promise<T.PreloginResponse> {
    return this.auth.prelogin(body);
  }

  @Public()
  @StrictRateLimit()
  @Post('register/start')
  @HttpCode(202)
  async registerStart(@Body(new ZodPipe(V.registerStartRequest)) body: z.output<typeof V.registerStartRequest>, @Meta() meta: RequestMeta): Promise<void> {
    await this.auth.registerStart(body, meta);
  }

  @Public()
  @StrictRateLimit()
  @Post('register/verify')
  @HttpCode(200)
  registerVerify(@Body(new ZodPipe(V.registerVerifyRequest)) body: z.output<typeof V.registerVerifyRequest>): Promise<T.RegisterVerifyResponse> {
    return this.auth.registerVerify(body);
  }

  @Public()
  @StrictRateLimit()
  @Post('register')
  @HttpCode(201)
  register(@Body(new ZodPipe(V.registerRequest)) body: z.output<typeof V.registerRequest>, @Meta() meta: RequestMeta): Promise<T.RegisterResponse> {
    return this.auth.register(body, meta);
  }

  @Public()
  @StrictRateLimit()
  @Post('login')
  @HttpCode(200)
  login(@Body(new ZodPipe(V.loginRequest)) body: z.output<typeof V.loginRequest>, @Meta() meta: RequestMeta): Promise<T.LoginResponse> {
    return this.auth.login(body, meta);
  }

  /** pending_enrollment mfaToken in the body, OR an active session with a recent reauth. */
  @Public()
  @StrictRateLimit()
  @Post('mfa/enroll/start')
  @HttpCode(200)
  async enrollStart(@Body(new ZodPipe(V.mfaEnrollStartRequest)) body: z.output<typeof V.mfaEnrollStartRequest>, @Req() req: Request): Promise<T.MfaEnrollStartResponse> {
    if (body.mfaToken) return this.auth.enrollStart({ pendingToken: body.mfaToken });
    return this.auth.enrollStart({ auth: await this.activeWithReauth(req) });
  }

  @Public()
  @StrictRateLimit()
  @Post('mfa/enroll/confirm')
  @HttpCode(200)
  async enrollConfirm(@Body(new ZodPipe(V.mfaEnrollConfirmRequest)) body: z.output<typeof V.mfaEnrollConfirmRequest>, @Req() req: Request): Promise<T.MfaEnrollConfirmResponse> {
    if (body.mfaToken) return this.auth.enrollConfirm(body, {}, requestMeta(req));
    const auth = await this.activeWithReauth(req);
    return this.auth.enrollConfirm(body, { auth }, requestMeta(Object.assign(req, { auth })));
  }

  @Public()
  @StrictRateLimit()
  @Post('mfa/verify')
  @HttpCode(200)
  mfaVerify(@Body(new ZodPipe(V.mfaVerifyRequest)) body: z.output<typeof V.mfaVerifyRequest>, @Meta() meta: RequestMeta): Promise<T.MfaVerifyResponse> {
    return this.auth.mfaVerify(body, meta);
  }

  @StrictRateLimit()
  @Post('reauth')
  @HttpCode(200)
  reauth(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(V.reauthRequest)) body: z.output<typeof V.reauthRequest>, @Meta() meta: RequestMeta): Promise<T.ReauthResponse> {
    return this.auth.reauth(auth, body, meta);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta): Promise<void> {
    parseOrThrow(emptyBody, body);
    await this.auth.logout(auth, meta);
  }

  @Reauth()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentAuth() auth: AuthContext, @Body() body: unknown, @Meta() meta: RequestMeta): Promise<void> {
    parseOrThrow(emptyBody, body);
    await this.auth.logoutAll(auth, meta);
  }

  private async activeWithReauth(req: Request): Promise<AuthContext> {
    const token = bearerToken(req);
    if (!token) throw E.unauthenticated();
    const auth = await this.sessions.resolveActive(token);
    if (!auth.session.reauthUntil || auth.session.reauthUntil <= new Date()) throw E.reauthRequired();
    return auth;
  }
}
