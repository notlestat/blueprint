// Sign-in for the user's own agents, through each agent's own CLI.
//
// Blueprint keeps no password, token or key. Each CLI signs in the way it
// always does and stores its credentials where it always does: Claude Code in
// the macOS Keychain, Codex in ~/.codex. So signing in here also signs in the
// terminal, and the agent keeps the user's skills, MCP servers and settings,
// which are files on disk that a sign-in never touches.

import { spawn } from 'node:child_process';
import { agentEnv } from './acp.mjs';

// How each agent can sign in. `key` means the method reads a key, which is
// passed to the CLI on stdin and never written anywhere by Blueprint.
export const METHODS = {
  claude: [
    { id: 'claudeai', name: 'Claude subscription', args: ['auth', 'login', '--claudeai'] },
    { id: 'console', name: 'Anthropic Console (API billing)', args: ['auth', 'login', '--console'] },
  ],
  codex: [
    { id: 'chatgpt', name: 'ChatGPT account', args: ['login'] },
    { id: 'api-key', name: 'OpenAI API key', args: ['login', '--with-api-key'], key: true },
  ],
};
const STATUS = { claude: ['auth', 'status', '--json'], codex: ['login', 'status'] };
const LOGOUT = { claude: ['auth', 'logout'], codex: ['logout'] };
const SIGN_IN_MS = 5 * 60_000; // a browser sign-in left open is given up after this

// Run a CLI to its end and return its exit code and output.
function run(cli, args, { input, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cli, args, { env: agentEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => resolve({ code: -1, out: err.message }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
    child.stdin.end(input ?? '');
  });
}

const CLAUDE_METHOD = { 'claude.ai': 'Claude subscription', console: 'Anthropic Console', apiKey: 'API key' };

// Who the agent is signed in as. Returns { signedIn, method, email, plan }.
export async function accountStatus(kind, cli) {
  const { code, out } = await run(cli, STATUS[kind]);
  if (kind === 'claude') {
    let s = null;
    try {
      s = JSON.parse(out.slice(out.indexOf('{')));
    } catch {}
    if (!s) return { signedIn: false, method: null, email: null, plan: null, error: out.trim().split('\n').pop() || 'Could not read the sign-in status.' };
    return { signedIn: !!s.loggedIn, method: CLAUDE_METHOD[s.authMethod] || (s.loggedIn ? s.authMethod : null), email: s.email || null, plan: s.subscriptionType || null };
  }
  const using = out.match(/Logged in using (.+)/i);
  return { signedIn: code === 0 && !!using, method: using ? using[1].trim().replace(/^an? /i, '') : null, email: null, plan: null };
}

// The first address in the CLI's output that a person should open: the
// sign-in page. The CLI's own callback server on localhost is not it.
export const signInUrl = (text) => (text.match(/https:\/\/[^\s"'<>]+/g) || []).find((u) => !/^https:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u)) || null;

// Start signing in. The CLI opens the browser itself; `onUrl` gets the
// sign-in page's address too, for when the browser did not open. Returns
// { done, cancel }; `done` resolves to { ok, message }.
export function signIn(kind, cli, methodId, { key, onUrl = () => {} } = {}) {
  const method = METHODS[kind].find((m) => m.id === methodId);
  if (!method) throw new Error(`Sign-in method must be one of: ${METHODS[kind].map((m) => m.id).join(', ')}.`);
  if (method.key && !(typeof key === 'string' && key.trim())) throw new Error('Paste the API key first.');

  const child = spawn(cli, method.args, { env: agentEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let sent = false;
  const read = (d) => {
    out = (out + d).slice(-8000);
    const url = !sent && signInUrl(out);
    if (url) {
      sent = true;
      onUrl(url);
    }
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  child.stdin.end(method.key ? `${key.trim()}\n` : '');
  const timer = setTimeout(() => child.kill(), SIGN_IN_MS);
  const done = new Promise((resolve) => {
    child.on('error', (err) => resolve({ ok: false, message: err.message }));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, message: '' });
      else if (signal) resolve({ ok: false, message: 'Signing in was cancelled or took too long.' });
      // The CLI's last line says why. A key is never in it: it went to stdin.
      else resolve({ ok: false, message: out.trim().split('\n').pop() || `Signing in failed (exit code ${code}).` });
    });
  });
  return { done, cancel: () => child.kill() };
}

export async function signOut(kind, cli) {
  const { code, out } = await run(cli, LOGOUT[kind]);
  if (code !== 0) throw new Error(out.trim().split('\n').pop() || `Signing out failed (exit code ${code}).`);
}
