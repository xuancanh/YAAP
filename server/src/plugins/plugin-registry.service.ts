/**
 * The plugin registry (docs/plugins.md §7, §8; docs/foundry.md §9): the
 * packages Foundry's Plugins shelf lists, their immutable versions and what
 * the registry knows about each — the pinned digest (sha256 over the
 * manifest and every referenced file) and source pin, the core API range,
 * the publisher and tier, the registry's own mock conformance per provided
 * interface, the install count and the recall flag.
 *
 * Three sources feed it:
 * - **first party**: the folders under `plugins/first-party/`, synced on
 *   first use (tier `first_party`, namespace `@yaam`);
 * - **local**: a folder the owner uploads (or loads in developer mode) as
 *   `name@local`, through the loader's archive rules — no scripts, no
 *   symlinks, no executable bits, nothing runs at install — visible only to
 *   the workspace that loaded it;
 * - **registry**: a package published here (namespace `@community`, tier
 *   `community`), through the same capability review the agent registry
 *   runs: a dry run shows what installers will see, the second call lists
 *   it. A listing row of kind `plugin` is mirrored into `registry_items` so
 *   the public feed carries it.
 *
 * Recall freezes every install of a version through the registrar
 * (`PluginsService.freeze`); a recalled version never installs again.
 * Updates list every newer installable version with its permission diff.
 *
 * Domain-free like the rest of the mechanism: it reads declarations and
 * never names one.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { pluginInstalls, plugins, pluginVersions, registryItems } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { CORE_API_VERSION, lintText, type InterfaceDef, type Manifest, type Suite, type Tier } from './manifest';
import { packageFrom, PluginLoadError, referencedFiles, type PluginPackage } from './loader';
import { isWidening, permissionDiff, staticClassOf, type DiffEntry } from './policy';
import { compareVersions, parseInterfaceRef, satisfies } from './semver';
import { runSuite } from './conformance';
import { PluginsService, toolName, type InstallSource } from './plugins.service';
import { PluginAuditService } from './plugin-audit';

type PluginRow = typeof plugins.$inferSelect;
type VersionRow = typeof pluginVersions.$inferSelect;

export const TIERS: readonly Tier[] = ['first_party', 'verified', 'community', 'local'];
const TIER_ORDER: Record<string, number> = { first_party: 0, verified: 1, community: 2, local: 3 };
/** A source pin is a full hex digest of the source revision, never a moving ref. */
const SOURCE_PIN_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CHANGELOG_MAX = 4000;

export interface ConformanceEntry {
  interface: string; range: string; interfaceVersion: string | null; mode: string;
  result: 'pass' | 'fail' | 'error' | 'unverified'; passed: number; failed: number; failures: string[]; ranAt: string;
}

export interface OperationView {
  op: string; canonical: string; tool: string; semantics: string; declaredClass: string | null; effectiveClass: string;
  floorReasons: string[]; twoKey: boolean; outbound: boolean; movesMoney: boolean; reversibility: string; required: boolean;
}

export interface Capabilities {
  roles: string[];
  /** Interfaces this package defines (role interface). */
  defines: Array<{ name: string; version: string; semantics: string; operations: OperationView[]; changeKinds: string[]; events: string[] }>;
  /** Interfaces this package implements (role provider), with the operations as yaam will treat them. */
  provides: Array<{ interface: string; range: string; resources: string[]; conformanceMode: string; operations: OperationView[]; missingRequired: string[]; resolvedWith: string | null }>;
  /** Interfaces this package needs (consumers and providers). */
  requires: string[];
  egress: Array<{ host: string; category: string }>;
  dataSharing: Array<{ category: string; to: string; when: string; purpose: string }>;
  secrets: Array<{ slot: string; description: string; kind: string; inject: string }>;
  identity: Array<{ header: string; value: string }>;
  connections: string[];
  requestedPolicies: Array<{ operation: string | null; changeKind: string | null; require: string; why: string }>;
  budgets: Record<string, number>;
  consumer: { skills: number; rolePacks: number; playbooks: number; verifies: number };
  extras: Array<{ name: string; declaredClass: string | null }>;
  noEgress: boolean;
}

