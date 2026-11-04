/**
 * Who heads a function (decision 1 of docs/autonomous-skills-review.md §4,
 * and its "Why heads don't hire" note). Pure, model-free.
 *
 * A member is a head — it staffs its own unit (org_roles, org_hire_agent,
 * org_pause_agent, org_update_member) — when any of these holds:
 *
 *  1. it leads a non-root unit (it has reports);
 *  2. its member row says so (`org_members.isHead`, set when it was hired
 *     into a head role or by the chief's or the CEO's `make_head` reorg);
 *  3. it reports to the chief of staff and its title reads as a head's:
 *     a catalog head's ("Head of Sales"), or any "Head of …", "VP …",
 *     "Director of …", "… Lead", "… Director" title ("Head of Tutoring").
 *
 * Its function (`fn`) is the catalog function its title names — the exact
 * catalog title, or a keyword ("Head of Growth" → marketing) — or null for a
 * head of a function the catalog does not have (it hires generalist roles
 * and any function's specialists; the boundary and caps bind it the same).
 */
import { ROLES, type Role } from './roles/catalog';

/** A catalog function head: `<fn>-manager` with an authored pack, reporting to the chief. */
export function isHeadRole(r: Pick<Role, 'id' | 'packId' | 'reportsToHint'> | undefined | null): boolean {
  return Boolean(r && r.id.endsWith('-manager') && r.packId && r.reportsToHint === 'chief-of-staff');
}

/** A coordinator title that names a role, not a function ("Program Manager", "Account Manager"). */
const NOT_A_HEAD = /\b(program|programme|project|product|account|community|office|case|social media|success|delivery)\s+(manager|lead|coordinator)\b|\bcoordinator\b|\bassistant\b|\bspecialist\b|\banalyst\b|\bengineer\b/i;
/** A head's title shape. */
const HEAD_SHAPE = /^(head|vp|svp|evp|vice president|director|general manager|chief\s+\w+\s+officer)\b|\b(head|lead|director)$/i;

/** Whether a title names a Program Manager (the catalog's role:ops-pm): the
 *  owner of goals and projects on the matrix's outcome axis (docs/work-tracking.md
 *  "Program management: the matrix"). */
export function isProgramManagerTitle(title: string | null | undefined): boolean {
  return /\bprogram(me)?\s+manager\b/i.test(title ?? '');
}

/** Whether a title reads as a function head's (catalog or not). */
export function isHeadTitle(title: string | null | undefined): boolean {
  const t = (title ?? '').trim();
  if (!t) return false;
  if (/^chief of staff$/i.test(t)) return false;
  if (ROLES.some((r) => isHeadRole(r) && r.title.toLowerCase() === t.toLowerCase())) return true;
  if (NOT_A_HEAD.test(t)) return false;
  return HEAD_SHAPE.test(t) || /^\w[\w &-]*\s+manager$/i.test(t) && FUNCTION_WORDS.some(([, re]) => re.test(t));
}

/** Function keyword → catalog function slug (the `<fn>` of `<fn>-manager`). */
const FUNCTION_WORDS: Array<[string, RegExp]> = [
  ['revops', /\brev(enue)?\s*ops\b|\brevenue operations\b/i],
  ['it-security', /\b(it|security|infosec|information security)\b/i],
  ['engineering', /\b(engineering|technology|tech|platform|infrastructure|development)\b/i],
  ['sales', /\b(sales|business development|bizdev|partnerships)\b/i],
  ['marketing', /\b(marketing|growth|brand|content|communications|comms|demand)\b/i],
  ['cs', /\b(customer|support|success|cx|service)\b/i],
  ['product', /\bproduct\b/i],
  ['design', /\b(design|ux|ui)\b/i],
  ['data', /\b(data|analytics|insights|bi)\b/i],
  ['finance', /\b(finance|financial|accounting|fp&a|treasury)\b/i],
  ['people', /\b(people|hr|human resources|talent|recruiting)\b/i],
  ['legal', /\b(legal|counsel|compliance)\b/i],
  ['ops', /\b(operations|ops)\b/i],
];

/**
 * A head's function from its title ("Head of Sales" → `sales`, "VP Growth" →
 * `marketing`); null when the title names no catalog function ("Head of
 * Tutoring"). Only catalog functions with a head role are returned.
 */
export function headFunction(title: string | null | undefined): string | null {
  const q = (title ?? '').trim().toLowerCase();
  if (!q) return null;
  const exact = ROLES.find((x) => isHeadRole(x) && x.title.toLowerCase() === q);
  if (exact) return exact.id.slice(0, -'-manager'.length);
  if (!isHeadTitle(title)) return null;
  for (const [fn, re] of FUNCTION_WORDS) if (re.test(q) && ROLES.some((r) => r.id === `${fn}-manager` && isHeadRole(r))) return fn;
  return null;
}

export interface HeadMember { agentId: string; title: string; status: string; reportsToAgentId: string | null; isHead?: number | null }

