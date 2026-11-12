// The board store. Every change to a board goes through a function in this file,
// and server.mjs is the only program that calls them. One writer means the agent
// and the browser cannot overwrite each other's changes.

import { mkdir, readFile, writeFile, rename, stat, access } from 'node:fs/promises';
import path from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { sniffImage } from './assets.mjs';

export const LIMITS = {
  artboards: 100,
  htmlBytes: 2 * 1024 * 1024,
  commentChars: 4000,
  nameChars: 120,
  minSize: 100,
  maxSize: 4000,
  items: 500, // notes, images and links together
  connectors: 500,
  noteChars: 10000,
  labelChars: 200,
  urlChars: 2000,
  assetBytes: 10 * 1024 * 1024,
  minItemWidth: 80,
  maxItemWidth: 2000,
};

export const ITEM_TYPES = ['note', 'code', 'image', 'link'];

// An error the server can turn into an HTTP status and a plain sentence.
export class BoardError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const newId = (prefix) =>
  prefix + Array.from({ length: 4 }, () => ID_CHARS[randomInt(ID_CHARS.length)]).join('');

// ---- validation helpers: each returns a clean value or throws a BoardError ----

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim()) throw new BoardError(`${label} must be a non-empty string.`);
  if (value.length > max) throw new BoardError(`${label} is ${value.length} characters. The limit is ${max}.`);
  return value.trim();
}

function size(value, label) {
  if (!Number.isFinite(value)) throw new BoardError(`${label} must be a number.`);
  const n = Math.round(value);
  if (n < LIMITS.minSize || n > LIMITS.maxSize)
    throw new BoardError(`${label} is ${n}. It must be from ${LIMITS.minSize} to ${LIMITS.maxSize} pixels.`);
  return n;
}

function coord(value, label) {
  if (!Number.isFinite(value)) throw new BoardError(`${label} must be a number.`);
  return Math.round(value);
}

function html(value) {
  if (typeof value !== 'string') throw new BoardError('html must be a string.');
  const bytes = Buffer.byteLength(value);
  if (bytes > LIMITS.htmlBytes)
    throw new BoardError(`html is ${bytes} bytes. The limit is ${LIMITS.htmlBytes} bytes (2 MB).`);
  return value;
}

// IDs become file names, so only accept the exact shape newId() makes.
function safeId(id, prefix) {
  if (typeof id !== 'string' || !new RegExp(`^${prefix}[a-z0-9]{4}$`).test(id))
    throw new BoardError(`Unknown id "${String(id).slice(0, 40)}".`, 404);
  return id;
}

function itemWidth(value) {
  if (!Number.isFinite(value)) throw new BoardError('width must be a number.');
  const n = Math.round(value);
  if (n < LIMITS.minItemWidth || n > LIMITS.maxItemWidth)
    throw new BoardError(`width is ${n}. It must be from ${LIMITS.minItemWidth} to ${LIMITS.maxItemWidth} pixels.`);
  return n;
}

// Notes may be empty while being written, so this allows "".
function noteText(value) {
  if (typeof value !== 'string') throw new BoardError('text must be a string.');
  if (value.length > LIMITS.noteChars) throw new BoardError(`text is ${value.length} characters. The limit is ${LIMITS.noteChars}.`);
  return value;
}

function optionalText(value, label, max) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new BoardError(`${label} must be a string.`);
  return value.trim().slice(0, max);
}

