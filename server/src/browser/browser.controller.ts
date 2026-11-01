/** Read-only status surface: which browser backend is live (like /runner/status). */
import { Controller, Get } from '@nestjs/common';
import { BrowserService } from './browser.service';

@Controller('browser')
export class BrowserController {
  constructor(private readonly svc: BrowserService) {}

  @Get('status')
  async status() {
    await this.svc.ready();
    return this.svc.status();
  }
}
