/**
 * PluginsService — the interface mechanism's state (docs/plugins.md §4.2,
 * §4.4, §4.10, §4.11, §6): installs with their review and consent, the
 * interface registry, providers and their conformance, bindings and the
 * resolver, per-agent grants, owner policies on operations, the registrar
 * of reversible effects, dependency-driven suspension, updates with the
 * permission diff, disable, enable and uninstall.
 *
 * Domain-free: it reads interface declarations and never names one.
 * Nothing a plugin ships executes here; the only provider path is
 * runtime.ts's `callProvider`, reached through the dispatcher and the
 * conformance runner.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { resolve as resolvePath, sep as pathSep } from 'node:path';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  agents, chatSessions, conformanceRuns, interfaceBindings, interfacePolicies, interfaceProviders, interfaces, interfaceVersions,
  orgMembers, orgTasks, orgUnits, pluginContributions, pluginEffects, pluginGrants, pluginInstalls, plugins, pluginVersions, workspaces,
} from '../database/schema';
import { SkillsService } from '../skills/skills.service';
import { parseSkillMd } from '../portability/skill-md';
import { contributedSkillName, contributionSpecs, uiInterfaces } from './contributions';
import { skillRefs, uiConformance } from './manifest';
import { newId, nowIso } from '../common/ids.util';
import { actorId, currentAccountId } from '../accounts/account-context';
import { canonicalJson, isActionClass, registerOperationClasses, sha256, type ActionClass } from '../actions/action-classes';
import { ActionsService } from '../actions/actions.service';
import { CORE_API_VERSION, type InterfaceDef, type Manifest, type ProvidesDef, type Tier, type Fixtures, type Suite } from './manifest';
import { devDir, firstPartyDir, loadFirstParty, loadPluginFolder, packageFrom, PluginLoadError, referencedFiles, type PluginPackage } from './loader';
import { applyRules, classByInputOf, isWidening, kindRequirement, maxClass, permissionDiff, rank, staticClassOf, type DiffEntry, type PolicyRule } from './policy';
import { compareVersions, majorOf, parseInterfaceRef, parseVersion, satisfies } from './semver';
import { globMatch, globSpecificity } from './template';
import { runSuite, type CaseResult } from './conformance';
import { validate } from './json-schema';
import { PluginAuditService } from './plugin-audit';
import type { ProviderPackage } from './runtime';

export type InstallRow = typeof pluginInstalls.$inferSelect;
export type ProviderRow = typeof interfaceProviders.$inferSelect;
export type BindingRow = typeof interfaceBindings.$inferSelect;
export type EffectRow = typeof pluginEffects.$inferSelect;
type VersionRow = typeof pluginVersions.$inferSelect;

/**
 * Where a package comes from (docs/plugins.md §6.1, §7):
 * - `firstParty`: a folder under `plugins/first-party/`;
 * - `registry`: a version published to this instance's plugin registry,
 *   pinned by its digest (the latest installable one when `version` is
 *   omitted);
 * - `manifest` + `files`, or `files` carrying `plugin.json`: an uploaded
 *   `@local` folder, through the loader's archive rules;
 * - `path`: developer mode, a folder under `YAAM_PLUGINS_DEV_DIR`, walked
 *   with the same rules (symlinks and executable bits refused).
 */
export interface InstallSource { firstParty?: string; registry?: { id: string; version?: string }; manifest?: unknown; files?: Record<string, string>; path?: string }

export interface RegistryIface {
  name: string; version: string; major: number; def: InterfaceDef;
  interfaceVersionId: string; definitionHash: string; installId: string; pluginId: string; pluginVersion: string;
  suite?: Suite;
}
export interface RegistryProvider {
  row: ProviderRow; install: InstallRow; provides: ProvidesDef; pkg: ProviderPackage;
  pluginId: string; pluginVersion: string; digest: string; manifest: Manifest; healthy: boolean;
}
export interface LoadedInstall { install: InstallRow; version: VersionRow; manifest: Manifest; files: Record<string, string> }
export interface WorkspaceRegistry {
  workspaceId: string;
  interfaces: Map<string, RegistryIface>;
  providers: RegistryProvider[];
  bindings: BindingRow[];
  rules: PolicyRule[];
  installs: LoadedInstall[];
}

export type Resolution =
  | { ok: true; provider: RegistryProvider; scope: string; why: string }
  | { ok: false; reason: string; candidates: Array<{ providerId: string; pluginId: string }> };

/** Tables the registrar may remove and restore rows of (its inverses). */
const EFFECT_TABLES = { interface_providers: interfaceProviders, interface_bindings: interfaceBindings, plugin_grants: pluginGrants, plugin_contributions: pluginContributions } as const;
type EffectTable = keyof typeof EFFECT_TABLES;
/** `skill`: a contributed skill is archived on unwind (never deleted) and re-enabled on restore. */
interface Inverse { op: 'delete' | 'noop' | 'skill'; table?: EffectTable; id?: string; snapshot?: Record<string, unknown>; note?: string }
/** Effect kinds that are contributions beyond tools (§3.8), re-registered when the version moves. */
const EXTRA_EFFECT_KINDS = new Set(['skill', 'guidance', 'card', 'panel', 'page', 'action', 'badge']);
export type ContributionRow = typeof pluginContributions.$inferSelect;

/** Statuses an install keeps whatever its dependencies say. */
const STICKY = new Set(['disabled', 'frozen', 'removed']);
/** Statuses whose contributions are parked: nothing of theirs is offered or applies. */
const PARKED = new Set(['disabled', 'frozen']);
/** The interface name a model-facing tool belongs to: `<iface>_<op>`. */
export function toolName(iface: string, op: string): string { return `${iface}_${op}`; }

