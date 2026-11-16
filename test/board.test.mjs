import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBoard, toDocument, LIMITS, BoardError } from '../lib/board.mjs';

const fresh = async () => openBoard(await mkdtemp(path.join(tmpdir(), 'blueprint-')));

test('a new board is empty, makes its folders and writes board.json at once', async () => {
  const b = await fresh();
  assert.deepEqual(b.get(), { version: 1, artboards: [], comments: [], items: [], connectors: [] });
  assert.deepEqual((await readdir(b.dir)).sort(), ['artboards', 'board.json', 'trash']);
  assert.deepEqual(JSON.parse(await readFile(path.join(b.dir, 'board.json'), 'utf8')).artboards, []);
});

test('createArtboard uses defaults, writes both files and places boards in a row', async () => {
  const b = await fresh();
  const first = await b.createArtboard({ name: 'Pricing', html: '<h1>Hi</h1>' });
  assert.match(first.id, /^ab_[a-z0-9]{4}$/);
  assert.deepEqual([first.x, first.y, first.width, first.height], [0, 0, 1440, 900]);
  const second = await b.createArtboard({ name: 'Phone', width: 390, height: 780 });
  assert.equal(second.x, 1440 + 80);
  assert.equal(await readFile(path.join(b.dir, 'artboards', `${first.id}.html`), 'utf8'), '<h1>Hi</h1>');
  await b.flush();
  assert.equal(JSON.parse(await readFile(path.join(b.dir, 'board.json'), 'utf8')).artboards.length, 2);
});

test('a board survives being closed and opened again', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'Keep me' });
  await b.addComment({ artboardId: a.id, x: 10, y: 10, text: 'note' });
  await b.flush();
  const again = await openBoard(b.root);
  assert.equal(again.get().artboards[0].name, 'Keep me');
  assert.equal(again.get().comments[0].thread[0].text, 'note');
});

test('setHtml replaces the HTML and getHtml reads it back', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A', html: 'one' });
  await b.setHtml(a.id, 'two');
  assert.equal(await b.getHtml(a.id), 'two');
});

test('updateArtboard changes only what is sent and rejects an empty patch', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A' });
  const moved = await b.updateArtboard(a.id, { x: 300.4, name: 'B' });
  assert.deepEqual([moved.x, moved.name, moved.width], [300, 'B', 1440]);
  await assert.rejects(b.updateArtboard(a.id, {}), /Nothing to update/);
});

test('deleteArtboard moves the file to trash and removes its comments', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A', html: 'bye' });
  const keep = await b.createArtboard({ name: 'B' });
  await b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'gone' });
  await b.addComment({ artboardId: keep.id, x: 1, y: 1, text: 'stays' });
  await b.deleteArtboard(a.id);
  assert.deepEqual(b.get().artboards.map((x) => x.id), [keep.id]);
  assert.deepEqual(b.get().comments.map((c) => c.thread[0].text), ['stays']);
  const trash = await readdir(path.join(b.dir, 'trash'));
  assert.equal(trash.length, 1);
  assert.equal(await readFile(path.join(b.dir, 'trash', trash[0]), 'utf8'), 'bye');
});

test('restore brings a deleted artboard back with its HTML, comments and arrows, in place', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A', html: 'hello' });
  const other = await b.createArtboard({ name: 'B' });
  const note = await b.createItem({ type: 'note', text: 'why' });
  await b.addComment({ artboardId: other.id, x: 1, y: 1, text: 'first' });
  await b.addComment({ artboardId: a.id, x: 2, y: 2, text: 'second' });
  await b.createConnector({ from: note.id, to: a.id });
  const removed = await b.deleteArtboard(a.id);
  assert.equal(removed.comments, 1);
  assert.equal(b.get().connectors.length, 0);
  await b.restore(a.id);
  assert.deepEqual(b.get().artboards.map((x) => x.name), ['A', 'B']);
  assert.deepEqual(b.get().comments.map((c) => c.thread[0].text), ['first', 'second']);
  assert.equal(b.get().connectors.length, 1);
  assert.equal(await b.getHtml(a.id), 'hello');
  assert.deepEqual(await readdir(path.join(b.dir, 'trash')), []);
  // A second undo of the same delete has nothing to bring back.
  await assert.rejects(b.restore(a.id), /Nothing deleted/);
});

