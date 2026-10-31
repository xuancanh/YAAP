/** Web push (phase 4.3): subscriptions, the VAPID header, the aes128gcm
 *  payload round trip (decrypted here with the subscriber's own keys, as a
 *  browser would), and the delivery sweep that marks pushDeliveredAt and
 *  drops dead subscriptions. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createVerify, createPublicKey, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  generateVapidKeys, vapidAuthorization, encryptPayload, decryptPayload, sendWebPush, isValidVapidPublicKey,
} from '../server/src/push/web-push';
import { PushService } from '../server/src/push/push.service';
import { PushController } from '../server/src/push/push.module';
import { AgentsService } from '../server/src/agents/agents.service';
import { testDb, memStorage } from './helpers';

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** A fake browser subscription: its own P-256 pair and a 16-byte auth secret. */
function fakeSubscriber(endpoint = 'https://push.example.org/send/abc') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    endpoint,
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) },
    decrypt: (body: Buffer) => decryptPayload(body, ecdh.getPrivateKey(), ecdh.getPublicKey(), auth).toString('utf8'),
  };
}

test('VAPID keys: generated pair is a valid P-256 point + scalar; the Authorization header carries an ES256 JWT for the endpoint origin', () => {
  const keys = generateVapidKeys();
  assert.equal(fromB64u(keys.publicKey).length, 65);
  assert.equal(fromB64u(keys.privateKey).length, 32);
  assert.equal(isValidVapidPublicKey(keys.publicKey), true);
  assert.equal(isValidVapidPublicKey('nope'), false);

  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz?x=1', 'mailto:me@example.com', keys, new Date('2026-10-31T10:00:00Z'));
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m![2], keys.publicKey);
  const [h, p, sig] = m![1].split('.');
  assert.deepEqual(JSON.parse(fromB64u(h).toString()), { typ: 'JWT', alg: 'ES256' });
  const payload = JSON.parse(fromB64u(p).toString()) as { aud: string; exp: number; sub: string };
  assert.equal(payload.aud, 'https://fcm.googleapis.com', 'audience is the origin, nothing more');
  assert.equal(payload.sub, 'mailto:me@example.com');
  assert.equal(payload.exp, Math.floor(Date.parse('2026-10-31T10:00:00Z') / 1000) + 12 * 3600);
  assert.equal(fromB64u(sig).length, 64, 'raw r||s, not DER');

  // verifiable with the public key alone
  const point = fromB64u(keys.publicKey);
  const pub = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) } });
  assert.equal(createVerify('SHA256').update(`${h}.${p}`).verify({ key: pub, dsaEncoding: 'ieee-p1363' }, fromB64u(sig)), true);
});

test('aes128gcm: a payload encrypted for a subscription decrypts with the subscriber\'s keys and nothing else', () => {
  const sub = fakeSubscriber();
  const body = encryptPayload('{"title":"hi ✓"}', sub.keys.p256dh, sub.keys.auth);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body[20], 65, 'sender public key length');
  assert.equal(body[21], 0x04, 'uncompressed point');
  assert.equal(sub.decrypt(body), '{"title":"hi ✓"}');
  // fresh salt + ephemeral key every time
  assert.notDeepEqual(encryptPayload('x', sub.keys.p256dh, sub.keys.auth), encryptPayload('x', sub.keys.p256dh, sub.keys.auth));
  const other = fakeSubscriber();
  assert.throws(() => other.decrypt(body), 'another subscriber cannot read it');
  assert.throws(() => encryptPayload('x', 'bad', sub.keys.auth));
});

test('sendWebPush: POSTs the encrypted body with the right headers; 404/410 are reported as gone', async () => {
  const sub = fakeSubscriber();
  const vapid = { ...generateVapidKeys(), subject: 'mailto:me@example.com' };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let status = 201;
  const fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(null, { status }); }) as unknown as typeof fetch;

  const row = { endpoint: sub.endpoint, ...sub.keys };
  const r = await sendWebPush(row, '{"a":1}', vapid, fetchFn, { urgency: 'high' });
  assert.deepEqual(r, { status: 201, ok: true, gone: false });
  assert.equal(calls[0].url, sub.endpoint);
  const headers = calls[0].init.headers as Record<string, string>;
  assert.match(headers.authorization, /^vapid t=.+, k=/);
  assert.equal(headers['content-encoding'], 'aes128gcm');
  assert.equal(headers.urgency, 'high');
  assert.equal(headers.ttl, '86400');
  assert.equal(sub.decrypt(Buffer.from(calls[0].init.body as Buffer)), '{"a":1}');

  status = 410;
  assert.deepEqual(await sendWebPush(row, 'x', vapid, fetchFn), { status: 410, ok: false, gone: true });
  status = 404;
  assert.equal((await sendWebPush(row, 'x', vapid, fetchFn)).gone, true);
  status = 429;
  assert.deepEqual(await sendWebPush(row, 'x', vapid, fetchFn), { status: 429, ok: false, gone: false });
});

async function setup(vapid: { publicKey: string; privateKey: string } | null) {
  const db = await testDb();
  const { stub } = memStorage();
  const agents = new AgentsService(db, stub);
  const cfg: Record<string, string> = vapid
    ? { vapidPublicKey: vapid.publicKey, vapidPrivateKey: vapid.privateKey, vapidSubject: 'mailto:me@example.com', publicAppUrl: 'https://yaam.example/' }
    : { publicAppUrl: 'https://yaam.example/' };
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
  const push = new PushService(db, config, agents);
  return { push, agents, db };
}

