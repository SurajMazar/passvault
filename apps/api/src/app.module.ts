import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { APP_CONFIG, type AppConfig } from './config/config';
import { buildLoggerParams } from './logging/logger';
import { STRICT_RATE_LIMIT } from './common/decorators';
import { ApiExceptionFilter } from './common/exception.filter';
import { EmailLimiter } from './common/email-limiter.service';
import { PrismaService } from './prisma/prisma.service';
import { MailService } from './mail/mail.service';
import { PasswordHasher } from './security/password-hasher.service';
import { SecretsService } from './security/secrets.service';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { SessionService } from './auth/session.service';
import { MfaService } from './auth/mfa.service';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { AccountController } from './account/account.controller';
import { RecoveryService } from './recovery/recovery.service';
import { RecoveryController } from './recovery/recovery.controller';
import { UsersController } from './users/users.controller';
import { AccessService } from './vaults/access.service';
import { VaultsService } from './vaults/vaults.service';
import { VaultsController } from './vaults/vaults.controller';
import { RecordsService } from './records/records.service';
import { RecordsController } from './records/records.controller';
import { SyncController } from './sync/sync.controller';
import { HealthController } from './health/health.controller';
import { JobsService } from './jobs/jobs.service';

export interface AppModuleOptions {
  /** capture structured logs (tests) */
  logStream?: DestinationStream;
}

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig, opts: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot(buildLoggerParams(cfg, opts.logStream)),
        ThrottlerModule.forRoot({
          throttlers: [
            { name: 'global', ttl: 60_000, limit: cfg.RATE_LIMIT_GLOBAL_PER_MINUTE },
            {
              name: 'strict',
              ttl: 60_000,
              limit: cfg.RATE_LIMIT_AUTH_PER_MINUTE,
              skipIf: (ctx) =>
                !(Reflect.getMetadata(STRICT_RATE_LIMIT, ctx.getHandler()) || Reflect.getMetadata(STRICT_RATE_LIMIT, ctx.getClass())),
            },
          ],
        }),
        ScheduleModule.forRoot(),
      ],
      controllers: [
        HealthController,
        AuthController,
        AccountController,
        RecoveryController,
        UsersController,
        VaultsController,
        RecordsController,
        SyncController,
        AuditController,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: cfg },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthGuard },
        PrismaService,
        MailService,
        PasswordHasher,
        SecretsService,
        EmailLimiter,
        AuditService,
        SessionService,
        MfaService,
        AuthService,
        RecoveryService,
        AccessService,
        VaultsService,
        RecordsService,
        JobsService,
      ],
    };
  }
}
