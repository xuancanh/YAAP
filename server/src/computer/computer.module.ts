import { Module } from '@nestjs/common';
import { ComputerController } from './computer.controller';
import { ComputerService } from './computer.service';
import { CompanionGuard } from './companion.guard';

@Module({
  controllers: [ComputerController],
  providers: [ComputerService, CompanionGuard],
  exports: [ComputerService],
})
export class ComputerModule {}
