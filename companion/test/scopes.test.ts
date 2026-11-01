/** The companion's own gates: scope parsing, the lexical check, and the
 *  realpath jail for file operations (no symlink escapes). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileRoots, isSubset, lexicallyWithin, parseScopes, resolveInRoots, scopeDenial } from '../src/scopes.js';
import { appleScriptForKey, parseCombo, pngSize } from '../src/platform.js';
import { runShell } from '../src/actions.js';

test('parseScopes: words, absolute roots, canonical form; rejects relative, root, unknown, empty', () => {
  assert.deepEqual(parseScopes('screen,input'), ['screen', 'input']);
  assert.deepEqual(parseScopes('screen, files:/a/b/../c/'), ['screen', `files:${path.resolve('/a/c')}`]);
  assert.deepEqual(parseScopes(['shell', 'shell']), ['shell']);
  assert.throws(() => parseScopes('files:relative'), /absolute/);
  assert.throws(() => parseScopes('files:/'), /whole drive|root/);
  assert.throws(() => parseScopes('camera'), /unknown scope/);
  assert.throws(() => parseScopes(''), /at least one/);
  if (process.platform === 'win32') {
    assert.deepEqual(parseScopes('files:C:\\Users\\me,input'), ['files:C:\\Users\\me', 'input']);
  }
});

test('scopeDenial and isSubset mirror the server rules', () => {
  const scopes = ['screen', 'files:/Users/me/Projects'];
  assert.equal(scopeDenial(scopes, 'computer_screenshot'), null);
  assert.match(scopeDenial(scopes, 'computer_click')!, /input scope/);
  assert.match(scopeDenial(scopes, 'computer_shell')!, /shell scope/);
  assert.equal(scopeDenial(scopes, 'computer_read_file'), null);
  assert.match(scopeDenial(['screen'], 'computer_read_file')!, /files:<dir>/);
  assert.match(scopeDenial(scopes, 'fs_read')!, /unknown tool/);
  assert.deepEqual(fileRoots(scopes), ['/Users/me/Projects']);
  assert.equal(isSubset(scopes, ['screen']), true);
  assert.equal(isSubset(scopes, ['files:/Users/me/Projects/one']), true);
  assert.equal(isSubset(scopes, ['files:/Users/me']), false);
  assert.equal(isSubset(scopes, ['shell']), false);
  assert.equal(lexicallyWithin('/a/bc', '/a/b'), false, 'prefix without separator is outside');
  assert.equal(lexicallyWithin('/a/b', '/a/b'), true);
});

test('resolveInRoots: realpath jail — symlinks out of the root are refused, new files need an in-root parent', async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'yaam-comp-')));
  try {
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    await mkdir(path.join(root, 'sub'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(root, 'in.txt'), 'in');
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'));
    await symlink(outside, path.join(root, 'leakdir'));
    const roots = [root];

    assert.equal(await resolveInRoots(path.join(root, 'in.txt'), roots, { mustExist: true }), path.join(root, 'in.txt'));
    assert.equal(await resolveInRoots(root, roots, { mustExist: true }), root, 'the root itself is inside');
    await assert.rejects(resolveInRoots(path.join(root, 'leak.txt'), roots, { mustExist: true }), /symlink/);
    await assert.rejects(resolveInRoots(path.join(root, 'leakdir', 'secret.txt'), roots, { mustExist: true }), /symlink/);
    await assert.rejects(resolveInRoots(path.join(root, '..', 'outside', 'secret.txt'), roots, { mustExist: true }), /outside/);
    await assert.rejects(resolveInRoots(path.join(outside, 'secret.txt'), roots, { mustExist: true }), /outside/);
    await assert.rejects(resolveInRoots('relative.txt', roots, { mustExist: true }), /absolute/);
    await assert.rejects(resolveInRoots(path.join(root, 'missing.txt'), roots, { mustExist: true }), /no such file/);

    // writes: a new file inside is fine; a new file under a symlinked dir is not; a missing parent is not
    assert.equal(await resolveInRoots(path.join(root, 'sub', 'new.txt'), roots, { mustExist: false }), path.join(root, 'sub', 'new.txt'));
    await assert.rejects(resolveInRoots(path.join(root, 'leakdir', 'new.txt'), roots, { mustExist: false }), /outside/);
    await assert.rejects(resolveInRoots(path.join(root, 'nope', 'new.txt'), roots, { mustExist: false }), /parent directory does not exist/);
    // a root given through a symlink still works (macOS /tmp → /private/tmp)
    const linkRoot = path.join(base, 'rootlink');
    await symlink(root, linkRoot);
    assert.equal(await resolveInRoots(path.join(linkRoot, 'in.txt'), [linkRoot], { mustExist: true }), path.join(root, 'in.txt'));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('key combos parse and map to AppleScript; PNG header reads size', () => {
  const c = parseCombo('cmd+shift+s');
  assert.deepEqual([...c.mods].sort(), ['cmd', 'shift']);
  assert.equal(c.key, 's');
  assert.equal(appleScriptForKey(c), 'keystroke "s" using {command down, shift down}');
  assert.equal(appleScriptForKey(parseCombo('enter')), 'key code 36');
  assert.equal(appleScriptForKey(parseCombo('ctrl+Return')), 'key code 36 using {control down}');
  assert.throws(() => parseCombo('a+b'), /two keys/);
  assert.throws(() => parseCombo('cmd+'), /no key/);
  assert.throws(() => appleScriptForKey(parseCombo('hyperkey')), /unknown key/);
  const png = Buffer.alloc(33);
  png.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'ascii'); png.writeUInt32BE(2880, 16); png.writeUInt32BE(1800, 20);
  assert.deepEqual(pngSize(png), { width: 2880, height: 1800 });
  assert.throws(() => pngSize(Buffer.from('nope')), /not a PNG/);
});

test('runShell: bounded output, exit codes, and a hard timeout', { skip: process.platform === 'win32' }, async () => {
  const okRun = await runShell('echo hello; echo err 1>&2', '', 10);
  assert.equal(okRun.ok, true);
  assert.match(okRun.output!, /exit code 0/);
  assert.match(okRun.output!, /stdout:\nhello/);
  assert.match(okRun.output!, /stderr:\nerr/);
  const fail = await runShell('exit 3', '', 10);
  assert.equal(fail.ok, false);
  assert.match(fail.output!, /exit code 3/);
  const slow = await runShell('sleep 5', '', 1);
  assert.equal(slow.ok, false);
  assert.match(slow.output!, /killed: exceeded the 1s time limit/);
  const big = await runShell('head -c 200000 /dev/zero | tr "\\0" x', '', 10);
  assert.match(big.output!, /truncated at 64 KB/);
  assert.ok(big.output!.length < 70_000);
});
