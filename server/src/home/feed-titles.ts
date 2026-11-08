/**
 * The feed's titles (docs/owners-seat.md "Inbox and notifications"): every
 * row reads as one short sentence a person would write — "Head of Marketing
 * wants to hire a Content Marketer", "REJ-4 is stuck waiting on you",
 * "Trạng Tí's runs failed 5 times" — and the detail goes in the body. Names,
 * keys and amounts stay; free text is clipped at a word boundary, never
 * mid-word. Pure: the service and the registry call these.
 */
import type { HomeNeed } from './home.types';
import type { FeedType } from './feed.types';

/** Free text clipped at a word boundary, with an ellipsis when cut. */
export function clipWords(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const at = cut.lastIndexOf(' ');
  return `${(at > n * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.—–-]+$/, '')}…`;
}

/** The first sentence of free text (or the text clipped at a word boundary). */
export function firstSentence(s: string, n = 140): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{12,}?[.!?])(\s|$)/);
  return clipWords(m && m[1].length <= n ? m[1] : t, n);
}

const an = (w: string) => (/^[aeiou]/i.test(w.trim()) ? 'an' : 'a');
/** "$282", "$12.50", "$1,200". */
export const money = (n: number): string => `$${n >= 100 || Number.isInteger(n) ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;
/** A requester that reads as a someone (not "System", "Assurance", "CEO", "You" or empty). */
const someone = (who: string) => Boolean(who) && !/^(system|assurance|ceo|you|foundry)$/i.test(who.trim());
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Facts = NonNullable<HomeNeed['facts']>;
const f = (facts: Facts | undefined, k: string): string => { const v = facts?.[k]; return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''; };
const fn = (facts: Facts | undefined, k: string): number => { const v = facts?.[k]; return typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0; };
const fl = (facts: Facts | undefined, k: string): string[] => { const v = facts?.[k]; return Array.isArray(v) ? v : []; };

/** A Needs-you card as a title and body a person would write. */
export function needPresentation(n: Pick<HomeNeed, 'kind' | 'subkind' | 'title' | 'detail' | 'requestedBy' | 'facts' | 'task'>): { title: string; body: string } {
  const who = someone(n.requestedBy) ? n.requestedBy.trim() : '';
  const facts = n.facts;
  const key = n.task?.key || f(facts, 'taskKey');
  const taskTitle = n.task?.title || f(facts, 'title');
  const taskName = key || (taskTitle ? `"${clipWords(taskTitle, 60)}"` : 'A task');
  switch (n.kind) {
    case 'escalation':
      return { title: `${taskName} is stuck waiting on you`, body: f(facts, 'reason') || n.detail };
    case 'plan':
      return { title: who ? `${who} plans to ${lowerFirst(clipWords(n.title, 90))}` : clipWords(n.title, 110), body: n.detail };
    case 'held_action': {
      if (n.subkind === 'two_key') {
        const verb = facts?.staged ? 'send' : 'run';
        return { title: `${who || 'An agent'} needs your key to ${verb} ${f(facts, 'tool') || 'an action'}`, body: f(facts, 'summary') || n.detail };
      }
      const m = n.title.match(/^(Send staged|Run held) (.+)$/);
      return m ? { title: `${who || 'An agent'} needs your key to ${m[1] === 'Send staged' ? 'send' : 'run'} ${m[2]}`, body: n.detail } : { title: n.title, body: n.detail };
    }
    case 'queued_action': {
      const tool = n.subkind && n.subkind !== 'action' ? n.subkind : (n.title.match(/: (\S+)$/)?.[1] ?? '');
      return { title: tool ? `${who || 'An agent'} wants to run ${tool}` : n.title, body: n.detail };
    }
    case 'signal':
      return { title: signalTitle(n.subkind, n.title), body: n.detail };
    case 'incident':
      return { title: n.title, body: n.detail };
    case 'approval':
      return { title: approvalTitle(n.subkind, who, facts, n.title, taskName), body: n.detail || approvalBody(n.subkind, facts) };
  }
  return { title: n.title, body: n.detail };
}

function approvalTitle(kind: string, who: string, facts: Facts | undefined, fallback: string, taskName: string): string {
  const by = (verb: string, rest: string) => (who ? `${who} ${verb} ${rest}` : upperFirst(rest));
  const agent = f(facts, 'agentName') || 'a member';
  const kindOf = (k: string) => f(facts, k).replace(/_/g, ' ');
  switch (kind) {
    case 'hire': {
      const role = f(facts, 'title') || f(facts, 'name') || 'specialist';
      return who ? `${who} wants to hire ${an(role)} ${role}` : `Hire ${an(role)} ${role}`;
    }
    case 'scope_widen': {
      const w = fl(facts, 'widened');
      return `${upperFirst(agent)} asks for more access${w.length ? `: ${clipWords(w.join(', '), 60)}` : ''}`;
    }
    case 'member_settings': return `Change ${agent}'s settings${f(facts, 'summary') ? `: ${clipWords(f(facts, 'summary'), 70)}` : ''}`;
    case 'reorg': return by('proposes', 'a reorg');
    case 'budget_raise': {
      const scope = f(facts, 'scope') || 'company';
      const usd = fn(facts, 'monthlyUsd');
      return `${who || 'Someone'} asks to raise the ${scope} budget${usd ? ` to ${money(usd)} a month` : ''}`;
    }
    case 'routing': return `Send ${kindOf('class') || 'some'} work to the ${f(facts, 'tier') || 'other'} model tier`;
    case 'strategy': { const g = fl(facts, 'goals').length || fn(facts, 'goals'); return by('proposes', g ? `${g} new goal${g === 1 ? '' : 's'}` : 'a new strategy'); }
    case 'terminate': return by('proposes', `letting ${agent} go`);
    case 'external': return f(facts, 'description') ? upperFirst(firstSentence(f(facts, 'description'), 110)) : by('wants', 'to act outside the company');
    case 'tune': return `Change ${f(facts, 'key') || 'a setting'}${f(facts, 'from') ? ` from ${f(facts, 'from')}` : ''} to ${f(facts, 'value') || 'a new value'}`;
    case 'cadence': return `${f(facts, 'cron') ? 'Reschedule' : 'Stop'} the ${kindOf('kind') || 'meeting'} for ${f(facts, 'unitName') || 'the company'}`;
    case 'charter_change': return `Update ${agent}'s charter`;
    case 'blueprint': { const h = fl(facts, 'hires').length; return `Staff ${f(facts, 'name') || 'the company'} from its blueprint${h ? ` (${h} hire${h === 1 ? '' : 's'})` : ''}`; }
    case 'metric_source': return `Connect the metric "${clipWords(f(facts, 'name') || 'source', 60)}"`;
    case 'experiment': return by('wants to run', `an experiment: ${clipWords(f(facts, 'title') || 'untitled', 70)}`);
    case 'human_review': return `Review ${taskName}`;
    case 'project_now': return `Move ${f(facts, 'projectKey') || clipWords(f(facts, 'title'), 50) || 'a project'} to Now`;
    case 'project_appetite': return `${f(facts, 'projectKey') || 'A project'} used up its appetite: extend, cut or stop it`;
    case 'project_allocation': return `Put ${agent} on ${f(facts, 'projectKey') || 'a project'}${fn(facts, 'allocation') ? ` at ${fn(facts, 'allocation')}%` : ''}`;
    case 'project_kill': return `Stop ${f(facts, 'projectKey') || 'a project'}${f(facts, 'title') ? ` (${clipWords(f(facts, 'title'), 50)})` : ''}`;
    // Quality control (docs/quality.md): a policy or standard change, a one-time exception to a blocked call.
    case 'quality_change': {
      const what = f(facts, 'target') === 'policy' ? 'policy' : 'quality standard';
      const name = clipWords(f(facts, 'name') || f(facts, 'key') || 'untitled', 60);
      const verb = f(facts, 'action') === 'retire' ? 'retire the' : f(facts, 'action') === 'revise' ? 'change the' : 'add the';
      return by('wants to', `${verb} ${what} "${name}"`);
    }
    case 'policy_exception': return `${upperFirst(f(facts, 'agentName') || 'A member')} asks to break policy "${clipWords(f(facts, 'policyKey') || 'a policy', 50)}" once${f(facts, 'tool') ? ` for ${f(facts, 'tool')}` : ''}`;
    case 'alignment': return `Align on the ${f(facts, 'label') || 'plan'}: ${clipWords(f(facts, 'title') || 'untitled', 70)}`;
    default: return clipWords(upperFirst(fallback), 110);
  }
}

