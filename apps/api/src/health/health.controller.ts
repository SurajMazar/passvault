import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type * as T from '@passvault/types';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { Public } from '../common/decorators';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Liveness + DB check. Never exposes configuration or secrets. */
  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<T.HealthResponse> {
    let db: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'error';
    }
    res.setHeader('Cache-Control', 'no-store');
    if (db !== 'ok') res.status(503);
    return { status: db === 'ok' ? 'ok' : 'degraded', db, version: this.cfg.version };
  }
}
