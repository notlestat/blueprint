// Signing the user's own agents in and out, through a fake CLI
// (test/fake-agent-cli.mjs), so no real account is touched.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent } from '../lib/agent.mjs';
import { signInUrl, accountStatus } from '../lib/accounts.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-agent-cli.mjs');
let agent, root, bin;

// One fake CLI per agent: a small wrapper that sets which agent it plays.
async function fakeCli(kind) {
  const file = path.join(bin, kind);
  await writeFile(file, `#!/bin/sh\nFAKE_KIND=${kind} exec node ${JSON.stringify(FAKE)} "$@"\n`);
  await chmod(file, 0o755);
  return file;
}

const until = (check, ms = 8000) =>
  new Promise((resolve, reject) => {
    if (check(agent.state())) return resolve(agent.state());
    const timer = setTimeout(() => (off(), reject(new Error('Timed out waiting for the chat state.'))), ms);
    const off = agent.onChange((s) => {
      if (check(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
const own = (s, id) => s.agents.find((a) => a.id === id);

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'blueprint-accounts-'));
  bin = path.join(root, 'bin');
  await mkdir(bin);
  await mkdir(path.join(root, '.blueprint'));
  await mkdir(path.join(root, 'state'));
  process.env.FAKE_STATE = path.join(root, 'state');
  const clis = { claude: await fakeCli('claude'), codex: await fakeCli('codex') };
  agent = createAgent({ root, dir: path.join(root, '.blueprint'), home: root, skillsDir: path.join(root, 'skills'), findCli: async (name) => clis[name] || null });
  await agent.load();
  await agent.accountsRead();
});
after(async () => {
  delete process.env.FAKE_STATE;
  await agent.close();
});

test('each own agent starts signed out, with its sign-in methods listed', () => {
  const s = agent.state();
  assert.equal(own(s, 'claude').account.signedIn, false);
  assert.equal(own(s, 'codex').account.signedIn, false);
  assert.deepEqual(own(s, 'claude').methods.map((m) => m.id), ['claudeai', 'console']);
  assert.deepEqual(own(s, 'codex').methods.map((m) => [m.id, m.key]), [['chatgpt', false], ['api-key', true]]);
  assert.equal(own(s, 'builtin').methods, undefined);
});

test('a browser sign-in shows the sign-in page, then the account once the browser finishes', async () => {
  agent.signIn('claude', 'claudeai');
  const waiting = await until((s) => own(s, 'claude').signingIn?.url);
  assert.equal(own(waiting, 'claude').signingIn.url, 'https://example.com/oauth/authorize?client=fake&redirect_uri=http://localhost:5454/callback');
  assert.throws(() => agent.signIn('claude', 'claudeai'), /already signing in/);

  await writeFile(path.join(root, 'state', 'approved'), '');
  const done = await until((s) => !own(s, 'claude').signingIn && own(s, 'claude').account?.signedIn);
  assert.deepEqual(own(done, 'claude').account, { signedIn: true, method: 'Claude subscription', email: 'person@example.com', plan: 'pro' });
});

test('signing out reads the status again', async () => {
  await agent.signOut('claude');
  assert.equal(own(agent.state(), 'claude').account.signedIn, false);
});

test('a rejected API key shows the reason, and the key appears nowhere in the state', async () => {
  agent.signIn('codex', 'api-key', 'sk-bad-secret');
  const failed = await until((s) => !own(s, 'codex').signingIn && own(s, 'codex').account?.error);
  assert.equal(own(failed, 'codex').account.error, 'Error: the API key was rejected.');
  assert.equal(JSON.stringify(failed).includes('sk-bad-secret'), false);
});

test('a good API key signs Codex in', async () => {
  agent.signIn('codex', 'api-key', 'sk-good');
  const done = await until((s) => !own(s, 'codex').signingIn && own(s, 'codex').account?.signedIn);
  assert.equal(own(done, 'codex').account.method, 'API key');
});

test('bad requests are refused before anything runs', () => {
  assert.throws(() => agent.signIn('codex', 'api-key', '  '), /Paste the API key first/);
  assert.throws(() => agent.signIn('codex', 'magic'), /must be one of: chatgpt, api-key/);
  assert.throws(() => agent.signIn('builtin', 'claudeai'), /agent must be one of: claude, codex/);
});

test('a sign-in can be cancelled', async () => {
  await agent.signOut('codex');
  const { rm } = await import('node:fs/promises');
  await rm(path.join(root, 'state', 'approved'), { force: true });
  agent.signIn('codex', 'chatgpt');
  await until((s) => own(s, 'codex').signingIn?.url);
  agent.cancelSignIn('codex');
  const s = await until((x) => !own(x, 'codex').signingIn);
  assert.equal(own(s, 'codex').account.signedIn, false);
  assert.match(own(s, 'codex').account.error, /cancelled/);
});

test('signInUrl skips the CLI callback server on localhost', () => {
  assert.equal(signInUrl('Listening on https://localhost:1455/cb\nOpen https://auth.example.com/x?y=1 to sign in'), 'https://auth.example.com/x?y=1');
  assert.equal(signInUrl('no address here'), null);
});

test('accountStatus reports a CLI that cannot run instead of throwing', async () => {
  const s = await accountStatus('claude', path.join(root, 'missing-cli'));
  assert.equal(s.signedIn, false);
  assert.ok(s.error);
});
