// The canvas page. It keeps one copy of the board, redraws when the server
// sends a new one, and turns pointer and key input into pans, moves and comments.

import { createCanvas } from './canvas.js';
import { createComments } from './comments.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const world = $('world');

let board = { version: 1, artboards: [], comments: [] };
let tool = 'move';
let firstBoard = true;
let agents = []; // what each agent is doing right now, sent by the server
const nodes = new Map(); // artboard id -> { el, sheet, iframe, name, rev }

// ---- talking to the server ----

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
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

// ---- canvas and comments ----

const canvas = createCanvas(viewport, world, {
  onChange(cam) {
    $('zoom').textContent = Math.round(cam.z * 100) + '%';
    comments?.place();
  },
});
const comments = createComments({ api, getBoard: () => board, nodes, toast });

function bounds(list = board.artboards) {
  if (!list.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...list.map((a) => a.x));
  const y = Math.min(...list.map((a) => a.y));
  return {
    x,
    y,
    width: Math.max(...list.map((a) => a.x + a.width)) - x,
    height: Math.max(...list.map((a) => a.y + a.height)) - y,
  };
}
// Leave room for the floating panel on wide windows, so Fit never hides an artboard under it.
function inset() {
  const panel = $('panel');
  const wide = innerWidth > 720 && !panel.hidden;
  return { top: 80, left: 40, bottom: wide ? 96 : 96 + panel.offsetHeight, right: wide ? panel.offsetWidth + 40 : 40 };
}
const fit = (animate = true) => canvas.frameRect(bounds(), { animate, inset: inset() });

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
    node.iframe.title = a.name;
    const size = document.createElement('span');
    size.textContent = `${a.width} × ${a.height}`;
    node.name.replaceChildren(a.name, size);
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

  $('empty').hidden = board.artboards.length > 0;
  $('panel').hidden = board.artboards.length === 0;
  renderPanel();
  renderAgents();
  comments.render();

  if (firstBoard) {
    firstBoard = false;
    fit(false);
  }
}

// The panel lists every artboard and every comment as plain buttons, so the
// whole board can be used from the keyboard without touching the canvas.
function renderPanel() {
  const artboards = board.artboards.map((a) => {
    const open = board.comments.filter((c) => c.artboardId === a.id && c.status === 'open').length;
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const label = document.createElement('span');
    label.textContent = a.name;
    const badge = document.createElement('span');
    badge.className = open ? 'badge' : 'badge quiet';
    badge.textContent = open ? String(open) : '';
    badge.setAttribute('aria-label', open ? `${open} open comment${open === 1 ? '' : 's'}` : '');
    b.append(label, badge);
    b.addEventListener('click', () => canvas.frameRect(a, { inset: inset() }));
    li.append(b);
    return li;
  });
  $('artboard-list').replaceChildren(...artboards);

  $('comments-heading').hidden = board.comments.length === 0;
  const items = board.comments.map((c, i) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    if (c.status === 'resolved') b.className = 'resolved';
    const num = document.createElement('span');
    num.className = c.status === 'resolved' ? 'num done' : 'num';
    num.textContent = String(i + 1);
    const label = document.createElement('span');
    label.textContent = c.thread[0].text;
    b.append(num, label);
    b.setAttribute('aria-label', `Comment ${i + 1}, ${c.status}: ${c.thread[0].text.slice(0, 80)}`);
    b.addEventListener('click', (e) => {
      const a = board.artboards.find((x) => x.id === c.artboardId);
      if (a) canvas.frameRect(a, { animate: false, inset: inset() });
      comments.open(c.id, { animate: e.detail > 0, from: b });
    });
    li.append(b);
    return li;
  });
  $('comment-list').replaceChildren(...items);
}

// ---- agents at work ----

