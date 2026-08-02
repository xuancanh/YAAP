# Running user and agent code safely: options, ladder, and what to fix first

Research + design note, August 2026. Answers three questions: where code authored by users or agents actually executes today, what the credible sandboxing options are for adding a real code-execution capability, and in what order we should ship. Builds on the sandbox ladder sketched in docs/deployment.md §Tiers and the gate model in docs/permissions.md.

## 1. Where we stand: Tier 0 is real, with one hole

An audit of the codebase (Aug 2026) confirms the invariant in docs/deployment.md: **brokered tools only, no code execution anywhere on the server.** There is no `eval`, `new Function`, `node:vm`, `child_process`, or `worker_threads` in `server/` or `src/`. Every capability an agent has is a reviewed verb we implemented: `fs_*` jailed to a file root, `http_request`/`web_fetch`/custom tools through `fetchPublic` SSRF guards, connection tools as curated Google/Microsoft verbs, MCP over HTTPS. Self-built skills are prompt text, not programs; self-built tools are URL templates, not code.

The only place authored code runs is **JavaScript inside sandboxed iframes in the user's browser**: mini apps (`src/components/AppHost.tsx`), chat artifacts (`ArtifactPanel.tsx`), and HTML file previews (`FilesView.tsx`, `AgentsView.tsx`). That surface has good bones — `sandbox="allow-scripts"` srcdoc frames are opaque-origin, the `window.yaam` bridge validates `e.source`, and the server re-verifies every capability grant in `app-bridge.service.ts` — but the audit found real gaps:

- **The "no network" claim is unenforced.** UI chips, doc strings, and docs/miniapp-capabilities.md §2 all assert mini apps have no network, and the whole capability model's exfiltration-safety argument rests on it. But `sandbox="allow-scripts"` does not block network: an opaque-origin frame can still `fetch()` to any host, set `img.src`, or load a remote `<script>`. There is no CSP anywhere — not in `index.html`, not in the shim, not in `bootstrap.ts` headers. **This is the highest-value fix in this doc and it is one line**: inject `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:">` into the AppHost shim (and the artifact/preview wrappers).
- Market pack skill bodies are not shown at hire review (`market.service.ts` strips them), contradicting docs/permissions.md ("show the real artifact").
- Custom-tool POST body templates substitute params unencoded — bounded by the literal-host rule, but a param can reshape the JSON sent to an approved host.
- The PDF preview iframe in `FilesView.tsx` is the only frame without a `sandbox` attribute; `window.confirm` capability prompts have no spam quota for `tasks.write`.

These fixes are prerequisites, not optional hardening: there is no point adding a code interpreter behind a capability model whose existing invariant is aspirational.

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

### 3d. The browser as a second runner

The mini-app iframe (once CSP-sealed) is itself a code sandbox we already ship, and artifacts prove agents author useful HTML/JS today. A `render`-class runner — code that computes *in the user's browser tab* with results returned over the existing validated postMessage channel — costs nearly nothing to add and inherits the AppHost capability model. It is not a substitute for a server-side runner (no access to workspace files beyond granted caps, dies with the tab), but it is free compute with a boundary the browser vendors maintain.

## 4. What we deliberately do not build

- **A shell tool on the host process.** Not at any tier. Shell access arrives only inside a Tier-1 disposable worker that holds no credentials.
- **Arbitrary package installation in Tier 0.5.** The WASM runners ship with their stdlib (Pyodide includes numpy/pandas-class wheels); "npm install left-pad" waits for Tier 1 workers with an egress proxy.
- **Same-process JS execution of any kind**, per §3a — including for "just this one trusted transform."
- **Persistent runner state.** Every execution starts from a fresh interpreter; anything worth keeping goes through `fs_write` where the existing approval and jailing apply. Persistence is how injected code outlives its injection.

## 5. Recommended shape: `run_js` / `run_python` as brokered tools

A new `server/src/runner/` module, same Controller→Service pattern:

- `run_js`: quickjs-emscripten in the Nest process. Fresh runtime per call; 64 MB memory limit; 5 s interrupt budget; stdout/return value capped at 32 KB and framed as tool output. Host functions injected: none in v1. Mutation-class for the approval policy (it can compute anything, so Ask-gate it like a write).
- `run_python`: Deno subprocess (`--allow-read=none --allow-net=none ...`) running Pyodide, stdin/stdout JSON protocol, killed at timeout. Feature-flagged off unless Deno is present.
- Inputs are code + an explicit `stdin` string. No implicit access to files, chats, or connections — the agent pipes data in via the tool call, and what it pipes is visible in the approval card. **The approval card shows the code itself**, not a summary (docs/permissions.md: the real artifact).
- Loop-origin calls queue as `action_pending`, reusing the M1 machinery unchanged.

This slots between today's Tier 0 and deployment.md's Tier 1 — call it **Tier 0.5: interpreter-in-WASM, in-process, deny-by-default** — and none of it is throwaway: the tool surface, approval UX, and provenance framing carry forward verbatim when Tier 1 swaps the backend for srt-style OS sandboxes or microVM workers.

## 6. Sequencing

1. **Seal the existing sandbox first.** CSP meta tag in the AppHost/artifact/preview shims; `sandbox` attribute on the PDF frame; show pack skill bodies at hire; encode POST-body params in custom tools. Half a day, and it makes the documented invariants true.
2. **`run_js` via quickjs-emscripten** behind the standard grant + Ask gates, approval card showing full code. This is the payoff step — most agent "I need to compute something" moments are JS-shaped and small.
3. **`run_python` via Deno + Pyodide**, feature-flagged, same tool contract.
4. **Tier 1 per deployment.md** — disposable OS-sandboxed workers (srt-style Seatbelt/bubblewrap locally, gVisor/Firecracker in cloud) with an egress proxy, unlocking shell + package installs. Sequenced after desktop packaging, as already planned.

## 7. Sources

- [Anthropic sandbox-runtime (srt)](https://github.com/anthropic-experimental/sandbox-runtime) — Seatbelt/bubblewrap + egress-proxy design and its stated caveats
- [quickjs-emscripten](https://github.com/justjake/quickjs-emscripten) — memory limits, interrupt handlers, per-runtime isolation
- [langchain-sandbox](https://github.com/langchain-ai/langchain-sandbox) — the Pyodide-in-Deno pattern
- [Deno permission model](https://docs.deno.com/runtime/fundamentals/security/) — deny-by-default I/O, `--allow-run` caveat
- [Node.js vm docs](https://nodejs.org/api/vm.html) ("not a security mechanism") and the [vm2 January 2026 escape](https://www.endorlabs.com/learn/cve-2026-22709-critical-sandbox-escape-in-vm2-enables-arbitrary-code-execution)
- [web.dev on sandboxed iframes](https://web.dev/articles/sandboxed-iframes) — why `allow-scripts` alone does not imply no-network