function approvalBody(kind: string, facts: Facts | undefined): string {
  switch (kind) {
    case 'hire': {
      // The reading pane lists the role, who it reports to and the budget; the body says what the hire would do.
      const name = f(facts, 'name');
      const charter = firstSentence(f(facts, 'charter'), 200);
      return charter || (name && name !== f(facts, 'title') ? `Named ${name}.` : '');
    }
    case 'budget_raise': return f(facts, 'buys') ? `It buys: ${firstSentence(f(facts, 'buys'), 200)}` : '';
    case 'alignment': return f(facts, 'why') ? firstSentence(f(facts, 'why'), 200) : '';
    case 'scope_widen': return fl(facts, 'widened').join(', ');
    case 'charter_change': return firstSentence(f(facts, 'lesson') || f(facts, 'summary'), 200);
    case 'project_appetite': {
      const asked = [fn(facts, 'extendDays') ? `${fn(facts, 'extendDays')} more days` : '', fn(facts, 'extendUsd') ? `${money(fn(facts, 'extendUsd'))} more` : ''].filter(Boolean);
      return asked.length ? `Asked: ${asked.join(' and ')}.` : '';
    }
    case 'routing': return f(facts, 'from') ? `It runs on ${f(facts, 'from')} today.` : '';
    case 'quality_change': return firstSentence(f(facts, 'summary'), 200);
    case 'policy_exception': return [f(facts, 'statement') ? `The rule: ${firstSentence(f(facts, 'statement'), 140)}` : '', f(facts, 'why') ? `Why: ${firstSentence(f(facts, 'why'), 160)}` : ''].filter(Boolean).join(' ');
    case 'external': { const d = f(facts, 'description'); return d && firstSentence(d, 110) !== d ? d : ''; }
    default: return '';
  }
}

