import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import type { z } from 'zod';
import { Meta, Public, StrictRateLimit } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import type { RequestMeta } from '../auth/auth.types';
import { RecoveryService } from './recovery.service';

@Public()
@StrictRateLimit()
@Controller('recovery')
export class RecoveryController {
  constructor(private readonly recovery: RecoveryService) {}

  @Post('start')
  @HttpCode(202)
  async start(@Body(new ZodPipe(V.recoveryStartRequest)) body: z.output<typeof V.recoveryStartRequest>, @Meta() meta: RequestMeta): Promise<void> {
    await this.recovery.start(body, meta);
  }

  @Post('verify')
  @HttpCode(200)
  verify(@Body(new ZodPipe(V.recoveryVerifyRequest)) body: z.output<typeof V.recoveryVerifyRequest>, @Meta() meta: RequestMeta): Promise<T.RecoveryVerifyResponse> {
    return this.recovery.verify(body, meta);
  }

  @Post('complete-vault')
  @HttpCode(204)
  async completeVault(
    @Body(new ZodPipe(V.recoveryCompleteVaultRequest)) body: z.output<typeof V.recoveryCompleteVaultRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.recovery.completeVault(body, meta);
  }

  @Post('reset-account')
  @HttpCode(204)
  async resetAccount(
    @Body(new ZodPipe(V.recoveryResetAccountRequest)) body: z.output<typeof V.recoveryResetAccountRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.recovery.resetAccount(body, meta);
  }
}
