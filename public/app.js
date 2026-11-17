// The canvas page. It keeps one copy of the board, redraws when the server
// sends a new one, and turns pointer and key input into pans, moves, notes,
// arrows and comments.

import { createCanvas } from './canvas.js';
import { createComments } from './comments.js';
import { createItems, KIND } from './items.js';
import { createConnectors } from './connectors.js';
import { createRecents, ON_BOARD } from './recents.js';
import { createChat } from './chat.js';
import { createAccounts } from './accounts.js';
import { URL_ONLY, FENCE, isHtml, looksLikeCode, htmlName } from './paste.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');

let board = { version: 1, artboards: [], comments: [], items: [], connectors: [] };
let tool = 'move';
let firstBoard = true;
let agents = []; // what each agent is doing right now, sent by the server
let selection = null; // { kind: 'item' | 'connector' | 'artboard', id } — what Delete and Enter act on
let lastDeleted = null; // what the last delete removed, so Cmd+Z can bring it back
const nodes = new Map(); // artboard id -> { el, sheet, iframe, name, rev }

// ---- talking to the server ----

let toastTimer;
function toast(message, action) {
  const t = $('toast');
  $('toast-text').textContent = message;
  const button = $('toast-action');
  button.hidden = !action;
  if (action) {
    button.textContent = action.label;
    button.onclick = () => {
      t.hidden = true;
      action.run();
    };
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 6000 : 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok) {
    const message = data.error || 'Blueprint is not running. Start it again and reload.';
    toast(message);
    throw new Error(message);
  }
  return data;
}

// ---- canvas, comments, notes, arrows ----

let drawnZoom = 0;
const canvas = createCanvas(viewport, world, {
  onChange(cam) {
    $('zoom').textContent = Math.round(cam.z * 100) + '%';
    comments?.place();
    // Arrowheads keep one size on screen, so arrows redraw when the zoom
    // changes. A pan moves the whole board at once and needs no redraw.
    if (cam.z !== drawnZoom) {
      drawnZoom = cam.z;
      connectors?.render();
    }
  },
});
const comments = createComments({ api, getBoard: () => board, nodes, toast, onDelete: (id) => (lastDeleted = { restore: id }) });
const items = createItems({ world, api, getBoard: () => board });

// The box of anything an arrow can join, in board pixels, read from the page.
function rectOf(id) {
  const node = id.startsWith('ab_') ? nodes.get(id)?.el : items.nodes.get(id)?.el;
  if (!node) return null;
  return { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight };
}
const connectors = createConnectors({ world, getBoard: () => board, rectOf, getZoom: () => canvas.cam.z });
const recents = createRecents({ api, toast });

function bounds() {
  const boxes = [...board.artboards.map((a) => rectOf(a.id) || a), ...board.items.map((i) => rectOf(i.id) || i)];
  if (!boxes.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...boxes.map((a) => a.x));
  const y = Math.min(...boxes.map((a) => a.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((a) => a.x + a.width)) - x,
    height: Math.max(...boxes.map((a) => a.y + (a.height || 120))) - y,
  };
}
// Leave room for the floating panel on wide windows, so Fit never hides an artboard under it.
function inset() {
  const panel = $('panel');
  const wide = innerWidth > 720 && !panel.hidden;
  // An open chat covers the left of the screen on a wide window, so framing
  // keeps clear of it. On a phone the open chat is a sheet over everything.
  const chatPanel = $('chat');
  const chatRight = innerWidth > 720 && !chatPanel.classList.contains('closed') ? chatPanel.getBoundingClientRect().right : 0;
  return { top: 80, left: chatRight + 40, bottom: wide ? 96 : 96 + panel.offsetHeight, right: wide ? panel.offsetWidth + 40 : 40 };
}
const fit = (animate = true) => canvas.frameRect(bounds(), { animate, inset: inset() });
// The middle of the visible board, in board pixels: where pasted things land.
function viewCentre() {
  const i = inset();
  return canvas.toBoard(i.left + (innerWidth - i.left - i.right) / 2, i.top + (innerHeight - i.top - i.bottom) / 2);
}

// ---- drawing the board ----

