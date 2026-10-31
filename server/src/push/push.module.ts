/**
 * PushModule — web push subscriptions and delivery (roadmap phase 4.3).
 *
 *  GET    /api/push/vapid-public-key   → { enabled, publicKey, subscriptions }
 *  POST   /api/push/subscribe          ← PushSubscription.toJSON() + userAgent
 *  DELETE /api/push/subscribe          ← { endpoint }
 */
import { Body, Controller, Delete, Get, Module, Post, BadRequestException } from '@nestjs/common';
import { PushService, type SubscribeInput } from './push.service';
import { AgentsModule } from '../agents/agents.module';

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key') publicKey() { return this.push.publicKey(); }

  @Post('subscribe')
  async subscribe(@Body() body: SubscribeInput) {
    try {
      return await this.push.subscribe(body);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : 'invalid subscription');
    }
  }

  @Delete('subscribe') unsubscribe(@Body() body: { endpoint?: string }) { return this.push.unsubscribe(body?.endpoint ?? ''); }
}

@Module({
  imports: [AgentsModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
