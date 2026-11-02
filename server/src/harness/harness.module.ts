/**
 * HarnessModule — coding-agent CLIs as the `code_agent` tool
 * (docs/coding-harnesses.md): GET /api/harness (redacted settings, detection,
 * the OS sandbox), PUT /api/harness/:id (validated patch; the API key is
 * sealed and never returned), POST /api/harness/:id/detect (re-check).
 */
import { BadRequestException, Body, Controller, Get, Module, Param, Post, Put } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { SettingsModule } from '../settings/settings.module';
import { HarnessConfigError, isHarnessId } from './harness-config';
import { HarnessService } from './harness.service';

@Controller('harness')
export class HarnessController {
  constructor(private readonly svc: HarnessService) {}

  @Get() view() { return this.svc.view(); }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!isHarnessId(id)) throw new BadRequestException(`unknown harness: ${id}`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('body must be an object');
    try {
      await this.svc.update(id, body);
    } catch (err) {
      if (err instanceof HarnessConfigError) throw new BadRequestException(err.message);
      throw err;
    }
    return this.svc.view();
  }

  @Post(':id/detect')
  async detect(@Param('id') id: string) {
    if (!isHarnessId(id)) throw new BadRequestException(`unknown harness: ${id}`);
    return this.svc.detect(id, undefined, true);
  }
}

@Module({
  imports: [ChatsModule, SettingsModule],
  controllers: [HarnessController],
  providers: [HarnessService],
  exports: [HarnessService],
})
export class HarnessModule {}
