/**
 * KitsService — kits installed into a company (docs/foundry.md §4, §5).
 *
 * A kit is applied as a **reconciliation**: from the kit version and the
 * owner's choices the service derives the members it wants (the interface
 * plugins it requires, the providers chosen for them, its consumer plugins,
 * a workspace binding per interface, its requested policies, its playbooks
 * as skills, its guidance notes, its seats and their grants), then creates
 * what is missing and removes what it owns and no longer wants. Install is
 * a reconciliation from nothing, an upgrade one to the new version (with a
 * revision row), a rollback one back to the revision's version, and
 * uninstall the reverse unwind. Each member is a `kit_members` row: `owned`
 * when the kit created it, not owned when it reused something the
 * workspace already had (a plugin the owner installed, a binding already
 * set) — reused things are never removed by the kit.
 *
 * Atomic: if a step fails before the seats, everything the run created is
 * unwound in reverse and the install is not left half-applied. Seats come
 * last (hiring creates agents, which a rollback never terminates); a seat
 * that cannot be hired leaves the kit `partial` with the reason.
 *
 * Every write goes through the plugin core's own owner-gated paths
 * (install with its review, bindings, policies that only raise, grants), so
 * the kit can do nothing the owner could not do by hand. The plan is the
 * review: every member plugin's classification and contributions, every
 * playbook's and note's full text, what is reused and what is new.
 */
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { kitInstalls, kitMembers, kitRevisions, pluginContributions } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { PluginsService } from '../plugins/plugins.service';
import { PluginAuditService } from '../plugins/plugin-audit';
import { SkillsService } from '../skills/skills.service';
import { parseSkillMd } from '../portability/skill-md';
import { CORE_API_VERSION } from '../plugins/manifest';
import { compareVersions, parseInterfaceRef, satisfies } from '../plugins/semver';
import { contributedSkillName } from '../plugins/contributions';
import type { PluginPackage } from '../plugins/loader';
import { kitPlaybooks, loadFirstPartyKits, type KitManifest, type KitPackage, type KitRole } from './kit-manifest';
import { KIT_PREVIEWS } from './kits.catalog';

export type KitInstallRow = typeof kitInstalls.$inferSelect;
export type KitMemberRow = typeof kitMembers.$inferSelect;

/** The owner's choices on the review: a provider (or `later`) per interface, and which seats to fill. */
export interface KitChoices { providers?: Record<string, string>; seats?: Record<string, boolean> }

/** The people side, bound by the org module (a workspace without a company has no seats). */
export interface KitPeopleHook {
  /** The chief of staff of the workspace's company, or null when there is none. */
  chief(workspaceId: string): Promise<string | null>;
  /** A live member already holding this catalog role (the seat reuses it). */
  existing(workspaceId: string, role: string): Promise<{ agentId: string; name: string } | null>;
  /** Hire a seat through the org's own hire path (caps, scopes, envelope). */
  hire(workspaceId: string, seat: { role: string; title: string; reportsToAgentId: string | null }, by: string): Promise<{ agentId: string; name: string }>;
}

interface Desired { kind: 'plugin' | 'binding' | 'policy' | 'skill' | 'guidance' | 'seat'; key: string; detail: Record<string, unknown> }

const LATER = 'later';

