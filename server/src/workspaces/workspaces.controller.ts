import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { WorkspacesService } from './workspaces.service';

class CreateWorkspaceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() color?: string;
}

class UpdateWorkspaceDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() memory?: string;
}

@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get() list() { return this.workspaces.list(); }
  @Post() create(@Body() dto: CreateWorkspaceDto) { return this.workspaces.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateWorkspaceDto) { return this.workspaces.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.workspaces.remove(id); }
}