function makeNode(a) {
  const el = document.createElement('div');
  el.className = 'board';
  el.dataset.id = a.id;
  const name = document.createElement('div');
  name.className = 'name';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  const iframe = document.createElement('iframe');
  // allow-scripts without allow-same-origin: a mockup's scripts run, but in a
  // sealed box with no access to this page or to the board's API.
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('loading', 'lazy');
  iframe.tabIndex = -1;
  const cover = document.createElement('div');
  cover.className = 'cover';
  sheet.append(iframe, cover);
  const ring = document.createElement('div');
  ring.className = 'ring';
  const tag = document.createElement('div');
  tag.className = 'tag';
  el.append(name, sheet, ring, tag);
  world.append(el);
  if (!firstBoard) {
    // Made while you were watching: let it arrive, then drop the class.
    el.classList.add('arriving');
    el.addEventListener('animationend', () => el.classList.remove('arriving'), { once: true });
  }
  const node = { el, sheet, iframe, name, tag, rev: 0 };
  nodes.set(a.id, node);
  return node;
}

function render() {
  const seen = new Set();
  for (const a of board.artboards) {
    seen.add(a.id);
    const node = nodes.get(a.id) || makeNode(a);
    if (!node.el.classList.contains('dragging')) {
      node.el.style.left = a.x + 'px';
      node.el.style.top = a.y + 'px';
    }
    node.el.style.width = a.width + 'px';
    node.el.style.height = a.height + 'px';
    // The name may not run wider than the artboard on screen (see .name in the CSS).
    node.el.style.setProperty('--w', a.width);
    node.iframe.title = a.name;
    node.name.title = a.name;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = a.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = `${a.width} × ${a.height}`;
    node.name.replaceChildren(label, size);
    // Reload the artboard only when its HTML changed.
    if (node.rev !== (a.rev || 1)) {
      node.rev = a.rev || 1;
      node.iframe.src = `/artboard/${a.id}?rev=${node.rev}`;
    }
  }
  for (const [id, node] of nodes) {
    if (!seen.has(id)) {
      node.el.remove();
      nodes.delete(id);
    }
  }

  items.render();
  // Drop a selection whose thing has gone, for example after the agent deleted it.
  const lists = { item: board.items, connector: board.connectors, artboard: board.artboards };
  if (selection && !lists[selection.kind].some((x) => x.id === selection.id)) selection = null;
  showSelection();

  const empty = board.artboards.length === 0 && board.items.length === 0;
  $('empty').hidden = !empty;
  $('panel').hidden = empty;
  renderPanel();
  renderAgents();
  comments.render();
  connectors.render();

  if (firstBoard) {
    firstBoard = false;
    fit(false);
  }
}

// ---- selection ----

function showSelection() {
  for (const [id, node] of items.nodes) node.el.classList.toggle('selected', selection?.kind === 'item' && selection.id === id);
  for (const [id, node] of nodes) node.el.classList.toggle('selected', selection?.kind === 'artboard' && selection.id === id);
  connectors.select(selection?.kind === 'connector' ? selection.id : null);
  // The dock's Delete button shows while something is selected, so deleting
  // does not depend on knowing the Delete key.
  $('delete-button').hidden = !selection;
}
function select(next) {
  selection = next;
  showSelection();
}

async function deleteSelection() {
  if (!selection) return;
  const { kind, id } = selection;
  selection = null;
  try {
    if (kind === 'artboard') {
      const name = board.artboards.find((a) => a.id === id)?.name || 'Artboard';
      const removed = await api('DELETE', `/api/artboards/${id}`);
      lastDeleted = { restore: id };
      const n = removed.comments || 0;
      toast(`"${name}" deleted${n ? ` with its ${n} comment${n === 1 ? '' : 's'}` : ''}.`, { label: 'Undo', run: undo });
    } else if (kind === 'item') {
      const removed = await api('DELETE', `/api/items/${id}`);
      lastDeleted = removed;
      toast(`${{ note: 'Note', code: 'Code card' }[removed.item.type] || 'Reference'} deleted.`, { label: 'Undo', run: undo });
    } else {
      const removed = await api('DELETE', `/api/connectors/${id}`);
      lastDeleted = { connectors: [removed] };
      toast('Arrow deleted.', { label: 'Undo', run: undo });
    }
  } catch {}
}

