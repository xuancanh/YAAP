/**
 * FilesModule — the workspace filesystem (docs/filesystem.md), global so the
 * chat tools, the workspace and agent file routes and the app bridge all
 * share one WorkspaceFs (one per-file write queue). It also owns the
 * WorkspaceEventBus behind `GET /api/workspaces/:id/events`, since file
 * changes are emitted on it from modules the group chat never imports.
 */
import { Global, Module } from '@nestjs/common';
import { WorkspaceFs } from './workspace-fs.service';
import { WorkspaceEventBus } from '../groupchat/workspace-events';

@Global()
@Module({
  providers: [WorkspaceFs, WorkspaceEventBus],
  exports: [WorkspaceFs, WorkspaceEventBus],
})
export class FilesModule {}
