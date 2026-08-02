# Running user and agent code safely: options, ladder, and what to fix first

Research + design note, August 2026; §5 updated when the runner shipped. Answers three questions: where code authored by users or agents actually executes today, what the credible sandboxing options are for adding a real code-execution capability, and in what order we should ship. Builds on the sandbox ladder sketched in docs/deployment.md §Tiers and the gate model in docs/permissions.md.

## 1. Where we stand: Tier 0 is real, with one hole

An audit of the codebase (Aug 2026) confirms the invariant in docs/deployment.md: **brokered tools only, no code execution anywhere on the server.** There is no `eval`, `new Function`, `node:vm`, `child_process`, or `worker_threads` in `server/` or `src/`. Every capability an agent has is a reviewed verb we implemented: `fs_*` jailed to a file root, `http_request`/`web_fetch`/custom tools through `fetchPublic` SSRF guards, connection tools as curated Google/Microsoft verbs, MCP over HTTPS. Self-built skills are prompt text, not programs; self-built tools are URL templates, not code.

The only place authored code runs is **JavaScript inside sandboxed iframes in the user's browser**: mini apps (`src/components/AppHost.tsx`), chat artifacts (`ArtifactPanel.tsx`), and HTML file previews (`FilesView.tsx`, `AgentsView.tsx`). That surface has good bones — `sandbox="allow-scripts"` srcdoc frames are opaque-origin, the `window.yaam` bridge validates `e.source`, and the server re-verifies every capability grant in `app-bridge.service.ts` — but the audit found four real gaps. **All four are now closed** (August 2026); they are recorded here because the reasoning outlives the fix:

- **"No network" was claimed but unenforced.** UI chips, doc strings, and docs/miniapp-capabilities.md §2 all assert mini apps have no network, and the whole capability model's exfiltration-safety argument rests on it. But `sandbox="allow-scripts"` does not block network: an opaque-origin frame can still `fetch()` to any host, set `img.src`, or load a remote `<script>`. There was no CSP anywhere — not in `index.html`, not in the shim, not in `bootstrap.ts` headers. **Fixed** in `src/lib/sandbox.ts`: a `default-src 'none'` Content-Security-Policy, allowing only inline script/style and `data:`/`blob:` images, media and fonts, is injected into every frame we render. `sealHtml()` places it inside `<head>` for full documents so a meta tag before the doctype cannot drop the page into quirks mode.
- **Market pack skill bodies were not shown at hire review** (`market.service.ts` stripped them), contradicting docs/permissions.md ("show the real artifact"). **Fixed**: `GET /api/market/:id/skills` serves the full instruction text, and the hire modal has a per-skill "Read text" toggle. The catalog listing still strips bodies — that is about payload size, not secrecy.
- **Custom-tool POST body templates substituted params unencoded** — bounded by the literal-host rule, but a param could close its JSON string and add fields the user never approved. **Fixed**: values are now escaped for the syntax they land in, `encodeURIComponent` for the URL and JSON string-escaping for the body.
- **The PDF preview iframe had no `sandbox` attribute** and capability confirms had no spam quota. **Fixed**: every iframe in the codebase now carries `sandbox`, and an app that keeps re-prompting after three denials loses the confirm channel until it is reopened — the nagging attack named in docs/miniapp-capabilities.md.

These were prerequisites, not optional hardening: there is no point adding a code runner behind a capability model whose existing invariant is aspirational.

## 2. Threat model before engine choice

What "run code safely" must defend against, in our single-user-today, multi-tenant-later world:

1. **Host compromise.** The code escapes the sandbox and reads the server's environment: sealed-token key, OAuth refresh tokens, the Postgres socket. This is fatal — the connections work (docs/integrations.md) concentrated real credentials on this box.
2. **Exfiltration.** The code cannot escape but can phone home: workspace files, chat history passed as input, or profile data leave via network. Prompt injection makes this the *expected* attack, not the exotic one — an agent that read a hostile web page will happily write the exfiltration code itself.
3. **Resource abuse.** Infinite loops, memory bombs, fork bombs. In a local app this is an annoyance (fan noise, a frozen turn); in cloud it is a bill.
4. **Persistence.** Code that survives its invocation — writing cron entries, editing the agent's own skills or files to re-trigger itself. Our brain-poisoning defenses (path jailing in the app bridge) already treat this as first-class; the code runner must too.

