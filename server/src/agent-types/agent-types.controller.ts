import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { AgentTypesService } from './agent-types.service';

class CreateAgentTypeDto {
  @IsString() name!: string;
  @IsString() provider!: string;
  @IsString() model!: string;
  @IsOptional() @IsArray() models?: string[];
  @IsOptional() @IsString() baseUrl?: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsString() persona?: string;
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
}

@Controller('agent-types')
export class AgentTypesController {
  constructor(private readonly types: AgentTypesService) {}

  @Get() list() { return this.types.list(); }
  @Post() create(@Body() dto: CreateAgentTypeDto) { return this.types.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateAgentTypeDto) { return this.types.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.types.remove(id); }
}