test('deleteComment removes one comment, and restore puts it back at the same number', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A' });
  await b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'one' });
  const two = await b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'two' });
  await b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'three' });
  await b.deleteComment(two.id);
  assert.deepEqual(b.get().comments.map((c) => c.thread[0].text), ['one', 'three']);
  await b.restore(two.id);
  assert.deepEqual(b.get().comments.map((c) => c.thread[0].text), ['one', 'two', 'three']);
  await assert.rejects(b.deleteComment('c_zzzz'), (e) => e instanceof BoardError && e.status === 404);
});

test('a deleted comment cannot come back after its artboard has gone', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A' });
  const c = await b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'orphan' });
  await b.deleteComment(c.id);
  await b.deleteArtboard(a.id);
  await assert.rejects(b.restore(c.id), /artboard/);
});

test('comments: add, reply and resolve', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A' });
  const c = await b.addComment({ artboardId: a.id, x: 320, y: 140, text: 'Less loud', target: { selector: 'button', tag: 'button', text: 'Start' } });
  assert.match(c.id, /^c_[a-z0-9]{4}$/);
  assert.equal(c.status, 'open');
  assert.deepEqual(c.target, { selector: 'button', tag: 'button', text: 'Start' });
  await b.reply(c.id, { author: 'agent', text: 'Done' });
  assert.deepEqual(c.thread.map((m) => m.author), ['user', 'agent']);
  assert.equal((await b.setStatus(c.id, 'resolved')).status, 'resolved');
  await assert.rejects(b.reply(c.id, { author: 'robot', text: 'x' }), /author must be/);
  await assert.rejects(b.setStatus(c.id, 'closed'), /status must be/);
});

test('a pin outside the artboard is rejected', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A', width: 400, height: 400 });
  await assert.rejects(b.addComment({ artboardId: a.id, x: 401, y: 10, text: 'x' }), /outside the artboard/);
});

test('every limit is enforced with a message that names it', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'A' });
  await assert.rejects(b.createArtboard({ name: 'x', width: 99 }), /from 100 to 4000 pixels/);
  await assert.rejects(b.createArtboard({ name: 'x', height: 4001 }), /from 100 to 4000 pixels/);
  await assert.rejects(b.createArtboard({ name: '' }), /name must be a non-empty string/);
  await assert.rejects(b.setHtml(a.id, 'x'.repeat(LIMITS.htmlBytes + 1)), /limit is 2097152 bytes/);
  await assert.rejects(b.addComment({ artboardId: a.id, x: 1, y: 1, text: 'x'.repeat(4001) }), /limit is 4000/);
});

test('the artboard limit is 100', async () => {
  const b = await fresh();
  for (let i = 0; i < LIMITS.artboards; i++) await b.createArtboard({ name: `A${i}`, width: 100, height: 100 });
  await assert.rejects(b.createArtboard({ name: 'one too many' }), /100 artboards, which is the limit/);
  assert.equal(new Set(b.get().artboards.map((a) => a.id)).size, 100, 'ids are unique');
});

test('unknown and malformed ids give a 404 and cannot reach other files', async () => {
  const b = await fresh();
  for (const id of ['ab_zzzz', '../../etc/passwd', 'ab_../x', undefined]) {
    const err = await b.getHtml(id).catch((e) => e);
    assert.ok(err instanceof BoardError);
    assert.equal(err.status, 404);
  }
});

test('toDocument wraps a fragment and leaves a full document alone', () => {
  const wrapped = toDocument('<p>Hi</p>');
  assert.match(wrapped, /^<!doctype html><html lang="en">/);
  assert.match(wrapped, /<body><p>Hi<\/p><script>/);
  const full = toDocument('<html><body><p>Full</p></body></html>');
  assert.equal(full.match(/<html/g).length, 1);
  assert.match(full, /<p>Full<\/p><script>[\s\S]+<\/script><\/body>/);
});

test('onChange fires for each change', async () => {
  const b = await fresh();
  let count = 0;
  b.onChange(() => count++);
  const a = await b.createArtboard({ name: 'A' });
  await b.setHtml(a.id, 'x');
  assert.equal(count, 2);
});

test('a board file with the wrong shape is refused, not overwritten', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-'));
  await mkdir(path.join(root, '.blueprint'), { recursive: true });
  await writeFile(path.join(root, '.blueprint', 'board.json'), '{"version":2}');
  await assert.rejects(openBoard(root), /not a version 1 board/);
  assert.equal(await readFile(path.join(root, '.blueprint', 'board.json'), 'utf8'), '{"version":2}');
});