/**
 * Whether `m` heads a function (the three rules above). `leadsUnit` is true
 * when it leads a non-root unit. The chief and the auditor are never heads.
 */
export function isHeadMember(m: HeadMember | null | undefined, org: { chiefOfStaffAgentId: string | null; auditorAgentId?: string | null }, leadsUnit: boolean): boolean {
  if (!m || m.status !== 'active') return false;
  if (m.agentId === org.chiefOfStaffAgentId || (org.auditorAgentId && m.agentId === org.auditorAgentId)) return false;
  if (leadsUnit || m.isHead === 1) return true;
  return m.reportsToAgentId !== null && m.reportsToAgentId === org.chiefOfStaffAgentId && isHeadTitle(m.title);
}

/** The catalog roles a head of `fn` hires (its specialists); every
 *  specialist and generalist role for a head of no catalog function. */
export function rolesForHead(fn: string | null): Role[] {
  if (fn) return ROLES.filter((r) => r.reportsToHint === `${fn}-manager`);
  return ROLES.filter((r) => !isHeadRole(r) && r.id !== 'chief-of-staff' && r.id !== 'auditor' && r.reportsToHint !== 'chief-of-staff');
}

/**
 * The head playbooks a head without a catalog head pack carries
 * (OrgApprovalsService.ensureHeadPlaybooks): installed on a member that
 * becomes a head through a non-head pack, a blueprint, enrolment or the
 * chief's `make_head` reorg, so every head knows how to staff its unit.
 */
export const HEAD_PLAYBOOKS: ReadonlyArray<{ name: string; description: string; instructions: string }> = [
  {
    name: 'unit-team-design',
    description: 'Design your unit\'s team yourself - the seats its key results need, the hire plan within your envelope, the unit\'s rituals - then hire, onboard and report it to the chief. Use when you take a head\'s seat, when the chief hands you a mandate or an envelope, each quarter, and whenever org_capacity or your heartbeat\'s staffing line shows a gap.',
    instructions: [
      '1. Read the mandate before the catalog: the objectives and key results your unit carries (org_intent, org_read_goal), the envelope the chief set for it (org_costs, org_forecast), the agent-cap headroom your heartbeat\'s staffing line shows, and the load (org_capacity for you and your reports). A head doing all of its unit\'s work itself is a staffing gap, not diligence.',
      '2. Find the roles: org_roles with a query naming your work (your function, the competencies the key results need) lists the catalog roles with their tier, rough monthly cost and competencies. Pick the fewest seats that carry the key results — one per distinct competency the work needs now. Work another function owns is a request to its head, not a hire.',
      '3. Write the design to your function\'s folder under /org/ (team.md): each seat (role id, the key result it serves, expected load, monthly cost), the seats you fill now and the ones you defer with the trigger that brings them in, the unit\'s rituals with their cadence from the profile (org_set_cadence), and how work flows in and who reviews it.',
      '4. Hire what you fill now with org_hire_agent: templateOrPack "role:<id>", reportsTo you, monthlyBudgetUsd within the unit\'s envelope, and a why naming the key result, the alternatives (doing nothing included) and your confidence. Supervised: a card the chief sees first, then the CEO. Autonomous: it acts at once within the caps. A refusal names its limit — take the case to the chief with org_escalate instead of retrying.',
      '5. Onboard every new member (unit-team-management step 3) and hand it your open tasks (org_assign) so you lead the unit instead of doing its work.',
      '6. Report the design in a short org_message and in your weekly report (seats filled, deferred, refused and why), so the chief reviews it rather than designing it.',
    ].join('\n'),
  },
  {
    name: 'unit-team-management',
    description: 'Manage your unit\'s members - brief and assign, review, balance load, coach, onboard, and pause or re-tool within your line (the chief is told). Use whenever work is assigned or reviewed, and monthly.',
    instructions: [
      '1. Brief every task with outcome, context, constraints and a testable done_when; add checks where you can, a dueAt, and dependsOn for sequenced work. Assign only to yourself or your reports (or, on a project you lead, its team).',
      '2. Read org_capacity first and keep each member under its WIP limit; a member at its limit gets no new task until one closes.',
      '3. Onboard every new member: an onboarding task (read its charter, your team.md and the latest report; write a first-week plan naming the key result it serves) and one small real task with checks; review its first three results yourself.',
      '4. Decisions your reports raise come to you first: org_decision_queue lists them with whether each is within your authority; decide with org_decide, send back with guidance, or escalate with your recommendation. Program Managers ask you to allocate your people to their projects: approve against your design and the member\'s load, or decline with the reason.',
      '5. Pause a member that idles or spends without accepted work (org_pause_agent); change a member\'s model or heartbeat with org_update_member (the eval gate replays its golden set first). The chief is told of each change; record it with the why in team.md.',
      '6. A new function, a hire into another unit, a termination, a scope widening or more envelope stay the chief\'s: bring them as a backlog task (org_create_task) with the case.',
    ].join('\n'),
  },
];