// Bring back the last deleted thing with its old id, then its arrows.
async function undo() {
  const last = lastDeleted;
  lastDeleted = null;
  if (!last) return;
  $('toast').hidden = true; // the "deleted" message is no longer true
  try {
    // Artboards and comments are kept by the server, which puts them back itself.
    if (last.restore) return void (await api('POST', `/api/restore/${last.restore}`));
    if (last.item) {
      const { id, type, x, y, width, text, asset, url, title, description, author } = last.item;
      await api('POST', '/api/items', { id, type, x, y, width, text, asset, url, title, description, author });
    }
    for (const c of last.connectors || []) await api('POST', '/api/connectors', { id: c.id, from: c.from, to: c.to, label: c.label, author: c.author });
  } catch {}
}

// ---- making notes and references ----

async function addNote(at, text = '') {
  const item = await api('POST', '/api/items', { type: 'note', x: Math.round(at.x), y: Math.round(at.y), text }).catch(() => null);
  if (!item) return;
  // The board event that draws the note may arrive just after this answer.
  // Wait for it, then start typing in the new note.
  const start = () => {
    select({ kind: 'item', id: item.id });
    if (!text) items.edit(item.id, { isNew: true });
  };
  if (items.nodes.has(item.id)) start();
  else pendingEdit = { id: item.id, start };
}
let pendingEdit = null;

async function uploadImages(files, at) {
  const images = [...files].filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
  if (!images.length) return toast('Blueprint takes PNG, JPEG, GIF and WebP images.');
  let offset = 0;
  for (const file of images) {
    const res = await fetch('/api/assets', { method: 'POST', body: file }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok) {
      toast(data.error || 'The image could not be uploaded.');
      continue;
    }
    await api('POST', '/api/items', { type: 'image', asset: data.asset, x: Math.round(at.x + offset), y: Math.round(at.y + offset) }).catch(() => {});
    offset += 32;
  }
}

// ---- what pasted text is ----

async function addText(text, at) {
  const raw = text.replace(/\r\n/g, '\n');
  text = raw.trim();
  if (!text) return;
  const where = { x: Math.round(at.x), y: Math.round(at.y) };
  if (URL_ONLY.test(text)) return api('POST', '/api/items', { type: 'link', url: text, ...where }).catch(() => {});
  if (isHtml(text)) {
    // Pasted HTML becomes an artboard, so it renders like any design.
    const a = await api('POST', '/api/artboards', { name: htmlName(text), html: text }).catch(() => null);
    if (a) {
      toast(`Pasted HTML as the artboard "${a.name}".`);
      canvas.frameRect(a, { inset: inset() });
    }
    return;
  }
  const fenced = text.match(FENCE);
  if (fenced || looksLikeCode(text)) {
    const code = fenced ? fenced[2] : raw.replace(/^\n+|\s+$/g, '');
    const item = await api('POST', '/api/items', { type: 'code', text: code.slice(0, 10000), ...where }).catch(() => null);
    if (item) select({ kind: 'item', id: item.id });
    return;
  }
  await addNote(at, text.slice(0, 10000));
}

// ---- the panel ----

// The panel lists every artboard, note, reference and comment as plain
// buttons, so the whole board can be used from the keyboard without the canvas.
function button(label, onClick, className) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  if (className) b.className = className;
  if (typeof label === 'string') {
    const span = document.createElement('span');
    span.textContent = label;
    b.append(span);
  } else b.append(...label);
  b.addEventListener('click', onClick);
  li.append(b);
  return { li, b };
}

