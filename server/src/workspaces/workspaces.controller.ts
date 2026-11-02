import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Optional, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { WorkspacesService } from './workspaces.service';
import { StorageService } from '../storage/storage.service';
import { cleanRelativePath, isHiddenPath, workspaceFileKey } from '../storage/storage.keys';
import { WorkspaceFs, type FileMeta } from '../files/workspace-fs.service';
import { fsHttp } from '../files/fs-http';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';
import { TranscriptionService, isAudioUpload } from '../voice/transcription.service';

/** Text previews are capped; the full file remains downloadable. */
const PREVIEW_TEXT_CAP = 200_000;
const PREVIEW_BINARY_CAP = 5_000_000;

/** Content types a browser would execute when navigated to directly —
 *  getFile serves these as attachments instead (preview.util.ts mime table). */
const ACTIVE_CONTENT_TYPES = new Set(['text/html', 'image/svg+xml', 'application/xml']);

class CreateWorkspaceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() color?: string;
}

class UpdateWorkspaceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() memory?: string;
  @IsOptional() @IsString() profile?: string;
  /** Quiet hours JSON (see quiet-hours.ts) or '' to turn them off. */
  @IsOptional() @IsString() quietHours?: string;
  /** Monthly token budget for every agent in the workspace; 0 = unlimited. */
  @IsOptional() @IsInt() @Min(0) spendBudgetTokens?: number;
  /** Heartbeat defaults JSON { cron?, dailyRunCap?, staleMinutes? } (bounded). */
  @IsOptional() @IsString() heartbeatDefaults?: string;
}

class ResolveProposalDto {
  @IsString() proposalId!: string;
}

class PutFileDto {
  @IsString() path!: string;
  /** File content, base64-encoded (works for text and binary alike). */
  @IsString() contentBase64!: string;
  @IsOptional() @IsString() contentType?: string;
  /** Voice notes: recorder-measured length, used when the transcriber reports none. */
  @IsOptional() @IsNumber() @Min(0) durationSeconds?: number;
  /** Optimistic concurrency (docs/filesystem.md): the version the editor
   *  loaded; 0 = must not exist yet. A mismatch is a 409. */
  @IsOptional() @IsInt() @Min(0) expectedVersion?: number;
}

class RestoreFileDto {
  @IsString() path!: string;
  @IsInt() @Min(0) version!: number;
}

class MoveFileDto {
  @IsString() from!: string;
  @IsString() to!: string;
}

/** The `version` / `updatedBy` pair previews and writes report. */
function versionOf(meta: FileMeta | null): { version?: number; updatedBy?: FileMeta['updatedBy']; updatedAt?: string } {
  return meta ? { version: meta.version, updatedBy: meta.updatedBy, updatedAt: meta.updatedAt } : {};
}

