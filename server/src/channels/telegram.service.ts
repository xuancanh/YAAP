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
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { SettingsService } from '../settings/settings.module';
import { AgentsService } from '../agents/agents.service';
import { AccountsService } from '../accounts/accounts.service';
import { currentAccountId, currentViewer, runWithAccount, runWithViewer, type Viewer } from '../accounts/account-context';
import { SharedService } from '../shared/shared.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChatsRepository } from '../chats/chats.repository';
import { TurnLoopService } from '../chats/turn-loop.service';
import { GroupChatService } from '../groupchat/groupchat.service';
import { eventHead, eventLink } from '../agents/agents.service';

/** `#slug text` from a paired chat posts into that channel (docs/group-chat.md §4). */
export const CHANNEL_POST_RE = /^#([a-z0-9][a-z0-9-]{0,47})\s+([\s\S]+)$/i;

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
  /** One live pairing code per process, remembering which account minted it
   *  — and, for a member of a shared workspace, which member (docs/shared-agents.md §5). */
  private pairCode: { code: string; expires: number; accountId: string; member?: { workspaceId: string; viewer: Viewer } } | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
    private readonly agents: AgentsService,
    private readonly workspaces: WorkspacesService,
    private readonly repo: ChatsRepository,
    private readonly turns: TurnLoopService,
    /** Optional: without it, one account (the current one) owns the bot. With
     *  it, the paired chat id decides whose agents a message reaches. */
    @Optional() private readonly accounts?: AccountsService,
    /** Optional: per-member pairings in shared workspaces. */
    @Optional() private readonly shared?: SharedService,
    /** Optional: `#slug text` posts into a group-chat channel. */
    @Optional() private readonly groupchat?: GroupChatService,
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

  /** Mint a short-lived pairing code the user sends to the bot as /pair. A
   *  member acting in a shared workspace mints a *member* code: the chat
   *  that redeems it means that member, not the owner. */
  mintPairCode(): { code: string; expiresInSeconds: number; member?: boolean } {
    const code = randomBytes(4).toString('hex');
    const viewer = currentViewer();
    this.pairCode = {
      code, expires: Date.now() + PAIR_TTL_MS, accountId: currentAccountId(),
      ...(viewer && viewer.role !== 'owner' ? { member: { workspaceId: viewer.workspaceId, viewer } } : {}),
    };
    return { code, expiresInSeconds: PAIR_TTL_MS / 1000, ...(viewer ? { member: true } : {}) };
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

    // Whose chat is this? With accounts, the paired chat id is looked up
    // across every account's settings; without, the current account's.
    const owner = this.accounts
      ? await this.accounts.findAccountIdBySetting('telegramChatId', String(chatId))
      : ((await this.settings.all()).telegramChatId === String(chatId) ? currentAccountId() : null);

    if (owner === null) {
      // A member's pairing (shared workspaces): the chat means that member,
      // and the turn runs under the owner's account as them.
      const paired = this.shared ? await this.shared.channelOwner('telegram', String(chatId)) : null;
      if (paired) {
        await runWithViewer(paired.ownerAccountId, paired.viewer, () => this.handlePaired(chatId, text, paired.viewer));
        return;
      }
      // unknown sender: only the pairing handshake is acknowledged
      const m = /^\/pair\s+([a-f0-9]+)$/i.exec(text);
      if (m && this.pairCode && this.pairCode.code === m[1].toLowerCase() && Date.now() < this.pairCode.expires) {
        const { accountId, member } = this.pairCode;
        this.pairCode = null;
        if (member && this.shared) {
          await runWithAccount(accountId, () => this.shared!.pairChannel(member.workspaceId, member.viewer.memberAccountId, 'telegram', String(chatId)));
          await this.send(chatId, `Paired as ${member.viewer.displayName || 'a member'} of a shared workspace. Messages here go to its default agent and count as yours; approvals routed to you arrive here too.`);
          return;
        }
        await runWithAccount(accountId, () => this.settings.put({ telegramChatId: String(chatId) }));
        await this.send(chatId, 'Paired. Messages here go to your default agent; set or change it in the app under Settings → Channels.');
      } else {
        await this.send(chatId, 'This bot only talks to its owner. Open the app, go to Settings → Channels, generate a pairing code, and send: /pair <code>');
      }
      return;
    }
    await runWithAccount(owner, () => this.handlePaired(chatId, text));
  }

  /** A message from the paired chat, under its account (and, for a member
   *  pairing, as that member: their session, their grants, their name). */
  private async handlePaired(chatId: number, text: string, member?: Viewer): Promise<void> {
    const s = await this.settings.all();
    if (text === '/unpair') {
      if (member && this.shared) await this.shared.unpairChannel(member.workspaceId, member.memberAccountId, 'telegram');
      else await this.unpair();
      await this.send(chatId, 'Unpaired. Generate a new code in the app to reconnect.');
      return;
    }

    // `#slug text` → a channel post as this person (docs/group-chat.md §4);
    // the channel runtime wakes whoever the message mentions.
    const chan = CHANNEL_POST_RE.exec(text);
    if (chan && this.groupchat) {
      const target = member ? await this.workspaces.get(member.workspaceId).catch(() => null) : (await this.workspaces.list())[0];
      if (!target) return;
      try {
        const posted = await this.groupchat.postFromPairedChannel(target.id, chan[1].toLowerCase(), chan[2].trim());
        await this.send(chatId, `Posted to #${chan[1].toLowerCase()} (${posted.id.slice(0, 8)}).`);
      } catch (err) {
        await this.send(chatId, `Could not post to #${chan[1].toLowerCase()}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const agentId = s.telegramDefaultAgentId ?? '';
    const agent = agentId ? await this.agents.get(agentId).catch(() => null) : null;
    if (!agent) {
      await this.send(chatId, 'No default agent is set. Pick one in the app under Settings → Channels.');
      return;
    }

    const ws = member ? await this.workspaces.get(member.workspaceId).catch(() => null) : (await this.workspaces.list())[0];
    if (!ws) return;
    // One channel session per person: a member's Telegram turns land in their
    // own private session, never in the owner's.
    const name = member ? `Telegram · ${agent.name} · ${member.displayName || member.memberAccountId.slice(0, 8)}` : `Telegram · ${agent.name}`;
    const existing = (await this.repo.listSessions(ws.id)).find((x) => x.agentId === agent.id && x.name === name);
    // Ask mode, deliberately: gated tools deny with a pointer to the app.
    const session = existing ?? await this.repo.createSession({ workspaceId: ws.id, agentId: agent.id, name, kind: 'chat', permissionMode: 'ask' });

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
      if (!this.accounts) return await this.sweepAccount(now);
      // Once per active account, under its context (docs/accounts.md §3).
      let delivered = 0;
      await this.accounts.forEachAccount(async () => { delivered += await this.sweepAccount(now); });
      return delivered;
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepAccount(now: Date): Promise<number> {
    const s = await this.settings.all();
    const chatId = Number(s.telegramChatId ?? '');
    let delivered = 0;
    if (chatId) {
      const defaultAgentId = s.telegramDefaultAgentId ?? '';
      const events = (await this.agents.undeliveredEvents(now))
        .filter((e) => e.agentId === defaultAgentId || e.channel === 1);
      if (events.length > 0) {
        const batch = events.slice(0, 20); // the rest goes next minute; one phone message, not a flood
        await this.send(chatId, await this.render(batch));
        // Marked only after the send succeeded: a failed push retries next sweep.
        await this.agents.markEventsDelivered(batch.map((e) => e.id), now);
        delivered += batch.length;
      }
    }
    // Members' pairings deliver whether or not the owner paired a chat.
    return delivered + await this.sweepMembers(now);
  }

  /** Events addressed to members (routed approvals) go to *their* paired
   *  chats in this account's workspaces — never to the owner's phone. */
  private async sweepMembers(now: Date): Promise<number> {
    if (!this.shared) return 0;
    let delivered = 0;
    const seen = new Set<string>();
    for (const ws of await this.workspaces.list()) {
      for (const ch of (await this.shared.channels(ws.id)).filter((c) => c.kind === 'telegram')) {
        const key = `${ch.memberAccountId}:${ch.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const events = (await this.shared.addressedEvents(ch.memberAccountId, 'deliveredAt'))
          .filter((e) => e.accountId === currentAccountId() && (e.deliverAfter === null || e.deliverAfter <= now.toISOString()))
          .slice(0, 20);
        if (events.length === 0) continue;
        await this.send(Number(ch.address), await this.render(events));
        await this.agents.markEventsDelivered(events.map((e) => e.id), now);
        delivered += events.length;
      }
    }
    return delivered;
  }

  private async render(batch: Array<{ kind: string; agentId: string; title: string; body: string; sessionId: string | null; payload?: string }>): Promise<string> {
    const names = new Map((await this.agents.list()).map((a) => [a.id, a.name]));
    const base = (this.config.get<string>('publicAppUrl') ?? 'http://localhost:5175').replace(/\/+$/, '');
    return batch.map((e) => {
      const head = `${this.glyph(e.kind)} ${eventHead(e, names)}`;
      const body = e.body ? `\n${e.body.replace(/\s+/g, ' ').slice(0, 400)}` : '';
      const url = eventLink(e, base);
      const link = url ? `\n${url}` : '';
      const hint = e.kind === 'approval_request' ? '\nAllow or deny from your inbox in the app.' : '';
      return head + body + link + hint;
    }).join('\n\n');
  }

  private glyph(kind: string): string {
    switch (kind) {
      case 'loop_error': case 'action_failed': return '❌';
      case 'budget_stop': return '⛔';
      case 'action_pending': case 'approval_request': return '⏸';
      case 'loop_run': return '✅';
      case 'mention': return '💬';
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
