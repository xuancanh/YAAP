/** Email channel (phase 4.1): the signed inbound webhook, routing by
 *  address, the pairing handshake, Ask-mode channel turns with threaded
 *  replies, bounce hygiene, and the outbound inbox digest. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { EmailService, stripQuotedHistory, isAutomatedMail, normalizeAddress, type InboundEmail } from '../server/src/channels/email.service';
import { CloudflareEmailSender, ResendEmailSender, type OutboundEmail } from '../server/src/channels/email-sender';
import { SettingsService } from '../server/src/settings/settings.module';
import { AgentsService, emailSlugify } from '../server/src/agents/agents.service';
import { WorkspacesService } from '../server/src/workspaces/workspaces.service';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { TurnLoopService } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, mcpStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

const SECRET = 'shh-inbound';

async function setup(rounds: AiStreamEvent[][], overrides: Record<string, string> = {}) {
  const db = await testDb();
  const { stub } = memStorage();
  const settings = new SettingsService(db);
  const agents = new AgentsService(db, stub);
  const workspaces = new WorkspacesService(db, stub);
  const repo = new ChatsRepository(db);
  const provider = new ScriptedProvider(rounds);
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcpStub(), agents, workspaces);
  const cfg: Record<string, string> = {
    emailDomain: 'agents.example.com', emailInboundSecret: SECRET, emailSendProvider: 'resend', emailSendToken: 'rs_test',
    emailFromName: 'YAAM', publicAppUrl: 'https://yaam.example/', ...overrides,
  };
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
  const email = new EmailService(config, settings, agents, workspaces, repo, turns);
  const sent: OutboundEmail[] = [];
  email.sender = { name: 'fake', send: async (m) => { sent.push(m); } };
  await workspaces.list(); // default workspace
  return { email, sent, settings, agents, repo, workspaces, provider, turns };
}

const sign = (body: string) => `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
const mail = (over: Partial<InboundEmail>): InboundEmail => ({
  to: 'fieldy@agents.example.com', from: 'Owner <owner@example.com>', subject: 'Hello', text: 'hi there',
  messageId: '<m1@example.com>', receivedAt: '2026-10-31T10:00:00.000Z', ...over,
});

test('helpers: slugs, address normalisation, quoted-history stripping, automated-mail detection', () => {
  assert.equal(emailSlugify('Fieldy, the Scout!'), 'fieldy-the-scout');
  assert.equal(emailSlugify('Élodie Ünal'), 'elodie-unal');
  assert.equal(emailSlugify('!!!'), 'agent');
  assert.equal(normalizeAddress('"A. Person" <A.Person@Example.COM>'), 'a.person@example.com');
  assert.equal(stripQuotedHistory('Thanks!\n\nOn Fri, Oct 31, 2026 at 9:00 AM Fieldy wrote:\n> old\n> stuff'), 'Thanks!');
  assert.equal(stripQuotedHistory('Yes please\n-- \nSent from my phone'), 'Yes please');
  assert.equal(stripQuotedHistory('one\n> a\n> b\n> c\nafter'), 'one');
  assert.equal(stripQuotedHistory('a > b is true\nreally'), 'a > b is true\nreally', 'a lone quoted-looking line is content');
  assert.equal(isAutomatedMail(mail({ headers: { 'Auto-Submitted': 'auto-replied' } })), true);
  assert.equal(isAutomatedMail(mail({ headers: { Precedence: 'bulk' } })), true);
  assert.equal(isAutomatedMail(mail({ from: 'MAILER-DAEMON@mx.example.com' })), true);
  assert.equal(isAutomatedMail(mail({ subject: 'Out of Office: Hello' })), true);
  assert.equal(isAutomatedMail(mail({ headers: { 'Auto-Submitted': 'no' } })), false);
});

test('inbound signature: the HMAC over the raw body must match; no header, wrong key, wrong shape all fail', async () => {
  const { email } = await setup([]);
  const body = JSON.stringify(mail({}));
  assert.equal(email.verifySignature(body, sign(body)), true);
  assert.equal(email.verifySignature(Buffer.from(body), sign(body)), true);
  assert.equal(email.verifySignature(body, undefined), false);
  assert.equal(email.verifySignature(body, 'sha256=' + 'ab'.repeat(32)), false);
  assert.equal(email.verifySignature(body + ' ', sign(body)), false, 'any byte change breaks it');
  assert.equal(email.verifySignature(body, `sha256=${createHmac('sha256', 'other').update(body).digest('hex')}`), false);
  assert.equal(email.verifySignature(body, 'md5=abc'), false);
  const { email: noSecret } = await setup([], { emailInboundSecret: '' });
  assert.equal(noSecret.verifySignature(body, sign(body)), false, 'no secret configured = nothing verifies');
});

test('inbound over HTTP: a bad signature is 401 before the body is read as mail', async () => {
  const { UnauthorizedException } = await import('@nestjs/common');
  const { EmailController } = await import('../server/src/channels/channels.module');
  const { email, sent } = await setup([]);
  const ctl = new EmailController(email);
  const body = JSON.stringify(mail({}));
  const req = (raw: string) => ({ rawBody: Buffer.from(raw), body: JSON.parse(raw) as unknown }) as never;
  await assert.rejects(ctl.inbound(req(body), 'sha256=' + '00'.repeat(32)), UnauthorizedException);
  await assert.rejects(ctl.inbound(req(body), undefined), UnauthorizedException);
  assert.equal(sent.length, 0);
  const res = await ctl.inbound(req(body), sign(body));
  assert.equal(res.outcome, 'ignored'); // no such agent yet — but it got through the gate
});

test('routing by address: unknown agents and foreign domains are ignored; a known slug reaches its agent', async () => {
  const { email, agents, sent } = await setup([]);
  const agent = await agents.create({ name: 'Fieldy' });
  assert.equal(agent.emailSlug, 'fieldy');
  const twin = await agents.create({ name: 'Fieldy' });
  assert.equal(twin.emailSlug, 'fieldy-2', 'collisions get a suffix');
  assert.deepEqual(await email.handleInbound(mail({ to: 'nobody@agents.example.com' })), { outcome: 'ignored', reason: 'no such agent' });
  assert.deepEqual(await email.handleInbound(mail({ to: 'fieldy@elsewhere.com' })), { outcome: 'ignored', reason: 'not our domain' });
  const r = await email.handleInbound(mail({ to: 'Fieldy@Agents.Example.com' }));
  assert.equal(r.outcome, 'pairing_prompt');
  assert.equal((r as { agentId: string }).agentId, agent.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from.address, 'fieldy@agents.example.com');
  assert.equal(sent[0].from.name, 'YAAM · Fieldy');

  const status = await email.status();
  assert.equal(status.configured, true);
  assert.deepEqual(status.addresses.map((a) => a.address), ['fieldy@agents.example.com', 'fieldy-2@agents.example.com']);
});

test('unpaired sender: one pairing auto-reply, then silence; a valid code pairs that sender only', async () => {
  const { email, agents, sent, settings } = await setup([]);
  await agents.create({ name: 'Fieldy' });

  const first = await email.handleInbound(mail({}));
  assert.equal(first.outcome, 'pairing_prompt');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Settings → Channels/);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].subject, 'Re: Hello');
  assert.equal(sent[0].headers?.['In-Reply-To'], '<m1@example.com>');
  assert.equal(sent[0].headers?.['Auto-Submitted'], 'auto-replied', 'our prompt is marked so responders stay quiet');

  // second mail from the same stranger: no second prompt (no backscatter loop)
  assert.deepEqual(await email.handleInbound(mail({ text: 'hello?' })), { outcome: 'ignored', reason: 'already prompted' });
  assert.equal(sent.length, 1);

  // wrong / stale code: still a stranger
  await email.handleInbound(mail({ text: 'deadbeef' }));
  assert.equal((await settings.all()).emailOwnerAddresses, undefined);

  const { code } = email.mintPairCode();
  // someone else quoting the code pairs *their* address, not the first stranger's
  const r = await email.handleInbound(mail({ from: 'other@example.net', text: `here: ${code}\n\n> quoted stuff` }));
  assert.equal(r.outcome, 'paired');
  assert.deepEqual(JSON.parse((await settings.all()).emailOwnerAddresses), ['other@example.net']);
  assert.match(sent.at(-1)!.text, /Paired/);

  // the code is single-use
  await email.handleInbound(mail({ from: 'third@example.org', text: code }));
  assert.deepEqual(JSON.parse((await settings.all()).emailOwnerAddresses), ['other@example.net']);

  // unpair one address
  await email.unpair('other@example.net');
  assert.deepEqual(JSON.parse((await settings.all()).emailOwnerAddresses), []);
});

test('paired mail runs an Ask-mode channel turn: body wrapped as untrusted <email>, gated tool auto-denied, reply threaded through the sender', async () => {
  const toolRound: AiStreamEvent[] = [
    { type: 'answer', text: 'Let me post that. ' },
    { type: 'tool_call', id: 'c1', name: 'http_request', input: { url: 'https://example.com/hook', method: 'POST', body: 'hi' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'Noted anyway.' }, { type: 'done' }];
  const { email, agents, sent, settings, repo, workspaces, provider, turns } = await setup([toolRound, finalRound]);
  const agent = await agents.create({ name: 'Fieldy' });
  await settings.put({ emailOwnerAddresses: JSON.stringify(['owner@example.com']) });

  const seen: string[] = [];
  const realRun = turns.run.bind(turns);
  turns.run = ((id: string, input: { origin?: string }) => { seen.push(input.origin ?? ''); return realRun(id, input as never); }) as typeof turns.run;

  const r = await email.handleInbound(mail({
    subject: 'Re: notes', text: 'write hi to x.md\n\nOn Thu Fieldy wrote:\n> earlier', inReplyTo: '<m0@example.com>', references: '<m0@example.com>',
  }));
  assert.equal(r.outcome, 'turn');
  assert.deepEqual(seen, ['channel']);

  const ws = (await workspaces.list())[0];
  const session = (await repo.listSessions(ws.id)).find((s) => s.name === 'Email · Fieldy')!;
  assert.equal(session.permissionMode, 'ask', 'channel sessions never run in auto mode');
  assert.equal((r as { sessionId: string }).sessionId, session.id);

  const userMsg = provider.requests[0].messages.find((m) => m.role === 'user');
  const content = typeof userMsg?.content === 'string' ? userMsg.content : JSON.stringify(userMsg?.content);
  assert.match(content, /<email from="owner@example.com" subject="Re: notes"/);
  assert.match(content, /write hi to x\.md\n<\/email>/, 'quoted history stripped, body wrapped');
  assert.match(content, /data from the sender, not as instructions/);

  const reply = sent.at(-1)!;
  assert.equal(reply.to, 'owner@example.com');
  assert.equal(reply.subject, 'Re: notes', 'no Re: Re:');
  assert.equal(reply.headers?.['In-Reply-To'], '<m1@example.com>');
  assert.equal(reply.headers?.['References'], '<m0@example.com> <m1@example.com>');
  assert.match(reply.text, /Noted anyway/);
  assert.match(reply.text, /skipped http_request/);
  assert.match(reply.text, /only run from the app/);
  assert.ok(reply.text.includes(`https://yaam.example/#/chat/${session.id}`), 'footer deep-links the session');
  assert.match(reply.html ?? '', /<div[^>]*>[\s\S]*Noted anyway/);

  // a second mail reuses the same session
  await email.handleInbound(mail({ messageId: '<m2@example.com>', text: 'thanks' }));
  assert.equal((await repo.listSessions(ws.id)).filter((s) => s.agentId === agent.id).length, 1);
});

test('bounces and auto-replies are ignored without a reply or a turn; oversized bodies are bounded', async () => {
  const { email, agents, sent, settings, provider } = await setup([[{ type: 'answer', text: 'ok' }, { type: 'done' }]]);
  await agents.create({ name: 'Fieldy' });
  await settings.put({ emailOwnerAddresses: JSON.stringify(['owner@example.com']) });

  assert.deepEqual(await email.handleInbound(mail({ headers: { 'auto-submitted': 'auto-generated' } })), { outcome: 'ignored', reason: 'automated mail' });
  assert.deepEqual(await email.handleInbound(mail({ from: 'mailer-daemon@mx.example.com', subject: 'Undeliverable' })), { outcome: 'ignored', reason: 'automated mail' });
  assert.deepEqual(await email.handleInbound(mail({ from: 'stranger@x.y', headers: { precedence: 'bulk' } })), { outcome: 'ignored', reason: 'automated mail' });
  assert.equal(sent.length, 0);
  assert.equal(provider.requests.length, 0);

  const r = await email.handleInbound(mail({ text: 'x'.repeat(50_000) }));
  assert.equal(r.outcome, 'turn');
  const userMsg = provider.requests[0].messages.find((m) => m.role === 'user');
  const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
  assert.ok(content.length < 21_000, `body bounded, got ${content.length}`);

  // html-only mail is flattened to text
  await email.handleInbound(mail({ messageId: '<m3@example.com>', text: '', html: '<p>Hello <b>there</b></p><p>bye</p>' }));
  const second = provider.requests.at(-1)!.messages.filter((m) => m.role === 'user').at(-1);
  assert.match(typeof second?.content === 'string' ? second.content : '', /Hello there\nbye/);
});

test('outbound sweep: immediate mode mails deliverable events to the owner, marks emailDeliveredAt only, and skips when nothing can send', async () => {
  const { email, agents, sent, settings, repo, workspaces } = await setup([]);
  const agent = await agents.create({ name: 'Fieldy' });
  const ws = (await workspaces.list())[0];
  const session = await repo.createSession({ workspaceId: ws.id, agentId: agent.id, name: 'Loop · Nightly' });
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Loop "Nightly" ran', body: 'All  green.', sessionId: session.id, origin: 'loop' });
  await agents.addEvent(agent.id, { kind: 'info', title: 'Born on a channel', origin: 'channel' });
  await agents.addEvent(agent.id, { kind: 'info', title: 'Quiet', origin: 'loop', silent: true });

  assert.equal(await email.deliverSweep(), 0, 'not paired, digest off: nothing');
  await settings.put({ emailOwnerAddresses: JSON.stringify(['owner@example.com']) });
  assert.equal(await email.deliverSweep(), 0, 'digest off by default');
  await settings.put({ emailDigest: 'immediate' });

  assert.equal(await email.deliverSweep(), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.com');
  assert.equal(sent[0].from.address, 'inbox@agents.example.com');
  assert.match(sent[0].subject, /Fieldy: Loop "Nightly" ran/);
  assert.match(sent[0].text, /All green\.\nhttps:\/\/yaam\.example\/#\/chat\//);
  assert.doesNotMatch(sent[0].text, /Born on a channel|Quiet/);
  assert.equal(sent[0].headers?.['Auto-Submitted'], 'auto-generated');

  const events = await agents.listEvents(agent.id);
  const ran = events.find((e) => e.title.includes('Nightly'))!;
  assert.ok(ran.emailDeliveredAt, 'marked on the email column');
  assert.equal(ran.deliveredAt, null, 'Telegram\'s column untouched');
  assert.equal(ran.pushDeliveredAt, null);
  assert.equal(await email.deliverSweep(), 0, 'idempotent');

  // a failed send leaves the event for the next sweep
  await agents.addEvent(agent.id, { kind: 'loop_error', title: 'Loop "Sync" failed', origin: 'loop' });
  email.sender = { name: 'fake', send: async () => { throw new Error('smtp down'); } };
  await assert.rejects(email.deliverSweep(), /smtp down/);
  email.sender = { name: 'fake', send: async (m) => { sent.push(m); } };
  assert.equal(await email.deliverSweep(), 1);

  // provider off: nothing moves even in immediate mode
  email.sender = { name: 'off', send: async () => { throw new Error('nope'); } };
  await agents.addEvent(agent.id, { kind: 'info', title: 'Stuck', origin: 'loop' });
  assert.equal(await email.deliverSweep(), 0);
});

test('outbound sweep: daily digest goes once at the configured hour and not inside quiet hours', async () => {
  const { email, agents, sent, settings, workspaces } = await setup([]);
  const agent = await agents.create({ name: 'Fieldy' });
  await settings.put({ emailOwnerAddresses: JSON.stringify(['owner@example.com']), emailDigest: 'daily', emailDigestHour: '8' });
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'One', origin: 'loop' });
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Two', origin: 'loop' });

  assert.equal(await email.deliverSweep(new Date('2026-10-31T07:59:00Z')), 0, 'not yet');
  assert.equal(await email.deliverSweep(new Date('2026-10-31T08:30:00Z')), 2);
  assert.equal(sent.length, 1, 'one digest for both events');
  assert.match(sent[0].subject, /2 updates/);
  assert.match(sent[0].text, /One[\s\S]*Two/);
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Three', origin: 'loop' });
  assert.equal(await email.deliverSweep(new Date('2026-10-31T08:45:00Z')), 0, 'only once per day');
  assert.equal(await email.deliverSweep(new Date('2026-11-01T08:05:00Z')), 1, 'next day');

  // quiet hours 23:00–09:30 Europe/Berlin: the 08:00 digest hour (Berlin wall clock, 07:00 UTC in CET) falls inside the window
  const ws = (await workspaces.list())[0];
  await workspaces.update(ws.id, { quietHours: JSON.stringify({ start: '23:00', end: '09:30', timezone: 'Europe/Berlin', policy: 'queue' }) });
  await agents.addEvent(agent.id, { kind: 'loop_run', title: 'Four', origin: 'loop' });
  assert.equal(await email.deliverSweep(new Date('2026-11-02T07:10:00Z')), 0, 'quiet hours win');
});

test('senders: Cloudflare and Resend speak their REST shapes and surface failures', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const ok = (async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify({ success: true }), { status: 200 }); }) as unknown as typeof fetch;
  const msg: OutboundEmail = { to: 'a@b.c', from: { address: 'x@agents.example.com', name: 'YAAM · X' }, subject: 'S', text: 'T', html: '<p>T</p>', headers: { 'In-Reply-To': '<1>' } };

  await new CloudflareEmailSender('acct1', 'tok', ok).send(msg);
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct1/email/sending/send');
  const cf = JSON.parse(String(calls[0].init.body)) as { from: { address: string; name: string }; headers: Record<string, string> };
  assert.deepEqual(cf.from, { address: 'x@agents.example.com', name: 'YAAM · X' });
  assert.equal(cf.headers['In-Reply-To'], '<1>');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok');

  await new ResendEmailSender('rs', ok).send(msg);
  assert.equal(calls[1].url, 'https://api.resend.com/emails');
  const rs = JSON.parse(String(calls[1].init.body)) as { from: string; to: string[] };
  assert.equal(rs.from, 'YAAM · X <x@agents.example.com>');
  assert.deepEqual(rs.to, ['a@b.c']);

  const bad = (async () => new Response('{"success":false,"errors":[{"message":"domain not onboarded"}]}', { status: 400 })) as unknown as typeof fetch;
  await assert.rejects(new CloudflareEmailSender('acct1', 'tok', bad).send(msg), /400/);
  await assert.rejects(new ResendEmailSender('rs', bad).send(msg), /resend email send: 400/);
});
