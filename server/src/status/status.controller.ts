import { Controller, Get } from '@nestjs/common';

@Controller('status')
export class StatusController {
  @Get()
  status() {
    return { ok: true, app: 'yaam-chat', time: new Date().toISOString() };
  }
}
