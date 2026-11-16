import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

// New boards from the Boards view. Each one gets a folder in a temporary
// boards folder and its own server, which the tests stop at the end.
let app, home, boardsDir;
const started = [];
before(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'blueprint-home-'));
  boardsDir = await mkdtemp(path.join(tmpdir(), 'blueprint-boards-'));
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-hub-'));
  app = await startServer({ root, port: 0, home, boardsDir, previews: false });
});
after(async () => {
  for (const root of started) {
    const info = JSON.parse(await readFile(path.join(root, '.blueprint', 'server.json'), 'utf8').catch(() => '{}'));
    if (info.pid) process.kill(info.pid, 'SIGTERM');
  }
  await app.close();
});

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(app.url + p, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('a new board gets its own folder and server, and joins the list', async () => {
  const r = await call('POST', '/api/boards', { name: '  Ceramics   studio ' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  started.push(r.body.root);
  assert.equal(r.body.root, path.join(boardsDir, 'Ceramics studio'));
  assert.match(r.body.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(r.body.url, app.url, 'the new board runs on its own server');

  const health = await fetch(`${r.body.url}/api/health`).then((x) => x.json());
  assert.equal(health.root, r.body.root);
  assert.ok((await readdir(path.join(r.body.root, '.blueprint'))).includes('board.json'));

  const list = await call('GET', '/api/recents');
  assert.equal(list.body.boardsDir, boardsDir);
  assert.ok(list.body.projects.some((p) => p.root === r.body.root));
});

test('a name already used is refused with 409', async () => {
  const r = await call('POST', '/api/boards', { name: 'Ceramics studio' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already exists/);
});

test('a name that is empty, too long, or could leave the boards folder is refused', async () => {
  for (const name of ['', '   ', '../escape', 'a/b', 'a\\b', '.hidden', '..', 'x'.repeat(61), 'tab\u0000name', 42, null]) {
    const r = await call('POST', '/api/boards', { name });
    assert.equal(r.status, 400, `${JSON.stringify(name)} -> ${JSON.stringify(r.body)}`);
  }
  assert.deepEqual(await readdir(boardsDir), ['Ceramics studio'], 'nothing else was created');
});

test('another website cannot create a board', async () => {
  const r = await call('POST', '/api/boards', { name: 'From a website' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.deepEqual(await readdir(boardsDir), ['Ceramics studio']);
});
