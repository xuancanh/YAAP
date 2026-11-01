import type { ContextCard } from './types';

export const microsoftCalendar: ContextCard = {
  id: 'microsoft-calendar',
  service: 'calendar',
  provider: 'microsoft',
  title: 'Outlook Calendar',
  summary: 'Read the user\'s Outlook calendar; with a write grant, create and update events. Calendar triggers fire on events created, changed or about to start.',
  capabilities: {
    read: ['mscal_upcoming: events in the next N hours', 'mscal_search: find events by text and window', 'calendar trigger: created / changed / starting events'],
    write: ['mscal_create_event: create an event (stamped "created by <agent> via yaam")', 'mscal_update_event: move, rename or re-describe an event'],
  },
  dataExposed: 'Event subjects, times, locations, attendee addresses and bodies on the default calendar.',
  risks: 'Attendee lists are PII and event bodies are third-party text. Creating or moving an event with guests sends them invitations — an external-floor action; prefer a proposal the user confirms.',
  usage: [
    'mscal_upcoming for "what is next"; mscal_search for anything older or by name.',
    'Propose two or three slots rather than one when scheduling.',
    'Creating or updating an event with attendees notifies them — in loops it queues as a pending approval.',
    'Keep event bodies short and factual; no private notes in shared events.',
    'Report times with the timezone.',
  ],
  suggestedUses: [
    {
      id: 'external-briefing',
      title: 'Briefing 60 minutes before meetings with external guests',
      why: 'A one-page who / why / last-touch note before every outside meeting.',
      grantLevel: 'read',
      fits: ['sales', 'executive', 'consulting'],
      loop: {
        name: 'Meeting briefings',
        trigger: { kind: 'calendar', service: 'mscal', on: 'starting', withinHours: 2, leadMinutes: 60, pollMinutes: 5 },
        prompt: 'An event is starting soon (payload below). If it has guests outside the user\'s own domain, prepare a one-page briefing from what you already know: who they are, the purpose, open items, two questions worth asking. Post it to your dashboard and the paired channel. Skip internal-only events in one line.',
      },
    },
    {
      id: 'day-plan',
      title: 'Weekday 07:00 plan of the day',
      why: 'Meetings, gaps and travel in one glance.',
      grantLevel: 'read',
      fits: ['executive', 'operations', 'personal'],
      loop: {
        name: 'Plan of the day',
        cron: '0 7 * * 1-5',
        prompt: 'List today\'s events with times, locations, attendees and the free blocks between them. Flag overlaps. Post it to your dashboard.',
      },
    },
  ],
};
