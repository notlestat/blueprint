#!/usr/bin/env node
// The Blueprint server. It serves the canvas page, the JSON API, a live event
// stream and each artboard document, for one project's board.
//
//   node server.mjs --root /path/to/project [--port 4400]

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBoard, BoardError, LIMITS } from './lib/board.mjs';
import { screenshot } from './lib/screenshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const VERSION = '0.1.0';
const FIRST_PORT = 4400;
const PORT_COUNT = 10;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// The canvas page may only load its own files, and may only frame its own artboards.
const PAGE_CSP = "default-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

export async function startServer({ root, port } = {}) {
  root = path.resolve(root || process.cwd());
  const store = await openBoard(root);
  const clients = new Set(); // open event-stream responses

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Read a request body, refusing anything over the HTML limit plus a little.
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let bytes = 0;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes > LIMITS.htmlBytes + 64 * 1024) {
          reject(new BoardError(`The request is larger than the ${LIMITS.htmlBytes} byte limit (2 MB).`));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  const readJson = async (req) => {
    const raw = await readBody(req);
    try {
      const value = JSON.parse(raw || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw 0;
      return value;
    } catch {
      throw new BoardError('The request body must be a JSON object.');
    }
  };

  const send = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.onChange((board) => send('board', board));

  // ---- Agent activity: who is working on what, right now ----
  // This is kept in memory only. It is never written to board.json, because it
  // describes this moment and means nothing after a restart.
  const ACTIONS = ['looking', 'reading', 'writing', 'creating', 'resizing', 'replying', 'resolving'];
  const STALE_MS = 90_000; // an agent that says nothing for this long is dropped
  const activity = new Map(); // agentId -> { agentId, name, action, artboardId, at }
  const activityList = () => [...activity.values()];
  const short = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

  function setActivity({ agentId, name, action, artboardId, commentId, done } = {}) {
    const id = short(agentId, 64);
    if (!id) throw new BoardError('agentId must be a non-empty string.');
    if (done) activity.delete(id);
    else {
      if (!ACTIONS.includes(action)) throw new BoardError(`action must be one of: ${ACTIONS.join(', ')}.`);
      // A comment belongs to an artboard, so replying to one counts as working there.
      const viaComment = store.get().comments.find((c) => c.id === commentId)?.artboardId;
      const target = store.get().artboards.find((a) => a.id === (artboardId || viaComment));
      activity.set(id, { agentId: id, name: short(name, 40) || 'Agent', action, artboardId: target?.id || null, at: Date.now() });
    }
    send('activity', activityList());
  }
  const sweep = setInterval(() => {
    let dropped = false;
    for (const [id, a] of activity) if (Date.now() - a.at > STALE_MS) dropped = activity.delete(id);
    if (dropped) send('activity', activityList());
  }, 5000);
  sweep.unref(); // do not keep the process alive just for this timer

  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address().port;
      const allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`];
      // 1. Host check. A website that points its own domain at 127.0.0.1 sends
      //    its own name here, so this stops it reading the board.
      if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'This server only answers on 127.0.0.1.' });
      // 2. Origin check. Browsers attach Origin to requests that change data.
      //    A sandboxed artboard sends "null"; another site sends its own address.
      const origin = req.headers.origin;
      const changes = req.method !== 'GET' && req.method !== 'HEAD';
      if (changes && origin !== undefined && !allowedHosts.includes(origin.replace(/^http:\/\//, '')))
        return json(res, 403, { error: 'Requests from other pages cannot change the board.' });

      const url = new URL(req.url, `http://${req.headers.host}`);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const route = `${req.method} /${parts.map((p, i) => (i === 2 && parts[0] === 'api' ? ':id' : p)).join('/')}`;

      switch (route) {
        case 'GET /api/health':
          return json(res, 200, { ok: true, root, version: VERSION });
        case 'GET /api/board':
          return json(res, 200, store.get());
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`event: board\ndata: ${JSON.stringify(store.get())}\n\n`);
          res.write(`event: activity\ndata: ${JSON.stringify(activityList())}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        case 'GET /api/activity':
          return json(res, 200, activityList());
        case 'POST /api/activity':
          setActivity(await readJson(req));
          return json(res, 200, activityList());
        case 'POST /api/artboards':
          return json(res, 201, await store.createArtboard(await readJson(req)));
        case 'PATCH /api/artboards/:id':
          return json(res, 200, await store.updateArtboard(parts[2], await readJson(req)));
        case 'DELETE /api/artboards/:id':
          await store.deleteArtboard(parts[2]);
          return json(res, 200, { ok: true });
        case 'GET /api/artboards/:id/html': {
          const body = await store.getHtml(parts[2]);
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(body);
        }
        case 'PUT /api/artboards/:id/html':
          return json(res, 200, await store.setHtml(parts[2], await readBody(req)));
        case 'GET /api/artboards/:id/screenshot': {
          const a = store.get().artboards.find((x) => x.id === parts[2]);
          if (!a) throw new BoardError(`No artboard with id "${parts[2]}".`, 404);
          const png = await screenshot(`http://127.0.0.1:${actualPort}/artboard/${a.id}`, a.width, a.height);
          res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
          return res.end(png);
        }
        case 'POST /api/comments':
          return json(res, 201, await store.addComment(await readJson(req)));
        case 'POST /api/comments/:id/replies':
          return json(res, 201, await store.reply(parts[2], await readJson(req)));
        case 'PATCH /api/comments/:id':
          return json(res, 200, await store.setStatus(parts[2], (await readJson(req)).status));
      }

      // An artboard as a full document. The sandbox header means that even if
      // you open this address directly, its scripts cannot reach the API.
      if (req.method === 'GET' && parts[0] === 'artboard' && parts.length === 2) {
        const doc = await store.documentFor(parts[1]);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': 'sandbox allow-scripts' });
        return res.end(doc);
      }

      // Static files for the canvas page.
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC, rel);
        if (file.startsWith(PUBLIC + path.sep) && TYPES[path.extname(file)]) {
          const body = await readFile(file).catch(() => null);
          if (body) {
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)], 'cache-control': 'no-store', 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff' });
            return res.end(body);
          }
        }
      }
      return json(res, 404, { error: `Nothing at ${req.method} ${url.pathname}.` });
    } catch (err) {
      if (err instanceof BoardError) return json(res, err.status, { error: err.message });
      console.error('[blueprint]', err);
      if (!res.headersSent) json(res, 500, { error: err.message || 'Something went wrong.' });
      else res.end();
    }
  });

  // Find a port. Another project's Blueprint server may already hold 4400.
  const tryListen = (p) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  if (port !== undefined) await tryListen(port);
  else {
    let bound = false;
    for (let p = FIRST_PORT; p < FIRST_PORT + PORT_COUNT && !bound; p++) {
      try {
        await tryListen(p);
        bound = true;
      } catch (err) {
        if (err.code !== 'EADDRINUSE') throw err;
        const other = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.json()).catch(() => null);
        if (other?.root === root) throw Object.assign(new Error(`Blueprint is already running for this project on port ${p}.`), { code: 'ALREADY_RUNNING', port: p });
      }
    }
    if (!bound) throw new Error(`Ports ${FIRST_PORT} to ${FIRST_PORT + PORT_COUNT - 1} are all in use. Stop another Blueprint server and try again.`);
  }

  const actualPort = server.address().port;
  const infoFile = path.join(store.dir, 'server.json');
  await writeFile(infoFile, JSON.stringify({ port: actualPort, pid: process.pid, root }) + '\n');

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    store,
    async close() {
      clearInterval(sweep);
      for (const res of clients) res.end();
      await new Promise((r) => server.close(r));
      server.closeAllConnections?.();
      await store.flush();
      await rm(infoFile, { force: true });
    },
  };
}

// Run directly: `node server.mjs --root <project>`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  try {
    const app = await startServer({ root: arg('--root'), port: arg('--port') ? Number(arg('--port')) : undefined });
    console.log(`Blueprint is running at ${app.url}`);
    console.log(`Board: ${path.join(app.store.dir, 'board.json')}`);
    const stop = async () => {
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(err.message);
    process.exit(err.code === 'ALREADY_RUNNING' ? 0 : 1);
  }
}
