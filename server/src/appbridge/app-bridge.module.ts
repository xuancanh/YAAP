/**
 * AppBridgeModule — the server side of the mini-app capability bridge
 * (docs/miniapp-capabilities.md). Apps run in opaque-origin iframes and can
 * never reach these endpoints themselves; every call funnels through the
 * host page (AppHost), and the grant is re-verified here on each request —
 * the client-side checks are UX, this is the boundary.
 */
import { Body, Controller, Get, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AppBridgeService } from './app-bridge.service';
import { AgentsModule } from '../agents/agents.module';
import { ChatsModule } from '../chats/chats.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Controller('agents/:id/apps/:appId')
export class AppBridgeController {
  constructor(private readonly bridge: AppBridgeService) {}

  @Post('approve')
  approve(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { capabilities: string[] }) {
    return this.bridge.approve(id, appId, body.capabilities ?? []);
  }

  @Get('storage')
  storageGet(@Param('id') id: string, @Param('appId') appId: string) {
    return this.bridge.storageGet(id, appId);
  }

  @Put('storage')
  storagePut(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { state: unknown }) {
    return this.bridge.storagePut(id, appId, body.state);
  }

  @Get('files')
  filesList(
    @Param('id') id: string, @Param('appId') appId: string,
    @Query('prefix') prefix?: string, @Query('workspaceId') workspaceId?: string,
  ) {
    return this.bridge.filesList(id, appId, prefix ?? '', workspaceId);
  }

  @Get('file')
  fileRead(
    @Param('id') id: string, @Param('appId') appId: string,
    @Query('path') path: string, @Query('workspaceId') workspaceId?: string,
  ) {
    return this.bridge.fileRead(id, appId, path ?? '', workspaceId);
  }

  @Put('files')
  fileWrite(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { path: string; content: string }) {
    return this.bridge.fileWrite(id, appId, body.path ?? '', body.content ?? '');
  }

  @Get('tasks')
  tasksList(@Param('id') id: string, @Param('appId') appId: string) {
    return this.bridge.tasksList(id, appId);
  }

  @Post('tasks')
  taskAdd(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { title: string; note?: string }) {
    return this.bridge.taskAdd(id, appId, body.title ?? '', body.note);
  }

  @Patch('tasks/:taskId')
  taskMove(
    @Param('id') id: string, @Param('appId') appId: string,
    @Param('taskId') taskId: string, @Body() body: { status: string },
  ) {
    return this.bridge.taskMove(id, appId, taskId, body.status ?? '');
  }

  @Post('ask')
  ask(@Param('id') id: string, @Param('appId') appId: string, @Body() body: { prompt: string; workspaceId?: string }) {
    return this.bridge.ask(id, appId, body.prompt ?? '', body.workspaceId);
  }
}

@Module({
  imports: [AgentsModule, ChatsModule, WorkspacesModule],
  controllers: [AppBridgeController],
  providers: [AppBridgeService],
})
export class AppBridgeModule {}