/** An interface the registry knows, with the suite its providers run. */
interface KnownIface { name: string; version: string; def: InterfaceDef; suite: Suite | undefined; from: string }

/** Every interface tag a package touches, for search and the interface filter. */
function touched(m: Manifest): { defines: string[]; provides: string[]; requires: string[] } {
  return {
    defines: (m.interfaces ?? []).map((i) => i.name),
    provides: (m.provides ?? []).map((p) => parseInterfaceRef(p.interface)?.name ?? '').filter(Boolean),
    requires: (m.requires.interfaces ?? []).map((r) => parseInterfaceRef(r)?.name ?? '').filter(Boolean),
  };
}

function opView(iface: InterfaceDef, op: string, provides?: Parameters<typeof staticClassOf>[3]): OperationView {
  const def = iface.operations[op];
  const st = staticClassOf(op, def, iface, provides);
  return {
    op, canonical: `${iface.name}.${op}`, tool: toolName(iface.name, op), semantics: def.semantics, declaredClass: def.class ?? null,
    effectiveClass: st.cls, floorReasons: st.floor.reasons, twoKey: st.floor.twoKey, outbound: Boolean(def.outbound), movesMoney: Boolean(def.movesMoney),
    reversibility: String(def.reversibility ?? ''), required: Boolean(def.required),
  };
}

