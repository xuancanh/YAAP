/**
 * Evidence-gated claims tunables (docs/evidence.md §5, docs/company-vision.md
 * §1b): how strictly each class of claim is gated (0 log, 1 mark unverified,
 * 2 block), how far back a tool call or action counts as evidence, how much
 * a claimed count may exceed the record, and when fabricated evidence
 * becomes an incident. Registered on the shared registry so `org_tune` and
 * `PUT …/org/tunables` reach them; the boundary reserves `claims.*` for the
 * CEO (they decide what counts as a fact). Every starter company derives
 * them from its own values and culture (`deriveClaimTunables`, called by
 * chief-os.ts `deriveOperatingSystem`); the defaults below are only the
 * fallback when no profile was read.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

const STRICT = '0 logged only, 1 lands flagged unverified and does not count until verified, 2 refused without evidence';

export const CLAIM_TUNABLES: Record<string, TunableDef> = {
  'claims.krCheckin': { default: 1, min: 0, max: 2, area: 'quality', description: `A key-result check-in value without evidence: ${STRICT}.` },
  'claims.projectUpdate': { default: 1, min: 0, max: 2, area: 'quality', description: `A project health update that states facts (done, sent, numbers): ${STRICT}.` },
  'claims.taskUpdate': { default: 1, min: 0, max: 2, area: 'quality', description: `A task update that states done/sent/published/contacted N: ${STRICT}.` },
  'claims.decision': { default: 1, min: 0, max: 2, area: 'quality', description: `An external fact (a number, a result) inside a decision proposed for the log: ${STRICT}.` },
  'claims.stepOutput': { default: 1, min: 0, max: 2, area: 'quality', description: `A process step output: ${STRICT}.` },
  'claims.lesson': { default: 0, min: 0, max: 2, area: 'quality', description: `A unit or company lesson stated as fact: ${STRICT}.` },
  'claims.evidenceWindowDays': { default: 7, min: 1, max: 90, area: 'quality', description: 'How far back a tool call, fetch or action of the author counts as evidence for a claim not tied to a task (a task\'s claims count from its creation).' },
  'claims.countTolerancePct': { default: 10, min: 0, max: 100, area: 'quality', description: 'How far (percent) a claimed count may exceed what the record shows before it is a mismatch.' },
  'claims.fabricationIncident': { default: 2, min: 1, max: 20, area: 'quality', description: 'Claims citing evidence that does not exist, by one member within the window, that open an incident.' },
  'claims.fabricationWindowHours': { default: 168, min: 1, max: 2_160, area: 'quality', description: 'The window, in hours, fabrications are counted over.' },
};
registerTunables(CLAIM_TUNABLES);

export function claimTunable(org: unknown, key: keyof typeof CLAIM_TUNABLES): number {
  return tunable(org as { tunables?: string | null } | null, key);
}

/** The values → mechanism map for claims: a rigour or control culture
 *  refuses unevidenced key-result values, step outputs and facts in
 *  decisions and opens an incident at the first fabrication; speed and
 *  experimentation let writes land flagged and only refuse what moves a
 *  key result. Pure; every value inside its bound. */
export function deriveClaimTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  const strict = rigor || c === 'hierarchy';
  const light = !strict && (speed || c === 'adhocracy');
  const numbers = strict || c === 'market';
  return [
    { key: 'claims.krCheckin', value: numbers ? 2 : 1, why: numbers ? (c === 'market' && !strict ? 'a results culture: a key-result value without evidence is refused' : 'rigour: a key-result value without evidence is refused') : 'an unevidenced key-result value lands flagged and does not move progress' },
    { key: 'claims.projectUpdate', value: strict ? 2 : 1, why: strict ? 'a project update that states facts cites them' : 'an unevidenced project update lands flagged' },
    { key: 'claims.taskUpdate', value: strict ? 2 : 1, why: strict ? '"done", "sent", "contacted N" on a task cite the record' : 'an unevidenced "done/sent N" on a task lands flagged' },
    { key: 'claims.decision', value: strict ? 2 : light ? 0 : 1, why: strict ? 'facts in a logged decision carry their source' : light ? 'decisions move fast; their facts are logged, not gated' : 'facts in a decision without a source are logged flagged' },
    { key: 'claims.stepOutput', value: strict ? 2 : 1, why: strict ? 'a process step output that later steps build on carries evidence' : 'an unevidenced step output reaches later steps flagged' },
    { key: 'claims.lesson', value: strict ? 1 : 0, why: strict ? 'a shared lesson stated as fact is kept marked until sourced' : 'lessons are judgement first; they are logged, not gated' },
    { key: 'claims.evidenceWindowDays', value: strict && stage !== 'early' ? 3 : 7, why: strict && stage !== 'early' ? 'evidence is recent: tool calls and actions from the last three days' : 'tool calls and actions from the last week count' },
    { key: 'claims.countTolerancePct', value: strict ? 0 : light ? 20 : 10, why: strict ? 'a claimed count matches the record exactly' : light ? 'a claimed count may round up by a fifth' : 'a claimed count may round up by a tenth' },
    { key: 'claims.fabricationIncident', value: strict ? 1 : light ? 3 : 2, why: strict ? 'one fabricated reference is an incident' : light ? 'three fabrications in the window is an incident' : 'two fabrications in the window is an incident' },
    { key: 'claims.fabricationWindowHours', value: strict ? 336 : 168, why: strict ? 'fabrications are counted over two weeks' : 'fabrications are counted over a week' },
  ].map((t) => { const def = CLAIM_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
