/**
 * Re-derives each first-party starter's `tunables` from its own profile
 * (chief-os.ts `deriveOperatingSystem`), keeping only the values that differ
 * from the catalog default — the rule tests/backend-builtin-companies.test.ts
 * checks. Run it whenever a tunable is added, then rebuild:
 *
 *   npm run blueprints:build   (runs this first)
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveOperatingSystem } from '../server/src/org/chief-os';
import { TUNABLES } from '../server/src/org/org-tunables';

const SRC = process.env.BLUEPRINTS_SRC || join(process.cwd(), 'blueprints/first-party');
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.company.json'))) {
  const path = join(SRC, f);
  const bp = JSON.parse(readFileSync(path, 'utf8'));
  const os = deriveOperatingSystem({ values: bp.profile.values, culture: bp.profile.culture, mission: bp.description, vision: bp.vision?.title, size: bp.roles.length });
  bp.tunables = Object.fromEntries(os.tunables.filter((t) => TUNABLES[t.key] && TUNABLES[t.key].default !== t.value).map((t) => [t.key, t.value]));
  writeFileSync(path, JSON.stringify(bp, null, 2) + '\n');
}
console.log(`derived tunables for ${SRC}`);