@Injectable()
export class PluginsService {
  private firstParty: Map<string, PluginPackage> | null = null;
  /** Model-facing operation name → the strictest static class seen in any workspace (classOf's lookup). */
  private readonly staticClasses = new Map<string, ActionClass>();
  /** Every model-facing operation name of an installed interface, for `owns`. */
  readonly knownTools = new Set<string>();
  private readonly listeners: Array<(workspaceId: string) => void> = [];
  readonly dispose: () => void;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    readonly audit: PluginAuditService,
    @Optional() private readonly actions?: ActionsService,
    @Optional() readonly skills?: SkillsService,
  ) {
    this.dispose = registerOperationClasses((name, input) => {
      const base = this.staticClasses.get(name);
      if (!base) return null;
      const by = this.byInput.get(name);
      return by ? maxClass(base, by(input)) : base;
    });
  }

  private readonly byInput = new Map<string, (input: Record<string, unknown>) => ActionClass | null>();

  /** Told when a workspace's registry may have changed (installs, bindings, grants). */
  onChange(fn: (workspaceId: string) => void): void { this.listeners.push(fn); }
  private changed(workspaceId: string): void { for (const fn of this.listeners) { try { fn(workspaceId); } catch { /* isolated */ } } }

  // ---- packages ----

  async catalog(): Promise<Map<string, PluginPackage>> {
    if (!this.firstParty) this.firstParty = await loadFirstParty(firstPartyDir());
    return this.firstParty;
  }

  /** Test seam and developer reload: forget the cached first-party catalog. */
  resetCatalog(): void { this.firstParty = null; }

  async load(source: InstallSource): Promise<{ pkg: PluginPackage; tier: Tier; source: string; versionId?: string }> {
    let out: { pkg: PluginPackage; tier: Tier; source: string; versionId?: string } | null = null;
    try {
      if (source.firstParty) {
        const id = source.firstParty.includes('@') ? source.firstParty : `${source.firstParty}@yaam`;
        const pkg = (await this.catalog()).get(id);
        if (!pkg) throw new NotFoundException(`no first-party plugin ${id}`);
        out = { pkg, tier: 'first_party', source: 'first_party' };
      } else if (source.registry) {
        out = await this.loadFromRegistry(source.registry.id, source.registry.version);
      } else if (source.path) {
        const root = devDir();
        if (!root) throw new BadRequestException('developer mode is off: set YAAM_PLUGINS_DEV_DIR to load plugin folders from disk');
        const abs = resolvePath(root, source.path);
        if (abs !== root && !abs.startsWith(root + pathSep)) throw new BadRequestException('the folder must be inside YAAM_PLUGINS_DEV_DIR');
        const pkg = await loadPluginFolder(abs);
        if (!pkg.manifest.id.endsWith('@local')) throw new BadRequestException('a folder loads as name@local only (developer mode)');
        out = { pkg, tier: 'local', source: 'local' };
      } else if (source.manifest !== undefined || (source.files && typeof source.files['plugin.json'] === 'string')) {
        let manifest = source.manifest;
        const files = { ...(source.files ?? {}) };
        if (manifest === undefined) {
          try { manifest = JSON.parse(files['plugin.json']); } catch { throw new PluginLoadError(['plugin.json: not JSON']); }
        }
        delete files['plugin.json'];
        const pkg = packageFrom(manifest, files);
        if (!pkg.manifest.id.endsWith('@local')) throw new BadRequestException('an uploaded package loads as name@local only; publish to the registry for anything wider');
        out = { pkg, tier: 'local', source: 'local' };
      }
    } catch (err) {
      if (err instanceof PluginLoadError) throw new BadRequestException({ message: 'the package was refused', errors: err.errors, warnings: err.warnings });
      throw err;
    }
    if (!out) throw new BadRequestException('source must name a first-party plugin, a registry version, an uploaded @local folder or a developer folder');
    // A recalled version never installs, whichever way its bytes arrive.
    const recalled = (await this.db.select({ v: pluginVersions.version, why: pluginVersions.revokeReason, at: pluginVersions.revokedAt })
      .from(pluginVersions).where(and(eq(pluginVersions.pluginId, out.pkg.manifest.id), eq(pluginVersions.archiveSha256, out.pkg.digest)))).find((r) => r.at);
    if (recalled) throw new BadRequestException(`${out.pkg.manifest.id}@${recalled.v} was recalled${recalled.why ? `: ${recalled.why}` : ''}; it cannot be installed`);
    return out;
  }

  /** A registry version, rebuilt from its stored files and checked against its pinned digest. */
  private async loadFromRegistry(id: string, version?: string): Promise<{ pkg: PluginPackage; tier: Tier; source: string; versionId: string }> {
    const plugin = (await this.db.select().from(plugins).where(eq(plugins.pluginId, id))).at(0);
    if (!plugin || plugin.source === 'local') throw new NotFoundException(`no plugin ${id} in the registry`);
    if (plugin.source === 'first_party') {
      const pkg = (await this.catalog()).get(id);
      if (!pkg) throw new NotFoundException(`no first-party plugin ${id}`);
      if (version && pkg.manifest.version !== version) throw new NotFoundException(`${id}@${version} is not the shipped first-party version (${pkg.manifest.version})`);
      return { pkg, tier: 'first_party', source: 'first_party', versionId: '' };
    }
    const rows = (await this.db.select().from(pluginVersions).where(eq(pluginVersions.pluginId, id))).filter((v) => v.source !== 'local');
    let row: VersionRow | undefined;
    if (version) {
      row = rows.find((v) => v.version === version);
      if (!row) throw new NotFoundException(`no version ${version} of ${id}`);
      if (row.revokedAt) throw new BadRequestException(`${id}@${version} was recalled${row.revokeReason ? `: ${row.revokeReason}` : ''}; it cannot be installed`);
    } else {
      row = rows.filter((v) => !v.revokedAt && satisfies(CORE_API_VERSION, v.coreRange)).sort((a, b) => compareVersions(b.version, a.version))[0];
      if (!row) throw new NotFoundException(`${id} has no installable version`);
    }
    const pkg = packageFrom(JSON.parse(row.manifest), JSON.parse(row.files || '{}') as Record<string, string>);
    if (pkg.digest !== row.archiveSha256) throw new BadRequestException(`${id}@${row.version}: the package does not match its pinned digest; refused`);
    return { pkg, tier: plugin.tier as Tier, source: 'registry', versionId: row.id };
  }

  private async isOwner(workspaceId: string, actor = actorId()): Promise<boolean> {
    if (this.actions) return this.actions.trust.isOwnerOrCeo(workspaceId, actor);
    return actor === currentAccountId();
  }
  /** Whether the caller is the workspace owner (or the CEO), without throwing. */
  callerIsOwner(workspaceId: string): Promise<boolean> { return this.isOwner(workspaceId); }
  /** Owner-only gate shared with the plugin registry. */
  assertOwner(workspaceId: string, what: string): Promise<string> { return this.requireOwner(workspaceId, what); }
  private async requireOwner(workspaceId: string, what: string): Promise<string> {
    const actor = actorId();
    if (!(await this.isOwner(workspaceId, actor))) throw new ForbiddenException(`only the workspace owner ${what}`);
    return actor;
  }

  /**
   * The workspace's plugin settings: the community-interface opt-in (§5.1),
   * and the trust policy for agents' install proposals (docs/foundry.md
   * §4.7): `propose` (default — every install, upgrade or removal an agent
   * proposes is a card for the owner) or `first_party` (in an autonomous
   * company, an install or upgrade of a first-party kit or plugin the chief
   * proposes applies at once, audited; removals are always cards).
   */
  async workspaceSettings(workspaceId: string): Promise<{ allowCommunityInterfaces: boolean; agentInstalls: 'propose' | 'first_party' }> {
    const row = (await this.db.select({ s: workspaces.pluginSettings }).from(workspaces).where(eq(workspaces.id, workspaceId))).at(0);
    if (!row) throw new NotFoundException(`workspace ${workspaceId}`);
    let s: Record<string, unknown>;
    try { s = JSON.parse(row.s || '{}') as Record<string, unknown>; } catch { s = {}; }
    return { allowCommunityInterfaces: s.allowCommunityInterfaces === true, agentInstalls: s.agentInstalls === 'first_party' ? 'first_party' : 'propose' };
  }

  async setWorkspaceSettings(workspaceId: string, patch: { allowCommunityInterfaces?: boolean; agentInstalls?: string }): Promise<{ allowCommunityInterfaces: boolean; agentInstalls: 'propose' | 'first_party' }> {
    const actor = await this.requireOwner(workspaceId, 'changes plugin settings');
    const cur = await this.workspaceSettings(workspaceId);
    if (patch.agentInstalls !== undefined && patch.agentInstalls !== 'propose' && patch.agentInstalls !== 'first_party') throw new BadRequestException('agentInstalls is propose or first_party');
    const next = { ...cur, ...(typeof patch.allowCommunityInterfaces === 'boolean' ? { allowCommunityInterfaces: patch.allowCommunityInterfaces } : {}), ...(patch.agentInstalls ? { agentInstalls: patch.agentInstalls as 'propose' | 'first_party' } : {}) };
    await this.db.update(workspaces).set({ pluginSettings: JSON.stringify(next) }).where(eq(workspaces.id, workspaceId));
    await this.audit.append(workspaceId, { actor, action: 'plugin_settings_set', refType: 'workspace', refId: workspaceId, payload: next });
    return next;
  }

  // ---- review (the permission diff against nothing, or against the approved version) ----

  async review(workspaceId: string, source: InstallSource): Promise<Record<string, unknown>> {
    const { pkg, tier } = await this.load(source);
    const cur = await this.installOf(workspaceId, pkg.manifest.id);
    const prev = cur && cur.install.status !== 'removed' ? cur.manifest : null;
    return this.reviewOf(workspaceId, pkg, tier, prev);
  }

  private async reviewOf(workspaceId: string, pkg: PluginPackage, tier: Tier, prev: Manifest | null): Promise<Record<string, unknown> & { blockers: string[]; diff: DiffEntry[] }> {
    const m = pkg.manifest;
    const blockers: string[] = [];
    if (!satisfies(CORE_API_VERSION, m.requires.yaamCore)) blockers.push(`requires yaamCore ${m.requires.yaamCore}; this server implements ${CORE_API_VERSION}`);
    const settings = await this.workspaceSettings(workspaceId);
    const namespace = m.id.split('@')[1];
    const ifaces = [];
    for (const iface of m.interfaces ?? []) {
      if ((tier === 'community' || tier === 'local') && !settings.allowCommunityInterfaces) {
        blockers.push(`${iface.name}: a ${tier} interface needs the workspace's community-interface opt-in (plugins.allowCommunityInterfaces)`);
      }
      const claim = (await this.db.select().from(interfaces).where(eq(interfaces.name, iface.name))).at(0);
      if (claim && claim.ownerPluginId !== m.id) blockers.push(`${iface.name}: the interface name is claimed by ${claim.ownerPluginId}`);
      const same = (await this.db.select().from(interfaceVersions).where(and(eq(interfaceVersions.name, iface.name), eq(interfaceVersions.version, iface.version)))).filter((r) => r.definitionHash !== sha256(canonicalJson(iface)));
      if (same.length > 0) blockers.push(`${iface.name}@${iface.version}: that version was registered with a different definition; bump the version`);
      const kinds = iface.changeKinds ?? {};
      ifaces.push({
        name: iface.name, version: iface.version, semantics: iface.semantics, resources: iface.resources.pattern,
        operations: Object.entries(iface.operations).map(([op, def]) => {
          const st = staticClassOf(op, def, iface);
          return {
            op, canonical: `${iface.name}.${op}`, tool: toolName(iface.name, op), semantics: def.semantics, required: def.required,
            declaredClass: def.class ?? null, effectiveClass: st.cls, floorReasons: st.floor.reasons, raisedByFloor: rank(st.cls) > rank(isActionClass(def.class) ? def.class : 'read') && st.floor.reasons.length > 0,
            twoKeyByFloor: st.floor.twoKey, reversibility: def.reversibility, outbound: def.outbound, movesMoney: def.movesMoney ?? false,
            change: def.change ?? null, untrustedOutput: def.untrustedOutput, classByInput: def.classByInput ?? [], cost: def.cost ?? null,
          };
        }),
        changeKinds: Object.entries(kinds).map(([k, kind]) => ({
          kind: `${iface.name}.${k}`, semantics: kind.semantics, reversibility: kind.reversibility,
          declaredRequirement: kind.requirement ?? 'trust', effectiveRequirement: kindRequirement(kind),
          raisedByFloor: kindRequirement(kind) !== (kind.requirement ?? 'trust'),
          roles: Object.entries(iface.operations).filter(([, d]) => d.change?.kind === k).map(([op, d]) => ({ op: `${iface.name}.${op}`, role: d.change!.role })),
          verify: kind.verify ?? [],
        })),
        events: Object.keys(iface.events ?? {}).map((e) => `${iface.name}.${e}`),
        metrics: Object.keys(iface.metrics ?? {}).map((e) => `${iface.name}.${e}`),
        suiteCases: pkg.suites[iface.conformance]?.cases.map((c) => c.id) ?? [],
      });
    }
    if (namespace === 'yaam' && tier !== 'first_party') blockers.push('the @yaam namespace is first-party only');
    const reg = await this.registry(workspaceId);
    const provides = (m.provides ?? []).map((p) => {
      const ref = parseInterfaceRef(p.interface)!;
      const iface = reg.interfaces.get(ref.name) ?? (m.interfaces ?? []).map((d) => this.asRegistryIface(d)).find((x) => x.name === ref.name);
      const def = iface?.def;
      const usesFixture = Object.values(p.operations).some((impl) => 'fixture' in impl);
      if (usesFixture && tier !== 'first_party' && tier !== 'local') blockers.push(`${p.interface}: fixture implementations are for first-party and local providers only`);
      return {
        interface: p.interface, resources: p.resources, conformanceMode: p.conformance.mode,
        installed: Boolean(iface && satisfies(iface.version, ref.range)),
        operations: Object.keys(p.operations),
        missingRequired: def ? Object.entries(def.operations).filter(([op, d]) => d.required && !p.operations[op]).map(([op]) => op) : [],
        classRaises: Object.entries(p.class ?? {}).map(([op, c]) => ({ op: `${ref.name}.${op}`, class: c, effectiveClass: def?.operations[op] ? maxClass(staticClassOf(op, def.operations[op], def, p).cls) : c })),
        implementations: Object.fromEntries(Object.entries(p.operations).map(([op, impl]) => [op, Object.keys(impl).find((k) => !k.endsWith('Map'))])),
      };
    });
    const requested = (m.policies ?? []).map((pol) => {
      let status = 'applies';
      const [ifn, rest] = (pol.match.operation ?? pol.match.changeKind ?? '').split('.');
      const def = reg.interfaces.get(ifn)?.def ?? (m.interfaces ?? []).find((d) => d.name === ifn);
      if (def && pol.match.operation && def.operations[rest] && pol.require.startsWith('class:')) {
        if (rank(staticClassOf(rest, def.operations[rest], def).cls) >= rank(pol.require.slice(6) as ActionClass)) status = 'already stricter';
      }
      if (def && pol.match.changeKind && def.changeKinds?.[rest] && pol.require === 'two_key' && !pol.match.bind && kindRequirement(def.changeKinds[rest]) === 'two_key') status = 'already stricter';
      return { ...pol, status };
    });
    const diff = permissionDiff(prev, m);
    return {
      id: m.id, name: m.name, version: m.version, description: m.description ?? '', publisher: m.publisher, tier, roles: m.roles,
      // Community packages install only with the owner's explicit opt-in at confirm (§7.1); interfaces need the workspace opt-in as well (§5.1).
      communityOptIn: tier === 'community',
      requires: m.requires, digest: pkg.digest, manifestHash: pkg.manifestHash, warnings: pkg.warnings, coreApi: CORE_API_VERSION,
      noEgress: (m.egress ?? []).length === 0,
      interfaces: ifaces, provides,
      egress: m.egress ?? [], secrets: (m.secrets ?? []).map((s) => ({ ...s, redLine: s.inject === 'env' })), dataSharing: m.dataSharing ?? [],
      identity: m.identity ?? [], connections: m.connections ?? [], budgets: m.budgets ?? {}, runtime: m.runtime ?? [],
      extras: (m.tools?.items ?? []).map((t) => ({ name: `${m.toolPrefix ?? ''}_${t.name}`, declaredClass: t.class ?? null, effectiveClass: maxClass(t.class ?? 'external_reversible', 'impl' in t && 'http' in t.impl && t.impl.http.method !== 'GET' ? 'external_reversible' : null), grant: t.grant })),
      consumer: { requires: m.requires.interfaces ?? [], skills: m.skills ?? [], rolePacks: m.rolePacks ?? [], playbooks: m.playbooks ?? [], verifies: m.verifies ?? [] },
      requestedPolicies: requested,
      settingsSchema: m.settings ?? null,
      deferred: [
        ...((m.connections ?? []).length ? ['connections (Phase 3)'] : []), ...((m.events ?? []).length ? ['webhook events (Phase 3)'] : []),
        ...((m.runtime ?? []).length ? ['provider code (Phase 3)'] : []), ...((m.setup ?? []).length ? ['setup operations (Phase 3)'] : []),
        ...((m.panels ?? []).length ? ['panels (later)'] : []), ...((m.mirrors ?? []).length ? ['mirrors (later)'] : []),
        ...((m.rolePacks ?? []).length ? ['role packs (later)'] : []),
      ],
      contributions: this.contributionsReview(pkg, tier),
      diff, widening: isWidening(diff), blockers: [...blockers, ...uiConformance(m, (n) => reg.interfaces.get(n)?.def ?? (m.interfaces ?? []).find((d) => d.name === n))],
    };
  }

  private asRegistryIface(def: InterfaceDef): RegistryIface {
    return { name: def.name, version: def.version, major: parseVersion(def.version)?.major ?? 0, def, interfaceVersionId: '', definitionHash: sha256(canonicalJson(def)), installId: '', pluginId: '', pluginVersion: '' };
  }

  // ---- install ----

  async install(workspaceId: string, source: InstallSource, opts: { confirm?: boolean; acceptCommunity?: boolean } = {}): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'installs plugins');
    const { pkg, tier, source: origin } = await this.load(source);
    const existing = await this.installOf(workspaceId, pkg.manifest.id);
    if (existing && existing.install.status !== 'removed') throw new ConflictException(`${pkg.manifest.id} is installed; update it instead`);
    const review = await this.reviewOf(workspaceId, pkg, tier, null);
    if (!opts.confirm) return { review, installed: false };
    if (review.blockers.length > 0) throw new BadRequestException({ message: 'the install is blocked', blockers: review.blockers });
    if (tier === 'community' && opts.acceptCommunity !== true) {
      throw new BadRequestException({ message: 'a community plugin installs only with your explicit opt-in', blockers: [`${pkg.manifest.id} is community tier: reviewed by the registry, not signed by a verified publisher; confirm with acceptCommunity`] });
    }
    const m = pkg.manifest;
    const now = nowIso();
    const plugin = (await this.db.select().from(plugins).where(eq(plugins.pluginId, m.id))).at(0);
    if (!plugin) {
      await this.db.insert(plugins).values({
        accountId: currentAccountId(), id: newId(), pluginId: m.id, name: m.name, publisherId: m.publisher.id, tier, roles: JSON.stringify(m.roles), registryItemId: null, createdAt: now,
        description: m.description ?? '', publisherName: m.publisher.name, source: origin === 'local' ? 'local' : origin === 'registry' ? 'registry' : 'first_party',
        workspaceId: origin === 'local' ? workspaceId : '', updatedAt: now,
      });
    }
    await this.db.update(plugins).set({ installs: sql`${plugins.installs} + 1` }).where(eq(plugins.pluginId, m.id));
    const version = await this.versionRow(pkg, tier);
    let install: InstallRow;
    if (existing) {
      await this.db.update(pluginInstalls).set({ versionId: version.id, pendingVersionId: null, pendingNote: '{}', status: 'installed', suspendedReason: '', approvedDiff: JSON.stringify(review), settings: '{}', installedBy: actor, updatedAt: now, activatedAt: null }).where(eq(pluginInstalls.id, existing.install.id));
      install = (await this.db.select().from(pluginInstalls).where(eq(pluginInstalls.id, existing.install.id)))[0];
    } else {
      install = {
        accountId: currentAccountId(), id: newId(), workspaceId, pluginId: m.id, versionId: version.id, pendingVersionId: null, pendingNote: '{}',
        status: 'installed', suspendedReason: '', approvedDiff: JSON.stringify(review), settings: '{}', kitInstallId: null,
        installedBy: actor, createdAt: now, activatedAt: null, updatedAt: now,
      };
      await this.db.insert(pluginInstalls).values(install);
    }
    await this.audit.append(workspaceId, { actor, action: 'plugin_installed', refType: 'plugin', refId: m.id, payload: { version: m.version, tier, digest: pkg.digest, roles: m.roles, consent: { widening: review.diff.filter((d) => d.widening).map((d) => d.detail), classifications: (review.interfaces as Array<{ name: string; operations: Array<{ canonical: string; effectiveClass: string }> }>).flatMap((i) => i.operations.map((o) => `${o.canonical}=${o.effectiveClass}`)) } } });
    await this.registerContributions(workspaceId, install, m, version, pkg);
    await this.conformAll(workspaceId, install.id);
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return { review, installed: true, install: await this.summary(workspaceId, m.id) };
  }

  /** The immutable version row for a package, found by its digest or written once. */
  async versionRow(pkg: PluginPackage, tier: Tier, extra: Partial<Pick<VersionRow, 'commitSha' | 'conformance' | 'capabilities' | 'changelog' | 'publishedBy'>> = {}): Promise<VersionRow> {
    const m = pkg.manifest;
    const found = (await this.db.select().from(pluginVersions).where(and(eq(pluginVersions.pluginId, m.id), eq(pluginVersions.archiveSha256, pkg.digest)))).at(0);
    if (found) return found;
    const definitions: Record<string, string> = {};
    for (const i of m.interfaces ?? []) for (const [op, d] of Object.entries(i.operations)) definitions[`${i.name}.${op}`] = sha256(canonicalJson(d));
    for (const t of m.tools?.items ?? []) definitions[`extra.${t.name}`] = sha256(canonicalJson(t));
    const row: VersionRow = {
      accountId: currentAccountId(), id: newId(), pluginId: m.id, version: m.version, manifest: JSON.stringify(m), manifestHash: pkg.manifestHash,
      archiveSha256: pkg.digest, files: JSON.stringify(pkg.files), definitions: JSON.stringify(definitions), coreRange: m.requires.yaamCore,
      scanReport: JSON.stringify(pkg.warnings), source: tier, createdAt: nowIso(), revokedAt: null, revokeReason: null,
      commitSha: '', conformance: '[]', capabilities: '{}', changelog: '', publishedBy: '', revokedBy: '', ...extra,
    };
    await this.db.insert(pluginVersions).values(row);
    return row;
  }

  /** Register what a version contributes, each as an effect with its inverse. */
  private async registerContributions(workspaceId: string, install: InstallRow, m: Manifest, version: VersionRow, pkg: PluginPackage): Promise<void> {
    for (const iface of m.interfaces ?? []) {
      const hash = sha256(canonicalJson(iface));
      const claim = (await this.db.select().from(interfaces).where(eq(interfaces.name, iface.name))).at(0);
      if (!claim) {
        await this.db.insert(interfaces).values({ accountId: currentAccountId(), id: newId(), name: iface.name, ownerNamespace: m.id.split('@')[1], ownerPluginId: m.id, latestVersion: iface.version, createdAt: nowIso() });
      } else if (parseVersion(iface.version) && satisfies(iface.version, `>=${claim.latestVersion}`)) {
        await this.db.update(interfaces).set({ latestVersion: iface.version }).where(eq(interfaces.id, claim.id));
      }
      const have = (await this.db.select().from(interfaceVersions).where(and(eq(interfaceVersions.name, iface.name), eq(interfaceVersions.version, iface.version), eq(interfaceVersions.definitionHash, hash)))).at(0);
      if (!have) {
        await this.db.insert(interfaceVersions).values({
          accountId: currentAccountId(), id: newId(), name: iface.name, version: iface.version, major: parseVersion(iface.version)!.major,
          definition: JSON.stringify(iface), definitionHash: hash, pluginVersionId: version.id, suite: JSON.stringify(pkg.suites[iface.conformance] ?? {}),
          deprecatedAt: null, sunsetAt: null, createdAt: nowIso(),
        });
      }
      await this.effect(workspaceId, install.id, 'interface', `${iface.name}@${iface.version}`, { op: 'noop', note: 'the interface leaves this workspace\'s registry; its immutable version row stays as history' });
      await this.effect(workspaceId, install.id, 'tools', Object.keys(iface.operations).map((op) => toolName(iface.name, op)).join(','), { op: 'noop', note: 'unoffered from the next turn' });
    }
    for (const p of m.provides ?? []) {
      const ref = parseInterfaceRef(p.interface)!;
      const row: ProviderRow = {
        accountId: currentAccountId(), id: newId(), workspaceId, installId: install.id, interface: ref.name, range: ref.range, resolvedVersion: '',
        resources: JSON.stringify(p.resources), conformanceRunId: null, status: 'unverified', createdAt: nowIso(),
      };
      await this.db.insert(interfaceProviders).values(row);
      await this.effect(workspaceId, install.id, 'provider', `${ref.name}@${ref.range}`, { op: 'delete', table: 'interface_providers', id: row.id, snapshot: row });
    }
    await this.registerExtras(workspaceId, install.id, m, pkg, version.source as Tier);
  }

  // ---- contributions beyond tools (§3.8): skills, guidance, declarative UI ----

  /** What the review shows of a package's skills, guidance and UI: the real text and every extension point. */
  private contributionsReview(pkg: PluginPackage, tier: Tier): Record<string, unknown> {
    const m = pkg.manifest;
    const skills = skillRefs(m).map((s) => {
      try {
        const p = parseSkillMd(pkg.files[s.path] ?? '');
        return { name: contributedSkillName(m.id, p.name), description: p.description, audience: s.audience, path: s.path, text: p.body, draft: tier !== 'first_party' };
      } catch { return { name: s.path, description: '', audience: s.audience, path: s.path, text: '', draft: true }; }
    });
    const ui = m.ui ?? {};
    return {
      skills,
      guidance: (m.guidance ?? []).map((g) => ({ ...g })),
      ui: {
        cards: (ui.cards ?? []).map((c) => ({ id: c.id, title: c.title, placement: c.placement, operation: c.query?.operation ?? null })),
        panels: (ui.panels ?? []).map((c) => ({ id: c.id, title: c.title, placement: c.placement, operation: c.query?.operation ?? null })),
        pages: (ui.pages ?? []).map((c) => ({ id: c.id, title: c.title, placement: c.placement })),
        actions: (ui.actions ?? []).map((a) => ({ id: a.id, title: a.title, operation: a.operation })),
        badges: (ui.badges ?? []).map((b) => ({ id: b.id, placement: b.placement, operation: b.query.operation })),
      },
    };
  }

  /**
   * Register skills, guidance and UI as effects of an install. A skill
   * becomes a workspace skill with its audience (live for first-party,
   * a draft behind the Skills approval otherwise); guidance and UI become
   * `plugin_contributions` rows. Each is an effect with its inverse, so
   * disable, enable and uninstall carry them with the plugin.
   */
  private async registerExtras(workspaceId: string, installId: string, m: Manifest, pkg: PluginPackage, tier: Tier): Promise<void> {
    if (this.skills) {
      for (const ref of skillRefs(m)) {
        const body = pkg.files[ref.path];
        if (body === undefined) continue;
        const parsed = parseSkillMd(body);
        const row = await this.skills.contribute({
          workspaceId, name: contributedSkillName(m.id, parsed.name), description: parsed.description, instructions: parsed.body,
          audience: ref.audience, source: `plugin:${m.id}`, draft: tier !== 'first_party',
        });
        await this.effect(workspaceId, installId, 'skill', row.name, { op: 'skill', id: row.id, note: 'archived, never deleted' });
      }
    }
    for (const c of contributionSpecs(m)) {
      const row: ContributionRow = {
        accountId: currentAccountId(), id: newId(), workspaceId, ownerKind: 'plugin', ownerId: m.id, installId, version: m.version,
        kind: c.kind, key: c.key, spec: JSON.stringify(c.spec), createdAt: nowIso(),
      };
      await this.db.insert(pluginContributions).values(row);
      await this.effect(workspaceId, installId, c.kind, c.key, { op: 'delete', table: 'plugin_contributions', id: row.id, snapshot: row });
    }
  }

  /** A version move: the old version's contributions unwind for good, the new version's register. */
  private async refreshExtras(workspaceId: string, installId: string, m: Manifest, pkg: PluginPackage, tier: Tier, actor: string): Promise<void> {
    for (const e of (await this.effects(installId)).filter((x) => EXTRA_EFFECT_KINDS.has(x.kind) && x.state === 'live').reverse()) {
      await this.unwindOne(workspaceId, installId, e, actor, false);
    }
    await this.registerExtras(workspaceId, installId, m, pkg, tier);
  }

  /** Live contribution rows of the workspace's live installs (parked installs have none: their rows were unwound). */
  async contributionRows(workspaceId: string, kinds?: string[]): Promise<ContributionRow[]> {
    const rows = await this.db.select().from(pluginContributions).where(eq(pluginContributions.workspaceId, workspaceId)).orderBy(asc(pluginContributions.createdAt));
    return kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows;
  }

  /** Whether every interface a UI contribution reads or acts on has a healthy bound provider. */
  contributionReady(reg: WorkspaceRegistry, spec: unknown): { ready: boolean; missing: string[] } {
    const missing = uiInterfaces(spec).filter((n) => !reg.bindings.some((b) => b.interface === n && reg.providers.find((p) => p.row.id === b.providerId)?.healthy));
    return { ready: missing.length === 0, missing };
  }

  // ---- the registrar (§4.10) ----

  private async effect(workspaceId: string, installId: string, kind: string, ref: string, inverse: Inverse, external = false): Promise<EffectRow> {
    const last = (await this.db.select().from(pluginEffects).where(eq(pluginEffects.installId, installId)).orderBy(desc(pluginEffects.seq)).limit(1)).at(0);
    const row: EffectRow = {
      accountId: currentAccountId(), id: newId(), workspaceId, installId, seq: (last?.seq ?? 0) + 1, kind, ref,
      inverse: JSON.stringify(inverse), external: external ? 1 : 0, finalizer: null, state: 'live', createdAt: nowIso(), unwoundAt: null,
    };
    await this.db.insert(pluginEffects).values(row);
    return row;
  }

  async effects(installId: string): Promise<EffectRow[]> {
    return this.db.select().from(pluginEffects).where(eq(pluginEffects.installId, installId)).orderBy(asc(pluginEffects.seq));
  }

  /** Unwind live effects in reverse order. `restorable` keeps them for enable. */
  private async unwind(workspaceId: string, installId: string, actor: string, restorable: boolean): Promise<number> {
    const live = (await this.effects(installId)).filter((e) => e.state === 'live').reverse();
    for (const e of live) await this.unwindOne(workspaceId, installId, e, actor, restorable);
    return live.length;
  }

  private async unwindOne(workspaceId: string, installId: string, e: EffectRow, actor: string, restorable: boolean): Promise<void> {
    const inv = JSON.parse(e.inverse) as Inverse;
    await this.db.update(pluginEffects).set({ state: 'unwinding' }).where(eq(pluginEffects.id, e.id));
    if (inv.op === 'delete' && inv.table && inv.id && inv.table in EFFECT_TABLES) {
      const t = EFFECT_TABLES[inv.table];
      // Keep the row as it is now (conformance results and all), so enable restores it exactly.
      const current = (await this.db.select().from(t).where(eq(t.id, inv.id))).at(0);
      if (current) inv.snapshot = current as Record<string, unknown>;
      await this.db.delete(t).where(eq(t.id, inv.id));
    } else if (inv.op === 'skill' && inv.id) {
      await this.skills?.setContributedEnabled(inv.id, false);
    }
    await this.db.update(pluginEffects).set({ state: restorable ? 'disabled' : 'unwound', unwoundAt: nowIso(), inverse: JSON.stringify(inv) }).where(eq(pluginEffects.id, e.id));
    await this.audit.append(workspaceId, { actor, action: 'plugin_effect_unwound', refType: 'plugin_effect', refId: e.id, payload: { installId, seq: e.seq, kind: e.kind, ref: e.ref, restorable } });
  }

  /** Re-register effects a disable unwound, in their original order. */
  private async restore(workspaceId: string, installId: string, actor: string): Promise<number> {
    const parked = (await this.effects(installId)).filter((e) => e.state === 'disabled');
    for (const e of parked) {
      const inv = JSON.parse(e.inverse) as Inverse;
      if (inv.op === 'delete' && inv.table && inv.snapshot && inv.table in EFFECT_TABLES) {
        const t = EFFECT_TABLES[inv.table];
        const exists = (await this.db.select({ id: t.id }).from(t).where(eq(t.id, String(inv.id)))).at(0);
        // A binding whose scope was taken meanwhile stays unwound.
        if (!exists) { try { await this.db.insert(t).values(inv.snapshot as never); } catch { await this.db.update(pluginEffects).set({ state: 'unwound' }).where(eq(pluginEffects.id, e.id)); continue; } }
      } else if (inv.op === 'skill' && inv.id) {
        await this.skills?.setContributedEnabled(inv.id, true);
      }
      await this.db.update(pluginEffects).set({ state: 'live', unwoundAt: null }).where(eq(pluginEffects.id, e.id));
      await this.audit.append(workspaceId, { actor, action: 'plugin_effect_restored', refType: 'plugin_effect', refId: e.id, payload: { installId, seq: e.seq, kind: e.kind, ref: e.ref } });
    }
    return parked.length;
  }

  /** An effect the owner undid directly (an unbind, a revoked grant). */
  private async retireEffect(installId: string, table: EffectTable, id: string): Promise<void> {
    for (const e of await this.effects(installId)) {
      const inv = JSON.parse(e.inverse) as Inverse;
      if (inv.table === table && inv.id === id && (e.state === 'live' || e.state === 'disabled')) {
        await this.db.update(pluginEffects).set({ state: 'unwound', unwoundAt: nowIso() }).where(eq(pluginEffects.id, e.id));
      }
    }
  }

  // ---- registry ----

  async installOf(workspaceId: string, pluginId: string): Promise<LoadedInstall | null> {
    const install = (await this.db.select().from(pluginInstalls).where(and(eq(pluginInstalls.workspaceId, workspaceId), eq(pluginInstalls.pluginId, pluginId)))).at(0);
    if (!install) return null;
    const version = (await this.db.select().from(pluginVersions).where(eq(pluginVersions.id, install.versionId))).at(0);
    if (!version) return null;
    return { install, version, manifest: JSON.parse(version.manifest) as Manifest, files: JSON.parse(version.files || '{}') as Record<string, string> };
  }

  /** The workspace's view: interfaces of live interface installs, providers, bindings, rules. */
  async registry(workspaceId: string): Promise<WorkspaceRegistry> {
    const rows = await this.db.select().from(pluginInstalls).where(and(eq(pluginInstalls.workspaceId, workspaceId), ne(pluginInstalls.status, 'removed')));
    const versionIds = rows.map((r) => r.versionId);
    const versions = versionIds.length ? await this.db.select().from(pluginVersions).where(inArray(pluginVersions.id, versionIds)) : [];
    const installs: LoadedInstall[] = rows.map((install) => {
      const version = versions.find((v) => v.id === install.versionId)!;
      return { install, version, manifest: JSON.parse(version.manifest) as Manifest, files: JSON.parse(version.files || '{}') as Record<string, string> };
    }).filter((x) => x.version);
    const ifaceMap = new Map<string, RegistryIface>();
    for (const li of installs) {
      if (PARKED.has(li.install.status)) continue;
      for (const def of li.manifest.interfaces ?? []) {
        const hash = sha256(canonicalJson(def));
        const v = (await this.db.select().from(interfaceVersions).where(and(eq(interfaceVersions.name, def.name), eq(interfaceVersions.version, def.version), eq(interfaceVersions.definitionHash, hash)))).at(0);
        ifaceMap.set(def.name, {
          name: def.name, version: def.version, major: parseVersion(def.version)?.major ?? 0, def, interfaceVersionId: v?.id ?? '', definitionHash: hash,
          installId: li.install.id, pluginId: li.manifest.id, pluginVersion: li.manifest.version,
          suite: v ? JSON.parse(v.suite || '{}') as Suite : undefined,
        });
      }
    }
    const provRows = await this.db.select().from(interfaceProviders).where(eq(interfaceProviders.workspaceId, workspaceId));
    const providers: RegistryProvider[] = [];
    for (const row of provRows) {
      const li = installs.find((x) => x.install.id === row.installId);
      if (!li) continue;
      const provides = (li.manifest.provides ?? []).find((p) => parseInterfaceRef(p.interface)?.name === row.interface);
      if (!provides) continue;
      const fixtures: Record<string, Fixtures> = {};
      for (const path of referencedFiles(li.manifest).fixtures) { try { fixtures[path] = JSON.parse(li.files[path] ?? '') as Fixtures; } catch { /* validated at load */ } }
      const iface = ifaceMap.get(row.interface);
      const healthy = row.status === 'conformant' && ['active', 'suspended'].includes(li.install.status)
        && Boolean(iface && satisfies(iface.version, row.range)) && !this.providerSuspended(li.install);
      providers.push({ row, install: li.install, provides, pkg: { provides, fixtures }, pluginId: li.manifest.id, pluginVersion: li.manifest.version, digest: li.version.archiveSha256, manifest: li.manifest, healthy });
    }
    const bindings = await this.db.select().from(interfaceBindings).where(eq(interfaceBindings.workspaceId, workspaceId));
    const owner = await this.db.select().from(interfacePolicies).where(eq(interfacePolicies.workspaceId, workspaceId));
    const rules: PolicyRule[] = owner.map((p) => {
      let match: { bind?: Record<string, string> } = {};
      try { match = JSON.parse(p.match || '{}') as typeof match; } catch { match = {}; }
      return { operation: p.operation || null, changeKind: p.changeKind || null, resourcePattern: p.resourcePattern || null, bind: match.bind ?? null, require: p.require, why: p.why, source: 'owner' as const };
    });
    for (const li of installs) {
      if (PARKED.has(li.install.status)) continue;
      for (const pol of li.manifest.policies ?? []) rules.push({ operation: pol.match.operation ?? null, changeKind: pol.match.changeKind ?? null, bind: pol.match.bind ?? null, require: pol.require, why: pol.why, source: 'plugin' });
    }
    // Keep classOf's lookup current: the strictest static class per tool name.
    for (const [name, ri] of ifaceMap) {
      for (const [op, def] of Object.entries(ri.def.operations)) {
        const t = toolName(name, op);
        let cls = staticClassOf(op, def, ri.def).cls;
        for (const pr of providers.filter((x) => x.row.interface === name)) cls = maxClass(cls, staticClassOf(op, def, ri.def, pr.provides).cls);
        this.staticClasses.set(t, maxClass(this.staticClasses.get(t), cls));
        this.byInput.set(t, (input) => classByInputOf(def, input));
        this.knownTools.add(t);
      }
    }
    return { workspaceId, interfaces: ifaceMap, providers, bindings, rules, installs };
  }

  private providerSuspended(install: InstallRow): boolean {
    // A provider install suspends when its own dependencies fail; "no <x>
    // provider bound" on an interface install never suspends a provider.
    return install.status === 'suspended' && install.suspendedReason.split('; ').some((r) => !/^no [a-z0-9]+ provider bound$/.test(r));
  }

  /** The agent's unit and the session's project, for scoped bindings. */
  async scopeOf(p: { agentId?: string | null; sessionId?: string | null }): Promise<{ unitId: string | null; projectId: string | null }> {
    let unitId: string | null = null;
    let projectId: string | null = null;
    if (p.agentId) {
      const led = (await this.db.select({ id: orgUnits.id }).from(orgUnits).where(and(eq(orgUnits.leadAgentId, p.agentId)))).find(Boolean);
      if (led) unitId = led.id;
      else {
        const mem = (await this.db.select({ reportsTo: orgMembers.reportsToAgentId }).from(orgMembers).where(eq(orgMembers.agentId, p.agentId))).at(0);
        if (mem?.reportsTo) unitId = (await this.db.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.leadAgentId, mem.reportsTo))).at(0)?.id ?? null;
      }
    }
    if (p.sessionId) {
      const s = (await this.db.select({ taskKind: chatSessions.taskKind, taskId: chatSessions.taskId }).from(chatSessions).where(eq(chatSessions.id, p.sessionId))).at(0);
      if (s?.taskKind === 'org' && s.taskId) projectId = (await this.db.select({ p: orgTasks.projectId }).from(orgTasks).where(eq(orgTasks.id, s.taskId))).at(0)?.p ?? null;
    }
    return { unitId, projectId };
  }

  /**
   * The binding resolver (§4.2): the most specific binding matching the
   * resource, the session's project, the agent's unit, then the workspace
   * default. No binding → refused with the candidates named; the core never
   * guesses and the agent never chooses. The resolved provider must serve
   * the resource.
   */
  resolveIn(reg: WorkspaceRegistry, ifaceName: string, ctx: { resource?: string | null; unitId?: string | null; projectId?: string | null }): Resolution {
    const iface = reg.interfaces.get(ifaceName);
    const candidates = reg.providers.filter((p) => p.row.interface === ifaceName && p.healthy).map((p) => ({ providerId: p.row.id, pluginId: p.pluginId }));
    if (!iface) return { ok: false, reason: `the ${ifaceName} interface is not installed in this workspace`, candidates };
    const mine = reg.bindings.filter((b) => b.interface === ifaceName && b.major === iface.major);
    const resourceHits = ctx.resource ? mine.filter((b) => b.scopeKind === 'resource' && globMatch(b.scopeRef, ctx.resource!)).sort((a, b) => globSpecificity(b.scopeRef) - globSpecificity(a.scopeRef)) : [];
    const ordered: Array<[BindingRow | undefined, string]> = [
      [resourceHits[0], resourceHits[0] ? `resource:${resourceHits[0].scopeRef}` : ''],
      [ctx.projectId ? mine.find((b) => b.scopeKind === 'project' && b.scopeRef === ctx.projectId) : undefined, `project:${ctx.projectId}`],
      [ctx.unitId ? mine.find((b) => b.scopeKind === 'unit' && b.scopeRef === ctx.unitId) : undefined, `unit:${ctx.unitId}`],
      [mine.find((b) => b.scopeKind === 'workspace'), 'workspace'],
    ];
    const hit = ordered.find(([b]) => b);
    if (!hit || !hit[0]) {
      return { ok: false, reason: `no ${ifaceName} provider is bound${ctx.resource ? ` for ${ctx.resource}` : ''}; the owner binds one (candidates: ${candidates.map((c) => c.pluginId).join(', ') || 'none installed'})`, candidates };
    }
    const [binding, scope] = hit;
    const provider = reg.providers.find((p) => p.row.id === binding.providerId);
    if (!provider) return { ok: false, reason: `the ${ifaceName} binding at ${scope} points at a provider that is gone`, candidates };
    if (!provider.healthy) return { ok: false, reason: `${provider.pluginId}, bound for ${ifaceName} at ${scope}, is not healthy (${provider.install.status}${provider.install.suspendedReason ? `: ${provider.install.suspendedReason}` : ''}${provider.row.status !== 'conformant' ? `; conformance ${provider.row.status}` : ''})`, candidates };
    if (ctx.resource && !(JSON.parse(provider.row.resources) as string[]).some((pat) => globMatch(pat, ctx.resource!))) {
      return { ok: false, reason: `${provider.pluginId} does not serve ${ctx.resource}`, candidates };
    }
    return { ok: true, provider, scope, why: `${scope} binding` };
  }

  async resolve(workspaceId: string, ifaceName: string, q: { resource?: string; agentId?: string; sessionId?: string }): Promise<Record<string, unknown>> {
    const reg = await this.registry(workspaceId);
    const scope = await this.scopeOf({ agentId: q.agentId, sessionId: q.sessionId });
    const r = this.resolveIn(reg, ifaceName, { resource: q.resource ?? null, ...scope });
    return r.ok ? { ok: true, providerId: r.provider.row.id, pluginId: r.provider.pluginId, scope: r.scope, why: r.why } : { ok: false, reason: r.reason, candidates: r.candidates };
  }

  // ---- conformance (§4.4) ----

  private async conformAll(workspaceId: string, installId: string): Promise<void> {
    const reg = await this.registry(workspaceId);
    for (const p of reg.providers.filter((x) => x.install.id === installId)) await this.conform(workspaceId, reg, p);
  }

  private async conform(workspaceId: string, reg: WorkspaceRegistry, p: RegistryProvider, pkgOverride?: { provides: ProvidesDef; pkg: ProviderPackage; versionId: string }): Promise<{ result: string; cases: CaseResult[]; runId: string }> {
    const iface = reg.interfaces.get(p.row.interface);
    const runId = newId();
    const startedAt = nowIso();
    let outcome: { result: 'pass' | 'fail' | 'error'; cases: CaseResult[] };
    if (!iface || !satisfies(iface.version, p.row.range)) {
      outcome = { result: 'error', cases: [{ id: 'interface', ok: false, detail: `no installed ${p.row.interface} version satisfies ${p.row.range}` }] };
    } else {
      outcome = await runSuite({ iface: iface.def, suite: iface.suite && (iface.suite as Suite).cases ? iface.suite : undefined, pkg: pkgOverride?.pkg ?? p.pkg, runId: runId.slice(0, 8) });
    }
    await this.db.insert(conformanceRuns).values({
      accountId: currentAccountId(), id: runId, workspaceId, providerId: p.row.id, installId: p.install.id, pluginVersionId: pkgOverride?.versionId ?? p.install.versionId,
      interfaceVersionId: iface?.interfaceVersionId ?? '', mode: (pkgOverride?.provides ?? p.provides).conformance.mode, startedAt, finishedAt: nowIso(),
      result: outcome.result, cases: JSON.stringify(outcome.cases), envId: null,
    });
    if (!pkgOverride) {
      await this.db.update(interfaceProviders).set({ status: outcome.result === 'pass' ? 'conformant' : 'failed', conformanceRunId: runId, resolvedVersion: iface?.version ?? '' }).where(eq(interfaceProviders.id, p.row.id));
    }
    await this.audit.append(workspaceId, { actor: 'system', action: 'conformance_run', refType: 'interface_provider', refId: p.row.id, payload: { pluginId: p.pluginId, interface: p.row.interface, result: outcome.result, failed: outcome.cases.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail ?? ''}`), candidate: pkgOverride?.versionId ?? null } });
    return { ...outcome, runId };
  }

  async runConformance(workspaceId: string, pluginId: string): Promise<Array<{ interface: string; result: string; cases: CaseResult[] }>> {
    await this.requireOwner(workspaceId, 'runs conformance');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    const reg = await this.registry(workspaceId);
    const out = [];
    for (const p of reg.providers.filter((x) => x.install.id === li.install.id)) {
      const r = await this.conform(workspaceId, reg, p);
      out.push({ interface: p.row.interface, result: r.result, cases: r.cases });
    }
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return out;
  }

  // ---- activation and suspension (§4.11) ----

  /** Recompute every install's status from its dependencies. */
  async refreshActivation(workspaceId: string): Promise<void> {
    for (let pass = 0; pass < 2; pass++) {
      const reg = await this.registry(workspaceId);
      for (const li of reg.installs) {
        const st = li.install.status;
        if (STICKY.has(st)) continue;
        const reasons: string[] = [];
        let base: 'active' | 'installed' = 'active';
        const provRows = reg.providers.filter((p) => p.install.id === li.install.id);
        if ((li.manifest.provides ?? []).length > 0) {
          for (const p of li.manifest.provides ?? []) {
            const ref = parseInterfaceRef(p.interface)!;
            const iface = reg.interfaces.get(ref.name);
            if (!iface || !satisfies(iface.version, ref.range)) reasons.push(`the ${ref.name} interface is not installed`);
          }
          if (reasons.length === 0 && provRows.length > 0 && provRows.every((p) => p.row.status !== 'conformant')) {
            base = 'installed';
            reasons.push(`conformance ${provRows.map((p) => `${p.row.interface}: ${p.row.status}`).join(', ')}`);
          }
        }
        for (const ifname of [...(li.manifest.interfaces ?? []).map((i) => i.name)]) {
          const bound = reg.bindings.some((b) => b.interface === ifname && reg.providers.find((p) => p.row.id === b.providerId)?.healthy);
          if (!bound) reasons.push(`no ${ifname} provider bound`);
        }
        if (li.manifest.roles.includes('consumer')) {
          for (const r of li.manifest.requires.interfaces ?? []) {
            const ref = parseInterfaceRef(r)!;
            if ((li.manifest.provides ?? []).some((p) => parseInterfaceRef(p.interface)?.name === ref.name)) continue;
            const bound = reg.bindings.some((b) => b.interface === ref.name && reg.providers.find((p) => p.row.id === b.providerId)?.healthy);
            if (!bound) reasons.push(`no ${ref.name} provider bound`);
          }
        }
        const status = base === 'installed' ? 'installed' : reasons.length > 0 ? 'suspended' : 'active';
        const reason = reasons.join('; ');
        if (status !== st || reason !== li.install.suspendedReason) {
          await this.db.update(pluginInstalls).set({ status, suspendedReason: reason, updatedAt: nowIso(), ...(status === 'active' && !li.install.activatedAt ? { activatedAt: nowIso() } : {}) }).where(eq(pluginInstalls.id, li.install.id));
          if (status === 'suspended' || (st === 'suspended' && status === 'active')) {
            await this.audit.append(workspaceId, { actor: 'system', action: status === 'suspended' ? 'plugin_suspended' : 'plugin_resumed', refType: 'plugin', refId: li.manifest.id, payload: { reason, from: st } });
          }
        }
      }
    }
  }

  // ---- bindings (§4.2, §6.3) ----

  async setBinding(workspaceId: string, ifaceName: string, body: { major?: number; scopeKind?: string; scopeRef?: string; providerId?: string | null }): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'binds providers');
    const reg = await this.registry(workspaceId);
    const iface = reg.interfaces.get(ifaceName);
    if (!iface) throw new NotFoundException(`the ${ifaceName} interface is not installed`);
    const major = body.major ?? iface.major;
    const scopeKind = body.scopeKind ?? 'workspace';
    if (!['workspace', 'unit', 'project', 'resource'].includes(scopeKind)) throw new BadRequestException('scopeKind is workspace, unit, project or resource');
    const scopeRef = scopeKind === 'workspace' ? '' : String(body.scopeRef ?? '').trim();
    if (scopeKind !== 'workspace' && !scopeRef) throw new BadRequestException(`a ${scopeKind} binding names its scope`);
    if (scopeKind === 'resource' && validate(scopeRef.replace(/\*/g, 'x'), iface.def.resources.schema, {}).length > 0 && !/^[a-z][a-z0-9]{1,15}:\/\//.test(scopeRef)) {
      throw new BadRequestException(`a resource binding is a pattern over ${iface.def.resources.pattern}`);
    }
    const existing = reg.bindings.find((b) => b.interface === ifaceName && b.major === major && b.scopeKind === scopeKind && b.scopeRef === scopeRef);
    const prevProvider = existing ? reg.providers.find((p) => p.row.id === existing.providerId) : undefined;
    if (body.providerId === null || body.providerId === undefined || body.providerId === '') {
      if (!existing) return { ok: true, unbound: false };
      await this.db.delete(interfaceBindings).where(eq(interfaceBindings.id, existing.id));
      if (prevProvider) await this.retireEffect(prevProvider.install.id, 'interface_bindings', existing.id);
      await this.audit.append(workspaceId, { actor, action: 'interface_binding_set', refType: 'interface', refId: ifaceName, payload: { major, scopeKind, scopeRef, from: prevProvider?.pluginId ?? null, to: null } });
      await this.refreshActivation(workspaceId);
      this.changed(workspaceId);
      return { ok: true, unbound: true };
    }
    const provider = reg.providers.find((p) => p.row.interface === ifaceName && (p.row.id === body.providerId || p.pluginId === body.providerId));
    if (!provider) throw new BadRequestException(`${body.providerId} does not provide ${ifaceName}`);
    if (provider.row.status !== 'conformant') throw new BadRequestException(`${provider.pluginId} cannot be bound: conformance ${provider.row.status} (a provider binds only after a pass)`);
    if (['disabled', 'frozen', 'removed', 'installed'].includes(provider.install.status)) throw new BadRequestException(`${provider.pluginId} cannot be bound while ${provider.install.status}`);
    if (majorOf(provider.row.range) !== major) throw new BadRequestException(`${provider.pluginId} provides ${ifaceName}@${provider.row.range}, not major ${major}`);
    if (existing) {
      await this.db.delete(interfaceBindings).where(eq(interfaceBindings.id, existing.id));
      if (prevProvider) await this.retireEffect(prevProvider.install.id, 'interface_bindings', existing.id);
    }
    const row: BindingRow = { accountId: currentAccountId(), id: newId(), workspaceId, interface: ifaceName, major, scopeKind, scopeRef, providerId: provider.row.id, setBy: actor, createdAt: nowIso() };
    await this.db.insert(interfaceBindings).values(row);
    await this.effect(workspaceId, provider.install.id, 'binding', `${ifaceName}@${major} ${scopeKind}${scopeRef ? `:${scopeRef}` : ''}`, { op: 'delete', table: 'interface_bindings', id: row.id, snapshot: row });
    await this.audit.append(workspaceId, { actor, action: 'interface_binding_set', refType: 'interface', refId: ifaceName, payload: { major, scopeKind, scopeRef, from: prevProvider?.pluginId ?? null, to: provider.pluginId } });
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return { ok: true, binding: row, reroutes: prevProvider ? `${scopeKind}${scopeRef ? ` ${scopeRef}` : ''}: ${prevProvider.pluginId} → ${provider.pluginId}` : null };
  }

  // ---- grants (§6.4) ----

  async setGrant(workspaceId: string, pluginId: string, agentId: string, body: { level?: string | null; extras?: boolean }): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'grants plugin access');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    if (!li.manifest.roles.includes('provider')) throw new BadRequestException('grants are on providers');
    const agent = (await this.db.select({ id: agents.id, workspaceId: agents.workspaceId }).from(agents).where(eq(agents.id, agentId))).at(0);
    if (!agent || agent.workspaceId !== workspaceId) throw new NotFoundException(`agent ${agentId} is not in this workspace`);
    const cur = (await this.db.select().from(pluginGrants).where(and(eq(pluginGrants.installId, li.install.id), eq(pluginGrants.agentId, agentId)))).at(0);
    if (cur) { await this.db.delete(pluginGrants).where(eq(pluginGrants.id, cur.id)); await this.retireEffect(li.install.id, 'plugin_grants', cur.id); }
    let row = null;
    if (body.level === 'read' || body.level === 'write') {
      row = { accountId: currentAccountId(), id: newId(), workspaceId, installId: li.install.id, connectionId: null, agentId, level: body.level, extras: body.extras ? 1 : 0, memberAccountId: null, createdAt: nowIso() };
      await this.db.insert(pluginGrants).values(row);
      await this.effect(workspaceId, li.install.id, 'grant', `${agentId}:${body.level}${body.extras ? '+extras' : ''}`, { op: 'delete', table: 'plugin_grants', id: row.id, snapshot: row });
    } else if (body.level !== null && body.level !== undefined) {
      throw new BadRequestException('level is read, write or null');
    }
    await this.audit.append(workspaceId, { actor, action: 'plugin_grant_set', refType: 'plugin', refId: pluginId, payload: { agentId, level: body.level ?? null, extras: Boolean(body.extras) } });
    this.changed(workspaceId);
    return { ok: true, grant: row };
  }

  async grantsOf(workspaceId: string, agentId: string): Promise<Array<typeof pluginGrants.$inferSelect>> {
    return this.db.select().from(pluginGrants).where(and(eq(pluginGrants.workspaceId, workspaceId), eq(pluginGrants.agentId, agentId)));
  }

  // ---- owner policies (§4.3 step 4) ----

  async listPolicies(workspaceId: string): Promise<Array<typeof interfacePolicies.$inferSelect>> {
    return this.db.select().from(interfacePolicies).where(eq(interfacePolicies.workspaceId, workspaceId));
  }

  async putPolicy(workspaceId: string, id: string, body: { operation?: string; changeKind?: string; resourcePattern?: string; bind?: Record<string, string>; require?: string; why?: string }): Promise<typeof interfacePolicies.$inferSelect> {
    const actor = await this.requireOwner(workspaceId, 'sets policies on operations');
    const op = String(body.operation ?? '').trim();
    const kind = String(body.changeKind ?? '').trim();
    if (!op && !kind) throw new BadRequestException('a policy names an operation (iface.op or iface.*) or a change kind (iface.kind)');
    if (op && !/^[a-z][a-z0-9]{1,15}\.([a-z][a-z0-9_]{0,39}|\*)$/.test(op)) throw new BadRequestException('operation is iface.op or iface.*');
    if (kind && !/^[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9_]{0,39}$/.test(kind)) throw new BadRequestException('changeKind is iface.kind');
    const req = String(body.require ?? '');
    if (!(['two_key', 'cosign', 'owner_key', 'deny'].includes(req) || (req.startsWith('class:') && isActionClass(req.slice(6))))) throw new BadRequestException('require is two_key, cosign, owner_key, deny or class:<Class>');
    const row = {
      accountId: currentAccountId(), id: id || newId(), workspaceId, operation: op, changeKind: kind, resourcePattern: String(body.resourcePattern ?? '').trim(),
      match: JSON.stringify(body.bind ? { bind: body.bind } : {}), require: req, why: String(body.why ?? '').slice(0, 300), setBy: actor, createdAt: nowIso(),
    };
    await this.db.delete(interfacePolicies).where(and(eq(interfacePolicies.id, row.id), eq(interfacePolicies.workspaceId, workspaceId)));
    await this.db.insert(interfacePolicies).values(row);
    await this.audit.append(workspaceId, { actor, action: 'interface_policy_set', refType: 'interface_policy', refId: row.id, payload: { operation: op, changeKind: kind, resourcePattern: row.resourcePattern, require: req, why: row.why } });
    this.changed(workspaceId);
    return row;
  }

  async deletePolicy(workspaceId: string, id: string): Promise<{ ok: true }> {
    const actor = await this.requireOwner(workspaceId, 'removes policies on operations');
    await this.db.delete(interfacePolicies).where(and(eq(interfacePolicies.id, id), eq(interfacePolicies.workspaceId, workspaceId)));
    await this.audit.append(workspaceId, { actor, action: 'interface_policy_removed', refType: 'interface_policy', refId: id });
    this.changed(workspaceId);
    return { ok: true };
  }

  /** Owner and requested policies applied to one call (they only raise). */
  applyPolicies(reg: WorkspaceRegistry, base: { cls: ActionClass; requirement: Parameters<typeof applyRules>[0]['requirement'] }, call: Parameters<typeof applyRules>[2]): ReturnType<typeof applyRules> {
    return applyRules(base, reg.rules, call);
  }

  // ---- disable, enable, uninstall (§6.6, §6.7) ----

  async disable(workspaceId: string, pluginId: string): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'disables plugins');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    if (li.install.status === 'disabled') return { ok: true, unwound: 0 };
    await this.db.update(pluginInstalls).set({ status: 'disabled', updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
    const n = await this.unwind(workspaceId, li.install.id, actor, true);
    await this.audit.append(workspaceId, { actor, action: 'plugin_disabled', refType: 'plugin', refId: pluginId, payload: { unwound: n } });
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return { ok: true, unwound: n };
  }

  async enable(workspaceId: string, pluginId: string): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'enables plugins');
    const li = await this.installOf(workspaceId, pluginId);
    if (li?.install.status === 'frozen') throw new BadRequestException(`${pluginId} is frozen because its version was recalled; update it to a version that is not recalled`);
    if (!li || li.install.status !== 'disabled') throw new BadRequestException(`${pluginId} is not disabled`);
    const n = await this.restore(workspaceId, li.install.id, actor);
    await this.db.update(pluginInstalls).set({ status: 'installed', updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
    await this.audit.append(workspaceId, { actor, action: 'plugin_enabled', refType: 'plugin', refId: pluginId, payload: { restored: n } });
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return { ok: true, restored: n };
  }

  async uninstall(workspaceId: string, pluginId: string): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'uninstalls plugins');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    const reg = await this.registry(workspaceId);
    const names = (li.manifest.interfaces ?? []).map((i) => i.name);
    const dependants = reg.installs.filter((x) => x.install.id !== li.install.id && x.install.status !== 'removed'
      && ((x.manifest.provides ?? []).some((p) => names.includes(parseInterfaceRef(p.interface)?.name ?? '')) || (x.manifest.requires.interfaces ?? []).some((r) => names.includes(parseInterfaceRef(r)?.name ?? ''))));
    if (dependants.length > 0) throw new ConflictException(`still needed by ${dependants.map((d) => d.manifest.id).join(', ')}; remove them first or install a replacement`);
    await this.db.update(pluginInstalls).set({ status: 'terminating', updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
    // Effects a disable parked are unwound for good.
    await this.db.update(pluginEffects).set({ state: 'unwound' }).where(and(eq(pluginEffects.installId, li.install.id), eq(pluginEffects.state, 'disabled')));
    const n = await this.unwind(workspaceId, li.install.id, actor, false);
    // Belt and braces: nothing of this install stays registered.
    await this.db.delete(interfaceProviders).where(eq(interfaceProviders.installId, li.install.id));
    await this.db.delete(pluginGrants).where(eq(pluginGrants.installId, li.install.id));
    await this.db.delete(pluginContributions).where(eq(pluginContributions.installId, li.install.id));
    await this.db.update(pluginInstalls).set({ status: 'removed', pendingVersionId: null, pendingNote: '{}', suspendedReason: '', updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
    await this.audit.append(workspaceId, { actor, action: 'plugin_uninstalled', refType: 'plugin', refId: pluginId, payload: { unwound: n } });
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return { ok: true, unwound: n };
  }

  // ---- updates (§6.5) ----

  async update(workspaceId: string, pluginId: string, source: InstallSource): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'updates plugins');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li || li.install.status === 'removed') throw new NotFoundException(`${pluginId} is not installed`);
    const { pkg, tier } = await this.load(source);
    if (pkg.manifest.id !== pluginId) throw new BadRequestException(`the package is ${pkg.manifest.id}, not ${pluginId}`);
    const review = await this.reviewOf(workspaceId, pkg, tier, li.manifest);
    if (review.blockers.length > 0) throw new BadRequestException({ message: 'the update is blocked', blockers: review.blockers });
    const version = await this.versionRow(pkg, tier);
    if (version.id === li.version.id) return { applied: false, reason: 'already at this version' };
    // Providers re-run conformance on the candidate before anything moves.
    const failures = await this.candidateConformance(workspaceId, li, pkg, version.id);
    if (failures.length > 0 || review.widening) {
      await this.db.update(pluginInstalls).set({ pendingVersionId: version.id, pendingNote: JSON.stringify({ diff: review.diff, failures, version: pkg.manifest.version }), updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
      await this.audit.append(workspaceId, { actor, action: 'plugin_update_pending', refType: 'plugin', refId: pluginId, payload: { from: li.manifest.version, to: pkg.manifest.version, widening: review.diff.filter((d) => d.widening).map((d) => `${d.path}: ${d.detail}`), failures } });
      this.changed(workspaceId);
      return { applied: false, pending: true, widening: review.widening, failures, diff: review.diff };
    }
    await this.switchVersion(workspaceId, li, pkg, version, actor, review.diff);
    return { applied: true, diff: review.diff };
  }

  private async candidateConformance(workspaceId: string, li: LoadedInstall, pkg: PluginPackage, versionId: string): Promise<string[]> {
    const failures: string[] = [];
    if ((pkg.manifest.provides ?? []).length === 0) return failures;
    const reg = await this.registry(workspaceId);
    for (const p of pkg.manifest.provides ?? []) {
      const ref = parseInterfaceRef(p.interface)!;
      const cur = reg.providers.find((x) => x.install.id === li.install.id && x.row.interface === ref.name);
      if (!cur) continue;
      const r = await this.conform(workspaceId, reg, cur, { provides: p, pkg: { provides: p, fixtures: pkg.fixtures }, versionId });
      if (r.result !== 'pass') failures.push(...r.cases.filter((c) => !c.ok).map((c) => `${ref.name}/${c.id}: ${c.detail ?? 'failed'}`));
    }
    return failures;
  }

  /** Move an install to a version: re-register contributions by id; the
   *  next turn sees the new definitions (a turn's tool list is fixed when
   *  it starts), while classes are read per call and only ever stricter. */
  private async switchVersion(workspaceId: string, li: LoadedInstall, pkg: PluginPackage, version: VersionRow, actor: string, diff: DiffEntry[]): Promise<void> {
    const m = pkg.manifest;
    if (li.install.status === 'frozen') {
      // Moving off a recalled version: the parked effects come back, then the new version registers over them.
      await this.restore(workspaceId, li.install.id, actor);
      await this.db.update(pluginInstalls).set({ status: 'installed', suspendedReason: '' }).where(eq(pluginInstalls.id, li.install.id));
      await this.audit.append(workspaceId, { actor, action: 'plugin_unfrozen', refType: 'plugin', refId: m.id, payload: { from: li.manifest.version, to: m.version } });
    }
    await this.db.update(pluginInstalls).set({ versionId: version.id, pendingVersionId: null, pendingNote: '{}', approvedDiff: JSON.stringify({ diff }), updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
    for (const iface of m.interfaces ?? []) {
      const hash = sha256(canonicalJson(iface));
      const have = (await this.db.select().from(interfaceVersions).where(and(eq(interfaceVersions.name, iface.name), eq(interfaceVersions.version, iface.version), eq(interfaceVersions.definitionHash, hash)))).at(0);
      if (!have) {
        await this.db.insert(interfaceVersions).values({
          accountId: currentAccountId(), id: newId(), name: iface.name, version: iface.version, major: parseVersion(iface.version)!.major,
          definition: JSON.stringify(iface), definitionHash: hash, pluginVersionId: version.id, suite: JSON.stringify(pkg.suites[iface.conformance] ?? {}), deprecatedAt: null, sunsetAt: null, createdAt: nowIso(),
        });
      }
      await this.db.update(interfaces).set({ latestVersion: iface.version }).where(eq(interfaces.name, iface.name));
    }
    for (const p of m.provides ?? []) {
      const ref = parseInterfaceRef(p.interface)!;
      await this.db.update(interfaceProviders).set({ range: ref.range, resources: JSON.stringify(p.resources) }).where(and(eq(interfaceProviders.installId, li.install.id), eq(interfaceProviders.interface, ref.name)));
    }
    if (li.install.status !== 'disabled') await this.refreshExtras(workspaceId, li.install.id, m, pkg, version.source as Tier, actor);
    await this.audit.append(workspaceId, { actor, action: 'plugin_updated', refType: 'plugin', refId: m.id, payload: { from: li.manifest.version, to: m.version, digest: pkg.digest, changes: diff.map((d) => `${d.path}: ${d.detail}`) } });
    await this.conformAll(workspaceId, li.install.id);
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
  }

  async decideUpdate(workspaceId: string, pluginId: string, approve: boolean): Promise<Record<string, unknown>> {
    const actor = await this.requireOwner(workspaceId, 'approves plugin updates');
    const li = await this.installOf(workspaceId, pluginId);
    if (!li?.install.pendingVersionId) throw new BadRequestException(`${pluginId} has no pending update`);
    const note = JSON.parse(li.install.pendingNote || '{}') as { failures?: string[]; diff?: DiffEntry[] };
    if (!approve) {
      await this.db.update(pluginInstalls).set({ pendingVersionId: null, pendingNote: '{}', updatedAt: nowIso() }).where(eq(pluginInstalls.id, li.install.id));
      await this.audit.append(workspaceId, { actor, action: 'plugin_update_declined', refType: 'plugin', refId: pluginId });
      this.changed(workspaceId);
      return { applied: false };
    }
    if ((note.failures ?? []).length > 0) throw new BadRequestException(`the pending version fails conformance and cannot be applied: ${note.failures!.join('; ')}`);
    const version = (await this.db.select().from(pluginVersions).where(eq(pluginVersions.id, li.install.pendingVersionId))).at(0);
    if (!version) throw new NotFoundException('the pending version is gone');
    if (version.revokedAt) throw new BadRequestException(`${pluginId}@${version.version} was recalled${version.revokeReason ? `: ${version.revokeReason}` : ''}; it cannot be applied`);
    const files = JSON.parse(version.files || '{}') as Record<string, string>;
    const pkg = packageFrom(JSON.parse(version.manifest), files);
    await this.switchVersion(workspaceId, li, pkg, version, actor, note.diff ?? []);
    await this.audit.append(workspaceId, { actor, action: 'plugin_update_approved', refType: 'plugin', refId: pluginId, payload: { version: version.version } });
    return { applied: true };
  }

  // ---- recall (§6.8) ----

  /**
   * A recalled version freezes every install of it: the registrar unwinds
   * its effects (kept restorable, so approving a version that is not
   * recalled brings them back), its tools leave from the next turn, its
   * dependants suspend, and the install carries the notice. Called by the
   * plugin registry; the caller has checked who may recall.
   */
  async freeze(workspaceId: string, installId: string, notice: string, actor: string): Promise<boolean> {
    const install = (await this.db.select().from(pluginInstalls).where(and(eq(pluginInstalls.id, installId), eq(pluginInstalls.workspaceId, workspaceId)))).at(0);
    if (!install || install.status === 'removed' || install.status === 'frozen') return false;
    const wasDisabled = install.status === 'disabled';
    await this.db.update(pluginInstalls).set({ status: 'frozen', suspendedReason: notice, updatedAt: nowIso() }).where(eq(pluginInstalls.id, installId));
    const n = wasDisabled ? 0 : await this.unwind(workspaceId, installId, actor, true);
    await this.audit.append(workspaceId, { actor, action: 'plugin_revoked', refType: 'plugin', refId: install.pluginId, payload: { notice, unwound: n, severity: 'major' } });
    await this.refreshActivation(workspaceId);
    this.changed(workspaceId);
    return true;
  }

  /** A pending update to a recalled version is withdrawn. */
  async dropPending(workspaceId: string, installId: string, actor: string, why: string): Promise<void> {
    await this.db.update(pluginInstalls).set({ pendingVersionId: null, pendingNote: '{}', updatedAt: nowIso() }).where(and(eq(pluginInstalls.id, installId), eq(pluginInstalls.workspaceId, workspaceId)));
    await this.audit.append(workspaceId, { actor, action: 'plugin_update_withdrawn', refType: 'plugin_install', refId: installId, payload: { why } });
    this.changed(workspaceId);
  }

  // ---- views ----

  async summary(workspaceId: string, pluginId: string): Promise<Record<string, unknown> | null> {
    const li = await this.installOf(workspaceId, pluginId);
    if (!li) return null;
    const providers = await this.db.select().from(interfaceProviders).where(eq(interfaceProviders.installId, li.install.id));
    const pending = li.install.pendingVersionId ? JSON.parse(li.install.pendingNote || '{}') as Record<string, unknown> : null;
    return {
      id: li.manifest.id, name: li.manifest.name, version: li.manifest.version, description: li.manifest.description ?? '', roles: li.manifest.roles,
      tier: li.version.source, status: li.install.status, suspendedReason: li.install.suspendedReason, installId: li.install.id,
      digest: li.version.archiveSha256, installedAt: li.install.createdAt, pendingUpdate: pending,
      // The recall notice (§6.8): why a frozen install stopped, until the owner moves it to a version that is not recalled.
      recall: li.install.status === 'frozen' ? { version: li.manifest.version, notice: li.install.suspendedReason, at: li.version.revokedAt } : null,
      providers: providers.map((p) => ({ id: p.id, interface: p.interface, range: p.range, status: p.status, resources: JSON.parse(p.resources) as string[], conformanceRunId: p.conformanceRunId })),
      interfaces: (li.manifest.interfaces ?? []).map((i) => `${i.name}@${i.version}`),
    };
  }

  async list(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await this.db.select().from(pluginInstalls).where(and(eq(pluginInstalls.workspaceId, workspaceId), ne(pluginInstalls.status, 'removed')));
    const out = [];
    for (const r of rows) { const s = await this.summary(workspaceId, r.pluginId); if (s) out.push(s); }
    return out;
  }

  async detail(workspaceId: string, pluginId: string): Promise<Record<string, unknown>> {
    const li = await this.installOf(workspaceId, pluginId);
    if (!li) throw new NotFoundException(`${pluginId} is not installed`);
    const s = await this.summary(workspaceId, pluginId);
    const runs = await this.db.select().from(conformanceRuns).where(eq(conformanceRuns.installId, li.install.id)).orderBy(desc(conformanceRuns.startedAt));
    const grants = await this.db.select().from(pluginGrants).where(eq(pluginGrants.installId, li.install.id));
    return {
      ...s,
      effects: (await this.effects(li.install.id)).map((e) => ({ id: e.id, seq: e.seq, kind: e.kind, ref: e.ref, state: e.state, external: e.external === 1, createdAt: e.createdAt, unwoundAt: e.unwoundAt })),
      conformance: runs.slice(0, 20).map((r) => ({ id: r.id, providerId: r.providerId, result: r.result, mode: r.mode, startedAt: r.startedAt, cases: JSON.parse(r.cases) as CaseResult[], candidate: r.pluginVersionId !== li.install.versionId })),
      grants: grants.map((g) => ({ agentId: g.agentId, level: g.level, extras: g.extras === 1 })),
      approved: JSON.parse(li.install.approvedDiff || '[]') as unknown,
      manifest: li.manifest,
    };
  }

  async interfacesView(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const reg = await this.registry(workspaceId);
    return [...reg.interfaces.values()].map((i) => ({
      name: i.name, version: i.version, major: i.major, pluginId: i.pluginId, semantics: i.def.semantics,
      operations: Object.entries(i.def.operations).map(([op, def]) => {
        const st = staticClassOf(op, def, i.def);
        return { op, canonical: `${i.name}.${op}`, tool: toolName(i.name, op), effectiveClass: st.cls, declaredClass: def.class ?? null, floorReasons: st.floor.reasons, change: def.change ?? null };
      }),
      changeKinds: Object.entries(i.def.changeKinds ?? {}).map(([k, kind]) => ({ kind: `${i.name}.${k}`, reversibility: kind.reversibility, requirement: kindRequirement(kind) })),
      providers: reg.providers.filter((p) => p.row.interface === i.name).map((p) => ({ id: p.row.id, pluginId: p.pluginId, status: p.row.status, healthy: p.healthy, resources: JSON.parse(p.row.resources) as string[], range: p.row.range })),
      bindings: reg.bindings.filter((b) => b.interface === i.name).map((b) => ({ id: b.id, major: b.major, scopeKind: b.scopeKind, scopeRef: b.scopeRef, providerId: b.providerId, pluginId: reg.providers.find((p) => p.row.id === b.providerId)?.pluginId ?? null, setBy: b.setBy })),
    }));
  }

  async catalogView(workspaceId: string): Promise<Array<Record<string, unknown>>> {
    const cat = await this.catalog();
    const out = [];
    for (const [id, pkg] of cat) {
      const li = await this.installOf(workspaceId, id);
      out.push({ id, name: pkg.manifest.name, version: pkg.manifest.version, description: pkg.manifest.description ?? '', roles: pkg.manifest.roles, tier: 'first_party', installed: Boolean(li && li.install.status !== 'removed'), installedVersion: li?.manifest.version ?? null, updateAvailable: Boolean(li && li.install.status !== 'removed' && li.version.archiveSha256 !== pkg.digest) });
    }
    return out;
  }
}
