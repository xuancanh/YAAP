import type { ContextCard } from './types';

/** The desktop companion (docs/computer-control.md): the user's own computer,
 *  reached through a paired runner. Every tool is Ask-gated; the scope the
 *  user granted (screen, input, shell, file roots) bounds what exists. */
export const computer: ContextCard = {
  id: 'computer',
  service: 'computer',
  provider: '',
  title: 'Computer companion',
  summary: 'Act on the user\'s own computer through the paired companion: see the screen, click and type, run shell commands and read or write files inside the granted roots. Every action is approved by the user.',
  capabilities: {
    read: ['computer_screenshot: see the screen', 'computer_list_dir / computer_read_file: inside granted roots only'],
    write: ['computer_click / computer_type / computer_key / computer_move / computer_scroll: drive input', 'computer_shell: run a command', 'computer_write_file: write inside granted roots (all Ask-gated, recorded in the action log)'],
  },
  dataExposed: 'Whatever is on screen when you look, and the files inside the roots the user granted — potentially everything the user works on.',
  risks: 'This is the user\'s machine: a wrong click or command is real and may be irreversible. Screenshots can show passwords, messages and other people\'s data. The companion can be paused by the user at any time; a paused companion offers no tools.',
  usage: [
    'Look before you act: a screenshot first, then one small step, then look again.',
    'Prefer reading a file to reading the screen; prefer a single exact shell command to driving a GUI.',
    'Never type secrets you were not given for that step; never run commands that delete, install or send without stating them in full.',
    'Stay inside the granted roots and the apps the task names; if the task needs more, say so and stop.',
    'Loops and heartbeats should only remind and prepare: real computer actions wait for the user to be present.',
  ],
  suggestedUses: [
    {
      id: 'desk-reminder',
      title: 'Weekday 09:00 "unsaved work and open items" reminder (Ask-only)',
      why: 'A narrow, approval-gated glance at the screen for unsaved documents and dialogs left open overnight — nothing is clicked.',
      grantLevel: 'read',
      fits: ['operations', 'personal'],
      loop: {
        name: 'Desk reminder',
        cron: '0 9 * * 1-5',
        prompt: 'Take one screenshot (it is approval-gated: the user may decline, which ends the loop). If it shows unsaved documents, error dialogs or windows left open, list them as a short reminder on your dashboard. Do not click, type or run anything.',
      },
    },
    {
      id: 'folder-tidy-list',
      title: 'Friday: list what landed in the granted folders this week',
      why: 'Downloads and shared folders fill up; a read-only list of new files with a suggested home for each keeps them tidy without moving anything.',
      grantLevel: 'read',
      fits: ['operations', 'personal', 'finance'],
      loop: {
        name: 'Folder tidy list',
        cron: '0 15 * * 5',
        prompt: 'List the files in each granted root modified in the last 7 days (computer_list_dir only — read nothing you do not need). Suggest where each should go. Post the list to your dashboard; move nothing.',
      },
    },
  ],
};
