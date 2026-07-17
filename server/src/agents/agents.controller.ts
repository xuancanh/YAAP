import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { AgentsService } from './agents.service';

class CreateAgentDto {
  @IsString() name!: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
}

class UpdateAgentDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() charter?: string;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() homeDir?: string;
  @IsOptional() @IsString() dashboard?: string;
}

class FeedbackDto {
  @IsIn(['up', 'down']) rating!: 'up' | 'down';
  @IsOptional() @IsString() note?: string;
  @IsString() turnId!: string;
}

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get() list() { return this.agents.list(); }
  @Get(':id') get(@Param('id') id: string) { return this.agents.get(id); }
  @Post() create(@Body() dto: CreateAgentDto) { return this.agents.create(dto); }
  @Patch(':id') update(@Param('id') id: string, @Body() dto: UpdateAgentDto) { return this.agents.update(id, dto); }
  @Delete(':id') remove(@Param('id') id: string) { return this.agents.remove(id); }
  @Post(':id/feedback') feedback(@Param('id') id: string, @Body() dto: FeedbackDto) { return this.agents.addFeedback(id, dto); }
}
