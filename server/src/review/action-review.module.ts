/**
 * ReviewModule — the independent action reviewer (docs/permissions.md §6).
 * Imported by ChatsModule; the turn loop calls it before any mutating call
 * that would run without a fresh human decision.
 */
import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ActionReviewService } from './action-review.service';

@Module({
  imports: [SettingsModule],
  providers: [ActionReviewService],
  exports: [ActionReviewService],
})
export class ActionReviewModule {}
