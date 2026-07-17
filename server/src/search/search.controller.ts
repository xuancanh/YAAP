import { Controller, Get, Query } from '@nestjs/common';
import { SearchService } from './search.service';

@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  run(@Query('workspaceId') workspaceId: string, @Query('q') q: string) {
    return this.search.search(workspaceId ?? '', q ?? '');
  }
}
