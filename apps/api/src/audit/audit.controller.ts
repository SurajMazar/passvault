import { Controller, Get, Query } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { CurrentAuth } from '../common/decorators';
import { parseOrThrow } from '../common/zod';
import type { AuthContext } from '../auth/auth.types';
import { AuditService } from './audit.service';

@Controller('audit-events')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query() query: unknown): Promise<T.Page<T.AuditEventDto>> {
    const q = parseOrThrow(V.pageQuery, query);
    return this.audit.list(auth.user.id, q.cursor ? BigInt(q.cursor) : null, Math.min(q.limit ?? 100, 500));
  }
}
