/**
 * How an interrupted run reads (docs/work-log.md "Interrupted",
 * docs/architecture.md "Restarts and recovery"): a server restart cut it
 * short — not an error, so never red. The suffix says what the boot after
 * did with it: re-ran it (resumed), stopped mid-action and left it for you
 * to check (held), or left it for a Retry.
 */
export type RecoveryState = string | null | undefined;

export function interruptedLabel(recovery: RecoveryState): string {
  if (recovery === 'resumed') return 'Interrupted by a restart · resumed';
  if (recovery === 'held') return 'Interrupted by a restart mid-action · check it';
  return 'Interrupted by a restart · retry';
}

/** Whether a Retry is the next step (not resumed, not held for a check). */
export function retryable(recovery: RecoveryState): boolean {
  return recovery !== 'resumed' && recovery !== 'held';
}
