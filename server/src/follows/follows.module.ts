/**
 * FollowsModule — follows of threads and tasks (docs/follows.md). Global so
 * the services whose changes feed it (agents, org tasks, group chat) and the
 * heartbeat inject FollowsService (optionally) without importing this
 * module; it depends on nothing but the database. FollowsToolsModule offers
 * the `follow` / `unfollow` / `list_follows` tools on the turn loop.
 */
import { Global, Module } from '@nestjs/common';
import { ChatsModule } from '../chats/chats.module';
import { FollowsService } from './follows.service';
import { FollowsController } from './follows.controller';
import { FollowsTools } from './follows.tools';

@Global()
@Module({
  controllers: [FollowsController],
  providers: [FollowsService],
  exports: [FollowsService],
})
export class FollowsModule {}

@Module({
  imports: [ChatsModule],
  providers: [FollowsTools],
})
export class FollowsToolsModule {}
