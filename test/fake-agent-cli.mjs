#!/usr/bin/env node
// A stand-in for the `claude` and `codex` CLIs' sign-in commands, for
// test/accounts.test.mjs. It keeps its signed-in state in a file in
// FAKE_STATE, and plays `claude` unless FAKE_KIND is "codex".
//
// A browser sign-in prints a sign-in page address, then finishes when the
// test writes "approved" into FAKE_STATE, the way a browser would.

import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const dir = process.env.FAKE_STATE;
const state = path.join(dir, `signed-in-${process.env.FAKE_KIND === 'codex' ? 'codex' : 'claude'}`);
const args = process.argv.slice(2).join(' ');
const signedIn = existsSync(state) ? readFileSync(state, 'utf8') : null;
const stdin = () => readFileSync(0, 'utf8').trim();

function waitForBrowser(as) {
  console.log('Opening your browser to sign in.');
  console.log('If it did not open, go to: https://example.com/oauth/authorize?client=fake&redirect_uri=http://localhost:5454/callback');
  console.log('Waiting for http://localhost:5454/callback ...');
  const timer = setInterval(() => {
    if (existsSync(path.join(dir, 'approved'))) {
      clearInterval(timer);
      writeFileSync(state, as);
      process.exit(0);
    }
  }, 50);
}

if (process.env.FAKE_KIND === 'codex') {
  if (args === 'login status') {
    console.log(signedIn ? `Logged in using ${signedIn}` : 'Not logged in');
    process.exit(signedIn ? 0 : 1);
  } else if (args === 'login --with-api-key') {
    const key = stdin();
    if (key !== 'sk-good') {
      console.error('Error: the API key was rejected.');
      process.exit(1);
    }
    writeFileSync(state, 'an API key');
  } else if (args === 'login') waitForBrowser('ChatGPT');
  else if (args === 'logout') rmSync(state, { force: true });
} else {
  if (args === 'auth status --json') {
    const s = signedIn ? { loggedIn: true, authMethod: signedIn, email: 'person@example.com', subscriptionType: 'pro' } : { loggedIn: false, authMethod: 'none' };
    console.log(JSON.stringify(s, null, 2));
    process.exit(signedIn ? 0 : 1);
  } else if (args === 'auth login --claudeai') waitForBrowser('claude.ai');
  else if (args === 'auth login --console') waitForBrowser('console');
  else if (args === 'auth logout') rmSync(state, { force: true });
}
