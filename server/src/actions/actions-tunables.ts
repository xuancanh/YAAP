/**
 * Action-contract and trust-ledger tunables (docs/actions-and-trust.md §7,
 * docs/company-vision.md §1b, execution-plan item 28). Registered on the
 * shared registry so `org_tune` and `PUT …/org/tunables` reach them; the
 * bounds are the fence. A workspace without an organization reads the
 * defaults (private chats get the same contract).
 */
import { registerTunables, tunable, type TunableDef } from '../org/org-tunables';

export const ACTIONS_TUNABLES: Record<string, TunableDef> = {
  'actions.externalPerHour': { default: 30, min: 1, max: 500, area: 'actions', description: 'Outward actions (reversible or irreversible) one outbound channel (gmail, calendar, drive, browser, an MCP server, …) may take per workspace per hour; beyond it the call is refused with the reason.' },
  'actions.irreversiblePerDay': { default: 20, min: 0, max: 200, area: 'actions', description: 'Irreversible outward actions (a sent email, an invitation) per workspace per day.' },
  'actions.moneyPerDay': { default: 0, min: 0, max: 50, area: 'actions', description: 'Money-moving actions per workspace per day; 0 = none, whatever the trust level.' },
  'actions.dedupeWindowMinutes': { default: 1_440, min: 5, max: 10_080, area: 'actions', description: 'Minutes within which a retry of a succeeded outward action returns the recorded result instead of acting twice.' },
  'trust.promoteAfterClean': { default: 10, min: 3, max: 100, area: 'trust', description: 'Clean outcomes in one action class since the last level change before the ledger raises that member one level (never above the owner\'s ceiling).' },
  'trust.demoteAfterRejections': { default: 3, min: 1, max: 10, area: 'trust', description: 'Rejections in a row (review sent back, co-signer or owner said no) before the ledger lowers that member one level.' },
  'trust.calibrationBar': { default: 0.7, min: 0, max: 1, area: 'trust', description: 'Forecast calibration (0–1) a member needs for a promotion once the prediction ledger exists; ignored until then.' },
};
registerTunables(ACTIONS_TUNABLES);

export function actionsTunable(org: { tunables?: string | null } | null | undefined, key: keyof typeof ACTIONS_TUNABLES): number {
  return tunable(org, key);
}
