/**
 * HeartbeatController — the agent-home side of the gated heartbeat
 * (docs/triggers.md "Heartbeat"): state and the settings in effect, a
 * "beat now" that runs the gate immediately, and the per-agent tunables
 * (bounds-checked in HeartbeatService.setHeartbeat).
 */
import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsInt, IsOptional, IsString, ValidateIf } from 'class-validator';
import { HeartbeatService } from './heartbeat.service';

class HeartbeatPatchDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  /** Five-field cron; null or '' clears the agent override. */
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsString() cron?: string | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() dailyRunCap?: number | null;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() staleMinutes?: number | null;
}

@Controller('agents')
export class HeartbeatController {
  constructor(private readonly heartbeat: HeartbeatService) {}

  @Get(':id/heartbeat')
  view(@Param('id') id: string) {
    return this.heartbeat.view(id);
  }

  /** Run the gate now: returns the reasons and whether a turn ran. */
  @Post(':id/heartbeat/beat')
  beat(@Param('id') id: string) {
    return this.heartbeat.beat(id, new Date(), { force: true });
  }

  @Patch(':id/heartbeat')
  patch(@Param('id') id: string, @Body() dto: HeartbeatPatchDto) {
    return this.heartbeat.setHeartbeat(id, dto);
  }
}
