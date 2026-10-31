# yaam email worker

The inbound half of yaam's email channel (`docs/channels.md`). Cloudflare
Email Routing delivers every message addressed to your agent domain to this
Worker; it parses the MIME with `postal-mime`, reduces it to a small JSON
document, signs that body with HMAC-SHA256 under a shared secret, and POSTs
it to the yaam API at `POST /api/channels/email/inbound`.

The Worker never talks to the model and holds no yaam credentials beyond
the HMAC secret. The API verifies the signature before it parses the body,
so a forged POST without the secret is a 401.

## Setup

1. **Add the domain to Cloudflare** (the zone whose MX records you control —
   a subdomain such as `agents.example.com` works and keeps your main mail
   untouched).
2. **Enable Email Routing** on that zone:
   ```sh
   npx wrangler email routing enable agents.example.com
   ```
   or Dashboard → *Compute & AI* → *Email Service* → *Email Routing*. Accept
   the MX/SPF records it proposes.
3. **Deploy this Worker**:
   ```sh
   cd cloudflare/email-worker
   npm install
   # edit wrangler.jsonc: YAAM_API_URL = https://your-yaam-host
   npx wrangler secret put YAAM_INBOUND_SECRET   # any long random string
   npx wrangler deploy
   ```
4. **Route mail to it** with a catch-all rule (every agent address is
   `<slug>@domain`, and new agents appear without a redeploy):
   Dashboard → *Email Routing* → *Routing rules* → *Catch-all* → action
   *Send to a Worker* → `yaam-email`. (The CLI equivalent is
   `npx wrangler email routing rules create --catch-all --action worker --worker yaam-email`;
   check `npx wrangler email routing rules --help` for the current flags.)
5. **Configure yaam** and restart:
   ```sh
   EMAIL_DOMAIN=agents.example.com
   EMAIL_INBOUND_SECRET=<the same value as YAAM_INBOUND_SECRET>
   # outbound — one of:
   EMAIL_SEND_PROVIDER=cloudflare EMAIL_SEND_TOKEN=<API token with Email Sending> EMAIL_CF_ACCOUNT_ID=<account id>
   EMAIL_SEND_PROVIDER=resend     EMAIL_SEND_TOKEN=<Resend API key>
   ```
   For the Cloudflare sender, onboard the same domain to Email Sending
   (`npx wrangler email sending enable agents.example.com`) so replies pass
   SPF/DKIM. With Resend, verify the domain in Resend instead.
6. Open yaam → Settings → Channels → Email: every agent's address is listed.
   Send one a mail from your own mailbox, generate a pairing code, reply
   with it, and you are paired.

## Contract

The Worker POSTs:

```json
{
  "to": "fieldy@agents.example.com",       // SMTP RCPT TO (envelope)
  "from": "you@example.com",               // SMTP MAIL FROM (envelope — what pairing binds)
  "headerFrom": "you@example.com",         // header From, informational
  "subject": "…",
  "text": "…",                             // plain part; html only when there is no text
  "html": "…",
  "messageId": "<…@mail.example.com>",
  "inReplyTo": "<…>",
  "references": "<…> <…>",
  "receivedAt": "2026-10-31T12:00:00.000Z",
  "headers": { "auto-submitted": "…", "precedence": "…" }   // only the auto-reply markers
}
```

with `X-Yaam-Signature: sha256=<hex HMAC-SHA256 of the exact body bytes>`.
Any other forwarder (a Postfix pipe, a Mailgun route, a Gmail script) that
produces the same shape and signature works too.

A non-2xx from the API makes the Worker reject the message with a temporary
error so the sender's MTA retries, instead of dropping mail on the floor.
