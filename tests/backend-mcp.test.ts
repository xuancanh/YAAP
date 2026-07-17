/** MCP (§10.3): Streamable-HTTP client, discovery caching, tool exposure,
 *  routing, and the Ask-mode gate for MCP calls. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpHttpClient } from '../server/src/mcp/mcp-client';
import { McpService } from '../server/src/mcp/mcp.module';
import { ChatsRepository } from '../server/src/chats/chats.repository';
import { ChatsService } from '../server/src/chats/chats.service';
import { TurnLoopService, TurnEvent } from '../server/src/chats/turn-loop.service';
import { ChatLocks } from '../server/src/chats/chat-locks';
import { ToolsService } from '../server/src/chats/tools.service';
import { testDb, memStorage, ctxStub, skillsStub, agentsStub, ScriptedProvider } from './helpers';
import { AiStreamEvent } from '../server/src/ai/ai-provider.interface';

/** A tiny in-memory MCP server speaking Streamable HTTP JSON-RPC. */
function fakeMcpServer(tools: Array<{ name: string; description: string }>, callResult = 'it worked') {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string; params: Record<string, unknown> };
    calls.push({ method: req.method, params: req.params });
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result =
      req.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } }
        : req.method === 'tools/list' ? { tools: tools.map((t) => ({ ...t, inputSchema: { type: 'object', properties: { q: { type: 'string' } } } })) }
          : req.method === 'tools/call' ? { content: [{ type: 'text', text: callResult }] }
            : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test('client initializes, lists tools, calls tools, and carries the session id', async () => {
  const { fn, calls } = fakeMcpServer([{ name: 'search-issues', description: 'Search the tracker' }]);
  const client = new McpHttpClient('https://mcp.example.com/mcp', fn);
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search-issues']);

  const out = await client.callTool('search-issues', { q: 'bug' });
  assert.equal(out, 'it worked');
  assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
});

test('client parses SSE-framed responses and surfaces JSON-RPC errors', async () => {
  let n = 0;
  const fn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id?: number; method: string };
    n++;
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'initialize') {
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} })}\n\n`, {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'nope' } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new McpHttpClient('https://mcp.example.com/mcp', fn);
  await assert.rejects(client.listTools(), /nope/);
  assert.ok(n >= 3);
});

test('stdio URLs are rejected', () => {
  assert.throws(() => new McpHttpClient('stdio://mcp-fs'), /only http\(s\)/);
});

test('discover caches tools on the row; specs and routing use the cache', async () => {
  const db = await testDb();
  const mcp = new McpService(db);
  const { fn } = fakeMcpServer([{ name: 'get-weather', description: 'Weather lookup' }], 'sunny, 21C');
  mcp.clientFactory = (url) => new McpHttpClient(url, fn);

  const server = await mcp.create({ name: 'Weather API', url: 'https://mcp.example.com/mcp' });
  const { tools } = await mcp.discover(server.id);
  assert.equal(tools.length, 1);

  const specs = await mcp.toolSpecs();
  assert.equal(specs.length, 1);
  assert.equal(specs[0].name, 'mcp_weather_api_get_weather');
  assert.match(specs[0].description, /\[MCP · Weather API\]/);

  assert.equal(await mcp.execute('mcp_weather_api_get_weather', { q: 'hanoi' }), 'sunny, 21C');
  await assert.rejects(mcp.execute('mcp_weather_api_no_such', {}), /unknown tool/);

  // disabled servers offer nothing
  await mcp.update(server.id, { enabled: false });
  assert.equal((await mcp.toolSpecs()).length, 0);
});

test('turn loop offers MCP tools and gates them behind approval in Ask mode (FR-10.3/4.2)', async () => {
  const db = await testDb();
  const mcp = new McpService(db);
  const { fn } = fakeMcpServer([{ name: 'send-alert', description: 'Pages someone' }], 'alert sent');
  mcp.clientFactory = (url) => new McpHttpClient(url, fn);
  const server = await mcp.create({ name: 'pager', url: 'https://mcp.example.com/mcp' });
  await mcp.discover(server.id);

  const repo = new ChatsRepository(db);
  const chats = new ChatsService(repo, agentsStub());
  const mcpRound: AiStreamEvent[] = [
    { type: 'tool_call', id: 'm1', name: 'mcp_pager_send_alert', input: { q: 'wake up' } },
    { type: 'done' },
  ];
  const finalRound: AiStreamEvent[] = [{ type: 'answer', text: 'paged.' }, { type: 'done' }];
  const provider = new ScriptedProvider([mcpRound, finalRound]);
  const { stub } = memStorage();
  const turns = new TurnLoopService(repo, new ChatLocks(), new ToolsService(stub), ctxStub(provider), skillsStub(), stub, mcp);

  const s = await chats.create({ workspaceId: 'ws1' }); // ask mode default
  let paused = false;
  const events: TurnEvent[] = [];
  for await (const ev of turns.run(s.id, { text: 'page the on-call' })) {
    events.push(ev);
    if (ev.type === 'approval_required') {
      paused = true;
      assert.equal(ev.tool, 'mcp_pager_send_alert');
      turns.resolveApproval(s.id, ev.callId, 'allow-once');
    }
  }
  assert.ok(paused, 'MCP call paused for approval in Ask mode');
  assert.ok(provider.requests[0].tools!.some((t) => t.name === 'mcp_pager_send_alert'));
  const result = events.find((e) => e.type === 'tool_result');
  assert.ok(result && !result.isError);
  assert.equal(result.output, 'alert sent');
});
