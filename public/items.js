// Notes and references on the board: text notes, images and link cards.
// Each is a plain element in #world, so it pans and zooms with the artboards.
// All text goes in with textContent, never innerHTML, because a note or a link
// title can hold anything a person or a web page typed.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export const KIND = { note: 'Note', code: 'Code', image: 'Image', link: 'Link' };
const hasText = (item) => item.type === 'note' || item.type === 'code';

export function createItems({ world, api, getBoard, onEditEnd }) {
  const nodes = new Map(); // item id -> { el, body, rev }
  let editing = null; // { id, textarea, isNew }

  function label(item) {
    if (hasText(item)) return item.text.trim().split('\n')[0].trim() || (item.type === 'code' ? 'Empty code card' : 'Empty note');
    return item.title || item.url || 'Image';
  }

  function fill(node, item) {
    const { body } = node;
    body.replaceChildren();
    if (item.type === 'note') {
      const text = el('div', 'note-text', item.text);
      if (!item.text.trim()) text.classList.add('placeholder');
      body.append(text);
    } else if (item.type === 'code') {
      const pre = el('pre', 'code-text', item.text);
      if (!item.text.trim()) pre.classList.add('placeholder');
      body.append(pre);
    } else if (item.type === 'image') {
      const img = el('img');
      img.src = `/assets/${item.asset}`;
      img.alt = item.title || 'Reference image';
      img.draggable = false;
      img.decoding = 'async';
      body.append(img);
      if (item.title) body.append(el('div', 'caption', item.title));
    } else {
      const host = (() => {
        try {
          return new URL(item.url).hostname.replace(/^www\./, '');
        } catch {
          return item.url;
        }
      })();
      body.append(el('span', 'host', host), el('b', 'link-title', item.title || host));
      if (item.description) body.append(el('p', 'link-desc', item.description));
    }
  }

  function make(item) {
    const node = el('div', `item ${item.type}`);
    node.dataset.id = item.id;
    node.tabIndex = 0; // reachable from the keyboard: Tab to it, Enter to edit or open, Delete to remove
    node.setAttribute('role', 'button'); // so a screen reader announces it as something to act on
    node.setAttribute('aria-roledescription', KIND[item.type].toLowerCase());
    const by = el('div', 'by', 'Agent');
    const body = el('div', 'item-body');
    const grip = el('span', 'grip');
    grip.setAttribute('aria-hidden', 'true');
    node.append(by, body, grip);
    world.append(node);
    const entry = { el: node, body, key: '' };
    nodes.set(item.id, entry);
    return entry;
  }

  function render() {
    const seen = new Set();
    for (const item of getBoard().items) {
      seen.add(item.id);
      const node = nodes.get(item.id) || make(item);
      if (!node.el.classList.contains('dragging')) {
        node.el.style.left = item.x + 'px';
        node.el.style.top = item.y + 'px';
        node.el.style.width = item.width + 'px';
      }
      if (item.type === 'image') node.el.style.height = Math.round(item.width * (item.aspect || 1)) + 'px';
      node.el.classList.toggle('agent', item.author === 'agent');
      node.el.setAttribute('aria-label', `${KIND[item.type]}: ${label(item).slice(0, 80)}`);
      // Redraw the contents only when they changed, and never under the person typing.
      const key = JSON.stringify([item.text, item.title, item.url, item.description, item.asset]);
      if (node.key !== key && editing?.id !== item.id) {
        node.key = key;
        fill(node, item);
      }
    }
    for (const [id, node] of nodes) {
      if (!seen.has(id)) {
        node.el.remove();
        nodes.delete(id);
        if (editing?.id === id) editing = null;
      }
    }
  }

  // ---- editing a note in place ----

  function grow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
  }

  function edit(id, { isNew = false } = {}) {
    const item = getBoard().items.find((i) => i.id === id);
    const node = nodes.get(id);
    if (!item || !hasText(item) || !node) return;
    if (editing?.id === id) return editing.textarea.focus();
    finish();
    const textarea = el('textarea', item.type === 'code' ? 'note-input code-input' : 'note-input');
    textarea.spellcheck = item.type !== 'code';
    textarea.value = item.text;
    textarea.maxLength = 10000;
    textarea.setAttribute('aria-label', 'Note text');
    textarea.placeholder = item.type === 'code' ? 'Paste or type code' : 'Write a note';
    node.body.replaceChildren(textarea);
    node.el.classList.add('editing');
    editing = { id, textarea, isNew };
    grow(textarea);
    textarea.addEventListener('input', () => grow(textarea));
    textarea.addEventListener('blur', () => finish());
    textarea.addEventListener('keydown', (e) => {
      // In a code card, Tab indents instead of leaving the box.
      if (e.key === 'Tab' && item.type === 'code' && !e.shiftKey) {
        e.preventDefault();
        textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
        grow(textarea);
        return;
      }
      // Escape, or Cmd/Ctrl+Enter, saves and stops editing. Plain Enter is a new line.
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        e.stopPropagation();
        finish({ refocus: true });
      }
    });
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  async function finish({ refocus = false } = {}) {
    if (!editing) return;
    const { id, textarea, isNew } = editing;
    editing = null;
    const node = nodes.get(id);
    node?.el.classList.remove('editing');
    const item = getBoard().items.find((i) => i.id === id);
    const text = textarea.value;
    if (node) node.key = ''; // force a redraw of the plain text
    try {
      if (item && !text.trim() && (isNew || !item.text.trim())) {
        // A note left empty is not worth keeping.
        await api('DELETE', `/api/items/${id}`);
      } else if (item && text !== item.text) {
        await api('PATCH', `/api/items/${id}`, { text });
      } else render();
    } catch {
      // The save failed (api() has said why). Reopen the note with the typed
      // text still in it, so nothing is lost and the person can try again.
      render();
      if (getBoard().items.some((i) => i.id === id)) {
        edit(id);
        if (editing?.id === id) {
          editing.textarea.value = text;
          grow(editing.textarea);
        }
      }
      return;
    }
    if (refocus) nodes.get(id)?.el.focus({ preventScroll: true });
    onEditEnd?.();
  }

  return {
    nodes,
    render,
    edit,
    finish,
    isEditing: () => editing !== null,
    label,
    // Open a link card's address in a new tab. Only http and https ever reach
    // the board (the server checks), and noopener keeps the new tab from
    // reaching back into this page.
    open(id) {
      const item = getBoard().items.find((i) => i.id === id);
      if (item?.type === 'link') window.open(item.url, '_blank', 'noopener,noreferrer');
      else if (item && hasText(item)) edit(id);
    },
  };
}
