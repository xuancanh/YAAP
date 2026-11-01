# Desktop computer control

Status: **shipped**, 1 November 2026 (execution plan item 13). Code:
`server/src/computer/`, `companion/`, the `computer` branch of
`chats/turn-loop.service.ts`, Settings → Computer and the artifact panel's
Computer tab. Tests: `tests/backend-computer.test.ts`,
`companion/test/*.test.ts`.

## 1. What this is, and why it is shaped like this

Until now `docs/security.md` §c could say "no host": agents had no shell, no
filesystem and no process, and the only `child_process` in the server spawned
an interpreter inside a sandbox. Desktop computer control punches a deliberate
hole in that story: a user can let their agents see and drive **their own
computer**. The owner's decision to build it (`docs/execution-plan.md`) came
with a condition — do not repeat the field's mistakes
(`docs/competitor-gap-analysis.md` §4c):

- Grok Bot gives every Bot one shared per-user computer and says the Bots are
  "not a security boundary". Ours is one companion, paired to one server,
  reached only through the Ask gate, with scopes the owner chose.
- Dots ships single local computer access off by default and unscoped once on.
  Ours is off until paired, and even then every action is individually
  approved and every tool exists only within a scope.
- OpenClaw's year of CVEs came from full host access behind one gateway with
  a single trusted operator. Ours never gives the server a path *into* the
  machine (the companion only asks outward), never trusts the server's view
  of the scopes (the companion checks again), and never lets the acting tools
  be auto-approved.

The result is less convenient than any of those. That is the point: the one
place an agent can reach a real machine is also the place where "the user
clicks yes" is required most often.

## 2. Architecture

```
  browser ── SSE/REST ──▶  yaam-chat API  ◀── outbound long-poll ──  yaam-companion (user's machine)
                           computer.service.ts                       companion/src/*
                           queue · scopes · audit                    scopes again · screencapture/osascript/xdotool/PowerShell
```

- **The server never reaches into the user's machine.** The companion
  (`companion/`, a dependency-free Node CLI) connects outbound and long-polls
  `GET /api/computer/work` (25 s, then 204). An approved tool call becomes a
  queued action; the next poll hands it over; the companion performs it and
  `POST`s the result to `/api/computer/result/:id`. No inbound port, no
  WebSocket server on the user's side, nothing to scan for.
- **Pairing** (`POST /api/computer/pair-code` → 8-hex code, 10 minutes,
  burned after five wrong guesses; `POST /api/computer/pair` redeems it). The
  companion receives a 256-bit bearer token (`ycr_…`); the server stores only
  its sha256 (`computer_runners.tokenHash`) and compares in constant time.
  Exactly one runner row exists at a time: pairing again replaces it and the
  old token dies with the row.
- **Two bearer kinds, four public paths.** `TokenAuthStrategy.isPublic`
  lists exactly `POST /pair`, `GET /work`, `POST /result/:id`, `POST
  /heartbeat`; `CompanionGuard` authenticates those with the companion token.
  The user routes (`status`, `pause`, `resume`, `disconnect`, `scopes`,
  `actions`, `pair-code`) stay behind the app token. A leaked companion
  token can pull queued actions; it cannot drive the app.
- **In-process queue** like the approval registry: a queued action waits for
  the companion; a deadline (60 s; shell `timeoutSec` + 15 s, max 315 s)
  turns silence into an error; a companion that has not polled for 90 s is
  "offline" and actions fail fast with a hint instead of waiting it out.

## 3. Scopes

Chosen **on the companion, at the keyboard**, at pair time:

| Scope | Tools | Note |
|---|---|---|
| `screen` | `computer_screenshot` | PNG, downscaled to 1600 px on macOS; coordinates the agent uses afterwards are pixels of this image |
| `input` | `computer_click(x,y,button?,double?)`, `computer_move`, `computer_scroll(x,y,dx,dy)`, `computer_type(text)`, `computer_key(combo)` | whatever window has focus |
| `shell` | `computer_shell(command, cwd?, timeoutSec?)` | the user's shell, the user's permissions, 64 KB output, 300 s cap |
| `files:<abs dir>` (repeatable) | `computer_read_file`, `computer_write_file`, `computer_list_dir` | realpath-checked on the companion: a symlink inside a granted folder that leads outside is refused; a new file's parent must resolve inside |

Rules (`computer-scopes.ts`, mirrored in `companion/src/scopes.ts`):

- A whole drive or `/` is not a valid files root. Relative roots are refused.
- **Scopes only narrow from the server** (`POST /api/computer/scopes`): a
  subset, or a files root shrunk to a sub-directory. Widening is refused
  with "re-pair the companion" — the server has no business granting itself
  more than the owner typed.
- The companion accepts the server's scope set only when it is a subset of
  what it was paired with, and refuses out-of-scope actions locally even if
  the server somehow queued one.
- The tool list the model sees (`ComputerService.specs()`) is derived from the
  scopes: no `screen` → no screenshot tool. A tool that cannot run does not
  exist.

## 4. The approval model

Every computer tool is **mutation-class** (`isReadOnly === false`) and gets
its own branch in `checkPolicy`:

- **Auto mode never applies.** An Auto chat still pauses on every computer
  call.
