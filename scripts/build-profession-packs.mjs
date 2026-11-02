/**
 * Builds server/src/market/profession-packs.generated.ts from a checkout of
 * anthropics/knowledge-work-plugins. Each plugin becomes a "profession pack":
 * a market agent whose hire installs the plugin's skills (SKILL.md bodies,
 * plus any bundled reference *.md files) as agent-private skills.
 *
 *   node scripts/build-profession-packs.mjs /path/to/knowledge-work-plugins
 *
 *   node scripts/build-profession-packs.mjs --meta-only
 *
 * --meta-only re-applies the PACKS metadata below (name, category, segment,
 * function, level, colours, loops, charter) to the committed output without a
 * checkout: the plugin taglines and skill bodies are kept as they are.
 *
 * Segments (docs/agent-catalog.md "Segments and functions"): a pack whose
 * plugin is one job function's toolkit (sales, finance, legal, engineering,
 * ...) is in the business segment, filed under that function as a
 * specialist-level generalist (no reporting line: it brings no head
 * playbooks and works standalone or under the function's head). A pack for
 * one person's own shop or research (Shopkeeper, Research Desk) stays
 * personal with its category.
 *
 * The output file is committed, so the build never needs the clone. Skipped
 * plugins: bio-research (depends on bundled Python scripts we cannot run),
 * productivity (duplicates native tasks/memory), pdf-viewer and
 * cowork-plugin-management (Claude-Code-specific), partner-built (connectors).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const META_ONLY = process.argv[2] === '--meta-only';
const SRC = process.argv[2];
if (!META_ONLY && (!SRC || !existsSync(join(SRC, 'marketing', 'skills')))) {
  console.error('usage: node scripts/build-profession-packs.mjs <knowledge-work-plugins checkout> | --meta-only');
  process.exit(1);
}
const OUT = new URL('../server/src/market/profession-packs.generated.ts', import.meta.url).pathname;

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SKILL_CAP = 48_000;

/** Shared charter tail: how every profession agent works day to day. */
const CHARTER_TAIL = `
Work out of your own folder: keep durable outputs (briefs, reports, trackers, templates) as files, not just chat replies. You carry a library of profession playbooks installed as skills; when a request matches one, invoke it and follow it, adapting any placeholder tools or data sources to what the user actually has. If a playbook assumes a connected system (CRM, ticketing, analytics), ask the user to paste or upload the data instead. Ask for missing company context rather than inventing it. As you learn how this user works, propose profile entries and draft new skills for their approval. When the user has granted you a connected service (calendar, mail), prefer it over your file copies: read real dates with the gcal tools instead of a markdown calendar, and draft email with gmail_draft for the user to review — send only on their standing instruction. Keep files as the fallback when no connection is granted.`;

