// Captures one URL as a PNG at an exact pixel size, using the Chrome that is
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

export async function screenshot(url, width, height, { timeoutMs = 20000 } = {}) {
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
