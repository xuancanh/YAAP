/**
 * The calibration seam (docs/experiments.md §2.3, execution-plan item 30):
 * one provider answers "how well calibrated are this member's forecasts" as
 * a 0–1 score, or null when it has too few resolved forecasts. The
 * prediction ledger (OrgPredictionsService) registers itself here at
 * construction; the trust ledger (item 28, `trust.service.ts`
 * `calibrationOf`) reads it through `calibrationOf` without importing the
 * org module. A module-level registry rather than an injected service so
 * neither side depends on the other's construction order; the last
 * registration wins, and unregistering restores null.
 */

export interface CalibrationProvider {
  /** 1 − the mean loss of the member's last N resolved forecasts (0–1); null with too few. */
  calibrationOf(workspaceId: string, agentId: string): Promise<number | null>;
}

let provider: CalibrationProvider | null = null;

/** Register the provider (an object or a bare function); returns the undo. */
export function registerCalibrationProvider(p: CalibrationProvider | CalibrationProvider['calibrationOf']): () => void {
  const next: CalibrationProvider = typeof p === 'function' ? { calibrationOf: p } : p;
  provider = next;
  return () => { if (provider === next) provider = null; };
}

/** The member's calibration, or null when no provider is registered or it has too few forecasts. */
export async function calibrationOf(workspaceId: string, agentId: string): Promise<number | null> {
  if (!provider) return null;
  try {
    const v = await provider.calibrationOf(workspaceId, agentId);
    return v === null || !Number.isFinite(v) ? null : Math.min(1, Math.max(0, v));
  } catch {
    return null;
  }
}