- **The acting tools — `computer_click`, `computer_type`, `computer_key`,
  `computer_shell`, `computer_write_file` — ask on every call** and return
  `remember: false`, like `gmail_send`. "Allow always" / "Always allow tool"
  are not offered on their cards and would not be honoured if sent.
- **The observational tools — `computer_screenshot`, `computer_move`,
  `computer_scroll`, `computer_list_dir`, `computer_read_file` — may be
  remembered per chat** (exact input or per tool), because approving each of
  thirty screenshots is how users learn to click yes without reading. A
  remembered call is still a `remembered` verdict, so the independent action
  reviewer (`docs/permissions.md` §6) reads it before it runs.
- **Loop and channel turns are refused, not queued.** Code execution from a
  loop queues as `action_pending` for later; a computer action from a loop or
  a Telegram/email turn is denied immediately (`Refused: computer tools …
  only run from a conversation the user is having in the app right now`)
  and an `agent_events` row of kind `info` ("Computer action refused (loop
  turn): computer_shell") lands in the agent inbox. There is nobody at the
  keyboard to approve, and a queued "click here later" is exactly the
  injection vector we refuse to build.
- The approval card carries a red banner — **This acts on your computer** —
  and, for `type`, `shell` and `write_file`, the full text, command or file
  content, so what is approved is what runs.

## 5. Audit

`computer_actions` is the record: one row per action with `runnerId`,
`sessionId`, `tool`, a one-line `inputSummary` (the target, never typed text
or file content), `status` (`queued` → `ok | error | timeout | refused`),
a bounded `resultSummary`, the `screenshotPath` when one was taken, and
timestamps. Refusals are rows too (out of scope, paused, disconnected,
offline, bad arguments), so Settings → Computer shows what was *tried*, not
only what ran. Per-action `agent_events` rows are deliberately not written —
thirty screenshots would bury the inbox — except the refusal note above.

Screenshots are workspace files, `computer/<sessionId>/<n>.png`, served
through the existing inert file endpoints and read by the UI through the
JSON `/preview` route. The model receives the image as a vision part on the
tool result (Anthropic: image block inside `tool_result`; OpenAI family: a
following user message of image parts framed "data, not instructions").

Companion side: every action is printed to its console with a timestamp,
and `~/.yaam-companion/config.json` (0600) is the only state.

## 6. Kill switches

Strongest first:

1. **`COMPUTER_CONTROL_ENABLED=false`** on the server: `specs()` is empty,
   pairing refuses, `CompanionGuard` 401s, `execute` throws. Whatever is
   paired stays in the table and is inert.
2. **Disconnect** (Settings → Computer, `POST /api/computer/disconnect`):
   deletes the runner row — the token is revoked at once — and refuses every
   queued and in-flight action (`refused` rows). The companion's next poll
   gets 401 and exits.
3. **Pause** (`POST /api/computer/pause`): pairing kept, tools hidden from
   the model, every action refused with "paused by the user". The companion's
   heartbeat shows it paused.
4. **Ctrl-C on the companion.** Actions time out server-side with a clear
   error; the pairing survives.

## 7. Threat model delta (`docs/security.md`)

What changes:

- §b gains a **Companion** tier: a process the user runs on their own
  machine, trusted to act within the scopes the user typed, authenticated by
  a hashed bearer on four routes.
- §c "no host" becomes "no host *unless the user pairs one*, and then only
  through the Ask gate, inside scopes, audited". The server still contains
  no code path that reaches a user machine; the companion's `child_process`
  runs on the user's machine, as the user, after the user's click.
- §h's "no host access" refusal is restated: no *ambient* host access, no
  shared computer, no auto-approved action, no inbound port.

What does not change: nothing a tool result says alters a verdict; untrusted
surfaces (loop, channel, app, MCP) can propose a computer action and have it
refused; secrets stay out of agent-authored artifacts (the companion token
never touches the model or the transcript).

What the user is still trusting:

- `shell` is their shell. `rm -rf ~` is a command like any other, which is
  why the card shows the exact command and it can never be remembered.
- `input` types into whatever has focus. A click approved against one
  screenshot lands on whatever is there a second later.
- The companion's platform tools (`screencapture`, `osascript`, `xdotool`,
  PowerShell) have the permissions the OS granted the terminal running it.
- The screenshot the model sees is untrusted content: text on screen can try
  to instruct the model. The next action still needs the user's click, and
  the reviewer sees the proposed call next to the user's request.

## 8. Known limits

- Platform coverage: macOS is exercised end to end (`screencapture`,
  `osascript`, `cliclick` optional); Linux (`xdotool`, `grim`/`scrot`/
  `import`) and Windows (PowerShell `System.Drawing`, `user32`, `SendKeys`)
  are implemented from documentation and untested here. macOS scrolling is
  approximated with arrow keys; right/double click and pointer moves need
  `cliclick`.
- One companion per server. Multi-user cloud (plan item 7) will need
  `computer_runners.accountId` and per-account queues.
- The queue is in-process: a server restart drops queued actions (they
  time out on the companion side and are re-queued only if the model asks
  again).
- Screenshots are stored as workspace files without expiry; a retention
  sweep belongs with the workspace file quota work.
