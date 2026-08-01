/** Connections (docs/integrations.md): per-agent grants gate calendar tools;
 *  tokens refresh transparently; OAuth state is validated; secretbox seals. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@nestjs/config';
import { ConnectionsService } from '../server/src/connections/connections.service';
import { AgentsService } from '../server/src/agents/agents.service';
import { seal, open } from '../server/src/common/secretbox';
import { agentEvents, connections } from '../server/src/database/schema';
import { memStorage, testDb } from './helpers';
import type { StorageService } from '../server/src/storage/storage.service';

const WRITE_SCOPES = '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/calendar.events"]';
const GMAIL_SCOPES = '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/gmail.compose"]';
const DRIVE_SCOPES = '["https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/drive.file"]';

const configStub = {
  get: (key: string) => ({
    googleClientId: 'test-client',
    googleClientSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:8790',
  })[key],
} as unknown as ConfigService;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

async function service() {
  const db = await testDb();
  const svc = new ConnectionsService(db, configStub);
  return { db, svc };
}

async function insertConnection(db: Awaited<ReturnType<typeof testDb>>, over: Partial<typeof connections.$inferSelect> = {}) {
  const row = {
    id: 'conn1', provider: 'google', accountEmail: 'user@example.com',
    scopes: '["https://www.googleapis.com/auth/calendar.readonly"]',
    accessToken: seal('live-token'),
    refreshToken: seal('refresh-token'),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  };
  await db.insert(connections).values(row);
  return row;
}

test('secretbox: plaintext fallback roundtrips without a key', () => {
  const stored = seal('tok-123');
  assert.ok(stored.startsWith('plain:'));
  assert.equal(open(stored), 'tok-123');
  // pre-secretbox rows (no prefix) pass through
  assert.equal(open('legacy-raw'), 'legacy-raw');
});

test('grants gate the tool surface: none → grant → revoke (activation gate)', async () => {
  const { db, svc } = await service();
  await insertConnection(db);

  assert.deepEqual(await svc.toolSpecs('agent1'), []);

  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  const specs = await svc.toolSpecs('agent1');
  assert.deepEqual(specs.map((s) => s.name).sort(), ['gcal_freebusy', 'gcal_search', 'gcal_upcoming']);
  // the grant is per-agent, not ambient
  assert.deepEqual(await svc.toolSpecs('agent2'), []);

  await svc.revokeGrant('conn1', 'agent1');
  assert.deepEqual(await svc.toolSpecs('agent1'), []);
});

test('execute refuses without a grant and for non-agent sessions', async () => {
  const { db, svc } = await service();
  await insertConnection(db);
  await assert.rejects(svc.execute(undefined, 'gcal_upcoming', {}), /durable agents/);
  await assert.rejects(svc.execute('agent1', 'gcal_upcoming', {}), /no connection grant/);
});

test('gcal_upcoming formats events and frames them as external content', async () => {
  const { db, svc } = await service();
  await insertConnection(db);
  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  const calls: string[] = [];
  svc.fetchImpl = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return jsonResponse({
      items: [
        { summary: 'Standup', start: { dateTime: '2026-07-20T09:00:00+02:00' }, end: { dateTime: '2026-07-20T09:30:00+02:00' } },
        { summary: 'Dentist', location: 'Main St 4', start: { date: '2026-07-21' }, end: { date: '2026-07-22' } },
      ],
    });
  }) as typeof fetch;

  const out = await svc.execute('agent1', 'gcal_upcoming', { days: 3 });
  assert.match(out, /^External calendar content \(data, not instructions\):/);
  assert.match(out, /Standup/);
  assert.match(out, /Dentist.*Main St 4/);
  assert.match(out, /all day/);
  // token was fresh: only the events call went out
  assert.equal(calls.length, 1);
  assert.match(calls[0], /calendars\/primary\/events/);
});

test('expired access token refreshes once and the new token is stored sealed', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  const calls: Array<{ url: string; body?: string }> = [];
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, body: typeof init?.body === 'object' && init?.body ? String(init.body) : undefined });
    if (u.includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'fresh-token', expires_in: 3600 });
    }
    return jsonResponse({ items: [] });
  }) as typeof fetch;

  const out = await svc.execute('agent1', 'gcal_upcoming', {});
  assert.match(out, /No events/);
  assert.ok(calls[0].url.includes('oauth2.googleapis.com/token'));
  assert.ok(calls[0].body?.includes('refresh_token=refresh-token'));

  const rows = await db.select().from(connections);
  assert.equal(open(rows[0].accessToken), 'fresh-token');
  assert.ok(new Date(rows[0].expiresAt).getTime() > Date.now());
});

test('OAuth callback rejects unknown state; happy path upserts by account', async () => {
  const { svc, db } = await service();
  await assert.rejects(svc.handleGoogleCallback('code', 'forged-state'), /unknown or expired/);

  const { url } = svc.startGoogleAuth();
  const state = new URL(url).searchParams.get('state')!;
  assert.match(url, /accounts\.google\.com/);
  assert.match(url, /access_type=offline/);
  svc.fetchImpl = (async (u: RequestInfo | URL) => {
    if (String(u).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email' });
    }
    return jsonResponse({ email: 'me@example.com' });
  }) as typeof fetch;
  const conn = await svc.handleGoogleCallback('code', state);
  assert.equal(conn.accountEmail, 'me@example.com');
  assert.equal(conn.provider, 'google');
  // tokens never appear in the listed shape
  assert.ok(!('accessToken' in conn));
  const rows = await db.select().from(connections);
  assert.equal(open(rows[0].refreshToken), 'rt');
});

test('write tier: consent URL requests calendar.events incrementally', () => {
  const db = null as never; // startGoogleAuth never touches the db
  const svc = new ConnectionsService(db, configStub);
  const read = new URL(svc.startGoogleAuth('read').url);
  assert.match(read.searchParams.get('scope')!, /calendar\.readonly/);
  assert.doesNotMatch(read.searchParams.get('scope')!, /calendar\.events/);
  const write = new URL(svc.startGoogleAuth('write').url);
  assert.match(write.searchParams.get('scope')!, /calendar\.events/);
  // incremental auth keeps prior consents without re-listing them
  assert.equal(write.searchParams.get('include_granted_scopes'), 'true');
});

test('write grant is refused until the connection holds write scopes', async () => {
  const { db, svc } = await service();
  await insertConnection(db); // readonly scopes only
  await assert.rejects(svc.setGrant('conn1', 'agent1', 'calendar', 'write'), /read-only consent/);

  await db.delete(connections);
  await insertConnection(db, {
    scopes: '["https://www.googleapis.com/auth/calendar.readonly","https://www.googleapis.com/auth/calendar.events"]',
  });
  await svc.setGrant('conn1', 'agent1', 'calendar', 'write');
  const listed = await svc.list();
  assert.equal(listed[0].writeCapable, true);
  assert.deepEqual(listed[0].grants, [{ agentId: 'agent1', service: 'calendar', level: 'write' }]);
  // a write grant exposes the read tools plus the write tools
  const specs = await svc.toolSpecs('agent1');
  assert.deepEqual(specs.map((s) => s.name).sort(), ['gcal_create_event', 'gcal_freebusy', 'gcal_search', 'gcal_upcoming', 'gcal_update_event']);
});

test('re-consent upgrade merges scopes instead of replacing them', async () => {
  const { db, svc } = await service();
  await insertConnection(db); // existing readonly connection for user@example.com
  const { url } = svc.startGoogleAuth('write');
  const state = new URL(url).searchParams.get('state')!;
  svc.fetchImpl = (async (u: RequestInfo | URL) => {
    if (String(u).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'at2', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/calendar.events' });
    }
    return jsonResponse({ email: 'user@example.com' });
  }) as typeof fetch;
  const conn = await svc.handleGoogleCallback('code', state);
  assert.ok(conn.scopes.includes('https://www.googleapis.com/auth/calendar.readonly'));
  assert.ok(conn.scopes.includes('https://www.googleapis.com/auth/calendar.events'));
  assert.equal(conn.writeCapable, true);
  // no refresh token in the upgrade response: the original one is kept
  const rows = await db.select().from(connections);
  assert.equal(open(rows[0].refreshToken), 'refresh-token');
});

test('write tools appear only under a write grant; execute enforces the level', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: WRITE_SCOPES });

  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  const readSpecs = (await svc.toolSpecs('agent1')).map((s) => s.name);
  assert.ok(!readSpecs.includes('gcal_create_event'));
  await assert.rejects(svc.execute('agent1', 'gcal_create_event', { title: 'x', start: '2026-08-05' }), /no write grant/);

  await svc.setGrant('conn1', 'agent1', 'calendar', 'write');
  const writeSpecs = (await svc.toolSpecs('agent1')).map((s) => s.name).sort();
  assert.deepEqual(writeSpecs, ['gcal_create_event', 'gcal_freebusy', 'gcal_search', 'gcal_upcoming', 'gcal_update_event']);
  // write tools are mutation-class for the approval policy
  assert.equal(svc.isReadOnly('gcal_create_event'), false);
  assert.equal(svc.isReadOnly('gcal_upcoming'), true);
});

test('gcal_create_event posts to Google with a provenance stamp', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: WRITE_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'calendar', 'write');
  let sent: { url: string; method?: string; body?: string } | null = null;
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent = { url: String(url), method: init?.method, body: init?.body ? String(init.body) : undefined };
    return jsonResponse({ id: 'evt42', summary: 'Dentist', start: { date: '2026-08-05' }, end: { date: '2026-08-05' }, htmlLink: 'https://cal/evt42' });
  }) as typeof fetch;

  const out = await svc.execute('agent1', 'gcal_create_event', { title: 'Dentist', start: '2026-08-05' });
  assert.match(out, /Event created/);
  assert.match(out, /id: evt42/);
  assert.ok(sent, 'request went out');
  assert.equal(sent!.method, 'POST');
  assert.match(sent!.url, /calendars\/primary\/events/);
  const body = JSON.parse(sent!.body!) as { summary: string; description: string; start: { date: string }; end: { date: string } };
  assert.equal(body.summary, 'Dentist');
  assert.match(body.description, /\[created by an agent via yaam\]/);
  assert.deepEqual(body.start, { date: '2026-08-05' });
});

test('gcal_update_event patches only the provided fields', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: WRITE_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'calendar', 'write');
  let sent: { url: string; method?: string; body?: string } | null = null;
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent = { url: String(url), method: init?.method, body: init?.body ? String(init.body) : undefined };
    return jsonResponse({ id: 'evt42', summary: 'Dentist (moved)', start: { dateTime: '2026-08-06T10:00:00+02:00' }, end: { dateTime: '2026-08-06T11:00:00+02:00' } });
  }) as typeof fetch;

  await assert.rejects(svc.execute('agent1', 'gcal_update_event', { eventId: 'evt42' }), /at least one field/);
  const out = await svc.execute('agent1', 'gcal_update_event', { eventId: 'evt42', title: 'Dentist (moved)' });
  assert.match(out, /Event updated/);
  assert.equal(sent!.method, 'PATCH');
  assert.match(sent!.url, /events\/evt42$/);
  const body = JSON.parse(sent!.body!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['summary']);
});

test('gmail tier: consent URL requests gmail.compose; gmail grants are service-scoped (M2)', async () => {
  const { db, svc } = await service();
  const gmailUrl = new URL(svc.startGoogleAuth('gmail').url);
  assert.match(gmailUrl.searchParams.get('scope')!, /gmail\.compose/);
  assert.doesNotMatch(gmailUrl.searchParams.get('scope')!, /calendar/);

  // no gmail consent yet → gmail grant refused
  await insertConnection(db);
  await assert.rejects(svc.setGrant('conn1', 'agent1', 'gmail', 'write'), /no Gmail consent/);

  await db.delete(connections);
  await insertConnection(db, { scopes: GMAIL_SCOPES });
  await assert.rejects(svc.setGrant('conn1', 'agent1', 'gmail', 'read'), /write-level/);
  await svc.setGrant('conn1', 'agent1', 'gmail', 'write');

  // gmail grant alone exposes only the gmail tools, not calendar
  const specs = (await svc.toolSpecs('agent1')).map((s) => s.name).sort();
  assert.deepEqual(specs, ['gmail_draft', 'gmail_send']);
  await assert.rejects(svc.execute('agent1', 'gcal_upcoming', {}), /no connection grant/);
  // a calendar grant on top exposes both services
  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  assert.equal((await svc.toolSpecs('agent1')).length, 5);
  // revoking just gmail keeps calendar
  await svc.revokeGrant('conn1', 'agent1', 'gmail');
  assert.deepEqual((await svc.toolSpecs('agent1')).map((s) => s.name).sort(), ['gcal_freebusy', 'gcal_search', 'gcal_upcoming']);
  // gmail_send is the confirm-always class; drafts are not
  assert.equal(svc.isConfirmAlways('gmail_send'), true);
  assert.equal(svc.isConfirmAlways('gmail_draft'), false);
});

test('gmail_draft and gmail_send build RFC 2822 mail and hit the right endpoints (M2)', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: GMAIL_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'gmail', 'write');
  const sent: Array<{ url: string; body: string }> = [];
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: init?.body ? String(init.body) : '' });
    return jsonResponse({ id: 'm1' });
  }) as typeof fetch;

  await assert.rejects(svc.execute('agent1', 'gmail_draft', { subject: 's', body: 'b' }), /"to" requires at least one recipient/);
  await assert.rejects(svc.execute('agent1', 'gmail_draft', { to: 'not-an-email', subject: 's', body: 'b' }), /not a valid email/);
  await assert.rejects(svc.execute('agent1', 'gmail_draft', { to: 'a@b.co', subject: '', body: 'b' }), /"subject" is required/);

  const out = await svc.execute('agent1', 'gmail_draft', { to: 'a@b.co', cc: 'c@d.co', subject: 'Rent reminder', body: 'Hello Ann,\nrent is due.' });
  assert.match(out, /Draft created/);
  assert.match(sent[0].url, /gmail\/v1\/users\/me\/drafts/);
  const raw = (JSON.parse(sent[0].body) as { message: { raw: string } }).message.raw;
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /To: a@b\.co\r\n/);
  assert.match(mime, /Cc: c@d\.co\r\n/);
  assert.match(mime, /Subject: Rent reminder\r\n/);
  assert.match(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString('utf8'), /Hello Ann/);

  const out2 = await svc.execute('agent1', 'gmail_send', { to: 'a@b.co', subject: 'Go', body: 'now' });
  assert.match(out2, /Email sent/);
  assert.match(sent[1].url, /gmail\/v1\/users\/me\/messages\/send/);
  assert.ok((JSON.parse(sent[1].body) as { raw?: string }).raw, 'send posts the raw message directly');
});

test('drive tier: scoped grants gate read vs export tools (M3)', async () => {
  const { db, svc } = await service();
  const driveUrl = new URL(svc.startGoogleAuth('drive').url);
  assert.match(driveUrl.searchParams.get('scope')!, /drive\.readonly/);
  assert.match(driveUrl.searchParams.get('scope')!, /drive\.file/);
  assert.doesNotMatch(driveUrl.searchParams.get('scope')!, /calendar|gmail/);

  await insertConnection(db); // calendar-only consent
  await assert.rejects(svc.setGrant('conn1', 'agent1', 'drive', 'read'), /no Drive consent/);

  await db.delete(connections);
  await insertConnection(db, { scopes: DRIVE_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'drive', 'read');
  assert.deepEqual((await svc.toolSpecs('agent1')).map((s) => s.name).sort(), ['drive_read', 'drive_search']);
  await assert.rejects(svc.execute('agent1', 'drive_export_doc', { title: 't', markdown: 'x' }), /no write grant/);

  await svc.setGrant('conn1', 'agent1', 'drive', 'write');
  assert.deepEqual((await svc.toolSpecs('agent1')).map((s) => s.name).sort(),
    ['drive_export_doc', 'drive_export_sheet', 'drive_read', 'drive_search']);
  assert.equal((await svc.list())[0].driveCapable, true);
});

test('drive_search and drive_read hit the right endpoints; Google Docs export to text (M3)', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: DRIVE_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'drive', 'read');
  const calls: string[] = [];
  svc.fetchImpl = (async (url: RequestInfo | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/export')) return { ok: true, status: 200, text: async () => 'Quarterly report body', json: async () => ({}) } as unknown as Response;
    if (u.includes('fields=id,name,mimeType,size')) {
      return jsonResponse({ id: 'f1', name: 'Q3 Report', mimeType: 'application/vnd.google-apps.document' });
    }
    return jsonResponse({ files: [{ id: 'f1', name: 'Q3 Report', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-07-30T10:00:00Z' }] });
  }) as typeof fetch;

  const found = await svc.execute('agent1', 'drive_search', { query: "Ann's Q3" });
  assert.match(found, /^External drive content/);
  assert.match(found, /Q3 Report.*id:f1/);
  // single quotes in the query are escaped inside the Drive q expression
  assert.match(decodeURIComponent(calls[0]).replace(/\+/g, ' '), /name contains 'Ann\\'s Q3'/);

  const read = await svc.execute('agent1', 'drive_read', { fileId: 'f1' });
  assert.match(read, /Quarterly report body/);
  assert.match(calls.at(-1)!, /files\/f1\/export\?mimeType=text%2Fplain/);
});

test('drive_export_doc uploads multipart markdown that converts to a Google Doc (M3)', async () => {
  const { db, svc } = await service();
  await insertConnection(db, { scopes: DRIVE_SCOPES });
  await svc.setGrant('conn1', 'agent1', 'drive', 'write');
  let sent: { url: string; contentType: string; body: string } | null = null;
  svc.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent = {
      url: String(url),
      contentType: String((init?.headers as Record<string, string>)?.['content-type'] ?? ''),
      body: init?.body ? String(init.body) : '',
    };
    return jsonResponse({ id: 'doc1', name: 'Plan', webViewLink: 'https://docs.google.com/d/doc1' });
  }) as typeof fetch;

  const out = await svc.execute('agent1', 'drive_export_doc', { title: 'Plan', markdown: '# Plan\n- step one' });
  assert.match(out, /Google Doc created/);
  assert.match(out, /docs\.google\.com/);
  assert.match(sent!.url, /upload\/drive\/v3\/files\?uploadType=multipart/);
  assert.match(sent!.contentType, /multipart\/related; boundary=/);
  assert.match(sent!.body, /"mimeType":"application\/vnd\.google-apps\.document"/);
  assert.match(sent!.body, /Content-Type: text\/markdown/);
  assert.match(sent!.body, /# Plan/);
});

test('action_pending inbox events: approve executes, dismiss does not (M1)', async () => {
  const db = await testDb();
  const agentsSvc = new AgentsService(db, memStorage().stub as unknown as StorageService);
  const pending = await agentsSvc.addEvent('agent1', {
    kind: 'action_pending', title: 'Needs your approval: gcal_create_event',
    payload: JSON.stringify({ tool: 'gcal_create_event', input: { title: 'Dentist', start: '2026-08-05' } }),
  });

  const ran: Array<{ tool: string; input: Record<string, unknown> }> = [];
  const res = await agentsSvc.resolveActionEvent('agent1', pending.id, true, async (_agentId, tool, input) => {
    ran.push({ tool, input });
    return 'Event created: ...';
  });
  assert.equal(res.status, 'done');
  assert.deepEqual(ran, [{ tool: 'gcal_create_event', input: { title: 'Dentist', start: '2026-08-05' } }]);
  const [row] = await db.select().from(agentEvents);
  assert.equal(row.kind, 'action_done');
  // resolved events cannot run twice
  await assert.rejects(agentsSvc.resolveActionEvent('agent1', pending.id, true, async () => 'x'), /not awaiting approval/);

  const dismissed = await agentsSvc.addEvent('agent1', {
    kind: 'action_pending', title: 't', payload: JSON.stringify({ tool: 'gcal_create_event', input: {} }),
  });
  const res2 = await agentsSvc.resolveActionEvent('agent1', dismissed.id, false, async () => { throw new Error('must not run'); });
  assert.equal(res2.status, 'dismissed');
  // wrong agent id cannot resolve someone else's event
  const other = await agentsSvc.addEvent('agent1', { kind: 'action_pending', title: 't', payload: '{"tool":"x"}' });
  await assert.rejects(agentsSvc.resolveActionEvent('agent2', other.id, true, async () => 'x'), /event/);
});

test('remove revokes at the provider and deletes grants', async () => {
  const { db, svc } = await service();
  await insertConnection(db);
  await svc.setGrant('conn1', 'agent1', 'calendar', 'read');
  let revoked = '';
  svc.fetchImpl = (async (url: RequestInfo | URL) => {
    revoked = String(url);
    return jsonResponse({});
  }) as typeof fetch;
  await svc.remove('conn1');
  assert.match(revoked, /revoke\?token=refresh-token/);
  assert.deepEqual(await svc.list(), []);
  assert.deepEqual(await svc.toolSpecs('agent1'), []);
});