@Injectable()
export class KitsService {
  private catalogCache: Map<string, KitPackage> | null = null;
  people: KitPeopleHook | null = null;
  private readonly listeners: Array<(workspaceId: string) => void> = [];

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly plugins: PluginsService,
    private readonly audit: PluginAuditService,
    @Optional() private readonly skills?: SkillsService,
  ) {}

  onChange(fn: (workspaceId: string) => void): void { this.listeners.push(fn); }
  private changed(ws: string): void { for (const fn of this.listeners) { try { fn(ws); } catch { /* isolated */ } } }

  async catalog(): Promise<Map<string, KitPackage>> {
    if (!this.catalogCache) this.catalogCache = await loadFirstPartyKits();
    return this.catalogCache;
  }
  resetCatalog(): void { this.catalogCache = null; }

  private async pkg(kitId: string): Promise<KitPackage> {
    const id = kitId.includes('@') ? kitId : `${kitId}@yaam`;
    const p = (await this.catalog()).get(id);
    if (!p) throw new NotFoundException(`no kit ${id}`);
    return p;
  }

  // ---- the shelf ----

  /** Shipped kits (installable) first, then the designed ones not shipped yet (previews). */
  async shelf(workspaceId?: string, q?: { fn?: string; type?: string; q?: string }): Promise<Array<Record<string, unknown>>> {
    const cat = await this.catalog();
    const installs = workspaceId ? await this.installRows(workspaceId) : [];
    const out: Array<Record<string, unknown>> = [];
    for (const p of cat.values()) {
      const m = p.manifest;
      const inst = installs.find((i) => i.kitId === m.id && i.status !== 'removed');
      out.push({
        ...this.card(m), installable: satisfies(CORE_API_VERSION, m.requires.yaamCore), status: 'available',
        installed: inst ? { version: inst.version, status: inst.status, statusReason: inst.statusReason, updateAvailable: compareVersions(m.version, inst.version) > 0 } : null,
      });
    }
    const shipped = new Set([...cat.values()].map((p) => p.manifest.id.split('@')[0]));
    for (const k of KIT_PREVIEWS) if (!shipped.has(k.id)) out.push({ ...k, id: `${k.id}@yaam`, summary: k.blurb, installed: null });
    const needle = (q?.q ?? '').trim().toLowerCase();
    return out.filter((k) => (!q?.fn || (k.functions as string[]).includes(q.fn)) && (!q?.type || (k.companyTypes as string[] | undefined ?? []).includes(q.type))
      && (!needle || JSON.stringify([k.name, k.summary, k.interfaces, k.providers]).toLowerCase().includes(needle)));
  }

  /** A kit as a shelf card (the same shape as a preview, plus what it ships). */
  private card(m: KitManifest): Record<string, unknown> {
    const recs = m.recommends?.providers ?? {};
    return {
      id: m.id, name: m.name, summary: m.summary, blurb: m.summary, description: m.description ?? '', version: m.version, publisher: m.publisher, tier: 'first_party',
      functions: m.functions, companyTypes: m.companyTypes ?? [], fits: m.fits ?? [],
      interfaces: [...m.requires.interfaces.map((r) => ({ name: parseInterfaceRef(r)!.name })), ...(m.requires.optionalInterfaces ?? []).map((r) => ({ name: parseInterfaceRef(r)!.name, optional: true }))],
      providers: [...new Set(Object.values(recs).flat().map((r) => r.id))],
      seats: (m.roles ?? []).map((r) => `${r.title}${r.hire === 'optional' ? ' (optional)' : ''}`),
      cadences: m.rhythm ?? [], metrics: m.measures ?? [], policies: (m.policies ?? []).map((p) => p.why).join(' '),
      playbooks: kitPlaybooks(m).map((p) => p.name), guidance: (m.guidance ?? []).map((g) => g.title), plugins: (m.plugins ?? []).map((p) => p.id),
    };
  }

  // ---- what a kit wants ----

  /** The package in the plugin catalog that defines an interface. */
  private async interfacePackage(name: string): Promise<PluginPackage | null> {
    for (const p of (await this.plugins.catalog()).values()) if ((p.manifest.interfaces ?? []).some((i) => i.name === name)) return p;
    return null;
  }

  /** Providers in the catalog for an interface, ranked: the kit's recommendations first. */
  private async providerOptions(m: KitManifest, iface: string): Promise<Array<{ id: string; name: string; why: string; trial: boolean; available: boolean; recommended: boolean }>> {
    const cat = await this.plugins.catalog();
    const provides = (p: PluginPackage) => (p.manifest.provides ?? []).some((x) => parseInterfaceRef(x.interface)?.name === iface);
    const recs = m.recommends?.providers?.[iface] ?? [];
    const out = recs.map((r) => ({ id: r.id, name: cat.get(r.id)?.manifest.name ?? r.id, why: r.why, trial: r.trial === true, available: Boolean(cat.get(r.id) && provides(cat.get(r.id)!)), recommended: true }));
    for (const p of cat.values()) if (provides(p) && !out.some((o) => o.id === p.manifest.id)) out.push({ id: p.manifest.id, name: p.manifest.name, why: '', trial: /-mock@/.test(p.manifest.id), available: true, recommended: false });
    return out;
  }

  private ifaceNames(m: KitManifest): { required: string[]; optional: string[] } {
    return { required: m.requires.interfaces.map((r) => parseInterfaceRef(r)!.name), optional: (m.requires.optionalInterfaces ?? []).map((r) => parseInterfaceRef(r)!.name) };
  }

  /** The provider each interface gets: the owner's choice, else what is already bound, else the first available recommendation. */
  private async resolveProviders(workspaceId: string, m: KitManifest, choices: KitChoices): Promise<Record<string, string>> {
    const reg = await this.plugins.registry(workspaceId);
    const { required, optional } = this.ifaceNames(m);
    const out: Record<string, string> = {};
    for (const iface of [...required, ...optional]) {
      const chosen = choices.providers?.[iface];
      const opts = await this.providerOptions(m, iface);
      const bound = reg.bindings.find((b) => b.interface === iface && b.scopeKind === 'workspace');
      const boundPlugin = bound ? reg.providers.find((p) => p.row.id === bound.providerId)?.pluginId : undefined;
      if (chosen === LATER) { out[iface] = LATER; continue; }
      if (chosen) {
        if (!opts.some((o) => o.id === chosen && o.available)) throw new BadRequestException(`${chosen} does not provide ${iface} (or is not available here)`);
        out[iface] = chosen;
        continue;
      }
      if (boundPlugin) { out[iface] = boundPlugin; continue; }
      // Optional interfaces stay off unless the owner picks a provider.
      if (optional.includes(iface)) { out[iface] = LATER; continue; }
      out[iface] = opts.find((o) => o.available)?.id ?? LATER;
    }
    return out;
  }

  private seatOn(r: KitRole, choices: KitChoices): boolean {
    if (r.hire === 'required') return true;
    const c = choices.seats?.[r.key];
    return c === undefined ? r.hire === 'recommended' : c;
  }

  /** The members a kit version wants, in apply order. */
  private async desired(workspaceId: string, kit: KitPackage, choices: KitChoices): Promise<{ members: Desired[]; providers: Record<string, string>; problems: string[] }> {
    const m = kit.manifest;
    const problems: string[] = [];
    const providers = await this.resolveProviders(workspaceId, m, choices);
    const out: Desired[] = [];
    const add = (d: Desired) => { if (!out.some((x) => x.kind === d.kind && x.key === d.key)) out.push(d); };
    const { required, optional } = this.ifaceNames(m);
    for (const iface of [...required, ...optional]) {
      if (optional.includes(iface) && providers[iface] === LATER) continue;
      const pkg = await this.interfacePackage(iface);
      if (!pkg) { if (required.includes(iface)) problems.push(`no plugin defines the ${iface} interface yet`); continue; }
      add({ kind: 'plugin', key: pkg.manifest.id, detail: { role: 'interface', interface: iface } });
    }
    for (const iface of [...required, ...optional]) {
      const prov = providers[iface];
      if (!prov || prov === LATER) continue;
      add({ kind: 'plugin', key: prov, detail: { role: 'provider', interface: iface } });
    }
    for (const p of m.plugins ?? []) {
      if (p.optional) continue;
      if (!(await this.plugins.catalog()).get(p.id)) { problems.push(`${p.id} is not available`); continue; }
      add({ kind: 'plugin', key: p.id, detail: { role: 'consumer', why: p.why } });
    }
    const bindable = new Set((m.bindings ?? []).filter((b) => b.scope.kind === 'workspace').map((b) => b.interface));
    for (const iface of [...required, ...optional]) {
      const prov = providers[iface];
      if (!prov || prov === LATER || !bindable.has(iface)) continue;
      add({ kind: 'binding', key: iface, detail: { provider: prov } });
    }
    for (const p of m.policies ?? []) add({ kind: 'policy', key: p.id, detail: { ...p } });
    for (const pb of kitPlaybooks(m)) {
      const body = kit.files[pb.path];
      const parsed = parseSkillMd(body);
      add({ kind: 'skill', key: contributedSkillName(m.id, parsed.name), detail: { path: pb.path, description: parsed.description, instructions: parsed.body, audience: pb.audience } });
    }
    for (const g of m.guidance ?? []) add({ kind: 'guidance', key: g.id, detail: { ...g } });
    for (const r of m.roles ?? []) if (this.seatOn(r, choices)) add({ kind: 'seat', key: r.key, detail: { ...r } });
    return { members: out, providers, problems };
  }

  // ---- the plan (the review screen's model; writes nothing) ----

  async plan(workspaceId: string, kitId: string, choices: KitChoices = {}): Promise<Record<string, unknown>> {
    const kit = await this.pkg(kitId);
    const m = kit.manifest;
    const { members, providers, problems } = await this.desired(workspaceId, kit, choices);
    const reg = await this.plugins.registry(workspaceId);
    const current = await this.installRow(workspaceId, m.id);
    const blockers: string[] = [...problems];
    if (!satisfies(CORE_API_VERSION, m.requires.yaamCore)) blockers.push(`requires yaamCore ${m.requires.yaamCore}; this server implements ${CORE_API_VERSION}`);
    const live = current ? (await this.members(current.id)).filter((x) => x.state === 'live') : [];
    const pluginsOut = [];
    for (const d of members.filter((x) => x.kind === 'plugin')) {
      const li = await this.plugins.installOf(workspaceId, d.key);
      const installed = Boolean(li && li.install.status !== 'removed');
      let review: Record<string, unknown> | null = null;
      if (!installed) {
        review = await this.plugins.review(workspaceId, { firstParty: d.key }).catch((err: unknown) => ({ blockers: [err instanceof Error ? err.message : String(err)] }));
        for (const b of (review.blockers as string[] | undefined) ?? []) blockers.push(`${d.key}: ${b}`);
      }
      pluginsOut.push({
        id: d.key, role: d.detail.role, interface: d.detail.interface ?? null, why: d.detail.why ?? null, state: installed ? (live.some((x) => x.memberKind === 'plugin' && x.itemKey === d.key) ? 'in this kit' : `already installed (${li!.install.status}); reused`) : 'new',
        review: review ? summarizeReview(review) : null,
      });
    }
    const { required, optional } = this.ifaceNames(m);
    const interfaces = [];
    for (const iface of [...required, ...optional]) {
      const bound = reg.bindings.find((b) => b.interface === iface && b.scopeKind === 'workspace');
      const boundPlugin = bound ? reg.providers.find((p) => p.row.id === bound.providerId)?.pluginId ?? null : null;
      interfaces.push({ name: iface, optional: optional.includes(iface), installed: reg.interfaces.has(iface), boundTo: boundPlugin, choice: providers[iface] ?? LATER, options: await this.providerOptions(m, iface), note: boundPlugin && providers[iface] !== boundPlugin ? `keeps ${boundPlugin} for ${iface}` : null });
    }
    const chief = this.people ? await this.people.chief(workspaceId).catch(() => null) : null;
    const seats = [];
    for (const r of m.roles ?? []) {
      const filler = chief && this.people ? await this.people.existing(workspaceId, r.role).catch(() => null) : null;
      seats.push({ key: r.key, role: r.role, title: r.title, hire: r.hire, on: this.seatOn(r, choices), reportsTo: r.reportsTo, grants: r.grants ?? {}, playbooks: r.playbooks ?? [], filledBy: filler, available: Boolean(chief) });
    }
    const policies = await this.plugins.listPolicies(workspaceId);
    const partial = required.filter((i) => providers[i] === LATER);
    return {
      kit: { ...this.card(m), digest: kit.digest, changelog: m.changelog ?? '' },
      installed: current && current.status !== 'removed' ? { version: current.version, status: current.status } : null,
      interfaces, plugins: pluginsOut,
      policies: (m.policies ?? []).map((p) => ({ ...p, status: policies.some((x) => x.id === this.policyId(workspaceId, m.id, p.id)) ? 'already set' : 'applies' })),
      playbooks: members.filter((d) => d.kind === 'skill').map((d) => ({ name: d.key, description: d.detail.description, audience: d.detail.audience, text: d.detail.instructions })),
      guidance: (m.guidance ?? []).map((g) => ({ ...g })),
      seats, company: Boolean(chief),
      rhythm: m.rhythm ?? [], measures: m.measures ?? [],
      outcome: partial.length ? `partial: no ${partial.join(', ')} provider chosen (decide later)` : 'active',
      blockers,
    };
  }

  // ---- install, upgrade, rollback, uninstall ----

  async install(workspaceId: string, kitId: string, choices: KitChoices = {}, opts: { confirm?: boolean; by?: string } = {}): Promise<Record<string, unknown>> {
    const actor = await this.plugins.assertOwner(workspaceId, 'installs kits');
    const kit = await this.pkg(kitId);
    const plan = await this.plan(workspaceId, kit.manifest.id, choices);
    if (!opts.confirm) return { plan, installed: false };
    if ((plan.blockers as string[]).length) throw new BadRequestException({ message: 'the kit install is blocked', blockers: plan.blockers });
    const existing = await this.installRow(workspaceId, kit.manifest.id);
    if (existing && existing.status !== 'removed' && existing.status !== 'failed') {
      if (existing.version === kit.manifest.version) return { installed: false, already: true, install: await this.view(existing) };
      throw new ConflictException(`${kit.manifest.id}@${existing.version} is installed; upgrade it instead`);
    }
    const now = nowIso();
    let row: KitInstallRow;
    if (existing) {
      await this.db.update(kitInstalls).set({ version: kit.manifest.version, manifest: JSON.stringify(kit.manifest), status: 'applying', statusReason: '', choices: JSON.stringify(choices), installedBy: opts.by ?? actor, updatedAt: now, activatedAt: null }).where(eq(kitInstalls.id, existing.id));
      row = (await this.installRow(workspaceId, kit.manifest.id))!;
    } else {
      row = { accountId: currentAccountId(), id: newId(), workspaceId, kitId: kit.manifest.id, version: kit.manifest.version, manifest: JSON.stringify(kit.manifest), status: 'applying', statusReason: '', choices: JSON.stringify(choices), installedBy: opts.by ?? actor, createdAt: now, activatedAt: null, updatedAt: now };
      await this.db.insert(kitInstalls).values(row);
    }
    await this.audit.append(workspaceId, { actor: opts.by ?? actor, action: 'kit_installing', refType: 'kit', refId: kit.manifest.id, payload: { version: kit.manifest.version, digest: kit.digest, choices } });
    const result = await this.reconcile(workspaceId, row, kit, choices, opts.by ?? actor);
    return { installed: true, ...result, install: await this.view((await this.installRow(workspaceId, kit.manifest.id))!) };
  }

  /** Move an installed kit to the catalog's version: a revision row, then reconcile. */
  async upgrade(workspaceId: string, kitId: string, opts: { by?: string } = {}): Promise<Record<string, unknown>> {
    const actor = await this.plugins.assertOwner(workspaceId, 'upgrades kits');
    const kit = await this.pkg(kitId);
    const row = await this.liveInstall(workspaceId, kit.manifest.id);
    if (compareVersions(kit.manifest.version, row.version) <= 0) return { applied: false, reason: `already at ${row.version}` };
    const choices = JSON.parse(row.choices || '{}') as KitChoices;
    const plan = await this.plan(workspaceId, kit.manifest.id, choices);
    if ((plan.blockers as string[]).length) throw new BadRequestException({ message: 'the kit upgrade is blocked', blockers: plan.blockers });
    await this.db.insert(kitRevisions).values({ accountId: currentAccountId(), id: newId(), workspaceId, installId: row.id, fromVersion: row.version, toVersion: kit.manifest.version, fromManifest: row.manifest, choices: row.choices, approvedBy: opts.by ?? actor, appliedAt: nowIso(), rolledBackAt: null });
    await this.db.update(kitInstalls).set({ version: kit.manifest.version, manifest: JSON.stringify(kit.manifest), status: 'applying', updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
    await this.audit.append(workspaceId, { actor: opts.by ?? actor, action: 'kit_upgrading', refType: 'kit', refId: kit.manifest.id, payload: { from: row.version, to: kit.manifest.version } });
    const result = await this.reconcile(workspaceId, { ...row, version: kit.manifest.version }, kit, choices, opts.by ?? actor);
    return { applied: true, from: row.version, to: kit.manifest.version, ...result };
  }

  /** Back to the version a revision came from: its pinned manifest, reconciled; the revision is marked. */
  async rollback(workspaceId: string, kitId: string, revisionId?: string): Promise<Record<string, unknown>> {
    const actor = await this.plugins.assertOwner(workspaceId, 'rolls kits back');
    const row = await this.liveInstall(workspaceId, kitId.includes('@') ? kitId : `${kitId}@yaam`);
    const revs = (await this.db.select().from(kitRevisions).where(eq(kitRevisions.installId, row.id)).orderBy(desc(kitRevisions.appliedAt))).filter((r) => !r.rolledBackAt);
    const rev = revisionId ? revs.find((r) => r.id === revisionId) : revs[0];
    if (!rev) throw new BadRequestException('there is no applied upgrade to roll back');
    const manifest = JSON.parse(rev.fromManifest) as KitManifest;
    const cur = await this.pkg(row.kitId);
    // The previous version's playbooks: the pinned text is in its manifest's package when the catalog still carries it; else the current files.
    const kit: KitPackage = { manifest, files: cur.files, digest: '', warnings: [] };
    for (const pb of kitPlaybooks(manifest)) if (kit.files[pb.path] === undefined) throw new BadRequestException(`${pb.path} of ${row.kitId}@${rev.fromVersion} is no longer available`);
    await this.db.update(kitInstalls).set({ version: rev.fromVersion, manifest: rev.fromManifest, status: 'applying', updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
    const result = await this.reconcile(workspaceId, { ...row, version: rev.fromVersion }, kit, JSON.parse(rev.choices || '{}') as KitChoices, actor);
    await this.db.update(kitRevisions).set({ rolledBackAt: nowIso() }).where(eq(kitRevisions.id, rev.id));
    await this.audit.append(workspaceId, { actor, action: 'kit_rolled_back', refType: 'kit', refId: row.kitId, payload: { from: rev.toVersion, to: rev.fromVersion } });
    return { rolledBack: true, from: rev.toVersion, to: rev.fromVersion, ...result };
  }

  /** What uninstall would do, member by member (§5.4). */
  async uninstallPlan(workspaceId: string, kitId: string): Promise<Record<string, unknown>> {
    const row = await this.liveInstall(workspaceId, kitId.includes('@') ? kitId : `${kitId}@yaam`);
    const others = await this.otherKitPlugins(workspaceId, row.id);
    const items = (await this.members(row.id)).filter((x) => x.state === 'live').reverse().map((x) => ({
      kind: x.memberKind, key: x.itemKey, owned: x.owned === 1,
      outcome: x.memberKind === 'seat' ? 'kept (seats are never removed automatically)'
        : x.owned !== 1 ? 'kept (it was here before the kit)'
          : x.memberKind === 'binding' ? 'kept unless you remove bindings'
            : x.memberKind === 'policy' ? 'removed unless you keep the policies'
              : x.memberKind === 'skill' ? 'archived (never deleted)'
                : x.memberKind === 'plugin' && others.has(x.itemKey) ? 'kept (another kit uses it)' : 'removed',
    }));
    return { kit: row.kitId, version: row.version, items };
  }

  async uninstall(workspaceId: string, kitId: string, opts: { keepPolicies?: boolean; removeBindings?: boolean; by?: string } = {}): Promise<Record<string, unknown>> {
    const actor = await this.plugins.assertOwner(workspaceId, 'uninstalls kits');
    const row = await this.liveInstall(workspaceId, kitId.includes('@') ? kitId : `${kitId}@yaam`);
    await this.db.update(kitInstalls).set({ status: 'removing', updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
    const notes: string[] = [];
    const others = await this.otherKitPlugins(workspaceId, row.id);
    for (const mem of (await this.members(row.id)).filter((x) => x.state === 'live').reverse()) {
      const keep = mem.owned !== 1 || mem.memberKind === 'seat' || (mem.memberKind === 'binding' && !opts.removeBindings) || (mem.memberKind === 'policy' && opts.keepPolicies) || (mem.memberKind === 'plugin' && others.has(mem.itemKey));
      if (keep) { await this.setMemberState(mem.id, 'kept'); continue; }
      try { await this.removeMember(workspaceId, row, mem); } catch (err) {
        notes.push(`${mem.memberKind} ${mem.itemKey} kept: ${err instanceof Error ? err.message : String(err)}`);
        await this.setMemberState(mem.id, 'kept');
      }
    }
    await this.db.update(kitInstalls).set({ status: 'removed', statusReason: notes.join('; ').slice(0, 1_000), updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
    await this.audit.append(workspaceId, { actor: opts.by ?? actor, action: 'kit_uninstalled', refType: 'kit', refId: row.kitId, payload: { version: row.version, notes } });
    this.changed(workspaceId);
    return { ok: true, notes };
  }

  // ---- the reconciliation ----

  private async reconcile(workspaceId: string, row: KitInstallRow, kit: KitPackage, choices: KitChoices, actor: string): Promise<{ status: string; reason: string; created: string[]; removed: string[] }> {
    const { members: want, providers } = await this.desired(workspaceId, kit, choices);
    const have = (await this.members(row.id)).filter((x) => x.state === 'live');
    const created: KitMemberRow[] = [];
    const removed: string[] = [];
    const seats = want.filter((d) => d.kind === 'seat');
    try {
      for (const d of want.filter((x) => x.kind !== 'seat')) {
        if (have.some((x) => x.memberKind === d.kind && x.itemKey === d.key)) continue;
        created.push(await this.createMember(workspaceId, row, kit, d, actor));
      }
      // Members the kit owns and no longer wants (an upgrade dropped them, a rollback undoes them).
      const others = await this.otherKitPlugins(workspaceId, row.id);
      for (const mem of [...have].reverse()) {
        if (mem.memberKind === 'seat' || mem.memberKind === 'grant') continue;
        if (want.some((d) => d.kind === mem.memberKind && d.key === mem.itemKey)) continue;
        if (mem.owned !== 1 || (mem.memberKind === 'plugin' && others.has(mem.itemKey))) { await this.setMemberState(mem.id, 'kept'); continue; }
        await this.removeMember(workspaceId, row, mem);
        removed.push(`${mem.memberKind}:${mem.itemKey}`);
      }
    } catch (err) {
      // Atomic: unwind what this run created, newest first.
      for (const mem of created.reverse()) await this.removeMember(workspaceId, row, mem).catch(() => undefined);
      const why = err instanceof Error ? err.message : String(err);
      await this.db.update(kitInstalls).set({ status: have.length ? 'active' : 'failed', statusReason: `apply failed and was rolled back: ${why}`.slice(0, 1_000), updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
      await this.audit.append(workspaceId, { actor, action: 'kit_apply_failed', refType: 'kit', refId: row.kitId, payload: { why, unwound: created.length } });
      this.changed(workspaceId);
      throw new BadRequestException(`the kit could not be applied, nothing was left half-done: ${why}`);
    }
    // Seats last: hires are not unwound by a failure; one that fails leaves the kit partial.
    const seatNotes: string[] = [];
    for (const d of seats) {
      if (have.some((x) => x.memberKind === 'seat' && x.itemKey === d.key)) continue;
      try { created.push(...await this.createSeat(workspaceId, row, kit, d, providers)); } catch (err) { seatNotes.push(`${String(d.detail.title)} not hired: ${err instanceof Error ? err.message : String(err)}`); }
    }
    const { required } = this.ifaceNames(kit.manifest);
    const missing = required.filter((i) => providers[i] === LATER);
    const reasons = [...(missing.length ? [`no ${missing.join(', ')} provider bound`] : []), ...seatNotes];
    const status = reasons.length ? 'partial' : 'active';
    await this.db.update(kitInstalls).set({ status, statusReason: reasons.join('; ').slice(0, 1_000), activatedAt: status === 'active' ? nowIso() : null, updatedAt: nowIso() }).where(eq(kitInstalls.id, row.id));
    await this.audit.append(workspaceId, { actor, action: 'kit_applied', refType: 'kit', refId: row.kitId, payload: { version: row.version, status, created: created.map((c) => `${c.memberKind}:${c.itemKey}`), removed } });
    this.changed(workspaceId);
    return { status, reason: reasons.join('; '), created: created.map((c) => `${c.memberKind}:${c.itemKey}`), removed };
  }

  private policyId(workspaceId: string, kitId: string, id: string): string { return `kit:${kitId}:${id}:${workspaceId}`; }

  private async addMember(workspaceId: string, installId: string, kind: string, key: string, ref: string, owned: boolean): Promise<KitMemberRow> {
    const last = (await this.db.select().from(kitMembers).where(eq(kitMembers.installId, installId)).orderBy(desc(kitMembers.seq)).limit(1)).at(0);
    const row: KitMemberRow = { accountId: currentAccountId(), id: newId(), workspaceId, installId, seq: (last?.seq ?? 0) + 1, memberKind: kind, itemKey: key, ref, owned: owned ? 1 : 0, state: 'live', createdAt: nowIso() };
    await this.db.insert(kitMembers).values(row);
    return row;
  }

  private async createMember(workspaceId: string, row: KitInstallRow, kit: KitPackage, d: Desired, actor: string): Promise<KitMemberRow> {
    const m = kit.manifest;
    switch (d.kind) {
      case 'plugin': {
        const li = await this.plugins.installOf(workspaceId, d.key);
        if (li && li.install.status !== 'removed') return this.addMember(workspaceId, row.id, 'plugin', d.key, li.install.id, false);
        const res = await this.plugins.install(workspaceId, { firstParty: d.key }, { confirm: true });
        const installId = String((res.install as Record<string, unknown> | undefined)?.installId ?? '');
        return this.addMember(workspaceId, row.id, 'plugin', d.key, installId, true);
      }
      case 'binding': {
        const reg = await this.plugins.registry(workspaceId);
        const bound = reg.bindings.find((b) => b.interface === d.key && b.scopeKind === 'workspace');
        if (bound) return this.addMember(workspaceId, row.id, 'binding', d.key, bound.id, false);
        const res = await this.plugins.setBinding(workspaceId, d.key, { scopeKind: 'workspace', providerId: String(d.detail.provider) });
        return this.addMember(workspaceId, row.id, 'binding', d.key, String((res.binding as Record<string, unknown> | undefined)?.id ?? ''), true);
      }
      case 'policy': {
        const p = d.detail as unknown as NonNullable<KitManifest['policies']>[number];
        const id = this.policyId(workspaceId, m.id, p.id);
        await this.plugins.putPolicy(workspaceId, id, { operation: p.match.operation, changeKind: p.match.changeKind, require: p.require, why: `${p.why} (kit ${m.name})` });
        return this.addMember(workspaceId, row.id, 'policy', d.key, id, true);
      }
      case 'skill': {
        if (!this.skills) throw new Error('skills are not available on this server');
        const s = await this.skills.contribute({ workspaceId, name: d.key, description: String(d.detail.description), instructions: String(d.detail.instructions), audience: d.detail.audience as string[], source: `kit:${m.id}`, draft: false });
        return this.addMember(workspaceId, row.id, 'skill', d.key, s.id, true);
      }
      case 'guidance': {
        const id = newId();
        await this.db.insert(pluginContributions).values({ accountId: currentAccountId(), id, workspaceId, ownerKind: 'kit', ownerId: m.id, installId: row.id, version: m.version, kind: 'guidance', key: d.key, spec: JSON.stringify(d.detail), createdAt: nowIso() });
        return this.addMember(workspaceId, row.id, 'guidance', d.key, id, true);
      }
      default:
        void actor;
        throw new Error(`unknown member kind ${d.kind}`);
    }
  }

  /** A seat: reuse a member holding the role, else hire; then its grants on the bound providers. */
  private async createSeat(workspaceId: string, row: KitInstallRow, kit: KitPackage, d: Desired, providers: Record<string, string>): Promise<KitMemberRow[]> {
    if (!this.people) throw new Error('seats need a company');
    const chief = await this.people.chief(workspaceId);
    if (!chief) throw new Error('this workspace has no company; hire from Agents once it has one');
    const r = d.detail as unknown as KitRole;
    const out: KitMemberRow[] = [];
    let agent = await this.people.existing(workspaceId, r.role);
    let owned = false;
    if (!agent) {
      let reportsTo: string | null = chief;
      if (r.reportsTo !== '$chief') {
        const mgr = (await this.members(row.id)).find((x) => x.memberKind === 'seat' && x.itemKey === r.reportsTo && x.state === 'live');
        reportsTo = mgr?.ref || chief;
      }
      agent = await this.people.hire(workspaceId, { role: r.role, title: r.title, reportsToAgentId: reportsTo }, `kit:${kit.manifest.id}`);
      owned = true;
    }
    out.push(await this.addMember(workspaceId, row.id, 'seat', r.key, agent.agentId, owned));
    for (const [iface, level] of Object.entries(r.grants ?? {})) {
      const prov = providers[iface];
      if (!prov || prov === LATER) continue;
      const have = (await this.plugins.grantsOf(workspaceId, agent.agentId));
      const li = await this.plugins.installOf(workspaceId, prov);
      if (!li) continue;
      const cur = have.find((g) => g.installId === li.install.id);
      if (cur && (cur.level === 'write' || cur.level === level)) continue;
      await this.plugins.setGrant(workspaceId, prov, agent.agentId, { level });
      out.push(await this.addMember(workspaceId, row.id, 'grant', `${r.key}:${iface}`, `${prov}|${agent.agentId}`, true));
    }
    return out;
  }

  private async removeMember(workspaceId: string, row: KitInstallRow, mem: KitMemberRow): Promise<void> {
    if (mem.owned === 1) {
      switch (mem.memberKind) {
        case 'plugin': {
          const li = await this.plugins.installOf(workspaceId, mem.itemKey);
          if (li && li.install.status !== 'removed') await this.plugins.uninstall(workspaceId, mem.itemKey);
          break;
        }
        case 'binding': await this.plugins.setBinding(workspaceId, mem.itemKey, { scopeKind: 'workspace', providerId: null }).catch(() => undefined); break;
        case 'policy': await this.plugins.deletePolicy(workspaceId, mem.ref).catch(() => undefined); break;
        case 'skill': await this.skills?.setContributedEnabled(mem.ref, false); break;
        case 'guidance': await this.db.delete(pluginContributions).where(eq(pluginContributions.id, mem.ref)); break;
        case 'grant': {
          const [plugin, agentId] = mem.ref.split('|');
          await this.plugins.setGrant(workspaceId, plugin, agentId, { level: null }).catch(() => undefined);
          break;
        }
        default: break;
      }
    }
    await this.setMemberState(mem.id, 'removed');
    void row;
  }

  private async setMemberState(id: string, state: string): Promise<void> {
    await this.db.update(kitMembers).set({ state }).where(eq(kitMembers.id, id));
  }

  /** Plugins another live kit install holds (not removed with this one). */
  private async otherKitPlugins(workspaceId: string, installId: string): Promise<Set<string>> {
    const rows = await this.db.select().from(kitMembers).where(and(eq(kitMembers.workspaceId, workspaceId), eq(kitMembers.memberKind, 'plugin'), eq(kitMembers.state, 'live'), ne(kitMembers.installId, installId)));
    return new Set(rows.map((r) => r.itemKey));
  }

  // ---- views ----

  async installRow(workspaceId: string, kitId: string): Promise<KitInstallRow | null> {
    return (await this.db.select().from(kitInstalls).where(and(eq(kitInstalls.workspaceId, workspaceId), eq(kitInstalls.kitId, kitId)))).at(0) ?? null;
  }
  private async liveInstall(workspaceId: string, kitId: string): Promise<KitInstallRow> {
    const row = await this.installRow(workspaceId, kitId);
    if (!row || row.status === 'removed' || row.status === 'failed') throw new NotFoundException(`${kitId} is not installed`);
    return row;
  }
  async installRows(workspaceId: string): Promise<KitInstallRow[]> {
    return this.db.select().from(kitInstalls).where(eq(kitInstalls.workspaceId, workspaceId));
  }
  async members(installId: string): Promise<KitMemberRow[]> {
    return this.db.select().from(kitMembers).where(eq(kitMembers.installId, installId)).orderBy(asc(kitMembers.seq));
  }

  /** An install with its members, health per required interface, update and revisions. */
  async view(row: KitInstallRow): Promise<Record<string, unknown>> {
    const m = JSON.parse(row.manifest) as KitManifest;
    const reg = await this.plugins.registry(row.workspaceId);
    const cat = (await this.catalog()).get(row.kitId);
    const health = this.ifaceNames(m).required.map((iface) => {
      const b = reg.bindings.find((x) => x.interface === iface && x.scopeKind === 'workspace');
      const p = b ? reg.providers.find((x) => x.row.id === b.providerId) : undefined;
      return { interface: iface, boundTo: p?.pluginId ?? null, healthy: Boolean(p?.healthy) };
    });
    const revisions = await this.db.select().from(kitRevisions).where(eq(kitRevisions.installId, row.id)).orderBy(desc(kitRevisions.appliedAt));
    return {
      id: row.id, kitId: row.kitId, name: m.name, version: row.version, status: row.status, statusReason: row.statusReason, installedBy: row.installedBy, createdAt: row.createdAt, activatedAt: row.activatedAt,
      choices: JSON.parse(row.choices || '{}') as KitChoices,
      health, healthy: health.every((h) => h.healthy),
      update: cat && compareVersions(cat.manifest.version, row.version) > 0 ? { version: cat.manifest.version, changelog: cat.manifest.changelog ?? '' } : null,
      revisions: revisions.map((r) => ({ id: r.id, from: r.fromVersion, to: r.toVersion, appliedAt: r.appliedAt, rolledBackAt: r.rolledBackAt })),
      members: (await this.members(row.id)).map((x) => ({ kind: x.memberKind, key: x.itemKey, ref: x.ref, owned: x.owned === 1, state: x.state })),
    };
  }

  async list(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const out = [];
    for (const r of await this.installRows(workspaceId)) if (r.status !== 'removed' && r.status !== 'failed') out.push(await this.view(r));
    return out;
  }

  async detail(workspaceId: string | null, kitId: string): Promise<Record<string, unknown>> {
    const kit = await this.pkg(kitId);
    const row = workspaceId ? await this.installRow(workspaceId, kit.manifest.id) : null;
    return {
      ...this.card(kit.manifest), digest: kit.digest, changelog: kit.manifest.changelog ?? '', requires: kit.manifest.requires,
      roles: kit.manifest.roles ?? [], policyList: kit.manifest.policies ?? [], guidanceNotes: kit.manifest.guidance ?? [],
      playbookList: kitPlaybooks(kit.manifest).map((p) => { const s = parseSkillMd(kit.files[p.path]); return { name: p.name, description: s.description, audience: p.audience }; }),
      recommends: kit.manifest.recommends ?? {},
      install: row && row.status !== 'removed' && row.status !== 'failed' ? await this.view(row) : null,
    };
  }

  /** Who installed what, for the briefing and agents: one short line per kit. */
  async summaryLine(workspaceId: string): Promise<string> {
    const kits = (await this.installRows(workspaceId)).filter((r) => r.status === 'active' || r.status === 'partial');
    return kits.map((k) => `${(JSON.parse(k.manifest) as KitManifest).name}${k.status === 'partial' ? ' (partial)' : ''}`).join(', ');
  }

  /** The actor who started a write, for proposals applied on the owner's approval. */
  static actor(): string { return actorId(); }
}

/** The part of a plugin review the kit review shows per member. */
function summarizeReview(r: Record<string, unknown>): Record<string, unknown> {
  const ifaces = (r.interfaces as Array<{ name: string; operations: Array<{ canonical: string; effectiveClass: string; twoKeyByFloor: boolean }> }> | undefined) ?? [];
  return {
    name: r.name, version: r.version, tier: r.tier, roles: r.roles, description: r.description,
    operations: ifaces.flatMap((i) => i.operations.map((o) => ({ op: o.canonical, effectiveClass: o.effectiveClass, twoKey: o.twoKeyByFloor }))),
    provides: ((r.provides as Array<{ interface: string }> | undefined) ?? []).map((p) => p.interface),
    egress: r.egress ?? [], dataSharing: r.dataSharing ?? [], requestedPolicies: r.requestedPolicies ?? [],
    contributions: r.contributions ?? null, blockers: r.blockers ?? [],
  };
}
