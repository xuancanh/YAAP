/** ConnectionsModule — external service connections (docs/integrations.md).
 *  Tool definitions: connections.tools.ts · logic: connections.service.ts ·
 *  HTTP: connections.controller.ts. */
import { Module } from '@nestjs/common';
import { ConnectionsController } from './connections.controller';
import { ConnectionsService } from './connections.service';

@Module({
  controllers: [ConnectionsController],
  providers: [ConnectionsService],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
