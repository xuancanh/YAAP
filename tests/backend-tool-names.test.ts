/**
 * Tool names must be unique in a request — OpenAI-compatible providers refuse
 * one that repeats a name ("Tool names must be unique"). Each org tool
 * provider defines its own specs, so a name defined by two providers would
 * reach an agent twice. Within one file a name may repeat across role lists
 * (the auditor's and a member's), never across files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueToolSpecs } from '../server/src/chats/turn-loop.service';

const ORG = join(process.cwd(), 'server', 'src', 'org');

test('no org tool name is defined by two providers', () => {
  const owner = new Map<string, string>();
  const clashes: string[] = [];
  for (const file of readdirSync(ORG).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(ORG, file), 'utf8');
    for (const m of new Set([...src.matchAll(/\{ name: '((?:org|meeting)_[a-z_]+)', description:/g)].map((x) => x[1]))) {
      const prev = owner.get(m);
      if (prev && prev !== file) clashes.push(`${m}: ${prev} and ${file}`);
      else owner.set(m, file);
    }
  }
  assert.deepEqual(clashes, []);
});

test('uniqueToolSpecs keeps the first of a repeated name and reports it', () => {
  const seen: string[] = [];
  const out = uniqueToolSpecs([{ name: 'a', v: 1 }, { name: 'b', v: 1 }, { name: 'a', v: 2 }], (n) => seen.push(n));
  assert.deepEqual(out, [{ name: 'a', v: 1 }, { name: 'b', v: 1 }]);
  assert.deepEqual(seen, ['a']);
});
