/**
 * SharedService — more than one human on one workspace (docs/shared-agents.md,
 * execution-plan item 8).
 *
 * The model: a workspace keeps exactly one owning account; every row it has
 * (agents, sessions, lessons, events, grants) stays in that account. A
 * *member* is another account that may act inside it, and when they do their
 * request runs under the owner's account context with a `Viewer` attached
 * (accounts/account-context.ts) naming who they are and what their role
 * allows. Nothing a member does is ever written into their own account, and
 * nothing of theirs is read, unless a row says so explicitly: a per-member
 * connection grant, a per-member channel pairing, a flow rule.
 *
 *  - Invitations: email + role → a random token, SHA-256 at rest, 7 days,
 *    mailed through the same EmailSender as the sign-in link (logged when the
 *    sender is off). Accepting requires being signed in as the invited
 *    address; AUTH_MODE=single has no second account to invite, so the whole
 *    feature answers 400 there.
 *  - Roles: viewer = read-only; member = chat, tasks, files, their own
 *    connection grants and channel pairings; owner = settings, budgets,
 *    members, rules, the connections of others.
 *  - Flow rules: default deny for cross-member private material; only the
 *    owner writes allow rows, only through the controller — there is no agent
 *    tool for it, deliberately.
 *
 * Reads that must cross accounts (which account owns this workspace, which
 * workspaces is this caller a member of, which member paired this Telegram
 * chat) go through the unscoped handle, each marked with why.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { accounts, agentEvents, memberChannels, workspaceFlowRules, workspaceInvites, workspaceMembers, workspaces } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { createEmailSender, type EmailSender } from '../channels/email-sender';
import { SINGLE_ACCOUNT, actorId, currentAccountId, runWithAccount, type MemberRole, type Viewer } from '../accounts/account-context';
import { unscoped } from '../accounts/scoped-db';
import { AccountsService } from '../accounts/accounts.service';

export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type FlowRule = typeof workspaceFlowRules.$inferSelect;
export type MemberChannel = typeof memberChannels.$inferSelect;
export type FlowKind = 'lessons' | 'connections' | 'files';

export const MEMBER_ROLES: readonly MemberRole[] = ['owner', 'member', 'viewer'];
export const FLOW_KINDS: readonly FlowKind[] = ['lessons', 'connections', 'files'];
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}$/i;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** What the access guard learns about a workspace for a caller. */
export interface WorkspaceAccess {
  ownerAccountId: string;
  /** Undefined when the caller owns the workspace. */
  viewer?: Viewer;
}

/** A workspace shared with the caller, as the picker lists it. */
export interface SharedWorkspace {
  id: string;
  name: string;
  color: string;
  ownerAccountId: string;
  ownerName: string;
  role: MemberRole;
}

