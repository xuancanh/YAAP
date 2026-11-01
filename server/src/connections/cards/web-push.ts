import type { ContextCard } from './types';

/** Web push (docs/channels.md §3): browsers that turned on notifications
 *  receive the agent's events; the PWA opens the inbox. One-way. */
export const webPush: ContextCard = {
  id: 'web-push',
  service: 'push',
  provider: '',
  title: 'Web push',
  summary: 'Browser notifications for the agent\'s events on every device the user enabled them on. Delivery only — nothing comes back through it.',
  capabilities: {
    read: [],
    write: ['agent_events the agent writes are pushed as notifications (title + first line); quiet hours queue or silence them'],
  },
  dataExposed: 'Event titles and the first line of their bodies, shown on lock screens.',
  risks: 'Notifications appear on lock screens: the title is public to anyone near the device. Too many pushes get the channel muted, and then real alerts are lost.',
  usage: [
    'A push is an interruption: write at most one or two events a day that are not errors.',
    'Put the decision or the fact in the title; details belong in the body or the dashboard.',
    'No PII, secrets or amounts in titles.',
    'Errors and budget stops push themselves; do not duplicate them with an info event.',
  ],
  suggestedUses: [
    {
      id: 'daily-headline',
      title: 'One daily headline at 08:30',
      why: 'The single most useful fact of the day, pushed once, instead of a stream of pings.',
      grantLevel: 'read',
      fits: ['executive', 'personal', 'operations'],
      loop: {
        name: 'Daily headline',
        cron: '30 8 * * 1-5',
        prompt: 'Pick the one thing the user most needs to know today from your board, dashboard and recent events. Write it as a single info event with a title under 60 characters and a two-line body. If nothing qualifies, write nothing.',
      },
    },
  ],
};
