import { describe, expect, it } from 'vitest';
import { rerunRefusal } from '../src/lib/rerun';

describe('rerunRefusal', () => {
  it('says why in words for the dispatcher skip reasons', () => {
    expect(rerunRefusal('skipped:closed')).toMatch(/already done or cancelled\. Reopen the task/);
    expect(rerunRefusal('skipped:paused')).toMatch(/paused\. Resume first/);
    expect(rerunRefusal('cap')).toMatch(/daily run cap/);
  });
  it('prefers the server error and falls back to the raw word', () => {
    expect(rerunRefusal('skipped:closed', 'the loop was removed')).toBe('The rerun did not start: the loop was removed');
    expect(rerunRefusal('skipped:something_new')).toBe('The rerun did not start: something new');
  });
});
