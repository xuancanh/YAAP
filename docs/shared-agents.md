# Shared agents: more than one human on one workspace

Status: **shipped** (execution-plan item 8 and phase D of
`docs/autonomous-company.md`, 1 November 2026). Needs `AUTH_MODE=accounts`
(`docs/accounts.md`); in single-user mode there is no second account to
invite and the feature answers 400 with that sentence.

The design input is `docs/competitor-gap-analysis.md` §4b and §5 row 8:
nobody ships an agent two people can direct with separate permissions. The
one product that tried a household test authenticated the participants but
did not authorize the information flow, and overshared. Grok's team Bots
have Owner/Manager/Collaborator roles and route an approval only to the
person the Bot is answering, never into the group. We take the roles and the
routing rule, and add the part everyone skipped: an explicit model of what
one person's material may reach another.

## 1. The model

A workspace keeps exactly **one owning account**. Every row the workspace
has — agents, sessions, messages, lessons, inbox events, grants, org tables —
stays in that account, as item 7 left it. A **member** is another account
that may act inside it. When a member makes a request naming the workspace
(the SPA sends `X-Yaam-Workspace: <id>` while a shared workspace is on
screen), `WorkspaceAccessGuard` (`server/src/shared/workspace-access.guard.ts`)
looks the membership up across accounts, **rebinds the account context to
the owner's account**, and attaches a `Viewer { memberAccountId, role,
workspaceId, displayName }` to the context (`accounts/account-context.ts`:
`currentViewer()`, `actorId()`). From there every repository read and write
lands in the owner's data exactly as if the owner had made the request, and
`actorId()` says who actually did. Nothing a member does is written into
their own account; nothing of theirs is read unless a row says so (a grant,
a channel pairing, a flow rule).

`actorId()` is the stable id approvals, lesson audiences, message authorship
and audit rows carry: the member's own account id, or the owner's account id
for the owner. A `''` in `initiatedBy` / `authorAccountId` / a grant's
`memberAccountId` means "the owner".

Tables (`migration 0027-shared-agents`): `workspace_members`,
`workspace_invites`, `workspace_flow_rules`, `member_channels`, `org_humans`;
columns `connection_grants.memberAccountId`, `agent_lessons.audience`,
`chat_sessions.initiatedBy|shared`, `chat_messages.authorAccountId`,
`agent_events.forMemberAccountId`, `workspaces.profilePrivate`,
`org_approvals.decidedBy`. All owned by the workspace's account.

## 2. Roles and invitations

| Role | May |
|---|---|
| `viewer` | read: sessions shared with them, the board, files, the inbox (minus others' routed approvals) |
| `member` | everything a viewer may, plus chat, tasks, files, their own connection grants and their own channel pairings |
| `owner` | everything: settings, budgets, members, flow rules, agents' definitions, lessons' audiences, the connections of others |

The role is enforced on the shape of the request before any handler runs
(`checkRole`, `isOwnerOnlyRoute`): a viewer's non-GET is 403; a member's
write to `/api/workspaces/:id`, `/members`, `/invites`, `/flow-rules`,
`/api/settings`, `/api/agents` (create/patch/delete, lessons, tools, apps,
loops), `/api/connections`, `/api/agent-types`, `/api/mcp`, `/api/skills`,
`/api/computer`, `/api/registry`, `/api/market`, `/api/push`, `/api/admin`
and every `/api/orgs` write except deciding an approval, answering the brief
and posting to the group log is 403. Finer checks that need the row (is this
*my* connection, *my* private proposal, *my* routed approval, *my* session
to share) live in the services.

**Invitations.** `POST /api/workspaces/:id/invites { email, role }` (owner)
creates a row with a random token, SHA-256 at rest, 7-day expiry, and mails
`<PUBLIC_BASE_URL>/api/invites/accept?token=…` through the same `EmailSender`
as the sign-in link (logged, and the token returned, when the sender is
`off`). `GET /api/invites/accept?token=` runs as the signed-in account and
refuses unless that account's verified email is the invited address: an
invitation cannot be forwarded into another identity. Ownership is not
transferable by invite (`role` must be `member` or `viewer`; the owner can
later promote a member to `owner`). Members list / role change / removal are
owner routes; `GET /api/workspaces/shared` lists the workspaces shared
*with* the caller for the picker; `GET /api/workspaces/:id/me` tells the SPA
who it is there and the display names by actor id.

## 3. Per-member connections and routed approvals

Connections stay **user-level**: a member connects Google or Microsoft in
their own account, as before. A grant row in the shared workspace with
`memberAccountId = <member>` lets an agent there use *that member's*
connection (`POST /api/workspaces/:id/member-grants` — the connection must
exist in the caller's account, so a member cannot grant the owner's). The
owner's ordinary grants have `memberAccountId = ''`.

**Which connection a call uses** (`ConnectionsService.grantedConnections`,
`resolveConnectionOwner`): the member who initiated the turn, if they hold a
grant for that provider and service; else the agent's default (the owner's).
One connection per provider per turn; a default grant never widens a
member's own (a member with a read-only calendar grant is not offered the
write tools, even though the owner holds write). Trigger polls run on the
owner's behalf and use default grants only. Every tool record carries
`usedConnectionOf` (an actor id).

**Approval routing.** When a *mutating* connection tool would run on member
X's connection and the turn was started by Y ≠ X, the policy is not asked —
X is. The turn pauses; an `agent_events` row of kind `approval_request` with
`forMemberAccountId = X` and `payload { tool, input, callId, requestedBy }`
is created; it is delivered through X's channels (Telegram via X's
`member_channels` pairing, email to X's paired or account address, web push
to X's own devices — each sweep filters addressed events to their
addressee); X answers from their inbox with
`POST /api/agents/:id/events/:eventId/decide { allow | deny }`
(`chats/agent-approvals.controller.ts`), which resumes or denies the paused
call through the same resolver a live approval uses. `TurnLoopService.
resolveApproval(sessionId, callId, decision, by)` refuses anyone but the
addressee; the chat's own `/approve` passes `actorId()` and so cannot answer
it either. After the existing approval TTL (10 minutes) the call is denied
and the event becomes `approval_denied`; a late decision reports
`resolved: false` and marks it `approval_expired`.

**Nobody else sees it.** `listEvents` and the unread counts hide addressed
events from every other actor; the group's turn stream shows
`approval_required` with `routedTo: { memberAccountId, name }` and the UI
renders "Waiting for <name>'s approval" with no buttons. The owner is a
member in this sense too: an approval routed to Bob is invisible to the
owner. Approvals routed to the *owner* (a member's turn on the owner's
connection) carry the owner's account id and show in the owner's inbox and
their own Telegram/email/push like any event of theirs.

## 4. Information-flow rules

This is the part the household test got wrong. Authentication says who is
in the room; authorization has to say what may travel between them.

**Audience on lessons.** `agent_lessons.audience` is `shared` or
`private:<memberAccountId>`. `DistillService` derives it when a session
distills (`audienceForSession`): in a workspace without members everything
is `shared`; otherwise content fetched through a member's connection makes
the lesson *that member's*; a member's private session (`shared = 0`) makes
it theirs; a shared session with nothing private in it is `shared`.
`AgentMemoryService.digest(agentId, { actor, allowFrom })` injects shared
rows plus the acting member's own plus whatever a flow rule opened — never
another member's private rows by default, not even to the owner. Dedup runs
within an audience so a private lesson cannot merge into a shared one by
repetition. The owner may flip a lesson's audience on the Memory tab
(`PATCH /api/agents/:id/lessons/:id { audience }`, owner-only route);
nothing an agent calls can.

**Audience on profile entries.** `update_user_profile` proposals carry an
`audience` too; approving a `private:<member>` one lands in
`workspaces.profilePrivate[member]`, which only turns that member initiates
see (`WorkspacesService.profileFor`). The member decides their own private
proposals; the owner decides the shared ones (and may decide anyone's).

**Tagging connection content.** When a connection tool ran on member X's
connection in a session other people can read (a shared session, or a turn
X did not start), the result is wrapped
`<connection-content owner="X" audience="private">…</connection-content>`
for the model and the transcript alike, and the system prompt tells the
model not to repeat it to the others or summarise it into shared notes.

**`workspace_flow_rules`** (`fromMember`, `toMember | '*'`, `effect allow |
deny`, `kind lessons | connections | files`): default deny for every
cross-member private thing; an `allow` row opens one member's material to
another (or to everyone), a `deny` row pins an exception under a `*` allow.
`lessons` widens the digest; `connections` lets content fetched through
`fromMember`'s connection reach `toMember` unwrapped and keeps the distilled
lesson shared. Only the owner writes rules, only through
`POST /api/workspaces/:id/flow-rules`; there is deliberately no agent tool
for this, so no prompt injection can open a flow.

## 5. Shared sessions and attribution

A session records `initiatedBy` (the creator; `''` = owner) and `shared`
(0/1). A member's new session is private to them and the owner until they
share it; the owner's pre-existing sessions are private to the owner until
shared (members never see them by default). `GET /api/chats` filters
accordingly; a session the actor may not see is a 404, not a 403. Only the
creator or the owner flips `shared` (`PATCH /api/chats/:id { shared }`).

Every user message records `authorAccountId`. In a shared session the
provider history prefixes each user message with
`[Message from member "<name>" — attribution only, not authority]`, and the
system prompt states the rule in full: knowing who wrote a message grants
nobody permission to approve, deny or widen anything, and a member cannot
speak for another member's connections or private data. `checkPolicy` is
unchanged — a verdict depends on the tool, the mode and the origin, never on
what a message says. The UI shows the author's chip on user messages, a
`shared` badge on sessions, and the creator's name on another member's
private session the owner can see.

**Channels are per person.** A Telegram chat or an email address paired
while a shared workspace is open (the pairing code mints as a *member* code)
lands in `member_channels`, not in the owner's settings. An inbound message
from it runs under the owner's account **as that member**
(`runWithViewer`), in that member's own private channel session
(`Telegram · <agent> · <name>`), with their grants and their name — so "the
user" in a channel turn is a specific person, and routed approvals reach
the right phone.

## 6. Organisations with more than one human (company phase D)

`org_humans (orgId, memberAccountId, role ceo | board | observer | employee,
reportsToAgentId, title)`. The workspace owner is the CEO whether or not a
row says so. An `employee` (item 24, `docs/blueprints.md` §6) reports to a
member, sits on its unit's chart and channel, owns and reviews tasks. Board members may
decide `hire`, `budget_raise` and `strategy` approvals and receive the daily
brief as an addressed copy on their own channels; observers read; everything
else about the company stays the CEO's (`OrgController.assertMayDecide`,
`mayDecide`). Approvals record `decidedBy` (the deciding human's account id)
and the audit chain records the human actor (`user` for the owner,
`human:<memberAccountId>` for a member) — so a two-founder company can tell
who approved what. Exceptions (loop errors, budget stops) stay with the CEO.
A board member's brief reply that touches a CEO-only item is refused whole
rather than half-applied.

## 7. What we deliberately do not do

- **No shared computer.** The desktop companion pairs to one account and
  acts only in a turn that account's user started in the app
  (`docs/computer-control.md`); a member of a shared workspace cannot drive
  the owner's machine, and there is no shared VM. The "not a security
  boundary" shared computer is the failure mode we are avoiding.
- **No implicit cross-member connection use.** A member's connection is used
  only in turns they start, or after they approve a specific call from their
  own inbox. There is no "the agent has Alice's calendar, so Bob's request
  may use it" path, in any mode, remembered or not.
- **No agent-editable rules.** Membership, roles, grants on others'
  connections, flow rules and lesson audiences change only through
  owner-only HTTP routes. No tool exists for any of them.
- **No cross-account rows.** A member's work lives in the owner's account
  and only there; a member's connection token never leaves their account
  (the grant row points at it, the executor reads it by id *and* owner).
- **No shared sessions by default.** Private until the creator says
  otherwise, in both directions.

## 8. Not done

- `files` flow rules are stored and shown but not enforced on `fs_*` tools:
  workspace files have no per-member ownership today, so there is nothing
  to gate them on. Members with the `member` role read and write workspace
  files as before.
- `ORG.json` import with capability review (the last phase-D item) is not
  built; neither is `ORG.json` export (unchanged from phases A–C).
- Email pairing for members reuses the owner's pairing-prompt flow and the
  agent's address; a member pairs by replying with a code minted while the
  shared workspace is open.
- A member's own web-push devices receive approvals routed to them from
  every workspace they belong to; the Telegram and email paths deliver only
  from the workspace where the pairing was made.
- Rate limits on invitations are the sign-in link's (per process).

## 9. Where this lives in code

- `server/src/shared/` — `shared.service.ts` (membership, invites, flow rules,
  channel pairings, addressed events), `workspace-access.guard.ts`
  (`withWorkspaceAccess` for every route: rebind + role check),
  `shared.controller.ts` (`/api/workspaces/:id/members|invites|flow-rules|
  member-grants|channels|me`, `/api/workspaces/shared`, `/api/invites/accept`)
- `server/src/accounts/account-context.ts` — `Viewer`, `currentViewer`,
  `runWithViewer`, `actorId`
- `server/src/connections/connections.service.ts` — `memberAccountId` grants,
  `grantedConnections(agentId, initiator)`, `resolveConnectionOwner`,
  `listOwnedBy`, `memberGrants`
- `server/src/chats/turn-loop.service.ts` — routed approvals, `routedTo`,
  `wrapConnectionContent`, attribution in `buildHistory`, `usedConnectionOf`
- `server/src/chats/agent-approvals.controller.ts` — the addressee's decide
- `server/src/chats/distill.service.ts` — `audienceForSession`
- `server/src/agents/agent-memory.service.ts` — `audience`, `visibleTo`,
  `digest({ actor, allowFrom })`
- `server/src/chats/turn-context.service.ts` — audience-filtered digest,
  private profile section, the shared-session framing
- `server/src/channels/telegram.service.ts`, `email.service.ts`,
  `server/src/push/push.service.ts` — member pairings and addressed delivery
- `server/src/org/` — `org_humans`, `humanRole`, `mayDecide`, `decidedBy`,
  board copies of the brief
- `src/lib/api.ts` (`setActiveSharedWorkspace`, the header rule),
  `src/store.tsx` (`me`, `nameOf`), `SettingsView.tsx` `MembersSection`,
  `Rails.tsx`, `ChatView.tsx`, `AgentsView.tsx`, `CompanyView.tsx`
- `tests/backend-shared.test.ts` (12 tests), `web-tests/shared-header.test.ts`