const PACKS = [
  {
    dir: 'marketing', id: 'pro-marketing', name: 'Marketer', emoji: '📣', role: 'Marketing',
    colors: ['#f06292', '#c2185b'], segment: 'business', function: 'marketing', level: 'specialist', cat: 'Workplace',
    charter: 'You are Marketer, a hands-on marketing partner: content, campaigns, brand voice, SEO, and performance reporting.',
  },
  {
    dir: 'sales', id: 'pro-sales', name: 'Sales Partner', emoji: '🤝', role: 'Sales',
    colors: ['#5ca8f2', '#2f5fd0'], segment: 'business', function: 'sales', level: 'specialist', cat: 'Workplace',
    charter: 'You are Sales Partner: account research, call prep and summaries, outreach drafts, pipeline and forecast reviews.',
    loops: [{ name: 'Daily sales briefing', cron: '0 8 * * 1-5', prompt: 'Run your daily-briefing skill: review the working folder for pipeline and account notes, then write today’s briefing to briefings/<date>.md and summarize the top 3 actions.' }],
  },
  {
    dir: 'customer-support', id: 'pro-support', name: 'Support Desk', emoji: '🎧', role: 'Customer Support',
    colors: ['#3ad6b0', '#159e86'], segment: 'business', function: 'customer', level: 'specialist', cat: 'Workplace',
    charter: 'You are Support Desk: triage tickets, draft empathetic responses, handle escalations, and turn resolved issues into KB articles.',
  },
  {
    dir: 'finance', id: 'pro-finance', name: 'Bookkeeper', emoji: '💰', role: 'Finance & Accounting',
    colors: ['#8bc34a', '#33691e'], segment: 'business', function: 'finance', level: 'specialist', cat: 'Legal & Finance',
    charter: 'You are Bookkeeper, a finance and accounting assistant: journal entries, reconciliations, close management, variance analysis, and audit support. You prepare and explain; a human accountant approves.',
  },
  {
    dir: 'legal', id: 'pro-legal', name: 'Counsel', emoji: '⚖️', role: 'Legal',
    colors: ['#b39ddb', '#5e35b1'], segment: 'business', function: 'legal', level: 'specialist', cat: 'Legal & Finance',
    charter: 'You are Counsel, a legal operations assistant: contract review, NDA triage, compliance checks, and risk assessments. You are not a lawyer and never give legal advice; you prepare analysis for qualified review.',
  },
  {
    dir: 'human-resources', id: 'pro-hr', name: 'People Partner', emoji: '🧑‍💼', role: 'Human Resources',
    colors: ['#ffb74d', '#ef6c00'], segment: 'business', function: 'people', level: 'specialist', cat: 'Workplace',
    charter: 'You are People Partner: recruiting pipelines, interview prep, offers, onboarding, comp analysis, and performance cycles. Treat all people data as confidential and keep it inside the working folder.',
  },
  {
    dir: 'operations', id: 'pro-operations', name: 'Ops Manager', emoji: '⚙️', role: 'Operations',
    colors: ['#90a4ae', '#455a64'], segment: 'business', function: 'operations', level: 'specialist', cat: 'Workplace',
    charter: 'You are Ops Manager: process docs, runbooks, change requests, capacity plans, vendor reviews, and status reports.',
  },
  {
    dir: 'small-business', id: 'pro-smb', name: 'Shopkeeper', emoji: '🏪', role: 'Small Business',
    colors: ['#ffd54f', '#f57f17'], segment: 'personal', cat: 'Small Business',
    charter: 'You are Shopkeeper, an all-in-one copilot for a small business owner: sales, invoices, cash flow, customers, hiring, and month-end, all without assuming a big-company stack.',
    loops: [
      { name: 'Monday brief', cron: '0 8 * * 1', prompt: 'Run your monday-brief skill against the working folder and write the week’s brief to briefs/<date>-monday.md.' },
      { name: 'Friday wrap', cron: '0 16 * * 5', prompt: 'Run your friday-brief skill: wrap the week, flag unpaid invoices and follow-ups, write briefs/<date>-friday.md.' },
    ],
  },
  {
    dir: 'product-management', id: 'pro-product', name: 'Product Manager', emoji: '🧭', role: 'Product',
    colors: ['#4dd0e1', '#00838f'], segment: 'business', function: 'product', level: 'specialist', cat: 'Product & Engineering',
    charter: 'You are Product Manager: specs, roadmaps, sprint planning, metrics reviews, research synthesis, and stakeholder updates.',
  },
  {
    dir: 'design', id: 'pro-design', name: 'Design Partner', emoji: '🎨', role: 'Design',
    colors: ['#f48fb1', '#ad1457'], segment: 'business', function: 'design', level: 'specialist', cat: 'Product & Engineering',
    charter: 'You are Design Partner: design critique, accessibility review, UX copy, research synthesis, and design-system upkeep.',
  },
  {
    dir: 'data', id: 'pro-data', name: 'Data Analyst', emoji: '📊', role: 'Data & Analytics',
    colors: ['#7986cb', '#283593'], segment: 'business', function: 'data', level: 'specialist', cat: 'Product & Engineering',
    charter: 'You are Data Analyst: explore datasets, write and explain SQL, run statistical analysis, validate data, and build visualizations and dashboards from files the user shares.',
  },
  {
    dir: 'engineering', id: 'pro-engineering', name: 'Engineer', emoji: '🛠️', role: 'Engineering',
    colors: ['#a1887f', '#4e342e'], segment: 'business', function: 'engineering', level: 'specialist', cat: 'Product & Engineering',
    charter: 'You are Engineer: code review, architecture and system design, debugging, testing strategy, incident response, and docs.',
  },
  {
    dir: 'enterprise-search', id: 'pro-research', name: 'Research Desk', emoji: '🔎', role: 'Research',
    colors: ['#81d4fa', '#0277bd'], segment: 'personal', cat: 'Workplace',
    charter: 'You are Research Desk: multi-source search strategy, source management, knowledge synthesis, and digest writing over the user’s files and the web.',
  },
];

