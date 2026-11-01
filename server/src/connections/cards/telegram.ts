import type { ContextCard } from './types';

/** The Telegram presence channel (docs/channels.md §1): inbound messages
 *  become turns, the agent's events are pushed back. There are no telegram
 *  tools; the agent reaches it by writing events and answering turns. */
export const telegram: ContextCard = {
  id: 'telegram',
  service: 'telegram',
  provider: '',
  title: 'Telegram channel',
  summary: 'A paired Telegram chat: messages from the user arrive as turns, and the agent\'s activity events (loop runs, alerts, briefs) are pushed back to the chat, respecting quiet hours.',
  capabilities: {
    read: ['inbound messages from the paired chat arrive as ordinary user turns (channel origin: mutating tools are auto-denied)'],
    write: ['agent_events the agent produces are delivered to the chat (loop_run, loop_error, budget_stop, info); quiet hours queue or silence them'],
  },
  dataExposed: 'Message text and attachments the user sends from Telegram; the event titles and bodies pushed back.',
  risks: 'A Telegram message is an external surface: it can never trigger a send, a purchase or a file write directly. Anything pushed to the chat is readable by whoever holds the phone — keep PII and secrets out of event bodies.',
  usage: [
    'Answer Telegram turns briefly: it is a phone screen, not a report.',
    'What should reach the user later goes into a loop_run or info event body; the channel delivers it after quiet hours end.',
    'Channel-originated turns cannot run mutating tools: queue the work as a task and do it in your next loop or heartbeat.',
    'Never echo secrets, tokens or other people\'s addresses into an event body.',
  ],
  suggestedUses: [
    {
      id: 'evening-wrap',
      title: 'Weekday 18:00 wrap-up to the phone',
      why: 'One short message a day on what got done and what waits for the user — nothing else is pushed.',
      grantLevel: 'read',
      fits: ['personal', 'executive', 'operations'],
      loop: {
        name: 'Evening wrap-up',
        cron: '0 18 * * 1-5',
        prompt: 'Write a three-line wrap-up of the day: done, waiting on the user, tomorrow. Keep it under 300 characters; it is delivered to the paired Telegram chat.',
      },
    },
  ],
};
