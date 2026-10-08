import { Controller, Get, Query } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { CurrentAuth, StrictRateLimit } from '../common/decorators';
import { parseOrThrow } from '../common/zod';
import { E } from '../common/errors';
import { EmailLimiter } from '../common/email-limiter.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthContext } from '../auth/auth.types';

@Controller('users')
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: EmailLimiter,
  ) {}

  /** Exact-match recipient lookup (verified users only). Rate-limited per IP and per caller. */
  @StrictRateLimit()
  @Get('lookup')
  async lookup(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<T.UserLookupResponse> {
    const q = parseOrThrow(V.userLookupQuery, query);
    this.limiter.hit('lookup', auth.user.id, 60);
    const u = await this.prisma.user.findUnique({ where: { email: q.email } });
    if (!u || !u.emailVerifiedAt) throw E.notFound('No verified user with that email address');
    return {
      userId: u.id,
      email: u.email,
      name: u.name,
      publicEncryptionKey: u.publicEncryptionKey,
      publicSigningKey: u.publicSigningKey,
      publicKeySignature: u.publicKeySignature,
    };
  }
}
