/**
 * yaam email worker — the inbound half of the email channel
 * (docs/channels.md). Cloudflare Email Routing hands every message for the
 * domain to `email()`; we parse it with postal-mime, reduce it to the JSON
 * the yaam API expects, sign the body with HMAC-SHA256 under the shared
 * secret, and POST it to /api/channels/email/inbound.
 *
 * The worker holds no yaam credentials beyond that secret; the API verifies
 * the signature before parsing, so a forged POST without it is a 401.
 * Delivery is at-least-once: a non-2xx from the API rejects the message so
 * the sending MTA retries later, rather than silently dropping mail.
 */
import PostalMime from 'postal-mime';

export interface Env {
  /** https://yaam.example.com — no trailing slash needed. */
  YAAM_API_URL: string;
  /** Must equal EMAIL_INBOUND_SECRET on the yaam server (wrangler secret). */
  YAAM_INBOUND_SECRET: string;
}

const MAX_TEXT = 60_000; // the API bounds further; this keeps the POST small

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const addr = (list: Array<{ address?: string }> | undefined): string => list?.[0]?.address ?? '';

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    if (!env.YAAM_API_URL || !env.YAAM_INBOUND_SECRET) {
      message.setReject('email worker is not configured');
      return;
    }
    // The raw stream is single-use: buffer it before parsing.
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const headers: Record<string, string> = {};
    for (const name of ['auto-submitted', 'precedence', 'x-auto-response-suppress', 'list-id', 'x-autoreply']) {
      const v = message.headers.get(name);
      if (v) headers[name] = v;
    }

    const payload = {
      // Envelope addresses: `message.from` is the SMTP MAIL FROM, which the
      // yaam side pairs against; the header From can be spoofed.
      to: message.to,
      from: message.from,
      headerFrom: addr(parsed.from ? [parsed.from] : undefined) || undefined,
      subject: parsed.subject ?? '',
      text: (parsed.text ?? '').slice(0, MAX_TEXT),
      html: parsed.text ? undefined : (parsed.html ?? '').slice(0, MAX_TEXT),
      messageId: parsed.messageId ?? message.headers.get('message-id') ?? '',
      inReplyTo: parsed.inReplyTo ?? undefined,
      references: parsed.references ?? undefined,
      receivedAt: new Date().toISOString(),
      headers,
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${await hmacHex(env.YAAM_INBOUND_SECRET, body)}`;

    const res = await fetch(`${env.YAAM_API_URL.replace(/\/+$/, '')}/api/channels/email/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-yaam-signature': signature },
      body,
    });
    if (!res.ok) {
      // Transient (5xx, network): a temporary reject makes the sender retry.
      // 4xx means our config is wrong; still surface it rather than vanish.
      message.setReject(`yaam API responded ${res.status}`);
    }
  },
};
