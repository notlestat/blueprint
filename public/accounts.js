// Accounts: sign the user's own agents (Claude Code, Codex) in and out. The
// server runs each agent's own CLI for this; the account state arrives with
// the chat state on the event stream, so this file only draws it and sends
// what the user chooses.

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, onClick, className = '') => {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
};

export function createAccounts({ api }) {
  const dialog = $('accounts');
  const list = $('accounts-list');
  let agents = [];
  const keyOpen = new Set(); // agents whose API key field is showing

  const post = (path, body) => api('POST', path, body).catch(() => {}); // api() has said why

  function status(a) {
    const s = a.account;
    if (!a.available) return `Not found on this computer. Install ${a.name}, or set ${a.id === 'claude' ? 'BLUEPRINT_CLAUDE' : 'BLUEPRINT_CODEX'} to its path.`;
    if (a.signingIn) return 'Finish signing in in your browser.';
    if (!s) return 'Checking…';
    if (!s.signedIn) return 'Not signed in.';
    return ['Signed in', s.method && `with ${s.method}`, s.email && `as ${s.email}`, s.plan && `(${s.plan})`].filter(Boolean).join(' ');
  }

  function row(a) {
    const li = el('li', 'account');
    const head = el('div', 'account-head');
    head.append(el('strong', '', a.name), el('span', `account-state${a.account?.signedIn ? ' on' : ''}`, a.account?.signedIn ? 'Signed in' : a.signingIn ? 'Signing in' : a.available ? 'Signed out' : 'Not found'));
    li.append(head, el('p', 'account-status', status(a)));
    if (a.id === 'claude') li.append(el('p', 'account-note', 'The built-in agent uses this sign-in too.'));
    if (a.account?.error && !a.signingIn) li.append(el('p', 'account-error', a.account.error));

    const actions = el('div', 'account-actions');
    if (a.signingIn) {
      // Only an https address from the CLI becomes a link.
      if (a.signingIn.url?.startsWith('https://')) {
        const link = el('a', 'account-link', 'Open the sign-in page');
        link.href = a.signingIn.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        actions.append(link);
      }
      actions.append(button('Cancel', () => post(`/api/accounts/${a.id}/cancel`), 'quiet'));
    } else if (a.account?.signedIn) {
      actions.append(
        button('Sign out', () => {
          if (confirm(`Sign out of ${a.name}? This also signs you out of ${a.name} in your terminal. Your skills and settings stay.`)) post(`/api/accounts/${a.id}/logout`);
        }, 'quiet'),
      );
    } else if (a.available) {
      for (const m of a.methods) {
        if (!m.key) actions.append(button(`Sign in with ${m.name}`, () => post(`/api/accounts/${a.id}/login`, { method: m.id })));
        else if (!keyOpen.has(a.id)) actions.append(button(`Use an ${m.name}`, () => (keyOpen.add(a.id), draw()), 'quiet'));
      }
      const keyMethod = a.methods.find((m) => m.key);
      if (keyMethod && keyOpen.has(a.id)) li.append(keyForm(a, keyMethod));
    }
    li.append(actions);
    return li;
  }

  // The key goes to the server once, which passes it to the CLI. It is not
  // kept in the page: the field is cleared as soon as it is sent.
  function keyForm(a, method) {
    const form = el('form', 'account-key');
    const input = el('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = method.name;
    input.setAttribute('aria-label', method.name);
    const save = el('button', '', 'Save');
    save.type = 'submit';
    form.append(input, save, button('Cancel', () => (keyOpen.delete(a.id), draw()), 'quiet'));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const key = input.value;
      input.value = '';
      keyOpen.delete(a.id);
      // Move focus off the field first: draw() holds back while a key field has focus.
      $('accounts-close').focus();
      draw();
      post(`/api/accounts/${a.id}/login`, { method: method.id, key });
    });
    queueMicrotask(() => input.focus());
    return form;
  }

  function draw() {
    if (!dialog.open) return;
    // Redrawing would wipe a key being typed, so wait until it is sent.
    if (dialog.contains(document.activeElement) && document.activeElement.type === 'password') return;
    list.replaceChildren(...agents.filter((a) => a.id !== 'builtin').map(row));
  }

  $('accounts-open').addEventListener('click', () => {
    dialog.showModal();
    draw();
    api('GET', '/api/accounts').catch(() => {}); // read the status again; the chat state brings it back
  });
  $('accounts-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => keyOpen.clear());

  return {
    update(chatState) {
      agents = chatState.agents || [];
      draw();
    },
  };
}
