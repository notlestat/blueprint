// The chat with the design agent: Blueprint's own, or the user's Claude Code
// or Codex. The server owns the conversation and pushes it on the event
// stream; this file draws it, sends what you type, switches the agent and
// answers the agent's permission requests.

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text; // textContent, never innerHTML: model output is not trusted markup
  return node;
};

// The agent writes a little Markdown. This draws paragraphs, "- " lists,
// **bold** and `code` out of DOM nodes and text, so nothing it writes can
// become markup.
function inline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (/^\*\*[^*]+\*\*$/.test(part)) parent.append(el('strong', '', part.slice(2, -2)));
    else if (/^`[^`]+`$/.test(part)) parent.append(el('code', '', part.slice(1, -1)));
    else if (part) parent.append(document.createTextNode(part));
  }
}
export function formatReply(text) {
  const out = document.createDocumentFragment();
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    let list = null;
    let para = null;
    for (const line of lines) {
      const item = line.match(/^\s*[-*•]\s+(.*)$/);
      if (item) {
        para = null;
        list ||= out.appendChild(el('ul'));
        inline(list.appendChild(el('li')), item[1]);
      } else {
        list = null;
        if (para) para.append(el('br'));
        else para = out.appendChild(el('p'));
        inline(para, line.replace(/^#+\s+/, ''));
      }
    }
  }
  return out;
}

// Remembered per browser. Storage can be missing or blocked, so every access is guarded.
const remember = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {}
  },
};

export function createChat({ api }) {
  const panel = $('chat');
  const toggle = $('chat-toggle');
  const log = $('chat-log');
  const form = $('chat-form');
  const input = $('chat-input');
  const send = $('chat-send');
  const clear = $('chat-clear');
  const picker = $('chat-agent');
  let chat = { busy: false, skills: [], messages: [], agent: 'builtin', agents: [], pending: null };

  const nearEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const scrollToEnd = () => (log.scrollTop = log.scrollHeight);

  // ---- open and closed ----
  // Open by default on a wide screen. Only a click is remembered, so a phone's
  // closed default never becomes a preference you did not choose.
  function setOpen(open) {
    panel.classList.toggle('closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open) scrollToEnd();
  }
  const saved = remember.get('blueprint.chat');
  setOpen(saved ? saved === 'open' : innerWidth >= 720);
  toggle.addEventListener('click', () => {
    const open = panel.classList.contains('closed');
    setOpen(open);
    remember.set('blueprint.chat', open ? 'open' : 'closed');
  });

  // ---- drawing ----
  function render() {
    const follow = nearEnd();
    log.replaceChildren();
    if (!chat.messages.length) {
      const hint = el('li', 'chat-hint');
      hint.append(el('p', '', 'Ask for a design, for example “Mock up a pricing page at desktop and phone sizes from my references.”'));
      hint.append(el('p', '', 'Pin comments on an artboard, then say “check the board”.'));
      const own = chat.agents.find((a) => a.id === chat.agent && a.id !== 'builtin');
      if (own) hint.append(el('p', '', `${own.name} runs with your own skills and connections. It asks here before it uses anything other than the board.`));
      log.append(hint);
    }
    for (const m of chat.messages) {
      const li = el('li', `chat-msg ${m.role}`);
      if (m.role === 'step') li.append(el('span', 'dot'), el('span', '', m.text));
      else if (m.role === 'agent') li.append(formatReply(m.text));
      else li.textContent = m.text;
      log.append(li);
    }
    if (chat.pending) log.append(askCard(chat.pending));
    if (chat.busy && !chat.pending) {
      const li = el('li', 'chat-msg working');
      li.append(el('span', 'live'), el('span', '', 'Working'));
      log.append(li);
    }
    panel.classList.toggle('busy', chat.busy);
    send.setAttribute('aria-label', chat.busy ? 'Stop the agent' : 'Send');
    send.title = chat.busy ? 'Stop' : 'Send';
    clear.disabled = chat.busy || !chat.messages.length;
    drawPicker();
    if (follow || chat.pending) scrollToEnd();
  }

  // ---- the agent's permission request ----
  // The agent's own wording is shown as text, and its options become buttons.
  function askCard(p) {
    const li = el('li', 'chat-msg chat-ask');
    li.setAttribute('role', 'group');
    li.setAttribute('aria-label', `${p.agent} asks for permission`);
    const line = el('p', '', `${p.agent} asks to use `);
    line.append(el('strong', '', p.title));
    li.append(line);
    if (p.detail && p.detail !== p.title) li.append(el('pre', '', p.detail));
    const choices = el('div', 'choices');
    for (const o of p.options) {
      const b = el('button', o.kind.startsWith('reject') ? 'refuse' : '', o.name);
      b.type = 'button';
      b.addEventListener('click', () => {
        for (const x of choices.querySelectorAll('button')) x.disabled = true;
        api('POST', '/api/chat/permission', { id: p.id, optionId: o.id }).catch(() => {});
      });
      choices.append(b);
    }
    li.append(choices);
    return li;
  }

  // ---- which agent ----
  function drawPicker() {
    const key = JSON.stringify([chat.agent, chat.agents]);
    if (picker.dataset.key !== key) {
      picker.dataset.key = key;
      picker.replaceChildren(
        ...chat.agents.map((a) => {
          const option = el('option', '', a.available ? a.name : `${a.name} (not found)`);
          option.value = a.id;
          option.disabled = !a.available;
          return option;
        }),
      );
      picker.value = chat.agent;
    }
    picker.hidden = chat.agents.length < 2;
    picker.disabled = chat.busy;
  }
  picker.addEventListener('change', async () => {
    try {
      chat = await api('POST', '/api/chat/agent', { agent: picker.value });
    } catch {
      picker.value = chat.agent; // api() has said why
    }
    render();
  });

  // ---- typing and sending ----
  // The box grows with what you type, up to about six lines.
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    // Enter sends, Shift+Enter starts a new line. Not while an input method is
    // composing, and not while the agent works: then the button means Stop,
    // and a habitual Enter must not stop the agent. Your text waits instead.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!chat.busy) form.requestSubmit();
    }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (chat.busy) return void api('POST', '/api/chat/stop').catch(() => {});
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    grow();
    try {
      chat = await api('POST', '/api/chat', { text });
      render();
      scrollToEnd();
    } catch {
      input.value = text; // keep what was typed if the server refused it
      grow();
    }
  });
  clear.addEventListener('click', async () => {
    if (!confirm('Start a new conversation? The agent forgets this chat. Your board stays as it is.')) return;
    chat = await api('POST', '/api/chat/clear').catch(() => chat);
    render();
    input.focus();
  });

  render();
  return {
    // The server sends the whole chat each time it changes.
    update(next) {
      chat = next;
      render();
    },
    focus() {
      setOpen(true);
      input.focus();
    },
  };
}
