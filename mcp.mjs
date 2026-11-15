#!/usr/bin/env node
// The MCP server. This is what an agent talks to. Each tool is a small HTTP
// call to server.mjs, which is the only program that writes the board.
//
// The agent starts this in the project it is working on. That folder (or
// BLUEPRINT_ROOT) decides which board is used.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.BLUEPRINT_ROOT || process.cwd());

// ---- find the server for this project, or start one ----

let baseUrl = null;

async function healthy(port) {
  const h = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
    .then((r) => r.json())
    .catch(() => null);
  return h?.root === ROOT;
}

async function recordedPort() {
  const info = await readFile(path.join(ROOT, '.blueprint', 'server.json'), 'utf8').then(JSON.parse).catch(() => null);
  return Number.isInteger(info?.port) ? info.port : null;
}

async function ensureServer() {
  if (baseUrl && (await healthy(Number(new URL(baseUrl).port)))) return baseUrl;
  let port = await recordedPort();
  if (!port || !(await healthy(port))) {
    // Start the server detached, so it keeps running after this agent session ends.
    spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--root', ROOT], { detached: true, stdio: 'ignore' }).unref();
    const deadline = Date.now() + 5000;
    port = null;
    while (Date.now() < deadline && !port) {
      await new Promise((r) => setTimeout(r, 150));
      const p = await recordedPort();
      if (p && (await healthy(p))) port = p;
    }
    if (!port) throw new Error(`Blueprint's server did not start within 5 seconds. Run "node ${path.join(HERE, 'server.mjs')} --root ${ROOT}" to see why.`);
  }
  baseUrl = `http://127.0.0.1:${port}`;
  return baseUrl;
}

