import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as T from '@passvault/types';
import { APP_CONFIG, type AppConfig } from '../config/config';
import { Public } from '../common/decorators';

/**
 * Server description for clients choosing a server: the API version range,
 * capabilities and whether sign-up is open. Public and credential-free so a
 * client can verify compatibility before it sends anything about the user.
 * Static: no database access, no configuration beyond these fields.
 */
@Controller('meta')
export class MetaController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Public()
  @Get()
  meta(@Res({ passthrough: true }) res: Response): T.MetaResponse {
    res.setHeader('Cache-Control', 'no-store');
    return {
      service: 'passvault',
      version: this.cfg.version,
      api: { current: T.SERVER_API_VERSION.current, min: T.SERVER_API_VERSION.min },
      capabilities: [...T.SERVER_CAPABILITIES],
      registration: this.cfg.REGISTRATION_OPEN ? 'open' : 'closed',
    };
  }
}