function parseFrontmatter(md) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md);
  if (!m) return { meta: {}, body: md };
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z-]+):\s?(.*)$/.exec(line);
    if (kv) { key = kv[1]; meta[key] = kv[2].replace(/^["']|["']$/g, ''); }
    else if (key && /^\s+\S/.test(line)) meta[key] += ' ' + line.trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

function cleanBody(body) {
  return body
    .split('\n')
    .filter((l) => !l.includes('CONNECTORS.md'))
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function referenceDocs(skillDir) {
  const docs = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md') && e !== 'SKILL.md' && !/license/i.test(e)) {
        docs.push({ rel: relative(skillDir, p), text: readFileSync(p, 'utf8').trim() });
      }
    }
  };
  walk(skillDir);
  return docs;
}

function buildSkill(skillDir, name) {
  const raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  let instructions = cleanBody(body);
  for (const doc of referenceDocs(skillDir)) {
    if (instructions.length >= SKILL_CAP) break;
    instructions += `\n\n---\n\n## Bundled reference: ${doc.rel}\n\n${doc.text}`;
  }
  if (instructions.length > SKILL_CAP) instructions = instructions.slice(0, SKILL_CAP) + '\n\n[truncated]';
  return { name, description: String(meta.description ?? '').slice(0, 500), instructions };
}

/** The fields every pack carries, in the order the generated file lists them. */
function packOf(p, tagline, skills) {
  return {
    id: p.id, name: p.name, emoji: p.emoji, role: p.role, colors: p.colors,
    author: 'Anthropic · knowledge-work-plugins', verified: true, stars: '5.0', installs: 'curated pack',
    cat: p.cat, segment: p.segment,
    ...(p.segment === 'business' ? { function: p.function, level: p.level } : {}),
    price: 'free',
    tagline,
    caps: ['fs', 'web_search', `${skills.length} skills`],
    capsFull: [
      { name: 'fs_read / fs_write', desc: 'Keep briefs, reports, and trackers in its working folder', icon: 'file' },
      { name: 'web_search', desc: 'Research the outside world when a playbook calls for it', icon: 'globe' },
      { name: `${skills.length} profession skills`, desc: 'Installed private to this agent; review them in Skills & tools', icon: 'board' },
    ],
    loops: p.loops ?? [],
    charter: p.charter + '\n' + CHARTER_TAIL.trim(),
    skills,
  };
}

for (const p of PACKS) {
  if (p.segment !== 'personal' && p.segment !== 'business') throw new Error(`${p.id}: segment`);
  if (p.segment === 'business' && (!p.function || p.level !== 'specialist')) throw new Error(`${p.id}: a business pack names its function and level`);
}

/** The committed output, parsed back (for --meta-only). */
function committed() {
  const raw = readFileSync(OUT, 'utf8');
  const marker = 'export const PROFESSION_PACKS = ';
  const start = raw.indexOf(marker) + marker.length;
  const end = raw.lastIndexOf(' as unknown as MarketItem[]');
  return new Map(JSON.parse(raw.slice(start, end)).map((x) => [x.id, x]));
}

const packs = META_ONLY ? (() => {
  const old = committed();
  return PACKS.map((p) => {
    const prev = old.get(p.id);
    if (!prev) throw new Error(`${p.id} is not in the committed output; run a full build`);
    return packOf(p, prev.tagline, prev.skills);
  });
})() : PACKS.map((p) => {
  const pluginMeta = JSON.parse(readFileSync(join(SRC, p.dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const skillsDir = join(SRC, p.dir, 'skills');
  const skills = readdirSync(skillsDir).sort()
    .filter((e) => NAME_RE.test(e) && statSync(join(skillsDir, e)).isDirectory() && existsSync(join(skillsDir, e, 'SKILL.md')))
    .map((e) => buildSkill(join(skillsDir, e), e));
  return packOf(p, String(pluginMeta.description ?? '').slice(0, 200), skills);
});

const header = `/**
 * AUTO-GENERATED by scripts/build-profession-packs.mjs from
 * anthropics/knowledge-work-plugins — do not edit by hand. Regenerate with:
 *   node scripts/build-profession-packs.mjs <checkout>   (metadata only: --meta-only)
 */
import type { MarketItem } from './market.catalog';

export const PROFESSION_PACKS = `;

writeFileSync(OUT, header + JSON.stringify(packs, null, 1) + ' as unknown as MarketItem[];\n');
const total = packs.reduce((n, p) => n + p.skills.length, 0);
console.log(`wrote ${OUT}: ${packs.length} packs, ${total} skills, ${(statSync(OUT).size / 1024).toFixed(0)} KB`);
