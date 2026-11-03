# Agents message the owner

*Shipped 3 November 2026.* The owner asked: "Agents can message CEO
directly through chat. It should notify CEO and reflect in
dashboard/inbox."

An agent that has something the owner should know or decide — and that
does not fit a task, an escalation or its report — writes to the owner
with one tool. The message lands in the agent's direct chat with the
owner, the owner is notified, and Home and the Inbox show it. The owner
answers in that chat like any other conversation.

Code:

- `ChatsService.ownerChatFor(agentId)` (`server/src/chats/chats.service.ts`)
  — which session is the agent's direct chat with the owner;
  `server/src/chats/session-kind.ts` holds the one chat-vs-work rule and
  `OWNER_DM_TAG` (`docs/work-log.md`).
- `server/src/chats/owner-messages.service.ts` — `OwnerMessagesService`:
  the tool, the guardrails, the list and read marking.
- `server/src/home/inbox-messages.controller.ts` — the Inbox routes.
- SPA: `src/lib/inbox.ts` (`messageItem`, `messagesList`, the badge),
  `src/components/InboxView.tsx`, `src/components/HomeBoard.tsx`
  (`TeamMessages`).

## 1. The tool

```
message_owner { text, urgency?: 'fyi' | 'normal' | 'urgent', refs?: string[] }
```

- `text` — up to 4,000 characters, markdown allowed.
- `urgency` — `normal` by default (see §3).
- `refs` — up to ten task keys or file paths the message is about.

Every agent has it, in every session. It only talks to the owner, so it is
free internal work (`message_owner` in `FREE_INTERNAL_TOOLS`, class
`internal_write`): no Ask pause, no approval, logged like the rest.

## 2. The direct chat

Each agent has one **direct chat** with the owner: `ChatsService.ownerChatFor`,
a session of kind `chat` tagged `owner-dm`, named after the agent, private
to the owner and in Ask mode. The first message creates it; later ones reuse
it; an archived one is replaced by a new one. Being kind `chat`, it shows in
the rail, never in the agent's Work log (`docs/work-log.md`; the one
classification rule is `session-kind.ts`).

The message is written as a turn with no owner input and one assistant
message marked `toolName: message_owner`. So:

- the transcript shows it as the agent's, under a small "wrote to you"
  label — never as something the owner said;
- the text renders through the same markdown renderer as every answer,
  which builds React elements and never injects HTML; Home and the Inbox
  show it as plain text;
- when the owner replies, the model's history puts a short marker turn
  before the message ("No message from the owner here: you wrote to them
  first"), so roles alternate and the agent knows it spoke first. The reply
  is an ordinary turn.

An agent already in its direct chat is refused: it should simply answer.

## 3. Notification

Every message is an `agent_message` event in the agent's inbox (title: the
first line; payload: urgency, refs and the message id), so Telegram and
web push deliver it like other events, through the workspace's quiet hours
(`docs/permissions.md`, `workspaces/quiet-hours.ts`):

| Urgency | Outside quiet hours | Inside quiet hours |
|---|---|---|
| `fyi` | Inbox only, never pushed | Inbox only |
| `normal` | pushed now | queued until the window ends (`queue`, `allow-urgent`), Inbox only (`silent`) |
| `urgent` | pushed now, high push urgency | pushed now only when the policy is `allow-urgent`; otherwise as `normal` |

The workspace's `allow-urgent` policy is the owner's permission for urgent
interruptions. `normal` and `urgent` messages reach the paired channel
even when the agent is not the channel's default.

## 4. Guardrails

| Tunable | Default | Bound | Meaning |
|---|---|---|---|
| `seat.agentMessagesPerDay` | 10 | 0–100 | messages one agent may send in any 24 hours; 0 turns direct messages off |
| `seat.agentMessageDedupeHours` | 24 | 0–168 | the same text (whitespace and case ignored, refs included) is not sent twice within this window |

Both count the agent's stored messages, not inbox events (those are
pruned). The keys sit under `seat.*`, so an agent can only propose
changing them (`docs/boundary.md`); the owner sets them per workspace like
every tunable. A refusal says why and what to do instead (the next report,
an escalation, or wait for the reply).

## 5. Home and the Inbox

- **Home** shows **Messages from your team** after Needs you: unread
  first, at most five, with the unread count (`HomeData.messages`).
- **Inbox** has a **Messages** filter; unread messages also wait in
  **All** and count in the badge (`docs/home.md` "Inbox").
- Opening a message opens the direct chat and marks that chat's messages
  read (`POST …/inbox/messages/read`).

Messages are addressed to the owner: a member of a shared workspace sees
none of them and cannot mark them. The Inbox exists in organization mode;
without a company, Home and the agent's own inbox show the messages.

## 6. Departures

- No migration: the message is a chat row, the notification an inbox
  event, and the direct chat a tag on a session.
- Telegram replies land in the Telegram session, not the direct chat.
