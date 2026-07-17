import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsOptional, IsString } from 'class-validator';
import { WorkspacesService } from './workspaces.service';
import { StorageService } from '../storage/storage.service';
import { workspaceFileKey, workspacePrefix, relativePath } from '../storage/storage.keys';
import { contentTypeFor, previewKindFor } from '../storage/preview.util';

/** Text previews are capped; the full file remains downloadable. */
const PREVIEW_TEXT_CAP = 200_000;
const PREVIEW_BINARY_CAP = 5_000_000;

class CreateWorkspaceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() color?: string;
}

class UpdateWorkspaceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() memory?: string;
}

class PutFileDto {
  @IsString() path!: string;
  /** File content, base64-encoded (works for text and binary alike). */
  @IsString() contentBase64!: string;
  @IsOptional() @IsString() contentType?: string;
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly storage: StorageService,
  ) {}

  @Get() list() { return this.workspaces.list(); }
  @Post() create(@Body() dto: CreateWorkspaceDto) { return this.workspaces.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto) { return this.workspaces.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.workspaces.remove(id); }

  // ---- workspace files (S3-compatible object storage) ----

  @Get(':id/files')
  async listFiles(@Param('id') id: string) {
    await this.workspaces.get(id);
    const objects = await this.storage.list(workspacePrefix(id));
    return objects.map((o) => ({ path: relativePath(id, o.key), size: o.size, lastModified: o.lastModified }));
  }

  @Post(':id/files')
  async putFile(@Param('id') id: string, @Body() dto: PutFileDto) {
    await this.workspaces.get(id);
    const key = this.key(id, dto.path);
    await this.storage.put(key, Buffer.from(dto.contentBase64, 'base64'), dto.contentType);
    return { ok: true, path: dto.path };
  }

  @Get(':id/file')
  async getFile(@Param('id') id: string, @Query('path') path: string, @Res() res: Response) {
    await this.workspaces.get(id);
    const body = await this.storage.get(this.key(id, path ?? ''));
    if (body === null) throw new NotFoundException(`file ${path}`);
    res.type(contentTypeFor(path ?? '')).send(body);
  }

  /** Rich preview descriptor: tells the frontend which renderer to use and
   *  carries the content (text inline; images/pdf as base64). HTML must be
   *  rendered in a sandboxed, network-denied iframe (FR-13.1). */
  @Get(':id/preview')
  async preview(@Param('id') id: string, @Query('path') path: string) {
    await this.workspaces.get(id);
    const body = await this.storage.get(this.key(id, path ?? ''));
    if (body === null) throw new NotFoundException(`file ${path}`);
    const kind = previewKindFor(path ?? '');
    const base = { path, kind, size: body.length, contentType: contentTypeFor(path ?? '') };
    if (kind === 'markdown' || kind === 'html' || kind === 'text') {
      const text = body.toString('utf8');
      return { ...base, text: text.slice(0, PREVIEW_TEXT_CAP), truncated: text.length > PREVIEW_TEXT_CAP };
    }
    if ((kind === 'image' || kind === 'pdf') && body.length <= PREVIEW_BINARY_CAP) {
      return { ...base, base64: body.toString('base64') };
    }
    return base; // binary or too large: metadata only, use the file endpoint
  }

  @Delete(':id/file')
  async deleteFile(@Param('id') id: string, @Query('path') path: string) {
    await this.workspaces.get(id);
    await this.storage.delete(this.key(id, path ?? ''));
    return { ok: true };
  }

  private key(id: string, path: string): string {
    try {
      return workspaceFileKey(id, path);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid path');
    }
  }
}
