/**
 * The starter service catalog (docs/services.md "Templates"): what common
 * departments usually offer the rest of the company, as templates a head
 * adopts. A new company gets the ones whose department it has at
 * bootstrap (the head's title or the unit's name matches `unitHint`, as
 * process templates do); a company from before services sees them as a
 * library (`org_services library=true`, the Services page) and nothing is
 * activated for it. After adoption a service is the department's to change.
 *
 * Templates carry no SLA hours: a service starts from the company's
 * `service.acceptSlaHours` / `service.resolveSlaHours` (derived from its
 * values and culture), scaled by the template's `effort` — a contract
 * review takes longer than a launch-copy draft in any company.
 */
import type { ServiceField } from './service-model';

export interface ServiceTemplate {
  id: string;
  title: string;
  summary: string;
  /** Words matched against head titles and unit names to pick the providing unit. */
  unitHint: string[];
  /** Scales the company's resolve SLA (1 = the tunable as is); the accept SLA is never scaled. */
  effort: number;
  fields: ServiceField[];
}

const t = (name: string, label: string, required = true, description?: string): ServiceField => ({ name, label, type: 'text', required, ...(description ? { description } : {}) });
const choice = (name: string, label: string, options: string[], required = true): ServiceField => ({ name, label, type: 'choice', required, options });
const date = (name: string, label: string, required = false): ServiceField => ({ name, label, type: 'date', required });
const url = (name: string, label: string, required = false): ServiceField => ({ name, label, type: 'url', required });
const num = (name: string, label: string, required = true): ServiceField => ({ name, label, type: 'number', required });

const ENG = ['engineering', 'engineer', 'technology', 'cto', 'software', 'developer', 'platform'];

export const SERVICE_TEMPLATES: ServiceTemplate[] = [
  { id: 'bug-fix', title: 'Bug fix', summary: 'Fix a defect someone else found: reproduced, fixed, verified.', unitHint: ENG, effort: 1,
    fields: [t('summary', 'What is broken'), t('repro', 'Steps to reproduce', true, 'what you did, what happened, what you expected'), choice('severity', 'Severity', ['low', 'medium', 'high', 'critical']), url('link', 'Where it shows (a link)')] },
  { id: 'feature-estimate', title: 'Feature estimate', summary: 'A sized estimate (days, risk, options) for a feature before anyone commits to it.', unitHint: ENG, effort: 0.5,
    fields: [t('feature', 'The feature'), t('outcome', 'The outcome it should produce'), date('decide_by', 'When you must decide')] },
  { id: 'design-mockup', title: 'Mockup', summary: 'A mockup of a screen or flow, at the fidelity asked for.', unitHint: ['design', 'designer', 'ux', 'ui', 'creative', 'brand'], effort: 1,
    fields: [t('screen', 'Screen or flow'), t('goal', 'What the user must be able to do'), choice('fidelity', 'Fidelity', ['wireframe', 'high-fidelity']), url('references', 'References')] },
  { id: 'launch-copy', title: 'Launch copy', summary: 'Copy for a launch: announcement, page and posts for the channels named.', unitHint: ['marketing', 'content', 'growth', 'communications', 'copy', 'brand'], effort: 1,
    fields: [t('product', 'What is launching'), t('audience', 'Who it is for'), t('channels', 'Channels (blog, email, social, …)'), date('launch_date', 'Launch date')] },
  { id: 'budget-check', title: 'Budget check', summary: 'Whether a spend fits the budget, and from which line.', unitHint: ['finance', 'cfo', 'accounting', 'controller', 'treasury'], effort: 0.5,
    fields: [num('amount_usd', 'Amount (USD)'), t('purpose', 'What it buys'), t('budget_line', 'Budget line, if known', false)] },
  { id: 'contract-review', title: 'Contract review', summary: 'Review of a contract before it is signed: risks, redlines, go or no-go.', unitHint: ['legal', 'counsel', 'compliance', 'lawyer', 'contracts'], effort: 2,
    fields: [t('counterparty', 'Counterparty'), url('document', 'The contract (a link)', true), choice('kind', 'Kind', ['nda', 'msa', 'sow', 'order form', 'other']), date('sign_by', 'Must be signed by')] },
  { id: 'sales-quote', title: 'Customer quote', summary: 'A priced quote for a prospect or customer.', unitHint: ['sales', 'account', 'revenue', 'business development', 'bizdev'], effort: 0.5,
    fields: [t('customer', 'Customer'), t('scope', 'What they want'), num('seats', 'Seats or units', false)] },
  { id: 'customer-escalation', title: 'Customer escalation', summary: 'Take over a customer problem the requester cannot solve.', unitHint: ['support', 'customer', 'success', 'service', 'cx'], effort: 0.5,
    fields: [t('customer', 'Customer'), t('issue', 'The problem'), choice('impact', 'Impact', ['one user', 'one account', 'many accounts'])] },
  { id: 'data-pull', title: 'Data pull', summary: 'A number or a table answering one question, with its source.', unitHint: ['data', 'analytics', 'analyst', 'insights', 'research', 'bi'], effort: 0.5,
    fields: [t('question', 'The question'), t('period', 'Period', false), t('format', 'How you want it (number, table, chart)', false)] },
  { id: 'hiring-request', title: 'Hiring request', summary: 'Open a seat: the role, why now and the budget.', unitHint: ['people', 'hr', 'talent', 'recruit', 'hiring'], effort: 2,
    fields: [t('role', 'The role'), t('why_now', 'Why now'), num('budget_usd', 'Monthly budget (USD)', false)] },
  { id: 'prioritization-review', title: 'Prioritization review', summary: 'Product decides where an ask lands on the roadmap, and why.', unitHint: ['product', 'pm', 'roadmap'], effort: 0.5,
    fields: [t('proposal', 'The ask'), t('evidence', 'Evidence (customers, numbers)'), date('decide_by', 'When you need the answer')] },
];

export function serviceTemplateById(id: string): ServiceTemplate | undefined {
  return SERVICE_TEMPLATES.find((x) => x.id === id);
}
