/** Workspace-file tools, search, slides, and the raw-HTTP guard (FR-3.3). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolsService, htmlToText } from '../server/src/chats/tools.service';
import { validateSlides, renderSlidesHtml } from '../server/src/chats/slides.util';
import { contentTypeFor, previewKindFor } from '../server/src/storage/preview.util';
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

test('fs_search finds matching lines across workspace text files', async () => {
  const { tools } = setup();
  await tools.execute('ws1', 'fs_write', { path: 'a.md', content: 'alpha\nthe needle is here\nomega' });
  await tools.execute('ws1', 'fs_write', { path: 'sub/b.txt', content: 'no match' });
  await tools.execute('ws2', 'fs_write', { path: 'c.md', content: 'needle in another workspace' });

  const out = await tools.execute('ws1', 'fs_search', { query: 'NEEDLE' });
  assert.match(out, /a\.md:2: the needle is here/);
  assert.ok(!out.includes('another workspace'), 'search stays inside the workspace');
  assert.match(await tools.execute('ws1', 'fs_search', { query: 'zzz-nothing' }), /no matches/);
});

test('slides_create renders a bounded, escaped, self-contained deck', async () => {
  const { tools, map } = setup();
  const out = await tools.execute('ws1', 'slides_create', {
    path: 'slides/demo.html',
    title: 'Demo <deck>',
    slides: [
      { title: 'One', bullets: ['first <b>point</b>', 'second'] },
      { title: 'Two', notes: 'speaker only' },
    ],
  });
  assert.match(out, /2-slide deck/);
  const html = map.get('workspaces/ws1/slides/demo.html')!.toString('utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Demo &lt;deck&gt;'), 'title is escaped');
  assert.ok(html.includes('first &lt;b&gt;point&lt;/b&gt;'), 'bullets are escaped');
  assert.ok(html.includes('speaker only'));
  assert.ok(!/src=|href=/.test(html), 'no external references (sandbox-safe)');

  await assert.rejects(
    tools.execute('ws1', 'slides_create', { path: 'x.html', title: 'T', slides: [] }),
    /non-empty array/,
  );
  await assert.rejects(
    tools.execute('ws1', 'slides_create', { path: 'x.html', title: 'T', slides: [{ notitle: true }] }),
    /needs a "title"/,
  );
  assert.throws(() => validateSlides('T', Array.from({ length: 51 }, () => ({ title: 'x' }))), /at most 50/);
  assert.ok(renderSlidesHtml('t', [{ title: 'only' }]).includes('only'));
});

test('htmlToText strips scripts, styles and tags into readable text', () => {
  const text = htmlToText('<html><head><style>.x{}</style><script>evil()</script></head><body><h1>Title</h1><p>Para one.</p><ul><li>a</li><li>b</li></ul></body></html>');
  assert.ok(!text.includes('evil'));
  assert.ok(!text.includes('.x{}'));
  assert.match(text, /Title/);
  assert.match(text, /Para one\./);
});

test('preview classification maps extensions to renderers and content types', () => {
  assert.equal(previewKindFor('docs/readme.md'), 'markdown');
  assert.equal(previewKindFor('slides/deck.html'), 'html');
  assert.equal(previewKindFor('img/logo.png'), 'image');
  assert.equal(previewKindFor('paper.pdf'), 'pdf');
  assert.equal(previewKindFor('src/main.ts'), 'text');
  assert.equal(previewKindFor('blob.bin'), 'binary');
  assert.equal(contentTypeFor('deck.html'), 'text/html');
  assert.equal(contentTypeFor('readme.md'), 'text/markdown');
  assert.equal(contentTypeFor('mystery.xyz'), 'application/octet-stream');
});

test('agent roots with an assigned workspace folder see it as shared/ (read, write, list, isolation)', async () => {
  const { stub, map } = memStorage();
  const tools = new ToolsService(stub);
  map.set('workspaces/ws1/projects/site/index.html', Buffer.from('<h1>hi</h1>'));
  map.set('workspaces/ws1/private/secret.md', Buffer.from('not mounted'));
  map.set('agents/agA/notes.md', Buffer.from('own file'));
  const root = { kind: 'agent' as const, id: 'agA', shared: { workspaceId: 'ws1', folder: 'projects/site' } };

  // list shows both worlds; the unassigned part of the workspace does not exist
  const listing = await tools.execute(root, 'fs_list', {});
  assert.match(listing, /notes\.md/);
  assert.match(listing, /shared\/index\.html/);
  assert.doesNotMatch(listing, /secret/);

  // read + write through the mount land in the workspace folder
  assert.equal(await tools.execute(root, 'fs_read', { path: 'shared/index.html' }), '<h1>hi</h1>');
  await tools.execute(root, 'fs_write', { path: 'shared/notes/todo.md', content: 'shared note' });
  assert.equal(map.get('workspaces/ws1/projects/site/notes/todo.md')!.toString(), 'shared note');

  // escaping the mount is refused by key validation
  await assert.rejects(tools.execute(root, 'fs_read', { path: 'shared/../private/secret.md' }), /invalid path/);

  // search spans both roots with mapped paths
  const found = await tools.execute(root, 'fs_search', { query: 'shared note' });
  assert.match(found, /shared\/notes\/todo\.md/);

  // without an assignment there is no shared/ at all
  const bare = { kind: 'agent' as const, id: 'agA' };
  assert.match(await tools.execute(bare, 'fs_read', { path: 'shared/index.html' }), /file not found/);
});
