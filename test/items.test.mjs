// Notes, references (images and links) and arrows in the board store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openBoard, BoardError, LIMITS } from '../lib/board.mjs';
import { sniffImage } from '../lib/assets.mjs';
import { PNG_3x2 } from './fixtures.mjs';

const fresh = async () => openBoard(await mkdtemp(path.join(tmpdir(), 'blueprint-items-')));


test('sniffImage reads PNG, GIF, JPEG and WebP sizes and refuses anything else', () => {
  assert.deepEqual(sniffImage(PNG_3x2), { ext: 'png', width: 3, height: 2 });
  const gif = Buffer.alloc(32);
  gif.write('GIF89a', 0, 'latin1');
  gif.writeUInt16LE(40, 6);
  gif.writeUInt16LE(30, 8);
  assert.deepEqual(sniffImage(gif), { ext: 'gif', width: 40, height: 30 });
  // JPEG: SOI, an APP0 segment of length 16, then SOF0 with height 50 and width 70.
  const jpg = Buffer.alloc(40);
  jpg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  jpg.set([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x32, 0x00, 0x46], 20);
  assert.deepEqual(sniffImage(jpg), { ext: 'jpg', width: 70, height: 50 });
  const webp = Buffer.alloc(32);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(99, 24, 3);
  webp.writeUIntLE(49, 27, 3);
  assert.deepEqual(sniffImage(webp), { ext: 'webp', width: 100, height: 50 });
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffImage(Buffer.from('hello')), null);
});

test('an old board without items or arrows opens with empty lists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-old-'));
  await mkdir(path.join(root, '.blueprint'), { recursive: true });
  await writeFile(path.join(root, '.blueprint', 'board.json'), JSON.stringify({ version: 1, artboards: [], comments: [] }));
  const b = await openBoard(root);
  assert.deepEqual(b.get().items, []);
  assert.deepEqual(b.get().connectors, []);
});

test('a note is made, placed, edited and saved', async () => {
  const b = await fresh();
  const n = await b.createItem({ type: 'note', x: 10.4, y: -20, text: 'Calmer hero, less copy' });
  assert.match(n.id, /^it_[a-z0-9]{4}$/);
  assert.deepEqual([n.x, n.y, n.width, n.author], [10, -20, 240, 'user']);
  await b.updateItem(n.id, { text: 'Calmer hero', width: 300 });
  await b.flush();
  const saved = JSON.parse(await readFile(path.join(b.dir, 'board.json'), 'utf8'));
  assert.equal(saved.items[0].text, 'Calmer hero');
  assert.equal(saved.items[0].width, 300);
});

test('an agent note without a position goes beside the object it is near, and stacks', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'Home', width: 1440, height: 900 });
  const first = await b.createItem({ type: 'note', near: a.id, text: 'one', author: 'agent' });
  assert.deepEqual([first.x, first.y, first.author], [1480, 0, 'agent']);
  const second = await b.createItem({ type: 'note', near: a.id, text: 'two' });
  assert.equal(second.x, 1480);
  assert.ok(second.y > first.y, 'the second note sits below the first');
  const loose = await b.createItem({ type: 'note', text: 'below everything' });
  assert.ok(loose.y >= 900 + 80);
});

test('an image asset is stored once by content and an image item keeps its shape', async () => {
  const b = await fresh();
  const one = await b.addAsset(PNG_3x2);
  const two = await b.addAsset(PNG_3x2);
  assert.equal(one.asset, two.asset);
  assert.match(one.asset, /^[a-f0-9]{16}\.png$/);
  assert.deepEqual(await readFile(b.assetPath(one.asset)), PNG_3x2);
  const img = await b.createItem({ type: 'image', asset: one.asset, x: 0, y: 0, width: 300 });
  assert.equal(img.height, 200);
  await b.updateItem(img.id, { width: 150 });
  assert.equal(b.get().items[0].height, 100);
});

test('assets refuse files that are not images, and oversized ones', async () => {
  const b = await fresh();
  await assert.rejects(b.addAsset(Buffer.from('<svg><script>alert(1)</script></svg>')), /not a PNG, JPEG, GIF or WebP/);
  await assert.rejects(b.addAsset(Buffer.alloc(LIMITS.assetBytes + 1)), /limit is/);
  await assert.rejects(b.createItem({ type: 'image', asset: '../board.json', x: 0, y: 0 }), BoardError);
  await assert.rejects(b.createItem({ type: 'image', asset: '0123456789abcdef.png', x: 0, y: 0 }), /Upload the image first/);
  assert.throws(() => b.assetPath('../../etc/passwd'), BoardError);
});

