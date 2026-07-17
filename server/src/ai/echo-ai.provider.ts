/**
 * EchoAiProvider — development stand-in so the full turn pipeline (session →
 * turn → stream → persisted transcript) runs end to end before any real
 * provider adapter lands. Streams the user's last message back word by word
 * with a fake usage event.
 */
import { Injectable } from '@nestjs/common';
import { AiProvider, AiRequest, AiStreamEvent } from './ai-provider.interface';

@Injectable()
export class EchoAiProvider implements AiProvider {
  readonly name = 'echo';

  async *stream(req: AiRequest): AsyncGenerator<AiStreamEvent> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const words = `(echo) ${last?.content ?? ''}`.split(/\s+/);
    for (const word of words) {
      if (req.signal?.aborted) return;
      yield { type: 'answer', text: `${word} ` };
      await new Promise((r) => setTimeout(r, 15));
    }
    yield { type: 'usage', inputTokens: words.length, outputTokens: words.length };
    yield { type: 'done' };
  }
}
