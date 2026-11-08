/**
 * The CEO-alignment tools (docs/alignment.md), offered to org members as a
 * ToolProviderHook beside the runtime's matrix so they work in every session
 * kind (task runs, planning runs, heartbeats, chats):
 *
 *  - `org_alignment` (read, every member): the gated items and their state, or one item's brief and thread;
 *  - `org_classify_alignment` (the owner): does this item need alignment — yes / no, the class and the reasoning against the criteria;
 *  - `org_request_alignment` (the owner): the brief, to the aligner (the CEO's card, the chief, or auto);
 *  - `org_alignment_comment` (every member): reply on an item's thread with the CEO;
 *  - `org_align` (the chief, where the company delegates a class to it): approve, send back or reject;
 *  - `org_alignment_audit` (the chief and the auditor, read): under- and over-escalation findings.
 *
 * Classes (docs/boundary.md): reads and comments are read-only; a request
 * writes a card or a task the aligner decides (a proposal); a
 * classification and the chief's decision are internal writes.
 */
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChatSession } from '../chats/chats.repository';
import { TurnLoopService, type ToolProviderHook } from '../chats/turn-loop.service';
import type { AiToolSpec } from '../ai/ai-provider.interface';
import { OrgService, type Organization } from './org.service';
import { OrgRuntimeService } from './org-runtime.service';
import { OrgAlignmentService } from './org-alignment.service';
import { ALIGNMENT_CLASS_DEFS, ALIGNMENT_CRITERIA } from './alignment';

const ITEM = 'The item: "vision" (the product direction), "strategy" (the strategy memo), a project key (P-3), or a goal id / id prefix from org_intent.';
const CLASSES = ALIGNMENT_CLASS_DEFS.map((c) => `${c.id} (${c.label}: ${c.covers})`).join('; ');
const CRITERIA = { type: 'object', description: `Your answers to the criteria: ${ALIGNMENT_CRITERIA.map((c) => `${c.id} (${c.values}) — ${c.question}`).join(' ')}`, properties: {
  reversibility: { type: 'string', enum: ['two_way', 'one_way'] }, blastRadius: { type: 'string', enum: ['team', 'unit', 'cross_unit', 'company', 'external'] },
  costShare: { type: 'number', description: 'Share 0–1 of the monthly company envelope it commits.' }, externalCommitment: { type: 'boolean' },
  novelty: { type: 'string', enum: ['within', 'extends', 'new'] }, conflicts: { type: 'boolean' },
} };
const BRIEF = { type: 'object', description: 'The alignment brief: what the CEO reads before deciding.', properties: {
  what: { type: 'string', description: 'The item, said plainly (one or two sentences).' },
  why: { type: 'string', description: 'The problem or opportunity, and the evidence.' },
  options: { type: 'array', items: { type: 'string' }, description: 'The alternatives you considered, including doing nothing, each with one line on why not.' },
  tradeoffs: { type: 'string', description: 'What we give up by choosing it.' },
  measures: { type: 'string', description: 'How we will know it worked: the metric, the target, the date.' },
  cost: { type: 'string', description: 'What it costs: time, money (appetite, envelope share), people.' },
  unlocks: { type: 'string', description: 'The projects and tasks it unlocks once aligned.' },
}, required: ['what', 'why', 'options', 'measures'] };

