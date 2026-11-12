// The board store. Every change to a board goes through a function in this file,
// and server.mjs is the only program that calls them. One writer means the agent
// and the browser cannot overwrite each other's changes.

import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomInt } from 'node:crypto';

export const LIMITS = {
  artboards: 100,
  htmlBytes: 2 * 1024 * 1024,
  commentChars: 4000,
  nameChars: 120,
  minSize: 100,
  maxSize: 4000,
};

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

  const listeners = new Set();
  const htmlPath = (id) => path.join(artDir, `${id}.html`);
  const now = () => new Date().toISOString();

  // Write to a temporary file, then rename it over the real one. A rename is
  // all-or-nothing, so a crash mid-save cannot leave half a board on disk.
  // Saves run one after another through this promise chain.
  let saving = Promise.resolve();
  function save() {
    const snapshot = JSON.stringify(board, null, 2) + '\n';
    saving = saving.then(async () => {
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
  function uniqueId(prefix, list) {
    for (;;) {
      const id = newId(prefix);
      if (!list.some((x) => x.id === id)) return id;
    }
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
      return readFile(htmlPath(id), 'utf8');
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
      await rename(htmlPath(id), path.join(trashDir, `${id}-${stamp}.html`));
      board.artboards = board.artboards.filter((x) => x !== a);
      board.comments = board.comments.filter((c) => c.artboardId !== id);
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

    // The full document the browser loads for one artboard.
    async documentFor(id) {
      findArtboard(id);
      return toDocument(await readFile(htmlPath(id), 'utf8'));
    },

    async exists() {
      return stat(file).then(() => true, () => false);
    },
  };
}
