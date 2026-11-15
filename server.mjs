#!/usr/bin/env node
// The Blueprint server. It serves the canvas page, the JSON API, a live event
// stream and each artboard document, for one project's board.
//
//   node server.mjs --root /path/to/project [--port 4400]

import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBoard, BoardError, LIMITS } from './lib/board.mjs';
import { screenshot } from './lib/screenshot.mjs';
import { IMAGE_TYPES } from './lib/assets.mjs';
import { fetchPreview } from './lib/preview.mjs';
import { createAgent, DEFAULT_MODEL } from './lib/agent.mjs';
import { defaultHome, touchProject, forgetProject, isKnownProject, listProjects, runningUrl, deleteBoard } from './lib/recents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const VERSION = '0.1.0';
const FIRST_PORT = 4400;
const PORT_COUNT = 10;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

// The canvas page may only load its own files, and may only frame its own artboards.
const PAGE_CSP = "default-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

// `agentQuery` replaces the Agent SDK's query() in tests, so no test calls a model.
export async function startServer({ root, port, home = defaultHome(), previews = true, agentQuery, skillsDir } = {}) {
  root = path.resolve(root || process.cwd());
  const store = await openBoard(root);
  const clients = new Set(); // open event-stream responses

  // The built-in design agent. Its chat lives in .blueprint/chat.json; its
  // design skills come from scripts/export-skills.mjs.
  const agent = createAgent({
    root,
    dir: store.dir,
    home,
    skillsDir: skillsDir || path.join(home, 'agent-skills'),
    getBoard: () => store.get(),
    model: process.env.BLUEPRINT_MODEL || DEFAULT_MODEL,
    ...(agentQuery && { query: agentQuery }),
  });
  await agent.load();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  // Read a request body as bytes, refusing anything over `max`.
  // Past the limit, it stops keeping the bytes but keeps reading, so the
  // connection stays open long enough for the 400 and its message to arrive.
  const readBytes = (req, max, label) =>
    new Promise((resolve, reject) => {
      const tooBig = () => new BoardError(`The request is larger than the ${label} limit.`);
      if (Number(req.headers['content-length']) > max) {
        req.resume(); // drain without keeping anything
        return reject(tooBig());
      }
      const chunks = [];
      let bytes = 0;
      req.on('data', (c) => {
        bytes += c.length;
        if (bytes <= max) chunks.push(c);
      });
      req.on('end', () => (bytes > max ? reject(tooBig()) : resolve(Buffer.concat(chunks))));
      req.on('error', reject);
    });
  // Text bodies (HTML and JSON) are held to the HTML limit plus a little.
  const readBody = async (req) => (await readBytes(req, LIMITS.htmlBytes + 64 * 1024, `${LIMITS.htmlBytes} byte (2 MB)`)).toString('utf8');
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
  agent.onChange((chat) => send('chat', chat));

  // ---- Recents: add this project to the shared list, and bump it on each edit ----
  // Edits come in bursts while an agent works, so the write waits for a quiet second.
  let touchTimer = null;
  const touch = () => touchProject(home, root).catch((err) => console.error('[blueprint] could not update recents:', err.message));
  store.onChange(() => {
    clearTimeout(touchTimer);
    touchTimer = setTimeout(touch, 1000);
    touchTimer.unref();
  });

  // Open another project's board from Recents. Only folders already in the
  // list can be opened, and only if they still hold a board, so a request
  // cannot start a server in an arbitrary folder.
  async function openProject(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new BoardError('root must be an absolute folder path.');
    target = path.resolve(target);
    if (!(await isKnownProject(home, target))) throw new BoardError('That folder is not in Recents.', 404);
    if (target === root) return `http://127.0.0.1:${server.address().port}`;
    const exists = await readFile(path.join(target, '.blueprint', 'board.json')).then(() => true, () => false);
    if (!exists) throw new BoardError('That folder no longer has a Blueprint board.', 404);
    const already = await runningUrl(target);
    if (already) return already;
    spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--root', target], { detached: true, stdio: 'ignore', env: { ...process.env, BLUEPRINT_HOME: home } }).unref();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const url = await runningUrl(target);
      if (url) return url;
    }
    throw new BoardError(`The board for ${path.basename(target)} did not start within 5 seconds.`, 500);
  }

  // Delete another project's board from Recents. The same rules as opening
  // apply: only a folder already in the list. This server's own board cannot
  // be deleted from inside it, because the server would be writing into a
  // folder that had just moved.
  async function removeBoard(target) {
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new BoardError('root must be an absolute folder path.');
    target = path.resolve(target);
    if (target === root) throw new BoardError('This is the board you have open. Open another board, then delete this one from Recents.');
    if (!(await isKnownProject(home, target))) throw new BoardError('That folder is not in Recents.', 404);
    const exists = await readFile(path.join(target, '.blueprint', 'board.json')).then(() => true, () => false);
    if (!exists) throw new BoardError('That folder no longer has a Blueprint board.', 404);
    try {
      return await deleteBoard(home, target);
    } catch (err) {
      throw new BoardError(err.message, 500);
    }
  }

  // A new link card shows its host at once. The page title arrives a moment
  // later if the page can be fetched, and only if nobody has retitled it.
  function fillLinkPreview(item) {
    if (!previews || item.type !== 'link') return;
    const original = item.title;
    fetchPreview(item.url).then((p) => {
      const current = store.get().items.find((x) => x.id === item.id);
      if (!p || !current || current.title !== original) return;
      const patch = {};
      if (p.title) patch.title = p.title;
      if (p.description && !current.description) patch.description = p.description;
      if (Object.keys(patch).length) store.updateItem(item.id, patch).catch(() => {});
    });
  }

  // ---- Agent activity: who is working on what, right now ----
  // This is kept in memory only. It is never written to board.json, because it
  // describes this moment and means nothing after a restart.
  const ACTIONS = ['looking', 'reading', 'writing', 'creating', 'resizing', 'replying', 'resolving', 'noting', 'connecting'];
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
      let parts;
      try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        // A broken %-escape in the address is the caller's mistake, not a server fault.
        throw new BoardError('The address has a broken %-escape.');
      }
      const route = `${req.method} /${parts.map((p, i) => (i === 2 && parts[0] === 'api' ? ':id' : p)).join('/')}`;

      switch (route) {
        case 'GET /api/health':
          return json(res, 200, { ok: true, root, version: VERSION, pid: process.pid }); // pid lets Recents stop the right process
        case 'GET /api/board':
          return json(res, 200, store.get());
        case 'GET /api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(`event: board\ndata: ${JSON.stringify(store.get())}\n\n`);
          res.write(`event: activity\ndata: ${JSON.stringify(activityList())}\n\n`);
          res.write(`event: chat\ndata: ${JSON.stringify(agent.state())}\n\n`);
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
        case 'GET /api/activity':
          return json(res, 200, activityList());
        case 'POST /api/activity':
          setActivity(await readJson(req));
          return json(res, 200, activityList());
        case 'GET /api/chat':
          return json(res, 200, agent.state());
        case 'POST /api/chat':
          return json(res, 202, agent.send((await readJson(req)).text));
        case 'POST /api/chat/:id':
          if (parts[2] === 'stop') return json(res, 200, agent.stop());
          if (parts[2] === 'clear') return json(res, 200, await agent.clear());
          break;
        case 'POST /api/artboards':
          return json(res, 201, await store.createArtboard(await readJson(req)));
        case 'PATCH /api/artboards/:id':
          return json(res, 200, await store.updateArtboard(parts[2], await readJson(req)));
        case 'DELETE /api/artboards/:id':
          return json(res, 200, await store.deleteArtboard(parts[2]));
        case 'POST /api/restore/:id':
          return json(res, 200, await store.restore(parts[2]));
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
        case 'DELETE /api/comments/:id':
          return json(res, 200, await store.deleteComment(parts[2]));

        case 'POST /api/items': {
          const item = await store.createItem(await readJson(req));
          fillLinkPreview(item);
          return json(res, 201, item);
        }
        case 'PATCH /api/items/:id':
          return json(res, 200, await store.updateItem(parts[2], await readJson(req)));
        case 'DELETE /api/items/:id':
          return json(res, 200, await store.deleteItem(parts[2]));
        case 'POST /api/assets': {
          const bytes = await readBytes(req, LIMITS.assetBytes, `${LIMITS.assetBytes} byte (10 MB)`);
          return json(res, 201, await store.addAsset(bytes));
        }
        case 'POST /api/connectors':
          return json(res, 201, await store.createConnector(await readJson(req)));
        case 'PATCH /api/connectors/:id':
          return json(res, 200, await store.updateConnector(parts[2], await readJson(req)));
        case 'DELETE /api/connectors/:id':
          return json(res, 200, await store.deleteConnector(parts[2]));

        case 'GET /api/recents':
          return json(res, 200, { current: root, projects: await listProjects(home) });
        case 'POST /api/recents/:id':
          if (parts[2] === 'open') return json(res, 200, { url: await openProject((await readJson(req)).root) });
          if (parts[2] === 'forget') {
            await forgetProject(home, path.resolve(String((await readJson(req)).root || '')));
            return json(res, 200, { ok: true });
          }
          if (parts[2] === 'delete') return json(res, 200, { ok: true, movedTo: await removeBoard((await readJson(req)).root) });
          break;
      }

      // A reference image. It is served with its real type, no sniffing, and a
      // sandbox, so even a file that slipped past the checks cannot run as a page.
      if (req.method === 'GET' && parts[0] === 'assets' && parts.length === 2) {
        const file = store.assetPath(parts[1]);
        const body = await readFile(file).catch(() => null);
        if (!body) throw new BoardError(`No asset named "${parts[1]}".`, 404);
        res.writeHead(200, {
          'content-type': IMAGE_TYPES[path.extname(file).slice(1)],
          'cache-control': 'private, max-age=31536000, immutable', // the name is a hash of the content
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
        });
        return res.end(body);
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
  await touch();

  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    store,
    agent,
    async close() {
      clearInterval(sweep);
      await agent.close();
      clearTimeout(touchTimer);
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