test('subscriptions: subscribe upserts by endpoint, unsubscribe removes, bad input is a 400; without keys the public-key route says disabled', async () => {
  const { push } = await setup(generateVapidKeys());
  const ctl = new PushController(push);
  const sub = fakeSubscriber();
  const first = await ctl.subscribe({ ...sub, userAgent: 'TestBrowser/1' });
  assert.equal(first.ok, true);
  const again = await ctl.subscribe({ ...sub, keys: { ...sub.keys, auth: b64u(randomBytes(16)) }, userAgent: 'TestBrowser/2' });
  assert.equal(again.id, first.id, 'same endpoint = same row');
  const rows = await push.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userAgent, 'TestBrowser/2');

  const { BadRequestException } = await import('@nestjs/common');
  await assert.rejects(ctl.subscribe({ endpoint: 'http://insecure', keys: sub.keys }), BadRequestException);
  await assert.rejects(ctl.subscribe({ endpoint: sub.endpoint, keys: { p256dh: '', auth: '' } }), BadRequestException);

  const info = await ctl.publicKey();
  assert.equal(info.enabled, true);
  assert.equal(info.subscriptions, 1);
  assert.equal(info.publicKey.length > 80, true);

  assert.deepEqual(await ctl.unsubscribe({ endpoint: sub.endpoint }), { ok: true, removed: 1 });
  assert.deepEqual(await ctl.unsubscribe({ endpoint: sub.endpoint }), { ok: true, removed: 0 });
  assert.equal((await push.list()).length, 0);

  const { push: off } = await setup(null);
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.publicKey(), { enabled: false, publicKey: '', subscriptions: 0 });
  assert.equal(await off.deliverSweep(), 0);
});

test('deliverSweep: one notification per device per event with a deep link, marks pushDeliveredAt only, drops 410 subscriptions, retries failures', async () => {
  const { push, agents } = await setup(generateVapidKeys());
  const phone = fakeSubscriber('https://push.example.org/phone');
  const laptop = fakeSubscriber('https://push.example.org/laptop');
  await push.subscribe({ ...phone, userAgent: 'phone' });
  await push.subscribe({ ...laptop, userAgent: 'laptop' });
  const agent = await agents.create({ name: 'Fieldy' });

  const got: Array<{ endpoint: string; payload: { title: string; body: string; url: string; tag: string } }> = [];
  const statuses: Record<string, number> = {};
  push.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const endpoint = String(url);
    const sub = endpoint === phone.endpoint ? phone : laptop;
    got.push({ endpoint, payload: JSON.parse(sub.decrypt(Buffer.from(init!.body as Buffer))) as never });
    return new Response(null, { status: statuses[endpoint] ?? 201 });
  }) as unknown as typeof fetch;

  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Loop "Nightly" ran', body: 'All  green.', sessionId: 'sess0000001', origin: 'loop' });
  await agents.addEvent(agent.id, { kind: 'info', title: 'From the phone', origin: 'channel' });
  await agents.addEvent(agent.id, { kind: 'info', title: 'Hush', origin: 'loop', silent: true });
  await agents.addEvent(agent.id, { kind: 'info', title: 'Later', origin: 'loop', deliverAfter: new Date(Date.now() + 3_600_000).toISOString() });

  assert.equal(await push.deliverSweep(), 1);
  assert.equal(got.length, 2, 'both devices');
  assert.deepEqual(new Set(got.map((g) => g.endpoint)), new Set([phone.endpoint, laptop.endpoint]));
  assert.equal(got[0].payload.title, 'Fieldy · Loop "Nightly" ran');
  assert.equal(got[0].payload.body, 'All green.');
  assert.equal(got[0].payload.url, 'https://yaam.example/#/chat/sess0000001');
  const ran = (await agents.listEvents(agent.id)).find((e) => e.title.includes('Nightly'))!;
  assert.ok(ran.pushDeliveredAt);
  assert.equal(ran.deliveredAt, null, 'Telegram column untouched');
  assert.equal(ran.emailDeliveredAt, null, 'email column untouched');
  assert.equal(await push.deliverSweep(), 0, 'idempotent; deferred/silent/channel-born stay put');

  // the phone's subscription died: dropped; the laptop still counts as delivered
  statuses[phone.endpoint] = 410;
  await agents.addEvent(agent.id, { kind: 'loop_error', title: 'Loop "Sync" failed', origin: 'loop' });
  assert.equal(await push.deliverSweep(), 1);
  assert.deepEqual((await push.list()).map((s) => s.endpoint), [laptop.endpoint]);

  // every device failing transiently: not marked, retried next sweep
  statuses[laptop.endpoint] = 503;
  await agents.addEvent(agent.id, { kind: 'info', title: 'Flaky', origin: 'loop' });
  assert.equal(await push.deliverSweep(), 0);
  statuses[laptop.endpoint] = 201;
  assert.equal(await push.deliverSweep(), 1);
  assert.equal(got.at(-1)!.payload.title, 'Fieldy · Flaky');

  // no subscriptions left: nothing is attempted or marked
  await push.unsubscribe(laptop.endpoint);
  await agents.addEvent(agent.id, { kind: 'info', title: 'Nobody listening', origin: 'loop' });
  assert.equal(await push.deliverSweep(), 0);
});