function renderPanel() {
  $('artboard-list').replaceChildren(
    ...board.artboards.map((a) => {
      const open = board.comments.filter((c) => c.artboardId === a.id && c.status === 'open').length;
      const label = document.createElement('span');
      label.textContent = a.name;
      const badge = document.createElement('span');
      badge.className = open ? 'badge' : 'badge quiet';
      badge.textContent = open ? String(open) : '';
      badge.setAttribute('aria-label', open ? `${open} open comment${open === 1 ? '' : 's'}` : '');
      return button([label, badge], () => {
        canvas.frameRect(a, { inset: inset() });
        select({ kind: 'artboard', id: a.id });
      }).li;
    }),
  );

  $('items-heading').hidden = board.items.length === 0;
  $('item-list').replaceChildren(
    ...board.items.map((it) => {
      const kind = document.createElement('span');
      kind.className = `kind kind-${it.type}`;
      kind.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = items.label(it);
      const { li, b } = button([kind, label], () => {
        canvas.frameRect(rectOf(it.id) || { ...it, height: 160 }, { inset: inset(), maxZoom: 1 });
        select({ kind: 'item', id: it.id });
        items.nodes.get(it.id)?.el.focus({ preventScroll: true });
      });
      b.setAttribute('aria-label', `${KIND[it.type]}: ${items.label(it).slice(0, 80)}`);
      return li;
    }),
  );

  $('comments-heading').hidden = board.comments.length === 0;
  $('comment-list').replaceChildren(
    ...board.comments.map((c, i) => {
      const num = document.createElement('span');
      num.className = c.status === 'resolved' ? 'num done' : 'num';
      num.textContent = String(i + 1);
      const label = document.createElement('span');
      label.textContent = c.thread[0].text;
      const { li, b } = button([num, label], (e) => {
        const a = board.artboards.find((x) => x.id === c.artboardId);
        if (a) canvas.frameRect(a, { animate: false, inset: inset() });
        comments.open(c.id, { animate: e.detail > 0, from: b });
      }, c.status === 'resolved' ? 'resolved' : '');
      b.setAttribute('aria-label', `Comment ${i + 1}, ${c.status}: ${c.thread[0].text.slice(0, 80)}`);
      return li;
    }),
  );
}

// ---- agents at work ----

const VERBS = { looking: 'looking at', reading: 'reading', writing: 'writing', creating: 'creating', resizing: 'resizing', replying: 'replying on', resolving: 'resolving a comment on' };
const LOOSE = { reading: ' is reading comments', noting: ' is adding notes and references', connecting: ' is drawing arrows' };

function renderAgents() {
  // Ring and tag on each artboard that has an agent on it.
  for (const [id, node] of nodes) {
    const here = agents.filter((a) => a.artboardId === id);
    node.el.classList.toggle('busy', here.length > 0);
    if (here.length) {
      const dot = document.createElement('span');
      dot.className = 'live';
      node.tag.replaceChildren(dot, here.map((a) => a.name).join(', '));
    }
  }
  // One line per agent in the status pill at the top.
  const rows = agents.map((a) => {
    const artboard = board.artboards.find((x) => x.id === a.artboardId);
    const b = document.createElement('button');
    b.type = 'button';
    const dot = document.createElement('span');
    dot.className = 'live';
    const text = document.createElement('span');
    const who = document.createElement('b');
    who.textContent = a.name;
    const what = artboard ? ` is ${VERBS[a.action] || 'working on'} ${artboard.name}` : LOOSE[a.action] || ' is looking at the board';
    text.append(who, what);
    b.append(dot, text);
    if (artboard) {
      b.title = 'Go to this artboard';
      b.addEventListener('click', () => canvas.frameRect(artboard, { inset: inset() }));
    }
    return b;
  });
  const box = $('agents');
  // Only touch the page when the wording changed, so a screen reader is not
  // told the same thing again every time an agent pings.
  const summary = rows.map((r) => r.textContent).join('|');
  if (box.dataset.summary !== summary) {
    box.dataset.summary = summary;
    box.replaceChildren(...rows);
  }
  box.hidden = rows.length === 0;
}

// ---- tools ----

