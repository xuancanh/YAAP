/**
 * TelegramService — the first presence channel (roadmap phase 4): talk to
 * your agents from Telegram, and hear from them there.
 *
 * Two-way (phase 2 finish): a minute sweep pushes undelivered inbox events
 * — the paired default agent's, plus any event flagged `channel` (loop
 * failures, budget stops from every agent) — to the paired chat, batched
 * into one message with a deep link back to the conversation. Quiet hours
 * are honoured through `deliverAfter`/`silent` on the event; events born on a
 * channel turn are never echoed back (that would be a loop).
 *
 * Design constraints from the OpenClaw research:
 *  - Pairing, not open DMs: the bot answers unknown chats only with pairing
 *    instructions. A pairing code minted in the app (10-minute expiry,
 *    in-memory) binds exactly one chat id; everything else is ignored.
 *  - Channel turns are Ask-mode turns: when the agent wants a gated tool,
 *    the call is auto-denied with a note telling the user to run it from the
 *    app — a phone channel must never become the blanket-approval backdoor.
 *  - The gateway is outbound-only long polling (getUpdates); nothing listens
 *    for inbound webhooks, matching the desktop/cloud posture.
 *
 * The Bot API is spoken over plain fetch with an injectable fetchFn test
 * seam, like the provider adapters and the MCP client.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { SettingsService } from '../settings/settings.module';
import { AgentsService } from '../agents/agents.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatsRepository } from '../chats/chats.repository';
import { TurnLoopService } from '../chats/turn-loop.service';

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { first_name?: string } };
}

const PAIR_TTL_MS = 10 * 60_000;

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  /** Test seam, same pattern as McpService.clientFactory. */
  fetchFn: typeof fetch = fetch;
  private offset = 0;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private pairCode: { code: string; expires: number } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
  ) {}

  private get token(): string {
    return this.config.get<string>('telegramBotToken') ?? '';
  }

  onModuleInit(): void {
    if (!this.token) return;
    this.running = true;
    this.timer = setTimeout(() => { void this.pollLoop(); }, 1_000);
    // Outbound: same cadence as the loop tick, so a loop_run written at
    // :00 reaches the phone by :01.
    this.sweepTimer = setInterval(() => { void this.deliverSweep().catch(() => undefined); }, 60_000);
    this.logger.log('Telegram channel enabled (long polling + outbound sweep)');
  }

  onModuleDestroy(): void {
    this.running = false;
    clearTimeout(this.timer);
    clearInterval(this.sweepTimer);
  }

  // ---- pairing (Settings → Channels) ----

  async status() {
    const s = await this.settings.all();
    return {
      configured: Boolean(this.token),
      paired: Boolean(s.telegramChatId),
      defaultAgentId: s.telegramDefaultAgentId ?? '',
    };
  }

  /** Mint a short-lived pairing code the user sends to the bot as /pair. */
  mintPairCode(): { code: string; expiresInSeconds: number } {
    const code = randomBytes(4).toString('hex');
    this.pairCode = { code, expires: Date.now() + PAIR_TTL_MS };
    return { code, expiresInSeconds: PAIR_TTL_MS / 1000 };
  }

  async unpair() {
    await this.settings.put({ telegramChatId: '' });
    return { ok: true };
  }

  // ---- the gateway loop ----

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.api<TgUpdate[]>('getUpdates', { offset: this.offset, timeout: 25 });
        for (const u of updates) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          await this.handleUpdate(u).catch((err) => {
            this.logger.warn(`update failed: ${err instanceof Error ? err.message : err}`);
          });
        }
      } catch (err) {
        this.logger.warn(`poll failed: ${err instanceof Error ? err.message : err}`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  /** Exposed for tests: process one update as the poll loop would. */
  async handleUpdate(u: TgUpdate): Promise<void> {
    const text = u.message?.text?.trim();
    const chatId = u.message?.chat.id;
    if (!text || chatId === undefined) return;

    const s = await this.settings.all();
    const pairedChat = s.telegramChatId ?? '';

    if (String(chatId) !== pairedChat) {
      // unknown sender: only the pairing handshake is acknowledged
      const m = /^\/pair\s+([a-f0-9]+)$/i.exec(text);
      if (m && this.pairCode && this.pairCode.code === m[1].toLowerCase() && Date.now() < this.pairCode.expires) {
        this.pairCode = null;
        await this.settings.put({ telegramChatId: String(chatId) });
        await this.send(chatId, 'Paired. Messages here go to your default agent; set or change it in the app under Settings → Channels.');
      } else {
        await this.send(chatId, 'This bot only talks to its owner. Open the app, go to Settings → Channels, generate a pairing code, and send: /pair <code>');
      }
      return;
    }

    if (text === '/unpair') {
      await this.unpair();
      await this.send(chatId, 'Unpaired. Generate a new code in the app to reconnect.');
      return;
    }

    const agentId = s.telegramDefaultAgentId ?? '';
    const agent = agentId ? await this.agents.get(agentId).catch(() => null) : null;
    if (!agent) {
      await this.send(chatId, 'No default agent is set. Pick one in the app under Settings → Channels.');
      return;
    }

    const ws = (await this.workspaces.list())[0];
    if (!ws) return;
    const name = `Telegram · ${agent.name}`;
    const existing = (await this.repo.listSessions(ws.id)).find((x) => x.agentId === agent.id && x.name === name);
    // Ask mode, deliberately: gated tools deny with a pointer to the app.
    const session = existing ?? await this.repo.createSession({ workspaceId: ws.id, agentId: agent.id, name, permissionMode: 'ask' });

    let answer = '';
    const denied: string[] = [];
    try {
      for await (const ev of this.turns.run(session.id, { text, origin: 'channel' })) {
        if (ev.type === 'answer') answer += ev.text;
        if (ev.type === 'approval_required') {
          denied.push(ev.tool);
          this.turns.resolveApproval(session.id, ev.callId, 'deny');
        }
        if (ev.type === 'error') answer += `\n(error: ${ev.message})`;
      }
    } catch (err) {
      answer = `Turn failed: ${err instanceof Error ? err.message : err}`;
    }
    if (denied.length > 0) {
      answer += `\n\n⚠ I skipped ${[...new Set(denied)].join(', ')} — approval-gated tools only run from the app. Open this conversation there to continue.`;
    }
    await this.send(chatId, answer.trim() || '(no reply)');
  }

  // ---- outbound: the agent inbox reaches the phone ----

  /** Push every deliverable inbox event to the paired chat. Exposed for
   *  tests; the interval calls it once a minute. Returns how many events
   *  were delivered. */
  async deliverSweep(now: Date = new Date()): Promise<number> {
    if (!this.token || this.sweeping) return 0;
    this.sweeping = true;
    try {
      const s = await this.settings.all();
      const chatId = Number(s.telegramChatId ?? '');
      if (!chatId) return 0;
      const defaultAgentId = s.telegramDefaultAgentId ?? '';
      const events = (await this.agents.undeliveredEvents(now))
        .filter((e) => e.agentId === defaultAgentId || e.channel === 1);
      if (events.length === 0) return 0;

      const batch = events.slice(0, 20); // the rest goes next minute; one phone message, not a flood
      const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
      const base = (this.config.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
      const text = batch.map((e) => {
        const head = `${this.glyph(e.kind)} ${names.get(e.agentId) ?? 'Agent'} · ${e.title}`;
        const body = e.body ? `\n${e.body.replace(/\s+/g, ' ').slice(0, 400)}` : '';
        const link = e.sessionId ? `\n${base}/#/chat/${e.sessionId}` : '';
        return head + body + link;
      }).join('\n\n');
      await this.send(chatId, text);
      // Marked only after the send succeeded: a failed push retries next sweep.
      await this.agents.markEventsDelivered(batch.map((e) => e.id), now);
      return batch.length;
    } finally {
      this.sweeping = false;
    }
  }

  private glyph(kind: string): string {
    switch (kind) {
      case 'loop_error': case 'action_failed': return '❌';
      case 'budget_stop': return '⛔';
      case 'action_pending': return '⏸';
      case 'loop_run': return '✅';
      default: return 'ℹ️';
    }
  }

  private async send(chatId: number, text: string): Promise<void> {
    // Telegram caps messages at 4096 chars; split conservatively.
    for (let i = 0; i < text.length; i += 3800) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3800) });
    }
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? res.status}`);
    return data.result as T;
  }
}
