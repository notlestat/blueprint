// Comment pins and the thread card. Pins live on the board and move with it.
// The card lives on the screen, so it stays one size at any zoom.

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent, never innerHTML: comment text is not trusted
  return node;
};

function when(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function createComments({ api, getBoard, nodes, toast, onDelete }) {
  const card = $('thread');
  const body = $('thread-body');
  const form = $('composer');
  const input = $('composer-input');
  const statusText = $('thread-status');
  const toggle = $('thread-toggle');
  const remove = $('thread-delete');

  let openId = null; // id of the comment whose thread is showing
  let draft = null; // { artboardId, x, y, target, pin } while writing a new comment
  let returnFocus = null;

  const numberOf = (id) => getBoard().comments.findIndex((c) => c.id === id) + 1;
  const pinFor = (id) => document.querySelector(`.pin[data-id="${id}"]`);

  // Ask the artboard which element is at (x, y). It answers through the helper
  // script the server adds to every artboard. No answer in 300ms means "unknown".
  function elementAt(iframe, x, y) {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      const done = (target) => {
        removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve(target);
      };
      const onMessage = (e) => {
        // Only trust a reply that comes from this exact iframe.
        if (e.source !== iframe.contentWindow || e.data?.type !== 'blueprint:element' || e.data.requestId !== requestId) return;
        done(e.data.target || null);
      };
      const timer = setTimeout(() => done(null), 300);
      addEventListener('message', onMessage);
      iframe.contentWindow?.postMessage({ type: 'blueprint:elementAt', x, y, requestId }, '*');
    });
  }

  function renderPins() {
    document.querySelectorAll('.pin:not(.draft)').forEach((p) => p.remove());
    getBoard().comments.forEach((c, i) => {
      const node = nodes.get(c.artboardId);
      if (!node) return;
      const pin = el('button', c.status === 'resolved' ? 'pin done' : 'pin', String(i + 1));
      pin.type = 'button';
      pin.dataset.id = c.id;
      pin.style.left = c.x + 'px';
      pin.style.top = c.y + 'px';
      pin.setAttribute('aria-label', `Comment ${i + 1}, ${c.status}: ${c.thread[0].text.slice(0, 60)}`);
      pin.setAttribute('aria-expanded', String(c.id === openId));
      // e.detail is 0 when a click comes from the keyboard. Keyboard actions do not animate.
      pin.addEventListener('click', (e) => (openId === c.id ? close() : open(c.id, { animate: e.detail > 0, from: pin })));
      node.el.append(pin);
    });
  }

  function renderThread() {
    const c = getBoard().comments.find((x) => x.id === openId);
    if (!c) return close();
    body.replaceChildren();
    c.thread.forEach((m, i) => {
      const row = el('div', 'msg');
      row.append(el('span', m.author === 'agent' ? 'who agent' : 'who', m.author === 'agent' ? 'A' : 'Y'));
      const text = el('div');
      const time = el('time', '', when(m.at));
      time.dateTime = m.at;
      text.append(el('b', '', m.author === 'agent' ? 'Agent' : 'You'), time, el('p', '', m.text));
      row.append(text);
      body.append(row);
      if (i === 0 && c.target) body.append(el('div', 'target', `${c.target.tag}${c.target.text ? ` “${c.target.text}”` : ''}`));
    });
    card.setAttribute('aria-label', `Comment ${numberOf(c.id)}`);
    input.placeholder = 'Reply';
    input.setAttribute('aria-label', 'Reply');
    form.hidden = c.status === 'resolved';
    toggle.parentElement.hidden = false;
    const last = c.thread.at(-1);
    statusText.textContent = c.status === 'resolved' ? 'Resolved' : last.author === 'agent' ? 'Open · agent replied' : 'Open · waiting for the agent';
    toggle.textContent = c.status === 'resolved' ? 'Reopen' : 'Resolve';
  }

  // Put the card beside its pin, kept inside the window.
  function place() {
    if (card.hidden) return;
    const pin = draft ? draft.pin : pinFor(openId);
    if (!pin) return;
    const r = pin.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    let x = r.right + 8;
    if (x + w > innerWidth - 16) x = r.left - w - 8; // no room on the right: go left
    x = Math.max(16, Math.min(x, innerWidth - w - 16));
    const y = Math.max(16, Math.min(r.top, innerHeight - h - 84));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    // Grow from the corner nearest the pin.
    card.style.transformOrigin = `${x > r.left ? 'left' : 'right'} top`;
  }

  function show({ animate }) {
    card.hidden = false;
    place();
    card.classList.remove('entering');
    if (animate) {
      void card.offsetWidth; // restart the animation
      card.classList.add('entering');
    }
  }

  function open(id, { animate = true, from = null } = {}) {
    cancelDraft();
    openId = id;
    returnFocus = from || pinFor(id);
    renderPins();
    renderThread();
    if (!openId) return;
    show({ animate });
    const c = getBoard().comments.find((x) => x.id === id);
    (c.status === 'resolved' ? toggle : input).focus({ preventScroll: true });
  }

  function close({ refocus = false } = {}) {
    const hadFocus = card.contains(document.activeElement);
    const previous = openId;
    cancelDraft();
    openId = null;
    card.hidden = true;
    input.value = '';
    document.querySelectorAll('.pin[aria-expanded="true"]').forEach((p) => p.setAttribute('aria-expanded', 'false'));
    // Pins are redrawn on every board update, so the pin that opened the card
    // may be gone. Fall back to the current pin for the same comment.
    const back = returnFocus?.isConnected ? returnFocus : previous && pinFor(previous);
    if ((refocus || hadFocus) && back) back.focus({ preventScroll: true });
    returnFocus = null;
  }

  function cancelDraft() {
    draft?.pin.remove();
    draft = null;
  }

  // Start a new comment at (x, y) on an artboard, in artboard pixels.
  async function startDraft(artboardId, x, y) {
    const node = nodes.get(artboardId);
    if (!node) return;
    close();
    const pin = el('span', 'pin draft', '+');
    pin.style.left = x + 'px';
    pin.style.top = y + 'px';
    node.el.append(pin);
    draft = { artboardId, x, y, target: null, pin };
    body.replaceChildren();
    form.hidden = false;
    toggle.parentElement.hidden = true;
    card.setAttribute('aria-label', 'New comment');
    input.placeholder = 'Add a comment';
    input.setAttribute('aria-label', 'Add a comment');
    show({ animate: true });
    input.focus({ preventScroll: true });
    const mine = draft;
    const target = await elementAt(node.iframe, x, y);
    if (draft === mine) {
      draft.target = target;
      if (target) {
        body.replaceChildren(el('div', 'target', `${target.tag}${target.text ? ` “${target.text}”` : ''}`));
        body.firstChild.style.marginLeft = '0';
        place();
      }
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    try {
      if (draft) {
        const { artboardId, x, y, target } = draft;
        await api('POST', '/api/comments', { artboardId, x, y, text, target });
        input.value = '';
        close();
        toast('Comment added. Tell your agent to check the board.');
      } else if (openId) {
        await api('POST', `/api/comments/${openId}/replies`, { author: 'user', text });
        input.value = '';
      }
    } catch {} // api() already showed the error
  });

  toggle.addEventListener('click', async () => {
    const c = getBoard().comments.find((x) => x.id === openId);
    if (!c) return;
    try {
      await api('PATCH', `/api/comments/${c.id}`, { status: c.status === 'resolved' ? 'open' : 'resolved' });
    } catch {}
  });

  // The server keeps a deleted comment for a while, so Undo can bring it back.
  remove.addEventListener('click', async () => {
    const id = openId;
    if (!id) return;
    try {
      await api('DELETE', `/api/comments/${id}`);
    } catch {
      return;
    }
    close();
    onDelete?.(id);
    toast('Comment deleted.', { label: 'Undo', run: () => api('POST', `/api/restore/${id}`).catch(() => {}) });
  });

  return {
    startDraft,
    open,
    close,
    place,
    isOpen: () => !card.hidden,
    // Called after every board update.
    render() {
      renderPins();
      if (openId) {
        renderThread();
        place();
      }
    },
  };
}
