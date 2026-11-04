import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { StatusService } from './status.service';

@Controller('status')
export class StatusController {
  // Explicit @Inject: tsx (dev/test runner) doesn't emit design:paramtypes,
  // so type-based injection alone leaves this undefined outside the tsc build.
  constructor(@Inject(StatusService) private readonly status: StatusService) {}

  @Get()
  // Named `readiness`, not `status`: the constructor parameter property
  // `status` (the injected service) would shadow a same-named route method
  // on the instance and break the handler lookup.
  async readiness() {
    const db = await this.status.databaseUp();
    const body = { ok: db, app: 'yaap', db: db ? 'up' : 'down', time: new Date().toISOString() };
    // Readiness, not just liveness: a dead database means the API can't serve
    // real traffic, so probes should see 503 and route around this instance.
    if (!db) throw new ServiceUnavailableException(body);
    return body;
  }
}
