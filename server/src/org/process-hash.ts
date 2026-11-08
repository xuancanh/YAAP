/** The process hashes (docs/processes.md): a definition's content hash and
 *  a run's ramp bucket. Apart from process-model.ts so that the pure model
 *  has no Node imports and the SPA's editor can validate with it. */
import { createHash } from 'node:crypto';
import type { ProcessDef } from './process-model';

export function processHash(def: ProcessDef): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex').slice(0, 16);
}

/** A run's bucket 0–99 for a ramp (deterministic per key). Pure. */
export function rampBucket(key: string): number {
  return parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) % 100;
}