/** The assurance signals' titles, said plainly (the signal keeps its own). */
export function signalTitle(kind: string, title: string): string {
  const m = (re: RegExp) => title.match(re);
  switch (kind) {
    case 'burn_rate': {
      const x = m(/\$([\d,.]+) by month-end against a \$([\d,.]+) envelope/);
      return x ? `Spending is on track to reach ${money(Number(x[1].replace(/,/g, '')))} against a ${money(Number(x[2].replace(/,/g, '')))} budget` : title;
    }
    case 'stale_task': { const x = m(/^Stale: "(.*)" has had no run in (\d+)h$/); return x ? `No progress on "${clipWords(x[1], 60)}" in ${x[2]} hours` : title; }
    case 'blocked_unowned': { const x = m(/^Blocked and unowned: "(.*)"$/); return x ? `"${clipWords(x[1], 60)}" is blocked and nobody owns it` : title; }
    case 'review_age': { const x = m(/^Review waiting (\d+)h: "(.*)"$/); return x ? `"${clipWords(x[2], 60)}" has waited ${x[1]} hours for review` : title; }
    case 'breaker_trip': { const x = m(/^Breaker: "(.*)" — (.*) in 24h$/); return x ? `"${clipWords(x[1], 50)}" keeps stalling: ${x[2]} in a day` : title; }
    default: return title;
  }
}

/** A grouped row's title: what happened to the one thing, and how often. */
export function groupTitle(types: FeedType[], label: string, n: number): string {
  const all = (t: FeedType) => types.length > 0 && types.every((x) => x === t);
  const thing = clipWords(label || 'one thing', 64);
  const times = `${n} time${n === 1 ? '' : 's'}`;
  if (all('run_failed')) return /'s runs$/.test(thing) ? `${thing} failed ${times}` : `Runs on ${thing} failed ${times}`;
  if (all('channel_activity')) return `${n} new messages in ${thing}`;
  if (all('meeting')) return `${n} updates from ${thing}`;
  if (all('project_team')) return `${n} team changes on ${thing}`;
  if (all('plugin')) return `${n} updates to ${thing}`;
  return `${n} updates on ${thing}`;
}

/** "3 decision(s)" → "3 decisions", "1 hire(s)" → "1 hire". */
export const fixPlurals = (s: string): string => s.replace(/\b(\d+) (\w+)\(s\)/g, (_m, n: string, w: string) => `${n} ${w}${n === '1' ? '' : 's'}`);

/** An agent's note or trust change ("Acted (trust level 1, you hear after): http_request",
 *  "Trust raised for internal write: level 2 → 3") said with the agent's name. */
export function agentNoteTitle(agent: string, title: string): { title: string; body?: string } {
  const who = agent || 'An agent';
  const acted = title.match(/^Acted \(trust level (\d+), you hear after\): (.+)$/);
  if (acted) return { title: `${who} ran ${acted[2]} on its own`, body: `At trust level ${acted[1]} it acts first and you hear after.` };
  const trust = title.match(/^Trust (raised|lowered) for (.+): level (\d+) → (\d+)$/);
  if (trust) return { title: `${who}'s trust for ${trust[2]} went ${trust[1] === 'raised' ? 'up' : 'down'} to level ${trust[4]}` };
  return { title: fixPlurals(title) };
}

/** An envelope event's title ("Acme: company envelope at 85%") said plainly. */
export function budgetTitle(kind: 'budget_warn' | 'budget_stop', title: string): string {
  if (kind === 'budget_warn') {
    const x = title.match(/^(?:.*?: )?(.+?) envelope at (\d+)%$/);
    return x ? `The ${x[1]} budget is ${x[2]}% used` : title;
  }
  const x = title.match(/^(?:.*?: )?(.+?) budget reached/);
  return x ? `The ${x[1]} budget is used up, so a run was refused` : title;
}
