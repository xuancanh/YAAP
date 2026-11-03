/**
 * RegistryService — the market registry (execution-plan item 12,
 * docs/registry.md). Three artifacts can be published: an agent (AGENT.json
 * v2 *without* lessons, tasks or profile — those are the user's, not the
 * agent's), a skill (its SKILL.md) and a mini app ({name, description, html,
 * capabilities}). Every publish runs the item-9 scan (skill-md.ts for text,
 * app-scan.ts for HTML) and stores the report beside the manifest; a
 * blocking flag refuses the publish.
 *
 * Installing is a two-step POST. The first call returns the review — the
 * capability summary, the loops, the scan report, the real skill bodies —
 * and nothing else happens; only `{ confirm: true }` installs, and what it
 * installs is inert: skills as drafts, loops disabled, elevated app
 * capabilities parked. This is docs/permissions.md §5 made executable: the
 * market gets the same gate as an AGENT.json import, plus the static checks.
 *
 * Federation is one URL. GET /api/registry merges the local items with a
 * cached (10 min) fetch of <REGISTRY_URL>/api/registry/public — the same
 * read-only feed this server exposes — through the SSRF guard, so a
 * self-hosted instance can browse the hosted registry and a hosted one can
 * accept pushes (POST /api/registry/public with REGISTRY_PUBLISH_TOKEN).
 * Installing a remote item pulls its manifest and runs the same local review
 * and scan: the remote's scan report is shown, never trusted.
 */
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { registryInstalls, registryItems, registryOutcomes, registryRatings } from '../database/schema';
import { newId, nowIso } from '../common/ids.util';
import { currentAccountId } from '../accounts/account-context';
import { unscoped } from '../accounts/scoped-db';
import { fetchPublic } from '../common/url-guard';
import { AgentsService, APP_CAPABILITIES, APP_FREE_CAPS } from '../agents/agents.service';
import { SkillsService } from '../skills/skills.service';
import { PortabilityService } from '../portability/portability.service';
import { parseSkillMd, renderSkillMd, scanSkillMd, type ParsedSkillMd, type ScanFlag, type ScanReport } from '../portability/skill-md';
import { scanAppHtml } from './app-scan';
import { BUILTIN_COMPANIES } from './builtin-companies.generated';
import { BlueprintError, validateBlueprint, type Blueprint } from '../org/blueprints/format';

export type RegistryKind = 'agent' | 'skill' | 'app' | 'company' | 'plugin' | 'kit';
/** Kinds published and installed through this service's generic routes. */
export const REGISTRY_KINDS: readonly RegistryKind[] = ['agent', 'skill', 'app', 'company'];
/** Package kinds (docs/foundry.md §9.1) listed here but published, installed
 *  and recalled through their own registry: `plugin` through
 *  PluginRegistryService (/api/workspaces/:ws/foundry/plugins); `kit` is
 *  reserved for the kit mechanism (Foundry F1) and nothing writes it yet. */
export const PACKAGE_KINDS: readonly RegistryKind[] = ['plugin', 'kit'];
const LISTED_KINDS: readonly RegistryKind[] = [...REGISTRY_KINDS, ...PACKAGE_KINDS];
/** Blueprint outcomes (docs/blueprints.md §4): the two measured milestones. */
export type OutcomeKind = 'first_key_result' | 'thirty_days_in_envelope';
export const OUTCOME_KINDS: readonly OutcomeKind[] = ['first_key_result', 'thirty_days_in_envelope'];

export type RegistryItemRow = typeof registryItems.$inferSelect;

/** What the install review shows, computed statically from the manifest. */
export interface CapabilitySummary {
  /** Tool names the charter, loop prompts and skill bodies mention. */
  tools: string[];
  /** Connections those tools imply: calendar | mail | drive. */
  connections: string[];
  loops: Array<{ name: string; cron?: string; trigger?: string; enabled: false }>;
  skills: Array<{ name: string; description: string }>;
  apps: Array<{ name: string; capabilities: string[] }>;
  /** For kind=app: the capabilities the app requests, split by tier. */
  appCapabilities?: { free: string[]; elevated: string[] };
  /** For kind=company (item 24): the staffing the blueprint describes. */
  company?: { roles: number; depth: number; monthlyUsd: number; playbooks: number; cadences: number; tunables: number; cards: string[] };
}

/** The public projection: what GET /api/registry/public serves and what the
 *  listing shows. Never carries lessons, tasks, a profile or the publisher's
 *  identity beyond the display name they chose. */
export interface RegistryListItem {
  id: string;
  kind: RegistryKind;
  slug: string;
  name: string;
  description: string;
  version: number;
  publisherName: string;
  capabilities: CapabilitySummary;
  scanReport: ScanReport;
  installs: number;
  ratingUp: number;
  ratingDown: number;
  publishedAt: string;
  updatedAt: string;
  /** `builtin`: a first-party starter shipped with the server (BUILTIN_PREFIX ids, no row). */
  source: 'local' | 'remote' | 'builtin';
  remoteUrl: string;
  /** Local only: this instance has installed it at least once. */
  installed?: boolean;
  /** First-party (a built-in starter): the listing badges it "Official" and sorts it first. */
  official?: boolean;
}

export interface RegistryItemDetail extends RegistryListItem {
  manifest: Record<string, unknown>;
}

export interface RegistryReview {
  kind: RegistryKind;
  name: string;
  version: number;
  publisherName: string;
  source: 'local' | 'remote' | 'builtin';
  capabilities: CapabilitySummary;
  loops: CapabilitySummary['loops'];
  tools: string[];
  connections: string[];
  scanReport: ScanReport;
  /** The real artifact (docs/permissions.md §4.2): full skill bodies, the
   *  charter, the app html — approving a paraphrase is not approving. */
  charter?: string;
  skillBodies: Array<{ name: string; description: string; instructions: string }>;
  appHtml?: string;
  /** kind=company: the validated blueprint itself (roles with charters, playbooks). */
  blueprint?: Blueprint;
  /** What the install will create, in words the card can show. */
  installs: string[];
}

export interface PublishInput {
  kind: RegistryKind;
  /** agent: the agent to export. skill: owner (ignored). app: the owner. */
  agentId?: string;
  skillId?: string;
  appId?: string;
  name?: string;
  description?: string;
  publisherName?: string;
  /** company: the exported COMPANY.json (OrgBlueprintsService.export) — the companies controller passes it. */
  manifest?: Record<string, unknown>;
  /** Scan and summarize, write nothing — the form shows this before confirm. */
  dryRun?: boolean;
}

export interface InstallOptions {
  /** Scope for skills: workspace-shared by default, agent-private with agentId. */
  workspaceId?: string;
  /** Required for apps (the agent that will own it); optional for skills. */
  agentId?: string;
  /** Agent install: override the agent name (avoids a conflict). */
  name?: string;
}

export interface InstallResult {
  ok: true;
  install: typeof registryInstalls.$inferSelect;
  agentId?: string;
  skillId?: string;
  appId?: string;
  /** Plain-language notes: what is parked, disabled or a draft. */
  notes: string[];
}

