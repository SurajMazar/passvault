import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import * as V from '@passvault/validation';
import type * as T from '@passvault/types';
import { z } from 'zod';
import { CurrentAuth, Meta } from '../common/decorators';
import { ZodPipe, parseOrThrow } from '../common/zod';
import { E } from '../common/errors';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { VaultsService } from './vaults.service';

const emptyBody = z.strictObject({});
export const uuidParam = new ParseUUIDPipe({ exceptionFactory: () => E.notFound() });

@Controller()
export class VaultsController {
  constructor(private readonly vaults: VaultsService) {}

  @Get('vaults')
  async list(@CurrentAuth() auth: AuthContext): Promise<T.VaultMembershipDto[]> {
    return (await this.vaults.liveMemberships(auth.user.id)).dtos;
  }

  @Post('vaults')
  @HttpCode(201)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(V.createSharedVaultRequest)) body: z.output<typeof V.createSharedVaultRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<T.VaultMembershipDto> {
    return this.vaults.create(auth, body, meta);
  }

  @Patch('vaults/:id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(V.updateVaultRequest)) body: z.output<typeof V.updateVaultRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<T.VaultMembershipDto> {
    return this.vaults.update(auth, id, body, meta);
  }

  @Delete('vaults/:id')
  @HttpCode(204)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', uuidParam) id: string, @Meta() meta: RequestMeta): Promise<void> {
    await this.vaults.remove(auth, id, meta);
  }

  @Get('vaults/:id/members')
  members(@CurrentAuth() auth: AuthContext, @Param('id', uuidParam) id: string): Promise<T.VaultMemberDto[]> {
    return this.vaults.members(auth, id);
  }

  @Post('vaults/:id/members')
  @HttpCode(201)
  invite(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(V.inviteMemberRequest)) body: z.output<typeof V.inviteMemberRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<T.VaultMemberDto> {
    return this.vaults.invite(auth, id, body, meta);
  }

  @Patch('vaults/:id/members/:userId')
  updateMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Param('userId', uuidParam) userId: string,
    @Body(new ZodPipe(V.updateMemberRequest)) body: z.output<typeof V.updateMemberRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<T.VaultMemberDto> {
    return this.vaults.updateMember(auth, id, userId, body, meta);
  }

  @Delete('vaults/:id/members/:userId')
  @HttpCode(204)
  async removeMember(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Param('userId', uuidParam) userId: string,
    @Meta() meta: RequestMeta,
  ): Promise<void> {
    await this.vaults.removeMember(auth, id, userId, meta);
  }

  @Post('vaults/:id/rotate')
  @HttpCode(200)
  rotate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuidParam) id: string,
    @Body(new ZodPipe(V.rotateVaultKeyRequest)) body: z.output<typeof V.rotateVaultKeyRequest>,
    @Meta() meta: RequestMeta,
  ): Promise<T.VaultMembershipDto> {
    return this.vaults.rotate(auth, id, body, meta);
  }

  @Get('vaults/:id/records')
  records(@CurrentAuth() auth: AuthContext, @Param('id', uuidParam) id: string, @Query() query: unknown): Promise<T.Page<T.RecordDto>> {
    const q = parseOrThrow(V.pageQuery, query);
    return this.vaults.records(auth, id, BigInt(q.cursor ?? '0'), q.limit ?? 500);
  }

  @Get('invitations')
  invitations(@CurrentAuth() auth: AuthContext): Promise<T.InvitationDto[]> {
    return this.vaults.invitations(auth.user.id);
  }

  @Post('invitations/:vaultId/accept')
  @HttpCode(200)
  accept(@CurrentAuth() auth: AuthContext, @Param('vaultId', uuidParam) vaultId: string, @Body() body: unknown, @Meta() meta: RequestMeta): Promise<T.VaultMembershipDto> {
    parseOrThrow(emptyBody, body);
    return this.vaults.accept(auth, vaultId, meta);
  }

  @Post('invitations/:vaultId/decline')
  @HttpCode(204)
  async decline(@CurrentAuth() auth: AuthContext, @Param('vaultId', uuidParam) vaultId: string, @Body() body: unknown, @Meta() meta: RequestMeta): Promise<void> {
    parseOrThrow(emptyBody, body);
    await this.vaults.decline(auth, vaultId, meta);
  }
}
