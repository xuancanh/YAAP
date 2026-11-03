# Coding harnesses: `code_agent`

Agents can hand multi-step coding work to an external coding-agent CLI —
**Claude Code**, **OpenAI Codex**, **Pi**, or **DeepSeek** (the Claude
Code CLI on DeepSeek's Anthropic-compatible API). The CLI works in a
private copy of one workspace folder. When it finishes, the files it
changed are synced back through WorkspaceFs as the agent.

The code is in `server/src/harness/`, the settings UI in
`src/components/CodingAgents.tsx`, and the tests in
`tests/backend-harness.test.ts` and `web-tests/coding-agents.test.tsx`.

## 1. Research (verified 2026-11-02)

Every flag used here comes from the CLI's own documentation. Items marked
*unverified* could not be confirmed from the docs and are handled
defensively. Tests never run a real CLI or touch the network.

### Claude Code (`claude`, npm `@anthropic-ai/claude-code`)

Docs: [CLI reference](https://code.claude.com/docs/en/cli-reference),
[headless](https://code.claude.com/docs/en/headless),
[Agent SDK message types](https://code.claude.com/docs/en/agent-sdk/typescript),
[env vars](https://code.claude.com/docs/en/env-vars).

- **Headless run:** `claude -p` takes the prompt as an argument or on
  stdin. `--output-format text|json|stream-json`; `stream-json` needs
  `--verbose`.
- **Events:** one JSON object per line.
  - `system/init` carries `model`, `tools`, `session_id` and
    `claude_code_version`.
  - `assistant` messages wrap an Anthropic `message` (with `id`,
    `content`, `usage`) and a `parent_tool_use_id`, which is null in the
    main loop.
  - `user` messages carry `tool_result` blocks.
  - `system/api_retry` reports retries.
  - The last line is `result`, which has `subtype` (`success`,
    `error_max_turns`, `error_during_execution`, `error_max_budget_usd`,
    …), `is_error`, `num_turns`, `result` (on success) or `errors[]`,
    `total_cost_usd` (a client-side estimate from Anthropic prices),
    `usage`, `modelUsage` and `permission_denials`.
- **Limits:** `--max-turns N` and `--max-budget-usd N` (print mode only).
- **Model:** `--model <alias|id>` takes priority over `ANTHROPIC_MODEL`.
- **Permissions:**
  - `--permission-mode` takes `default|acceptEdits|plan|auto|dontAsk|bypassPermissions`.
    In `-p`, anything that would prompt is denied.
  - `--tools "Read,Edit"` restricts the built-in tool set.
  - `--allowedTools` / `--disallowedTools` take permission rules.
- **Isolation:**
  - `--setting-sources user,project,local` chooses which settings load.
  - `--strict-mcp-config` uses only the servers given in `--mcp-config`.
  - `--no-session-persistence` keeps the session off disk.
  - `--bare` skips hooks, plugins, MCP and CLAUDE.md, and also skips
    OAuth and the keychain. That rules it out for the CLI-login mode,
    so we don't use it (see §3).
- **Auth:**
  - `ANTHROPIC_API_KEY` is the `X-Api-Key` header; in `-p` it always wins
    over a login.
  - `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer`.
  - `ANTHROPIC_BASE_URL` sets the endpoint.
  - `CLAUDE_CONFIG_DIR` moves the config dir.
  - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` turns off telemetry,
    auto-update and similar traffic.
- **Version:** `claude --version`.

### OpenAI Codex (`codex`, npm `@openai/codex`)

Docs: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[CLI reference](https://learn.chatgpt.com/docs/cli/reference).

- **Headless run:** `codex exec "<task>"`; `codex exec -` reads the
  prompt from stdin. The read-only sandbox is the default.
- **Flags:**
  - `--json` prints JSONL events.
  - `--sandbox read-only|workspace-write|danger-full-access`.
  - `--skip-git-repo-check`, `--ephemeral` (no rollout files),
    `--ignore-user-config` (skip `$CODEX_HOME/config.toml`).
  - `--cd`, `--model`, `-c key=value` (repeatable),
    `--output-last-message`.
  - `--full-auto` is **gone**; `--approve-for-me` replaces it.
- **Events:** `thread.started`, `turn.started`,
  `item.started|completed`, `turn.completed`, `turn.failed` and `error`.
  - Item types include `agent_message` (`text`), `command_execution`
    (`command`) and `file_change`.
  - `turn.completed.usage` has `input_tokens`, `cached_input_tokens`,
    `output_tokens` and `reasoning_output_tokens`.
  - *Unverified:* field names beyond the documented examples (such as
    `file_change.changes[].path`); the parser tolerates their absence.
- **Approval:** `--ask-for-approval` is not listed for `exec`, so we set
  `-c approval_policy="never"`. This config key is *unverified* for
  current versions. With no approver, exec cannot prompt anyway.
- **Auth:** `CODEX_API_KEY` is meant for one `exec` invocation;
  otherwise the saved login in `$CODEX_HOME/auth.json` (default
  `~/.codex`).
- **Custom endpoint:** `model_providers.<id>.{base_url, env_key, wire_api}`
  in config, passed here as `-c` overrides.
- **Cost and turns:** Codex reports tokens only (no dollar cost) and has
  no max-turns flag.

### Pi (`pi`, npm `@earendil-works/pi-coding-agent`; formerly `@mariozechner/pi-coding-agent`, repo badlogic/pi-mono)

Docs: [README](https://github.com/earendil-works/pi),
[cli.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md),
[json.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md),
[providers.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md),
[models.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md),
[configuration.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md).

- **Headless run:** `pi --mode json "<prompt>"` is one-shot: it writes a
  session header and events, then exits. `--` stops option parsing, so
  a prompt can start with `-`.
- **Flags:**
  - `--provider <name>` (requires `--model`), `--model <pattern>`,
    `--api-key`.
  - `--no-session`.
  - `-t/--tools a,b` allowlist. The default tools are read, bash, edit
    and write.
  - `--no-extensions`, `--no-skills`, `--no-prompt-templates`.
  - `--no-approve` ignores trust-gated project config.
  - `--version`.
- **Events:** `agent_start`, `turn_start`, `turn_end`, `agent_end`,
  `message_start|update|end` and `tool_execution_start|update|end`.
  - `tool_execution_start` carries `toolName` and `args`.
  - Assistant messages carry `usage` with
    `cost{input,output,cacheRead,cacheWrite,total}`, so Pi reports cost.
- **Providers:** DeepSeek is built in (`DEEPSEEK_API_KEY`), as are
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY` and others.
- **Custom endpoint:** an OpenAI-compatible endpoint is a `models.json`
  provider (`baseUrl`, `api: "openai-completions"`, `apiKey`, `models`).
- **Config dir:** `~/.pi/agent`, or wherever `PI_CODING_AGENT_DIR`
  points.
- **Sandbox:** Pi documents no sandbox or permission prompts. Assume its
  tools run unsandboxed — the OS sandbox (§3) matters most here.

### DeepSeek — the decision

DeepSeek has no first-party coding CLI of the Claude Code kind, but on
13 August 2026 it open-sourced **DeepSeek Harness (`dsh`)**, a
plugin-composed harness. By default it uploads the session log and plugin
inventory in the model request body (see `docs/plugins.md` §9). It is not
wired as a harness here.
[DeepSeek's coding-agents page](https://api-docs.deepseek.com/guides/coding_agents)
lists third-party agents (Claude Code, Codex, OpenCode, …) and a
developer-preview "DeepSeek Harness" for harness authors. DeepSeek
documents an
[Anthropic-compatible API](https://api-docs.deepseek.com/guides/anthropic_api)
at `https://api.deepseek.com/anthropic`, and an
[official Claude Code setup](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)
that sets these variables:

- `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`;
- `ANTHROPIC_MODEL`;
- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`;
- `CLAUDE_CODE_SUBAGENT_MODEL`.

**We chose Claude Code pointed at DeepSeek.** It is the integration
DeepSeek itself documents, and it reuses the best-tested stream format
and permission model we already drive. The `deepseek` harness runs the
`claude` binary with exactly those variables:

- `ANTHROPIC_BASE_URL` defaults to the DeepSeek URL and can be
  overridden.
- The key goes in `ANTHROPIC_AUTH_TOKEN`, with no `ANTHROPIC_API_KEY`.
- Every model slot gets the chosen model. The default is
  `deepseek-v4-pro`; DeepSeek also serves `deepseek-flash`.

There are two caveats:

1. Claude Code's `total_cost_usd` and `--max-budget-usd` use Anthropic
   prices, so for DeepSeek we omit the budget flag. Cost is estimated
   from the streamed token usage and the price table
   (`server/src/ai/pricing.ts`), and the cost cap watches that estimate.
2. DeepSeek's endpoint ignores some Anthropic features (`cache_control`,
   MCP content blocks).

Two alternatives also work, and are documented by DeepSeek: Pi with
`provider: deepseek`, and Codex through a custom `model_providers` entry.
Both are reachable with this design (Pi's provider setting; Codex's base
URL).

## 2. Design

One tool, **`code_agent { harness, task, folder?, model?, maxTurns? }`**,
not one tool per harness:

- The choice of harness is data, not a different capability.
- One tool keeps the tool list short and the gate, ledger class and
  reviewer rule in one place.
- `harness` is an `enum` narrowed to what this agent may use right now:
  enabled, allowed for the agent, detected on the machine, and keyed.

The description tells the model to use it for multi-step coding in a
folder. For a quick computation it should use `run_js` / `run_python`;
for one edit, `fs_edit`.

A run (`HarnessService.run`) goes through these steps:

1. **Detect** — the configured binary path, or the first executable named
   `claude` / `codex` / `pi` on the search path. `<bin> --version` runs
   in a throwaway directory and is cached for a minute; *Re-check* forces
   a new check.
2. **Materialise** — create `mkdtemp()/` containing `work/` (the folder's
   files copied out of WorkspaceFs), `home/` (the CLI's HOME and config
   dir for API-key runs) and `tmp/`. The copy is capped at 2,000 files,
   100 MB in total and 10 MB per file. A file too large to copy is
   recorded, and writes to it are refused.
3. **Build the command** (`harness-commands.ts`):
   - the task goes on stdin for Claude and Codex, and after `--` for Pi;
   - the key goes in the environment only, never in argv;
   - the environment is built from scratch: `PATH` (the CLI's dir and
     node's), `HOME`, `TMPDIR`, `LANG`, `TERM`, `NO_COLOR`, and the
     harness's own variables. Nothing is inherited from the server.
4. **Spawn** in its own process group with `cwd = work/`, optionally
   wrapped in the OS sandbox (§3).
5. **Stream** — parse the JSONL into short progress lines (tool calls,
   commands, file edits, text). They reach the chat as `tool_progress`
   events, and the tool card shows the latest lines.
6. **Watchdogs** — the run is stopped (SIGTERM to the group, SIGKILL
   3 seconds later) on any of these:
   - the timeout;
   - max turns. Claude counts main-loop assistant messages, Codex counts
     steps (commands, file changes, tool calls), Pi counts `turn_start`.
     Claude also gets `--max-turns`.
   - the cost cap: reported cost (Claude Code, Pi) or the token estimate
     (Codex, DeepSeek). Claude Code also gets `--max-budget-usd`.
   - 2 MB of stdout;
   - the chat's **Stop** (the turn's abort signal).
7. **Sync back** (`harness-workdir.ts`) — each new or changed regular
   file goes through `WorkspaceFs.write`:
   - it is written as the agent, with
     `expectedVersion = the version copied out`. A file someone changed
     during the run is reported as a conflict and never clobbered.
   - a file that disappeared is deleted through `WorkspaceFs.delete`,
     which keeps a revision, so `fs_restore` brings it back;
   - a permission error is reported as *refused*, for example in another
     agent's home;
   - symlinks and special files are never followed or synced;
   - `.git/`, `node_modules/`, `.venv/` and `__pycache__/` are not
     synced;
   - at most 500 files are synced per run.

   A **stopped** run discards its changes; every other ending syncs what
   was done.
8. **Clean up** — delete the temp dir. Return a concise result: the end
   state, turns, tokens, cost, the CLI's final summary (capped), and the
   changed files (`A`/`M`/`D` with versions), refusals and conflicts.

At most three runs execute per server process at a time.

## 3. Security model

- **No real paths.** The CLI's working directory is a temp copy of one
  workspace folder. The workspace root is refused. The repo, the
  server's cwd and the S3 store are never exposed. Writes reach the
  workspace only through WorkspaceFs, under its permission table, so an
  agent can write its own home and shared folders such as `/org/`. Every
  change is versioned and attributed to the agent.
- **OS sandbox (default on).**
  - On macOS it uses Seatbelt (`sandbox-exec`): reads are allowed, and
    every write is denied except under the run directory and `/dev`.
  - On Linux it uses bubblewrap: `--ro-bind / /`, the run dir
    bind-mounted writable, `--unshare-all --share-net`.
  - The network stays on, because the CLI must reach its model.
  - A test checks that the jail blocks a write outside the run dir on
    machines that have one.
  - If the sandbox is on but unavailable, runs are refused rather than
    run unjailed. The owner can turn it off per harness.
- **Reads.** Like `run_js`'s local backend, Seatbelt allows reads, so a
  sandboxed CLI can still *read* the host disk. Keep that in mind with
  the *Files and shell* mode on a shared host. Codex additionally
  applies its own sandbox (`--sandbox`).
- **Secrets.**
  - Keys are sealed at rest (secretbox, `TOKEN_ENCRYPTION_KEY`) in the
    `harness.config` row.
  - That row is hidden from `GET /api/settings` and cannot be written
    through `PUT /api/settings`.
  - `GET /api/harness` returns only `hasApiKey`.
  - Keys enter the child's environment only, never argv. Any occurrence
    of a key in progress lines, the final text or stderr is replaced with
    `[redacted]`.
  - The server's own environment (database URL, tokens) is never passed.
- **Workspace config is not trusted.**
  - Claude runs with `--setting-sources user` and `--strict-mcp-config`,
    so a `.claude/settings.json` or `.mcp.json` planted in the folder
    cannot add hooks or servers.
  - Codex runs with `--ignore-user-config` in API-key mode, and its
    `CODEX_HOME` is the run's own empty dir.
  - Pi runs with `--no-extensions --no-skills --no-prompt-templates --no-approve`.
- **CLI login mode** (`auth: cli_login`) is weaker by design. The CLI
  uses this machine's real HOME and config dir, which the sandbox then
  also lets it write, so the CLI's own user settings apply. DeepSeek has
  no login mode.
- **Gating** (docs/permissions.md §8 table):
  - `code_agent` is `internal_write` like `run_js`, and not in
    `FREE_INTERNAL_TOOLS`.
  - Ask mode pauses on every call. Auto mode runs it after the
    independent reviewer.
  - Without the action contract, loop turns queue it in the inbox
    (`queuesInLoops`). With the contract, the trust ledger decides.
  - Every call is an `action_log` row whose result includes the
    changed-files list.
  - The owner may opt chosen agents into **runs without approval**
    (`freeAgents`). Those calls take the free path (`decision: 'free'`,
    still logged, still frozen by an incident). The opt-in never applies
    to channel turns or confined turns (a mini app's `agent.ask`).
- **Owner-only configuration.** `PUT /api/harness/*` and
  `POST /api/harness/*/detect` are on the owner-only route list, so
  members and viewers cannot change them.
- **Validation.**
  - The base URL must be https (http is allowed only for localhost) and
    carry no credentials.
  - Model ids are plain (no leading `-`).
  - The binary path must be absolute.
  - Numeric limits are bounded.
  - Model ids from the tool call pass the same check.

## 4. Settings

The *Settings › Coding agents* pane (`pane=harness`) has these fields
for each harness:

- enabled;
- detected status and version, with *Re-check*;
- binary path override;
- authentication: an API key (write-only), or the CLI's own login;
- base URL (DeepSeek's Anthropic URL, or an OpenAI-compatible endpoint
  for Codex and Pi);
- Pi provider;
- default model;
- max turns (1–200, default 30);
- timeout (30–3600 s, default 900);
- cost cap per run (USD, 0 means none; default 2);
- permission mode (below);
- OS sandbox;
- which agents may use it (all, or a chosen list);
- runs without approval (an opt-in per agent).

Permission modes map to each CLI's flags:

| Mode | Claude Code / DeepSeek | Codex | Pi |
|---|---|---|---|
| Read only | `--permission-mode dontAsk --tools Read,Grep,Glob` | `--sandbox read-only` | `--tools read` |
| Edit files (default) | `--permission-mode acceptEdits --tools Read,Grep,Glob,Edit,Write` | `--sandbox workspace-write` | `--tools read,edit,write` |
| Files and shell | `--permission-mode bypassPermissions` | `--sandbox workspace-write -c sandbox_workspace_write.network_access=true` (never `danger-full-access`) | default tools (incl. bash) |

The agent's *Settings › Skills & tools* tab lists the coding agents it
can use. For each one it shows whether it is ready (detected and keyed)
and whether it asks before each run.

API: `GET /api/harness`, `PUT /api/harness/:id` (a validated patch; 400
with the reason), and `POST /api/harness/:id/detect`. Storage is one
account-scoped `app_settings` row, `harness.config`, so no migration is
needed.

## 5. Not done yet

- Per-workspace harness settings. Today they are per account, like the
  other app settings; the agent allow-lists are per agent.
- A container backend for runs (the Cloudflare runner equivalent).
- Pi's `models.json` holds the key in the run's private temp home for
  the length of a run. Pi's env-reference syntax is unverified, so we
  don't use it.
- Resuming a CLI session across `code_agent` calls. Every run is fresh.
