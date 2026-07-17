/**
 * StorageModule — S3-compatible object storage, global so any feature module
 * (workspaces, attachments, agent brains) can inject StorageService.
 */
import { Module, Global } from '@nestjs/common';
import { StorageService } from './storage.service';

@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
