/**
 * The starter kit catalog (docs/foundry.md §10.1) as **previews**: the Kits
 * shelf shows what each kit will bring — interfaces, recommended providers,
 * seats, cadences and outcome metrics — but nothing here installs. The kit
 * mechanism (kit.json, the combined review, the apply job) is Foundry F1;
 * until it ships every entry is `installable: false`, `status: 'coming_soon'`.
 *
 * Interfaces marked `planned` do not exist as plugins yet (§10.3).
 */

export interface KitPreview {
  id: string;
  name: string;
  blurb: string;
  /** BIZ_FUNCTIONS ids (src/lib/market.ts) the kit belongs to. */
  functions: string[];
  /** Company types it fits (Blueprints shelf filter). */
  companyTypes: string[];
  interfaces: Array<{ name: string; optional?: boolean; planned?: boolean }>;
  providers: string[];
  seats: string[];
  cadences: string[];
  metrics: string[];
  policies: string;
  status: 'coming_soon';
  installable: false;
}

const k = (x: Omit<KitPreview, 'status' | 'installable'>): KitPreview => ({ ...x, status: 'coming_soon', installable: false });

export const KIT_PREVIEWS: KitPreview[] = [
  k({ id: 'ship-software', name: 'Ship Software', blurb: 'An engineering team, its rhythm and DORA: sprints, releases, on-call and incident review.', functions: ['engineering'], companyTypes: ['saas', 'agency', 'open-source'],
    interfaces: [{ name: 'scm' }, { name: 'ci' }, { name: 'deploy' }, { name: 'observability' }, { name: 'issues', optional: true }],
    providers: ['GitHub', 'GitLab', 'Actions', 'Buildkite', 'Vercel', 'Fly', 'Sentry', 'Datadog', 'Linear'],
    seats: ['Engineering manager', 'Software engineer ×2', 'QA', 'SRE'],
    cadences: ['sprint planning (2w)', 'standup', 'weekly review', 'retro', 'release train', 'on-call handoff', 'incident review (event)'],
    metrics: ['deploy frequency', 'lead time', 'change failure rate', 'time to restore'], policies: 'merge to main and production release are two-key' }),
  k({ id: 'support-desk', name: 'Support Desk', blurb: 'A support queue with first response, CSAT and escalations under control.', functions: ['customer'], companyTypes: ['saas', 'e-commerce'],
    interfaces: [{ name: 'support' }, { name: 'issues', optional: true }, { name: 'billing', optional: true }],
    providers: ['Intercom', 'Zendesk', 'Linear', 'Stripe'], seats: ['CS manager', 'Support ×2', 'Onboarding (optional)'],
    cadences: ['queue review (daily)', 'weekly review', 'macro review (monthly)', 'escalation sync'],
    metrics: ['first response', 'CSAT', 'time to resolve', 'reopen rate'], policies: 'refunds two-key, sensitive replies cosign' }),
  k({ id: 'revenue', name: 'Revenue', blurb: 'Pipeline, forecast and deal desk, from first touch to renewal.', functions: ['sales', 'revops'], companyTypes: ['saas', 'services'],
    interfaces: [{ name: 'crm', planned: true }, { name: 'billing' }, { name: 'analytics', optional: true }],
    providers: ['HubSpot', 'Salesforce', 'Attio', 'Stripe', 'Paddle'], seats: ['Sales manager', 'Account executive', 'SDR', 'RevOps analyst'],
    cadences: ['pipeline review', 'forecast call', 'deal desk (event)', 'weekly review'],
    metrics: ['new ARR', 'pipeline created', 'win rate', 'forecast accuracy', 'net revenue retention'], policies: 'price changes two-key, contract send owner key' }),
  k({ id: 'growth', name: 'Growth', blurb: 'Activation and retention through experiments, campaigns and a weekly growth meeting.', functions: ['marketing'], companyTypes: ['saas', 'e-commerce', 'creator'],
    interfaces: [{ name: 'analytics' }, { name: 'marketing', planned: true }, { name: 'ads', optional: true, planned: true }, { name: 'cms', optional: true, planned: true }],
    providers: ['PostHog', 'Amplitude', 'Customer.io', 'Loops', 'Google Ads', 'Meta', 'Webflow'], seats: ['Marketing manager', 'Demand gen', 'SEO', 'BI analyst (optional)'],
    cadences: ['growth meeting (weekly)', 'experiment review', 'campaign calendar'],
    metrics: ['activation rate', 'signup conversion', 'experiment velocity', 'week-4 retention'], policies: 'large sends cosign, ad spend changes two-key' }),
  k({ id: 'compliance-soc2', name: 'Compliance (SOC 2)', blurb: 'Controls, evidence and access reviews on a schedule an auditor accepts.', functions: ['it-security'], companyTypes: ['saas', 'services'],
    interfaces: [{ name: 'compliance', planned: true }, { name: 'idp', planned: true }, { name: 'scm', optional: true }, { name: 'observability', optional: true }],
    providers: ['Vanta', 'Drata', 'Okta', 'Google Workspace'], seats: ['Security manager', 'GRC', 'Auditor'],
    cadences: ['control check (monthly)', 'access review (quarterly)', 'vendor review (quarterly)', 'policy review (yearly)'],
    metrics: ['controls passing', 'evidence freshness', 'finding age', 'access reviews on time'], policies: 'admin grants two-key, marking a control passing cosign' }),
  k({ id: 'content-studio', name: 'Content Studio', blurb: 'An editorial calendar that ships on time and learns from what performs.', functions: ['marketing'], companyTypes: ['agency', 'creator', 'open-source'],
    interfaces: [{ name: 'cms', planned: true }, { name: 'social', optional: true, planned: true }, { name: 'analytics', optional: true }],
    providers: ['Ghost', 'WordPress', 'Webflow', 'Buffer', 'PostHog'], seats: ['Editor-in-chief', 'Writer-editor', 'Brand designer', 'SEO (optional)'],
    cadences: ['editorial planning (weekly)', 'publish routine', 'performance review (monthly)'],
    metrics: ['pieces published on time', 'traffic per piece', 'subscriber growth'], policies: 'publishing cosign' }),
  k({ id: 'client-delivery', name: 'Client Delivery', blurb: 'Projects for clients on scope, on budget and invoiced on time.', functions: ['operations'], companyTypes: ['agency', 'services'],
    interfaces: [{ name: 'issues' }, { name: 'timesheets', planned: true }, { name: 'accounting', planned: true }, { name: 'scm', optional: true }, { name: 'files', optional: true }],
    providers: ['Linear', 'Jira', 'Harvest', 'Toggl', 'QuickBooks', 'Xero'], seats: ['Project lead', 'Program coordinator', 'Billing', 'Specialists by client work'],
    cadences: ['client status (weekly per project)', 'delivery review', 'invoicing (monthly)'],
    metrics: ['milestones on time', 'budget burn vs scope', 'utilisation', 'days to invoice'], policies: 'sending an invoice cosign' }),
  k({ id: 'commerce-ops', name: 'Commerce Ops', blurb: 'Orders, inventory and the monthly P&L for a shop.', functions: ['operations'], companyTypes: ['e-commerce'],
    interfaces: [{ name: 'commerce', planned: true }, { name: 'support' }, { name: 'fulfillment', optional: true, planned: true }, { name: 'accounting', optional: true, planned: true }],
    providers: ['Shopify', 'WooCommerce', 'Intercom', 'ShipStation', 'QuickBooks'], seats: ['Ops manager', 'Procurement', 'Support'],
    cadences: ['orders check (daily)', 'inventory review (weekly)', 'P&L review (monthly)'],
    metrics: ['fulfilment time', 'stockout days', 'refund rate', 'order defect rate'], policies: 'refunds and price changes two-key' }),
  k({ id: 'research', name: 'Research', blurb: 'A lab rhythm: literature, predictions reconciled and drafts to submission.', functions: ['data'], companyTypes: ['research'],
    interfaces: [{ name: 'literature', planned: true }, { name: 'files', optional: true }, { name: 'execution environments', optional: true }],
    providers: ['OpenAlex', 'Semantic Scholar', 'arXiv'], seats: ['Research lead', 'Analyst', 'Data scientist', 'Writer-editor'],
    cadences: ['seminar (derived; daily for a lab)', 'weekly review', 'quarterly agenda'],
    metrics: ['predictions reconciled', 'calibration (Brier)', 'drafts to submission'], policies: 'read-only sources' }),
  k({ id: 'hiring', name: 'Hiring', blurb: 'A recruiting pipeline with debriefs and fast candidate responses.', functions: ['people'], companyTypes: ['services', 'research'],
    interfaces: [{ name: 'ats', planned: true }, { name: 'mail', optional: true, planned: true }, { name: 'calendar', optional: true, planned: true }],
    providers: ['Ashby', 'Greenhouse', 'Lever'], seats: ['People manager', 'Recruiter'],
    cadences: ['pipeline review (weekly)', 'debrief (event: interview completed)'],
    metrics: ['time to hire', 'stage conversion', 'offer acceptance', 'candidate response time'], policies: 'offers owner key, rejections cosign' }),
  k({ id: 'finance-close', name: 'Finance Close', blurb: 'Month-end close, cash review and budget against actuals.', functions: ['finance'], companyTypes: ['saas', 'e-commerce', 'services', 'creator'],
    interfaces: [{ name: 'accounting', planned: true }, { name: 'banking', planned: true }, { name: 'billing', optional: true }],
    providers: ['QuickBooks', 'Xero', 'Mercury', 'Plaid'], seats: ['Finance manager', 'Accountant', 'FP&A (optional)'],
    cadences: ['month-end close (monthly window)', 'cash review (weekly)', 'budget vs actuals (quarterly)'],
    metrics: ['days to close', 'reconciliation rate', 'forecast accuracy'], policies: 'journal posts cosign; banking is read-only' }),
  k({ id: 'open-source-maintainer', name: 'Open-Source Maintainer', blurb: 'Triage, releases and a community that gets answers.', functions: ['engineering'], companyTypes: ['open-source'],
    interfaces: [{ name: 'issues' }, { name: 'packages', planned: true }, { name: 'forum', optional: true, planned: true }],
    providers: ['GitHub', 'npm', 'PyPI', 'crates.io', 'Discourse', 'Discord'], seats: ['Triager', 'Docs and changelog', 'Community lead (optional)'],
    cadences: ['issue triage (daily)', 'release (derived)', 'community call (monthly)', 'security advisory (event)'],
    metrics: ['time to first response', 'outside-contributor merge time', 'release cadence'], policies: 'package publish two-key' }),
];
