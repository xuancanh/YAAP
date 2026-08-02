# yaam runner worker

The paid-tier code-execution backend for yaam's `run_js` / `run_python` tools
(docs/code-execution.md §3d). A thin authenticated facade over
[Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/): the yaam
server POSTs a program here, this Worker runs it in a container with
**deny-all egress**, and returns stdout/stderr/exit code.

The yaam server holds no Cloudflare credentials beyond the shared bearer
token, and the sandbox container holds none at all.

## Deploy

```sh
cd cloudflare/runner-worker
npm install
npx wrangler secret put RUNNER_TOKEN     # any long random string
npx wrangler deploy
```

Then point the server at it and restart:

```sh
RUNNER_BACKEND=cloudflare
RUNNER_CF_URL=https://yaam-runner.<your-subdomain>.workers.dev
RUNNER_CF_TOKEN=<the same value as RUNNER_TOKEN>
```

`GET /api/runner/status` in yaam should then report the `cloudflare` backend.
Requires a Workers Paid plan (Containers are not on the free plan). First
deploy provisions containers and takes a few minutes before requests succeed.

## Contract

```
POST /run    Authorization: Bearer <RUNNER_TOKEN>
{ "language": "javascript" | "python", "code": "…", "stdin": "…", "timeout_seconds": 10 }
→ { "ok": true, "exitCode": 0, "timedOut": false, "stdout": "…", "stderr": "…" }
→ { "ok": false, "error": "…" }        (4xx/5xx)

GET /health → { "ok": true }
```

## Isolation notes

- `RunnerSandbox.allowedHosts = []` — an empty allowlist is deny-by-default
  with nothing allowed, so the container cannot reach the network. This is the
  same guarantee the local backend gets from Seatbelt `(deny network*)` /
  bubblewrap `--unshare-all`.
- One sandbox instance per request (`run-<uuid>`), destroyed in `finally`, so
  every execution starts from a fresh environment.
- `timeout <n>s` inside the container bounds wall clock; exit 124 is reported
  back as `timedOut`.
- No credential injection is configured. If a future tool needs authenticated
  egress, add an outbound handler (which runs **outside** the container, in
  the Workers runtime) rather than passing a token into the sandbox.
