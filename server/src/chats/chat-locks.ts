/**
 * ChatLocks — the per-chat busy lock shared by the turn loop and compaction
 * (FR-7.5): a chat runs one turn OR one compaction at a time, so private
 * history is never rewritten concurrently.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ChatLocks {
  private readonly busy = new Set<string>();

  tryAcquire(id: string): boolean {
    if (this.busy.has(id)) return false;
    this.busy.add(id);
    return true;
  }

  release(id: string): void {
    this.busy.delete(id);
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }
}