@Injectable()
export class SharedService {
  private readonly logger = new Logger(SharedService.name);
  /** Test seam: where invitation mail goes. */
  sender: EmailSender;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly config: ConfigService,
    private readonly accounts: AccountsService,
  ) {
    this.sender = createEmailSender({
      provider: this.config.get<string>('emailSendProvider') ?? 'off',
      token: this.config.get<string>('emailSendToken') ?? '',
      cfAccountId: this.config.get<string>('emailCfAccountId') ?? '',
    });
  }

  private get enabled(): boolean { return this.accounts.mode === 'accounts'; }

  private assertEnabled(): void {
    if (!this.enabled) throw new BadRequestException('shared workspaces need AUTH_MODE=accounts: in single-user mode there is no second account to invite');
  }

  // ---- resolution (the access guard, channels, sweeps) ----

  /**
   * Which account owns `workspaceId`, and — when `callerAccountId` is not it —
   * the viewer to act as. Null when the caller is neither owner nor member;
   * undefined when no such workspace exists (a stale header, not a breach).
   * Crosses accounts by definition: the caller does not yet know whose
   * workspace this is.
   */
  async resolveAccess(workspaceId: string, callerAccountId: string): Promise<WorkspaceAccess | null | undefined> {
    const bare = unscoped(this.db);
    const ws = (await bare.select({ accountId: workspaces.accountId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).at(0);
    if (!ws) return undefined;
    if (ws.accountId === callerAccountId) return { ownerAccountId: ws.accountId };
    const m = (await bare.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberAccountId, callerAccountId), eq(workspaceMembers.accountId, ws.accountId))).limit(1)).at(0);
    if (!m) return null;
    return {
      ownerAccountId: ws.accountId,
      viewer: { memberAccountId: m.memberAccountId, role: m.role as MemberRole, workspaceId, displayName: m.displayName },
    };
  }

  /** Workspaces the caller is a member of (not the ones they own). */
  async sharedWithMe(callerAccountId: string = currentAccountId()): Promise<SharedWorkspace[]> {
    if (!this.enabled) return [];
    const bare = unscoped(this.db); // the rows live in the owners' accounts
    const rows = await bare.select().from(workspaceMembers).where(eq(workspaceMembers.memberAccountId, callerAccountId));
    if (rows.length === 0) return [];
    const ws = await bare.select().from(workspaces).where(inArray(workspaces.id, rows.map((r) => r.workspaceId)));
    const owners = await bare.select({ id: accounts.id, name: accounts.name, email: accounts.email }).from(accounts)
      .where(inArray(accounts.id, [...new Set(rows.map((r) => r.accountId))]));
    return rows.flatMap((r) => {
      const w = ws.find((x) => x.id === r.workspaceId);
      if (!w) return [];
      const o = owners.find((a) => a.id === r.accountId);
      return [{ id: w.id, name: w.name, color: w.color, ownerAccountId: r.accountId, ownerName: displayNameOf(o), role: r.role as MemberRole }];
    });
  }

  // ---- members (owner's context) ----

  async members(workspaceId: string): Promise<WorkspaceMember[]> {
    const rows = await this.db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId));
    return rows.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  /** True when the workspace has anyone besides its owner — the switch that
   *  turns on per-member audiences and attribution. */
  async hasMembers(workspaceId: string): Promise<boolean> {
    return (await this.members(workspaceId)).length > 0;
  }

  async member(workspaceId: string, memberAccountId: string): Promise<WorkspaceMember | null> {
    return (await this.db.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.memberAccountId, memberAccountId))).limit(1)).at(0) ?? null;
  }

  async setRole(workspaceId: string, memberAccountId: string, role: MemberRole): Promise<WorkspaceMember> {
    if (!MEMBER_ROLES.includes(role)) throw new BadRequestException('role must be owner, member or viewer');
    const m = await this.member(workspaceId, memberAccountId);
    if (!m) throw new NotFoundException(`member ${memberAccountId}`);
    await this.db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, m.id));
    return { ...m, role };
  }

  async removeMember(workspaceId: string, memberAccountId: string): Promise<{ ok: true }> {
    const m = await this.member(workspaceId, memberAccountId);
    if (!m) throw new NotFoundException(`member ${memberAccountId}`);
    await this.db.delete(workspaceMembers).where(eq(workspaceMembers.id, m.id));
    await this.db.delete(memberChannels).where(and(eq(memberChannels.workspaceId, workspaceId), eq(memberChannels.memberAccountId, memberAccountId)));
    return { ok: true };
  }

  /** actor id → display name for everyone who may appear in a transcript:
   *  the owner (their account) and every member. */
  async displayNames(workspaceId: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ownerId = currentAccountId();
    const owner = ownerId === SINGLE_ACCOUNT ? null : await this.accounts.get(ownerId).catch(() => null);
    out.set(ownerId, owner ? displayNameOf(owner) : 'Owner');
    for (const m of await this.members(workspaceId)) out.set(m.memberAccountId, m.displayName || m.email || m.memberAccountId.slice(0, 8));
    return out;
  }

  async nameOf(workspaceId: string, actor: string): Promise<string> {
    return (await this.displayNames(workspaceId)).get(actor) ?? actor.slice(0, 8);
  }

  // ---- invitations ----

  async invites(workspaceId: string): Promise<Array<Omit<WorkspaceInvite, 'tokenHash'>>> {
    const rows = await this.db.select().from(workspaceInvites).where(eq(workspaceInvites.workspaceId, workspaceId));
    return rows.filter((r) => !r.acceptedAt).map((r) => withoutToken(r));
  }

  /** Create and mail an invitation. Returns the token only when the sender is
   *  off (dev), so a test or an operator can hand it over by other means. */
  async invite(workspaceId: string, input: { email: string; role?: MemberRole }, now: Date = new Date()): Promise<{ invite: Omit<WorkspaceInvite, 'tokenHash'>; sent: boolean; token?: string }> {
    this.assertEnabled();
    const email = (input.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new BadRequestException('a valid email address is required');
    const role: MemberRole = input.role ?? 'member';
    if (role !== 'member' && role !== 'viewer') throw new BadRequestException('invite role must be member or viewer (ownership is not transferable by invite)');
    const ws = (await this.db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)).at(0);
    if (!ws) throw new NotFoundException(`workspace ${workspaceId}`);
    const owner = await this.accounts.current();
    if (owner.email && owner.email.toLowerCase() === email) throw new BadRequestException('that is your own address');
    if ((await this.members(workspaceId)).some((m) => m.email.toLowerCase() === email)) throw new BadRequestException(`${email} is already a member`);
    // One live invite per address per workspace: a re-invite replaces it.
    const existing = await this.db.select().from(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, workspaceId), eq(workspaceInvites.email, email)));
    for (const e of existing) if (!e.acceptedAt) await this.db.delete(workspaceInvites).where(eq(workspaceInvites.id, e.id));
    const token = randomBytes(32).toString('base64url');
    const row: WorkspaceInvite = {
      accountId: currentAccountId(), id: newId(), workspaceId, email, role, tokenHash: sha256(token),
      invitedBy: actorId(), expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(), acceptedAt: null, acceptedBy: '', createdAt: now.toISOString(),
    };
    await this.db.insert(workspaceInvites).values(row);
    const base = (this.config.get<string>('publicBaseUrl') ?? 'http://localhost:8790').replace(/\/+$/, '');
    const link = `${base}/api/invites/accept?token=${encodeURIComponent(token)}`;
    const invite = withoutToken(row);
    if (this.sender.name === 'off') {
      this.logger.log(`invitation for ${email} to "${ws.name}" (EMAIL_SEND_PROVIDER=off, dev only): ${link}`);
      return { invite, sent: false, token };
    }
    const domain = this.config.get<string>('emailDomain') ?? '';
    const address = this.config.get<string>('authFromAddress') || (domain ? `login@${domain}` : 'login@localhost');
    await this.sender.send({
      to: email,
      from: { address, name: this.config.get<string>('emailFromName') ?? 'YAAM' },
      subject: `${displayNameOf(owner)} invited you to the workspace "${ws.name}"`,
      text: `${displayNameOf(owner)} invited you to work in their workspace "${ws.name}" as a ${role}.\n\nSign in with this address, then open the link (valid for 7 days):\n\n${link}\n\nIf you were not expecting this, ignore it.`,
      headers: { 'Auto-Submitted': 'auto-generated' },
    });
    return { invite, sent: true };
  }

  async revokeInvite(workspaceId: string, inviteId: string): Promise<{ ok: true }> {
    await this.db.delete(workspaceInvites).where(and(eq(workspaceInvites.workspaceId, workspaceId), eq(workspaceInvites.id, inviteId)));
    return { ok: true };
  }

  /**
   * Redeem an invitation as the signed-in account (`acceptor`). The invite row
   * lives in the owner's account, so the lookup is unscoped by the token
   * hash, and the membership row is written under the owner's account.
   */
  async acceptInvite(token: string, acceptor: { id: string; email: string; name: string }, now: Date = new Date()): Promise<{ workspaceId: string; role: MemberRole; ownerAccountId: string }> {
    this.assertEnabled();
    if (!token) throw new BadRequestException('missing token');
    const bare = unscoped(this.db); // the invite belongs to the inviting account
    const inv = (await bare.select().from(workspaceInvites).where(eq(workspaceInvites.tokenHash, sha256(token))).limit(1)).at(0);
    if (!inv || inv.acceptedAt || inv.expiresAt <= now.toISOString()) throw new BadRequestException('this invitation is invalid, used or has expired');
    if (!acceptor.email || acceptor.email.toLowerCase() !== inv.email) throw new ForbiddenException(`this invitation was sent to ${inv.email}; sign in with that address to accept it`);
    if (inv.accountId === acceptor.id) throw new BadRequestException('you own this workspace already');
    return runWithAccount(inv.accountId, async () => {
      const existing = await this.member(inv.workspaceId, acceptor.id);
      if (!existing) {
        await this.db.insert(workspaceMembers).values({
          id: newId(), workspaceId: inv.workspaceId, memberAccountId: acceptor.id, role: inv.role,
          displayName: displayNameOf(acceptor), email: inv.email, invitedBy: inv.invitedBy, joinedAt: now.toISOString(),
        });
      }
      await this.db.update(workspaceInvites).set({ acceptedAt: now.toISOString(), acceptedBy: acceptor.id }).where(eq(workspaceInvites.id, inv.id));
      return { workspaceId: inv.workspaceId, role: inv.role as MemberRole, ownerAccountId: inv.accountId };
    });
  }

  // ---- information-flow rules ----

  async flowRules(workspaceId: string): Promise<FlowRule[]> {
    return this.db.select().from(workspaceFlowRules).where(eq(workspaceFlowRules.workspaceId, workspaceId));
  }

  async addFlowRule(workspaceId: string, input: { fromMember: string; toMember?: string; effect?: 'allow' | 'deny'; kind: FlowKind }): Promise<FlowRule> {
    if (!FLOW_KINDS.includes(input.kind)) throw new BadRequestException(`kind must be one of ${FLOW_KINDS.join(', ')}`);
    const effect = input.effect ?? 'allow';
    if (effect !== 'allow' && effect !== 'deny') throw new BadRequestException('effect must be allow or deny');
    if (!input.fromMember) throw new BadRequestException('fromMember is required');
    const row: FlowRule = {
      accountId: currentAccountId(), id: newId(), workspaceId, fromMember: input.fromMember, toMember: input.toMember || '*',
      effect, kind: input.kind, createdAt: nowIso(),
    };
    await this.db.insert(workspaceFlowRules).values(row);
    return row;
  }

  async removeFlowRule(workspaceId: string, ruleId: string): Promise<{ ok: true }> {
    await this.db.delete(workspaceFlowRules).where(and(eq(workspaceFlowRules.workspaceId, workspaceId), eq(workspaceFlowRules.id, ruleId)));
    return { ok: true };
  }

  /** Members whose private material of `kind` may reach `toMember`: an allow
   *  row naming them (or '*') with no deny row naming them specifically.
   *  Default deny: with no rows, the answer is the empty set. */
  async allowedSources(workspaceId: string, toMember: string, kind: FlowKind): Promise<Set<string>> {
    const rules = (await this.flowRules(workspaceId)).filter((r) => r.kind === kind && (r.toMember === '*' || r.toMember === toMember));
    const out = new Set<string>();
    for (const r of rules) if (r.effect === 'allow') out.add(r.fromMember);
    for (const r of rules) if (r.effect === 'deny' && r.toMember === toMember) out.delete(r.fromMember);
    return out;
  }

  /** Whether `toMember` may see material private to `fromMember`. */
  async mayFlow(workspaceId: string, fromMember: string, toMember: string, kind: FlowKind): Promise<boolean> {
    if (fromMember === toMember) return true;
    return (await this.allowedSources(workspaceId, toMember, kind)).has(fromMember);
  }

  // ---- per-member channel pairings ----

  async channels(workspaceId: string, memberAccountId?: string): Promise<MemberChannel[]> {
    const rows = await this.db.select().from(memberChannels).where(eq(memberChannels.workspaceId, workspaceId));
    return memberAccountId ? rows.filter((r) => r.memberAccountId === memberAccountId) : rows;
  }

  async pairChannel(workspaceId: string, memberAccountId: string, kind: 'telegram' | 'email', address: string): Promise<MemberChannel> {
    if (!address) throw new BadRequestException('address is required');
    const existing = (await this.channels(workspaceId, memberAccountId)).find((c) => c.kind === kind);
    if (existing) {
      await this.db.update(memberChannels).set({ address }).where(eq(memberChannels.id, existing.id));
      return { ...existing, address };
    }
    const row: MemberChannel = { accountId: currentAccountId(), id: newId(), workspaceId, memberAccountId, kind, address, createdAt: nowIso() };
    await this.db.insert(memberChannels).values(row);
    return row;
  }

  async unpairChannel(workspaceId: string, memberAccountId: string, kind: 'telegram' | 'email'): Promise<{ ok: true }> {
    await this.db.delete(memberChannels).where(and(eq(memberChannels.workspaceId, workspaceId), eq(memberChannels.memberAccountId, memberAccountId), eq(memberChannels.kind, kind)));
    return { ok: true };
  }

  /** Whose pairing is this address? Resolves across accounts (a Telegram
   *  update arrives before anyone knows which workspace it is for). */
  async channelOwner(kind: 'telegram' | 'email', address: string): Promise<{ ownerAccountId: string; viewer: Viewer } | null> {
    if (!address) return null;
    const bare = unscoped(this.db); // see above
    const c = (await bare.select().from(memberChannels).where(and(eq(memberChannels.kind, kind), eq(memberChannels.address, address))).limit(1)).at(0);
    if (!c) return null;
    const m = (await bare.select().from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, c.workspaceId), eq(workspaceMembers.memberAccountId, c.memberAccountId), eq(workspaceMembers.accountId, c.accountId))).limit(1)).at(0);
    if (!m) return null;
    return { ownerAccountId: c.accountId, viewer: { memberAccountId: m.memberAccountId, role: m.role as MemberRole, workspaceId: c.workspaceId, displayName: m.displayName } };
  }

  /** Inbox events addressed to `memberAccountId` across every workspace they
   *  belong to (the member's own push sweep runs in their account; the
   *  events live in the owners'). Not yet delivered on `column`. */
  async addressedEvents(memberAccountId: string, column: 'deliveredAt' | 'emailDeliveredAt' | 'pushDeliveredAt'): Promise<Array<typeof agentEvents.$inferSelect>> {
    const bare = unscoped(this.db); // cross-account by design, filtered to the addressee
    const rows = await bare.select().from(agentEvents).where(eq(agentEvents.forMemberAccountId, memberAccountId));
    return rows.filter((r) => r[column] === null && r.silent === 0).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Mark addressed events delivered on `column` (they live in the owners'
   *  accounts; the member's own sweep calls this from their account). */
  async markAddressedDelivered(ids: string[], column: 'deliveredAt' | 'emailDeliveredAt' | 'pushDeliveredAt', at: Date = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await unscoped(this.db).update(agentEvents).set({ [column]: at.toISOString() }).where(inArray(agentEvents.id, ids)); // see addressedEvents
  }

  /** The account email of a member, for routed-approval mail. */
  async memberEmail(memberAccountId: string): Promise<string> {
    const a = await this.accounts.get(memberAccountId).catch(() => null);
    return a?.email ?? '';
  }
}

function withoutToken(r: WorkspaceInvite): Omit<WorkspaceInvite, 'tokenHash'> {
  const copy: Partial<WorkspaceInvite> = { ...r };
  delete copy.tokenHash;
  return copy as Omit<WorkspaceInvite, 'tokenHash'>;
}

export function displayNameOf(a: { name?: string; email?: string } | null | undefined): string {
  if (!a) return 'Owner';
  if (a.name?.trim()) return a.name.trim();
  if (a.email) return a.email.split('@')[0];
  return 'Owner';
}
