import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { SkillsService } from './skills.service';

class CreateSkillDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() instructions!: string;
  @IsOptional() @IsString() workspaceId?: string;
}

class UpdateSkillDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() instructions?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
}

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get() list(@Query('workspaceId') workspaceId?: string, @Query('agentId') agentId?: string) { return this.skills.list(workspaceId, agentId); }
  @Get(':id') get(@Param('id') id: string) { return this.skills.get(id); }
  @Post() create(@Body() dto: CreateSkillDto) { return this.skills.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateSkillDto) { return this.skills.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.skills.remove(id); }
  /** Phase 3: agent-drafted skills go live only on user approval. */
  @Post(':id/approve') approveDraft(@Param('id') id: string) { return this.skills.resolveDraft(id, true); }
  @Post(':id/reject') rejectDraft(@Param('id') id: string) { return this.skills.resolveDraft(id, false); }
}
