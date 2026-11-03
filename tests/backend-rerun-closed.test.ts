import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isClosedTask } from '../server/src/chats/work-log.service';

test('a run whose task has closed is not offered for rerun (org: done, cancelled; agent: done, abandoned)', () => {
  for (const s of ['done', 'cancelled', 'abandoned']) assert.equal(isClosedTask(s), true, s);
  for (const s of ['todo', 'in_progress', 'blocked', 'in_review', null, undefined]) assert.equal(isClosedTask(s), false, String(s));
});
