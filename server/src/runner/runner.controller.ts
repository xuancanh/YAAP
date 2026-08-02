/** Read-only status surface: which runner backend is live and what it runs. */
import { Controller, Get } from '@nestjs/common';
import { RunnerService } from './runner.service';

@Controller('runner')
export class RunnerController {
  constructor(private readonly svc: RunnerService) {}

  @Get('status') status() { return this.svc.status(); }
}
