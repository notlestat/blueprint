import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

// The chat routes, with the Agent SDK replaced by a script. A gate holds each
// turn open until the test releases it, so "busy" can be observed.
let app;
let gate = null; // set while a scripted turn is waiting
const prompts = [];
function agentQuery({ prompt, options }) {
  prompts.push(prompt);
  return (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    await new Promise((resolve, reject) => {
      gate = resolve;
      options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    yield { type: 'assistant', message: { content: [{ type: 'text', text: `Done: ${prompt}` }] } };
    yield { type: 'result', subtype: 'success', is_error: false, session_id: 's1' };
  })();
}

before(async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'blueprint-home-'));
  const root = await mkdtemp(path.join(tmpdir(), 'blueprint-chat-'));
  app = await startServer({ root, port: 0, home, previews: false, agentQuery });
});
after(() => app.close());

const call = async (method, p, body, headers = {}) => {
  const res = await fetch(app.url + p, {
    method,
    headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const idle = () => app.agent.idle();
// Open the gate once the turn is waiting at it. Releasing earlier would release nothing.
async function release() {
  while (!gate) await new Promise((r) => setTimeout(r, 2));
  const open = gate;
  gate = null;
  open();
}

// Read `event: chat` frames from the live stream until `done` says stop.
async function watchChat(done) {
  const res = await fetch(app.url + '/api/events');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  let buffer = '';
  while (true) {
    const { value } = await reader.read();
    buffer += decoder.decode(value, { stream: true });
    for (const frame of buffer.split('\n\n').slice(0, -1)) {
      const [eventLine, dataLine] = frame.split('\n');
      if (eventLine === 'event: chat') seen.push(JSON.parse(dataLine.slice(6)));
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
    if (done(seen)) break;
  }
  await reader.cancel();
  return seen;
}

test('the chat starts empty and idle', async () => {
  const r = await call('GET', '/api/chat');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.busy, r.body.messages.length], [false, 0]);
});

test('a message starts a turn, streams over the event stream, and ends idle', async () => {
  const watching = watchChat((seen) => seen.some((s) => s.messages.some((m) => m.text === 'Done: Draw a hero')));
  const sent = await call('POST', '/api/chat', { text: 'Draw a hero' });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.busy, true);
  assert.equal((await call('POST', '/api/chat', { text: 'Too soon' })).status, 409);
  await release();
  const seen = await watching;
  await idle();
  assert.equal(seen.at(-1).messages.at(-1).text, 'Done: Draw a hero');
  assert.equal((await call('GET', '/api/chat')).body.busy, false);
});

test('stop ends a running turn', async () => {
  await call('POST', '/api/chat', { text: 'Long job' });
  const stopped = await call('POST', '/api/chat/stop');
  assert.equal(stopped.status, 200);
  await idle();
  const chat = (await call('GET', '/api/chat')).body;
  assert.equal(chat.busy, false);
  assert.equal(chat.messages.at(-1).text, 'Stopped.');
});

test('another website cannot start the agent', async () => {
  const before = prompts.length;
  const r = await call('POST', '/api/chat', { text: 'Spend their quota' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  assert.equal(prompts.length, before);
});

test('an empty message is refused', async () => {
  assert.equal((await call('POST', '/api/chat', { text: ' ' })).status, 400);
});

test('clear empties the chat', async () => {
  const r = await call('POST', '/api/chat/clear');
  assert.equal(r.status, 200);
  assert.equal(r.body.messages.length, 0);
});
