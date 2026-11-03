import { Module } from '@nestjs/common';
import { FoundryController } from './foundry.controller';

/** Foundry (docs/foundry.md): the shelf index and the Kits shelf previews.
 *  The Plugins shelf's registry lives in PluginsModule. */
@Module({ controllers: [FoundryController] })
export class FoundryModule {}