interface RemoteCache {
  fetchedAt: number;
  items: RegistryListItem[];
  error: string;
}

const REMOTE_TTL_MS = 10 * 60_000;
const REMOTE_PREFIX = 'remote:';
/** First-party starter blueprints (docs/blueprints.md §3a): served from the
 *  built-in catalog, never seeded into registry_items. */
export const BUILTIN_PREFIX = 'builtin:';
export const OFFICIAL_PUBLISHER = 'yaam';
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NAME_MAX = 60;
const DESC_MAX = 300;
const PUBLISHER_MAX = 60;
const MANIFEST_MAX = 2_000_000;
const PUBLIC_LIST_MAX = 500;

/** Our tool vocabulary as it appears in prose; anything matched is listed on
 *  the review so the user sees what the artifact expects to be able to do. */
const TOOL_RE = /\b(fs_(?:list|read|write|delete|search)|web_(?:search|fetch)|http_request|run_(?:js|python)|browser_(?:open|act|read|screenshot)|slides_create|save_app|save_tool|delegate_task|update_dashboard|list_tasks|add_task|update_task|draft_skill|revise_skill|update_user_profile|search_history|(?:calendar|gmail|mail|drive|onedrive)_[a-z0-9_]+|skill_[a-z0-9_]+|mcp_[a-z0-9_]+|tool_[a-z0-9_]+)\b/g;

export function slugify(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'item';
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function emptyScan(): ScanReport {
  return { bytes: 0, lines: 0, urls: [], flags: [], ok: true, scannedAt: nowIso() };
}

/** Scan prose that is not a SKILL.md (a charter, a loop prompt, a skill body
 *  inside an AGENT.json) with the SKILL.md rules. */
function scanText(text: string, name: string, allowedTools: string[] = []): ScanReport {
  const parsed: ParsedSkillMd = { name, description: '', allowedTools, metadata: {}, body: text };
  return scanSkillMd(text, parsed);
}

function mergeScans(parts: Array<[string, ScanReport]>): ScanReport {
  const flags: ScanFlag[] = [];
  const urls = new Set<string>();
  let bytes = 0;
  let lines = 0;
  for (const [label, r] of parts) {
    bytes += r.bytes;
    lines += r.lines;
    r.urls.forEach((u) => urls.add(u));
    for (const f of r.flags) flags.push({ ...f, detail: label ? `${label}: ${f.detail}` : f.detail });
  }
  return { bytes, lines, urls: [...urls].slice(0, 50), flags, ok: flags.every((f) => f.severity !== 'block'), scannedAt: nowIso() };
}

function toolsIn(texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(TOOL_RE)) found.add(m[1]);
  return [...found].sort();
}

function connectionsFor(tools: string[], texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of tools) {
    if (t.startsWith('calendar_')) out.add('calendar');
    if (t.startsWith('gmail_') || t.startsWith('mail_')) out.add('mail');
    if (t.startsWith('drive_') || t.startsWith('onedrive_')) out.add('drive');
  }
  const blob = texts.join('\n');
  if (/\b(google calendar|outlook calendar|my calendar)\b/i.test(blob)) out.add('calendar');
  if (/\b(gmail|outlook mail|my inbox|my email)\b/i.test(blob)) out.add('mail');
  if (/\b(google drive|onedrive)\b/i.test(blob)) out.add('drive');
  return [...out].sort();
}

/** The normalized manifest for each kind, plus its scan and summary. Shared
 *  by publish (local objects), the push endpoint (a stranger's manifest) and
 *  remote install (a manifest we just downloaded) — one rule set, three doors. */
