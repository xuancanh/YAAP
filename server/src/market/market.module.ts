import { Module } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { AgentsModule } from '../agents/agents.module';
import { SkillsModule } from '../skills/skills.module';

@Module({
  imports: [AgentsModule, SkillsModule],
  controllers: [MarketController],
  providers: [MarketService],
})
export class MarketModule {}
