import { Body, Controller, Delete, Get, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import type { z } from 'zod';
import { CurrentAuth, Meta } from '../common/decorators';
import { ZodPipe } from '../common/zod';
import { uuidParam } from '../vaults/vaults.controller';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { RecordsService } from './records.service';

@Controller('records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(V.createRecordRequest)) body: z.output<typeof V.createRecordRequest>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<T.RecordDto> {
    const r = await this.records.create(auth, body);
    res.status(r.status);
    return r.body;
  }

  @Get(':id')
  get(@CurrentAuth() auth: AuthContext, @Param('id', uuidParam) id: string): Promise<T.RecordDto> {
    return this.records.get(auth, id);
  }

  @Put(':id')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(V.updateRecordRequest)) body: z.output<typeof V.updateRecordRequest>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<T.RecordDto> {
    const r = await this.records.update(auth, id, body);
    res.status(r.status);
    return r.body;
  }

  @Delete(':id')
  async remove(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(V.deleteRecordRequest)) body: z.output<typeof V.deleteRecordRequest>,
    @Meta() meta: RequestMeta,
    @Res({ passthrough: true }) res: Response,
  ): Promise<T.RecordDto> {
    const r = await this.records.remove(auth, id, body, meta);
    res.status(r.status);
    return r.body;
  }

  @Get(':id/versions')
  versions(@CurrentAuth() auth: AuthContext, @Param('id', uuidParam) id: string): Promise<T.RecordVersionDto[]> {
    return this.records.versions(auth, id);
  }
}