function setTool(next) {
  tool = next;
  viewport.dataset.tool = next;
  document.querySelectorAll('.dock [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === next)));
  if (next !== 'comment') comments.close();
  // Leaving Use: take focus back from the artboard last clicked, so the
  // board's shortcuts reach this page again.
  if (next !== 'use' && document.activeElement instanceof HTMLIFrameElement) document.activeElement.blur();
}
document.querySelectorAll('.dock [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('fit').addEventListener('click', () => fit());
$('zoom').addEventListener('click', () => canvas.zoomAt(innerWidth / 2, innerHeight / 2, 1));
$('add-image').addEventListener('click', () => $('image-input').click());

// ---- a new, empty artboard from the dock ----
// The button opens a menu of sizes. Choosing one makes the artboard, frames it
// and selects it, so Delete takes it away again if it was a mistake.
const artboardButton = $('add-artboard');
const artboardMenu = $('artboard-menu');
const artboardChoices = [...artboardMenu.querySelectorAll('[role="menuitem"]')];

function showArtboardMenu(open) {
  artboardMenu.hidden = !open;
  artboardButton.setAttribute('aria-expanded', String(open));
  if (!open) return;
  // Above the button, centred on it. The menu is fixed to the screen like the dock.
  const r = artboardButton.getBoundingClientRect();
  const half = artboardMenu.offsetWidth / 2;
  artboardMenu.style.left = `${Math.min(Math.max(r.left + r.width / 2, half + 8), innerWidth - half - 8)}px`;
  artboardMenu.style.bottom = `${innerHeight - r.top + 8}px`;
  artboardChoices[0].focus();
}

// "Desktop", then "Desktop 2", "Desktop 3" and so on.
function nextName(base) {
  const taken = new Set(board.artboards.map((a) => a.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

async function addArtboard(choice) {
  showArtboardMenu(false);
  const { name, width, height } = choice.dataset;
  const a = await api('POST', '/api/artboards', { name: nextName(name), width: Number(width), height: Number(height) }).catch(() => null);
  if (!a) return;
  canvas.frameRect(a, { inset: inset() });
  select({ kind: 'artboard', id: a.id });
  artboardButton.focus({ preventScroll: true });
}

artboardButton.addEventListener('click', () => showArtboardMenu(artboardMenu.hidden));
for (const choice of artboardChoices) choice.addEventListener('click', () => addArtboard(choice));
artboardMenu.addEventListener('keydown', (e) => {
  const i = artboardChoices.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    artboardChoices[(i + (e.key === 'ArrowDown' ? 1 : -1) + artboardChoices.length) % artboardChoices.length].focus();
  } else if (e.key === 'Escape') {
    e.stopPropagation();
    showArtboardMenu(false);
    artboardButton.focus({ preventScroll: true });
  } else if (e.key === 'Tab') showArtboardMenu(false);
});
// A click anywhere else closes the menu.
addEventListener('pointerdown', (e) => {
  if (!artboardMenu.hidden && !artboardMenu.contains(e.target) && !artboardButton.contains(e.target)) showArtboardMenu(false);
});
$('delete-button').addEventListener('click', () => deleteSelection());
$('image-input').addEventListener('change', (e) => {
  uploadImages(e.target.files, viewCentre());
  e.target.value = '';
});

// ---- pointer input on the canvas ----

let spaceHeld = false;
let gesture = null; // { kind: 'pan' | 'artboard' | 'item' | 'resize' | 'connect', ... } while a pointer is down
let lastPointer = null; // the last pointer position on the board, for paste

const boardPoint = (e) => canvas.toBoard(e.clientX, e.clientY);
// What is under the pointer that an arrow can join: an artboard or an item.
// Look through everything under the point, so an existing arrow on top does
// not hide the note or artboard beneath it.
function joinableAt(x, y) {
  for (const el of document.elementsFromPoint(x, y)) {
    const hit = el.closest('.item, .board');
    if (hit) return hit.dataset.id;
  }
  return null;
}

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.pin, .note-input')) return;
  const boardEl = e.target.closest('.board');
  const itemEl = e.target.closest('.item');
  const onName = e.target.closest('.name');
  const linkId = e.target.closest('[data-connector]')?.dataset.connector;

  if (tool === 'comment' && boardEl && !onName && !spaceHeld) {
    // A click on an artboard starts a comment at that point, in artboard pixels.
    // preventDefault stops the click moving focus to the page, which would
    // pull it straight back out of the comment box that startDraft focuses.
    e.preventDefault();
    const r = boardEl.querySelector('.sheet').getBoundingClientRect();
    comments.startDraft(boardEl.dataset.id, Math.round((e.clientX - r.left) / canvas.cam.z), Math.round((e.clientY - r.top) / canvas.cam.z));
    return;
  }

  if (tool === 'note' && !spaceHeld) {
    e.preventDefault(); // keep focus free for the new note's text box
    addNote(boardPoint(e));
    setTool('move'); // one note per click, then back to Move
    return;
  }

  comments.close();
  items.finish();
  viewport.setPointerCapture(e.pointerId);
  const from = itemEl?.dataset.id || boardEl?.dataset.id;

  if (tool === 'arrow' && from && !spaceHeld) {
    gesture = { kind: 'connect', from, over: null };
    connectors.showDraft(from, boardPoint(e), null);
    return;
  }
  if (itemEl && !spaceHeld && tool !== 'arrow') {
    const it = board.items.find((x) => x.id === itemEl.dataset.id);
    if (!it) return;
    select({ kind: 'item', id: it.id });
    const kind = e.target.closest('.grip') ? 'resize' : 'item';
    gesture = { kind, el: itemEl, it, px: e.clientX, py: e.clientY, x: it.x, y: it.y, width: it.width, moved: false };
    return;
  }
  if (linkId && !spaceHeld) {
    select({ kind: 'connector', id: linkId });
    gesture = null;
    return;
  }
  select(null);
  if (onName && boardEl && !spaceHeld && tool !== 'arrow') {
    const a = board.artboards.find((x) => x.id === boardEl.dataset.id);
    gesture = { kind: 'artboard', el: boardEl, a, px: e.clientX, py: e.clientY, x: a.x, y: a.y, moved: false };
  } else {
    // A click on an artboard that does not turn into a drag selects it (see endGesture).
    gesture = { kind: 'pan', px: e.clientX, py: e.clientY, sx: e.clientX, sy: e.clientY, boardId: spaceHeld ? null : boardEl?.dataset.id };
    viewport.classList.add('grabbing');
  }
});

viewport.addEventListener('pointermove', (e) => {
  lastPointer = boardPoint(e);
  if (!gesture) return;
  const dx = e.clientX - gesture.px;
  const dy = e.clientY - gesture.py;
  if (gesture.kind === 'pan') {
    // 1:1 with the pointer. No easing while the pointer is down.
    canvas.panBy(dx, dy);
    gesture.px = e.clientX;
    gesture.py = e.clientY;
    return;
  }
  if (gesture.kind === 'connect') {
    gesture.over = joinableAt(e.clientX, e.clientY);
    document.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    if (gesture.over && gesture.over !== gesture.from) document.querySelector(`[data-id="${gesture.over}"]`)?.classList.add('link-target');
    connectors.showDraft(gesture.from, lastPointer, gesture.over);
    return;
  }
  if (!gesture.moved && Math.hypot(dx, dy) < 4) return; // ignore tiny slips
  gesture.moved = true;
  gesture.el.classList.add('dragging');
  if (gesture.kind === 'resize') {
    gesture.width = Math.max(80, Math.min(2000, Math.round(gesture.it.width + dx / canvas.cam.z)));
    gesture.el.style.width = gesture.width + 'px';
    if (gesture.it.type === 'image') gesture.el.style.height = Math.round(gesture.width * (gesture.it.aspect || 1)) + 'px';
  } else {
    const start = gesture.kind === 'artboard' ? gesture.a : gesture.it;
    gesture.x = Math.round(start.x + dx / canvas.cam.z);
    gesture.y = Math.round(start.y + dy / canvas.cam.z);
    gesture.el.style.left = gesture.x + 'px';
    gesture.el.style.top = gesture.y + 'px';
  }
  connectors.render(); // arrows follow the thing being dragged
});

async function endGesture() {
  const g = gesture;
  gesture = null;
  viewport.classList.remove('grabbing');
  if (!g) return;
  if (g.kind === 'pan') {
    if (g.boardId && Math.hypot(g.px - g.sx, g.py - g.sy) < 4) select({ kind: 'artboard', id: g.boardId });
    return;
  }
  if (g.kind === 'connect') {
    connectors.hideDraft();
    document.querySelectorAll('.link-target').forEach((n) => n.classList.remove('link-target'));
    if (g.over && g.over !== g.from) {
      const made = await api('POST', '/api/connectors', { from: g.from, to: g.over }).catch(() => null);
      if (made) select({ kind: 'connector', id: made.id });
    }
    return;
  }
  g.el.classList.remove('dragging');
  if (!g.moved) {
    if (g.kind === 'artboard') select({ kind: 'artboard', id: g.a.id }); // a click on the name selects it
    return;
  }
  try {
    if (g.kind === 'artboard') await api('PATCH', `/api/artboards/${g.a.id}`, { x: g.x, y: g.y });
    else if (g.kind === 'item') await api('PATCH', `/api/items/${g.it.id}`, { x: g.x, y: g.y });
    else await api('PATCH', `/api/items/${g.it.id}`, { width: g.width });
  } catch {
    render(); // the save failed: put it back where the board says it is
  }
}
viewport.addEventListener('pointerup', endGesture);
viewport.addEventListener('pointercancel', endGesture);

// Double-click: edit a note, open a link, label an arrow, or make a note on empty board.
viewport.addEventListener('dblclick', (e) => {
  // Pointer capture can make the viewport the event's target, so look at what
  // is really under the pointer.
  const hit = document.elementFromPoint(e.clientX, e.clientY);
  if (tool !== 'move' || !hit || hit.closest('.pin, .note-input, .float')) return;
  const itemEl = hit.closest('.item');
  const linkId = hit.closest('[data-connector]')?.dataset.connector;
  if (itemEl) return items.open(itemEl.dataset.id);
  if (linkId) return editLabel(linkId);
  if (!hit.closest('.board')) addNote(boardPoint(e));
});

// Selecting an item from the keyboard: focus selects it.
world.addEventListener('focusin', (e) => {
  const itemEl = e.target.closest?.('.item');
  if (itemEl && !items.isEditing()) select({ kind: 'item', id: itemEl.dataset.id });
});

// ---- arrow labels ----

function editLabel(id) {
  const c = board.connectors.find((x) => x.id === id);
  const mid = connectors.midpointOf(id);
  if (!c || !mid) return;
  select({ kind: 'connector', id });
  const input = $('label-editor');
  const z = canvas.cam.z;
  input.value = c.label || '';
  input.hidden = false;
  input.style.left = Math.round(canvas.cam.x + mid.x * z - input.offsetWidth / 2) + 'px';
  input.style.top = Math.round(canvas.cam.y + mid.y * z - input.offsetHeight / 2) + 'px';
  input.focus();
  input.select();
  const done = async (save) => {
    input.removeEventListener('keydown', onKey);
    input.removeEventListener('blur', onBlur);
    input.hidden = true;
    if (save && input.value.trim() !== (c.label || '')) await api('PATCH', `/api/connectors/${id}`, { label: input.value }).catch(() => {});
  };
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    else if (e.key === 'Escape') done(false);
  };
  const onBlur = () => done(true);
  input.addEventListener('keydown', onKey);
  input.addEventListener('blur', onBlur);
}

// ---- paste and drop ----

addEventListener('paste', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return;
  if (recents.isOpen()) return;
  const at = lastPointer || viewCentre();
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    return uploadImages(files, at);
  }
  const text = e.clipboardData?.getData('text/plain');
  if (text) {
    e.preventDefault();
    addText(text, at);
  }
});

