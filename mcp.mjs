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
  const res = await fetch(base + route, {
    method,
    headers: body === undefined ? {} : { 'content-type': isText ? 'text/plain' : 'application/json' },
    body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  if (type.includes('image/png')) return Buffer.from(await res.arrayBuffer());
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Blueprint answered ${res.status}.`);
  return data;
}

// ---- activity: tell the board what this agent is doing, so the user can watch ----

// One id per agent session. Two agents on one board show up as two workers.
const AGENT_ID = randomUUID();
// The client tells us its name when it connects, for example "claude-code".
function agentName() {
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
const HTML_HELP =
  'A full HTML document or a fragment. Put CSS in a <style> tag. The artboard is a fixed-size window, so design for its width and height. Scripts run in a sandbox.';

const server = new McpServer(
  { name: 'blueprint', version: '0.1.0' },
  {
    instructions:
      'Blueprint is a whiteboard the user is watching live. They see which artboard you are working on. Build a large design in a few write_html calls (structure first, then detail) so they can watch it take shape. When you have finished a piece of work, call finish_working so the board stops showing you as busy.',
  },
);

server.registerTool(
  'get_board',
  {
    description:
      'Start here. Returns the board URL the user has open, every artboard (id, name, size, position) and how many open comments each has.',
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
