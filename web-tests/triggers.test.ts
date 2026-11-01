import { describe, expect, it } from 'vitest';
import { lastFiredLabel, runsWhenOf, triggerGlyph, triggerLabel } from '../src/lib/triggers';

describe('triggerLabel', () => {
  it('describes each trigger kind and appends a cron when both are set', () => {
    expect(triggerLabel({ name: 'a', cron: '0 9 * * *' })).toBe('0 9 * * *');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'mail', service: 'gmail', query: 'from:boss' } })).toBe('Gmail mail matching "from:boss" · every 5m');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'mail', service: 'msmail', query: '', pollMinutes: 10 } })).toBe('Outlook mail matching "*" · every 10m');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'calendar', service: 'gcal', withinHours: 24, on: 'created' } })).toBe('Google Calendar event created in the next 24h');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'calendar', service: 'mscal', withinHours: 2, on: 'starting', leadMinutes: 10 } })).toBe('Outlook Calendar event starting within 10m');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'task' }, cron: '*/15 * * * *' })).toBe('a task is assigned · */15 * * * *');
    expect(triggerLabel({ name: 'a', trigger: { kind: 'webhook' } })).toBe('webhook POST');
    expect(triggerLabel({ name: 'a' })).toBe('never (no schedule or trigger)');
  });
});

describe('runsWhenOf / triggerGlyph', () => {
  it('maps a loop to the chooser value and a glyph', () => {
    expect(runsWhenOf({})).toBe('schedule');
    expect(runsWhenOf({ trigger: { kind: 'webhook' } })).toBe('webhook');
    expect(triggerGlyph({})).toBe('clock');
    expect(triggerGlyph({ trigger: { kind: 'mail', service: 'gmail', query: '' } })).toBe('at');
    expect(triggerGlyph({ trigger: { kind: 'task' } })).toBe('board');
  });
});

describe('lastFiredLabel', () => {
  const now = new Date('2026-07-16T10:00:00.000Z');
  it('renders relative times and the never case', () => {
    expect(lastFiredLabel(null, now)).toBe('never fired');
    expect(lastFiredLabel('2026-07-16T09:59:50.000Z', now)).toBe('fired just now');
    expect(lastFiredLabel('2026-07-16T09:45:00.000Z', now)).toBe('fired 15 min ago');
    expect(lastFiredLabel('2026-07-16T07:00:00.000Z', now)).toBe('fired 3 h ago');
    expect(lastFiredLabel('2026-07-10T10:00:00.000Z', now)).toBe('fired 6 d ago');
  });
});
