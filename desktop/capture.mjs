// The desktop app's screenshot service. Board servers ask it for a picture of
// an artboard, and it renders the page in a hidden window with the app's own
// browser engine. This is why the app does not need Google Chrome.
//
// Board servers are separate processes, so they reach this over HTTP. Three
// things keep other programs out: it listens on 127.0.0.1 only, the path holds
// a random secret that only processes started by the app are given, and it
// renders artboard pages on 127.0.0.1 and nothing else.

import http from 'node:http';
import { randomBytes } from 'node:crypto';

const ARTBOARD = /^http:\/\/127\.0\.0\.1:\d{2,5}\/artboard\/[A-Za-z0-9_-]{1,64}$/;
const MAX_SIDE = 4000;
const TIMEOUT_MS = 20000;
const SETTLE_MS = 400; // let web fonts and first paint settle, as the Chrome path does

export async function capture(url, width, height) {
  // Loaded here, not at the top, so tests can load this file under plain Node.
  const { BrowserWindow } = await import('electron');
  // Offscreen rendering draws into memory instead of onto the screen, so a
  // page taller than the display is not cut to fit it.
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'blueprint-capture' },
  });
  win.webContents.setAudioMuted(true);
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The artboard took more than 20 seconds to load.')), TIMEOUT_MS);
    });
    await Promise.race([win.loadURL(url), timeout]);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    let image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
    // On a Retina display the picture comes back at twice the size. The agent
    // expects one image pixel per CSS pixel, as Chrome gives.
    const size = image.getSize();
    if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'best' });
    return image.toPNG();
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}

const readJson = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4096) req.destroy(new Error('too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('The request body must be JSON.'));
      }
    });
    req.on('error', reject);
  });

const side = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_SIDE;

// Start the service. Returns its address, secret included, for BLUEPRINT_CAPTURE.
export async function startCaptureService({ render = capture } = {}) {
  const secret = randomBytes(24).toString('hex');
  const reply = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== `/${secret}`) return reply(res, 404, { error: 'Not found.' });
    try {
      const { url, width, height } = await readJson(req);
      if (typeof url !== 'string' || !ARTBOARD.test(url)) return reply(res, 400, { error: 'Only Blueprint artboards on 127.0.0.1 can be captured.' });
      if (!side(width) || !side(height)) return reply(res, 400, { error: `width and height must be whole numbers from 1 to ${MAX_SIDE}.` });
      const png = await render(url, width, height);
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(png);
    } catch (err) {
      if (!res.headersSent) reply(res, 500, { error: err.message || 'The screenshot failed.' });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/${secret}`,
    close: () => new Promise((r) => server.close(r)),
  };
}
