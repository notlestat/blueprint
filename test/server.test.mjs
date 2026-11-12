import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';
import { findChrome } from '../lib/screenshot.mjs';

let app, root;
before(async () => {
  // Keep the Recents list in a temporary folder, never in the real ~/.blueprint.
  process.env.BLUEPRINT_HOME = await mkdtemp(path.join(tmpdir(), 'blueprint-home-'));
  root = await mkdtemp(path.join(tmpdir(), 'blueprint-srv-'));
  app = await startServer({ root, port: 0 }); // port 0 = any free port
});
after(() => app.close());

const call = async (method, p, body, headers = {}) => {
  const isText = typeof body === 'string';
  const res = await fetch(app.url + p, {
    method,
    headers: { ...(body !== undefined && { 'content-type': isText ? 'text/plain' : 'application/json' }), ...headers },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
};

// fetch() will not let us set a Host header, so use the raw http module for that.
const rawGet = (p, host) =>
  new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.port, path: p, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });

test('health reports the project root', async () => {
  const r = await call('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.root, root);
});

test('server.json records the port', async () => {
  const info = JSON.parse(await readFile(path.join(root, '.blueprint', 'server.json'), 'utf8'));
  assert.equal(info.port, app.port);
});

let artboardId, commentId;
test('create an artboard, write HTML, read it back', async () => {
  const made = await call('POST', '/api/artboards', { name: 'Pricing', width: 390, height: 780, html: '<button id="go">Start free trial</button>' });
  assert.equal(made.status, 201);
  artboardId = made.body.id;
  assert.equal((await call('GET', `/api/artboards/${artboardId}/html`)).body, '<button id="go">Start free trial</button>');
  const put = await call('PUT', `/api/artboards/${artboardId}/html`, '<h1>New</h1>');
  assert.equal(put.status, 200);
  assert.equal((await call('GET', `/api/artboards/${artboardId}/html`)).body, '<h1>New</h1>');
  assert.equal((await call('GET', '/api/board')).body.artboards.length, 1);
});

test('PATCH moves and renames an artboard', async () => {
  const r = await call('PATCH', `/api/artboards/${artboardId}`, { x: 200, name: 'Pricing v2' });
  assert.deepEqual([r.body.x, r.body.name], [200, 'Pricing v2']);
});

test('the artboard document is wrapped, sandboxed and carries the helper', async () => {
  const r = await call('GET', `/artboard/${artboardId}`);
  assert.equal(r.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.match(r.body, /<body><h1>New<\/h1><script>/);
  assert.match(r.body, /blueprint:elementAt/);
});

test('comments: create, reply, resolve', async () => {
  const made = await call('POST', '/api/comments', { artboardId, x: 20, y: 30, text: 'Less loud', target: { selector: '#go', tag: 'button', text: 'Start' } });
  assert.equal(made.status, 201);
  commentId = made.body.id;
  const replied = await call('POST', `/api/comments/${commentId}/replies`, { author: 'agent', text: 'Done' });
  assert.equal(replied.body.thread.length, 2);
  assert.equal((await call('PATCH', `/api/comments/${commentId}`, { status: 'resolved' })).body.status, 'resolved');
});

test('bad input gives 400 with a sentence, unknown ids give 404', async () => {
  const tooBig = await call('POST', '/api/artboards', { name: 'x', width: 9000 });
  assert.equal(tooBig.status, 400);
  assert.match(tooBig.body.error, /from 100 to 4000 pixels/);
  assert.equal((await call('POST', '/api/artboards', 'not json', { 'content-type': 'application/json' })).status, 400);
  assert.equal((await call('GET', '/api/artboards/ab_zzzz/html')).status, 404);
  assert.equal((await call('PATCH', '/api/comments/c_zzzz', { status: 'open' })).status, 404);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('a write from another origin is refused, including a sandboxed artboard', async () => {
  for (const origin of ['https://example.com', 'null', 'http://127.0.0.1:1']) {
    const r = await call('POST', '/api/comments', { artboardId, x: 1, y: 1, text: 'x' }, { origin });
    assert.equal(r.status, 403, origin);
  }
  const own = await call('POST', '/api/comments', { artboardId, x: 1, y: 1, text: 'from the page' }, { origin: app.url });
  assert.equal(own.status, 201);
});

test('a request with the wrong Host header is refused', async () => {
  assert.equal(await rawGet('/api/board', 'evil.test'), 403);
  assert.equal(await rawGet('/api/board', `127.0.0.1:${app.port}`), 200);
  assert.equal(await rawGet('/api/board', `localhost:${app.port}`), 200);
});

test('API responses carry no CORS header, so other pages cannot read them', async () => {
  const r = await call('GET', '/api/board', undefined, { origin: 'null' });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('static files are served with a strict policy and cannot escape public/', async () => {
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(await rawGet('/../server.mjs', `127.0.0.1:${app.port}`), 404);
  assert.equal(await rawGet('/%2e%2e/package.json', `127.0.0.1:${app.port}`), 404);
});

test('the event stream sends the board now and again on each change', async () => {
  const res = await fetch(app.url + '/api/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const nextBoard = async () => {
    let buf = '';
    for (;;) {
      const { value } = await reader.read();
      buf += decoder.decode(value);
      const m = buf.match(/event: board\ndata: (.+)\n\n/);
      if (m) return JSON.parse(m[1]);
    }
  };
  const first = await nextBoard();
  assert.equal(first.artboards.length, 1);
  const waiting = nextBoard();
  await call('POST', '/api/artboards', { name: 'Second' });
  assert.equal((await waiting).artboards.length, 2);
  await reader.cancel();
});

test('the board survives a restart', async () => {
  const before = (await call('GET', '/api/board')).body;
  await app.close();
  app = await startServer({ root, port: 0 });
  assert.deepEqual((await call('GET', '/api/board')).body, before);
});

test('a second project gets its own server and board', async () => {
  const other = await startServer({ root: await mkdtemp(path.join(tmpdir(), 'blueprint-srv-')), port: 0 });
  try {
    assert.notEqual(other.port, app.port);
    assert.equal((await (await fetch(other.url + '/api/board')).json()).artboards.length, 0);
    assert.equal((await call('GET', '/api/board')).body.artboards.length, 2);
  } finally {
    await other.close();
  }
});

test('delete moves the artboard to trash and drops its comments', async () => {
  const r = await call('DELETE', `/api/artboards/${artboardId}`);
  assert.equal(r.status, 200);
  const board = (await call('GET', '/api/board')).body;
  assert.equal(board.artboards.some((a) => a.id === artboardId), false);
  assert.equal(board.comments.length, 0);
});

test('screenshot is a PNG at exactly the artboard size', { skip: !findChrome() && 'Chrome is not installed' }, async () => {
  const made = await call('POST', '/api/artboards', { name: 'Phone', width: 390, height: 780, html: '<h1 style="font:40px sans-serif">Hello</h1>' });
  const res = await fetch(`${app.url}/api/artboards/${made.body.id}/screenshot`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  // Width and height sit at bytes 16 and 20 of every PNG file.
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [390, 780]);
});

test('agent activity: set, read, clear, and bad input', async () => {
  const made = await call('POST', '/api/artboards', { name: 'Busy' });
  const set = await call('POST', '/api/activity', { agentId: 'agent-1', name: 'Claude Code', action: 'writing', artboardId: made.body.id });
  assert.equal(set.status, 200);
  assert.deepEqual(
    (await call('GET', '/api/activity')).body.map(({ at, ...rest }) => rest),
    [{ agentId: 'agent-1', name: 'Claude Code', action: 'writing', artboardId: made.body.id }],
  );
  // A comment id points the agent at that comment's artboard.
  const c = await call('POST', '/api/comments', { artboardId: made.body.id, x: 5, y: 5, text: 'hi' });
  await call('POST', '/api/activity', { agentId: 'agent-2', action: 'replying', commentId: c.body.id });
  const two = (await call('GET', '/api/activity')).body;
  assert.equal(two.length, 2);
  assert.deepEqual([two[1].name, two[1].artboardId], ['Agent', made.body.id]);
  // An unknown artboard is not an error. The agent is shown without one.
  await call('POST', '/api/activity', { agentId: 'agent-2', action: 'looking', artboardId: 'ab_zzzz' });
  assert.equal((await call('GET', '/api/activity')).body[1].artboardId, null);
  assert.equal((await call('POST', '/api/activity', { agentId: 'agent-1', action: 'dancing' })).status, 400);
  assert.equal((await call('POST', '/api/activity', { action: 'writing' })).status, 400);
  await call('POST', '/api/activity', { agentId: 'agent-1', done: true });
  await call('POST', '/api/activity', { agentId: 'agent-2', done: true });
  assert.deepEqual((await call('GET', '/api/activity')).body, []);
  // Activity is not saved in the board file.
  assert.doesNotMatch(await readFile(path.join(root, '.blueprint', 'board.json'), 'utf8'), /agent-1|activity/);
});
