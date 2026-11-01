/**
 * SharedModule — shared workspaces (docs/shared-agents.md, execution-plan
 * item 8). Global so the WorkspaceAccessGuard (bound in AppModule) and the
 * turn loop, channels, push and org modules can inject SharedService without
 * a module cycle: it depends on ConnectionsModule only.
 */
import { Global, Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module';
import { SharedService } from './shared.service';
import { InvitesController, SharedController } from './shared.controller';
import { WorkspaceAccessGuard } from './workspace-access.guard';

@Global()
@Module({
  imports: [ConnectionsModule],
  controllers: [SharedController, InvitesController],
  providers: [SharedService, WorkspaceAccessGuard],
  exports: [SharedService, WorkspaceAccessGuard],
})
export class SharedModule {}
