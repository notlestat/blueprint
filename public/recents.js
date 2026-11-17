// Boards: every project with a Blueprint board, as cards with a small map of
// each board, and a form to make a new one. The page opens here. Each project
// runs its own server on its own port, so opening one moves this tab to that
// server's address.
//
// "#board" at the end of the address means "show the board, not this list".
// A fresh visit has no "#board", so it lands here; a reload keeps the board.

export const ON_BOARD = '#board';
const BOARDS = '#boards';
const NEW_BOARD = '#new';
const boardAddress = (url) => `${url}/${ON_BOARD}`;
// Show a home folder as ~, the way people type it.
const tidy = (p) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(iso) {
  const s = (Date.parse(iso) - Date.now()) / 1000;
  if (!Number.isFinite(s)) return '';
  const steps = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of steps) {
    if (Math.abs(v) < size) return unit === 'second' ? 'just now' : rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Draw a board's outline: artboards as white sheets, notes and references as smaller cards.
function map(outline) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'map');
  svg.setAttribute('aria-hidden', 'true');
  if (!outline.length) return svg;
  const minX = Math.min(...outline.map((b) => b.x));
  const minY = Math.min(...outline.map((b) => b.y));
  const maxX = Math.max(...outline.map((b) => b.x + b.w));
  const maxY = Math.max(...outline.map((b) => b.y + b.h));
  const pad = Math.max(maxX - minX, maxY - minY) * 0.06 + 40;
  svg.setAttribute('viewBox', `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const r = Math.max(maxX - minX, maxY - minY) * 0.006;
  for (const b of outline) {
    const rect = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: b.x, y: b.y, width: b.w, height: b.h, rx: r })) rect.setAttribute(k, v);
    rect.setAttribute('class', `map-${b.k}`);
    svg.append(rect);
  }
  return svg;
}

export function createRecents({ api, toast }) {
  const box = $('recents');
  const grid = $('recents-grid');
  const opener = $('home-button');
  const newButton = $('new-board');
  const form = $('new-board-form');
  const nameInput = $('new-board-name');
  const hint = $('new-board-hint');
  let current = null;
  let boardsDir = '';

  function card(p) {
    const li = el('li');
    const b = el('button', 'recent');
    b.type = 'button';
    const thumb = el('div', 'thumb');
    thumb.append(map(p.outline));
    const meta = el('div', 'recent-meta');
    const title = el('div', 'recent-title');
    title.append(el('span', '', p.name));
    if (p.root === current) title.append(el('span', 'chip', 'This board'));
    else if (p.url) title.append(el('span', 'chip live-chip', 'Open'));
    const detail = p.missing
      ? 'Folder moved or deleted'
      : [ago(p.editedAt) && `Edited ${ago(p.editedAt)}`, plural(p.artboards, 'artboard'), p.items ? `${p.items} ${p.items === 1 ? 'note or reference' : 'notes and references'}` : '', p.openComments ? plural(p.openComments, 'open comment') : '']
          .filter(Boolean)
          .join(' · ');
    meta.append(title, el('div', 'recent-detail', detail));
    b.append(thumb, meta);
    b.title = p.root;
    b.setAttribute('aria-label', `${p.name}. ${detail}`);
    if (p.missing) {
      b.disabled = true;
      const forget = el('button', 'forget', 'Remove');
      forget.type = 'button';
      forget.setAttribute('aria-label', `Remove ${p.name} from Recents`);
      forget.addEventListener('click', async () => {
        await api('POST', '/api/recents/forget', { root: p.root }).catch(() => {});
        load();
      });
      li.append(b, forget);
      return li;
    }
    if (p.root !== current) li.append(menu(p));
    b.addEventListener('click', async () => {
      if (p.root === current) return close();
      b.classList.add('busy');
      try {
        const { url } = p.url ? p : await api('POST', '/api/recents/open', { root: p.root });
        location.href = boardAddress(url);
      } catch {
        b.classList.remove('busy');
      }
    });
    li.prepend(b);
    return li;
  }

  // The "…" button on a card and the panel it opens: remove from the list, or
  // delete the board. The board you have open has no menu, because a server
  // cannot move its own folder away while it runs.
  function dots() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 14 14');
    svg.setAttribute('aria-hidden', 'true');
    for (const cx of [3, 7, 11]) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', cx);
      c.setAttribute('cy', 7);
      c.setAttribute('r', 1.4);
      c.setAttribute('fill', 'currentColor');
      svg.append(c);
    }
    return svg;
  }

  function menu(p) {
    const wrap = el('div', 'card-tools');
    const more = el('button', 'more');
    more.type = 'button';
    more.append(dots());
    more.setAttribute('aria-label', `Options for ${p.name}`);
    more.setAttribute('aria-expanded', 'false');
    const panel = el('div', 'card-menu');
    panel.hidden = true;
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', `Delete ${p.name}`);
    const text = el('p', '', `Delete the board for ${p.name}? Its artboards, notes and images move to Blueprint's deleted folder, so you can get them back. The project's own files stay where they are.`);
    const row = el('div', 'menu-row');
    const cancel = el('button', '', 'Cancel');
    const forget = el('button', '', 'Remove from list');
    const del = el('button', 'danger', 'Delete board');
    for (const x of [cancel, forget, del]) x.type = 'button';
    row.append(cancel, forget, del);
    panel.append(text, row);
    wrap.append(more, panel);

    const show = (open) => {
      panel.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
      (open ? cancel : more).focus({ preventScroll: true });
    };
    more.addEventListener('click', () => show(panel.hidden));
    cancel.addEventListener('click', () => show(false));
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // close the panel, not the whole Recents view
        show(false);
      }
    });
    forget.addEventListener('click', async () => {
      await api('POST', '/api/recents/forget', { root: p.root }).catch(() => {});
      toast(`Removed ${p.name} from Recents. Its board is still in the project folder.`);
      await load();
      focusFirst();
    });
    del.addEventListener('click', async () => {
      del.disabled = forget.disabled = cancel.disabled = true;
      del.textContent = 'Deleting…';
      try {
        const { movedTo } = await api('POST', '/api/recents/delete', { root: p.root });
        toast(`Deleted the board for ${p.name}. It is in ${movedTo}.`);
      } catch {}
      await load();
      focusFirst();
    });
    return wrap;
  }

  const focusFirst = () => grid.querySelector('button:not([disabled])')?.focus({ preventScroll: true });

  async function load() {
    try {
      const data = await api('GET', '/api/recents');
      current = data.current;
      boardsDir = data.boardsDir || '';
      showHint();
      grid.replaceChildren(...data.projects.map(card));
      if (!data.projects.length) grid.replaceChildren(el('li', 'recents-empty', 'No boards yet.'));
    } catch {
      toast('Could not read Recents.');
    }
  }

  // ---- a new board ----
  function showHint() {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    hint.textContent = boardsDir ? `Saved in ${tidy(boardsDir)}/${name || 'its name'}` : '';
  }
  function showForm(show) {
    form.hidden = !show;
    newButton.setAttribute('aria-expanded', String(show));
    if (show) nameInput.focus();
    else {
      nameInput.value = '';
      showHint();
      newButton.focus({ preventScroll: true });
    }
  }
  newButton.addEventListener('click', () => showForm(form.hidden));
  $('new-board-cancel').addEventListener('click', () => showForm(false));
  nameInput.addEventListener('input', showHint);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const create = form.querySelector('.create');
    create.disabled = true;
    create.textContent = 'Creating…';
    try {
      const { url } = await api('POST', '/api/boards', { name: nameInput.value });
      location.href = boardAddress(url);
    } catch {
      // api() has already said why in a message; keep the name so it can be fixed.
      create.disabled = false;
      create.textContent = 'Create';
      nameInput.focus();
    }
  });

  async function open() {
    const wantsForm = location.hash === NEW_BOARD;
    box.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    await load();
    if (wantsForm) showForm(true);
    else focusFirst();
  }

  // The desktop app's File menu sets #boards or #new to show this list or its
  // form. The hash is cleared once the list is open, so choosing the same
  // item again works.
  addEventListener('hashchange', () => {
    if (location.hash !== BOARDS && location.hash !== NEW_BOARD) return;
    open().finally(() => history.replaceState(null, '', location.pathname));
  });

  // Closing shows this board, and marks the address so a reload stays on it.
  function close() {
    box.hidden = true;
    if (!form.hidden) showForm(false);
    opener.setAttribute('aria-expanded', 'false');
    opener.focus({ preventScroll: true });
    if (location.hash !== ON_BOARD) history.replaceState(null, '', ON_BOARD);
  }

  opener.addEventListener('click', () => (box.hidden ? open() : close()));
  $('recents-close').addEventListener('click', close);
  // Keep Tab inside the dialog while it is open.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (!form.hidden) showForm(false); // the first Escape closes the form, the next one the list
      else close();
    } else if (e.key === 'Tab') {
      const focusable = [...box.querySelectorAll('button:not([disabled]), input')].filter((b) => b.offsetParent !== null); // skip controls in closed menus and forms
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  return { open, close, isOpen: () => !box.hidden };
}