const TOOLS: AiToolSpec[] = [
  { name: 'org_alignment', description: 'CEO alignment (read): without item, every alignment-gated item (direction, strategy, OKRs, project bets and anything classified into another class) with its state — draft, awaiting alignment, aligned, needs re-alignment, rejected, not escalated; with item, its brief, classification, conditions and the discussion thread with the CEO.', inputSchema: { type: 'object', properties: { item: { type: 'string', description: ITEM }, org: { type: 'string' } } } },
  { name: 'org_classify_alignment', description: `Decide whether an item you own needs alignment before work is built on it: needsAlignment true or false, the class, your reasoning and your answers to the criteria. "false" lets work start (the CEO sees it under "Not escalated" and can pull it in; the chief and the auditor spot-check). Refused when the class always needs the CEO here, or when your own criteria say it does. Classes: ${CLASSES}.`, inputSchema: { type: 'object', properties: { item: { type: 'string', description: ITEM }, needsAlignment: { type: 'boolean' }, class: { type: 'string', enum: ALIGNMENT_CLASS_DEFS.map((c) => c.id) }, reasoning: { type: 'string', description: 'Why, against the criteria, in two or three sentences.' }, criteria: CRITERIA, org: { type: 'string' } }, required: ['item', 'needsAlignment', 'reasoning'] } },
  { name: 'org_request_alignment', description: 'Ask for alignment on an item with a brief (what, why, options, trade-offs, measures, cost, what it unlocks). The company\'s aligner decides: the CEO (a decision card in their Inbox: approve, approve with changes, send back with comments, reject), the chief of staff, or nobody (auto-aligned, logged). An objective goes with its key results (include_children, default true). Calling it again while the card is pending revises the brief on the card. Tasks under the item are refused until it is aligned.', inputSchema: { type: 'object', properties: { item: { type: 'string', description: ITEM }, brief: BRIEF, include_children: { type: 'boolean' }, org: { type: 'string' } }, required: ['item', 'brief'] } },
  { name: 'org_alignment_comment', description: 'Reply on an item\'s alignment thread (the discussion with the CEO): answer a question, say what you changed. Revise the brief itself with org_request_alignment.', inputSchema: { type: 'object', properties: { item: { type: 'string', description: ITEM }, text: { type: 'string' }, org: { type: 'string' } }, required: ['item', 'text'] } },
  { name: 'org_align', description: 'Chief of staff only, for a class the company delegates to you (alignment.required.<class> = 1): approve (optionally with conditions in note), send_back with comments, or reject an item awaiting your alignment. Logged; the CEO can review and override.', inputSchema: { type: 'object', properties: { item: { type: 'string', description: ITEM }, decision: { type: 'string', enum: ['approve', 'send_back', 'reject'] }, note: { type: 'string' }, org: { type: 'string' } }, required: ['item', 'decision'] } },
  { name: 'org_alignment_audit', description: 'Chief of staff and auditor (read): the escalation spot-check — items an agent did not escalate whose signals say it should have (under-escalation), and items that reached the CEO although their criteria cleared them (over-escalation, noise). Feed what you find back as guidance or a finding.', inputSchema: { type: 'object', properties: { org: { type: 'string' } } } },
];
const NAMES = new Set(TOOLS.map((t) => t.name));
const READ = new Set(['org_alignment', 'org_request_alignment', 'org_alignment_comment', 'org_alignment_audit']);

const MEMBER_GUIDE = 'CEO alignment (docs/alignment.md): what the company builds toward is aligned before work is created under it. When you create or materially change a goal, a project or the strategy, decide whether it needs alignment — org_classify_alignment with the criteria (one-way door, blast radius, cost share of the envelope, external commitment, novelty against the strategy, conflict with a charter or the constitution) — and if it does, prepare a brief and call org_request_alignment. Tasks under an item that is not aligned are refused; shaping work for the brief is allowed as class discovery (capped). org_alignment shows what waits on whom.';

@Injectable()
export class OrgAlignmentTools implements ToolProviderHook {
  constructor(
    private readonly org: OrgService,
    private readonly alignment: OrgAlignmentService,
    private readonly config: ConfigService,
    @Optional() private readonly runtime?: OrgRuntimeService,
    @Optional() turns?: TurnLoopService,
  ) {
    turns?.addToolProvider(this);
  }

  private enabled(): boolean { return this.config.get<boolean>('companiesEnabled') !== false; }

  private async memberships(agentId: string) {
    return (await this.org.membershipsOf(agentId)).filter((m) => m.status === 'active');
  }

  async specsFor(session: ChatSession): Promise<AiToolSpec[]> {
    if (!this.enabled() || !session.agentId) return [];
    const ctx = this.runtime?.runningCtx(session.id);
    if (ctx?.audit) return TOOLS.filter((t) => t.name === 'org_alignment' || t.name === 'org_alignment_audit');
    if (ctx?.aux) return [];
    const ms = await this.memberships(session.agentId);
    if (!ms.length) return [];
    const orgs = await Promise.all(ms.map((m) => this.org.get(m.orgId).catch(() => null)));
    const chief = orgs.some((o) => o?.chiefOfStaffAgentId === session.agentId);
    const auditor = orgs.some((o) => o?.auditorAgentId === session.agentId);
    return TOOLS.filter((t) => (t.name === 'org_align' ? chief : t.name === 'org_alignment_audit' ? chief || auditor : true));
  }

  owns(name: string): boolean { return NAMES.has(name); }
  isReadOnly(name: string): boolean { return READ.has(name); }

