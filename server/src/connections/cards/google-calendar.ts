import type { ContextCard } from './types';

export const googleCalendar: ContextCard = {
  id: 'google-calendar',
  service: 'calendar',
  provider: 'google',
  title: 'Google Calendar',
  summary: 'Read the user\'s primary calendar and free/busy; with a write grant, create and update events. Calendar triggers fire on events created, changed or about to start.',
  capabilities: {
    read: ['gcal_upcoming: events in the next N hours', 'gcal_search: find events by text and window', 'gcal_freebusy: busy blocks for scheduling', 'calendar trigger: created / changed / starting events'],
    write: ['gcal_create_event: create an event (stamped "created by <agent> via yaam")', 'gcal_update_event: move, rename or re-describe an event'],
  },
  dataExposed: 'Event titles, times, locations, attendee addresses and descriptions on the primary calendar.',
  risks: 'Attendee lists are PII and descriptions are third-party text. Creating or moving an event with external guests sends them invitations — an external-floor action; prefer a proposal the user confirms.',
  usage: [
    'Start with gcal_upcoming for "what is next"; gcal_search for anything older or by name.',
    'Check gcal_freebusy before proposing a time; propose two or three slots, not one.',
    'Creating or updating an event with guests notifies them — in Ask mode this pauses for the user; in a loop it queues as a pending approval.',
    'Keep descriptions short and factual; never paste private notes into an event others can see.',
    'Times are in the user\'s calendar timezone; say the zone when you report a time.',
  ],
  suggestedUses: [
    {
      id: 'external-briefing',
      title: 'Briefing 60 minutes before meetings with external guests',
      why: 'The user walks into every outside meeting with a one-page who / why / last-touch note.',
      grantLevel: 'read',
      fits: ['sales', 'executive', 'consulting'],
      loop: {
        name: 'Meeting briefings',
        trigger: { kind: 'calendar', service: 'gcal', on: 'starting', withinHours: 2, leadMinutes: 60, pollMinutes: 5 },
        prompt: 'An event is starting soon (payload below). If it has guests outside the user\'s own domain, prepare a one-page briefing: who they are from what you already know in your files and memory, the stated purpose, open items from past notes, and two questions worth asking. Post it to your dashboard and the paired channel. Skip internal-only events in one line.',
      },
    },
    {
      id: 'day-plan',
      title: 'Weekday 07:00 plan of the day',
      why: 'Meetings, gaps and travel in one glance before the day starts.',
      grantLevel: 'read',
      fits: ['executive', 'operations', 'personal'],
      loop: {
        name: 'Plan of the day',
        cron: '0 7 * * 1-5',
        prompt: 'List today\'s events with times, where they are, who is attending, and the free blocks between them. Flag overlaps and back-to-back runs. Post it to your dashboard.',
      },
    },
    {
      id: 'new-event-check',
      title: 'On a new event, check for conflicts and missing details',
      why: 'Double bookings and events without a location or agenda are caught the moment they appear.',
      grantLevel: 'read',
      fits: ['operations', 'executive'],
      loop: {
        name: 'New event check',
        trigger: { kind: 'calendar', service: 'gcal', on: 'created', withinHours: 168, pollMinutes: 10 },
        prompt: 'New calendar events (payload below). For each: does it overlap another event, is a location or link missing, is the title clear? Report problems as tasks on your board; say nothing when all is well.',
      },
    },
  ],
};