@Injectable()
export class PluginRegistryService {
  private synced: Promise<void> | null = null;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly plugins: PluginsService,
    private readonly audit: PluginAuditService,
  ) {}

  // ---- the first-party source ----

  /** Make sure every first-party package has its registry row and version (once per process and account). */
  async syncFirstParty(): Promise<void> {
    if (!this.synced) this.synced = this.doSync().catch((err) => { this.synced = null; throw err; });
    return this.synced;
  }

  /** Test seam: forget the sync (after the catalog changes). */
  resetSync(): void { this.synced = null; this.plugins.resetCatalog(); }

  private async doSync(): Promise<void> {
    const cat = await this.plugins.catalog();
    const index = await this.interfaceIndex();
    for (const [id, pkg] of cat) {
      const m = pkg.manifest;
      const row = (await this.db.select().from(plugins).where(eq(plugins.pluginId, id))).at(0);
      const listing = { name: m.name, description: m.description ?? '', publisherId: m.publisher.id, publisherName: m.publisher.name, tier: 'first_party', roles: JSON.stringify(m.roles), source: 'first_party', workspaceId: '', listed: 1, updatedAt: nowIso() };
      if (!row) await this.db.insert(plugins).values({ accountId: currentAccountId(), id: newId(), pluginId: id, registryItemId: null, createdAt: nowIso(), installs: 0, ...listing });
      else await this.db.update(plugins).set(listing).where(eq(plugins.id, row.id));
      const v = await this.plugins.versionRow(pkg, 'first_party');
      if (v.conformance === '[]' || v.capabilities === '{}') {
        const conformance = await this.conformanceOf(pkg, index);
        await this.db.update(pluginVersions).set({ conformance: JSON.stringify(conformance), capabilities: JSON.stringify(this.capabilitiesOf(pkg, index)), publishedBy: 'yaam' }).where(eq(pluginVersions.id, v.id));
      }
    }
  }

  // ---- what the registry knows about interfaces ----

  /** Interfaces defined by listed, unrecalled versions (and the first-party catalog), newest first per name. */
  private async interfaceIndex(extra?: PluginPackage): Promise<Map<string, KnownIface[]>> {
    const out = new Map<string, KnownIface[]>();
    const add = (pkg: PluginPackage) => {
      for (const def of pkg.manifest.interfaces ?? []) {
        const list = out.get(def.name) ?? [];
        if (!list.some((k) => k.version === def.version)) list.push({ name: def.name, version: def.version, def, suite: pkg.suites[def.conformance], from: pkg.manifest.id });
        out.set(def.name, list);
      }
    };
    for (const pkg of (await this.plugins.catalog()).values()) add(pkg);
    const rows = await this.db.select().from(pluginVersions).where(ne(pluginVersions.source, 'local'));
    for (const r of rows) {
      if (r.revokedAt) continue;
      const m = JSON.parse(r.manifest) as Manifest;
      if (!(m.interfaces ?? []).length) continue;
      try { add(packageFrom(m, JSON.parse(r.files || '{}') as Record<string, string>)); } catch { /* a stored version that no longer validates defines nothing */ }
    }
    if (extra) add(extra);
    for (const list of out.values()) list.sort((a, b) => compareVersions(b.version, a.version));
    return out;
  }

  private resolveIface(index: Map<string, KnownIface[]>, ref: string): KnownIface | null {
    const r = parseInterfaceRef(ref);
    if (!r) return null;
    return (index.get(r.name) ?? []).find((k) => satisfies(k.version, r.range)) ?? null;
  }

  /** The registry's own mock conformance for each provided interface (§7.1: shown per interface version; the local run decides). */
  private async conformanceOf(pkg: PluginPackage, index: Map<string, KnownIface[]>): Promise<ConformanceEntry[]> {
    const out: ConformanceEntry[] = [];
    for (const p of pkg.manifest.provides ?? []) {
      const ref = parseInterfaceRef(p.interface)!;
      const iface = this.resolveIface(index, p.interface);
      const base = { interface: ref.name, range: ref.range, mode: p.conformance.mode, ranAt: nowIso() };
      if (!iface) { out.push({ ...base, interfaceVersion: null, result: 'unverified', passed: 0, failed: 0, failures: [`no ${ref.name} version in the registry satisfies ${ref.range}`] }); continue; }
      const r = await runSuite({ iface: iface.def, suite: iface.suite, pkg: { provides: p, fixtures: pkg.fixtures }, runId: 'registry' });
      out.push({
        ...base, interfaceVersion: iface.version, result: r.result,
        passed: r.cases.filter((c) => c.ok && !c.skipped).length, failed: r.cases.filter((c) => !c.ok).length,
        failures: r.cases.filter((c) => !c.ok).slice(0, 8).map((c) => `${c.id}: ${c.detail ?? 'failed'}`),
      });
    }
    return out;
  }

  capabilitiesOf(pkg: PluginPackage, index: Map<string, KnownIface[]>): Capabilities {
    const m = pkg.manifest;
    return {
      roles: m.roles,
      defines: (m.interfaces ?? []).map((i) => ({
        name: i.name, version: i.version, semantics: i.semantics,
        operations: Object.keys(i.operations).map((op) => opView(i, op)),
        changeKinds: Object.keys(i.changeKinds ?? {}).map((k) => `${i.name}.${k}`),
        events: Object.keys(i.events ?? {}).map((e) => `${i.name}.${e}`),
      })),
      provides: (m.provides ?? []).map((p) => {
        const ref = parseInterfaceRef(p.interface)!;
        const iface = this.resolveIface(index, p.interface);
        return {
          interface: ref.name, range: ref.range, resources: p.resources, conformanceMode: p.conformance.mode,
          operations: iface ? Object.keys(p.operations).filter((op) => iface.def.operations[op]).map((op) => opView(iface.def, op, p)) : [],
          missingRequired: iface ? Object.entries(iface.def.operations).filter(([op, d]) => d.required && !p.operations[op]).map(([op]) => op) : [],
          resolvedWith: iface ? `${iface.from} (${ref.name}@${iface.version})` : null,
        };
      }),
      requires: m.requires.interfaces ?? [],
      egress: m.egress ?? [],
      dataSharing: m.dataSharing ?? [],
      secrets: (m.secrets ?? []).map((s) => ({ slot: s.slot, description: s.description, kind: s.kind, inject: s.inject })),
      identity: (m.identity ?? []).map((x) => ({ header: x.header, value: x.value })),
      connections: (m.connections ?? []).map((c) => String(c.id ?? '')),
      requestedPolicies: (m.policies ?? []).map((p) => ({ operation: p.match.operation ?? null, changeKind: p.match.changeKind ?? null, require: p.require, why: p.why })),
      budgets: Object.fromEntries(Object.entries(m.budgets ?? {}).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
      consumer: { skills: (m.skills ?? []).length, rolePacks: (m.rolePacks ?? []).length, playbooks: (m.playbooks ?? []).length, verifies: (m.verifies ?? []).length },
      extras: (m.tools?.items ?? []).map((t) => ({ name: `${m.toolPrefix ?? ''}_${t.name}`, declaredClass: t.class ?? null })),
      noEgress: (m.egress ?? []).length === 0,
    };
  }

  // ---- browse ----

  private visible(row: PluginRow, workspaceId: string): boolean {
    if (row.listed !== 1 && row.source !== 'local') return false;
    return row.source !== 'local' || row.workspaceId === workspaceId;
  }

  private async versionsOf(pluginIds: string[]): Promise<Map<string, VersionRow[]>> {
    const out = new Map<string, VersionRow[]>();
    if (pluginIds.length === 0) return out;
    for (const v of await this.db.select().from(pluginVersions).where(inArray(pluginVersions.pluginId, pluginIds))) {
      const list = out.get(v.pluginId) ?? [];
      list.push(v);
      out.set(v.pluginId, list);
    }
    for (const list of out.values()) list.sort((a, b) => compareVersions(b.version, a.version));
    return out;
  }

  /** The newest version that can be installed here: not recalled, core range satisfied. */
  private latestInstallable(versions: VersionRow[]): VersionRow | null {
    return versions.find((v) => !v.revokedAt && satisfies(CORE_API_VERSION, v.coreRange)) ?? null;
  }

  private entry(row: PluginRow, versions: VersionRow[], installed: Awaited<ReturnType<PluginsService['installOf']>>) {
    const latest = this.latestInstallable(versions);
    const shown = latest ?? versions[0];
    const m = shown ? JSON.parse(shown.manifest) as Manifest : null;
    const t = m ? touched(m) : { defines: [], provides: [], requires: [] };
    const conformance = shown ? JSON.parse(shown.conformance || '[]') as ConformanceEntry[] : [];
    const live = installed && installed.install.status !== 'removed' ? installed : null;
    return {
      id: row.pluginId, name: row.name, description: row.description || m?.description || '', tier: row.tier, source: row.source,
      publisher: m?.publisher ?? { id: row.publisherId, name: row.publisherName }, roles: JSON.parse(row.roles || '[]') as string[],
      version: shown?.version ?? null, digest: shown?.archiveSha256 ?? null, coreRange: shown?.coreRange ?? null,
      compatible: Boolean(shown && satisfies(CORE_API_VERSION, shown.coreRange)),
      defines: t.defines, provides: t.provides, requires: t.requires,
      noEgress: (m?.egress ?? []).length === 0,
      conformance: conformance.map((c) => ({ interface: c.interface, interfaceVersion: c.interfaceVersion, result: c.result })),
      installs: row.installs, versions: versions.length,
      recalled: versions.length > 0 && !latest && versions.every((v) => v.revokedAt),
      installable: Boolean(latest),
      publishedAt: shown?.createdAt ?? row.createdAt,
      installed: live ? {
        status: live.install.status, version: live.manifest.version, notice: live.install.status === 'frozen' ? live.install.suspendedReason : '',
        recalled: Boolean(live.version.revokedAt),
      } : null,
      updateAvailable: Boolean(live && latest && latest.archiveSha256 !== live.version.archiveSha256 && compareVersions(latest.version, live.manifest.version) >= 0),
    };
  }

  /** Foundry's Plugins shelf: search, role, interface and tier filters, plus the facets that drive them. */
  async list(workspaceId: string, filter: { q?: string; role?: string; iface?: string; tier?: string } = {}) {
    await this.syncFirstParty();
    const rows = (await this.db.select().from(plugins)).filter((r) => this.visible(r, workspaceId));
    const versions = await this.versionsOf(rows.map((r) => r.pluginId));
    const all: Array<ReturnType<PluginRegistryService['entry']>> = [];
    for (const r of rows) all.push(this.entry(r, versions.get(r.pluginId) ?? [], await this.plugins.installOf(workspaceId, r.pluginId)));
    const q = (filter.q ?? '').trim().toLowerCase();
    const items = all.filter((e) => (!filter.role || e.roles.includes(filter.role))
      && (!filter.iface || [...e.defines, ...e.provides, ...e.requires].includes(filter.iface))
      && (!filter.tier || e.tier === filter.tier)
      && (!q || `${e.id} ${e.name} ${e.description} ${e.publisher.name} ${[...e.defines, ...e.provides, ...e.requires].join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9) || a.name.localeCompare(b.name));
    const ifaces = new Map<string, { name: string; defined: boolean; providers: number; consumers: number }>();
    for (const e of all) {
      for (const n of e.defines) ifaces.set(n, { ...(ifaces.get(n) ?? { name: n, providers: 0, consumers: 0 }), defined: true });
      for (const n of e.provides) { const x = ifaces.get(n) ?? { name: n, defined: false, providers: 0, consumers: 0 }; x.providers++; ifaces.set(n, x); }
      for (const n of e.requires.filter((x) => !e.provides.includes(x))) { const x = ifaces.get(n) ?? { name: n, defined: false, providers: 0, consumers: 0 }; x.consumers++; ifaces.set(n, x); }
    }
    return {
      items,
      facets: {
        interfaces: [...ifaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
        tiers: Object.fromEntries(TIERS.map((t) => [t, all.filter((e) => e.tier === t).length])),
        roles: Object.fromEntries(['interface', 'provider', 'consumer'].map((r) => [r, all.filter((e) => e.roles.includes(r)).length])),
      },
      coreApi: CORE_API_VERSION,
    };
  }

  /** The detail page: what it provides and requires (operations with their effective classes), egress, data sharing, secrets, conformance, versions, publisher. */
  async detail(workspaceId: string, pluginId: string) {
    await this.syncFirstParty();
    const row = (await this.db.select().from(plugins).where(eq(plugins.pluginId, pluginId))).at(0);
    if (!row || !this.visible(row, workspaceId)) throw new NotFoundException(`no plugin ${pluginId} on the shelf`);
    const versions = (await this.versionsOf([pluginId])).get(pluginId) ?? [];
    const installed = await this.plugins.installOf(workspaceId, pluginId);
    const base = this.entry(row, versions, installed);
    const shown = this.latestInstallable(versions) ?? versions[0];
    const index = await this.interfaceIndex();
    let capabilities: Capabilities | null = null;
    let manifest: Manifest | null = null;
    if (shown) {
      manifest = JSON.parse(shown.manifest) as Manifest;
      try { capabilities = this.capabilitiesOf(packageFrom(manifest, JSON.parse(shown.files || '{}') as Record<string, string>), index); } catch { capabilities = null; }
    }
    // Who else is on the shelf for the interfaces this package touches (an interface page lists its providers).
    const t = manifest ? touched(manifest) : { defines: [], provides: [], requires: [] };
    const related = (await this.list(workspaceId)).items.filter((e) => e.id !== pluginId && [...e.defines, ...e.provides, ...e.requires].some((n) => [...t.defines, ...t.provides, ...t.requires].includes(n)))
      .map((e) => ({ id: e.id, name: e.name, tier: e.tier, roles: e.roles, defines: e.defines, provides: e.provides, conformance: e.conformance }));
    return {
      ...base,
      license: manifest?.license ?? '', homepage: manifest?.homepage ?? '',
      capabilities,
      installSource: this.installSource(row, shown?.version),
      versions: versions.map((v) => ({
        version: v.version, digest: v.archiveSha256, manifestHash: v.manifestHash, commitSha: v.commitSha, coreRange: v.coreRange,
        compatible: satisfies(CORE_API_VERSION, v.coreRange), conformance: JSON.parse(v.conformance || '[]') as ConformanceEntry[],
        publishedAt: v.createdAt, publishedBy: v.publishedBy, changelog: v.changelog,
        recalled: Boolean(v.revokedAt), recalledAt: v.revokedAt, recallReason: v.revokeReason ?? '',
        installed: Boolean(installed && installed.install.status !== 'removed' && installed.version.id === v.id),
      })),
      related,
    };
  }

  private installSource(row: PluginRow, version?: string): InstallSource | null {
    if (row.source === 'first_party') return { firstParty: row.pluginId };
    if (row.source === 'registry') return { registry: { id: row.pluginId, ...(version ? { version } : {}) } };
    return null; // a local package re-installs from its folder
  }

  // ---- publish ----

  /**
   * Publish a version (docs/registry.md §2's flow, for plugins): validate
   * through the loader's archive rules, lint the text, run the registry's
   * mock conformance and compute the capability summary. `dryRun` returns
   * exactly what installers will see and writes nothing; a blocker refuses.
   */
  async publish(workspaceId: string, input: { manifest?: unknown; files?: Record<string, string>; commitSha?: string; changelog?: string; dryRun?: boolean }) {
    const actor = await this.plugins.assertOwner(workspaceId, 'publishes plugins');
    await this.syncFirstParty();
    const files = { ...(input.files ?? {}) };
    let raw = input.manifest;
    if (raw === undefined && typeof files['plugin.json'] === 'string') {
      try { raw = JSON.parse(files['plugin.json']); } catch { throw new BadRequestException('plugin.json: not JSON'); }
    }
    delete files['plugin.json'];
    if (raw === undefined) throw new BadRequestException('a plugin.json (manifest) is required');
    let pkg: PluginPackage;
    try { pkg = packageFrom(raw, files); } catch (err) {
      if (err instanceof PluginLoadError) throw new BadRequestException({ message: 'the package was refused', errors: err.errors, warnings: err.warnings });
      throw err;
    }
    const m = pkg.manifest;
    const blockers: string[] = [];
    const warnings = [...pkg.warnings];
    const ns = m.id.split('@')[1];
    let tier: Tier = 'community';
    if (ns === 'yaam') blockers.push('the @yaam namespace is first-party only: it ships in plugins/first-party/');
    else if (ns === 'local') blockers.push('a name@local package loads in one workspace (upload it in Settings › Plugins); publish it as name@community');
    else if (ns !== 'community') { tier = 'verified'; blockers.push(`@${ns} is a verified publisher namespace; verified packages are signed with the publisher's key, which arrives with signing (plugins Phase 2). Publish as name@community`); }
    // Community floors (§7.1): declarations over HTTP and remote MCP only.
    if ((m.runtime ?? []).length) blockers.push('community packages carry no provider code (runtime)');
    for (const s of m.secrets ?? []) if (s.inject === 'env') blockers.push(`secret ${s.slot}: env slots are first-party only`);
    for (const p of m.provides ?? []) if (Object.values(p.operations).some((impl) => 'fixture' in impl)) blockers.push(`${p.interface}: fixture implementations are for first-party and local providers only`);
    const commitSha = (input.commitSha ?? '').trim().toLowerCase();
    if (commitSha && !SOURCE_PIN_RE.test(commitSha)) blockers.push('commitSha is the full hex digest of the source revision (40 or 64 characters), never a name that can move');
    for (const p of referencedFiles(m).text) for (const flag of lintText(pkg.files[p] ?? '')) warnings.push(`${p}: ${flag}`);
    // Identity and semver: a package belongs to one publisher, versions only go up and never change.
    const row = (await this.db.select().from(plugins).where(eq(plugins.pluginId, m.id))).at(0);
    if (row && row.source !== 'registry') blockers.push(`${m.id} is a ${row.source.replace('_', '-')} package here; it cannot be published over`);
    if (row && row.publisherId !== m.publisher.id) blockers.push(`${m.id} belongs to publisher ${row.publisherId}`);
    const versions = (await this.versionsOf([m.id])).get(m.id) ?? [];
    const same = versions.find((v) => v.version === m.version);
    if (same && same.archiveSha256 !== pkg.digest) blockers.push(`${m.id}@${m.version} is already published with a different digest; versions are immutable, bump the version`);
    const newest = versions[0];
    if (!same && newest && compareVersions(m.version, newest.version) < 0) blockers.push(`${m.version} is older than the newest published version ${newest.version}`);
    const compatible = satisfies(CORE_API_VERSION, m.requires.yaamCore);
    if (!compatible) warnings.push(`requires yaamCore ${m.requires.yaamCore}; this server implements ${CORE_API_VERSION} (listed, not installable here)`);
    const index = await this.interfaceIndex(pkg);
    const conformance = await this.conformanceOf(pkg, index);
    for (const c of conformance.filter((x) => x.result !== 'pass')) warnings.push(`conformance ${c.interface}@${c.range}: ${c.result}${c.failures.length ? ` (${c.failures.join('; ')})` : ''}`);
    const capabilities = this.capabilitiesOf(pkg, index);
    const changelog = (input.changelog ?? '').slice(0, CHANGELOG_MAX);
    const preview = {
      id: m.id, name: m.name, version: m.version, description: m.description ?? '', publisher: m.publisher, tier, roles: m.roles,
      digest: pkg.digest, manifestHash: pkg.manifestHash, commitSha, coreRange: m.requires.yaamCore, compatible,
      capabilities, conformance, warnings, blockers, alreadyPublished: Boolean(same && same.archiveSha256 === pkg.digest),
    };
    if (input.dryRun) return { dryRun: true as const, ...preview };
    if (blockers.length > 0) throw new BadRequestException({ message: 'publish refused', blockers });
    if (preview.alreadyPublished) return { dryRun: false as const, ...preview, published: false };
    const now = nowIso();
    const listing = { name: m.name, description: m.description ?? '', publisherId: m.publisher.id, publisherName: m.publisher.name, tier, roles: JSON.stringify(m.roles), source: 'registry', workspaceId: '', listed: 1, updatedAt: now };
    let pluginRowId = row?.id;
    if (!row) { pluginRowId = newId(); await this.db.insert(plugins).values({ accountId: currentAccountId(), id: pluginRowId, pluginId: m.id, registryItemId: null, createdAt: now, installs: 0, ...listing }); }
    else await this.db.update(plugins).set(listing).where(eq(plugins.id, row.id));
    await this.plugins.versionRow(pkg, tier, { commitSha, conformance: JSON.stringify(conformance), capabilities: JSON.stringify(capabilities), changelog, publishedBy: actor });
    await this.mirror(pluginRowId!, m, pkg.digest, versions.length + 1, capabilities, warnings);
    await this.audit.append(workspaceId, { actor, action: 'plugin_published', refType: 'plugin', refId: m.id, payload: { version: m.version, tier, digest: pkg.digest, commitSha, conformance: conformance.map((c) => `${c.interface}: ${c.result}`) } });
    return { dryRun: false as const, ...preview, published: true };
  }

  /** The `plugin` kind's row in registry_items: the listing projection the public feed carries. */
  private async mirror(pluginRowId: string, m: Manifest, digest: string, count: number, caps: Capabilities, warnings: string[]): Promise<void> {
    const slug = m.id.replace('@', '-').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const now = nowIso();
    const values = {
      name: m.name, description: m.description ?? '', version: count, publisherName: m.publisher.name,
      manifest: JSON.stringify({ pluginId: m.id, version: m.version, digest, roles: m.roles, coreRange: m.requires.yaamCore }),
      capabilities: JSON.stringify({ tools: caps.defines.flatMap((d) => d.operations.map((o) => o.tool)), connections: [], loops: [], skills: [], apps: [], plugin: { roles: m.roles, defines: caps.defines.map((d) => d.name), provides: caps.provides.map((p) => p.interface), noEgress: caps.noEgress } }),
      scanReport: JSON.stringify({ ok: true, flags: warnings.map((w) => ({ kind: 'plugin', severity: 'warn', detail: w })), urls: caps.egress.map((e) => e.host) }),
      updatedAt: now,
    };
    const existing = (await this.db.select({ id: registryItems.id }).from(registryItems).where(and(eq(registryItems.kind, 'plugin'), eq(registryItems.slug, slug)))).at(0);
    let itemId = existing?.id;
    if (existing) await this.db.update(registryItems).set(values).where(eq(registryItems.id, existing.id));
    else { itemId = newId(); await this.db.insert(registryItems).values({ id: itemId, accountId: currentAccountId(), kind: 'plugin', slug, published: 1, source: 'local', remoteUrl: '', sourceRef: m.id, installs: 0, ratingUp: 0, ratingDown: 0, publishedAt: now, ...values }); }
    await this.db.update(plugins).set({ registryItemId: itemId }).where(eq(plugins.id, pluginRowId));
  }

  // ---- recall (§6.8) ----

  /** Recall a version: it never installs again, every install of it freezes with the notice, and pending updates to it are withdrawn. */
  async recall(workspaceId: string, pluginId: string, version: string, reason: string) {
    const actor = await this.plugins.assertOwner(workspaceId, 'recalls plugin versions');
    await this.syncFirstParty();
    const why = String(reason ?? '').trim().slice(0, 300);
    if (!why) throw new BadRequestException('a recall says why');
    const v = (await this.db.select().from(pluginVersions).where(and(eq(pluginVersions.pluginId, pluginId), eq(pluginVersions.version, version)))).at(0);
    if (!v) throw new NotFoundException(`no version ${version} of ${pluginId}`);
    if (v.revokedAt) return { recalled: true, already: true, frozen: 0, withdrawn: 0 };
    const at = nowIso();
    await this.db.update(pluginVersions).set({ revokedAt: at, revokeReason: why, revokedBy: actor }).where(eq(pluginVersions.id, v.id));
    const notice = `version ${version} was recalled: ${why}`;
    let frozen = 0, withdrawn = 0;
    for (const i of await this.db.select().from(pluginInstalls).where(eq(pluginInstalls.versionId, v.id))) {
      if (await this.plugins.freeze(i.workspaceId, i.id, notice, actor)) frozen++;
    }
    for (const i of await this.db.select().from(pluginInstalls).where(eq(pluginInstalls.pendingVersionId, v.id))) {
      await this.plugins.dropPending(i.workspaceId, i.id, actor, notice);
      withdrawn++;
    }
    await this.audit.append(workspaceId, { actor, action: 'plugin_version_recalled', refType: 'plugin', refId: pluginId, payload: { version, reason: why, frozen, withdrawn } });
    return { recalled: true, already: false, frozen, withdrawn };
  }

  // ---- updates (§6.5) ----

  /**
   * Every version an install could move to, each with its permission diff
   * against the approved version. Normally the newer installable versions;
   * for an install frozen by a recall, any version that is not recalled
   * (moving back is the fix too).
   */
  async updates(workspaceId: string, pluginId: string) {
    await this.syncFirstParty();
    const li = await this.plugins.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    const row = (await this.db.select().from(plugins).where(eq(plugins.pluginId, pluginId))).at(0);
    const frozen = li.install.status === 'frozen';
    const versions = (await this.versionsOf([pluginId])).get(pluginId) ?? [];
    const candidates: Array<{ v: VersionRow; manifest: Manifest; source: InstallSource }> = [];
    if (row?.source === 'first_party') {
      const pkg = (await this.plugins.catalog()).get(pluginId);
      const v = pkg ? versions.find((x) => x.archiveSha256 === pkg.digest) : undefined;
      if (pkg && v && !v.revokedAt && v.id !== li.version.id) candidates.push({ v, manifest: pkg.manifest, source: { firstParty: pluginId } });
    } else if (row?.source === 'registry') {
      for (const v of versions) {
        if (v.revokedAt || v.id === li.version.id || v.source === 'local') continue;
        if (!frozen && compareVersions(v.version, li.manifest.version) <= 0) continue;
        candidates.push({ v, manifest: JSON.parse(v.manifest) as Manifest, source: { registry: { id: pluginId, version: v.version } } });
      }
    }
    return {
      pluginId, installed: { version: li.manifest.version, status: li.install.status, recalled: Boolean(li.version.revokedAt), notice: frozen ? li.install.suspendedReason : '' },
      pending: li.install.pendingVersionId ? JSON.parse(li.install.pendingNote || '{}') as Record<string, unknown> : null,
      updates: candidates.map(({ v, manifest, source }) => {
        const diff: DiffEntry[] = permissionDiff(li.manifest, manifest);
        return {
          version: v.version, digest: v.archiveSha256, commitSha: v.commitSha, coreRange: v.coreRange, compatible: satisfies(CORE_API_VERSION, v.coreRange),
          changelog: v.changelog, conformance: JSON.parse(v.conformance || '[]') as ConformanceEntry[], publishedAt: v.createdAt,
          newer: compareVersions(v.version, li.manifest.version) > 0, diff, widening: isWidening(diff), source,
        };
      }),
    };
  }
}