// Links open in a new tab from the canvas, so only web addresses are allowed.
// A "javascript:" address would run code on the canvas page.
export function webUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new BoardError('url must be a non-empty string.');
  if (value.length > LIMITS.urlChars) throw new BoardError(`url is ${value.length} characters. The limit is ${LIMITS.urlChars}.`);
  let u;
  try {
    u = new URL(value.trim());
  } catch {
    throw new BoardError('url is not a valid web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BoardError('url must start with http:// or https://.');
  return u.href;
}

const author = (value) => (value === 'agent' ? 'agent' : 'user');

// Asset names are made by addAsset(): 16 hex characters and an image extension.
export function safeAssetName(name) {
  if (typeof name !== 'string' || !/^[a-f0-9]{16}\.(png|jpg|gif|webp)$/.test(name))
    throw new BoardError(`Unknown asset "${String(name).slice(0, 40)}".`, 404);
  return name;
}

// This script is added to every artboard document as it is served (never to the
// stored file). The canvas page asks it "what element is at x, y?" so a comment
// can record the thing it points at.
const HELPER = `<script>(function(){
  function selectorFor(el){
    var parts=[];
    while(el&&el.nodeType===1&&el!==document.body&&el!==document.documentElement){
      if(el.id){parts.unshift('#'+CSS.escape(el.id));break;}
      var tag=el.tagName.toLowerCase(),n=1,s=el;
      while((s=s.previousElementSibling))if(s.tagName===el.tagName)n++;
      parts.unshift(tag+':nth-of-type('+n+')');
      el=el.parentElement;
    }
    return parts.join(' > ');
  }
  addEventListener('message',function(e){
    var d=e.data;
    if(!d||d.type!=='blueprint:elementAt')return;
    var el=document.elementFromPoint(d.x,d.y),target=null;
    if(el&&el!==document.body&&el!==document.documentElement){
      var label=(el.getAttribute('aria-label')||el.getAttribute('alt')||el.getAttribute('placeholder')||el.innerText||'').trim().replace(/\\s+/g,' ').slice(0,80);
      target={selector:selectorFor(el),tag:el.tagName.toLowerCase(),text:label};
    }
    e.source.postMessage({type:'blueprint:element',requestId:d.requestId,target:target},'*');
  });
})();</script>`;

// Stored HTML may be a whole document or a fragment. Fragments get a minimal
// document wrapped round them so they render the same way every time.
export function toDocument(stored) {
  const isDocument = /<html[\s>]/i.test(stored);
  const doc = isDocument
    ? stored
    : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}</style></head><body>${stored}</body></html>`;
  const close = doc.toLowerCase().lastIndexOf('</body>');
  return close === -1 ? doc + HELPER : doc.slice(0, close) + HELPER + doc.slice(close);
}

// Open (or create) the board that lives in <root>/.blueprint/.
export async function openBoard(root) {
  const dir = path.join(root, '.blueprint');
  const file = path.join(dir, 'board.json');
  const artDir = path.join(dir, 'artboards');
  const trashDir = path.join(dir, 'trash');
  const assetDir = path.join(dir, 'assets');
  await mkdir(artDir, { recursive: true });
  await mkdir(trashDir, { recursive: true });

  let board;
  try {
    board = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Could not read ${file}: ${err.message}`);
    board = { version: 1, artboards: [], comments: [] };
  }
  if (board.version !== 1 || !Array.isArray(board.artboards) || !Array.isArray(board.comments))
    throw new Error(`${file} is not a version 1 board.`);
  // Notes, references and arrows were added later. A board saved before them
  // has no such lists, so start them empty. Nothing else about the file changes.
  if (!Array.isArray(board.items)) board.items = [];
  if (!Array.isArray(board.connectors)) board.connectors = [];

  const listeners = new Set();
  const htmlPath = (id) => path.join(artDir, `${id}.html`);
  const now = () => new Date().toISOString();
  // A missing HTML file (deleted by hand, or lost) reads as an empty artboard
  // instead of breaking every request that touches it.
  const readHtml = (id) =>
    readFile(htmlPath(id), 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return '';
      throw err;
    });

  // Write to a temporary file, then rename it over the real one. A rename is
  // all-or-nothing, so a crash mid-save cannot leave half a board on disk.
  // Saves run one after another through this promise chain.
  let saving = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(board, null, 2) + '\n';
    // .catch first: one failed save must not stop every later save from running.
    saving = saving.catch(() => {}).then(async () => {
      await writeFile(file + '.tmp', snapshot);
      await rename(file + '.tmp', file);
    });
    for (const fn of listeners) fn(board);
    return saving;
  }

  function findArtboard(id) {
    const a = board.artboards.find((x) => x.id === safeId(id, 'ab_'));
    if (!a) throw new BoardError(`No artboard with id "${id}".`, 404);
    return a;
  }
  function findComment(id) {
    const c = board.comments.find((x) => x.id === safeId(id, 'c_'));
    if (!c) throw new BoardError(`No comment with id "${id}".`, 404);
    return c;
  }
  function findItem(id) {
    const it = board.items.find((x) => x.id === safeId(id, 'it_'));
    if (!it) throw new BoardError(`No note or reference with id "${id}".`, 404);
    return it;
  }
  function findConnector(id) {
    const ln = board.connectors.find((x) => x.id === safeId(id, 'ln_'));
    if (!ln) throw new BoardError(`No arrow with id "${id}".`, 404);
    return ln;
  }
  // An arrow can join any two things on the board: artboards, notes and references.
  function findObject(id) {
    if (typeof id === 'string' && id.startsWith('ab_')) return findArtboard(id);
    if (typeof id === 'string' && id.startsWith('it_')) return findItem(id);
    throw new BoardError(`"${String(id).slice(0, 40)}" is not an artboard, note or reference id.`, 404);
  }
  function uniqueId(prefix, list) {
    for (;;) {
      const id = newId(prefix);
      if (!list.some((x) => x.id === id)) return id;
    }
  }
  // A restored item keeps its old id, so undo brings back the same arrows.
  function claimId(prefix, list, wanted) {
    if (wanted === undefined) return uniqueId(prefix, list);
    safeId(wanted, prefix);
    if (list.some((x) => x.id === wanted)) throw new BoardError(`The id "${wanted}" is already in use.`);
    return wanted;
  }

  // Where to put something when the caller gives no position. With `near`, it
  // goes in the first free spot to the right of that object, then below it,
  // moving down past anything in the way. Without `near`, it goes below everything.
  function placeFor(near, width) {
    const height = (o) => o.height || 160; // notes have no stored height; 160 is a typical one
    const all = [...board.artboards, ...board.items];
    const NEW_HEIGHT = 140;
    // 40px clear on every side leaves room for captions and the agent label above a note.
    const GAP = 40;
    const hits = (x, y) => all.find((o) => o.x < x + width + GAP && o.x + o.width + GAP > x && o.y < y + NEW_HEIGHT + GAP && o.y + height(o) + GAP > y);
    if (near) {
      const target = findObject(near);
      const starts = [
        { x: target.x + target.width + 40, y: target.y }, // right of it
        { x: target.x, y: target.y + height(target) + 40 }, // below it
      ];
      for (const start of starts) {
        let { x, y } = start;
        for (let tries = 0; tries < 40; tries++) {
          const hit = hits(x, y);
          if (!hit) return { x, y };
          // Slide down past a note, but stop at an artboard: try the next side.
          if (board.artboards.includes(hit) && hit !== target) break;
          y = hit.y + height(hit) + GAP;
          if (y > start.y + 2000) break;
        }
      }
    }
    if (!all.length) return { x: 0, y: 0 };
    return { x: Math.min(...all.map((o) => o.x)), y: Math.max(...all.map((o) => o.y + height(o))) + 80 };
  }

  // Undo needs the item and the arrows that went with it, exactly as they were.
  function removeItem(it) {
    const connectors = board.connectors.filter((c) => c.from === it.id || c.to === it.id);
    board.items = board.items.filter((x) => x !== it);
    board.connectors = board.connectors.filter((c) => !connectors.includes(c));
    return { item: it, connectors };
  }

  return {
    root,
    dir,
    get: () => board,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    flush: () => saving,

    async createArtboard({ name, width = 1440, height = 900, html: body = '' } = {}) {
      if (board.artboards.length >= LIMITS.artboards)
        throw new BoardError(`This board has ${LIMITS.artboards} artboards, which is the limit.`);
      const artboard = {
        id: uniqueId('ab_', board.artboards),
        name: text(name, 'name', LIMITS.nameChars),
        // New artboards go 80px to the right of the rightmost one.
        x: board.artboards.length ? Math.max(...board.artboards.map((a) => a.x + a.width)) + 80 : 0,
        y: 0,
        width: size(width, 'width'),
        height: size(height, 'height'),
        rev: 1, // goes up each time the HTML changes, so the page knows when to reload it
        updatedAt: now(),
      };
      await writeFile(htmlPath(artboard.id), html(body));
      board.artboards.push(artboard);
      await save();
      return artboard;
    },

    async updateArtboard(id, patch = {}) {
      const a = findArtboard(id);
      const next = {};
      if ('name' in patch) next.name = text(patch.name, 'name', LIMITS.nameChars);
      if ('x' in patch) next.x = coord(patch.x, 'x');
      if ('y' in patch) next.y = coord(patch.y, 'y');
      if ('width' in patch) next.width = size(patch.width, 'width');
      if ('height' in patch) next.height = size(patch.height, 'height');
      if (!Object.keys(next).length) throw new BoardError('Nothing to update. Send name, x, y, width or height.');
      Object.assign(a, next, { updatedAt: now() });
      await save();
      return a;
    },

    async getHtml(id) {
      findArtboard(id);
      return readHtml(id);
    },

    async setHtml(id, body) {
      const a = findArtboard(id);
      await writeFile(htmlPath(id), html(body));
      a.rev = (a.rev || 1) + 1;
      a.updatedAt = now();
      await save();
      return a;
    },

    // Deleting keeps the HTML: the file moves to trash/ with a timestamp.
    async deleteArtboard(id) {
      const a = findArtboard(id);
      const stamp = now().replace(/[:.]/g, '-');
      // If the file is already gone there is nothing to keep, but the artboard
      // must still come off the board. Before this, it could never be deleted.
      await rename(htmlPath(id), path.join(trashDir, `${id}-${stamp}.html`)).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      board.artboards = board.artboards.filter((x) => x !== a);
      board.comments = board.comments.filter((c) => c.artboardId !== id);
      board.connectors = board.connectors.filter((c) => c.from !== id && c.to !== id);
      await save();
    },

    async addComment({ artboardId, x, y, text: body, target = null } = {}) {
      const a = findArtboard(artboardId);
      const px = coord(x, 'x');
      const py = coord(y, 'y');
      if (px < 0 || py < 0 || px > a.width || py > a.height)
        throw new BoardError(`The pin (${px}, ${py}) is outside the artboard, which is ${a.width} by ${a.height}.`);
      const comment = {
        id: uniqueId('c_', board.comments),
        artboardId,
        x: px,
        y: py,
        target:
          target && typeof target.selector === 'string'
            ? { selector: target.selector.slice(0, 500), tag: String(target.tag || '').slice(0, 40), text: String(target.text || '').slice(0, 80) }
            : null,
        status: 'open',
        thread: [{ author: 'user', text: text(body, 'text', LIMITS.commentChars), at: now() }],
      };
      board.comments.push(comment);
      await save();
      return comment;
    },

    async reply(id, { author, text: body } = {}) {
      const c = findComment(id);
      if (author !== 'user' && author !== 'agent') throw new BoardError('author must be "user" or "agent".');
      c.thread.push({ author, text: text(body, 'text', LIMITS.commentChars), at: now() });
      await save();
      return c;
    },

    async setStatus(id, status) {
      const c = findComment(id);
      if (status !== 'open' && status !== 'resolved') throw new BoardError('status must be "open" or "resolved".');
      c.status = status;
      await save();
      return c;
    },

    // ---- Notes and references ----
    // An item is a note (text), an image (a file in assets/) or a link (a web
    // address). They sit on the canvas beside the artboards. The agent reads
    // them as references and can add its own.

    async createItem({ id, type, x, y, near, width, text: body, asset, url, title, description, author: by } = {}) {
      if (board.items.length >= LIMITS.items) throw new BoardError(`This board has ${LIMITS.items} notes and references, which is the limit.`);
      if (!ITEM_TYPES.includes(type)) throw new BoardError(`type must be one of: ${ITEM_TYPES.join(', ')}.`);
      const item = { id: claimId('it_', board.items, id), type };
      if (type === 'note') {
        item.width = itemWidth(width ?? 240);
        item.text = noteText(body ?? '');
      } else if (type === 'code') {
        // A code card is a note shown in a fixed-width font, with spacing kept.
        item.width = itemWidth(width ?? 440);
        item.text = noteText(body ?? '');
      } else if (type === 'image') {
        const name = safeAssetName(asset);
        await access(path.join(assetDir, name)).catch(() => {
          throw new BoardError(`No asset named "${name}". Upload the image first.`);
        });
        const size = sniffImage(await readFile(path.join(assetDir, name)));
        // Default: the image's own width, kept between the smallest item width and 360.
        item.width = itemWidth(width ?? Math.max(LIMITS.minItemWidth, Math.min(size?.width || 320, 360)));
        item.asset = name;
        // Keep the shape of the original image so its height follows its width.
        // Kept between 1:100 and 100:1, so a very wide or tall image never has zero height.
        const ratio = size && size.width ? size.height / size.width : 1;
        item.aspect = Math.round(Math.min(100, Math.max(0.01, ratio)) * 10000) / 10000;
        item.height = Math.round(item.width * item.aspect);
        item.title = optionalText(title, 'title', LIMITS.nameChars);
      } else {
        item.width = itemWidth(width ?? 280);
        item.url = webUrl(url);
        item.title = optionalText(title, 'title', LIMITS.nameChars) || new URL(item.url).hostname.replace(/^www\./, '');
        item.description = optionalText(description, 'description', 400);
      }
      const spot = x !== undefined && y !== undefined ? { x: coord(x, 'x'), y: coord(y, 'y') } : placeFor(near, item.width);
      Object.assign(item, spot, { author: author(by), createdAt: now(), updatedAt: now() });
      board.items.push(item);
      await save();
      return item;
    },

    async updateItem(id, patch = {}) {
      const it = findItem(id);
      const next = {};
      if ('x' in patch) next.x = coord(patch.x, 'x');
      if ('y' in patch) next.y = coord(patch.y, 'y');
      if ('width' in patch) next.width = itemWidth(patch.width);
      if ('text' in patch) {
        if (it.type !== 'note' && it.type !== 'code') throw new BoardError('Only a note or a code card has text. Use title or description for a link.');
        next.text = noteText(patch.text);
      }
      if ('title' in patch) next.title = optionalText(patch.title, 'title', LIMITS.nameChars);
      if ('description' in patch) {
        if (it.type !== 'link') throw new BoardError('Only a link has a description.');
        next.description = optionalText(patch.description, 'description', 400);
      }
      if (!Object.keys(next).length) throw new BoardError('Nothing to update. Send x, y, width, text, title or description.');
      Object.assign(it, next, { updatedAt: now() });
      if (it.type === 'image') it.height = Math.round(it.width * it.aspect);
      await save();
      return it;
    },

    // Returns what was removed, so the page can offer to undo it.
    async deleteItem(id) {
      const removed = removeItem(findItem(id));
      await save();
      return removed;
    },

    // Store an uploaded image under a name made from its content, so the same
    // image pasted twice is stored once. Returns { asset, width, height }.
    async addAsset(buf) {
      if (!Buffer.isBuffer(buf) || !buf.length) throw new BoardError('The image is empty.');
      if (buf.length > LIMITS.assetBytes) throw new BoardError(`The image is ${buf.length} bytes. The limit is ${LIMITS.assetBytes} bytes (10 MB).`);
      const kind = sniffImage(buf);
      if (!kind) throw new BoardError('That file is not a PNG, JPEG, GIF or WebP image.');
      // A header can claim any size. Refuse sizes no real reference has.
      if (!(kind.width >= 1 && kind.height >= 1 && kind.width <= 30000 && kind.height <= 30000))
        throw new BoardError(`The image says it is ${kind.width} by ${kind.height} pixels. Each side must be from 1 to 30000.`);
      const name = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${kind.ext}`;
      await mkdir(assetDir, { recursive: true });
      const target = path.join(assetDir, name);
      const exists = await access(target).then(() => true, () => false);
      if (!exists) {
        // A temporary name per upload, so two uploads of the same image at once cannot collide.
        const tmp = `${target}.${process.pid}.${randomInt(1e9)}.tmp`;
        await writeFile(tmp, buf);
        await rename(tmp, target);
      }
      return { asset: name, width: kind.width, height: kind.height };
    },

    assetPath: (name) => path.join(assetDir, safeAssetName(name)),

    // ---- Arrows ----
    // An arrow points from one thing to another. Both ends must exist. Deleting
    // either end deletes the arrow.

    async createConnector({ id, from, to, label, author: by } = {}) {
      if (board.connectors.length >= LIMITS.connectors) throw new BoardError(`This board has ${LIMITS.connectors} arrows, which is the limit.`);
      findObject(from);
      findObject(to);
      if (from === to) throw new BoardError('An arrow needs two different ends.');
      const connector = {
        id: claimId('ln_', board.connectors, id),
        from,
        to,
        label: optionalText(label, 'label', LIMITS.labelChars),
        author: author(by),
        createdAt: now(),
      };
      board.connectors.push(connector);
      await save();
      return connector;
    },

    async updateConnector(id, patch = {}) {
      const ln = findConnector(id);
      if (!('label' in patch)) throw new BoardError('Nothing to update. Send label.');
      ln.label = optionalText(patch.label, 'label', LIMITS.labelChars);
      await save();
      return ln;
    },

    async deleteConnector(id) {
      const ln = findConnector(id);
      board.connectors = board.connectors.filter((x) => x !== ln);
      await save();
      return ln;
    },

    // The full document the browser loads for one artboard.
    async documentFor(id) {
      findArtboard(id);
      return toDocument(await readHtml(id));
    },

    async exists() {
      return stat(file).then(() => true, () => false);
    },
  };
}