The gate model applies unchanged: offering a `run_code` tool is creation-free; an agent getting it is an explicit grant; each execution is Ask/Auto-gated like any mutating tool. Loop-origin runs queue as `action_pending`, same as connection mutations.

## 3. The options, surveyed

### 3a. What is disqualified outright

**`node:vm` and vm2.** The Node docs say the vm module "is not a security mechanism"; vm2 was deprecated in 2023 after unpatchable escapes and grew another critical CVE in January 2026. Anything that runs untrusted JS in the same V8 isolate/process as our server — including "hardened" wrappers — shares the server's memory space with the secretbox key. Never.

**`isolated-vm`.** Separate V8 isolates, real memory limits — but same process, native-addon build pain across Node majors, and its own README now steers agent-code use cases toward process-level isolation. The maintenance and escape-surface story is wrong for us when WASM interpreters exist.

### 3b. WASM interpreters in-process: the sweet spot for a first code runner

**quickjs-emscripten** (QuickJS compiled to WebAssembly) runs a full ES2023 interpreter inside a WASM linear-memory box. The sandbox boundary is the WASM memory model itself, not a patched-up API surface: the guest cannot name a single host object we do not explicitly inject. It ships the exact knobs a tool runner needs — `setMemoryLimit`, `setMaxStackSize`, `setInterruptHandler` for wall-clock/instruction budgets (polled even during regex backtracking) — and host functions are opt-in, one at a time. No network, no filesystem, no ambient anything: **deny-by-default is the physics of the runtime, not a configuration we maintain.**

For Python, the same shape exists as **Pyodide inside a Deno subprocess** (the langchain-sandbox / Pydantic AI pattern): Deno's permission model (`--allow-net=none`, no fs, no env) as the outer wall, Pyodide's WASM as the inner one, stdin/stdout as the only channel. Two independent layers, both deny-by-default.

Honest limits of this tier: no `npm install`/`pip install` of arbitrary native packages, no shell, cold-start of a few hundred ms for Pyodide, and CPU-bound code runs at interpreter-in-WASM speed. That covers the actual use cases agents have today — transform this JSON, compute these dates, parse this CSV, render this chart data — and refuses the ones we do not want yet.

### 3c. OS-level sandboxing: the Tier-1 step

When agents need real tools — a shell, package installs, a headless browser — the boundary moves to the OS. The credible open-source reference is **Anthropic's sandbox-runtime (`@anthropic-ai/sandbox-runtime`, Apache-2.0)**: `sandbox-exec` with generated Seatbelt profiles on macOS, bubblewrap + seccomp on Linux, filesystem allow-lists, and all egress forced through a domain-filtering proxy. Its caveats are instructive — domain allowlists do not inspect traffic, domain fronting exists, unix sockets need care — which is exactly why deployment.md already specifies "no credentials inside the sandbox, pre-signed scoped file access, egress through the same `assertPublicUrl` rules." A worker holding zero secrets makes escape merely bad instead of fatal.

Full VMs — **gVisor** for syscall interception, **Firecracker** microVMs with 5-30ms snapshot-restore — are the right wall for the paid cloud tier where tenants share metal, and the wrong amount of machinery for a local desktop app. Hosted sandbox services (E2B, Riza, Daytona) trade our locality story for someone else's cloud; no, for the core — the free product's promise is that nothing leaves the machine.

### 3d. Cloudflare Sandboxes: buy, not build, for the cloud tier

Evaluated August 2026. **Cloudflare's Sandbox SDK (`@cloudflare/sandbox`, GA April 2026)** is a container-per-sandbox platform on Cloudflare Containers, driven by a TypeScript API from a Worker, and it implements our Tier-1 spec almost clause for clause:

