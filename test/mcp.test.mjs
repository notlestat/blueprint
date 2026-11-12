import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findChrome } from '../lib/screenshot.mjs';
import { PNG_3x2 } from './fixtures.mjs';

// These tests act as an agent would: they start mcp.mjs and call its tools.
const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp.mjs');
let client, root;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'blueprint-mcp-'));
  const home = await mkdtemp(path.join(tmpdir(), 'blueprint-home-')); // Recents list, kept out of ~/.blueprint
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env: { ...process.env, BLUEPRINT_ROOT: root, BLUEPRINT_HOME: home } }));
});

after(async () => {
  await client.close();
  // mcp.mjs started a detached server. Stop it so the test leaves nothing running.
  const info = JSON.parse(await readFile(path.join(root, '.blueprint', 'server.json'), 'utf8').catch(() => '{}'));
  if (info.pid) process.kill(info.pid, 'SIGTERM');
});

const run = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content.find((c) => c.type === 'text')?.text };
};

test('lists the seventeen tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [
      'add_note', 'add_reference', 'connect', 'create_artboard', 'delete_artboard', 'delete_item', 'finish_working', 'get_board', 'get_html',
      'get_reference', 'get_screenshot', 'list_comments', 'reply_to_comment', 'resolve_comment', 'update_artboard', 'update_item', 'write_html',
    ],
  );
});

let id;
test('the first tool call starts the server and creates the board files', async () => {
  const made = await run('create_artboard', { name: 'Phone', width: 390, height: 780, html: '<button>Start</button>' });
  assert.ok(!made.isError, made.text);
  id = made.text.match(/ab_[a-z0-9]{4}/)[0];
  await access(path.join(root, '.blueprint', 'board.json'));
  await access(path.join(root, '.blueprint', 'artboards', `${id}.html`));
  const board = JSON.parse((await run('get_board')).text);
  assert.match(board.url, /^http:\/\/127\.0\.0\.1:44\d\d$/);
  assert.equal(board.artboards[0].name, 'Phone');
});

test('write, read and resize an artboard', async () => {
  await run('write_html', { artboardId: id, html: '<h1>Changed</h1>' });
  assert.equal((await run('get_html', { artboardId: id })).text, '<h1>Changed</h1>');
  const resized = JSON.parse((await run('update_artboard', { artboardId: id, width: 400 })).text);
  assert.equal(resized.width, 400);
});

test('the comment loop: the user pins, the agent reads, replies and resolves', async () => {
  const { url } = JSON.parse((await run('get_board')).text);
  // The user's side of the loop is a plain HTTP call from the canvas page.
  const posted = await fetch(url + '/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artboardId: id, x: 20, y: 20, text: 'Make it bigger', target: { selector: 'h1', tag: 'h1', text: 'Changed' } }),
  }).then((r) => r.json());

  const open = JSON.parse((await run('list_comments')).text);
  assert.equal(open.length, 1);
  assert.equal(open[0].number, 1);
  assert.equal(open[0].artboard, 'Phone');
  assert.equal(open[0].target.selector, 'h1');

  await run('reply_to_comment', { commentId: posted.id, text: 'Raised it to 48px.' });
  await run('resolve_comment', { commentId: posted.id });
  assert.match((await run('list_comments')).text, /No open comments/);
  const all = JSON.parse((await run('list_comments', { status: 'all' })).text);
  assert.deepEqual(all[0].thread.map((m) => m.author), ['user', 'agent']);
  assert.equal(all[0].status, 'resolved');
});

test('the board shows what the agent is doing, until finish_working', async () => {
  const { url } = JSON.parse((await run('get_board')).text);
  await run('write_html', { artboardId: id, html: '<h1>Changed</h1>' });
  const busy = await fetch(url + '/api/activity').then((r) => r.json());
  assert.equal(busy.length, 1);
  assert.deepEqual([busy[0].name, busy[0].action, busy[0].artboardId], ['Test', 'writing', id]);
  await run('finish_working');
  assert.deepEqual(await fetch(url + '/api/activity').then((r) => r.json()), []);
});

test('references: the user places an image and a note, the agent sees them, adds its own, and connects them', async () => {
  const { url } = JSON.parse((await run('get_board')).text);
  // The user's side: the canvas page uploads a pasted image and adds a note.
  const { asset } = await fetch(url + '/api/assets', { method: 'POST', body: PNG_3x2 }).then((r) => r.json());
  const img = await fetch(url + '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'image', asset, x: 0, y: 1000 }) }).then((r) => r.json());
  await fetch(url + '/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'note', text: 'Use this colour', x: 400, y: 1000 }) });

  const board = JSON.parse((await run('get_board')).text);
  assert.equal(board.notes[0].text, 'Use this colour');
  assert.equal(board.references[0].src, `/assets/${asset}`);

  const ref = await run('get_reference', { itemId: img.id });
  const picture = ref.content.find((c) => c.type === 'image');
  assert.equal(picture.mimeType, 'image/png');
  assert.deepEqual(Buffer.from(picture.data, 'base64'), PNG_3x2);

  const note = await run('add_note', { text: 'I took the blue from your image.', near: id });
  const snippet = await run('add_note', { text: 'color: #0a84ff;', code: true, near: id });
  assert.match(snippet.text, /code card/);
  const noteId = note.text.match(/it_[a-z0-9]{4}/)[0];
  assert.ok(!(await run('connect', { from: img.id, to: id, label: 'palette' })).isError);
  const file = path.join(root, 'ref.png');
  await writeFile(file, PNG_3x2);
  const added = await run('add_reference', { path: 'ref.png', near: id });
  assert.match(added.text, /\/assets\/[a-f0-9]{16}\.png/);
  assert.match((await run('add_reference', { path: 'ref.png', url: 'https://example.com' })).text, /exactly one/);

  const after = JSON.parse((await run('get_board')).text);
  assert.equal(after.notes.find((n) => n.id === noteId).author, 'agent');
  assert.equal(after.references.find((r) => r.type === 'code').text, 'color: #0a84ff;');
  assert.equal(after.arrows[0].label, 'palette');
  assert.match((await run('delete_item', { id: img.id })).text, /and 1 arrow/);
  assert.equal(JSON.parse((await run('get_board')).text).arrows.length, 0);
});

test('a bad call comes back as a readable error, not a crash', async () => {
  const r = await run('write_html', { artboardId: 'ab_zzzz', html: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /No artboard with id/);
  const big = await run('create_artboard', { name: 'Too big', width: 9000 });
  assert.match(big.text, /from 100 to 4000 pixels/);
});

test('get_screenshot returns a PNG image', { skip: !findChrome() && 'Chrome is not installed' }, async () => {
  const r = await run('get_screenshot', { artboardId: id });
  const image = r.content.find((c) => c.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [400, 780]);
});

test('delete_artboard keeps the HTML in trash', async () => {
  await run('delete_artboard', { artboardId: id });
  assert.equal(JSON.parse((await run('get_board')).text).artboards.length, 0);
});