test('a link keeps only web addresses and titles itself from the host', async () => {
  const b = await fresh();
  const l = await b.createItem({ type: 'link', url: 'https://www.example.com/work?a=1', x: 0, y: 0 });
  assert.equal(l.title, 'example.com');
  assert.equal(l.url, 'https://www.example.com/work?a=1');
  await assert.rejects(b.createItem({ type: 'link', url: 'javascript:alert(1)', x: 0, y: 0 }), /http:\/\/ or https:\/\//);
  await assert.rejects(b.createItem({ type: 'link', url: 'not a url', x: 0, y: 0 }), /not a valid web address/);
  await assert.rejects(b.updateItem(l.id, { text: 'x' }), /Only a note or a code card has text/);
});

test('arrows join two existing things, take a label, and go when an end goes', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'Home' });
  const n = await b.createItem({ type: 'note', x: 0, y: 1000, text: 'Reference this' });
  const ln = await b.createConnector({ from: n.id, to: a.id, label: 'use this type' });
  assert.match(ln.id, /^ln_[a-z0-9]{4}$/);
  await b.updateConnector(ln.id, { label: 'type scale' });
  assert.equal(b.get().connectors[0].label, 'type scale');
  await assert.rejects(b.createConnector({ from: n.id, to: n.id }), /two different ends/);
  await assert.rejects(b.createConnector({ from: n.id, to: 'it_zzzz' }), /No note or reference/);
  await assert.rejects(b.createConnector({ from: n.id, to: 'c_abcd' }), /not an artboard, note or reference/);

  const removed = await b.deleteItem(n.id);
  assert.equal(removed.connectors.length, 1);
  assert.equal(b.get().connectors.length, 0);

  // Undo: the same item and arrow come back with their old ids.
  await b.createItem({ ...removed.item });
  await b.createConnector({ ...removed.connectors[0] });
  assert.equal(b.get().connectors[0].id, ln.id);
  await assert.rejects(b.createItem({ ...removed.item }), /already in use/);

  await b.deleteArtboard(a.id);
  assert.equal(b.get().connectors.length, 0, 'deleting an artboard removes its arrows');
});

test('an artboard whose HTML file has gone can still be read and deleted', async () => {
  const b = await fresh();
  const a = await b.createArtboard({ name: 'Lost', html: '<p>hi</p>' });
  await rm(path.join(b.dir, 'artboards', `${a.id}.html`));
  assert.equal(await b.getHtml(a.id), '');
  assert.match(await b.documentFor(a.id), /<body>/);
  await b.deleteArtboard(a.id);
  assert.equal(b.get().artboards.length, 0);
});

test('item limits name the limit', async () => {
  const b = await fresh();
  await assert.rejects(b.createItem({ type: 'shape', x: 0, y: 0 }), /type must be one of/);
  await assert.rejects(b.createItem({ type: 'note', x: 0, y: 0, width: 10 }), /from 80 to 2000/);
  await assert.rejects(b.createItem({ type: 'note', x: 0, y: 0, text: 'x'.repeat(LIMITS.noteChars + 1) }), /limit is 10000/);
});

test('a note placed near an artboard never lands on the next artboard', async () => {
  const b = await fresh();
  const desktop = await b.createArtboard({ name: 'Desktop', width: 1440, height: 900 });
  await b.createArtboard({ name: 'Phone', width: 390, height: 844 }); // 80px to the right: no room for a note
  const n = await b.createItem({ type: 'note', near: desktop.id, text: 'why' });
  const boxes = b.get().artboards;
  const overlaps = boxes.some((a) => n.x < a.x + a.width && n.x + n.width > a.x && n.y < a.y + a.height && n.y + 140 > a.y);
  assert.equal(overlaps, false, `note at (${n.x}, ${n.y}) overlaps an artboard`);
  assert.equal(n.x, desktop.x, 'it goes below the artboard instead');
});

test('a code card keeps its text exactly, spacing included', async () => {
  const b = await fresh();
  const code = '.hero {\n  padding: 64px;\n}\n';
  const c = await b.createItem({ type: 'code', x: 0, y: 0, text: code });
  assert.equal(c.width, 440);
  assert.equal(c.text, code);
  await b.updateItem(c.id, { text: 'const a = 1;' });
  assert.equal(b.get().items[0].text, 'const a = 1;');
});

test('a very wide image keeps a visible height', async () => {
  const b = await fresh();
  const wide = Buffer.from(PNG_3x2);
  wide.writeUInt32BE(20000, 16); // 20000 by 2
  const { asset } = await b.addAsset(wide);
  const img = await b.createItem({ type: 'image', asset, x: 0, y: 0, width: 400 });
  assert.ok(img.height >= 4, `height ${img.height}`);
});
