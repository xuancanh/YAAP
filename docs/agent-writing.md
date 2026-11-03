# How agents write

Last updated: 2026-11-04

People read what agents write — chat replies, messages to the owner, channel
posts, task comments, status updates, briefs and reports — usually without the
context the agent had. Every agent's system prompt therefore carries a writing
guide (`writingGuide` in `server/src/chats/turn-context.service.ts`):

- plain, everyday words in full sentences; no jargon or internal codes, and a
  task key, tool or file name is explained the first time ("the pricing task
  (ENG-12)");
- lead with what matters to the reader: what happened, what it means for
  them, what is needed from them; detail after;
- warm and human, honest about uncertainty;
- one idea per sentence, short paragraphs or lists, no walls of text and no
  telegraphic fragments.

The owner picks how much agents say in **Settings › Context & budget › How
agents write to you** (`writingStyle`: `plain` — the default, a short
friendly explanation; `concise` — a few clear sentences; `detailed` — with
the reasoning). Every style keeps the same rules. Notes only the agent reads
(its journal, scratch files) may stay terse. The loop and task-wake prompts
no longer ask agents to "be concise"; they ask for plain sentences a person
can follow.
