/** Workspace-file tools and the raw-HTTP guard (FR-3.3 first slice). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolsService } from '../server/src/chats/tools.service';
import { memStorage } from './helpers';

function setup() {
  const { stub, map } = memStorage();
  return { tools: new ToolsService(stub), map };
}

test('fs tools round-trip through workspace-scoped keys', async () => {
  const { tools, map } = setup();
  await tools.execute('ws1', 'fs_write', { path: 'knowledge/a.md', content: 'alpha' });
  assert.ok(map.has('workspaces/ws1/knowledge/a.md'));

  assert.equal(await tools.execute('ws1', 'fs_read', { path: 'knowledge/a.md' }), 'alpha');
  assert.match(await tools.execute('ws1', 'fs_list', {}), /knowledge\/a\.md \(5 bytes\)/);

  await tools.execute('ws1', 'fs_delete', { path: 'knowledge/a.md' });
  assert.equal(map.size, 0);
  assert.match(await tools.execute('ws1', 'fs_read', { path: 'knowledge/a.md' }), /file not found/);
});

test('traversal in tool paths is rejected', async () => {
  const { tools } = setup();
  await assert.rejects(tools.execute('ws1', 'fs_read', { path: '../ws2/secret.md' }), /invalid path/);
  await assert.rejects(tools.execute('ws1', 'fs_write', { path: 'x', content: 42 as unknown as string }), /invalid arguments/);
});

test('read-only flags drive the approval policy', () => {
  const { tools } = setup();
  assert.equal(tools.isReadOnly('fs_list'), true);
  assert.equal(tools.isReadOnly('fs_read'), true);
  assert.equal(tools.isReadOnly('fs_write'), false);
  assert.equal(tools.isReadOnly('fs_delete'), false);
  assert.equal(tools.isReadOnly('http_request'), false);
  assert.equal(tools.isReadOnly('nope'), undefined);
});

test('http_request refuses private/internal hosts (SSRF guard)', async () => {
  const { tools } = setup();
  for (const url of [
    'http://localhost:8790/api/status',
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data',
    'ftp://example.com/x',
    'not a url',
  ]) {
    await assert.rejects(tools.execute('ws1', 'http_request', { url }), /not allowed|are allowed|not a valid URL/);
  }
});