viewport.addEventListener('dragover', (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    viewport.classList.add('dropping');
  }
});
viewport.addEventListener('dragleave', (e) => {
  if (e.target === viewport) viewport.classList.remove('dropping');
});
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  viewport.classList.remove('dropping');
  const at = boardPoint(e);
  if (e.dataTransfer.files.length) return uploadImages(e.dataTransfer.files, at);
  const text = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#')) || e.dataTransfer.getData('text/plain');
  if (text) addText(text, at);
});

// ---- keyboard ----

addEventListener('keydown', (e) => {
  // e.target can be the document itself, which has no matches().
  const on = (selector) => e.target instanceof Element && e.target.matches(selector);
  const typing = on('input, textarea');
  if (recents.isOpen()) return;
  if (e.key === 'Escape') {
    if (comments.isOpen()) comments.close({ refocus: true });
    else if (selection) select(null);
    else if (tool !== 'move') setTool('move');
    return;
  }
  if (typing) return;
  // Delete and Enter act on the selection only while focus is on the board.
  // On a panel or dock button, Enter must press that button.
  const onBoard = !(e.target instanceof Element) || e.target === document.body || !!e.target.closest('.item, #viewport');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && lastDeleted) {
    e.preventDefault();
    undo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection && onBoard) {
    e.preventDefault();
    deleteSelection();
    return;
  }
  if (e.key === 'Enter' && selection && onBoard) {
    e.preventDefault();
    if (selection.kind === 'item') items.open(selection.id);
    else if (selection.kind === 'artboard') {
      const a = board.artboards.find((x) => x.id === selection.id);
      if (a) canvas.frameRect(a, { inset: inset() });
    } else editLabel(selection.id);
    return;
  }
  if (e.code === 'Space') {
    if (!on('button, .item')) {
      spaceHeld = true;
      e.preventDefault();
    }
    return;
  }
  const key = e.key.toLowerCase();
  if (toolKey(key)) return;
  if (key.startsWith('arrow')) {
    const step = e.shiftKey ? 200 : 60;
    canvas.panBy(key === 'arrowleft' ? step : key === 'arrowright' ? -step : 0, key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0);
  }
});