- **Disposable workers with warm starts.** One isolated Linux container per sandbox, `sleepAfter` lifecycle, and backup/restore snapshot APIs so an agent's environment resumes without repeating setup.
- **No credentials inside the sandbox — as a platform primitive.** Outbound Workers run *outside* the container and inject secrets into egress requests in flight (`outboundByHost`); the workload makes a plain request and never sees the token. This is exactly the "worker holds zero secrets" rule from deployment.md, except we do not have to build the proxy.
- **Deny-by-default egress.** `allowedHosts` turns all egress into an allowlist (glob patterns), switchable per instance at runtime without restart; TLS interception uses a per-instance ephemeral CA whose key never enters the container. Same domain-fronting caveats as any domain filter, same as srt.
- **The tool surface we want is already there.** `exec`, persistent Python/JS/TS code-interpreter contexts with rich outputs (png/svg charts, HTML tables, JSON) that map directly onto our artifact panel, file APIs with real-time watch events, background processes with preview URLs, git checkout, PTY terminals.
- **Cost shape fits a paid tier.** Workers Paid ($5/mo) plus usage-based Containers pricing with active-CPU billing and included monthly allowances — per-execution cost, no idle fleet.

What it does not do, and why it changes nothing about §5:

- **It is not self-hostable and it is not local.** Sandboxes run on Cloudflare's edge; the local Docker mode is a dev harness, not a deployment target. Workspace data sent to a runner transits Cloudflare, and TLS interception means the platform sees decrypted egress. For the free local product — whose promise is that nothing leaves the machine — this is disqualifying, same as E2B/Riza above.
- **It is Worker-shaped, not Nest-shaped.** The sandbox binding lives in a Durable Object; our server would front it with a thin authenticated Worker facade. Modest integration cost, but it exists.

So the decision: **Tier 0.5 stays local WASM; when the paid cloud tier arrives, Cloudflare Sandboxes is the leading candidate to *be* Tier 1 there** — it replaces the "operate our own Firecracker/gVisor fleet" line item with a managed platform whose egress and credential model match what we were going to build anyway. The `run_js`/`run_python` tool contract in §5 is deliberately backend-agnostic so this swap is a service-module change, not a redesign.

### 3e. The browser as a second runner

The mini-app iframe (once CSP-sealed) is itself a code sandbox we already ship, and artifacts prove agents author useful HTML/JS today. A `render`-class runner — code that computes *in the user's browser tab* with results returned over the existing validated postMessage channel — costs nearly nothing to add and inherits the AppHost capability model. It is not a substitute for a server-side runner (no access to workspace files beyond granted caps, dies with the tab), but it is free compute with a boundary the browser vendors maintain.

## 4. What we deliberately do not build

- **A shell tool on the host process.** Not at any tier. Shell access arrives only inside a Tier-1 disposable worker that holds no credentials.
- **Arbitrary package installation in Tier 0.5.** The WASM runners ship with their stdlib (Pyodide includes numpy/pandas-class wheels); "npm install left-pad" waits for Tier 1 workers with an egress proxy.
- **Same-process JS execution of any kind**, per §3a — including for "just this one trusted transform."
- **Persistent runner state.** Every execution starts from a fresh interpreter; anything worth keeping goes through `fs_write` where the existing approval and jailing apply. Persistence is how injected code outlives its injection.

## 5. What shipped: `run_js` / `run_python` over two interchangeable backends

Implemented August 2026 in `server/src/runner/` (Controller→Service, like every other module). We skipped the WASM Tier-0.5 step and went straight to OS-level isolation, because the OS primitives turned out to be *simpler* than embedding an interpreter — no native addon, no WASM build step, and the same guarantee for both languages at once.

**The tool contract, identical on both backends:**

- `run_js` and `run_python` take `code`, an optional `stdin` string, and `timeout_seconds` (1-30, default 10). They return exit code, stdout, and stderr, each capped at 32 KB.
- **No implicit access to anything.** The sandbox cannot read workspace files, chats, or connection tokens. Data reaches a program only through the `stdin` the agent passes — which is visible in the approval card alongside the full program, per docs/permissions.md ("show the real artifact").
- **Always mutation-class.** `isReadOnly()` returns `false` for both, so Ask mode pauses on every call. There is no read-only code execution.
- **Loop-origin calls queue**, reusing the M1 `action_pending` machinery unchanged: a background loop turn records the code in the agent's inbox instead of running it, even in Auto mode.
- **Absent when unavailable.** With no backend, `specs()` returns `[]` — the tools do not exist rather than existing-and-failing. A model that hallucinates one gets a refusal naming why.

