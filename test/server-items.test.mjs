// HTTP routes for notes, references, arrows, assets and Recents.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { isPrivateAddress, fetchPreview, parsePreview } from '../lib/preview.mjs';
import { deleteBoard } from '../lib/recents.mjs';
import { PNG_3x2 } from './fixtures.mjs';

let app, root, home;
before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'blueprint-home-'));
  root = await mkdtemp(path.join(tmpdir(), 'blueprint-srv-items-'));
  // previews: false keeps the tests off the internet.
  app = await startServer({ root, port: 0, home, previews: false });
});
after(() => app.close());

const call = async (method, p, body, headers = {}) => {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(app.url + p, {
    method,
    headers: { ...(body !== undefined && !raw && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

test('a malformed address is a 400, not a server error', async () => {
  const r = await call('GET', '/api/artboards/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /broken %-escape/);
});

test('upload an image, place it, and read it back with safe headers', async () => {
  const up = await call('POST', '/api/assets', PNG_3x2, { 'content-type': 'image/png' });
  assert.equal(up.status, 201);
  assert.deepEqual([up.body.width, up.body.height], [3, 2]);
  const img = await call('GET', `/assets/${up.body.asset}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.match(img.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(img.body, PNG_3x2);
  const item = await call('POST', '/api/items', { type: 'image', asset: up.body.asset, x: 0, y: 1200 });
  assert.equal(item.status, 201);
  assert.equal(item.body.height, Math.round(item.body.width * (2 / 3)));
});

test('an upload that is not an image, or a bad asset name, is refused', async () => {
  const svg = await call('POST', '/api/assets', Buffer.from('<svg onload="alert(1)"/>'), { 'content-type': 'image/png' });
  assert.equal(svg.status, 400);
  assert.equal((await call('GET', '/assets/..%2Fboard.json')).status, 404);
  assert.equal((await call('GET', '/assets/0123456789abcdef.png')).status, 404);
});

test('another website cannot upload, add notes or draw arrows', async () => {
  const evil = { origin: 'https://example.com' };
  assert.equal((await call('POST', '/api/assets', PNG_3x2, evil)).status, 403);
  assert.equal((await call('POST', '/api/items', { type: 'note', x: 0, y: 0 }, evil)).status, 403);
  assert.equal((await call('POST', '/api/connectors', { from: 'it_aaaa', to: 'it_bbbb' }, evil)).status, 403);
  // A sandboxed artboard sends Origin: null.
  assert.equal((await call('POST', '/api/items', { type: 'note', x: 0, y: 0 }, { origin: 'null' })).status, 403);
});

test('notes and arrows: create, edit, delete, and the board stream carries them', async () => {
  const a = (await call('POST', '/api/artboards', { name: 'Home' })).body;
  const n = (await call('POST', '/api/items', { type: 'note', x: -400, y: 0, text: 'Warmer palette' })).body;
  const ln = await call('POST', '/api/connectors', { from: n.id, to: a.id });
  assert.equal(ln.status, 201);
  assert.equal((await call('PATCH', `/api/connectors/${ln.body.id}`, { label: 'apply here' })).body.label, 'apply here');
  assert.equal((await call('PATCH', `/api/items/${n.id}`, { x: -500 })).body.x, -500);

  const board = (await call('GET', '/api/board')).body;
  assert.ok(board.items.some((i) => i.id === n.id));
  assert.equal(board.connectors[0].from, n.id);

  const del = await call('DELETE', `/api/items/${n.id}`);
  assert.equal(del.body.item.id, n.id);
  assert.equal(del.body.connectors.length, 1, 'the delete returns the arrows it removed, for undo');
  assert.equal((await call('GET', '/api/board')).body.connectors.length, 0);
  assert.equal((await call('DELETE', `/api/connectors/${ln.body.id}`)).status, 404);
});

test('a link card refuses non-web addresses', async () => {
  const bad = await call('POST', '/api/items', { type: 'link', url: 'javascript:alert(1)', x: 0, y: 0 });
  assert.equal(bad.status, 400);
  const good = await call('POST', '/api/items', { type: 'link', url: 'https://example.com', x: 0, y: 0 });
  assert.equal(good.body.title, 'example.com');
});

test('Recents lists this project with an outline, and opens only known folders', async () => {
  await app.store.flush();
  const r = await call('GET', '/api/recents');
  assert.equal(r.body.current, root);
  const me = r.body.projects.find((p) => p.root === root);
  assert.ok(me, 'the running project is in Recents');
  assert.equal(me.url, app.url);
  assert.ok(me.outline.some((b) => b.k === 'a'), 'the outline has the artboard');
  assert.equal((await call('POST', '/api/recents/open', { root })).body.url, app.url);
  assert.equal((await call('POST', '/api/recents/open', { root: '/etc' })).status, 404);
  assert.equal((await call('POST', '/api/recents/open', { root: 'relative/path' })).status, 400);
  const list = JSON.parse(await readFile(path.join(home, 'recents.json'), 'utf8'));
  assert.equal(list.projects[0].root, root);
});

test('link previews refuse this machine and the local network', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '2606:2800:220:1::1']) assert.equal(isPrivateAddress(ip), false, ip);
  assert.equal(await fetchPreview(`${app.url}/api/board`), null);
  assert.equal(await fetchPreview('http://localhost:1/'), null);
});

test('Recents deletes another board by moving its folder, and refuses this one or unknown folders', async () => {
  // A second project with a board, opened through Recents so its server runs as its own process.
  const other = await mkdtemp(path.join(tmpdir(), 'blueprint-other-'));
  const second = await startServer({ root: other, port: 0, home, previews: false });
  await second.store.createArtboard({ name: 'Keep my code safe' });
  await second.close();
  await writeFile(path.join(other, 'index.js'), 'console.log("project file");');
  const opened = await call('POST', '/api/recents/open', { root: other });
  assert.match(opened.body.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const info = JSON.parse(await readFile(path.join(other, '.blueprint', 'server.json'), 'utf8'));

  assert.equal((await call('POST', '/api/recents/delete', { root })).status, 400, 'cannot delete the open board');
  assert.equal((await call('POST', '/api/recents/delete', { root: '/etc' })).status, 404);

  const del = await call('POST', '/api/recents/delete', { root: other });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.ok(del.body.movedTo.startsWith(path.join(home, 'deleted')));
  assert.equal(JSON.parse(await readFile(path.join(del.body.movedTo, 'board.json'), 'utf8')).artboards[0].name, 'Keep my code safe');
  await assert.rejects(access(path.join(other, '.blueprint')), 'the board folder has moved');
  assert.equal(await readFile(path.join(other, 'index.js'), 'utf8'), 'console.log("project file");', 'project files stay');
  assert.throws(() => process.kill(info.pid, 0), 'its server has stopped');
  assert.ok(!(await call('GET', '/api/recents')).body.projects.some((p) => p.root === other));
});

// ---- regressions from the pre-merge review ----

test('link previews refuse loopback hidden inside an IPv6 address, and the other reserved ranges', async () => {
  for (const ip of ['::ffff:7f00:1', '::ffff:c0a8:101', '::ffff:a9fe:a9fe', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '198.18.0.1', '192.0.0.1', '224.0.0.1', '255.255.255.255', 'fec0::1', 'not-an-ip'])
    assert.equal(isPrivateAddress(ip), true, ip);
  // This server answers on 127.0.0.1. Written as a mapped IPv6 address, it must still be refused.
  assert.equal(await fetchPreview(`http://[::ffff:127.0.0.1]:${app.port}/`), null);
  assert.equal(await fetchPreview(`http://[::ffff:7f00:1]:${app.port}/`), null);
});

test('a hostile page cannot make title parsing slow', () => {
  const start = performance.now();
  assert.equal(parsePreview('<meta '.repeat(90000) + '<title'.repeat(90000)), null);
  assert.ok(performance.now() - start < 300, `took ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(parsePreview('<head><meta property="og:title" content="Tides &amp; times"><meta name="description" content="When to walk &#128054;"></head>'), {
    title: 'Tides & times',
    description: 'When to walk 🐶',
  });
  assert.equal(parsePreview('<title>Ok &#99999999;</title>').title, 'Ok &#99999999;');
});

test('an upload over the limit gets the size message, not a dropped connection', async () => {
  const big = await call('POST', '/api/assets', Buffer.alloc(10 * 1024 * 1024 + 10));
  assert.equal(big.status, 400);
  assert.match(big.body.error, /larger than the 10485760 byte \(10 MB\) limit/);
});

test('an image that claims an impossible size is refused', async () => {
  const huge = Buffer.from(PNG_3x2);
  huge.writeUInt32BE(4294967295, 16);
  assert.equal((await call('POST', '/api/assets', huge)).status, 400);
});

test('one malformed board does not break the Recents list', async () => {
  const bad = await mkdtemp(path.join(tmpdir(), 'blueprint-bad-'));
  const b = await startServer({ root: bad, port: 0, home, previews: false });
  await b.close();
  await writeFile(path.join(bad, '.blueprint', 'board.json'), JSON.stringify({ version: 1, artboards: 'nope', items: [{}], comments: 5 }));
  const r = await call('GET', '/api/recents');
  assert.equal(r.status, 200);
  assert.ok(r.body.projects.some((p) => p.root === root), 'the good board is still listed');
  const row = r.body.projects.find((p) => p.root === bad);
  assert.equal(row.artboards, 0);
});

test('delete never signals a pid it cannot confirm, and refuses the folder that holds Recents', async () => {
  const other = await mkdtemp(path.join(tmpdir(), 'blueprint-pid-'));
  const s = await startServer({ root: other, port: 0, home, previews: false });
  await s.store.createArtboard({ name: 'Board' }); // board.json is written on the first change
  await s.close();
  // A forged server.json: a group-wide pid and a port where a different board answers.
  await writeFile(path.join(other, '.blueprint', 'server.json'), JSON.stringify({ port: app.port, pid: -1, root: other }));
  const moved = await deleteBoard(home, other);
  assert.ok(moved.startsWith(path.join(home, 'deleted')), 'treated as not running, and nothing was signalled');

  const fakeHome = await mkdtemp(path.join(tmpdir(), 'blueprint-homeproj-'));
  await mkdir(path.join(fakeHome, '.blueprint'), { recursive: true });
  await writeFile(path.join(fakeHome, '.blueprint', 'board.json'), JSON.stringify({ version: 1, artboards: [], comments: [] }));
  await assert.rejects(deleteBoard(path.join(fakeHome, '.blueprint'), fakeHome), /holds Blueprint's own settings/);
});