const VERBS = { looking: 'looking at', reading: 'reading', writing: 'writing', creating: 'creating', resizing: 'resizing', replying: 'replying on', resolving: 'resolving a comment on' };

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
    const what = artboard ? ` is ${VERBS[a.action] || 'working on'} ${artboard.name}` : a.action === 'reading' ? ' is reading comments' : ' is looking at the board';
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
  document.querySelectorAll('[data-tool]').forEach((b) => {
    if (b !== viewport) b.setAttribute('aria-pressed', String(b.dataset.tool === next));
  });
  if (next !== 'comment') comments.close();
}
document.querySelectorAll('.dock [data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('fit').addEventListener('click', () => fit());
$('zoom').addEventListener('click', () => canvas.zoomAt(innerWidth / 2, innerHeight / 2, 1));

// ---- pointer input on the canvas ----

let spaceHeld = false;
let gesture = null; // { kind: 'pan' | 'artboard', ... } while a pointer is down

viewport.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.pin')) return;
  const boardEl = e.target.closest('.board');
  const onName = e.target.closest('.name');

  if (tool === 'comment' && boardEl && !onName && !spaceHeld) {
    // A click on an artboard starts a comment at that point, in artboard pixels.
    const r = boardEl.querySelector('.sheet').getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / canvas.cam.z);
    const y = Math.round((e.clientY - r.top) / canvas.cam.z);
    comments.startDraft(boardEl.dataset.id, x, y);
    return;
  }

  comments.close();
  viewport.setPointerCapture(e.pointerId);
  if (onName && boardEl && !spaceHeld) {
    const a = board.artboards.find((x) => x.id === boardEl.dataset.id);
    gesture = { kind: 'artboard', el: boardEl, a, px: e.clientX, py: e.clientY, x: a.x, y: a.y, moved: false };
  } else {
    gesture = { kind: 'pan', px: e.clientX, py: e.clientY };
    viewport.classList.add('grabbing');
  }
});

viewport.addEventListener('pointermove', (e) => {
  if (!gesture) return;
  const dx = e.clientX - gesture.px;
  const dy = e.clientY - gesture.py;
  if (gesture.kind === 'pan') {
    // 1:1 with the pointer. No easing while the pointer is down.
    canvas.panBy(dx, dy);
    gesture.px = e.clientX;
    gesture.py = e.clientY;
  } else {
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return; // ignore tiny slips
    gesture.moved = true;
    gesture.el.classList.add('dragging');
    gesture.x = Math.round(gesture.a.x + dx / canvas.cam.z);
    gesture.y = Math.round(gesture.a.y + dy / canvas.cam.z);
    gesture.el.style.left = gesture.x + 'px';
    gesture.el.style.top = gesture.y + 'px';
  }
});

async function endGesture() {
  const g = gesture;
  gesture = null;
  viewport.classList.remove('grabbing');
  if (g?.kind !== 'artboard') return;
  g.el.classList.remove('dragging');
  if (!g.moved) return;
  try {
    await api('PATCH', `/api/artboards/${g.a.id}`, { x: g.x, y: g.y });
  } catch {
    render(); // the save failed: put the artboard back where the board says it is
  }
}
viewport.addEventListener('pointerup', endGesture);
viewport.addEventListener('pointercancel', endGesture);

// ---- keyboard ----

addEventListener('keydown', (e) => {
  // e.target can be the document itself, which has no matches().
  const on = (selector) => e.target instanceof Element && e.target.matches(selector);
  const typing = on('input, textarea');
  if (e.key === 'Escape') {
    if (comments.isOpen()) comments.close({ refocus: true });
    else if (tool !== 'move') setTool('move');
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') {
    if (!on('button')) {
      spaceHeld = true;
      e.preventDefault();
    }
    return;
  }
  const key = e.key.toLowerCase();
  if (key === 'v') setTool('move');
  else if (key === 'c') setTool('comment');
  else if (key === 'u') setTool('use');
  else if (key === '1') fit();
  else if (key.startsWith('arrow')) {
    const step = e.shiftKey ? 200 : 60;
    canvas.panBy(key === 'arrowleft' ? step : key === 'arrowright' ? -step : 0, key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0);
  }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false;
});
addEventListener('resize', () => comments.place());

// ---- start ----

setTool('move');
canvas.apply();

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
events.addEventListener('board', (e) => {
  board = JSON.parse(e.data);
  render();
});
events.addEventListener('activity', (e) => {
  agents = JSON.parse(e.data);
  renderAgents();
});
events.addEventListener('error', () => toast('Lost the connection to Blueprint. Trying again.'));
