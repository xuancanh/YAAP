import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { AgentTypesService } from './agent-types.service';

class CreateAgentTypeDto {
  @IsString() name!: string;
  @IsString() provider!: string;
  @IsString() model!: string;
  @IsOptional() @IsArray() models?: string[];
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() persona?: string;
  /** { cheap?, standard?, strong? }: designated model per tier, from the type's models. */
  @IsOptional() @IsObject() tierModels?: Record<string, string | null>;
  /** '' (the workspace's) | auto (by task complexity) | fixed. */
  @IsOptional() @IsString() modelMode?: string;
}

class PresetDto {
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() modelMode?: string;
}

class UpdateAgentTypeDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsArray() models?: string[];
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() persona?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsObject() tierModels?: Record<string, string | null>;
  @IsOptional() @IsString() modelMode?: string;
}

@Controller('agent-types')
export class AgentTypesController {
  constructor(private readonly types: AgentTypesService) {}

  @Get() list() { return this.types.list(); }
  @Post() create(@Body() dto: CreateAgentTypeDto) { return this.types.create(dto); }
  /** Provider presets (Claude, OpenAI, …): default model, list, tier map. */
  @Get('presets') presets() { return this.types.presets(); }
  /** Quick add from a preset, with a key (else the account's existing key). */
  @Post('presets/:provider') fromPreset(@Param('provider') provider: string, @Body() dto: PresetDto) { return this.types.createFromPreset(provider, dto); }
  /** The type's models: default, known list, tier picks, last fetch (cached; no network). */
  @Get(':id/models') models(@Param('id') id: string) { return this.types.models(id); }
  /** Ask the provider for its model list; on failure the configured list stays. */
  @Post(':id/models/refresh') refreshModels(@Param('id') id: string) { return this.types.refreshModels(id); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateAgentTypeDto) { return this.types.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.types.remove(id); }
}
