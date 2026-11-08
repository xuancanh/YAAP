/**
 * Service routes (docs/services.md), under the workspace's company:
 *
 *  GET    /api/workspaces/:id/org/services                          the catalog with metrics, the open and recent requests
 *  GET    /api/workspaces/:id/org/services/templates                the starter library (with the department each fits)
 *  GET    /api/workspaces/:id/org/services/:sid                     one service: fields, history, its requests
 *  POST   /api/workspaces/:id/org/services                          { template? | title, fields, …, unitId?, reason } — a new service
 *  PUT    /api/workspaces/:id/org/services/:sid                     { title?, fields?, acceptSlaHours?, …, reason } — a new version
 *  POST   /api/workspaces/:id/org/services/:sid/retire              { reason, restore? }
 *  POST   /api/workspaces/:id/org/services/requests                 { service? | unitId?, title, fields?, why, neededBy?, serves? } — the CEO requests
 *  POST   /api/workspaces/:id/org/services/requests/:rid/respond    { answer, due?, reason?, alternative?, scope?, note?, unitId?, service? }
 *
 * Reads are everyone's in the company; writes are the CEO's or a board
 * member's (a person's change applies at once — the boundary binds agents,
 * which use the tools, org-services.tools.ts).
 */
import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { actorId } from '../accounts/account-context';
import { OrgModeService } from './org-mode.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgServicesService, type OrgServiceRequest } from './org-services.service';
import { slaClock } from './service-model';

export class ServiceWriteDto {
  @IsOptional() @IsString() template?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() fields?: unknown[];
  @IsOptional() @IsString() ownerRole?: string;
  @IsOptional() @IsString() process?: string | null;
  @IsOptional() @IsNumber() acceptSlaHours?: number;
  @IsOptional() @IsNumber() resolveSlaHours?: number;
  @IsOptional() @IsString() unitId?: string | null;
  @IsString() reason!: string;
}
export class ServiceRetireDto {
  @IsString() reason!: string;
  @IsOptional() @IsBoolean() restore?: boolean;
}
export class ServiceRequestDto {
  @IsOptional() @IsString() service?: string;
  @IsOptional() @IsString() unitId?: string;
  @IsString() title!: string;
  @IsOptional() @IsObject() fields?: Record<string, unknown>;
  @IsString() why!: string;
  @IsOptional() @IsString() neededBy?: string;
  @IsOptional() @IsString() serves?: string;
}
export class ServiceRespondDto {
  @IsString() answer!: string;
  @IsOptional() @IsString() due?: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() alternative?: string;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() unitId?: string;
  @IsOptional() @IsString() service?: string;
}

const parse = <T>(raw: string | null | undefined, fallback: T): T => { try { return (JSON.parse(raw || '') as T) ?? fallback; } catch { return fallback; } };

@Controller('workspaces/:id/org/services')
export class ServicesController {
  constructor(
    private readonly mode: OrgModeService,
    private readonly orgs: OrgController,
    private readonly org: OrgService,
    private readonly services: OrgServicesService,
    private readonly config: ConfigService,
  ) {}

  private async oid(workspaceId: string): Promise<string> {
    if (this.config.get<boolean>('companiesEnabled') === false) throw new NotFoundException('organizations are disabled (COMPANIES_ENABLED=false)');
    return this.mode.orgIdOf(workspaceId);
  }

  /** Writes are the CEO's or a board member's. */
  private async writer(orgId: string): Promise<string> {
    const role = await this.org.humanRole(orgId, actorId());
    if (role !== 'ceo' && role !== 'board') throw new ForbiddenException(role === 'observer' ? 'observers can read the company but not change it' : 'only the CEO or a board member changes the service catalog or requests a service here');
    return this.orgs.actorName();
  }

  /** A request for the page: parsed JSON and its live SLA clock. */
  private row(r: OrgServiceRequest) {
    return { ...r, fields: parse<Record<string, string>>(r.fields, {}), thread: parse<unknown[]>(r.thread, []), counter: r.counter ? parse<Record<string, unknown>>(r.counter, {}) : null, clock: slaClock(r, new Date()) };
  }

  @Get() async list(@Param('id') id: string) {
    const orgId = await this.oid(id);
    const recent = await this.services.requests(orgId, { limit: 150 });
    return { services: await this.services.overview(orgId, { includeRetired: true }), requests: recent.map((r) => this.row(r)) };
  }

  @Get('templates') async templates(@Param('id') id: string) {
    return this.services.library(await this.oid(id));
  }

  @Post('requests') async request(@Param('id') id: string, @Body() dto: ServiceRequestDto) {
    const orgId = await this.oid(id);
    const r = await this.services.requestService(orgId, { service: dto.service, unit: dto.unitId, title: dto.title, fields: dto.fields, why: dto.why, neededBy: dto.neededBy ?? null, serves: dto.serves ?? null }, await this.writer(orgId));
    await this.services.settle();
    return { request: this.row(await this.services.request(orgId, r.request.id)), note: r.note };
  }

  @Post('requests/:rid/respond') async respond(@Param('id') id: string, @Param('rid') rid: string, @Body() dto: ServiceRespondDto) {
    const orgId = await this.oid(id);
    const r = await this.services.respond(orgId, rid, { answer: dto.answer, due: dto.due, reason: dto.reason, alternative: dto.alternative, scope: dto.scope, note: dto.note, unit: dto.unitId, service: dto.service }, await this.writer(orgId));
    await this.services.settle();
    return { request: this.row(await this.services.request(orgId, r.request.id)), note: r.note };
  }

  @Get(':sid') async detail(@Param('id') id: string, @Param('sid') sid: string) {
    const orgId = await this.oid(id);
    const s = await this.services.get(orgId, sid);
    const head = (await this.services.overview(orgId, { includeRetired: true })).find((x) => x.id === s.id)!;
    return { service: head, history: parse<unknown[]>(s.history, []), pending: s.pending ? parse<Record<string, unknown>>(s.pending, {}) : null, requests: (await this.services.requests(orgId, { serviceId: s.id, limit: 60 })).map((r) => this.row(r)) };
  }

  @Post() async create(@Param('id') id: string, @Body() dto: ServiceWriteDto) {
    const orgId = await this.oid(id);
    const r = await this.services.author(orgId, { ...dto, unitId: dto.unitId ?? null }, await this.writer(orgId));
    return this.detail(id, r.service.id);
  }

  @Put(':sid') async edit(@Param('id') id: string, @Param('sid') sid: string, @Body() dto: ServiceWriteDto) {
    const orgId = await this.oid(id);
    const { template: _t, name: _n, ...rest } = dto; void _t; void _n;
    const r = await this.services.author(orgId, { ...rest, service: sid }, await this.writer(orgId));
    return this.detail(id, r.service.id);
  }

  @Post(':sid/retire') async retire(@Param('id') id: string, @Param('sid') sid: string, @Body() dto: ServiceRetireDto) {
    const orgId = await this.oid(id);
    await this.services.retire(orgId, sid, dto.reason, await this.writer(orgId), { restore: dto.restore });
    return this.detail(id, sid);
  }
}
