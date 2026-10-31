/** Quiet hours + interrupt policy (roadmap phase 2.3): window math across
 *  midnight and timezones, the three delivery policies, and the workspace
 *  PATCH validation that keeps a malformed config out of the row. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { isQuiet, deliveryFor, parseQuietHours, validateQuietHours } from '../server/src/workspaces/quiet-hours';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { testDb, memStorage } from './helpers';

const berlinNight = { start: '22:00', end: '07:00', timezone: 'Europe/Berlin', policy: 'queue' as const };

test('isQuiet: a window crossing midnight, evaluated on the zone wall clock', () => {
  // 2026-01-15 23:30 Berlin (CET, UTC+1) = 22:30Z → inside
  const late = isQuiet(berlinNight, new Date('2026-01-15T22:30:00Z'));
  assert.equal(late.quiet, true);
  assert.equal(late.until?.toISOString(), '2026-01-16T06:00:00.000Z', 'ends 07:00 Berlin the next morning');

  // 03:00 Berlin = 02:00Z → inside, same morning end
  const early = isQuiet(berlinNight, new Date('2026-01-16T02:00:00Z'));
  assert.equal(early.quiet, true);
  assert.equal(early.until?.toISOString(), '2026-01-16T06:00:00.000Z');

  // 07:00 Berlin exactly → the window is half-open, so not quiet
  assert.equal(isQuiet(berlinNight, new Date('2026-01-16T06:00:00Z')).quiet, false);
  // 12:00 Berlin → not quiet
  assert.equal(isQuiet(berlinNight, new Date('2026-01-16T11:00:00Z')).quiet, false);

  // Same instant in summer (CEST, UTC+2): 22:30Z is 00:30 Berlin → still quiet, end at 05:00Z
  const summer = isQuiet(berlinNight, new Date('2026-07-15T22:30:00Z'));
  assert.equal(summer.quiet, true);
  assert.equal(summer.until?.toISOString(), '2026-07-16T05:00:00.000Z');
});

test('isQuiet: a same-day window and a far timezone', () => {
  const tokyoLunch = { start: '12:00', end: '13:00', timezone: 'Asia/Tokyo', policy: 'silent' as const };
  // 12:30 Tokyo = 03:30Z
  const at = isQuiet(tokyoLunch, new Date('2026-03-10T03:30:00Z'));
  assert.equal(at.quiet, true);
  assert.equal(at.policy, 'silent');
  assert.equal(at.until?.toISOString(), '2026-03-10T04:00:00.000Z');
  assert.equal(isQuiet(tokyoLunch, new Date('2026-03-10T04:00:00Z')).quiet, false);
  // the same instant is 04:30 in Berlin: a Berlin lunch window is not quiet
  assert.equal(isQuiet({ ...tokyoLunch, timezone: 'Europe/Berlin' }, new Date('2026-03-10T03:30:00Z')).quiet, false);
});

test('isQuiet accepts a workspace row and treats off/malformed as never quiet', () => {
  const inWindow = new Date('2026-01-15T22:30:00Z');
  assert.equal(isQuiet({ quietHours: JSON.stringify(berlinNight) }, inWindow).quiet, true);
  assert.equal(isQuiet({ quietHours: '' }, inWindow).quiet, false);
  assert.equal(isQuiet({ quietHours: '{nope' }, inWindow).quiet, false);
  assert.equal(isQuiet({ quietHours: JSON.stringify({ ...berlinNight, timezone: 'Mars/Olympus' }) }, inWindow).quiet, false);
  assert.equal(isQuiet(null, inWindow).quiet, false);
  assert.equal(parseQuietHours(JSON.stringify({ ...berlinNight, policy: 'shout' })), null);
});

test('deliveryFor: queue defers to the window end, silent hides from channels, allow-urgent lets failures through', () => {
  const inWindow = new Date('2026-01-15T22:30:00Z');
  const outside = new Date('2026-01-15T11:00:00Z');

  assert.deepEqual(deliveryFor(berlinNight, 'loop_run', outside), { deliverAfter: null, silent: false });
  assert.deepEqual(deliveryFor(berlinNight, 'loop_run', inWindow), { deliverAfter: '2026-01-16T06:00:00.000Z', silent: false });
  assert.deepEqual(deliveryFor(berlinNight, 'loop_error', inWindow), { deliverAfter: '2026-01-16T06:00:00.000Z', silent: false }, 'queue defers everything');

  const silent = { ...berlinNight, policy: 'silent' as const };
  assert.deepEqual(deliveryFor(silent, 'loop_run', inWindow), { deliverAfter: null, silent: true });
  assert.deepEqual(deliveryFor(silent, 'loop_run', outside), { deliverAfter: null, silent: false });

  const urgent = { ...berlinNight, policy: 'allow-urgent' as const };
  assert.deepEqual(deliveryFor(urgent, 'loop_run', inWindow), { deliverAfter: '2026-01-16T06:00:00.000Z', silent: false });
  assert.deepEqual(deliveryFor(urgent, 'loop_error', inWindow), { deliverAfter: null, silent: false });
  assert.deepEqual(deliveryFor(urgent, 'budget_stop', inWindow), { deliverAfter: null, silent: false });
});

test('validateQuietHours rejects bad times, zones, policies, and empty windows', () => {
  assert.throws(() => validateQuietHours({ ...berlinNight, start: '25:00' }), /start must be HH:MM/);
  assert.throws(() => validateQuietHours({ ...berlinNight, end: '7:00' }), /end must be HH:MM/);
  assert.throws(() => validateQuietHours({ ...berlinNight, end: '22:00' }), /must differ/);
  assert.throws(() => validateQuietHours({ ...berlinNight, timezone: 'Nowhere/Land' }), /IANA zone/);
  assert.throws(() => validateQuietHours({ ...berlinNight, policy: 'yell' }), /policy must be one of/);
  assert.throws(() => validateQuietHours('22:00-07:00'), /must be an object/);
  // policy defaults to queue
  assert.equal(validateQuietHours({ start: '22:00', end: '07:00', timezone: 'UTC' }).policy, 'queue');
});

test('workspace PATCH stores a normalized config, accepts "" as off, and 400s on junk', async () => {
  const db = await testDb();
  const workspaces = new WorkspacesService(db, memStorage().stub);
  const ws = (await workspaces.list())[0];
  assert.equal(ws.quietHours, '', 'off by default');

  const saved = await workspaces.update(ws.id, { quietHours: JSON.stringify({ start: '22:00', end: '07:00', timezone: 'Europe/Berlin' }) });
  assert.deepEqual(JSON.parse(saved.quietHours), berlinNight, 'policy defaulted and shape normalized');

  await assert.rejects(workspaces.update(ws.id, { quietHours: '{"start":"22:00"}' }), BadRequestException);
  await assert.rejects(workspaces.update(ws.id, { quietHours: 'not json' }), BadRequestException);
  await assert.rejects(workspaces.update(ws.id, { spendBudgetTokens: -1 }), BadRequestException);
  await assert.rejects(workspaces.update(ws.id, { spendBudgetTokens: 1.5 }), BadRequestException);

  const off = await workspaces.update(ws.id, { quietHours: '' });
  assert.equal(off.quietHours, '');
});