**Backend A — local OS sandbox** (`RUNNER_BACKEND=local`, the default when available). The interpreter runs on this machine under the OS's own sandbox:

- macOS: `sandbox-exec` with a generated Seatbelt profile — `(deny network*)`, `(deny file-write*)`, plus one `(allow file-write* (subpath <scratch>))`. The scratch path is JSON-quoted so a directory name cannot break out of the profile.
- Linux: `bubblewrap` with `--ro-bind / /`, a fresh `/tmp` and `/dev`, the scratch dir bind-mounted read-write, and `--unshare-all` — no network namespace at all.
- Every run gets a fresh `mkdtemp` scratch directory, removed in `finally`. `PATH`, `HOME`, and `TMPDIR` are rewritten so interpreters never reach outside it. A `SIGKILL` timer enforces the deadline.

Verified by tests that run the real sandbox, not a stub: `fetch()` and direct-IP sockets both fail inside it, a write to `/tmp` is denied while a write to the scratch dir succeeds, and `while(true){}` dies at the deadline.

**Backend B — Cloudflare Sandboxes** (`RUNNER_BACKEND=cloudflare`, the paid tier). `cloudflare/runner-worker/` is a small authenticated Worker facade: the server POSTs `{language, code, stdin, timeout_seconds}` with a bearer token, the Worker runs it in a Sandbox container and returns the same shape. `RunnerSandbox.allowedHosts = []` makes egress deny-by-default with nothing allowed, matching the local backend's no-network guarantee. One container per request id, destroyed after, so state never carries between runs. No credential injection is configured — if authenticated egress is ever needed, it belongs in an outbound handler that runs *outside* the container, never as a token passed in.

`RUNNER_BACKEND=auto` (the default) prefers Cloudflare when `RUNNER_CF_URL`/`RUNNER_CF_TOKEN` are set — configuring it is an explicit act — and otherwise uses the local sandbox. `off` disables execution entirely. Selecting `cloudflare` without its URL and token fails at boot rather than silently dropping the tools. `GET /api/runner/status` reports the live backend, and Settings → Code runner shows it.

## 6. Sequencing

1. **Done — `run_js` / `run_python` on both backends** (§5): local Seatbelt/bubblewrap and Cloudflare Sandboxes behind one tool contract, mutation-class, loop-origin queuing, status endpoint and Settings pane.
2. **Done — the existing iframe sandbox is sealed** (§1): CSP on every frame we render, `sandbox` on the PDF preview, full pack-skill text at hire review, JSON-escaped custom-tool bodies, and a denial quota on capability confirms.
3. **Package installs and a shell**, inside the sandbox only: an egress-allowlisted variant of each backend (`allowedHosts` on Cloudflare, a filtering proxy locally per srt) so `npm install` / `pip install` work without opening general network access.
4. **Desktop story.** Tauri ships its own WebView; the local backend's Seatbelt/bubblewrap path works unchanged there, but the packaged app must locate an interpreter it does not control. Decide between bundling one and requiring the system's.

## 7. Sources

- [Anthropic sandbox-runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime) — Seatbelt/bubblewrap + egress-proxy design and its stated caveats
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) — memory limits, interrupt handlers, per-runtime isolation
- [langchain-sandbox](https://github.com/langchain-ai/langchain-sandbox) — the Pyodide-in-Deno pattern
- [Deno permission model](https://docs.deno.com/runtime/fundamentals/security/) — deny-by-default I/O, `--allow-run` caveat
- [Node.js vm docs](https://nodejs.org/api/vm.html) ("not a security mechanism") and the [vm2 January 2026 escape](https://www.endorlabs.com/learn/cve-2026-22709-critical-sandbox-escape-in-vm2-enables-arbitrary-code-execution)
- [web.dev on sandboxed iframes](https://web.dev/articles/sandboxed-iframes) — why `allow-scripts` alone does not imply no-network
- [Cloudflare Sandbox SDK](https://github.com/cloudflare/sandbox-sdk) + [Sandboxes product page](https://www.cloudflare.com/products/sandboxes/) — container-per-sandbox platform, GA April 2026
- [Cloudflare changelog: credential injection + dynamic egress policies](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/) — outbound Workers, `allowedHosts`, per-instance TLS interception
