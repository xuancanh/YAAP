import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { SkillsService } from './skills.service';

class ImportSkillMdDto {
  @IsString() content!: string;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() @IsString() agentId?: string;
}

class CreateSkillDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsString() instructions!: string;
  @IsOptional() @IsString() workspaceId?: string;
}

class PromoteSkillDto {
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
  /** agentskills.io SKILL.md → scanned draft (docs/permissions.md "Skills"). */
  @Post('import') importSkillMd(@Body() dto: ImportSkillMdDto) { return this.skills.importSkillMd(dto); }
  @Get(':id') get(@Param('id') id: string) { return this.skills.get(id); }
  @Get(':id/skill.md')
  @Header('Content-Disposition', 'attachment; filename="SKILL.md"')
  async exportSkillMd(@Param('id') id: string, @Res() res: Response) {
    res.type('text/markdown').send(await this.skills.exportSkillMd(id));
  }
  @Get(':id/outcomes') outcomes(@Param('id') id: string) { return this.skills.outcomes(id); }
  /** Item 10: an agent-proposed revision is accepted (replaces the text,
   *  previous version kept in history) or rejected (dropped). */
  @Post(':id/revision/accept') acceptRevision(@Param('id') id: string) { return this.skills.resolveRevision(id, true); }
  @Post(':id/revision/reject') rejectRevision(@Param('id') id: string) { return this.skills.resolveRevision(id, false); }
  @Post() create(@Body() dto: CreateSkillDto) { return this.skills.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateSkillDto) { return this.skills.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.skills.remove(id); }
  /** Phase 3: agent-drafted skills go live only on user approval. */
  @Post(':id/approve') approveDraft(@Param('id') id: string) { return this.skills.resolveDraft(id, true); }
  @Post(':id/reject') rejectDraft(@Param('id') id: string) { return this.skills.resolveDraft(id, false); }
  /** Permissions §5: agent-private → workspace-shared, after the user re-reviews. */
  @Post(':id/promote') promote(@Param('id') id: string, @Body() dto: PromoteSkillDto) { return this.skills.promote(id, dto.workspaceId); }
}