// The dock's letter shortcuts. Returns true when the key was one of them.
function toolKey(key) {
  const tools = { v: 'move', n: 'note', a: 'arrow', c: 'comment', u: 'use' };
  if (tools[key]) setTool(tools[key]);
  else if (key === '1') fit();
  else if (key === 'f') showArtboardMenu(artboardMenu.hidden);
  else return false;
  return true;
}

// In Use, a click inside an artboard moves keyboard focus into its iframe, and
// key presses stop reaching this page. The helper script in each artboard
// passes Escape and the tool letters back up. Only a message from one of the
// artboards on this board is acted on.
addEventListener('message', (e) => {
  if (e.data?.type !== 'blueprint:key' || typeof e.data.key !== 'string') return;
  if (![...nodes.values()].some((n) => n.iframe.contentWindow === e.source)) return;
  if (recents.isOpen()) return;
  const key = e.data.key.toLowerCase();
  if (key === 'escape') setTool('move');
  else toolKey(key);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
});
addEventListener('resize', () => comments.place());

// ---- start ----

setTool('move');
canvas.apply();
// Blueprint opens on the Boards list. An address ending in #board, which
// opening or closing a board sets, goes straight to the board instead.
if (location.hash !== ON_BOARD) recents.open();

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    // The app is always called Blueprint. The project folder's name sits beside it.
    const name = h.root.split('/').filter(Boolean).pop() || '';
    $('project').textContent = name;
    document.title = name ? `Blueprint · ${name}` : 'Blueprint';
  })
  .catch(() => {});

// The server pushes the whole board every time it changes. EventSource
// reconnects by itself if the server restarts.
const events = new EventSource('/api/events');
let lost = false;
events.addEventListener('board', (e) => {
  board = JSON.parse(e.data);
  board.items ||= [];
  board.connectors ||= [];
  render();
  if (pendingEdit && items.nodes.has(pendingEdit.id)) {
    const p = pendingEdit;
    pendingEdit = null;
    p.start();
  }
});
const chat = createChat({ api });
const accounts = createAccounts({ api });
events.addEventListener('chat', (e) => {
  const state = JSON.parse(e.data);
  chat.update(state);
  accounts.update(state);
});
events.addEventListener('activity', (e) => {
  agents = JSON.parse(e.data);
  renderAgents();
});
// Say so once when the connection drops, not on every retry.
events.addEventListener('error', () => {
  if (!lost) toast('Lost the connection to Blueprint. Trying again.');
  lost = true;
});
events.addEventListener('open', () => {
  if (lost) toast('Connected again.');
  lost = false;
});
