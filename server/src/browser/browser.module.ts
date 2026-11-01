import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { BrowserController } from './browser.controller';
import { BrowserService } from './browser.service';

@Module({
  imports: [StorageModule],
  controllers: [BrowserController],
  providers: [BrowserService],
  exports: [BrowserService],
})
export class BrowserModule {}
