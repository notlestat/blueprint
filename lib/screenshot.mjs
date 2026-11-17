// Captures one URL as a PNG at an exact pixel size.
//
// In the desktop app, the app's own browser engine takes the picture. The app
// runs a small capture service and passes its address, with a secret in the
// path, to every server it starts in BLUEPRINT_CAPTURE.
//
// From a terminal there is no such service, so this uses the Chrome that is
// already installed. Chrome's --screenshot flag cannot go narrower than 500px,
// so this talks to Chrome over its DevTools protocol, which can set any size.

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  process.env.BLUEPRINT_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

export async function screenshot(url, width, height, { timeoutMs = 20000, service = process.env.BLUEPRINT_CAPTURE } = {}) {
  if (service) {
    const png = await viaService(service, url, width, height, timeoutMs);
    if (png) return png;
  }
  return viaChrome(url, width, height, timeoutMs);
}

// Ask the desktop app for the picture. Returns null when the app cannot be
// reached, or when another program now answers on its old port (404): a board
// server keeps running after the app quits, and then falls back to Chrome.
// An error from a running app is passed on as it is.
async function viaService(service, url, width, height, timeoutMs) {
  let res;
  try {
    res = await fetch(service, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, width, height }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('The screenshot took too long.');
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `The desktop app could not take the screenshot (${res.status}).`);
  return Buffer.from(await res.arrayBuffer());
}

async function viaChrome(url, width, height, timeoutMs) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Screenshots need Google Chrome. Install it, or set BLUEPRINT_CHROME to its path.');

  const profile = await mkdtemp(path.join(tmpdir(), 'blueprint-chrome-'));
  const child = spawn(chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let ws;
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    // Chrome prints the address of its control socket on stderr.
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      child.stderr.on('data', (chunk) => {
        buf += chunk;
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) resolve(m[1]);
      });
      child.on('exit', () => reject(new Error('Chrome closed before the screenshot was taken.')));
      child.on('error', reject);
    });

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('Could not connect to Chrome.')), { once: true });
    });

    // A tiny request/response layer: each command gets a number, and the reply
    // carries the same number back.
    let nextId = 1;
    const pending = new Map();
    const waiters = [];
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const w of waiters.filter((w) => w.method === msg.method)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    const waitFor = (method) => new Promise((resolve) => waiters.push({ method, resolve }));

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.enable', {}, sessionId);
    const loaded = waitFor('Page.loadEventFired');
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    await new Promise((r) => setTimeout(r, 400)); // let web fonts and first paint settle
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width, height, scale: 1 },
    }, sessionId);
    return Buffer.from(data, 'base64');
  } finally {
    clearTimeout(timer);
    try { ws?.close(); } catch {}
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