  async contextFor(session: ChatSession): Promise<string | null> {
    if (!this.enabled() || !session.agentId) return null;
    const ms = await this.memberships(session.agentId);
    if (!ms.length) return null;
    // What waits on this member: its own items that are not aligned yet.
    const lines: string[] = [];
    for (const m of ms.slice(0, 2)) {
      const mine = (await this.alignment.list(m.orgId).catch(() => [])).filter((v) => v.ownerAgentId === session.agentId && !['aligned', 'not_required'].includes(v.state) && !v.bundleOf);
      for (const v of mine.slice(0, 5)) lines.push(`- ${v.label} "${v.title.slice(0, 80)}": ${v.state.replace('_', ' ')}${v.needsAlignment === null && v.state === 'draft' ? ' (classify it)' : ''}`);
    }
    return lines.length ? `${MEMBER_GUIDE}\nYour items waiting on alignment:\n${lines.join('\n')}` : MEMBER_GUIDE;
  }

  private async resolveOrg(agentId: string, hint: unknown): Promise<Organization> {
    const ms = await this.memberships(agentId);
    if (ms.length === 0) throw new Error('you do not belong to an organization');
    if (typeof hint === 'string' && hint.trim()) {
      const q = hint.trim().toLowerCase();
      for (const m of ms) { const o = await this.org.get(m.orgId).catch(() => null); if (o && (o.id === q || o.id.startsWith(q) || o.name.toLowerCase() === q)) return o; }
      throw new Error(`no organization "${hint}"`);
    }
    if (ms.length > 1) throw new Error(`you belong to ${ms.length} organizations — pass org: <name>`);
    return this.org.get(ms[0].orgId);
  }

  async execute(session: ChatSession, name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.enabled()) throw new Error('organizations are disabled on this server');
    const agentId = session.agentId!;
    const org = await this.resolveOrg(agentId, input.org);
    if (org.status !== 'active') throw new Error(`"${org.name}" is paused by the CEO`);
    const isChief = org.chiefOfStaffAgentId === agentId;
    const actor = isChief ? 'chief' : `agent:${agentId}`;
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
    const ctx = this.runtime?.runningCtx(session.id);
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: unknown) => { const m = err instanceof Error ? err.message : String(err); throw new Error(m.startsWith('refused') ? m : `refused: ${m}`); });
    switch (name) {
      case 'org_alignment': {
        if (!str('item')) return this.alignment.describe(await this.alignment.list(org.id));
        const it = await wrap(() => this.alignment.resolve(org.id, str('item')));
        const v = (await this.alignment.list(org.id)).find((x) => x.itemType === it.itemType && x.itemId === it.itemId);
        return v ? this.alignment.describeOne(v) : `${it.itemType.replace('_', ' ')} "${it.title}" has no alignment record: it predates the gate, or nobody has classified it. Classify it with org_classify_alignment.`;
      }
      case 'org_classify_alignment': {
        const r = await wrap(() => this.alignment.classify(org.id, str('item'), { needsAlignment: input.needsAlignment, class: input.class, reasoning: input.reasoning, criteria: input.criteria }, actor));
        if (ctx) ctx.progress = true;
        return r.text;
      }
      case 'org_request_alignment': {
        const r = await wrap(() => this.alignment.request(org.id, str('item'), { brief: input.brief, includeChildren: input.include_children === false ? false : true }, actor));
        if (ctx) ctx.progress = true;
        return r.text;
      }
      case 'org_alignment_comment': {
        const it = await wrap(() => this.alignment.resolve(org.id, str('item')));
        const row = await this.alignment.rowFor(org.id, it.itemType, it.itemId);
        if (!row) throw new Error(`refused: ${it.title} has no alignment thread yet — classify it or request alignment first`);
        await wrap(() => this.alignment.comment(org.id, row.id, str('text'), actor));
        if (ctx) ctx.progress = true;
        return 'Comment posted on the alignment thread; the CEO reads it with the brief.';
      }
      case 'org_align': {
        if (!isChief) throw new Error('refused: only the chief of staff aligns on the CEO\'s behalf');
        const d = str('decision');
        if (!['approve', 'send_back', 'reject'].includes(d)) throw new Error('decision must be approve, send_back or reject');
        const out = await wrap(() => this.alignment.chiefDecide(org.id, str('item'), d as 'approve' | 'send_back' | 'reject', str('note'), actor));
        if (ctx) ctx.progress = true;
        return out;
      }
      case 'org_alignment_audit': {
        if (!isChief && org.auditorAgentId !== agentId) throw new Error('refused: the escalation spot-check is the chief\'s and the auditor\'s');
        return this.alignment.describeFindings(await this.alignment.spotCheck(org.id));
      }
    }
    throw new Error(`unknown tool: ${name}`);
  }
}