async function call(method, route, body) {
  const base = await ensureServer();
  const isText = typeof body === 'string';
  const isBytes = Buffer.isBuffer(body);
  const type = isBytes ? 'application/octet-stream' : isText ? 'text/plain' : 'application/json';
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': type },
    body: body === undefined ? undefined : isText || isBytes ? body : JSON.stringify(body),
  });
  const got = res.headers.get('content-type') || '';
  if (got.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
  const data = got.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Blueprint answered ${res.status}.`);
  return data;
}

// ---- activity: tell the board what this agent is doing, so the user can watch ----

// One id per agent session. Two agents on one board show up as two workers.
const AGENT_ID = randomUUID();
// The client tells us its name when it connects, for example "claude-code".
// Blueprint's own chat agent runs Claude Code too, so it names itself instead.
function agentName() {
  if (process.env.BLUEPRINT_AGENT_NAME) return process.env.BLUEPRINT_AGENT_NAME.slice(0, 40);
  const raw = server.server.getClientVersion()?.name || 'Agent';
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
// Reporting must never break a tool, so every failure here is swallowed.
const report = (fields) => call('POST', '/api/activity', { agentId: AGENT_ID, name: agentName(), ...fields }).catch(() => {});

// ---- tool results ----

const ok = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
// Wrap a handler so a failure comes back as a readable tool error, not a crash.
// `action` is the verb the board shows while this tool runs.
const tool = (action, fn) => async (args = {}) => {
  try {
    if (action) await report({ action, artboardId: args.artboardId, commentId: args.commentId });
    return await fn(args);
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: err.message }] };
  }
};

const artboardId = z.string().describe('Artboard id, like "ab_k3f9". get_board lists them.');
const commentId = z.string().describe('Comment id, like "c_p81x". list_comments lists them.');
const itemId = z.string().describe('Note or reference id, like "it_m2q8". get_board lists them.');
const HTML_HELP =
  'A full HTML document or a fragment. Put CSS in a <style> tag. The artboard is a fixed-size window, so design for its width and height. Scripts run in a sandbox. To show a reference image from the board, use its src from get_board, like <img src="/assets/1a2b3c4d5e6f7a8b.png">.';
const PLACE_HELP = {
  near: z.string().optional().describe('Put it to the right of this artboard, note or reference id. Ignored when x and y are given.'),
  x: z.number().optional().describe('Board pixels. Give x and y together.'),
  y: z.number().optional().describe('Board pixels. Give x and y together.'),
};

// How get_board describes a note or reference to the agent.
function describeItem(i) {
  const base = { id: i.id, type: i.type, x: i.x, y: i.y, width: i.width, author: i.author };
  if (i.type === 'note' || i.type === 'code') return { ...base, text: i.text };
  if (i.type === 'link') return { ...base, url: i.url, title: i.title, description: i.description || undefined };
  return { ...base, height: i.height, src: `/assets/${i.asset}`, title: i.title || undefined };
}

const server = new McpServer(
  { name: 'blueprint', version: '0.1.0' },
  {
    instructions:
      'Blueprint is a whiteboard the user is watching live. They see which artboard you are working on. Before designing, call get_board and read the notes, references and arrows the user placed: they are the brief. Build a large design in a few write_html calls (structure first, then detail) so they can watch it take shape. When you have finished a piece of work, call finish_working so the board stops showing you as busy.',
  },
);

server.registerTool(
  'get_board',
  {
    description:
      'Start here. Returns the board URL the user has open, every artboard (id, name, size, position) and its open comment count, the notes and references (images and links) on the board, and the arrows between things. Notes, references and arrows are the user\'s brief: read them before designing, and call get_reference to see an image.',
    inputSchema: {},
  },
  tool('looking', async () => {
    const board = await call('GET', '/api/board');
    return ok({
      url: baseUrl,
      root: ROOT,
      artboards: board.artboards.map((a) => ({
        id: a.id,
        name: a.name,
        width: a.width,
        height: a.height,
        x: a.x,
        y: a.y,
        openComments: board.comments.filter((c) => c.artboardId === a.id && c.status === 'open').length,
      })),
      openComments: board.comments.filter((c) => c.status === 'open').length,
      // What the user put on the board beside the artboards. Treat these as the brief.
      notes: (board.items || []).filter((i) => i.type === 'note').map(describeItem),
      // Code cards, images and links. A code card's text is code the user pasted.
      references: (board.items || []).filter((i) => i.type !== 'note').map(describeItem),
      arrows: (board.connectors || []).map((c) => ({ id: c.id, from: c.from, to: c.to, label: c.label || undefined })),
    });
  }),
);

server.registerTool(
  'create_artboard',
  {
    description:
      'Add an artboard to the board. Defaults to 1440 by 900 (desktop). Use 390 by 844 for a phone. It is placed to the right of the others.',
    inputSchema: {
      name: z.string().describe('Short name the user sees, like "Pricing / desktop".'),
      width: z.number().optional().describe('Pixels, 100 to 4000. Default 1440.'),
      height: z.number().optional().describe('Pixels, 100 to 4000. Default 900.'),
      html: z.string().optional().describe(HTML_HELP),
    },
  },
  tool('creating', async (args) => {
    const a = await call('POST', '/api/artboards', args);
    await report({ action: 'creating', artboardId: a.id }); // now that it exists, point at it
    return ok(`Created artboard ${a.id} "${a.name}" (${a.width} by ${a.height}). The user can see it at ${baseUrl}`);
  }),
);

server.registerTool(
  'write_html',
  {
    description: 'Replace the whole HTML of an artboard. The user sees the change at once. Call get_html first if you only mean to change part of it.',
    inputSchema: { artboardId, html: z.string().describe(HTML_HELP) },
  },
  tool('writing', async ({ artboardId: id, html }) => {
    const a = await call('PUT', `/api/artboards/${encodeURIComponent(id)}/html`, html);
    return ok(`Updated "${a.name}". Call get_screenshot to check how it looks.`);
  }),
);

server.registerTool(
  'get_html',
  { description: 'Read the stored HTML of an artboard.', inputSchema: { artboardId } },
  tool('reading', async ({ artboardId: id }) => ok(await call('GET', `/api/artboards/${encodeURIComponent(id)}/html`))),
);

server.registerTool(
  'update_artboard',
  {
    description: 'Rename or resize an artboard. Does not change its HTML.',
    inputSchema: {
      artboardId,
      name: z.string().optional(),
      width: z.number().optional().describe('Pixels, 100 to 4000.'),
      height: z.number().optional().describe('Pixels, 100 to 4000.'),
    },
  },
  tool('resizing', async ({ artboardId: id, ...patch }) => ok(await call('PATCH', `/api/artboards/${encodeURIComponent(id)}`, patch))),
);

server.registerTool(
  'delete_artboard',
  {
    description: 'Remove an artboard and its comments from the board. Its HTML file is kept in .blueprint/trash/. Only do this when the user asks.',
    inputSchema: { artboardId },
  },
  tool(null, async ({ artboardId: id }) => {
    await call('DELETE', `/api/artboards/${encodeURIComponent(id)}`);
    return ok(`Deleted ${id}. Its HTML is in .blueprint/trash/.`);
  }),
);

server.registerTool(
  'get_screenshot',
  {
    description: 'Render an artboard to a PNG at its own size, so you can see your work. Use it after write_html. Needs Google Chrome.',
    inputSchema: { artboardId },
  },
  tool('looking', async ({ artboardId: id }) => {
    const png = await call('GET', `/api/artboards/${encodeURIComponent(id)}/screenshot`);
    return { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] };
  }),
);

server.registerTool(
  'list_comments',
  {
    description:
      'Read the comments the user pinned on the board. Each has a position (x, y in artboard pixels), the element it points at when known (target), and the whole thread. Call this when the user says to check the board.',
    inputSchema: {
      status: z.enum(['open', 'resolved', 'all']).optional().describe('Default "open".'),
      artboardId: artboardId.optional(),
    },
  },
  tool('reading', async ({ status = 'open', artboardId: id }) => {
    const board = await call('GET', '/api/board');
    const names = new Map(board.artboards.map((a) => [a.id, a.name]));
    const list = board.comments
      .map((c, i) => ({ number: i + 1, ...c, artboard: names.get(c.artboardId) }))
      .filter((c) => (status === 'all' || c.status === status) && (!id || c.artboardId === id));
    return ok(list.length ? list : `No ${status === 'all' ? '' : status + ' '}comments.`);
  }),
);

server.registerTool(
  'reply_to_comment',
  {
    description: 'Answer a comment, as the agent. Say what you changed in one or two plain sentences. Leave resolving to the user unless they asked you to resolve.',
    inputSchema: { commentId, text: z.string().describe('Up to 4000 characters.') },
  },
  tool('replying', async ({ commentId: id, text }) => {
    await call('POST', `/api/comments/${encodeURIComponent(id)}/replies`, { author: 'agent', text });
    return ok('Reply added.');
  }),
);

server.registerTool(
  'resolve_comment',
  { description: 'Mark a comment as resolved.', inputSchema: { commentId } },
  tool('resolving', async ({ commentId: id }) => {
    await call('PATCH', `/api/comments/${encodeURIComponent(id)}`, { status: 'resolved' });
    return ok('Comment resolved.');
  }),
);

server.registerTool(
  'get_reference',
  {
    description:
      'Read one note or reference in full. For an image this returns the picture itself, so you can see the reference the user placed. For a link it returns the address, title and description. It does not fetch the linked page.',
    inputSchema: { itemId },
  },
  tool('looking', async ({ itemId: id }) => {
    const board = await call('GET', '/api/board');
    const item = (board.items || []).find((i) => i.id === id);
    if (!item) throw new Error(`No note or reference with id "${id}". get_board lists them.`);
    const arrows = (board.connectors || []).filter((c) => c.from === id || c.to === id);
    const info = { ...describeItem(item), arrows: arrows.map((c) => ({ from: c.from, to: c.to, label: c.label || undefined })) };
    if (item.type !== 'image') return ok(info);
    const bytes = await call('GET', `/assets/${encodeURIComponent(item.asset)}`);
    const mimeType = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[item.asset.split('.').pop()];
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }, { type: 'image', data: bytes.toString('base64'), mimeType }] };
  }),
);

server.registerTool(
  'add_note',
  {
    description:
      'Put a text note on the board, for example the reasoning behind a design, a question for the user, or a list of options. Set code to true for a snippet of code. Use near to put it beside the artboard it is about. Keep notes short.',
    inputSchema: {
      text: z.string().describe('Plain text, up to 10,000 characters. Line breaks are kept.'),
      code: z.boolean().optional().describe('Show the text as code: a fixed-width font with spacing kept. Default false.'),
      width: z.number().optional().describe('Pixels, 80 to 2000. Default 240, or 440 for code.'),
      ...PLACE_HELP,
    },
  },
  tool('noting', async ({ text, code, width, near, x, y }) => {
    const n = await call('POST', '/api/items', { type: code ? 'code' : 'note', text, width, near, x, y, author: 'agent' });
    return ok(`Added ${code ? 'code card' : 'note'} ${n.id} at (${n.x}, ${n.y}).`);
  }),
);

server.registerTool(
  'add_reference',
  {
    description:
      'Put a reference on the board: an image file from this machine (path) or a web link (url). Give exactly one of path or url. Use it to show the user material you are drawing on.',
    inputSchema: {
      path: z.string().optional().describe('An image file: PNG, JPEG, GIF or WebP, up to 10 MB. Absolute, or relative to the project folder.'),
      url: z.string().optional().describe('An http or https address. The board shows it as a link card.'),
      title: z.string().optional().describe('A short caption. Links default to the page title or host.'),
      width: z.number().optional().describe('Pixels, 80 to 2000.'),
      ...PLACE_HELP,
    },
  },
  tool('noting', async ({ path: file, url, title, width, near, x, y }) => {
    if (!file === !url) throw new Error('Give exactly one of path or url.');
    if (url) {
      const l = await call('POST', '/api/items', { type: 'link', url, title, width, near, x, y, author: 'agent' });
      return ok(`Added link ${l.id} "${l.title}" at (${l.x}, ${l.y}).`);
    }
    const bytes = await readFile(path.resolve(ROOT, file)).catch((err) => {
      throw new Error(`Could not read ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}.`);
    });
    const { asset } = await call('POST', '/api/assets', bytes);
    const img = await call('POST', '/api/items', { type: 'image', asset, title, width, near, x, y, author: 'agent' });
    return ok(`Added image ${img.id} at (${img.x}, ${img.y}), ${img.width} by ${img.height}. Use src "/assets/${asset}" to show it in an artboard.`);
  }),
);

server.registerTool(
  'connect',
  {
    description: 'Draw an arrow from one thing on the board to another: artboards, notes or references. Use it to show which reference an artboard draws on, or the order of screens in a flow.',
    inputSchema: {
      from: z.string().describe('Artboard, note or reference id where the arrow starts.'),
      to: z.string().describe('Artboard, note or reference id the arrow points at.'),
      label: z.string().optional().describe('A few words shown on the arrow, up to 200 characters.'),
    },
  },
  tool('connecting', async ({ from, to, label }) => {
    const c = await call('POST', '/api/connectors', { from, to, label, author: 'agent' });
    return ok(`Added arrow ${c.id} from ${from} to ${to}.`);
  }),
);

server.registerTool(
  'update_item',
  {
    description: "Edit a note or reference: move it, resize it, or change a note's text or a reference's title. Change the user's own notes only when they ask.",
    inputSchema: {
      itemId,
      text: z.string().optional().describe('New note text.'),
      title: z.string().optional(),
      description: z.string().optional().describe('Links only.'),
      width: z.number().optional().describe('Pixels, 80 to 2000.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  tool('noting', async ({ itemId: id, ...patch }) => {
    const it = await call('PATCH', `/api/items/${encodeURIComponent(id)}`, patch);
    return ok(describeItem(it));
  }),
);

server.registerTool(
  'delete_item',
  {
    description: 'Remove a note, a reference or an arrow. Removing a note or reference also removes its arrows. Only do this when the user asks, or for a note you added yourself.',
    inputSchema: { id: z.string().describe('A note or reference id (it_...) or an arrow id (ln_...).') },
  },
  tool(null, async ({ id }) => {
    if (typeof id === 'string' && id.startsWith('ln_')) {
      await call('DELETE', `/api/connectors/${encodeURIComponent(id)}`);
      return ok(`Removed arrow ${id}.`);
    }
    const removed = await call('DELETE', `/api/items/${encodeURIComponent(id)}`);
    return ok(`Removed ${id}${removed.connectors.length ? ` and ${removed.connectors.length} arrow${removed.connectors.length === 1 ? '' : 's'}` : ''}.`);
  }),
);

server.registerTool(
  'finish_working',
  {
    description: 'Tell the board you have finished, so it stops showing you as busy. Call this when a piece of work is done.',
    inputSchema: {},
  },
  tool(null, async () => {
    await report({ done: true });
    return ok('Marked as finished.');
  }),
);

const transport = new StdioServerTransport();
// When the agent session ends, clear this agent from the board.
const leave = () => report({ done: true }).finally(() => process.exit(0));
transport.onclose = leave;
process.stdin.on('end', leave);
await server.connect(transport);
