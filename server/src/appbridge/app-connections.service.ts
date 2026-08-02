/**
 * AppConnectionsService — `yaam.connections` (docs/miniapp-roadmap.md §6).
 *
 * docs/miniapp-capabilities.md §4.7 deferred `tools.invoke` for a reason that
 * has not gone away: an approved GET with a `{query}` placeholder becomes an
 * exfiltration channel the moment an app controls the parameter. The answer
 * is not to review harder, it is to never hand an app a request it can shape.
 *
 * So apps get **fixed shapes**, not tool invocation. An app names an op from
 * the table below and passes the parameters that op defines; it cannot name a
 * URL, a header, a tool, or a field we did not list. There is no request an
 * app can express that reaches a destination of its choosing, which is what
 * makes this safe where tools.invoke was not — the shape is the allowlist.
 *
 * Authority is the intersection: app grant ∧ agent grant ∧ (for writes) user
 * confirm. ConnectionsService.execute re-checks the agent's own per-service,
 * per-level grant on every call, so an app is always strictly weaker than the
 * agent that built it, and revoking the agent's grant revokes the app's too.
 *
 * Two deliberate narrowings against the surface agents have:
 *  - **No sending.** Apps may propose a *draft*; `gmail_send` / `msmail_send`
 *    are not reachable from an app at all. Sending is the one action with no
 *    undo, and "the app asked and I clicked yes" is a weaker record of intent
 *    than a person pressing send in their own mail client.
 *  - **No drive writes / doc export.** Reading is enough for the dashboards
 *    this exists to serve.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConnectionsService } from '../connections/connections.service';
import { AppBridgeService } from './app-bridge.service';

/** provider → tool name, per op. An op an app names must land in this table
 *  or it does not exist; there is no path from app input to a tool name. */
interface OpDef {
  service: 'calendar' | 'gmail' | 'drive';
  tools: { google: string; microsoft: string };
  /** Parameters the app may set. Anything else it sends is dropped, not
   *  forwarded — an unknown key is never a passthrough. */
  params: string[];
}

export const READ_OPS: Record<string, OpDef> = {
  'calendar.upcoming': { service: 'calendar', tools: { google: 'gcal_upcoming', microsoft: 'mscal_upcoming' }, params: ['days'] },
  'calendar.search': { service: 'calendar', tools: { google: 'gcal_search', microsoft: 'mscal_search' }, params: ['query'] },
  'drive.search': { service: 'drive', tools: { google: 'drive_search', microsoft: 'msdrive_search' }, params: ['query'] },
  'drive.read': { service: 'drive', tools: { google: 'drive_read', microsoft: 'msdrive_read' }, params: ['fileId'] },
};

export const WRITE_OPS: Record<string, OpDef> = {
  'calendar.create': { service: 'calendar', tools: { google: 'gcal_create_event', microsoft: 'mscal_create_event' }, params: ['title', 'start', 'end', 'description', 'attendees', 'location'] },
  'calendar.update': { service: 'calendar', tools: { google: 'gcal_update_event', microsoft: 'mscal_update_event' }, params: ['eventId', 'title', 'start', 'end', 'description', 'location'] },
  'mail.draft': { service: 'gmail', tools: { google: 'gmail_draft', microsoft: 'msmail_draft' }, params: ['to', 'subject', 'body', 'cc'] },
};

@Injectable()
export class AppConnectionsService {
  constructor(
    private readonly bridge: AppBridgeService,
    private readonly connections: ConnectionsService,
  ) {}

  /** What the app may reach: providers and services this agent holds, with
   *  levels. No tokens, no account email — an app never learns *whose*
   *  calendar it is reading, only that there is one. */
  async list(agentId: string, appId: string) {
    await this.bridge.gate(agentId, appId, 'connections', 'connections.read');
    const all = await this.connections.list();
    const out: Array<{ provider: string; service: string; level: string; ops: string[] }> = [];
    for (const conn of all) {
      for (const g of conn.grants.filter((x) => x.agentId === agentId)) {
        const ops = [
          ...Object.entries(READ_OPS).filter(([, d]) => d.service === g.service).map(([k]) => k),
          ...(g.level === 'write' ? Object.entries(WRITE_OPS).filter(([, d]) => d.service === g.service).map(([k]) => k) : []),
        ];
        out.push({ provider: conn.provider, service: g.service, level: g.level, ops });
      }
    }
    return out;
  }

  /** Pick the tool for an op, and rebuild its input from the declared
   *  parameters only — the app's object is read, never forwarded. */
  private resolve(table: Record<string, OpDef>, op: string, provider: string, input: Record<string, unknown>) {
    const def = table[op];
    if (!def) throw new BadRequestException(`unknown operation "${op}" (available: ${Object.keys(table).join(', ')})`);
    const name = provider === 'microsoft' ? def.tools.microsoft : def.tools.google;
    const args: Record<string, unknown> = {};
    for (const p of def.params) if (input[p] !== undefined) args[p] = input[p];
    return { name, args };
  }

  /** A read through the agent's grant. No confirm: this is a different lens
   *  on data the user already has, and with no network in the frame there is
   *  nowhere for it to go. */
  async read(agentId: string, appId: string, provider: string, op: string, params: Record<string, unknown> = {}) {
    const entry = await this.bridge.gate(agentId, appId, 'connections', 'connections.read');
    const { name, args } = this.resolve(READ_OPS, op, provider, params);
    const result = await this.connections.execute(agentId, name, args);
    await this.bridge.note(agentId, `App "${entry.name}" read ${op} from ${provider}`);
    // Provider text is untrusted external content and is already framed as
    // such by the tools themselves; an app feeding it into llm.complete or
    // agent.ask is a prompt-injection path, so the framing must survive.
    return { op, provider, text: result };
  }

  /** A change to the user's real calendar or mail. The host has already shown
   *  the payload and taken an explicit yes — every time, never remembered. */
  async propose(agentId: string, appId: string, provider: string, op: string, payload: Record<string, unknown> = {}) {
    const entry = await this.bridge.gate(agentId, appId, 'connections', 'connections.propose');
    const { name, args } = this.resolve(WRITE_OPS, op, provider, payload);
    const result = await this.connections.execute(agentId, name, args);
    await this.bridge.note(agentId, `App "${entry.name}" ran ${op} on ${provider} (you approved it)`, JSON.stringify(args).slice(0, 2_000));
    return { op, provider, text: result };
  }
}
