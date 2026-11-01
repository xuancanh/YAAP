/** The CEO's seat helpers (docs/company-vision.md §2, §3, §5, §8): pace and
 *  risk presentation, the cron humaniser, the pulse sparkline, minutes
 *  parsing, signal grouping, tunable groups and bounds, decision sources. */
import { describe, expect, it } from 'vitest';
import {
  atRiskByUnit, checkInDue, confidenceGap, decidedByLabel, decisionSource, dueLabel, firesOn, groupSignals, groupTunables, humanCron,
  minutesMeetingId, paceBadge, parseMinutes, sloTiles, sparkPath, summarizeChildren, tunableError,
} from '../src/lib/org';
import { decisionMentions, decisionRefs, meetingCommandHint } from '../src/lib/channels';
import type { OrgIntentNode, OrgSignal, OrgTunable } from '../src/lib/api';

const kr = (over: Partial<OrgIntentNode> = {}): OrgIntentNode => ({
  id: 'kr1', orgId: 'o', title: 'KR', description: '', status: 'active', ownerAgentId: 'a1', unitId: 'u1', parentGoalId: 'obj', createdAt: '2026-10-01T00:00:00Z',
  kind: 'key_result', metric: 'users', targetValue: 100, currentValue: 40, startValue: 0, unitLabel: '', dueAt: '2026-12-01T00:00:00Z', confidence: 0.8, atRisk: 0, atRiskReason: '', lastCheckInAt: '2026-10-30T00:00:00Z', checkInCadenceDays: 7,
  progress: 0.4, tasks: { total: 0, done: 0 }, pace: 'onPace', expected: 0.5, measured: 0.4, ownerName: 'Scout', children: [], ...over,
});

describe('pace and risk presentation (§2.4)', () => {
  it('names the pace with the measured-vs-expected numbers behind it', () => {
    expect(paceBadge('onPace', 0.5, 0.45)).toMatchObject({ label: 'on pace', title: '45% done where 50% was expected' });
    expect(paceBadge('behind', 0.5, 0.2).label).toBe('behind');
    expect(paceBadge('unknown', null, null).title).toBe('never checked in');
    expect(paceBadge('unknown', null, 0.3).title).toBe('no target or due date');
  });
  it('shows measurement and confidence side by side and says when they disagree', () => {
    expect(confidenceGap(0.4, 0.45).note).toBe('measurement and confidence agree');
    expect(confidenceGap(0.2, 0.9)).toMatchObject({ gap: 0.7, note: 'the owner is 70 points more confident than the numbers' });
    expect(confidenceGap(0.9, 0.3).note).toMatch(/numbers run 60 points ahead/);
    expect(confidenceGap(null, 0.5)).toEqual({ gap: null, note: 'no measurement yet' });
  });
  it('summarises an objective\'s key results and counts risk per unit', () => {
    const obj = kr({ id: 'obj', kind: 'objective', unitId: 'u1', children: [kr(), kr({ id: 'kr2', pace: 'behind', atRisk: 1 }), kr({ id: 'kr3', status: 'achieved' })] });
    expect(summarizeChildren(obj.children)).toBe('1 of 2 key results on pace · 1 at risk');
    expect(summarizeChildren([])).toBe('');
    expect(atRiskByUnit([obj, kr({ id: 'kr9', unitId: null, atRisk: 1 })])).toEqual({ u1: 1, '': 1 });
  });
  it('labels due dates and overdue check-ins', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(dueLabel('2026-11-01T12:00:00Z', now)).toBe('due today');
    expect(dueLabel('2026-11-11T12:00:00Z', now)).toBe('due in 10d');
    expect(dueLabel('2026-10-29T12:00:00Z', now)).toBe('3d overdue');
    expect(dueLabel(null, now)).toBe('no due date');
    expect(checkInDue(kr({ lastCheckInAt: '2026-10-30T00:00:00Z' }), now)).toBe(false);
    expect(checkInDue(kr({ lastCheckInAt: '2026-10-20T00:00:00Z' }), now)).toBe(true);
    expect(checkInDue(kr({ lastCheckInAt: null, createdAt: '2026-10-01T00:00:00Z' }), now)).toBe(true);
  });
});

