/** Oversight's audit log read as sentences, its categories and its filter. */
import { describe, expect, it } from 'vitest';
import type { OrgAuditRow } from '../src/lib/api';
import { actorWords, auditCategory, auditSentence, filterAudit, replayTitle } from '../src/lib/oversight';

const row = (seq: number, actor: string, action: string, payload: Record<string, unknown> = {}, refType = 'goal'): OrgAuditRow => ({ id: `r${seq}`, orgId: 'o', seq, actor, action, refType, refId: 'abcdef123', payload: JSON.stringify(payload), prevHash: '', hash: 'h', createdAt: '2026-11-04T00:00:00Z' });
const names = (id: string) => ({ a1: 'Writer' } as Record<string, string>)[id];

describe('the audit log in words', () => {
  it('names the actor and the action as a sentence, with the reason when the row has one', () => {
    expect(actorWords('user', names)).toBe('You');
    expect(actorWords('chief', names)).toBe('The chief of staff');
    expect(actorWords('agent:a1', names)).toBe('Writer');
    expect(auditSentence(row(1, 'user', 'goal_create', { title: 'Grow signups' }), names).text).toBe('You created a goal “Grow signups”');
    const auto = auditSentence(row(2, 'chief', 'auto_task_assign', { title: 'Draft the post', reason: 'Writer was idle' }, 'task'), names);
    expect(auto).toEqual({ text: 'The chief of staff assigned a task “Draft the post” on its own', detail: 'Writer was idle', auto: true });
    expect(auditSentence(row(3, 'agent:a1', 'weird_thing', {}, 'meeting'), names).text).toBe('Writer weird thing (meeting)');
  });
  it('sorts actions into kinds and filters by kind, actor, autonomy and words', () => {
    expect(auditCategory('goal_update')).toBe('goals');
    expect(auditCategory('auto_project_update')).toBe('work');
    expect(auditCategory('spend_commit')).toBe('money');
    expect(auditCategory('unit_rename')).toBe('people');
    expect(auditCategory('approve')).toBe('decisions');
    expect(auditCategory('run_end')).toBe('system');
    const rows = [row(1, 'user', 'goal_create', { title: 'Grow signups' }), row(2, 'chief', 'auto_task_assign', { title: 'Draft' }, 'task'), row(3, 'agent:a1', 'spend_commit', {}, 'run')];
    const f = { q: '', category: 'all' as const, actor: 'all', autoOnly: false, routine: true };
    // run bookkeeping (spend settled, runs started/ended) is hidden unless asked for
    expect(filterAudit(rows, { ...f, routine: false }, names).map((r) => r.seq)).toEqual([1, 2]);
    expect(filterAudit(rows, { ...f, category: 'money' }, names).map((r) => r.seq)).toEqual([3]);
    expect(filterAudit(rows, { ...f, autoOnly: true }, names).map((r) => r.seq)).toEqual([2]);
    expect(filterAudit(rows, { ...f, actor: 'user' }, names).map((r) => r.seq)).toEqual([1]);
    expect(filterAudit(rows, { ...f, q: 'signups' }, names).map((r) => r.seq)).toEqual([1]);
    expect(filterAudit(rows, { ...f, q: 'nobody did this' }, names)).toHaveLength(0);
    expect(filterAudit(rows, { ...f, q: 'settled' }, names).map((r) => r.seq)).toEqual([3]);
  });
  it('reads a replay line in words: ids become names and the verb reads as a sentence', () => {
    const nm = (id: string) => (id.startsWith('a1') ? 'Writer' : undefined);
    expect(replayTitle('task create task Draft the post (agent:a1b2c3d4-0000-0000-0000-000000000000)', nm)).toBe('Task created: Draft the post, by Writer');
    expect(replayTitle('member add agent a1b2c3d4 (user)', nm)).toBe('Member added: Writer, by you');
    expect(replayTitle('signal breaker_trip (warn) → chief', nm)).toBe('signal breaker_trip (warn) → chief');
  });
});