/** Text previews and binary inlining, shared with the revision viewer. */
function previewOf(path: string, body: Buffer) {
  const kind = previewKindFor(path);
  const base = { path, kind, size: body.length, contentType: contentTypeFor(path) };
  if (kind === 'markdown' || kind === 'html' || kind === 'text') {
    const text = body.toString('utf8');
    return { ...base, text: text.slice(0, PREVIEW_TEXT_CAP), truncated: text.length > PREVIEW_TEXT_CAP };
  }
  if ((kind === 'image' || kind === 'pdf' || kind === 'audio') && body.length <= PREVIEW_BINARY_CAP) {
    return { ...base, base64: body.toString('base64') };
  }
  return base; // binary or too large: metadata only, use the file endpoint
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly storage: StorageService,
    private readonly voice: TranscriptionService,
    /** Optional so test constructors without it keep working (unversioned). */
    @Optional() fs?: WorkspaceFs,
  ) {
    this.fs = fs ?? new WorkspaceFs(storage);
  }

  private readonly fs: WorkspaceFs;

  @Get() list() { return this.workspaces.list(); }
  @Post() create(@Body() dto: CreateWorkspaceDto) { return this.workspaces.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto) { return this.workspaces.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.workspaces.remove(id); }
  /** This month's spend against the budget (the row carries the raw counter;
   *  this applies the month boundary). */
  @Get(':id/spend') spend(@Param('id') id: string) { return this.workspaces.spend(id); }

  // ---- consented user profile: agents propose, the user decides ----
  @Post(':id/profile/approve')
  approveProposal(@Param('id') id: string, @Body() dto: ResolveProposalDto) {
    return this.workspaces.resolveProfileProposal(id, dto.proposalId, true);
  }

  @Post(':id/profile/reject')
  rejectProposal(@Param('id') id: string, @Body() dto: ResolveProposalDto) {
    return this.workspaces.resolveProfileProposal(id, dto.proposalId, false);
  }

  // ---- the workspace filesystem (docs/filesystem.md "API") ----
  // Paths are workspace-relative; a leading slash is accepted and dropped.

  /** Every file of the tree, with version, last editor and owning agent. */
  @Get(':id/files')
  async listFiles(@Param('id') id: string) {
    await this.workspaces.get(id);
    return this.fs.list(id, '');
  }

  @Post(':id/files')
  async putFile(@Param('id') id: string, @Body() dto: PutFileDto) {
    await this.workspaces.get(id);
    const path = this.path(dto.path);
    const key = this.key(id, path);
    const body = Buffer.from(dto.contentBase64, 'base64');
    // Voice notes (docs/voice.md): bound audio before it touches storage,
    // then transcribe synchronously and keep the transcript as a sidecar.
    const audio = isAudioUpload(path, dto.contentType);
    if (audio) this.voice.assertAudioBounds(path, body, dto.contentType);
    const by = await this.fs.userActor();
    const meta = await fsHttp(() => this.fs.write(id, path, body, { by, contentType: dto.contentType, expectedVersion: dto.expectedVersion }));
    // `version` is the new one (0 only without metadata, in tests).
    if (!audio) return { ok: true, path, ...versionOf(meta) };
    const { transcript, durationHint } = await this.voice.transcribeUpload(key, path, body, dto.contentType, dto.durationSeconds);
    return { ok: true, path, ...versionOf(meta), transcript, durationHint };
  }

  @Get(':id/file')
  async getFile(@Param('id') id: string, @Query('path') path: string, @Res() res: Response) {
    await this.workspaces.get(id);
    const clean = this.path(path ?? '');
    const body = await this.storage.get(this.key(id, clean));
    if (body === null) throw new NotFoundException(`file ${path}`);
    const contentType = contentTypeFor(clean);
    // Agent-written files must never execute on the API/SPA origin: force a
    // download for active content types and stop MIME sniffing for the rest.
    // In-app previews use the JSON /preview endpoint + sandboxed iframes, so
    // nothing legitimate navigates here for rendering.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ACTIVE_CONTENT_TYPES.has(contentType)) {
      res.setHeader('Content-Disposition', 'attachment');
    }
    res.type(contentType).send(body);
  }

  /** Rich preview descriptor: tells the frontend which renderer to use and
   *  carries the content (text inline; images/pdf as base64), plus the
   *  version the editor sends back. HTML must be rendered in a sandboxed,
   *  network-denied iframe (FR-13.1). */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query('path') path: string) {
    await this.workspaces.get(id);
    const clean = this.path(path ?? '');
    this.key(id, clean);
    const file = await this.fs.read(id, clean);
    if (file === null) throw new NotFoundException(`file ${path}`);
    return { ...previewOf(clean, file.body), ...versionOf(file.meta) };
  }

  /** Kept revisions, newest first: `{ version, size, updatedBy, updatedAt }[]`. */
  @Get(':id/file/revisions')
  async revisions(@Param('id') id: string, @Query('path') path: string) {
    await this.workspaces.get(id);
    const clean = this.path(path ?? '');
    this.key(id, clean);
    return this.fs.revisions(id, clean);
  }

  /** One kept revision, as a preview. */
  @Get(':id/file/revision')
  async revision(@Param('id') id: string, @Query('path') path: string, @Query('version') version: string) {
    await this.workspaces.get(id);
    const clean = this.path(path ?? '');
    this.key(id, clean);
    const v = Number(version);
    if (!Number.isInteger(v) || v < 0) throw new BadRequestException('version must be a non-negative integer');
    const body = await this.fs.revision(id, clean, v);
    if (body === null) throw new NotFoundException(`revision ${version} of ${path}`);
    const entry = (await this.fs.revisions(id, clean)).find((r) => r.version === v);
    return { ...previewOf(clean, body), version: v, ...(entry ? { updatedBy: entry.updatedBy, updatedAt: entry.updatedAt } : {}) };
  }

  /** Write a kept revision back as the newest version (undoable itself). */
  @Post(':id/file/restore')
  async restore(@Param('id') id: string, @Body() dto: RestoreFileDto) {
    await this.workspaces.get(id);
    const clean = this.path(dto.path);
    this.key(id, clean);
    const by = await this.fs.userActor();
    const meta = await fsHttp(() => this.fs.restore(id, clean, dto.version, { by }));
    return { ok: true, path: clean, ...versionOf(meta) };
  }

  /** Move or rename a file, or every file under a folder. */
  @Post(':id/file/move')
  async move(@Param('id') id: string, @Body() dto: MoveFileDto) {
    await this.workspaces.get(id);
    const from = this.path(dto.from);
    const to = this.path(dto.to);
    this.key(id, from);
    this.key(id, to);
    const by = await this.fs.userActor();
    const res = await fsHttp(() => this.fs.move(id, from, to, { by }));
    return { ok: true, from, to, moved: res.moved };
  }

  @Delete(':id/file')
  async deleteFile(@Param('id') id: string, @Query('path') path: string) {
    await this.workspaces.get(id);
    const clean = this.path(path ?? '');
    this.key(id, clean);
    const by = await this.fs.userActor();
    await fsHttp(() => this.fs.delete(id, clean, { by }));
    return { ok: true };
  }

  /** Normalize a workspace-relative path (400 on traversal or bookkeeping). */
  private path(path: string): string {
    try {
      const clean = cleanRelativePath(path);
      if (isHiddenPath(clean)) throw new Error(`invalid path: ${path}`);
      return clean;
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }

  private key(id: string, path: string): string {
    try {
      return workspaceFileKey(id, path);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }
}