describe('cron in words (§3)', () => {
  it('reads the default cadences as a person would', () => {
    expect(humanCron('30 9 * * 1-5')).toBe('weekdays at 09:30');
    expect(humanCron('0 16 * * 5')).toBe('Fridays at 16:00');
    expect(humanCron('0 9 * * 1')).toBe('Mondays at 09:00');
    expect(humanCron('0 9 * * 0,6')).toBe('weekends at 09:00');
    expect(humanCron('0 9 * * 1,3')).toBe('Mon, Wed at 09:00');
    expect(humanCron('0 8 1 * *')).toBe('the 1st of every month at 08:00');
    expect(humanCron('0 */2 * * *')).toBe('every 2 hours');
    expect(humanCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(humanCron('0 9 * * *')).toBe('every day at 09:00');
  });
  it('leaves odd expressions alone and knows which fire today', () => {
    expect(humanCron('0 9 1 6 *')).toBe('0 9 1 6 *');
    expect(humanCron('junk')).toBe('junk');
    const monday = new Date(2026, 10, 2, 8, 0); // 2 Nov 2026 is a Monday
    expect(firesOn('30 9 * * 1-5', monday)).toBe(true);
    expect(firesOn('0 9 * * 1', monday)).toBe(true);
    expect(firesOn('0 16 * * 5', monday)).toBe(false);
    expect(firesOn('0 8 2 * *', monday)).toBe(true);
    expect(firesOn('bad', monday)).toBe(false);
  });
});

describe('minutes and decision chips (§3, §6)', () => {
  it('parses minutes JSON defensively and finds the minutes attachment', () => {
    expect(parseMinutes('')).toEqual({ summary: '', decisions: [], actions: [], risks: [], questions: [] });
    expect(parseMinutes('{"summary":"ok","decisions":[{"title":"x","decision":"y","alternatives":"","rationale":"","by":"a"}]}').decisions).toHaveLength(1);
    expect(parseMinutes('not json').actions).toEqual([]);
    expect(minutesMeetingId([{ path: 'meetings/m-12', kind: 'minutes' }, { path: 'x.png', kind: 'image' }])).toBe('m-12');
    expect(minutesMeetingId([{ path: 'x.png', kind: 'image' }])).toBeNull();
  });
  it('finds #decision:<id> refs and mentions like #goal: does', () => {
    expect(decisionRefs('we agreed · #decision:ab12cd34, see #decision:ab12cd34 and #decision:zz99yy88.')).toEqual(['ab12cd34', 'zz99yy88']);
    expect(decisionRefs('#decision:ab is short; x#decision:abcd glued')).toEqual([]);
    expect(decisionMentions('[{"kind":"decision","id":"d1"},{"kind":"goal","id":"g1"}]')).toEqual(['d1']);
    expect(decisionMentions('nope')).toEqual([]);
  });
  it('names the source and the decider of a decision', () => {
    expect(decisionSource({ meetingId: 'm', approvalId: null, refType: 'meeting' })).toBe('meeting');
    expect(decisionSource({ meetingId: null, approvalId: 'a', refType: '' })).toBe('approval');
    expect(decisionSource({ meetingId: null, approvalId: null, refType: 'cadence' })).toBe('cadence');
    expect(decisionSource({ meetingId: null, approvalId: null, refType: 'tunable' })).toBe('autonomous');
    const agent = (id: string) => (id === 'a1' ? 'Scout' : undefined);
    expect(decidedByLabel('agent:a1', agent, (id) => id)).toBe('Scout');
    expect(decidedByLabel('agent:zz', agent, (id) => id)).toBe('agent zz');
    expect(decidedByLabel('user', agent, (id) => id)).toBe('You (CEO)');
    expect(decidedByLabel('human:bob', agent, (id) => `person ${id}`)).toBe('person bob');
  });
  it('hints the /meeting command while it is typed', () => {
    expect(meetingCommandHint('hello')).toBeNull();
    expect(meetingCommandHint('/mee')).toMatchObject({ kind: 'adhoc', complete: false });
    expect(meetingCommandHint('/meeting standup #research tomorrow\'s plan')).toEqual({ kind: 'standup', unitSlug: 'research', agenda: 'tomorrow\'s plan', complete: true });
    expect(meetingCommandHint('/meeting weekly-review')).toMatchObject({ kind: 'weekly_review', unitSlug: null, agenda: '' });
    expect(meetingCommandHint('/meeting fix the roadmap')).toMatchObject({ kind: 'adhoc', agenda: 'fix the roadmap' });
  });
});

describe('the pulse (§5)', () => {
  it('draws a sparkline that breaks at missing days and clamps to the box', () => {
    expect(sparkPath([], 100, 28)).toBe('');
    expect(sparkPath([50], 100, 28)).toBe('M0.00,14.00');
    const d = sparkPath([0, null, 100, 150], 100, 28);
    expect(d.startsWith('M0.00,27.00')).toBe(true);
    expect(d).toContain('M66.67,1.00'); // the pen lifts over the null and lands again
    expect(d.endsWith('L100.00,1.00')).toBe(true); // 150 clamps to 100
  });
  it('groups open signals by severity, critical first, and drops resolved ones', () => {
    const s = (id: string, severity: OrgSignal['severity'], status: OrgSignal['status'] = 'open'): OrgSignal => ({ id, orgId: 'o', unitId: null, kind: 'stale_task', severity, refType: 'task', refId: 't', title: id, detail: '', addresseeKind: 'chief', addresseeId: '', dayKey: '2026-11-01', status, ackNote: '', ackedAt: null, resolvedAt: null, createdAt: '2026-11-01T00:00:00Z' });
    const groups = groupSignals([s('a', 'info'), s('b', 'critical'), s('c', 'warn', 'acked'), s('d', 'critical', 'resolved')]);
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'warn', 'info']);
    expect(groups[0].rows.map((r) => r.id)).toEqual(['b']);
  });
  it('judges the SLO tiles against their targets, acceptance the other way round', () => {
    const tiles = sloTiles({ cycleTimeHours: 40, firstReviewAcceptancePct: 60, decisionLatencyHours: null }, { cycleTimeHours: 48, firstReviewAcceptancePct: 70, decisionLatencyHours: 24 });
    expect(tiles.map((t) => t.met)).toEqual([true, false, null]);
  });
});

describe('tunables (§1b)', () => {
  const t = (key: string, area: OrgTunable['area'], stored: number | null = null): OrgTunable => ({ key, default: 1, min: 0, max: 10, description: '', area, value: stored ?? 1, stored });
  it('groups by area in a fixed order and checks the bound client-side', () => {
    const groups = groupTunables([t('slo.cycleTimeHours', 'assurance'), t('meeting.usdCap', 'rituals'), t('intent.paceTolerance', 'intent'), t('intent.confidenceDrops', 'intent')]);
    expect(groups.map((g) => g.area)).toEqual(['intent', 'rituals', 'assurance']);
    expect(groups[0].rows.map((r) => r.key)).toEqual(['intent.confidenceDrops', 'intent.paceTolerance']);
    expect(tunableError({ key: 'k', min: 0, max: 10 }, '5')).toBeNull();
    expect(tunableError({ key: 'k', min: 0, max: 10 }, '11')).toBe('must stay within 0–10');
    expect(tunableError({ key: 'k', min: 0, max: 10 }, 'x')).toBe('k needs a number');
  });
});