export function normalizeManifest(kind: RegistryKind, raw: Record<string, unknown>): { manifest: Record<string, unknown>; capabilities: CapabilitySummary; scan: ScanReport; name: string; description: string } {
  const fail = (msg: string): never => { throw new BadRequestException(`invalid ${kind} manifest: ${msg}`); };
  if (!raw || typeof raw !== 'object') fail('not an object');
  if (JSON.stringify(raw).length > MANIFEST_MAX) fail('exceeds 2 MB');

  if (kind === 'skill') {
    const md = typeof raw.skillMd === 'string' ? raw.skillMd : '';
    if (!md.trim()) fail('skillMd (a SKILL.md text) is required');
    let parsed: ParsedSkillMd;
    try { parsed = parseSkillMd(md); } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
    const scan = scanSkillMd(md, parsed);
    const tools = toolsIn([parsed.body]);
    return {
      manifest: { skillMd: md },
      name: parsed.name,
      description: parsed.description.slice(0, DESC_MAX),
      capabilities: { tools: [...new Set([...tools, ...parsed.allowedTools])].sort(), connections: connectionsFor(tools, [parsed.body]), loops: [], skills: [{ name: parsed.name, description: parsed.description }], apps: [] },
      scan,
    };
  }

  if (kind === 'company') {
    // A company blueprint (docs/blueprints.md): strict shape, then every text
    // — each role's charter, each playbook — through the SKILL.md scan.
    let bp: Blueprint;
    try { bp = validateBlueprint(raw); } catch (err) { return err instanceof BlueprintError ? fail(err.message) : fail(err instanceof Error ? err.message : String(err)); }
    const scan = mergeScans([
      ...bp.roles.map((r): [string, ScanReport] => [`role "${r.title}"`, scanText(r.charter, slugify(r.title))]),
      ...bp.playbooks.map((p): [string, ScanReport] => {
        try { const parsed = parseSkillMd(p.skillMd); return [`playbook "${p.name}"`, scanSkillMd(p.skillMd, parsed)]; }
        catch (err) { return [`playbook "${p.name}"`, { ...emptyScan(), ok: false, flags: [{ kind: 'size', severity: 'block', detail: `not a SKILL.md: ${err instanceof Error ? err.message : String(err)}` }] }]; }
      }),
    ]);
    const scopeTools = bp.roles.flatMap((r) => r.scopes.filter((x) => x.startsWith('tool:')).map((x) => x.slice(5)));
    const scopeConnections = bp.roles.flatMap((r) => r.scopes.filter((x) => x.startsWith('connection:')).map((x) => x.split(':')[1]));
    const texts = [...bp.roles.map((r) => r.charter), ...bp.playbooks.map((p) => p.skillMd)];
    const tools = [...new Set([...toolsIn(texts), ...scopeTools])].sort();
    const depth = Math.max(...bp.roles.map((r) => { let d = 1; let cur = r; while (cur.reportsTo) { d++; cur = bp.roles.find((x) => x.title.toLowerCase() === cur.reportsTo!.toLowerCase())!; } return d; }));
    return {
      manifest: bp as unknown as Record<string, unknown>,
      name: bp.name.slice(0, NAME_MAX),
      description: bp.description.slice(0, DESC_MAX),
      capabilities: {
        tools, connections: [...new Set([...connectionsFor(tools, texts), ...scopeConnections])].sort(), loops: [],
        skills: bp.playbooks.map((p) => { try { const x = parseSkillMd(p.skillMd); return { name: x.name, description: x.description }; } catch { return { name: p.name, description: '' }; } }),
        apps: [],
        company: { roles: bp.roles.length, depth, monthlyUsd: bp.budget.monthlyUsd, playbooks: bp.playbooks.length, cadences: bp.cadences?.length ?? 0, tunables: Object.keys(bp.tunables).length, cards: bp.cards ?? [] },
      },
      scan,
    };
  }

  if (kind === 'app') {
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
    if (!name) fail('name is required');
    const html = typeof raw.html === 'string' ? raw.html : '';
    if (!html.trim()) fail('html is required');
    const caps = Array.isArray(raw.capabilities) ? [...new Set(raw.capabilities.filter((c): c is string => typeof c === 'string'))] : [];
    const scan = scanAppHtml({ html, capabilities: caps });
    const known = caps.filter((c) => (APP_CAPABILITIES as readonly string[]).includes(c));
    const description = typeof raw.description === 'string' ? raw.description.slice(0, DESC_MAX) : '';
    return {
      manifest: { name, description, html, capabilities: caps },
      name,
      description,
      capabilities: {
        tools: [], connections: known.includes('connections') ? ['calendar', 'mail'] : [], loops: [], skills: [],
        apps: [{ name, capabilities: caps }],
        appCapabilities: { free: known.filter((c) => APP_FREE_CAPS.has(c)), elevated: known.filter((c) => !APP_FREE_CAPS.has(c)) },
      },
      scan,
    };
  }

  // kind === 'agent': AGENT.json v2 core. Lessons, tasks and profile are
  // dropped whatever the input says — a registry item is the agent's
  // design, not one user's history.
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, NAME_MAX) : '';
  if (!name) fail('name is required');
  const charter = typeof raw.charter === 'string' ? raw.charter.slice(0, 20_000) : '';
  const rawLoops = Array.isArray(raw.loops) ? raw.loops.slice(0, 10) : [];
  const loops: Array<Record<string, unknown> & { enabled: false }> = rawLoops
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object' && typeof (l as Record<string, unknown>).name === 'string')
    .map((l) => ({ ...l, enabled: false as const }));
  const skills = (Array.isArray(raw.skills) ? raw.skills.slice(0, 40) : [])
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && typeof (s as Record<string, unknown>).name === 'string' && typeof (s as Record<string, unknown>).instructions === 'string')
    .map((s) => ({
      name: (s.name as string).toLowerCase().slice(0, 64),
      description: typeof s.description === 'string' ? s.description.slice(0, DESC_MAX) : '',
      instructions: (s.instructions as string).slice(0, 20_000),
      enabled: s.enabled === 0 || s.enabled === false ? 0 : 1,
      draft: s.draft === 1 || s.draft === true ? 1 : 0,
    }));
  const apps = (Array.isArray(raw.apps) ? raw.apps.slice(0, 12) : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).name === 'string' && typeof (a as Record<string, unknown>).html === 'string')
    .map((a) => ({
      name: (a.name as string).slice(0, NAME_MAX),
      description: typeof a.description === 'string' ? a.description.slice(0, DESC_MAX) : '',
      html: a.html as string,
      capabilities: Array.isArray(a.capabilities) ? a.capabilities.filter((c): c is string => typeof c === 'string') : [],
    }));
  const manifest: Record<string, unknown> = {
    formatVersion: 2,
    name,
    emoji: typeof raw.emoji === 'string' ? raw.emoji.slice(0, 8) : undefined,
    colors: raw.colors,
    role: typeof raw.role === 'string' ? raw.role.slice(0, 80) : '',
    charter,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    loops,
    dashboard: typeof raw.dashboard === 'string' ? raw.dashboard.slice(0, 50_000) : '',
    apps,
    skills,
  };
  const loopPrompts = loops.map((l) => (typeof l.prompt === 'string' ? l.prompt : ''));
  const texts = [charter, ...loopPrompts, ...skills.map((s) => s.instructions)];
  const scan = mergeScans([
    ['charter', scanText(charter, slugify(name))],
    ...loops.map((l, i): [string, ScanReport] => [`loop "${l.name as string}"`, scanText(loopPrompts[i], 'loop')]),
    ...skills.map((s): [string, ScanReport] => [`skill "${s.name}"`, scanText(s.instructions, s.name)]),
    ...apps.map((a): [string, ScanReport] => [`app "${a.name}"`, scanAppHtml({ html: a.html, capabilities: a.capabilities })]),
  ]);
  const tools = toolsIn(texts);
  return {
    manifest,
    name,
    description: typeof raw.description === 'string' ? raw.description.slice(0, DESC_MAX) : (manifest.role as string),
    capabilities: {
      tools,
      connections: connectionsFor(tools, texts),
      loops: loops.map((l) => ({
        name: l.name as string,
        ...(typeof l.cron === 'string' ? { cron: l.cron } : {}),
        ...(l.trigger && typeof l.trigger === 'object' && typeof (l.trigger as Record<string, unknown>).kind === 'string' ? { trigger: (l.trigger as Record<string, unknown>).kind as string } : {}),
        enabled: false as const,
      })),
      skills: skills.map((s) => ({ name: s.name, description: s.description })),
      apps: apps.map((a) => ({ name: a.name, capabilities: a.capabilities })),
    },
    scan,
  };
}

/** The first-party starter blueprints as registry items (docs/blueprints.md
 *  §3a, docs/foundry.md §10.2): COMPANY.json v1 documents in
 *  blueprints/first-party/, embedded at build time. Each goes through the
 *  same normalizeManifest('company') as a publish — validateBlueprint and the
 *  scan — once per process; an invalid one is a build error the test catches,
 *  and here it is left out rather than taking the listing down. */
let builtinCache: Array<{ item: RegistryListItem; manifest: Record<string, unknown> }> | null = null;
export function builtinCompanies(): Array<{ item: RegistryListItem; manifest: Record<string, unknown> }> {
  if (builtinCache) return builtinCache;
  const out: Array<{ item: RegistryListItem; manifest: Record<string, unknown> }> = [];
  for (const b of BUILTIN_COMPANIES) {
    let norm: ReturnType<typeof normalizeManifest>;
    try { norm = normalizeManifest('company', b.manifest); } catch { continue; }
    const at = (b.manifest.origin as { at?: string } | undefined)?.at ?? '';
    out.push({
      manifest: norm.manifest,
      item: {
        id: `${BUILTIN_PREFIX}${b.slug}`, kind: 'company', slug: b.slug, name: norm.name, description: norm.description, version: 1,
        publisherName: OFFICIAL_PUBLISHER, capabilities: norm.capabilities, scanReport: norm.scan, installs: 0, ratingUp: 0, ratingDown: 0,
        publishedAt: at, updatedAt: at, source: 'builtin', remoteUrl: '', official: true,
      },
    });
  }
  builtinCache = out;
  return out;
}

