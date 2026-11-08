/**
 * Quality-control tunables (docs/quality.md, docs/company-vision.md §1b):
 * how much evidence a submission must cite, how independent its verifier
 * must be, the default pass bar, how much accepted work is spot-checked
 * again, when escapes and repeated policy violations become incidents, and
 * how policy and standard changes are approved. Registered on the shared
 * registry so `org_tune` and `PUT …/org/tunables` reach them; the boundary
 * reserves `quality.*` and `policy.*` for the CEO (they decide what counts
 * as verified work). Every starter company derives them from its own values
 * and culture (`deriveQualityTunables`), never from a fixed default.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const QUALITY_TUNABLES: Record<string, TunableDef> = {
  'quality.evidenceRequired': { default: 1, min: 0, max: 2, area: 'quality', description: 'Evidence a review submission must cite: 0 none required, 1 every criterion of the applicable quality standard, 2 also at least one real reference when no standard applies.' },
  'quality.verifierIndependence': { default: 1, min: 0, max: 2, area: 'quality', description: 'Who verifies: 0 any member other than the maker, 1 prefer another model family, 2 require another model family whenever one is on the roster.' },
  'quality.defaultPassScore': { default: 3.5, min: 2.5, max: 5, area: 'quality', description: 'The weighted pass bar (1–5) of a standard that names none.' },
  'quality.spotCheckPct': { default: 10, min: 0, max: 100, area: 'quality', description: 'Percent of accepted work that skipped graded review (accepted by check, or with no standard) re-verified after acceptance.' },
  'quality.spotCheckReviewedPct': { default: 3, min: 0, max: 100, area: 'quality', description: 'Percent of accepted, graded work re-verified after acceptance.' },
  'quality.spotChecksPerDay': { default: 3, min: 0, max: 50, area: 'quality', description: 'At most this many spot-check tasks a day (0 = model-free re-verification only).' },
  'quality.escapeIncident': { default: 2, min: 1, max: 20, area: 'quality', description: 'Defect escapes (accepted work later reopened, failed a spot check or tied to an incident) by one member within a week that open an incident.' },
  'policy.authoringApproval': { default: 1, min: 0, max: 2, area: 'quality', description: 'Who approves policy and standard changes: 0 the mode decides (autonomous applies, supervised is a card), 1 a blocking policy is always the CEO\'s card, 2 every policy and standard change is a card.' },
  'policy.repeatForIncident': { default: 3, min: 1, max: 50, area: 'quality', description: 'Violations of one policy by one member within the window that open an incident.' },
  'policy.repeatWindowHours': { default: 168, min: 1, max: 2_160, area: 'quality', description: 'The window, in hours, repeated violations are counted over.' },
  'policy.signalSeverity': { default: 3, min: 1, max: 4, area: 'quality', description: 'A single violation at or above this severity (1 low, 2 medium, 3 high, 4 critical) opens a signal for the chief at once.' },
};
registerTunables(QUALITY_TUNABLES);

export function qualityTunable(org: unknown, key: keyof typeof QUALITY_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}

/** The values → mechanism map for quality (docs/quality.md "Tunables"): a
 *  rigour or control culture asks for more evidence, a stricter verifier, a
 *  higher bar and more spot checks; speed and experimentation keep them
 *  lighter. Pure; every value inside its bound. */
export function deriveQualityTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const strict = rigor || c === 'hierarchy';
  const light = !strict && (speed || c === 'adhocracy');
  return [
    { key: 'quality.evidenceRequired', value: strict ? 2 : 1, why: strict ? 'rigour: every submission cites real evidence, standard or not' : 'evidence for every criterion of a standard; free-form work cites what it can' },
    { key: 'quality.verifierIndependence', value: strict ? 2 : c === 'clan' ? 0 : 1, why: strict ? 'a control culture: another model family verifies whenever one exists' : c === 'clan' ? 'a people-first culture: a colleague verifies, any model' : 'another model family verifies when one is available' },
    { key: 'quality.defaultPassScore', value: strict ? 4 : light ? 3 : 3.5, why: strict ? 'a high bar: work passes at 4 of 5' : light ? 'speed is a value: good enough to ship passes at 3 of 5' : 'work passes at 3.5 of 5' },
    { key: 'quality.spotCheckPct', value: strict ? 25 : light ? 5 : c === 'market' ? 10 : 10, why: strict ? 'a quarter of unreviewed work is checked again after acceptance' : light ? 'a light touch: one in twenty unreviewed results is checked again' : 'one in ten unreviewed results is checked again' },
    { key: 'quality.spotCheckReviewedPct', value: strict ? 8 : light ? 1 : 3, why: strict ? 'reviewed work is sampled too, to keep reviewers honest' : 'reviewed work is sampled lightly' },
    { key: 'quality.spotChecksPerDay', value: stage === 'early' ? 2 : strict ? 6 : 3, why: stage === 'early' ? 'a small company spends little on checking checked work' : strict ? 'room for a formal spot-check programme' : 'a few spot checks a day' },
    { key: 'quality.escapeIncident', value: strict ? 1 : light ? 3 : 2, why: strict ? 'one escaped defect is an incident' : light ? 'an escape is a lesson first; three in a week is an incident' : 'two escapes in a week is an incident' },
    { key: 'policy.authoringApproval', value: c === 'hierarchy' ? 2 : light ? 0 : 1, why: c === 'hierarchy' ? 'a control culture: every policy and standard change is the CEO\'s' : light ? 'the mode decides; autonomous companies set their own standards' : 'blocking policies are always the CEO\'s call' },
    { key: 'policy.repeatForIncident', value: strict ? 2 : light ? 5 : 3, why: strict ? 'a repeated violation is an incident on the second time' : light ? 'repeated warnings become an incident after five' : 'three violations of one policy in the window is an incident' },
    { key: 'policy.repeatWindowHours', value: strict ? 336 : 168, why: strict ? 'violations are counted over two weeks' : 'violations are counted over a week' },
    { key: 'policy.signalSeverity', value: strict ? 2 : 3, why: strict ? 'a medium violation already reaches the chief' : 'high and critical violations reach the chief at once' },
  ].map((t) => { const def = QUALITY_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
