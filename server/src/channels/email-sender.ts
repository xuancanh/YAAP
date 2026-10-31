/**
 * EmailSender — the outbound half of the email channel, behind one small
 * interface so the service never knows which API it talks to.
 *
 * Two REST implementations, chosen by EMAIL_SEND_PROVIDER:
 *  - cloudflare: Email Sending, POST /accounts/{id}/email/sending/send
 *    (`from` is `{ address, name }`, `reply_to` snake_case, custom `headers`).
 *  - resend:     POST https://api.resend.com/emails (`from` is "Name <addr>").
 * `off` yields a sender that refuses — the channel still receives mail, it
 * just cannot answer, and status() says so.
 *
 * Both speak plain fetch with an injectable fetchFn, like the Telegram
 * service and the provider adapters, so tests swap in a recorder.
 */

export interface OutboundEmail {
  to: string;
  from: { address: string; name: string };
  subject: string;
  text: string;
  html?: string;
  /** Threading etc.: In-Reply-To, References, Auto-Submitted. */
  headers?: Record<string, string>;
}

export interface EmailSender {
  readonly name: string;
  send(mail: OutboundEmail): Promise<void>;
}

export class CloudflareEmailSender implements EmailSender {
  readonly name = 'cloudflare';
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(mail: OutboundEmail): Promise<void> {
    const res = await this.fetchFn(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/email/sending/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        to: mail.to,
        from: { address: mail.from.address, name: mail.from.name },
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`cloudflare email send: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
    const data = await res.json().catch(() => ({})) as { success?: boolean; errors?: Array<{ message?: string }> };
    if (data.success === false) throw new Error(`cloudflare email send: ${data.errors?.map((e) => e.message).join('; ') ?? 'failed'}`);
  }
}

export class ResendEmailSender implements EmailSender {
  readonly name = 'resend';
  constructor(private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  async send(mail: OutboundEmail): Promise<void> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: `${mail.from.name.replace(/[<>"\r\n]/g, '')} <${mail.from.address}>`,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
        ...(mail.html ? { html: mail.html } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`resend email send: ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
}

export class NoopEmailSender implements EmailSender {
  readonly name = 'off';
  async send(): Promise<void> {
    throw new Error('EMAIL_SEND_PROVIDER is off: outbound mail is disabled');
  }
}

export function createEmailSender(cfg: { provider: string; token: string; cfAccountId: string }, fetchFn: typeof fetch = fetch): EmailSender {
  switch (cfg.provider) {
    case 'cloudflare': return new CloudflareEmailSender(cfg.cfAccountId, cfg.token, fetchFn);
    case 'resend': return new ResendEmailSender(cfg.token, fetchFn);
    default: return new NoopEmailSender();
  }
}