@Injectable()
export class RegistryService {
  /** Test seam: swap the outbound fetch (the SSRF guard still runs). */
  fetchFn: typeof fetch = fetch;
  private remote: RemoteCache | null = null;
  private cfg: { registryUrl: string; registryPublishToken: string };

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: DrizzleDb,
    private readonly agents: AgentsService,
    private readonly skills: SkillsService,
    private readonly portability: PortabilityService,
    @Optional() @Inject(ConfigService) config?: ConfigService,
  ) {
    this.cfg = {
      registryUrl: (config?.get<string>('registryUrl') ?? '').replace(/\/+$/, ''),
      registryPublishToken: config?.get<string>('registryPublishToken') ?? '',
    };
  }

  /** Tests and the status endpoint; also lets a test point at a fake remote. */
  configure(patch: Partial<{ registryUrl: string; registryPublishToken: string }>): void {
    this.cfg = { ...this.cfg, ...patch, registryUrl: (patch.registryUrl ?? this.cfg.registryUrl).replace(/\/+$/, '') };
    this.remote = null;
  }

  status() {
    return {
      remoteUrl: this.cfg.registryUrl,
      publishToken: Boolean(this.cfg.registryPublishToken),
      remote: this.remote ? { fetchedAt: new Date(this.remote.fetchedAt).toISOString(), items: this.remote.items.length, error: this.remote.error } : null,
    };
  }

  // ---- publish ----

  async publish(input: PublishInput) {
    if (!REGISTRY_KINDS.includes(input.kind)) throw new BadRequestException(`kind must be one of ${REGISTRY_KINDS.join(', ')}`);
    const publisherName = (input.publisherName ?? '').trim().slice(0, PUBLISHER_MAX);
    let raw: Record<string, unknown>;
    let sourceRef: string;
    if (input.kind === 'agent') {
      if (!input.agentId) throw new BadRequestException('agentId is required');
      // exportAgent never includes the profile unless asked; lessons and
      // tasks are dropped by normalizeManifest.
      raw = await this.portability.exportAgent(input.agentId);
      sourceRef = input.agentId;
    } else if (input.kind === 'skill') {
      if (!input.skillId) throw new BadRequestException('skillId is required');
      const s = await this.skills.get(input.skillId);
      if (s.draft === 1) throw new BadRequestException('approve the draft before publishing it');
      raw = { skillMd: renderSkillMd({ name: s.name, description: s.description, instructions: s.instructions, proposedBy: s.proposedBy, createdAt: s.createdAt }) };
      sourceRef = input.skillId;
    } else if (input.kind === 'company') {
      // The blueprint is exported by OrgBlueprintsService (data only: no
      // connections, memory, tokens or files can be in it by construction).
      if (!input.manifest || typeof input.manifest !== 'object') throw new BadRequestException('manifest (a COMPANY.json) is required');
      raw = input.manifest;
      sourceRef = typeof (raw.origin as Record<string, unknown> | undefined)?.sourceOrgId === 'string' ? String((raw.origin as Record<string, unknown>).sourceOrgId) : '';
    } else {
      if (!input.agentId || !input.appId) throw new BadRequestException('agentId and appId are required');
      const app = (await this.agents.listApps(input.agentId)).find((a) => a.id === input.appId);
      if (!app) throw new NotFoundException(`app ${input.appId}`);
      raw = { name: app.name, description: app.description, html: app.html, capabilities: app.capabilities ?? [] };
      sourceRef = input.appId;
    }
    const norm = normalizeManifest(input.kind, raw);
    const name = (input.name ?? '').trim().slice(0, NAME_MAX) || norm.name;
    const description = (input.description ?? '').trim().slice(0, DESC_MAX) || norm.description;
    if (input.kind !== 'skill') norm.manifest.name = name;
    if (input.kind === 'company' && description) norm.manifest.description = description;
    const slug = input.kind === 'skill' ? norm.name : slugify(name);
    const preview = { kind: input.kind, slug, name, description, publisherName, capabilities: norm.capabilities, scanReport: norm.scan };
    if (!norm.scan.ok) {
      throw new BadRequestException(`publish refused: ${norm.scan.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}`);
    }
    if (input.dryRun) return { dryRun: true as const, ...preview };

    const item = await this.upsert({ ...preview, manifest: norm.manifest, source: 'local', remoteUrl: '', sourceRef });
    const pushed = await this.pushToRemote(item);
    return { dryRun: false as const, item: this.project(item), pushed };
  }

  /** Insert or re-publish: same (kind, slug) → version+1, manifest and scan
   *  replaced, installs and ratings kept. */
  private async upsert(input: { kind: RegistryKind; slug: string; name: string; description: string; publisherName: string; capabilities: CapabilitySummary; scanReport: ScanReport; manifest: Record<string, unknown>; source: 'local' | 'remote'; remoteUrl: string; sourceRef: string }): Promise<RegistryItemRow> {
    const existing = (await this.db.select().from(registryItems)
      .where(and(eq(registryItems.kind, input.kind), eq(registryItems.slug, input.slug))).limit(1))[0];
    const now = nowIso();
    if (existing) {
      await this.db.update(registryItems).set({
        name: input.name,
        description: input.description,
        version: existing.version + 1,
        publisherName: input.publisherName || existing.publisherName,
        manifest: JSON.stringify(input.manifest),
        capabilities: JSON.stringify(input.capabilities),
        scanReport: JSON.stringify(input.scanReport),
        published: 1,
        sourceRef: input.sourceRef || existing.sourceRef,
        updatedAt: now,
      }).where(eq(registryItems.id, existing.id));
      return this.row(existing.id);
    }
    const row: RegistryItemRow = {
      id: newId(),
      accountId: currentAccountId(),
      kind: input.kind,
      slug: input.slug,
      name: input.name,
      description: input.description,
      version: 1,
      publisherName: input.publisherName,
      manifest: JSON.stringify(input.manifest),
      capabilities: JSON.stringify(input.capabilities),
      scanReport: JSON.stringify(input.scanReport),
      installs: 0,
      ratingUp: 0,
      ratingDown: 0,
      published: 1,
      source: input.source,
      remoteUrl: input.remoteUrl,
      sourceRef: input.sourceRef,
      publishedAt: now,
      updatedAt: now,
    };
    await this.db.insert(registryItems).values(row);
    return row;
  }

  /** With REGISTRY_URL + REGISTRY_PUBLISH_TOKEN, mirror the item upstream. */
  private async pushToRemote(item: RegistryItemRow): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
    if (!this.cfg.registryUrl || !this.cfg.registryPublishToken) return { attempted: false, ok: false };
    try {
      const res = await fetchPublic(`${this.cfg.registryUrl}/api/registry/public`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.registryPublishToken}` },
        body: JSON.stringify({ kind: item.kind, slug: item.slug, name: item.name, description: item.description, publisherName: item.publisherName, manifest: JSON.parse(item.manifest) }),
        signal: AbortSignal.timeout(15_000),
      }, this.fetchFn);
      if (!res.ok) return { attempted: true, ok: false, error: `${res.status} ${(await res.text()).slice(0, 200)}` };
      this.remote = null; // the upstream listing changed
      return { attempted: true, ok: true };
    } catch (err) {
      return { attempted: true, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** The remote side of pushToRemote: `POST /api/registry/public` with the
   *  publish token. The manifest goes through the same normalize + scan as a
   *  local publish — the token proves the sender may list here, not that the
   *  content is clean. */
  async acceptRemotePublish(body: Record<string, unknown>, authorization: string | undefined) {
    const token = this.cfg.registryPublishToken;
    const presented = (authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) throw new ForbiddenException('this registry does not accept remote publishes (REGISTRY_PUBLISH_TOKEN is not set)');
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException('invalid publish token');
    const kind = body.kind as RegistryKind;
    if (!REGISTRY_KINDS.includes(kind)) throw new BadRequestException(`kind must be one of ${REGISTRY_KINDS.join(', ')}`);
    if (!body.manifest || typeof body.manifest !== 'object') throw new BadRequestException('manifest is required');
    const norm = normalizeManifest(kind, body.manifest as Record<string, unknown>);
    if (!norm.scan.ok) {
      throw new BadRequestException(`publish refused: ${norm.scan.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}`);
    }
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, NAME_MAX) : norm.name;
    const slug = kind === 'skill' ? norm.name : (typeof body.slug === 'string' && SLUG_RE.test(body.slug) ? body.slug.slice(0, 60) : slugify(name));
    if (kind !== 'skill') norm.manifest.name = name;
    const item = await this.upsert({
      kind, slug, name,
      description: typeof body.description === 'string' ? body.description.slice(0, DESC_MAX) : norm.description,
      publisherName: typeof body.publisherName === 'string' ? body.publisherName.slice(0, PUBLISHER_MAX) : '',
      capabilities: norm.capabilities, scanReport: norm.scan, manifest: norm.manifest,
      source: 'local', remoteUrl: '', sourceRef: '',
    });
    return this.project(item);
  }

  // ---- browse ----

  async list(filter: { kind?: string; q?: string } = {}) {
    const rows = await this.db.select().from(registryItems).where(eq(registryItems.published, 1)).orderBy(desc(registryItems.updatedAt));
    const installedIds = new Set((await this.db.select({ itemId: registryInstalls.itemId }).from(registryInstalls)).map((r) => r.itemId));
    const local = rows.map((r) => ({ ...this.project(r), installed: installedIds.has(r.id) }));
    const remote = await this.remoteItems();
    const localSlugs = new Set(local.map((i) => `${i.kind}/${i.slug}`));
    // A remote copy of something published here is the same thing; show ours.
    const merged = [...local, ...remote.items.filter((i) => !localSlugs.has(`${i.kind}/${i.slug}`)).map((i) => ({ ...i, installed: installedIds.has(i.id) }))];
    const kind = filter.kind && LISTED_KINDS.includes(filter.kind as RegistryKind) ? filter.kind : '';
    // The first-party starters join a company listing (only: the community
    // view lists what people published), first, with their install counts here.
    if (kind === 'company') {
      const builtinIds = builtinCompanies().map((b) => b.item.id);
      const counts = new Map<string, number>();
      if (builtinIds.length) for (const r of await this.db.select({ itemId: registryInstalls.itemId }).from(registryInstalls).where(inArray(registryInstalls.itemId, builtinIds))) counts.set(r.itemId, (counts.get(r.itemId) ?? 0) + 1);
      merged.unshift(...builtinCompanies().map((b) => ({ ...b.item, installs: counts.get(b.item.id) ?? 0, installed: counts.has(b.item.id) })));
    }
    const q = (filter.q ?? '').trim().toLowerCase();
    const items = merged.filter((i) => (!kind || i.kind === kind) && (!q || `${i.name} ${i.description} ${i.publisherName} ${i.slug}${i.official ? ' official first-party' : ''}`.toLowerCase().includes(q)));
    return { items, remote: { url: this.cfg.registryUrl, ok: !!this.cfg.registryUrl && !remote.error, error: remote.error, fetchedAt: remote.fetchedAt ? new Date(remote.fetchedAt).toISOString() : null } };
  }

  async get(id: string): Promise<RegistryItemDetail> {
    if (id.startsWith(REMOTE_PREFIX)) return this.remoteDetail(id.slice(REMOTE_PREFIX.length));
    if (id.startsWith(BUILTIN_PREFIX)) {
      const b = builtinCompanies().find((x) => x.item.id === id);
      if (!b) throw new NotFoundException(`registry item ${id}`);
      const installs = (await this.db.select({ id: registryInstalls.id }).from(registryInstalls).where(eq(registryInstalls.itemId, id))).length;
      return { ...b.item, installs, installed: installs > 0, manifest: b.manifest };
    }
    const row = await this.row(id);
    return { ...this.project(row), manifest: parseJson(row.manifest, {}) };
  }

  /** The public feed (no auth): published local items, projection only.
   *  Unscoped on purpose: the feed is the deployment's, across every account
   *  that published to it (docs/accounts.md §3); no account is bound on these
   *  anonymous routes anyway. */
  async listPublic(): Promise<RegistryListItem[]> {
    const rows = await unscoped(this.db).select().from(registryItems)
      .where(and(eq(registryItems.published, 1), eq(registryItems.source, 'local')))
      .orderBy(desc(registryItems.updatedAt)).limit(PUBLIC_LIST_MAX);
    return rows.map((r) => this.project(r));
  }

  async getPublic(id: string): Promise<RegistryItemDetail> {
    const row = await this.publicRow(id);
    if (row.published !== 1) throw new NotFoundException(`registry item ${id}`);
    return { ...this.project(row), manifest: parseJson(row.manifest, {}) };
  }

  /** Anonymous counters from other instances (install / rate on the feed). */
  async bumpPublicInstall(id: string) {
    const row = await this.publicRow(id);
    await unscoped(this.db).update(registryItems).set({ installs: sql`${registryItems.installs} + 1` }).where(eq(registryItems.id, row.id));
    return { ok: true, installs: row.installs + 1 };
  }

  /** A published item by id across accounts, for the anonymous feed routes. */
  private async publicRow(id: string): Promise<RegistryItemRow> {
    const rows = await unscoped(this.db).select().from(registryItems).where(and(eq(registryItems.id, id), eq(registryItems.source, 'local'))).limit(1);
    if (!rows[0]) throw new NotFoundException(`registry item ${id}`);
    return rows[0];
  }

  private project(r: RegistryItemRow): RegistryListItem {
    return {
      id: r.id,
      kind: r.kind as RegistryKind,
      slug: r.slug,
      name: r.name,
      description: r.description,
      version: r.version,
      publisherName: r.publisherName,
      capabilities: parseJson<CapabilitySummary>(r.capabilities, { tools: [], connections: [], loops: [], skills: [], apps: [] }),
      scanReport: parseJson<ScanReport>(r.scanReport, emptyScan()),
      installs: r.installs,
      ratingUp: r.ratingUp,
      ratingDown: r.ratingDown,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
      source: r.source as 'local' | 'remote',
      remoteUrl: r.remoteUrl,
    };
  }

  private async row(id: string): Promise<RegistryItemRow> {
    const rows = await this.db.select().from(registryItems).where(eq(registryItems.id, id)).limit(1);
    if (!rows[0]) throw new NotFoundException(`registry item ${id}`);
    return rows[0];
  }

  // ---- remote ----

  private async remoteItems(): Promise<RemoteCache> {
    if (!this.cfg.registryUrl) return { fetchedAt: 0, items: [], error: '' };
    if (this.remote && Date.now() - this.remote.fetchedAt < REMOTE_TTL_MS) return this.remote;
    try {
      const res = await fetchPublic(`${this.cfg.registryUrl}/api/registry/public`, { signal: AbortSignal.timeout(10_000) }, this.fetchFn);
      if (!res.ok) throw new Error(`remote registry answered ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error('remote registry returned a non-list');
      const items = body.slice(0, PUBLIC_LIST_MAX).map((raw) => this.fromRemote(raw as Record<string, unknown>)).filter((i): i is RegistryListItem => i !== null);
      this.remote = { fetchedAt: Date.now(), items, error: '' };
    } catch (err) {
      this.remote = { fetchedAt: Date.now(), items: [], error: err instanceof Error ? err.message : String(err) };
    }
    return this.remote;
  }

  /** Re-validate every field: the remote feed is data, not trusted rows. */
  private fromRemote(raw: Record<string, unknown>): RegistryListItem | null {
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return null;
    if (!LISTED_KINDS.includes(raw.kind as RegistryKind)) return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const scan = raw.scanReport && typeof raw.scanReport === 'object' ? (raw.scanReport as ScanReport) : emptyScan();
    const caps = raw.capabilities && typeof raw.capabilities === 'object' ? (raw.capabilities as CapabilitySummary) : { tools: [], connections: [], loops: [], skills: [], apps: [] };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
    return {
      id: REMOTE_PREFIX + raw.id,
      kind: raw.kind as RegistryKind,
      slug: SLUG_RE.test(str(raw.slug, 60)) ? str(raw.slug, 60) : slugify(raw.name),
      name: raw.name.slice(0, NAME_MAX),
      description: str(raw.description, DESC_MAX),
      version: num(raw.version) || 1,
      publisherName: str(raw.publisherName, PUBLISHER_MAX),
      capabilities: {
        tools: Array.isArray(caps.tools) ? caps.tools.filter((t): t is string => typeof t === 'string').slice(0, 50) : [],
        connections: Array.isArray(caps.connections) ? caps.connections.filter((t): t is string => typeof t === 'string').slice(0, 10) : [],
        loops: Array.isArray(caps.loops) ? caps.loops.slice(0, 10).map((l) => ({ ...l, enabled: false as const })) : [],
        skills: Array.isArray(caps.skills) ? caps.skills.slice(0, 40) : [],
        apps: Array.isArray(caps.apps) ? caps.apps.slice(0, 12) : [],
        ...(caps.appCapabilities ? { appCapabilities: caps.appCapabilities } : {}),
      },
      scanReport: { ...emptyScan(), ...scan, flags: Array.isArray(scan.flags) ? scan.flags.slice(0, 50) : [], urls: Array.isArray(scan.urls) ? scan.urls.slice(0, 50) : [] },
      installs: num(raw.installs),
      ratingUp: num(raw.ratingUp),
      ratingDown: num(raw.ratingDown),
      publishedAt: str(raw.publishedAt, 40),
      updatedAt: str(raw.updatedAt, 40),
      source: 'remote',
      remoteUrl: this.cfg.registryUrl,
    };
  }

  private async remoteDetail(remoteId: string): Promise<RegistryItemDetail> {
    if (!this.cfg.registryUrl) throw new NotFoundException('no remote registry is configured');
    const listed = (await this.remoteItems()).items.find((i) => i.id === REMOTE_PREFIX + remoteId);
    let res: Response;
    try {
      res = await fetchPublic(`${this.cfg.registryUrl}/api/registry/public/${encodeURIComponent(remoteId)}`, { signal: AbortSignal.timeout(15_000) }, this.fetchFn);
    } catch (err) {
      throw new BadRequestException(`could not reach the remote registry: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) throw new NotFoundException(`registry item ${REMOTE_PREFIX}${remoteId}`);
    if (!res.ok) throw new BadRequestException(`remote registry answered ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    const item = this.fromRemote(raw) ?? listed;
    if (!item) throw new NotFoundException(`registry item ${REMOTE_PREFIX}${remoteId}`);
    const manifest = raw.manifest && typeof raw.manifest === 'object' ? (raw.manifest as Record<string, unknown>) : {};
    return { ...item, manifest };
  }

  private async notifyRemote(remoteId: string, path: 'installed' | 'rate' | 'outcome', body?: unknown): Promise<void> {
    if (!this.cfg.registryUrl) return;
    try {
      await fetchPublic(`${this.cfg.registryUrl}/api/registry/public/${encodeURIComponent(remoteId)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(10_000),
      }, this.fetchFn);
    } catch { /* counters are best-effort */ }
  }

  // ---- review + install ----

  /** The review: everything the user must see before confirming. For a
   *  remote item the manifest is fetched and re-scanned here — the remote's
   *  report is shown for comparison, ours is the one that gates. */
  async review(id: string): Promise<{ item: RegistryListItem; review: RegistryReview; manifest: Record<string, unknown> }> {
    const detail = await this.get(id);
    if (PACKAGE_KINDS.includes(detail.kind)) {
      throw new BadRequestException(detail.kind === 'plugin'
        ? 'a plugin installs through Foundry › Plugins (POST /api/workspaces/:ws/plugins/install with source.registry), behind the plugin review'
        : 'kits are not installable yet (Foundry F1)');
    }
    const norm = normalizeManifest(detail.kind, detail.manifest);
    const m = norm.manifest;
    const skillBodies = detail.kind === 'skill'
      ? [{ name: norm.name, description: norm.description, instructions: parseSkillMd(m.skillMd as string).body }]
      : detail.kind === 'agent'
        ? (m.skills as Array<{ name: string; description: string; instructions: string }>).map((s) => ({ name: s.name, description: s.description, instructions: s.instructions }))
        : detail.kind === 'company'
          ? (m as unknown as Blueprint).playbooks.map((p) => { const x = parseSkillMd(p.skillMd); return { name: x.name, description: x.description, instructions: x.body }; })
          : [];
    const installs: string[] = [];
    if (detail.kind === 'company') {
      const bp = m as unknown as Blueprint;
      const c = norm.capabilities.company!;
      installs.push(`an organization "${detail.name}" in the mode you pick, with ${c.roles} agent(s) staffed by role (one approval card for the whole plan in supervised mode)`);
      installs.push('each agent gets its charter and the scopes you hold as chief or less (the meet rule); no connection, memory, lesson, token or file is created or copied');
      if (bp.vision) installs.push(`the vision "${bp.vision.title}" and the operating profile (values, culture, rules)`);
      if (c.tunables) installs.push(`${c.tunables} tunable(s), each clamped to its bound`);
      if (c.playbooks) installs.push(`${c.playbooks} playbook(s) as skill drafts awaiting your approval`);
      if (c.cards.length) installs.push(`recommended connection cards (nothing is granted): ${c.cards.join(', ')}`);
    } else if (detail.kind === 'agent') {
      installs.push(`a new agent "${detail.name}" with its charter and dashboard`);
      if (norm.capabilities.loops.length) installs.push(`${norm.capabilities.loops.length} loop(s), all disabled — enable each one on its Schedule tab`);
      if (skillBodies.length) installs.push(`${skillBodies.length} private skill(s) as drafts awaiting your approval`);
      if (norm.capabilities.apps.length) installs.push(`${norm.capabilities.apps.length} mini app(s); elevated capabilities parked until you review them`);
    } else if (detail.kind === 'skill') {
      installs.push(`one skill draft "/${norm.name}" — not callable until you approve it`);
    } else {
      installs.push(`one mini app "${detail.name}" on the agent you pick`);
      const elevated = norm.capabilities.appCapabilities?.elevated ?? [];
      if (elevated.length) installs.push(`elevated capabilities parked: ${elevated.join(', ')}`);
    }
    const scan = detail.source === 'remote' ? norm.scan : detail.scanReport;
    return {
      item: { ...detail, manifest: undefined } as unknown as RegistryListItem,
      manifest: m,
      review: {
        kind: detail.kind,
        name: detail.name,
        version: detail.version,
        publisherName: detail.publisherName,
        source: detail.source,
        capabilities: norm.capabilities,
        loops: norm.capabilities.loops,
        tools: norm.capabilities.tools,
        connections: norm.capabilities.connections,
        scanReport: scan,
        ...(detail.kind === 'agent' ? { charter: m.charter as string } : {}),
        skillBodies,
        ...(detail.kind === 'app' ? { appHtml: m.html as string } : {}),
        ...(detail.kind === 'company' ? { blueprint: m as unknown as Blueprint } : {}),
        installs,
      },
    };
  }

  /**
   * The mandatory gate. Without `confirm === true` the answer is the review
   * and nothing is written; with it, the manifest is re-scanned (a blocking
   * flag refuses even a confirmed install) and imported inert.
   */
  async install(id: string, body: { confirm?: unknown; options?: InstallOptions } = {}): Promise<{ requiresConfirm: true; review: RegistryReview } | InstallResult> {
    const { review, manifest } = await this.review(id);
    if (body.confirm !== true) return { requiresConfirm: true, review };
    if (review.kind === 'company') throw new BadRequestException('a company blueprint installs through POST /api/market/companies/:id/install (it needs a workspace, a mode and a budget)');
    if (!review.scanReport.ok) {
      throw new BadRequestException(`install refused: ${review.scanReport.flags.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ')}`);
    }
    const opts = body.options ?? {};
    const notes: string[] = [];
    const created: { agentId?: string; skillId?: string; appId?: string } = {};
    const publisher = review.publisherName || 'registry';

    if (review.kind === 'agent') {
      const taken = new Set((await this.agents.list()).map((a) => a.name));
      let name = (opts.name ?? '').trim().slice(0, NAME_MAX) || (manifest.name as string);
      if (taken.has(name)) {
        const base = name;
        for (let n = 2; taken.has(name); n++) name = `${base.slice(0, NAME_MAX - 4)} (${n})`.slice(0, NAME_MAX);
        notes.push(`named "${name}" because "${base}" already exists`);
      }
      const res = await this.portability.importAgent({ ...manifest, name }, { lessons: false, tasks: false, profile: false, skills: true, workspaceId: opts.workspaceId });
      created.agentId = res.agent.id;
      if (review.loops.length) notes.push(`${review.loops.length} loop(s) installed disabled`);
      if (res.summary.skills.added) notes.push(`${res.summary.skills.added} skill(s) installed as drafts`);
      const parked = review.capabilities.apps.flatMap((a) => a.capabilities.filter((c) => !APP_FREE_CAPS.has(c)));
      if (parked.length) notes.push(`app capabilities parked: ${[...new Set(parked)].join(', ')}`);
    } else if (review.kind === 'skill') {
      const { skill } = await this.skills.importSkillMd({ content: manifest.skillMd as string, workspaceId: opts.workspaceId, agentId: opts.agentId, proposedBy: `registry: ${publisher}` });
      created.skillId = skill.id;
      notes.push(`skill "/${skill.name}" installed as a draft`);
    } else {
      if (!opts.agentId) throw new BadRequestException('options.agentId is required: pick the agent that will own the app');
      await this.agents.get(opts.agentId);
      const caps = (manifest.capabilities as string[]).filter((c) => (APP_CAPABILITIES as readonly string[]).includes(c));
      await this.agents.saveApp(opts.agentId, { name: manifest.name as string, description: manifest.description as string, html: manifest.html as string, capabilities: caps });
      const app = (await this.agents.listApps(opts.agentId)).find((a) => a.name === manifest.name);
      created.appId = app?.id;
      created.agentId = opts.agentId;
      const parked = caps.filter((c) => !APP_FREE_CAPS.has(c));
      if (parked.length) notes.push(`capabilities parked until you review them: ${parked.join(', ')}`);
    }

    const install: typeof registryInstalls.$inferSelect = {
      id: newId(), accountId: currentAccountId(), itemId: id, version: review.version,
      agentId: created.agentId ?? null, skillId: created.skillId ?? null, appId: created.appId ?? null, orgId: null,
      installedAt: nowIso(),
    };
    await this.db.insert(registryInstalls).values(install);
    if (id.startsWith(REMOTE_PREFIX)) {
      await this.notifyRemote(id.slice(REMOTE_PREFIX.length), 'installed');
    } else {
      await this.db.update(registryItems).set({ installs: sql`${registryItems.installs} + 1` }).where(eq(registryItems.id, id));
    }
    return { ok: true, install, ...created, notes };
  }

  async installsOf(itemId: string) {
    return this.db.select().from(registryInstalls).where(eq(registryInstalls.itemId, itemId));
  }

  /** A company blueprint install (item 24): the import ran elsewhere
   *  (OrgBlueprintsService); here the install row is written against the
   *  organization it created and the counters follow as for any install. */
  async recordExternalInstall(id: string, input: { orgId: string }) {
    const detail = await this.get(id);
    const install: typeof registryInstalls.$inferSelect = {
      id: newId(), accountId: currentAccountId(), itemId: id, version: detail.version,
      agentId: null, skillId: null, appId: null, orgId: input.orgId, installedAt: nowIso(),
    };
    await this.db.insert(registryInstalls).values(install);
    if (id.startsWith(REMOTE_PREFIX)) await this.notifyRemote(id.slice(REMOTE_PREFIX.length), 'installed');
    else if (id.startsWith(BUILTIN_PREFIX)) { /* no row: a built-in's installs are counted from registry_installs */ }
    else await this.db.update(registryItems).set({ installs: sql`${registryItems.installs} + 1` }).where(eq(registryItems.id, id));
    return install;
  }

  // ---- blueprint outcomes (docs/blueprints.md §4) ----

  /** One anonymous outcome on an item: a local row, or a counter bump sent to
   *  the remote feed. Called only when `shareBlueprintOutcomes` is on. */
  async recordOutcome(itemId: string, kind: OutcomeKind): Promise<void> {
    if (!OUTCOME_KINDS.includes(kind)) throw new BadRequestException(`outcome kind must be one of ${OUTCOME_KINDS.join(', ')}`);
    if (itemId.startsWith(REMOTE_PREFIX)) { await this.notifyRemote(itemId.slice(REMOTE_PREFIX.length), 'outcome', { kind }); return; }
    if (itemId.startsWith(BUILTIN_PREFIX)) { if (!builtinCompanies().some((b) => b.item.id === itemId)) throw new NotFoundException(`registry item ${itemId}`); }
    else await this.row(itemId);
    await this.db.insert(registryOutcomes).values({ id: newId(), accountId: currentAccountId(), itemId, kind, createdAt: nowIso() });
  }

  /** The feed side of a remote outcome: an anonymous row, nothing else. */
  async bumpPublicOutcome(id: string, kind: unknown) {
    if (!OUTCOME_KINDS.includes(kind as OutcomeKind)) throw new BadRequestException(`outcome kind must be one of ${OUTCOME_KINDS.join(', ')}`);
    const row = await this.publicRow(id);
    await unscoped(this.db).insert(registryOutcomes).values({ id: newId(), accountId: row.accountId, itemId: row.id, kind: kind as string, createdAt: nowIso() });
    return { ok: true };
  }

  /** Outcome counts per item, for the companies listing. */
  async outcomesOf(itemIds: string[]): Promise<Map<string, Record<OutcomeKind, number>>> {
    const out = new Map<string, Record<OutcomeKind, number>>();
    if (itemIds.length === 0) return out;
    const rows = await this.db.select().from(registryOutcomes).where(inArray(registryOutcomes.itemId, itemIds));
    for (const r of rows) {
      const c = out.get(r.itemId) ?? { first_key_result: 0, thirty_days_in_envelope: 0 };
      if (OUTCOME_KINDS.includes(r.kind as OutcomeKind)) c[r.kind as OutcomeKind]++;
      out.set(r.itemId, c);
    }
    return out;
  }

  // ---- ratings ----

  /**
   * A rated turn ran on an installed agent, or loaded an installed skill:
   * one rating row per (install, turn), re-rating replaces, counters follow.
   * Called from ChatsService.rateTurn beside the skill outcomes.
   */
  async recordTurnRating(input: { agentId: string | null; skillIds: string[]; turnId: string; rating: 'up' | 'down'; note?: string }): Promise<string[]> {
    const conds = [];
    if (input.agentId) conds.push(eq(registryInstalls.agentId, input.agentId));
    if (input.skillIds.length) conds.push(inArray(registryInstalls.skillId, input.skillIds));
    if (conds.length === 0) return [];
    const installs = await this.db.select().from(registryInstalls).where(conds.length === 1 ? conds[0] : or(...conds));
    const touched: string[] = [];
    for (const inst of installs) {
      await this.applyRating(inst.itemId, inst.id, input.turnId, input.rating, input.note ?? '');
      touched.push(inst.itemId);
    }
    return [...new Set(touched)];
  }

  /** Explicit rating (app cards, which have no turns): one per item from
   *  this instance; a second explicit rating replaces the first. */
  async rate(id: string, body: { rating: 'up' | 'down'; note?: string }) {
    if (body.rating !== 'up' && body.rating !== 'down') throw new BadRequestException('rating must be up or down');
    const install = (await this.db.select().from(registryInstalls).where(eq(registryInstalls.itemId, id)).orderBy(desc(registryInstalls.installedAt)).limit(1))[0];
    if (!install) throw new BadRequestException('install the item before rating it');
    await this.applyRating(id, install.id, '', body.rating, (body.note ?? '').slice(0, 1000));
    if (id.startsWith(REMOTE_PREFIX)) await this.notifyRemote(id.slice(REMOTE_PREFIX.length), 'rate', { rating: body.rating });
    const ratings = await this.db.select().from(registryRatings).where(eq(registryRatings.itemId, id));
    return { ok: true, up: ratings.filter((r) => r.rating === 'up').length, down: ratings.filter((r) => r.rating === 'down').length };
  }

  /** The feed side of a remote rate: a bare counter bump, no row (there is
   *  no install here to attach it to). */
  async bumpPublicRating(id: string, rating: unknown) {
    if (rating !== 'up' && rating !== 'down') throw new BadRequestException('rating must be up or down');
    const row = await this.publicRow(id);
    await unscoped(this.db).update(registryItems)
      .set(rating === 'up' ? { ratingUp: sql`${registryItems.ratingUp} + 1` } : { ratingDown: sql`${registryItems.ratingDown} + 1` })
      .where(eq(registryItems.id, row.id));
    return { ok: true };
  }

  private async applyRating(itemId: string, installId: string, turnId: string, rating: 'up' | 'down', note: string): Promise<void> {
    const prev = (await this.db.select().from(registryRatings)
      .where(and(eq(registryRatings.installId, installId), eq(registryRatings.turnId, turnId))).limit(1))[0];
    if (prev && prev.rating === rating) {
      await this.db.update(registryRatings).set({ note: note || prev.note }).where(eq(registryRatings.id, prev.id));
      return;
    }
    if (prev) {
      await this.db.update(registryRatings).set({ rating, note }).where(eq(registryRatings.id, prev.id));
    } else {
      await this.db.insert(registryRatings).values({ id: newId(), accountId: currentAccountId(), itemId, installId, turnId, rating, note, createdAt: nowIso() });
    }
    if (itemId.startsWith(REMOTE_PREFIX) || itemId.startsWith(BUILTIN_PREFIX)) return; // the remote keeps its own counters; a built-in has no row
    const up = (rating === 'up' ? 1 : 0) - (prev?.rating === 'up' ? 1 : 0);
    const down = (rating === 'down' ? 1 : 0) - (prev?.rating === 'down' ? 1 : 0);
    await this.db.update(registryItems).set({
      ratingUp: sql`GREATEST(0, ${registryItems.ratingUp} + ${up})`,
      ratingDown: sql`GREATEST(0, ${registryItems.ratingDown} + ${down})`,
    }).where(eq(registryItems.id, itemId));
  }
}
