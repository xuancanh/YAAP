/**
 * Service tunables (docs/services.md "Tunables"): the accept and resolve
 * SLAs a new service starts with, what a missed accept SLA does, when a
 * repeated unlisted ask is flagged to the provider as a service to define,
 * whether a head's edit to its catalog applies at once, and the window the
 * metrics cover. Registered on the one registry of org-tunables.ts
 * (`org_tune`, `PUT …/org/tunables`); onboarding derives starting values
 * from the operating profile (`deriveServiceTunables`, called by chief-os.ts
 * `deriveOperatingSystem`) — speed answers in hours, a hierarchy formalises
 * the catalog early and approves its edits, a people-first culture nudges
 * before it escalates. The defaults below are only the fallback when no
 * profile was read; a service's own hours are set from them when it is
 * created and are the head's to change after that.
 */
import { registerTunables, tunable, type TunableDef } from './org-tunables';
import type { ProfileDiagnosis } from './chief-os';

export const SERVICE_TUNABLES: Record<string, TunableDef> = {
  'service.acceptSlaHours': { default: 8, min: 1, max: 168, area: 'service', description: 'Hours a new service gives its provider to answer a request (accept with a date, decline with a reason, or negotiate) before the request is breached and climbs the provider\'s line.' },
  'service.resolveSlaHours': { default: 72, min: 2, max: 1_440, area: 'service', description: 'Hours a new service gives from request to delivery when the provider commits no date of its own.' },
  'service.breachAction': { default: 1, min: 0, max: 1, area: 'service', description: 'What a request past its accept SLA does: 1 a breach card up the provider\'s line (its head, then the chief, then the CEO); 0 a nudge to the provider and a note to its head.' },
  'service.suggestAfterRepeats': { default: 3, min: 2, max: 10, area: 'service', description: 'Unlisted asks of the same kind to one department (within service.repeatWindowDays) before its head is asked to define a service for it.' },
  'service.repeatWindowDays': { default: 30, min: 7, max: 180, area: 'service', description: 'Days the repeat count of an unlisted ask looks back.' },
  'service.editApproval': { default: 1, min: 0, max: 2, area: 'service', description: 'Whether an agent\'s change to a service it owns applies at once: 0 every change applies; 1 a looser SLA, another answering role, another process or fewer required fields waits for an approval card to the editor\'s manager; 2 every change does.' },
  'service.metricsWindowDays': { default: 30, min: 7, max: 180, area: 'service', description: 'Days of requests the service metrics (acceptance and resolve time, breach and decline rates) cover.' },
};
registerTunables(SERVICE_TUNABLES);

export function serviceTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof SERVICE_TUNABLES): number {
  return tunable(org, key);
}

/** Starting values from the profile. Pure; values stay inside each bound. */
export function deriveServiceTunables(d: Pick<ProfileDiagnosis, 'stage' | 'cultureType' | 'speed' | 'rigor'>): Array<{ key: string; value: number; why: string }> {
  const { stage, cultureType: c, speed, rigor } = d;
  return [
    { key: 'service.acceptSlaHours', value: speed ? 4 : c === 'hierarchy' ? 24 : stage === 'early' ? 4 : 8, why: speed ? 'speed is a value: a request is answered within hours' : c === 'hierarchy' ? 'a formal intake answers within a working day' : stage === 'early' ? 'a small company answers the same morning' : 'a request is answered within a working day\'s half' },
    { key: 'service.resolveSlaHours', value: speed ? 48 : c === 'hierarchy' || rigor ? 120 : 72, why: speed ? 'delivered within two days unless the provider commits another date' : c === 'hierarchy' || rigor ? 'a week for the work and its checks' : 'three days unless the provider commits another date' },
    { key: 'service.breachAction', value: c === 'clan' && !rigor ? 0 : 1, why: c === 'clan' && !rigor ? 'a people-first culture nudges the provider before it escalates' : 'silence on a request is a breach: it climbs the provider\'s line' },
    { key: 'service.suggestAfterRepeats', value: c === 'hierarchy' || rigor ? 2 : c === 'adhocracy' ? 4 : 3, why: c === 'hierarchy' || rigor ? 'a control culture formalises an ask the second time it comes' : c === 'adhocracy' ? 'ad-hoc asks are normal: only a pattern becomes a service' : 'the third time an ask comes it deserves a service' },
    { key: 'service.repeatWindowDays', value: stage === 'early' ? 14 : 30, why: stage === 'early' ? 'a small company\'s asks change fast: two weeks of history' : 'a month of asks' },
    { key: 'service.editApproval', value: c === 'hierarchy' ? 2 : speed || c === 'adhocracy' ? 0 : 1, why: c === 'hierarchy' ? 'a control culture approves every change to what a department promises' : speed || c === 'adhocracy' ? 'a head changes its catalog at once, versioned' : 'a looser promise (a longer SLA, fewer required fields) is approved by the head\'s manager' },
    { key: 'service.metricsWindowDays', value: rigor ? 60 : stage === 'early' ? 14 : 30, why: rigor ? 'evidence before a change: two months of requests' : stage === 'early' ? 'a small company judges on recent requests' : 'the last month of requests' },
  ].map((t) => { const def = SERVICE_TUNABLES[t.key]; return { ...t, value: Math.min(def.max, Math.max(def.min, t.value)) }; });
}
