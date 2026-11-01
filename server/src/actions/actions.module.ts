/**
 * ActionsModule — the external-action contract (C2) and the trust ledger
 * (C10) of docs/actions-and-trust.md, execution-plan item 28. Imported by
 * ChatsModule (the turn loop consults it on every non-read call, in every
 * session) and by OrgModule (OrgTrustBridge binds the audit chain, signals,
 * `two_key` approvals and review verdicts). It never imports either.
 */
import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ConnectionsModule } from '../connections/connections.module';
import { ActionsService } from './actions.service';
import { TrustService } from './trust.service';
import { ActionsController } from './actions.controller';

@Module({
  imports: [AgentsModule, ConnectionsModule],
  controllers: [ActionsController],
  providers: [ActionsService, TrustService],
  exports: [ActionsService, TrustService],
})
export class ActionsModule {}
